import { Hono } from "@hono/hono";
import type { Context } from "@hono/hono";
import { logger } from "@hono/hono/logger";
import { bodyLimit } from "@hono/hono/body-limit";
import { HTTPException } from "@hono/hono/http-exception";
import { and, count, desc, eq, gt, gte, isNull, lt, lte, ne, notExists, or, sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import {
  crearDigestDeTokens,
  generarToken,
  hashPassword,
  largoTexto,
  verificarPassword,
} from "./auth.ts";
import { db } from "./db/client.ts";
import {
  accounts,
  blocks,
  bottleViews,
  bottles,
  messages,
  photos,
  profiles,
  reports,
  reservations,
  sessions,
  type Bottle,
} from "./db/schema.ts";

const UPLOADS = Deno.env.get("UPLOADS_DIR") ?? "./data/uploads";
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const detectarImagen = (bytes: Uint8Array): { mime: string; ext: string } | null => {
  if (bytes.length >= 8 && PNG.every((b, i) => bytes[i] === b)) {
    return { mime: "image/png", ext: "png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  const esRiff = bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 &&
    bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 &&
    bytes[10] === 0x42 && bytes[11] === 0x50;
  if (esRiff) {
    const tam = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
    if (tam + 8 === bytes.length) return { mime: "image/webp", ext: "webp" };
  }
  return null;
};

const NOMBRE_FOTO = /^[0-9a-f-]{36}\.(png|jpg|webp)$/;
const rutaDeFoto = (filename: string) => {
  if (!NOMBRE_FOTO.test(filename)) return null;
  return `${UPLOADS}/${filename}`;
};

const fotosDe = async (visitor: string) => {
  const filas = await db
    .select({ id: photos.id })
    .from(photos)
    .where(eq(photos.visitorId, visitor))
    .orderBy(photos.createdAt);
  return filas.map((f) => ({ id: f.id, url: `/api/photos/${f.id}` }));
};

const VISITOR_COOKIE = "visitor";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PEPPER_DE_DESARROLLO = "pepper-de-desarrollo-no-usar-en-produccion";

const PEPPER = Deno.env.get("TOKEN_PEPPER") ?? PEPPER_DE_DESARROLLO;
if (import.meta.main && PEPPER === PEPPER_DE_DESARROLLO) {
  console.warn("⚠️  TOKEN_PEPPER no definido: usando el de desarrollo. Define uno de 32+ bytes.");
}
if (import.meta.main && PEPPER.length < 32) {
  throw new Error("TOKEN_PEPPER debe tener al menos 32 caracteres");
}
const digestToken = await crearDigestDeTokens(PEPPER);

type Entorno = {
  Variables: {
    visitor: string | null;
    cuenta: number | null;
    sesion: number | null;
  };
};

const visitante = (c: Context): string | null => {
  const raw = c.req.header("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    const value = rest.join("=");
    if (name === VISITOR_COOKIE && UUID.test(value)) return value.toLowerCase();
  }
  return null;
};

const repartirCookie = (c: Context, visitor: string) => {
  c.header(
    "set-cookie",
    `${VISITOR_COOKIE}=${visitor}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
  );
};

const limpiarCookie = (c: Context) => {
  c.header("set-cookie", `${VISITOR_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
};

/** Solo el mar y el alta de perfil crean visitantes anónimos. */
const identidadAnonima = (c: Context<Entorno>): string => {
  const existente = c.get("visitor");
  if (existente) return existente;

  const visitor = crypto.randomUUID();
  repartirCookie(c, visitor);
  return visitor;
};

const leerCuerpo = async (c: Context): Promise<Record<string, unknown> | null> => {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
};

const idValido = (raw: string): number | null => {
  if (!/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

// Drizzle envuelve el error original: hay que seguir la cadena `cause` para ver el código de Postgres.
const codigoError = (err: unknown): string | undefined => {
  let actual: unknown = err;
  for (let depth = 0; actual && depth < 5; depth++) {
    if (typeof actual === "object" && "code" in actual) {
      const code = (actual as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
    actual = typeof actual === "object" && "cause" in actual
      ? (actual as { cause?: unknown }).cause
      : undefined;
  }
  return undefined;
};

// Lo único de una botella que se expone por la API.
const publica = (bottle: Bottle) => ({ id: bottle.id, text: bottle.text });

const bloqueoEntre = (a: string | SQLWrapper, b: string | SQLWrapper) =>
  or(
    and(eq(blocks.blockerId, a), eq(blocks.blockedId, b)),
    and(eq(blocks.blockerId, b), eq(blocks.blockedId, a)),
  );

const estanBloqueados = async (a: string, b: string) => {
  const [fila] = await db.select().from(blocks).where(bloqueoEntre(a, b)).limit(1);
  return fila !== undefined;
};

const perfilDe = async (visitor: string) => {
  const [perfil] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.visitorId, visitor))
    .limit(1);
  return perfil ?? null;
};

export const app = new Hono<Entorno>();

app.use(logger());
const limiteNormal = bodyLimit({ maxSize: 8 * 1024 });
app.use("/api/*", (c, next) =>
  c.req.path === "/api/profile/photos" ? next() : limiteNormal(c, next));

// Resuelve la identidad en una sola capa. No crea visitantes: eso solo lo hacen el mar y el perfil.
app.use("/api/*", async (c, next) => {
  const ruta = c.req.path;
  if (ruta === "/api/auth/register" || ruta === "/api/auth/login") return next();
  // Las etiquetas <img> no mandan Bearer: las fotos se sirven sin identidad.
  if (ruta.startsWith("/api/photos/")) return next();

  const autorizacion = c.req.header("authorization");
  if (autorizacion !== undefined) {
    const token = autorizacion.startsWith("Bearer ") ? autorizacion.slice(7) : "";
    const [sesion] = token
      ? await db
        .select()
        .from(sessions)
        .where(and(
          eq(sessions.tokenHash, await digestToken(token)),
          gt(sessions.expiresAt, sql`now()`),
        ))
        .limit(1)
      : [];
    if (!sesion) return c.json({ error: "sesión inválida" }, 401);

    const [cuenta] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.id, sesion.accountId))
      .limit(1);
    if (!cuenta) return c.json({ error: "sesión inválida" }, 401);

    c.set("visitor", cuenta.visitorId);
    c.set("cuenta", cuenta.id);
    c.set("sesion", sesion.id);
    return next();
  }

  const visitor = visitante(c);
  if (visitor) {
    const [cuenta] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.visitorId, visitor))
      .limit(1);
    if (cuenta) return c.json({ error: "inicia sesión con tu cuenta" }, 401);
  }

  c.set("visitor", visitor);
  c.set("cuenta", null);
  c.set("sesion", null);
  return next();
});

// ---------------------------------------------------------------- raíz / salud
app.get("/", (c) => c.text("Botella 🍾"));

app.get("/health", async (c) => {
  const result = await db.execute(sql`select version() as version`);
  const version = (result.rows[0] as { version?: string } | undefined)?.version;
  return c.json({
    status: "ok",
    runtime: `Deno ${Deno.version.deno}`,
    database: version ?? "desconocida",
  });
});

// --------------------------------------------------------------------- cuentas
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LIMITE_INTENTOS = 10;
const VENTANA_INTENTOS = 15 * 60 * 1000;
const intentos = new Map<string, number[]>();

export const resetRateLimit = () => intentos.clear();

const dentroDelLimite = (email: string) => {
  const ahora = Date.now();
  const previos = (intentos.get(email) ?? []).filter((t) => ahora - t < VENTANA_INTENTOS);
  if (previos.length >= LIMITE_INTENTOS) {
    intentos.set(email, previos);
    return false;
  }
  previos.push(ahora);
  intentos.set(email, previos);
  return true;
};

// Mismo coste cuando el email no existe: no se puede distinguir por tiempo.
const HASH_FALSO = await hashPassword("contraseña-falsa-para-igualar-tiempos");

const crearSesion = async (cuentaId: number) => {
  const token = generarToken();
  await db.insert(sessions).values({ accountId: cuentaId, tokenHash: await digestToken(token) });
  return token;
};

app.post("/api/auth/register", async (c) => {
  const body = await leerCuerpo(c);
  if (!body) return c.json({ error: "cuerpo inválido" }, 400);

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (email.length > 254 || !EMAIL.test(email)) {
    return c.json({ error: "email inválido" }, 422);
  }
  const largo = largoTexto(password);
  if (largo < 8 || largo > 128) {
    return c.json({ error: "la contraseña debe tener entre 8 y 128 caracteres" }, 422);
  }
  if (!dentroDelLimite(`registro:${email}`)) return c.json({ error: "demasiados intentos" }, 429);

  // El registro no pasa por el middleware: la cookie se lee aquí.
  const visitor = visitante(c) ?? identidadAnonima(c);

  const [yaTieneCuenta] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.visitorId, visitor))
    .limit(1);
  if (yaTieneCuenta) return c.json({ error: "ese visitante ya tiene cuenta" }, 409);

  try {
    const { token } = await db.transaction(async (tx) => {
      const [cuenta] = await tx
        .insert(accounts)
        .values({ email, passwordHash: await hashPassword(password), visitorId: visitor })
        .returning();

      const token = generarToken();
      await tx
        .insert(sessions)
        .values({ accountId: cuenta.id, tokenHash: await digestToken(token) });

      return { token };
    });

    repartirCookie(c, visitor);
    return c.json({ data: { token, email } }, 201);
  } catch (err) {
    if (codigoError(err) === "23505") return c.json({ error: "ese email ya tiene cuenta" }, 409);
    throw err;
  }
});

app.post("/api/auth/login", async (c) => {
  const body = await leerCuerpo(c);
  if (!body) return c.json({ error: "cuerpo inválido" }, 400);

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || typeof body.password !== "string") {
    return c.json({ error: "email y contraseña son obligatorios" }, 422);
  }
  if (!dentroDelLimite(`login:${email}`)) return c.json({ error: "demasiados intentos" }, 429);

  const [cuenta] = await db.select().from(accounts).where(eq(accounts.email, email)).limit(1);

  if (!cuenta) {
    await verificarPassword(password, HASH_FALSO);
    return c.json({ error: "credenciales inválidas" }, 401);
  }
  if (!(await verificarPassword(password, cuenta.passwordHash))) {
    return c.json({ error: "credenciales inválidas" }, 401);
  }

  const token = await crearSesion(cuenta.id);
  repartirCookie(c, cuenta.visitorId);
  return c.json({ data: { token, email: cuenta.email } });
});

app.get("/api/auth/me", async (c) => {
  const cuentaId = c.get("cuenta");
  if (cuentaId === null) return c.json({ error: "inicia sesión" }, 401);

  const [cuenta] = await db.select().from(accounts).where(eq(accounts.id, cuentaId)).limit(1);
  if (!cuenta) return c.json({ error: "sesión inválida" }, 401);

  return c.json({ data: { email: cuenta.email } });
});

app.post("/api/auth/logout", async (c) => {
  const sesion = c.get("sesion");
  if (sesion === null) return c.json({ error: "inicia sesión" }, 401);

  await db.delete(sessions).where(eq(sessions.id, sesion));
  limpiarCookie(c);
  return c.body(null, 204);
});

app.post("/api/auth/logout-all", async (c) => {
  const cuentaId = c.get("cuenta");
  if (cuentaId === null) return c.json({ error: "inicia sesión" }, 401);

  await db.delete(sessions).where(eq(sessions.accountId, cuentaId));
  limpiarCookie(c);
  return c.body(null, 204);
});

// -------------------------------------------------------------------- perfil
app.get("/api/profile", async (c) => {
  const visitor = c.get("visitor");
  if (!visitor) return c.json({ data: null });

  const perfil = await perfilDe(visitor);
  if (!perfil) return c.json({ data: null });

  return c.json({
    data: {
      alias: perfil.alias,
      publicId: perfil.publicId,
      bio: perfil.bio,
      photos: await fotosDe(visitor),
    },
  });
});

app.put("/api/profile", async (c) => {
  const body = await leerCuerpo(c);
  if (!body) return c.json({ error: "cuerpo inválido" }, 400);

  if (typeof body.alias !== "string") {
    return c.json({ error: "el alias es obligatorio" }, 422);
  }

  const alias = body.alias.trim();
  if (tieneInvisibles(alias)) {
    return c.json({ error: "el alias contiene caracteres no permitidos" }, 422);
  }

  const largoAlias = [...alias].length;
  if (largoAlias < 3 || largoAlias > 20) {
    return c.json({ error: "el alias debe tener entre 3 y 20 caracteres" }, 422);
  }

  let bio: string | null | undefined;
  if (body.bio !== undefined) {
    if (body.bio !== null && typeof body.bio !== "string") {
      return c.json({ error: "bio inválida" }, 422);
    }
    const texto = typeof body.bio === "string" ? body.bio.trim() : "";
    if (texto === "") {
      bio = null;
    } else {
      if (tieneInvisibles(texto) || [...texto].length > 300) {
        return c.json({ error: "la bio no puede pasar de 300 caracteres" }, 422);
      }
      bio = texto;
    }
  }

  const visitor = identidadAnonima(c);

  const [perfil] = await db
    .insert(profiles)
    .values({ visitorId: visitor, alias, bio: bio ?? null })
    .onConflictDoUpdate({
      target: profiles.visitorId,
      set: bio === undefined ? { alias } : { alias, bio },
    })
    .returning();

  return c.json({
    data: {
      alias: perfil.alias,
      publicId: perfil.publicId,
      bio: perfil.bio,
      photos: await fotosDe(visitor),
    },
  });
});

// ------------------------------------------------------------------- botellas
// Postgres cuenta puntos de código y no admite \u0000: validamos igual que el CHECK de la tabla.
// Se permiten solo los saltos de línea y tabuladores; nada de otros controles ni bidi/zero-width.
const INVISIBLES = /[\p{Cc}\p{Cf}]/u;
const tieneInvisibles = (texto: string) => INVISIBLES.test(texto.replace(/[\n\r\t]/g, ""));

// -------------------------------------------------------------------- mis botellas
const estadoBotella = (
  fila: { destroyedAt: Date | null; confirmedAt: Date | null; expiresAt: Date | null },
): "destruida" | "conversacion" | "reservada" | "en_el_mar" => {
  if (fila.destroyedAt) return "destruida";
  if (fila.confirmedAt) return "conversacion";
  if (fila.expiresAt && fila.expiresAt.getTime() > Date.now()) return "reservada";
  return "en_el_mar";
};

app.get("/api/bottles/mine", async (c) => {
  const visitor = c.get("visitor");
  if (!visitor) return c.json({ data: [] });

  const raw = c.req.query("before");
  let before: number | undefined;
  if (raw !== undefined) {
    if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
      return c.json({ error: "before debe ser un id positivo" }, 422);
    }
    before = Number(raw);
  }

  const condiciones = [eq(bottles.authorVisitor, visitor)];
  if (before !== undefined) condiciones.push(lt(bottles.id, before));

  const filas = await db
    .select({
      id: bottles.id,
      text: bottles.text,
      createdAt: bottles.createdAt,
      destroyedAt: bottles.destroyedAt,
      confirmedAt: reservations.confirmedAt,
      expiresAt: reservations.expiresAt,
    })
    .from(bottles)
    .leftJoin(reservations, eq(reservations.bottleId, bottles.id))
    .where(and(...condiciones))
    .orderBy(desc(bottles.id))
    .limit(50);

  const data = filas.reverse().map((f) => ({
    id: f.id,
    text: f.text,
    status: estadoBotella(f),
    createdAt: f.createdAt,
  }));

  return c.json({ data });
});

app.post("/api/bottles", async (c) => {
  const body = await leerCuerpo(c);
  if (!body) return c.json({ error: "cuerpo inválido" }, 400);

  if (typeof body.text !== "string") {
    return c.json({ error: "el texto es obligatorio" }, 422);
  }

  const text = body.text.trim();
  if (tieneInvisibles(text)) {
    return c.json({ error: "el texto contiene caracteres no permitidos" }, 422);
  }

  const largo = [...text].length;
  if (largo < 5) {
    return c.json({ error: "el texto debe tener al menos 5 caracteres" }, 422);
  }
  if (largo > 240) {
    return c.json({ error: "el texto no puede superar los 240 caracteres" }, 422);
  }

  const visitor = c.get("visitor");
  if (!visitor || !(await perfilDe(visitor))) {
    return c.json({ error: "necesitas un alias antes de lanzar botellas" }, 403);
  }

  // Cupo diario (UTC) por visitante. El advisory lock serializa los lanzamientos de un mismo
  // visitante para que dos peticiones simultáneas no lean el mismo contador.
  const created = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${visitor}))`);

    const [hoy] = await tx
      .select({ total: count() })
      .from(bottles)
      .where(and(
        eq(bottles.authorVisitor, visitor),
        gte(
          bottles.createdAt,
          sql`date_trunc('day', now() at time zone 'utc') at time zone 'utc'`,
        ),
      ));

    if (Number(hoy.total) >= 5) return null;

    const [row] = await tx.insert(bottles).values({ text, authorVisitor: visitor }).returning();
    return row;
  });

  if (!created) {
    return c.json({ error: "has alcanzado el límite de 5 botellas nuevas hoy" }, 429);
  }

  return c.json({ data: publica(created) }, 201);
});

// ------------------------------------------------------------------- el mar
app.get("/api/sea", async (c) => {
  const visitor = identidadAnonima(c);
  const perfil = await perfilDe(visitor);

  // Atómico: elegir la botella y registrar la vista en la misma transacción, para que dos
  // peticiones simultáneas del mismo visitante no reciban la misma.
  const bottle = await db.transaction(async (tx) => {
    const vistas = tx
      .select()
      .from(bottleViews)
      .where(and(eq(bottleViews.bottleId, bottles.id), eq(bottleViews.visitorId, visitor)));

    const reservadas = tx
      .select()
      .from(reservations)
      .where(and(eq(reservations.bottleId, bottles.id), gt(reservations.expiresAt, sql`now()`)));

    const bloqueos = tx
      .select()
      .from(blocks)
      .where(bloqueoEntre(visitor, bottles.authorVisitor));

    const [elegida] = await tx
      .select()
      .from(bottles)
      .where(and(
        isNull(bottles.destroyedAt),
        ne(bottles.authorVisitor, visitor),
        notExists(vistas),
        notExists(reservadas),
        notExists(bloqueos),
      ))
      .orderBy(sql`random()`)
      .limit(1)
      .for("update", { skipLocked: true });

    if (!elegida) return null;

    // Sin perfil no se registra la vista: si no, la botella quedaría quemada para siempre.
    if (perfil) {
      await tx.insert(bottleViews).values({ bottleId: elegida.id, visitorId: visitor })
        .onConflictDoNothing();
    }

    return elegida;
  });

  return c.json({ data: bottle ? publica(bottle) : null });
});

app.post("/api/bottles/:id/discard", async (c) => {
  const body = await leerCuerpo(c);
  if (!body) return c.json({ error: "cuerpo inválido" }, 400);

  const action = body.action;
  if (action !== "destroy" && action !== "return") {
    return c.json({ error: "action debe ser 'destroy' o 'return'" }, 422);
  }

  const id = idValido(c.req.param("id"));
  if (id === null) return c.json({ error: "botella no encontrada" }, 404);

  const [bottle] = await db
    .select()
    .from(bottles)
    .where(and(eq(bottles.id, id), isNull(bottles.destroyedAt)))
    .limit(1);
  if (!bottle) return c.json({ error: "botella no encontrada" }, 404);

  const visitor = c.get("visitor");
  const [vista] = visitor
    ? await db
      .select()
      .from(bottleViews)
      .where(and(eq(bottleViews.bottleId, id), eq(bottleViews.visitorId, visitor)))
      .limit(1)
    : [];
  if (!vista) return c.json({ error: "no has visto esa botella" }, 403);

  if (visitor && await estanBloqueados(visitor, bottle.authorVisitor)) {
    return c.json({ error: "no puedes interactuar con esa botella" }, 403);
  }

  const salida = { estado: "ok" as "ok" | "fijada" | "ajena" | "no-existe" };
  let destruida: Bottle | undefined;

  await db.transaction(async (tx) => {
    const [viva] = await tx
      .select()
      .from(bottles)
      .where(and(eq(bottles.id, id), isNull(bottles.destroyedAt)))
      .limit(1)
      .for("update");
    if (!viva) {
      salida.estado = "no-existe";
      return;
    }

    const [reserva] = await tx
      .select()
      .from(reservations)
      .where(eq(reservations.bottleId, id))
      .limit(1);

    if (reserva?.confirmedAt) {
      salida.estado = "fijada";
      return;
    }
    const vigente = reserva !== undefined && reserva.expiresAt.getTime() > Date.now();
    if (vigente && reserva.visitorId !== visitor) {
      salida.estado = "ajena";
      return;
    }

    if (action === "destroy") {
      const [d] = await tx
        .update(bottles)
        .set({ destroyedAt: new Date() })
        .where(and(eq(bottles.id, id), isNull(bottles.destroyedAt)))
        .returning();
      destruida = d;
      await tx.delete(reservations).where(eq(reservations.bottleId, id));
    } else if (visitor) {
      // Devolver al mar también suelta mi reserva, sin tocar una conversación fija.
      await tx.delete(reservations).where(and(
        eq(reservations.bottleId, id),
        eq(reservations.visitorId, visitor),
        sql`${reservations.confirmedAt} is null`,
      ));
    }
  });

  if (salida.estado === "no-existe") return c.json({ error: "botella no encontrada" }, 404);
  if (salida.estado === "fijada") {
    return c.json({ error: "la botella ya es una conversación abierta" }, 409);
  }
  if (salida.estado === "ajena") {
    return c.json({ error: "la botella está reservada por otra persona" }, 409);
  }

  return c.json({ data: publica(destruida ?? bottle) });
});

app.post("/api/bottles/:id/pick", async (c) => {
  const id = idValido(c.req.param("id"));
  if (id === null) return c.json({ error: "botella no encontrada" }, 404);

  const [bottle] = await db
    .select()
    .from(bottles)
    .where(and(eq(bottles.id, id), isNull(bottles.destroyedAt)))
    .limit(1);
  if (!bottle) return c.json({ error: "botella no encontrada" }, 404);

  const visitor = c.get("visitor");
  if (!visitor) return c.json({ error: "no has visto esa botella" }, 403);

  const perfil = await perfilDe(visitor);
  if (!perfil) return c.json({ error: "necesitas un alias antes de recoger botellas" }, 403);

  const [vista] = await db
    .select()
    .from(bottleViews)
    .where(and(eq(bottleViews.bottleId, id), eq(bottleViews.visitorId, visitor)))
    .limit(1);
  if (!vista) return c.json({ error: "no has visto esa botella" }, 403);

  if (await estanBloqueados(visitor, bottle.authorVisitor)) {
    return c.json({ error: "no puedes interactuar con esa botella" }, 403);
  }

  try {
    const reservada = await db.transaction(async (tx) => {
      // Bloquea la botella para que no la destruyan entre la comprobación y la reserva.
      const [viva] = await tx
        .select()
        .from(bottles)
        .where(and(eq(bottles.id, id), isNull(bottles.destroyedAt)))
        .limit(1)
        .for("update");
      if (!viva) return false;

      // Las reservas expiradas no deben seguir ocupando la botella ni mi hueco.
      await tx.delete(reservations).where(and(
        eq(reservations.bottleId, id),
        lte(reservations.expiresAt, sql`now()`),
      ));
      await tx.delete(reservations).where(and(
        eq(reservations.visitorId, visitor),
        lte(reservations.expiresAt, sql`now()`),
      ));

      await tx
        .insert(reservations)
        .values({ bottleId: id, visitorId: visitor, expiresAt: sql`now() + interval '48 hours'` });
      return true;
    });

    if (!reservada) return c.json({ error: "botella no encontrada" }, 404);
  } catch (err) {
    if (codigoError(err) === "23505") {
      return c.json({ error: "ya tienes una reserva o la botella ya está reservada" }, 409);
    }
    throw err;
  }

  const autora = await perfilDe(bottle.authorVisitor);
  return c.json({
    data: {
      ...publica(bottle),
      authorAlias: autora?.alias ?? null,
      authorPublicId: autora?.publicId ?? null,
      authorBio: autora?.bio ?? null,
      authorPhotos: autora ? await fotosDe(autora.visitorId) : [],
    },
  });
});

app.post("/api/bottles/:id/release", async (c) => {
  const id = idValido(c.req.param("id"));
  if (id === null) return c.json({ error: "botella no encontrada" }, 404);

  const [bottle] = await db
    .select()
    .from(bottles)
    .where(and(eq(bottles.id, id), isNull(bottles.destroyedAt)))
    .limit(1);
  if (!bottle) return c.json({ error: "botella no encontrada" }, 404);

  const visitor = c.get("visitor");
  if (!visitor) return c.json({ error: "esa reserva no es tuya" }, 403);

  const salida = { estado: "ok" as "ok" | "fijada" | "ajena" | "nada" | "no-existe" };

  await db.transaction(async (tx) => {
    const [viva] = await tx
      .select()
      .from(bottles)
      .where(and(eq(bottles.id, id), isNull(bottles.destroyedAt)))
      .limit(1)
      .for("update");
    if (!viva) {
      salida.estado = "no-existe";
      return;
    }

    const [reserva] = await tx
      .select()
      .from(reservations)
      .where(eq(reservations.bottleId, id))
      .limit(1);
    if (!reserva) {
      salida.estado = "nada";
      return;
    }
    if (reserva.confirmedAt) {
      salida.estado = "fijada";
      return;
    }
    if (reserva.visitorId !== visitor) {
      salida.estado = "ajena";
      return;
    }

    const borradas = await tx
      .delete(reservations)
      .where(and(
        eq(reservations.bottleId, id),
        eq(reservations.visitorId, visitor),
        sql`${reservations.confirmedAt} is null`,
      ))
      .returning();
    salida.estado = borradas.length > 0 ? "ok" : "fijada";
  });

  if (salida.estado === "no-existe") return c.json({ error: "botella no encontrada" }, 404);
  if (salida.estado === "ajena") return c.json({ error: "esa reserva no es tuya" }, 403);
  if (salida.estado === "nada") return c.json({ error: "no hay reserva" }, 409);
  if (salida.estado === "fijada") {
    return c.json({ error: "la conversación está abierta y no se puede liberar" }, 409);
  }

  return c.json({ data: publica(bottle) });
});

// ---------------------------------------------------------------- mensajes
const mensajePublico = (
  m: { id: number; text: string; senderAlias: string; createdAt: Date },
  mine: boolean,
  senderPublicId: string | null,
) => ({
  id: m.id,
  text: m.text,
  alias: m.senderAlias,
  publicId: senderPublicId,
  mine,
  createdAt: m.createdAt,
});

app.post("/api/bottles/:id/messages", async (c) => {
  const id = idValido(c.req.param("id"));
  if (id === null) return c.json({ error: "botella no encontrada" }, 404);

  const body = await leerCuerpo(c);
  if (!body) return c.json({ error: "cuerpo inválido" }, 400);

  if (typeof body.text !== "string") {
    return c.json({ error: "el mensaje es obligatorio" }, 422);
  }

  const text = body.text.trim();
  if (tieneInvisibles(text)) {
    return c.json({ error: "el mensaje contiene caracteres no permitidos" }, 422);
  }
  const largo = [...text].length;
  if (largo < 1 || largo > 500) {
    return c.json({ error: "el mensaje debe tener entre 1 y 500 caracteres" }, 422);
  }

  const visitor = c.get("visitor");
  if (!visitor) return c.json({ error: "no participas en esa conversación" }, 403);

  const perfil = await perfilDe(visitor);
  if (!perfil) return c.json({ error: "necesitas un alias para escribir" }, 403);

  const salida = {
    estado: "ok" as "ok" | "no-existe" | "ajena" | "solo-lectora" | "expirada" | "bloqueada",
  };
  let creado: { id: number; text: string; senderAlias: string; createdAt: Date } | undefined;

  await db.transaction(async (tx) => {
    // Bloquea la botella: evita que la destruyan justo mientras se confirma la conversación.
    const [bottle] = await tx
      .select()
      .from(bottles)
      .where(and(eq(bottles.id, id), isNull(bottles.destroyedAt)))
      .limit(1)
      .for("update");
    if (!bottle) {
      salida.estado = "no-existe";
      return;
    }

    const [reserva] = await tx
      .select()
      .from(reservations)
      .where(eq(reservations.bottleId, id))
      .limit(1);

    const esAutora = bottle.authorVisitor === visitor;
    const esLectora = reserva?.visitorId === visitor;

    if (!esAutora && !esLectora) {
      salida.estado = "ajena";
      return;
    }

    if (esAutora || esLectora) {
      const otra = esAutora ? reserva?.visitorId : bottle.authorVisitor;
      if (otra) {
        const [bloqueo] = await tx
          .select()
          .from(blocks)
          .where(bloqueoEntre(visitor, otra))
          .limit(1);
        if (bloqueo) {
          salida.estado = "bloqueada";
          return;
        }
      }
    }

    if (!reserva?.confirmedAt) {
      if (!esLectora) {
        salida.estado = "solo-lectora";
        return;
      }
      if (reserva.expiresAt.getTime() <= Date.now()) {
        salida.estado = "expirada";
        return;
      }

      const [confirmada] = await tx
        .update(reservations)
        .set({ confirmedAt: sql`now()`, expiresAt: sql`'infinity'` })
        .where(and(
          eq(reservations.bottleId, id),
          eq(reservations.visitorId, visitor),
          sql`${reservations.confirmedAt} is null`,
          gt(reservations.expiresAt, sql`now()`),
        ))
        .returning();

      if (!confirmada) {
        // Otra petición idéntica la confirmó a la vez: seguir y escribir el mensaje.
        const [actual] = await tx
          .select()
          .from(reservations)
          .where(eq(reservations.bottleId, id))
          .limit(1);
        if (!actual?.confirmedAt) {
          salida.estado = "expirada";
          return;
        }
      }
    }

    const [msg] = await tx
      .insert(messages)
      .values({ bottleId: id, senderVisitor: visitor, senderAlias: perfil.alias, text })
      .returning();
    creado = msg;
  });

  if (salida.estado === "no-existe") return c.json({ error: "botella no encontrada" }, 404);
  if (salida.estado === "ajena") return c.json({ error: "no participas en esa conversación" }, 403);
  if (salida.estado === "bloqueada") {
    return c.json({ error: "no puedes interactuar con esa persona" }, 403);
  }
  if (salida.estado === "solo-lectora") {
    return c.json({ error: "solo quien recogió puede abrir la conversación" }, 403);
  }
  if (salida.estado === "expirada") return c.json({ error: "la reserva ha expirado" }, 409);

  return c.json({ data: mensajePublico(creado!, true, perfil.publicId) }, 201);
});

app.get("/api/bottles/:id/messages", async (c) => {
  const id = idValido(c.req.param("id"));
  if (id === null) return c.json({ error: "botella no encontrada" }, 404);

  const [bottle] = await db
    .select()
    .from(bottles)
    .where(and(eq(bottles.id, id), isNull(bottles.destroyedAt)))
    .limit(1);
  if (!bottle) return c.json({ error: "botella no encontrada" }, 404);

  const visitor = c.get("visitor");
  if (!visitor) return c.json({ error: "no participas en esa conversación" }, 403);

  const [reserva] = await db
    .select()
    .from(reservations)
    .where(eq(reservations.bottleId, id))
    .limit(1);

  const esAutora = bottle.authorVisitor === visitor;
  const esLectora = reserva?.visitorId === visitor;
  if (!esAutora && !esLectora) {
    return c.json({ error: "no participas en esa conversación" }, 403);
  }
  if (!reserva?.confirmedAt && !esLectora) {
    return c.json({ error: "solo quien recogió puede abrir la conversación" }, 403);
  }

  const otra = esAutora ? reserva?.visitorId : bottle.authorVisitor;
  if (otra && await estanBloqueados(visitor, otra)) {
    return c.json({ error: "no puedes interactuar con esa persona" }, 403);
  }

  const raw = c.req.query("before");
  let before: number | undefined;
  if (raw !== undefined) {
    if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
      return c.json({ error: "before debe ser un id positivo" }, 422);
    }
    before = Number(raw);
  }

  const condiciones = [eq(messages.bottleId, id)];
  if (before !== undefined) condiciones.push(lt(messages.id, before));

  const filas = await db
    .select({
      id: messages.id,
      text: messages.text,
      senderVisitor: messages.senderVisitor,
      senderAlias: messages.senderAlias,
      createdAt: messages.createdAt,
      senderPublicId: profiles.publicId,
    })
    .from(messages)
    .leftJoin(profiles, eq(profiles.visitorId, messages.senderVisitor))
    .where(and(...condiciones))
    .orderBy(desc(messages.id))
    .limit(50);

  const data = filas
    .reverse()
    .map((m) => mensajePublico(m, m.senderVisitor === visitor, m.senderPublicId));
  return c.json({ data });
});

// --------------------------------------------------------------------- fotos
const LIMITE_SUBIDAS = 10;
const VENTANA_SUBIDAS = 24 * 60 * 60 * 1000;
const subidasPorVisitante = new Map<string, number[]>();

export const resetUploadLimit = () => subidasPorVisitante.clear();

const puedeSubir = (visitor: string) => {
  const ahora = Date.now();
  const previas = (subidasPorVisitante.get(visitor) ?? []).filter((t) =>
    ahora - t < VENTANA_SUBIDAS
  );
  if (previas.length >= LIMITE_SUBIDAS) {
    subidasPorVisitante.set(visitor, previas);
    return false;
  }
  previas.push(ahora);
  subidasPorVisitante.set(visitor, previas);
  return true;
};

app.post(
  "/api/profile/photos",
  bodyLimit({ maxSize: 6 * 1024 * 1024 }),
  async (c) => {
    const visitor = c.get("visitor");
    if (!visitor) return c.json({ error: "inicia sesión" }, 401);
    if (!(await perfilDe(visitor))) return c.json({ error: "necesitas un alias" }, 403);

    let formulario: Record<string, unknown>;
    try {
      formulario = await c.req.parseBody({ all: true });
    } catch {
      return c.json({ error: "multipart inválido" }, 400);
    }

    const foto = formulario.photo;
    if (!(foto instanceof File)) return c.json({ error: "falta la foto" }, 422);
    if (foto.size > 5 * 1024 * 1024) return c.json({ error: "la foto pasa de 5 MB" }, 413);

    const bytes = new Uint8Array(await foto.arrayBuffer());
    const tipo = detectarImagen(bytes);
    if (!tipo) return c.json({ error: "formato no permitido" }, 422);

    if (!puedeSubir(visitor)) return c.json({ error: "demasiadas subidas" }, 429);

    const filename = `${crypto.randomUUID()}.${tipo.ext}`;
    await Deno.mkdir(UPLOADS, { recursive: true });
    const temporal = `${UPLOADS}/.tmp-${filename}`;
    const definitivo = `${UPLOADS}/${filename}`;
    await Deno.writeFile(temporal, bytes, { mode: 0o600 });

    try {
      const creada = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${visitor}))`);

        const [total] = await tx
          .select({ cuantas: count() })
          .from(photos)
          .where(eq(photos.visitorId, visitor));
        if (Number(total.cuantas) >= 6) return null;

        const [fila] = await tx
          .insert(photos)
          .values({ visitorId: visitor, filename, mime: tipo.mime })
          .returning();
        return fila;
      });

      if (!creada) {
        await Deno.remove(temporal).catch(() => {});
        return c.json({ error: "ya tienes 6 fotos" }, 409);
      }

      await Deno.rename(temporal, definitivo);
      return c.json({ data: { id: creada.id, url: `/api/photos/${creada.id}` } }, 201);
    } catch (err) {
      await Deno.remove(temporal).catch(() => {});
      throw err;
    }
  },
);

app.delete("/api/profile/photos/:id", async (c) => {
  const visitor = c.get("visitor");
  if (!visitor) return c.json({ error: "inicia sesión" }, 401);

  const id = c.req.param("id");
  if (!UUID.test(id)) return c.json({ error: "foto no encontrada" }, 404);

  const borradas = await db
    .delete(photos)
    .where(and(eq(photos.id, id), eq(photos.visitorId, visitor)))
    .returning();
  if (borradas.length === 0) return c.json({ error: "foto no encontrada" }, 404);

  const ruta = rutaDeFoto(borradas[0].filename);
  if (ruta) await Deno.remove(ruta).catch(() => {});

  return c.body(null, 204);
});

app.get("/api/photos/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID.test(id)) return c.json({ error: "foto no encontrada" }, 404);

  const [foto] = await db.select().from(photos).where(eq(photos.id, id)).limit(1);
  if (!foto) return c.json({ error: "foto no encontrada" }, 404);

  const ruta = rutaDeFoto(foto.filename);
  if (!ruta) return c.json({ error: "foto no encontrada" }, 404);

  try {
    const bytes = await Deno.readFile(ruta);
    return c.body(bytes, 200, {
      "content-type": foto.mime,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    });
  } catch {
    return c.json({ error: "foto no encontrada" }, 404);
  }
});

// ------------------------------------------------------------------ bloqueos
const perfilPorPublicId = async (publicId: string) => {
  const [perfil] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.publicId, publicId))
    .limit(1);
  return perfil ?? null;
};

app.get("/api/blocks", async (c) => {
  const visitor = c.get("visitor");
  if (!visitor) return c.json({ error: "inicia sesión" }, 401);

  const filas = await db
    .select({
      publicId: profiles.publicId,
      alias: profiles.alias,
      createdAt: blocks.createdAt,
    })
    .from(blocks)
    .innerJoin(profiles, eq(profiles.visitorId, blocks.blockedId))
    .where(eq(blocks.blockerId, visitor))
    .orderBy(desc(blocks.createdAt))
    .limit(50);

  return c.json({ data: filas.map((f) => ({ publicId: f.publicId, alias: f.alias })) });
});

app.post("/api/blocks", async (c) => {
  const body = await leerCuerpo(c);
  if (!body) return c.json({ error: "cuerpo inválido" }, 400);

  const publicId = typeof body.publicId === "string" ? body.publicId : "";
  if (!UUID.test(publicId)) return c.json({ error: "publicId inválido" }, 422);

  const visitor = c.get("visitor");
  if (!visitor) return c.json({ error: "inicia sesión" }, 401);
  if (!(await perfilDe(visitor))) return c.json({ error: "necesitas un alias" }, 403);

  const objetivo = await perfilPorPublicId(publicId);
  if (!objetivo) return c.json({ error: "persona no encontrada" }, 404);
  if (objetivo.visitorId === visitor) {
    return c.json({ error: "no puedes bloquearte a ti mismo" }, 422);
  }

  await db.transaction(async (tx) => {
    await tx
      .insert(blocks)
      .values({ blockerId: visitor, blockedId: objetivo.visitorId })
      .onConflictDoNothing();

    // Una reserva sin confirmar entre los dos no puede quedar secuestrada: vuelve al mar.
    await tx.execute(sql`
      delete from reservations r
      using bottles b
      where r.bottle_id = b.id
        and r.confirmed_at is null
        and (
          (r.visitor_id = ${visitor} and b.author_visitor = ${objetivo.visitorId})
          or (r.visitor_id = ${objetivo.visitorId} and b.author_visitor = ${visitor})
        )
    `);
  });

  return c.json({ data: { publicId, alias: objetivo.alias } }, 201);
});

app.delete("/api/blocks/:publicId", async (c) => {
  const visitor = c.get("visitor");
  if (!visitor) return c.json({ error: "inicia sesión" }, 401);

  const publicId = c.req.param("publicId");
  if (!UUID.test(publicId)) return c.json({ error: "publicId inválido" }, 422);

  const objetivo = await perfilPorPublicId(publicId);
  if (!objetivo) return c.json({ error: "persona no encontrada" }, 404);

  const borradas = await db
    .delete(blocks)
    .where(and(eq(blocks.blockerId, visitor), eq(blocks.blockedId, objetivo.visitorId)))
    .returning();
  if (borradas.length === 0) return c.json({ error: "no tenías bloqueada a esa persona" }, 404);

  return c.body(null, 204);
});

// ------------------------------------------------------------------- reportes
const MOTIVOS = new Set(["acoso", "spam", "perfil_falso", "otro"]);
const LIMITE_REPORTES = 10;
const VENTANA_REPORTES = 24 * 60 * 60 * 1000;
const reportesPorVisitante = new Map<string, number[]>();

export const resetReportLimit = () => reportesPorVisitante.clear();

const puedeReportar = (visitor: string) => {
  const ahora = Date.now();
  const previos = (reportesPorVisitante.get(visitor) ?? []).filter((t) =>
    ahora - t < VENTANA_REPORTES
  );
  if (previos.length >= LIMITE_REPORTES) {
    reportesPorVisitante.set(visitor, previos);
    return false;
  }
  previos.push(ahora);
  reportesPorVisitante.set(visitor, previos);
  return true;
};

app.post("/api/reports", async (c) => {
  const body = await leerCuerpo(c);
  if (!body) return c.json({ error: "cuerpo inválido" }, 400);

  const visitor = c.get("visitor");
  if (!visitor) return c.json({ error: "inicia sesión" }, 401);
  if (!(await perfilDe(visitor))) return c.json({ error: "necesitas un alias" }, 403);

  const publicId = typeof body.publicId === "string" ? body.publicId : "";
  if (!UUID.test(publicId)) return c.json({ error: "publicId inválido" }, 422);

  const objetivo = await perfilPorPublicId(publicId);
  if (!objetivo) return c.json({ error: "persona no encontrada" }, 404);
  if (objetivo.visitorId === visitor) {
    return c.json({ error: "no puedes reportarte a ti mismo" }, 422);
  }

  const reason = typeof body.reason === "string" ? body.reason : "";
  if (!MOTIVOS.has(reason)) return c.json({ error: "motivo inválido" }, 422);

  let texto: string | null = null;
  if (body.text !== undefined && body.text !== null) {
    if (typeof body.text !== "string") return c.json({ error: "texto inválido" }, 422);
    texto = body.text.trim();
    const largo = [...texto].length;
    if (largo < 1 || largo > 500 || tieneInvisibles(texto)) {
      return c.json({ error: "el texto debe tener entre 1 y 500 caracteres válidos" }, 422);
    }
  }

  let bottleId: number | null = null;
  if (body.bottleId !== undefined && body.bottleId !== null) {
    if (typeof body.bottleId !== "number" || !Number.isSafeInteger(body.bottleId) || body.bottleId <= 0) {
      return c.json({ error: "bottleId inválido" }, 422);
    }
    const [botella] = await db
      .select()
      .from(bottles)
      .where(eq(bottles.id, body.bottleId))
      .limit(1);
    if (!botella) return c.json({ error: "botella no encontrada" }, 422);
    bottleId = body.bottleId;
  }

  if (!puedeReportar(visitor)) return c.json({ error: "demasiados reportes" }, 429);

  const [creado] = await db
    .insert(reports)
    .values({ reporterId: visitor, reportedId: objetivo.visitorId, reason, text: texto, bottleId })
    .returning();

  return c.json({ data: { id: creado.id } }, 201);
});

// ------------------------------------------------------------------- errores
app.notFound((c) => c.json({ error: "ruta no encontrada", path: c.req.path }, 404));

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  console.error("💥", err);
  return c.json({ error: "error interno del servidor" }, 500);
});

const port = Number(Deno.env.get("PORT") ?? 8000);

if (import.meta.main) {
  Deno.serve({ port }, (request) => app.fetch(request));
  console.log(`🔥 Hono escuchando en http://localhost:${port}`);
}

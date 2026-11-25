import { Hono } from "@hono/hono";
import type { Context } from "@hono/hono";
import { logger } from "@hono/hono/logger";
import { bodyLimit } from "@hono/hono/body-limit";
import { HTTPException } from "@hono/hono/http-exception";
import { and, count, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, notExists, or, sql } from "drizzle-orm";
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
  affinityAnswers,
  blocks,
  bottleViews,
  bottles,
  conversations,
  groupMembers,
  groupMessages,
  messages,
  planAttendees,
  plans,
  notifications,
  photos,
  profiles,
  reports,
  reservations,
  sessions,
  swipes,
  type Bottle,
} from "./db/schema.ts";

const UPLOADS = Deno.env.get("UPLOADS_DIR") ?? "./data/uploads";
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const asciiEn = (bytes: Uint8Array, desde: number, texto: string) =>
  texto.split("").every((c, i) => bytes[desde + i] === c.charCodeAt(0));

const detectarImagen = (bytes: Uint8Array): { mime: string; ext: string } | null => {
  // PNG: firma de 8 bytes, chunk IHDR y longitud mínima de un PNG real.
  if (bytes.length >= 33 && PNG.every((b, i) => bytes[i] === b) && asciiEn(bytes, 12, "IHDR")) {
    return { mime: "image/png", ext: "png" };
  }
  // JPEG: SOI al principio y EOI al final.
  if (
    bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff &&
    bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9
  ) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  // WebP: contenedor RIFF con tamaño coherente y chunk VP8/VP8L/VP8X.
  const esRiff = bytes.length >= 20 && asciiEn(bytes, 0, "RIFF") && asciiEn(bytes, 8, "WEBP");
  if (esRiff) {
    const tam = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
    const chunk = asciiEn(bytes, 12, "VP8 ");
    const chunkL = asciiEn(bytes, 12, "VP8L");
    const chunkX = asciiEn(bytes, 12, "VP8X");
    if (tam + 8 === bytes.length && (chunk || chunkL || chunkX)) {
      return { mime: "image/webp", ext: "webp" };
    }
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
if (Deno.env.get("ENV") === "production" && PEPPER === PEPPER_DE_DESARROLLO) {
  throw new Error("Define TOKEN_PEPPER (32+ bytes) en producción");
}
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

const ATRIBUTOS_COOKIE = Deno.env.get("COOKIE_SECURE") === "1" ? "; Secure" : "";

const repartirCookie = (c: Context, visitor: string) => {
  c.header(
    "set-cookie",
    `${VISITOR_COOKIE}=${visitor}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${ATRIBUTOS_COOKIE}`,
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

const ID_MAX = 2_147_483_647;

const idValido = (raw: string): number | null => {
  if (!/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 && id <= ID_MAX ? id : null;
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

// ---------------------------------------------------------------- afinidad
const PREGUNTAS = [
  {
    id: "plan_ideal",
    text: "¿Cuál es tu plan ideal?",
    options: [
      { id: "cena", text: "Cena tranquila" },
      { id: "cine", text: "Cine" },
      { id: "senderismo", text: "Senderismo" },
      { id: "concierto", text: "Concierto" },
    ],
  },
  {
    id: "finde",
    text: "¿Tu fin de semana perfecto?",
    options: [
      { id: "playa", text: "Playa" },
      { id: "montana", text: "Montaña" },
      { id: "ciudad", text: "Ciudad" },
      { id: "casa", text: "Casa" },
    ],
  },
  {
    id: "conversacion",
    text: "¿Qué te engancha en una conversación?",
    options: [
      { id: "humor", text: "El humor" },
      { id: "profundidad", text: "La profundidad" },
      { id: "memes", text: "Los memes" },
      { id: "actualidad", text: "La actualidad" },
    ],
  },
  {
    id: "ritmo",
    text: "¿A qué ritmo vives?",
    options: [
      { id: "tranquilo", text: "Tranquilo" },
      { id: "intenso", text: "Intenso" },
      { id: "depende", text: "Depende del día" },
    ],
  },
  {
    id: "comida",
    text: "¿Plan de comida?",
    options: [
      { id: "cocinar", text: "Cocinar en casa" },
      { id: "salir", text: "Salir a comer" },
      { id: "pedir", text: "Pedir a domicilio" },
      { id: "igual", text: "Me da igual" },
    ],
  },
  {
    id: "viaje",
    text: "¿Cómo te gusta viajar?",
    options: [
      { id: "mochila", text: "Con mochila" },
      { id: "hotel", text: "Con hotel" },
      { id: "roadtrip", text: "Road trip" },
      { id: "cerca", text: "Cerca de casa" },
    ],
  },
] as const;

const OPCIONES = new Map<string, Set<string>>(
  PREGUNTAS.map((p) => [p.id, new Set(p.options.map((o) => o.id))]),
);

const PARES_SQL = PREGUNTAS
  .flatMap((p) => p.options.map((o) => `('${p.id}','${o.id}')`))
  .join(",");

const respuestasDe = async (visitor: string): Promise<Record<string, string>> => {
  const filas = await db
    .select()
    .from(affinityAnswers)
    .where(eq(affinityAnswers.visitorId, visitor));

  const validas: Record<string, string> = {};
  for (const fila of filas) {
    if (OPCIONES.get(fila.question)?.has(fila.option)) validas[fila.question] = fila.option;
  }
  return validas;
};

const afinidadEntre = async (a: string, b: string): Promise<number | null> => {
  const [mias, suyas] = await Promise.all([respuestasDe(a), respuestasDe(b)]);
  const comunes = Object.keys(mias).filter((q) => q in suyas);
  if (comunes.length < 2) return null;
  const coincidencias = comunes.filter((q) => mias[q] === suyas[q]).length;
  return Math.round((coincidencias * 100) / comunes.length);
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const notificar = async (
  tx: Tx,
  visitor: string,
  type: string,
  bottleId: number | null,
  conversationId: number | null = null,
) => {
  await tx.insert(notifications).values({ visitorId: visitor, type, bottleId, conversationId });
  await tx.execute(sql`
    delete from notifications
    where visitor_id = ${visitor}
      and id < (
        select id from notifications
        where visitor_id = ${visitor}
        order by id desc
        offset 49
        limit 1
      )
  `);
};

const barrerExpiradas = async (tx: Tx, condiciones: ReturnType<typeof eq>[]) => {
  const expiradas = await tx
    .select()
    .from(reservations)
    .where(and(isNull(reservations.confirmedAt), lte(reservations.expiresAt, sql`now()`), ...condiciones));

  for (const reserva of expiradas) {
    const borradas = await tx
      .delete(reservations)
      .where(and(
        eq(reservations.bottleId, reserva.bottleId),
        isNull(reservations.confirmedAt),
      ))
      .returning();
    if (borradas.length > 0) {
      await notificar(tx, reserva.visitorId, "reserva_caducada", reserva.bottleId);
    }
  }
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
const respuesta413 = (c: Context) => c.json({ error: "cuerpo demasiado grande" }, 413);
const limiteNormal = bodyLimit({ maxSize: 8 * 1024, onError: respuesta413 });
const limiteFoto = bodyLimit({ maxSize: 6 * 1024 * 1024, onError: respuesta413 });

app.use("/api/*", (c, next) => {
  const esFoto = c.req.path === "/api/profile/photos";
  return (esFoto ? limiteFoto : limiteNormal)(c, next);
});

app.use("/api/*", async (c, next) => {
  if (c.req.method === "GET" && !c.req.path.startsWith("/api/photos/")) {
    c.header("cache-control", "no-store");
  }
  await next();
});

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
const intentosGlobales: number[] = [];

export const resetRateLimit = () => {
  intentos.clear();
  intentosGlobales.length = 0;
};

const LIMITE_MAPA = 5_000;

const acotarMapa = (mapa: Map<string, number[]>) => {
  while (mapa.size > LIMITE_MAPA) {
    const primera = mapa.keys().next().value;
    if (primera === undefined) break;
    mapa.delete(primera);
  }
};

const dentroDelLimite = (email: string) => {
  const ahora = Date.now();
  const previos = (intentos.get(email) ?? []).filter((t) => ahora - t < VENTANA_INTENTOS);
  if (previos.length >= LIMITE_INTENTOS) {
    intentos.set(email, previos);
    return false;
  }
  previos.push(ahora);
  intentos.set(email, previos);
  acotarMapa(intentos);
  return true;
};

const dentroDelLimiteGlobal = () => {
  const ahora = Date.now();
  while (intentosGlobales.length > 0 && ahora - intentosGlobales[0] > 60_000) {
    intentosGlobales.shift();
  }
  if (intentosGlobales.length >= 100) return false;
  intentosGlobales.push(ahora);
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

  const passwordHash = await hashPassword(password);

  try {
    const { token } = await db.transaction(async (tx) => {
      const [cuenta] = await tx
        .insert(accounts)
        .values({ email, passwordHash, visitorId: visitor })
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
  if (email.length > 254 || !EMAIL.test(email)) {
    return c.json({ error: "email inválido" }, 422);
  }
  if (!dentroDelLimiteGlobal()) return c.json({ error: "demasiados intentos" }, 429);
  if (!dentroDelLimite(`login:${email}`)) return c.json({ error: "demasiados intentos" }, 429);

  const [cuenta] = await db.select().from(accounts).where(eq(accounts.email, email)).limit(1);

  if (!cuenta) {
    await verificarPassword(password, HASH_FALSO);
    return c.json({ error: "credenciales inválidas" }, 401);
  }
  if (!(await verificarPassword(password, cuenta.passwordHash))) {
    return c.json({ error: "credenciales inválidas" }, 401);
  }

  await db.delete(sessions).where(lt(sessions.expiresAt, sql`now()`));

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
      affinity: { answers: await respuestasDe(visitor) },
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
  if (tieneControles(alias)) {
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
      affinity: { answers: await respuestasDe(visitor) },
    },
  });
});

// ------------------------------------------------------------------- botellas
// Postgres cuenta puntos de código y no admite \u0000: validamos igual que el CHECK de la tabla.
// Se permiten solo los saltos de línea y tabuladores; nada de otros controles ni bidi/zero-width.
const INVISIBLES = /[\p{Cc}\p{Cf}]/u;
const tieneInvisibles = (texto: string) => INVISIBLES.test(texto.replace(/[\n\r\t\u200d]/g, ""));
const tieneControles = (texto: string) => INVISIBLES.test(texto);

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
    const numero = Number(raw);
    if (!/^\d+$/.test(raw) || numero <= 0 || numero > ID_MAX) {
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

    const comunes = sql`(
      select count(*) from affinity_answers ma
      join affinity_answers sa on sa.question = ma.question and sa.visitor_id = ${bottles.authorVisitor}
      where ma.visitor_id = ${visitor}
        and (ma.question, ma.option) in (${sql.raw(PARES_SQL)})
        and (sa.question, sa.option) in (${sql.raw(PARES_SQL)})
    )`;
    const coincidencias = sql`(
      select count(*) from affinity_answers ma
      join affinity_answers sa on sa.question = ma.question and sa.visitor_id = ${bottles.authorVisitor}
      where ma.visitor_id = ${visitor}
        and ma.option = sa.option
        and (ma.question, ma.option) in (${sql.raw(PARES_SQL)})
        and (sa.question, sa.option) in (${sql.raw(PARES_SQL)})
    )`;
    const puntuacion = sql`case when ${comunes} >= 2 then round(${coincidencias} * 100.0 / ${comunes}) else 50 end`;

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
      .orderBy(sql`${puntuacion} desc, random()`)
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

  const salida = {
    estado: "ok" as "ok" | "fijada" | "ajena" | "no-existe" | "bloqueada",
  };
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

    if (visitor) {
      const [bloqueo] = await tx
        .select()
        .from(blocks)
        .where(bloqueoEntre(visitor, viva.authorVisitor))
        .limit(1);
      if (bloqueo) {
        salida.estado = "bloqueada";
        return;
      }
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
      if (d) {
        await barrerExpiradas(tx, [eq(reservations.bottleId, id)]);
        await tx.delete(reservations).where(eq(reservations.bottleId, id));
        // La botella se borra en blando: las notificaciones dejan de apuntar a ella.
        await tx.update(notifications).set({ bottleId: null }).where(eq(notifications.bottleId, id));
      }
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
  if (salida.estado === "bloqueada") {
    return c.json({ error: "no puedes interactuar con esa botella" }, 403);
  }
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

      const [bloqueo] = await tx
        .select()
        .from(blocks)
        .where(bloqueoEntre(visitor, viva.authorVisitor))
        .limit(1);
      if (bloqueo) return "bloqueada";

      // Las reservas expiradas no deben seguir ocupando la botella ni mi hueco, y avisan.
      await barrerExpiradas(tx, [eq(reservations.bottleId, id)]);
      await barrerExpiradas(tx, [eq(reservations.visitorId, visitor)]);

      await tx
        .insert(reservations)
        .values({ bottleId: id, visitorId: visitor, expiresAt: sql`now() + interval '48 hours'` });

      await notificar(tx, viva.authorVisitor, "botella_recogida", id);
      return true;
    });

    if (reservada === "bloqueada") {
      return c.json({ error: "no puedes interactuar con esa botella" }, 403);
    }
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
      authorAffinity: autora
        ? {
          percentage: await afinidadEntre(visitor, autora.visitorId),
          answers: await respuestasDe(autora.visitorId),
        }
        : { percentage: null, answers: {} },
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

    // Liberar mi propia reserva sigue permitido aunque esté bloqueado: nadie queda atrapado.

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

const leerBefore = (raw: string | undefined): number | undefined | "invalido" => {
  if (raw === undefined) return undefined;
  const numero = Number(raw);
  if (!/^\d+$/.test(raw) || numero <= 0 || numero > ID_MAX) return "invalido";
  return numero;
};

const mensajesDe = async (conversationId: number, visitor: string, before?: number) => {
  const condiciones = [eq(messages.conversationId, conversationId)];
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

  return filas
    .reverse()
    .map((m) => mensajePublico(m, m.senderVisitor === visitor, m.senderPublicId));
};

const conversacionDePareja = (a: string, b: string) =>
  and(
    isNull(conversations.bottleId),
    or(
      and(eq(conversations.visitorA, a), eq(conversations.visitorB, b)),
      and(eq(conversations.visitorA, b), eq(conversations.visitorB, a)),
    ),
  );

const validarTextoMensaje = (body: Record<string, unknown>) => {
  if (typeof body.text !== "string") return { error: "el mensaje es obligatorio" };
  const text = body.text.trim();
  if (tieneInvisibles(text)) return { error: "el mensaje contiene caracteres no permitidos" };
  const largo = [...text].length;
  if (largo < 1 || largo > 500) {
    return { error: "el mensaje debe tener entre 1 y 500 caracteres" };
  }
  return { text };
};

app.post("/api/bottles/:id/messages", async (c) => {
  const id = idValido(c.req.param("id"));
  if (id === null) return c.json({ error: "botella no encontrada" }, 404);

  const body = await leerCuerpo(c);
  if (!body) return c.json({ error: "cuerpo inválido" }, 400);

  const validado = validarTextoMensaje(body);
  if ("error" in validado) return c.json({ error: validado.error }, 422);
  const text = validado.text;

  const visitor = c.get("visitor");
  if (!visitor) return c.json({ error: "no participas en esa conversación" }, 403);

  const perfil = await perfilDe(visitor);
  if (!perfil) return c.json({ error: "necesitas un alias para escribir" }, 403);

  const salida = {
    estado: "ok" as "ok" | "no-existe" | "ajena" | "solo-lectora" | "expirada" | "bloqueada",
  };
  let creado: { id: number; text: string; senderAlias: string; createdAt: Date } | undefined;
  let conversacionId: number | undefined;

  await db.transaction(async (tx) => {
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

    if (!reserva?.confirmedAt) {
      if (!esLectora) {
        salida.estado = "solo-lectora";
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

    // La conversación de botella nace al confirmar; si otra petición la creó, se reutiliza.
    let [conversacion] = await tx
      .select()
      .from(conversations)
      .where(eq(conversations.bottleId, id))
      .limit(1);

    if (!conversacion) {
      await tx
        .insert(conversations)
        .values({
          bottleId: id,
          visitorA: bottle.authorVisitor,
          visitorB: reserva?.visitorId ?? visitor,
        })
        .onConflictDoNothing();
      [conversacion] = await tx
        .select()
        .from(conversations)
        .where(eq(conversations.bottleId, id))
        .limit(1);
    }

    conversacionId = conversacion.id;

    const [msg] = await tx
      .insert(messages)
      .values({
        conversationId: conversacion.id,
        senderVisitor: visitor,
        senderAlias: perfil.alias,
        text,
      })
      .returning();
    creado = msg;

    if (otra && otra !== visitor) {
      await notificar(tx, otra, "mensaje_nuevo", id, conversacion.id);
    }
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

  return c.json({ data: { ...mensajePublico(creado!, true, perfil.publicId), conversationId: conversacionId } }, 201);
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

  const before = leerBefore(c.req.query("before"));
  if (before === "invalido") return c.json({ error: "before debe ser un id positivo" }, 422);

  const [conversacion] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.bottleId, id))
    .limit(1);

  if (!conversacion) return c.json({ data: [] });

  return c.json({ data: await mensajesDe(conversacion.id, visitor, before) });
});

app.get("/api/conversations/:id/messages", async (c) => {
  const id = idValido(c.req.param("id"));
  if (id === null) return c.json({ error: "conversación no encontrada" }, 404);

  const [conversacion] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), isNull(conversations.bottleId)))
    .limit(1);
  if (!conversacion) return c.json({ error: "conversación no encontrada" }, 404);

  const visitor = c.get("visitor");
  const esParticipante = conversacion.visitorA === visitor || conversacion.visitorB === visitor;
  if (!visitor || !esParticipante) {
    return c.json({ error: "no participas en esa conversación" }, 403);
  }

  const otra = conversacion.visitorA === visitor ? conversacion.visitorB : conversacion.visitorA;
  if (await estanBloqueados(visitor, otra)) {
    return c.json({ error: "no puedes interactuar con esa persona" }, 403);
  }

  const before = leerBefore(c.req.query("before"));
  if (before === "invalido") return c.json({ error: "before debe ser un id positivo" }, 422);

  return c.json({ data: await mensajesDe(conversacion.id, visitor, before) });
});

app.post("/api/conversations/:id/messages", async (c) => {
  const id = idValido(c.req.param("id"));
  if (id === null) return c.json({ error: "conversación no encontrada" }, 404);

  const body = await leerCuerpo(c);
  if (!body) return c.json({ error: "cuerpo inválido" }, 400);

  const validado = validarTextoMensaje(body);
  if ("error" in validado) return c.json({ error: validado.error }, 422);
  const text = validado.text;

  const [conversacion] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), isNull(conversations.bottleId)))
    .limit(1);
  if (!conversacion) return c.json({ error: "conversación no encontrada" }, 404);

  const visitor = c.get("visitor");
  const esParticipante = conversacion.visitorA === visitor || conversacion.visitorB === visitor;
  if (!visitor || !esParticipante) {
    return c.json({ error: "no participas en esa conversación" }, 403);
  }

  const perfil = await perfilDe(visitor);
  if (!perfil) return c.json({ error: "necesitas un alias para escribir" }, 403);

  const otra = conversacion.visitorA === visitor ? conversacion.visitorB : conversacion.visitorA;
  if (await estanBloqueados(visitor, otra)) {
    return c.json({ error: "no puedes interactuar con esa persona" }, 403);
  }

  let creado: { id: number; text: string; senderAlias: string; createdAt: Date } | undefined;
  await db.transaction(async (tx) => {
    const [msg] = await tx
      .insert(messages)
      .values({
        conversationId: conversacion.id,
        senderVisitor: visitor,
        senderAlias: perfil.alias,
        text,
      })
      .returning();
    creado = msg;
    await notificar(tx, otra, "mensaje_nuevo", null, conversacion.id);
  });

  return c.json({ data: { ...mensajePublico(creado!, true, perfil.publicId), conversationId: conversacion.id } }, 201);
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

app.post("/api/profile/photos", async (c) => {
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
});

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
    const entreLaPareja = await tx
      .select({ bottleId: reservations.bottleId, visitorId: reservations.visitorId, expiresAt: reservations.expiresAt })
      .from(reservations)
      .innerJoin(bottles, eq(bottles.id, reservations.bottleId))
      .where(and(
        isNull(reservations.confirmedAt),
        or(
          and(eq(reservations.visitorId, visitor), eq(bottles.authorVisitor, objetivo.visitorId)),
          and(eq(reservations.visitorId, objetivo.visitorId), eq(bottles.authorVisitor, visitor)),
        ),
      ));

    await tx.delete(swipes).where(or(
      and(eq(swipes.visitorId, visitor), eq(swipes.targetVisitor, objetivo.visitorId)),
      and(eq(swipes.visitorId, objetivo.visitorId), eq(swipes.targetVisitor, visitor)),
    ));

    for (const reserva of entreLaPareja) {
      await tx
        .delete(reservations)
        .where(and(eq(reservations.bottleId, reserva.bottleId), isNull(reservations.confirmedAt)));
      if (reserva.expiresAt.getTime() <= Date.now()) {
        await notificar(tx, reserva.visitorId, "reserva_caducada", reserva.bottleId);
      }
    }
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
    if (
      typeof body.bottleId !== "number" || !Number.isSafeInteger(body.bottleId) ||
      body.bottleId <= 0 || body.bottleId > ID_MAX
    ) {
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

// --------------------------------------------------------------------- afinidad
app.get("/api/affinity/questions", (c) => {
  return c.json({
    data: PREGUNTAS.map((p) => ({
      id: p.id,
      text: p.text,
      options: p.options.map((o) => ({ id: o.id, text: o.text })),
    })),
  });
});

app.put("/api/affinity", async (c) => {
  const body = await leerCuerpo(c);
  if (!body) return c.json({ error: "cuerpo inválido" }, 400);

  const visitor = c.get("visitor");
  if (!visitor || !(await perfilDe(visitor))) {
    return c.json({ error: "necesitas un alias" }, 403);
  }

  const answers = body.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    return c.json({ error: "answers debe ser un objeto" }, 422);
  }

  const entradas: { question: string; option: string }[] = [];
  for (const [question, option] of Object.entries(answers as Record<string, unknown>)) {
    if (!OPCIONES.has(question)) {
      return c.json({ error: "pregunta desconocida" }, 422);
    }
    if (typeof option !== "string" || !OPCIONES.get(question)!.has(option)) {
      return c.json({ error: "opción inválida" }, 422);
    }
    if (tieneControles(question) || tieneControles(option)) {
      return c.json({ error: "respuesta inválida" }, 422);
    }
    entradas.push({ question, option });
  }

  // Reemplazo completo: lo que no venga, se borra.
  await db.transaction(async (tx) => {
    await tx.delete(affinityAnswers).where(eq(affinityAnswers.visitorId, visitor));
    if (entradas.length > 0) {
      await tx
        .insert(affinityAnswers)
        .values(entradas.map((e) => ({ visitorId: visitor, ...e })));
    }
  });

  return c.json({ data: { answers: await respuestasDe(visitor) } });
});

// ---------------------------------------------------------------- swipe / match
app.get("/api/deck", async (c) => {
  const visitor = c.get("visitor");
  if (!visitor || !(await perfilDe(visitor))) {
    return c.json({ error: "necesitas un alias" }, 403);
  }

  const comunes = sql`(
    select count(*) from affinity_answers ma
    join affinity_answers sa on sa.question = ma.question and sa.visitor_id = ${profiles.visitorId}
    where ma.visitor_id = ${visitor}
      and (ma.question, ma.option) in (${sql.raw(PARES_SQL)})
      and (sa.question, sa.option) in (${sql.raw(PARES_SQL)})
  )`;
  const coincidencias = sql`(
    select count(*) from affinity_answers ma
    join affinity_answers sa on sa.question = ma.question and sa.visitor_id = ${profiles.visitorId}
    where ma.visitor_id = ${visitor}
      and ma.option = sa.option
      and (ma.question, ma.option) in (${sql.raw(PARES_SQL)})
      and (sa.question, sa.option) in (${sql.raw(PARES_SQL)})
  )`;
  const puntuacion = sql`case when ${comunes} >= 2 then round(${coincidencias} * 100.0 / ${comunes}) else 50 end`;

  const yaDeslizados = db
    .select()
    .from(swipes)
    .where(and(eq(swipes.visitorId, visitor), eq(swipes.targetVisitor, profiles.visitorId)));
  const bloqueados = db
    .select()
    .from(blocks)
    .where(bloqueoEntre(visitor, profiles.visitorId));

  const [candidato] = await db
    .select({
      visitorId: profiles.visitorId,
      publicId: profiles.publicId,
      alias: profiles.alias,
      bio: profiles.bio,
    })
    .from(profiles)
    .where(and(
      ne(profiles.visitorId, visitor),
      notExists(yaDeslizados),
      notExists(bloqueados),
    ))
    .orderBy(sql`${puntuacion} desc, random()`)
    .limit(1);

  if (!candidato) return c.json({ data: null });

  return c.json({
    data: {
      publicId: candidato.publicId,
      alias: candidato.alias,
      bio: candidato.bio,
      photos: await fotosDe(candidato.visitorId),
      affinity: { percentage: await afinidadEntre(visitor, candidato.visitorId) },
    },
  });
});

app.post("/api/swipes", async (c) => {
  const body = await leerCuerpo(c);
  if (!body) return c.json({ error: "cuerpo inválido" }, 400);

  const visitor = c.get("visitor");
  if (!visitor || !(await perfilDe(visitor))) {
    return c.json({ error: "necesitas un alias" }, 403);
  }

  const publicId = typeof body.publicId === "string" ? body.publicId : "";
  if (!UUID.test(publicId)) return c.json({ error: "publicId inválido" }, 422);

  const action = body.action;
  if (action !== "like" && action !== "discard") {
    return c.json({ error: "action debe ser 'like' o 'discard'" }, 422);
  }

  const objetivo = await perfilPorPublicId(publicId);
  if (!objetivo) return c.json({ error: "persona no encontrada" }, 404);
  if (objetivo.visitorId === visitor) {
    return c.json({ error: "no puedes deslizarte a ti mismo" }, 422);
  }
  if (await estanBloqueados(visitor, objetivo.visitorId)) {
    return c.json({ error: "no puedes interactuar con esa persona" }, 403);
  }

  const [a, b] = [visitor, objetivo.visitorId].sort();

  const salida = {
    estado: "ok" as "ok" | "repetido" | "repetido-sin-match",
  };
  let resultado: { match: boolean; conversationId?: number } = { match: false };

  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${a}|${b}`}))`);

    const [existente] = await tx
      .select()
      .from(swipes)
      .where(and(eq(swipes.visitorId, visitor), eq(swipes.targetVisitor, objetivo.visitorId)))
      .limit(1);

    if (existente) {
      if (existente.action === "like" && action === "like") {
        const [conversacion] = await tx
          .select()
          .from(conversations)
          .where(conversacionDePareja(visitor, objetivo.visitorId))
          .limit(1);
        if (conversacion) {
          salida.estado = "repetido";
          resultado = { match: true, conversationId: conversacion.id };
          return;
        }
      }
      salida.estado = "repetido-sin-match";
      return;
    }

    await tx
      .insert(swipes)
      .values({ visitorId: visitor, targetVisitor: objetivo.visitorId, action });

    if (action !== "like") return;

    const [reciproco] = await tx
      .select()
      .from(swipes)
      .where(and(
        eq(swipes.visitorId, objetivo.visitorId),
        eq(swipes.targetVisitor, visitor),
        eq(swipes.action, "like"),
      ))
      .limit(1);
    if (!reciproco) return;

    let [conversacion] = await tx
      .select()
      .from(conversations)
      .where(conversacionDePareja(visitor, objetivo.visitorId))
      .limit(1);

    if (!conversacion) {
      [conversacion] = await tx
        .insert(conversations)
        .values({ visitorA: a, visitorB: b })
        .returning();

      await notificar(tx, visitor, "match_nuevo", null, conversacion.id);
      await notificar(tx, objetivo.visitorId, "match_nuevo", null, conversacion.id);
    }

    resultado = { match: true, conversationId: conversacion.id };
  });

  if (salida.estado === "repetido") return c.json({ data: resultado }, 200);
  if (salida.estado === "repetido-sin-match") {
    return c.json({ error: "ya deslizaste a esa persona" }, 409);
  }

  return c.json({ data: resultado }, 201);
});

app.get("/api/matches", async (c) => {
  const visitor = c.get("visitor");
  if (!visitor) return c.json({ error: "inicia sesión" }, 401);

  const filas = await db
    .select()
    .from(conversations)
    .where(and(
      isNull(conversations.bottleId),
      or(eq(conversations.visitorA, visitor), eq(conversations.visitorB, visitor)),
    ))
    .orderBy(desc(conversations.id))
    .limit(50);

  const data = [];
  for (const conversacion of filas) {
    const otro = conversacion.visitorA === visitor ? conversacion.visitorB : conversacion.visitorA;
    if (await estanBloqueados(visitor, otro)) continue;

    const perfil = await perfilDe(otro);
    if (!perfil) continue;

    data.push({
      conversationId: conversacion.id,
      publicId: perfil.publicId,
      alias: perfil.alias,
      createdAt: conversacion.createdAt,
    });
  }

  return c.json({ data });
});

// -------------------------------------------------------------------- grupos
const GRUPOS = [
  { id: "musica", title: "Música", description: "Discos, conciertos y descubrimientos." },
  { id: "cine", title: "Cine", description: "Películas, series y estrenos." },
  { id: "viajes", title: "Viajes", description: "Rutas, destinos y consejos." },
  { id: "libros", title: "Libros", description: "Lecturas y recomendaciones." },
  { id: "deporte", title: "Deporte", description: "Entrenar, competir y animar." },
  { id: "cocina", title: "Cocina", description: "Recetas y sitios donde comer." },
] as const;

const GRUPOS_VALIDOS = new Set<string>(GRUPOS.map((g) => g.id));

app.get("/api/groups", async (c) => {
  const visitor = c.get("visitor");

  const conteos = await db
    .select({ groupId: groupMembers.groupId, cuantos: count() })
    .from(groupMembers)
    .groupBy(groupMembers.groupId);

  const porGrupo = new Map(conteos.map((f) => [f.groupId, Number(f.cuantos)]));

  const misGrupos = visitor
    ? new Set(
      (await db
        .select({ groupId: groupMembers.groupId })
        .from(groupMembers)
        .where(eq(groupMembers.visitorId, visitor))).map((f) => f.groupId),
    )
    : new Set<string>();

  return c.json({
    data: GRUPOS.map((g) => ({
      id: g.id,
      title: g.title,
      description: g.description,
      members: porGrupo.get(g.id) ?? 0,
      joined: misGrupos.has(g.id),
    })),
  });
});

app.post("/api/groups/:id/join", async (c) => {
  const grupo = c.req.param("id");
  if (!GRUPOS_VALIDOS.has(grupo)) return c.json({ error: "grupo no encontrado" }, 404);

  const visitor = c.get("visitor");
  if (!visitor) return c.json({ error: "inicia sesión" }, 401);
  if (!(await perfilDe(visitor))) return c.json({ error: "necesitas un alias" }, 403);

  await db
    .insert(groupMembers)
    .values({ groupId: grupo, visitorId: visitor })
    .onConflictDoNothing();

  return c.body(null, 204);
});

app.delete("/api/groups/:id/leave", async (c) => {
  const grupo = c.req.param("id");
  if (!GRUPOS_VALIDOS.has(grupo)) return c.json({ error: "grupo no encontrado" }, 404);

  const visitor = c.get("visitor");
  if (!visitor) return c.json({ error: "inicia sesión" }, 401);

  await db
    .delete(groupMembers)
    .where(and(eq(groupMembers.groupId, grupo), eq(groupMembers.visitorId, visitor)));

  return c.body(null, 204);
});

app.get("/api/groups/:id/messages", async (c) => {
  const grupo = c.req.param("id");
  if (!GRUPOS_VALIDOS.has(grupo)) return c.json({ error: "grupo no encontrado" }, 404);

  const visitor = c.get("visitor");
  if (!visitor) return c.json({ error: "inicia sesión" }, 401);

  const [miembro] = await db
    .select()
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, grupo), eq(groupMembers.visitorId, visitor)))
    .limit(1);
  if (!miembro) return c.json({ error: "no eres miembro de ese grupo" }, 403);

  const before = leerBefore(c.req.query("before"));
  if (before === "invalido") return c.json({ error: "before debe ser un id positivo" }, 422);

  const condiciones = [eq(groupMessages.groupId, grupo)];
  if (before !== undefined) condiciones.push(lt(groupMessages.id, before));

  const bloqueados = db
    .select()
    .from(blocks)
    .where(bloqueoEntre(visitor, groupMessages.senderVisitor));

  const filas = await db
    .select({
      id: groupMessages.id,
      text: groupMessages.text,
      senderVisitor: groupMessages.senderVisitor,
      senderAlias: groupMessages.senderAlias,
      createdAt: groupMessages.createdAt,
      senderPublicId: profiles.publicId,
    })
    .from(groupMessages)
    .leftJoin(profiles, eq(profiles.visitorId, groupMessages.senderVisitor))
    .where(and(...condiciones, notExists(bloqueados)))
    .orderBy(desc(groupMessages.id))
    .limit(50);

  const data = filas.reverse().map((m) => ({
    id: m.id,
    text: m.text,
    alias: m.senderAlias,
    publicId: m.senderPublicId,
    mine: m.senderVisitor === visitor,
    createdAt: m.createdAt,
  }));

  return c.json({ data });
});

app.post("/api/groups/:id/messages", async (c) => {
  const grupo = c.req.param("id");
  if (!GRUPOS_VALIDOS.has(grupo)) return c.json({ error: "grupo no encontrado" }, 404);

  const body = await leerCuerpo(c);
  if (!body) return c.json({ error: "cuerpo inválido" }, 400);

  const visitor = c.get("visitor");
  if (!visitor) return c.json({ error: "inicia sesión" }, 401);

  const perfil = await perfilDe(visitor);
  if (!perfil) return c.json({ error: "necesitas un alias" }, 403);

  const validado = validarTextoMensaje(body);
  if ("error" in validado) return c.json({ error: validado.error }, 422);
  const text = validado.text;

  let creado:
    | { id: number; text: string; senderAlias: string; createdAt: Date }
    | undefined;
  let esMiembro = false;
  let estado: "ok" | "sin-membresia" = "ok";

  await db.transaction(async (tx) => {
    const [miembro] = await tx
      .select()
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, grupo), eq(groupMembers.visitorId, visitor)))
      .limit(1)
      .for("update");

    if (!miembro) {
      estado = "sin-membresia";
      return;
    }
    esMiembro = true;

    const [msg] = await tx
      .insert(groupMessages)
      .values({
        groupId: grupo,
        senderVisitor: visitor,
        senderAlias: perfil.alias,
        text,
      })
      .returning();
    creado = msg;
  });

  if (!esMiembro) return c.json({ error: "no eres miembro de ese grupo" }, 403);

  if (estado !== "ok" || !creado) {
    return c.json({ error: "no eres miembro de ese grupo" }, 403);
  }

  return c.json({
    data: {
      id: creado.id,
      text: creado.text,
      alias: creado.senderAlias,
      publicId: perfil.publicId,
      mine: true,
      createdAt: creado.createdAt,
    },
  }, 201);
});

// --------------------------------------------------------------------- planes
const distanciaKmSql = (lat: number, lng: number) => sql`
  2 * 6371 * asin(sqrt(least(1, greatest(0,
    power(sin(radians(${plans.lat} - ${lat}) / 2), 2) +
    cos(radians(${lat})) * cos(radians(${plans.lat})) *
    power(sin(radians(${plans.lng} - ${lng}) / 2), 2)
  ))))
`;

const numeroDeQuery = (raw: string | undefined) => {
  if (raw === undefined) return undefined;
  if (!/^-?\d+(\.\d+)?$/.test(raw)) return null;
  const numero = Number(raw);
  return Number.isFinite(numero) ? numero : null;
};

const fechaFutura = (valor: unknown) => {
  if (typeof valor !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(valor)) return null;
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(valor)) return null;
  const fecha = new Date(valor);
  return Number.isNaN(fecha.getTime()) ? null : fecha;
};

const conteosDePlanes = async (ids: number[]) => {
  if (ids.length === 0) return new Map<number, number>();
  const filas = await db
    .select({ planId: planAttendees.planId, cuantos: count() })
    .from(planAttendees)
    .where(and(inArray(planAttendees.planId, ids), eq(planAttendees.status, "confirmado")))
    .groupBy(planAttendees.planId);
  return new Map(filas.map((f) => [f.planId, Number(f.cuantos)]));
};

const misEstadosDePlanes = async (visitor: string | null, ids: number[]) => {
  if (!visitor || ids.length === 0) return new Map<number, string>();
  const filas = await db
    .select({ planId: planAttendees.planId, status: planAttendees.status })
    .from(planAttendees)
    .where(and(eq(planAttendees.visitorId, visitor), inArray(planAttendees.planId, ids)));
  return new Map(filas.map((f) => [f.planId, f.status]));
};

app.post("/api/plans", async (c) => {
  const body = await leerCuerpo(c);
  if (!body) return c.json({ error: "cuerpo inválido" }, 400);

  const visitor = c.get("visitor");
  if (!visitor) return c.json({ error: "inicia sesión" }, 401);
  if (!(await perfilDe(visitor))) return c.json({ error: "necesitas un alias" }, 403);

  const title = typeof body.title === "string" ? body.title.trim() : "";
  const description = body.description === undefined || body.description === null
    ? null
    : typeof body.description === "string" ? body.description.trim() : undefined;
  const place = typeof body.place === "string" ? body.place.trim() : "";
  const lat = typeof body.lat === "number" && Number.isFinite(body.lat) ? body.lat : null;
  const lng = typeof body.lng === "number" && Number.isFinite(body.lng) ? body.lng : null;
  const capacity = typeof body.capacity === "number" && Number.isInteger(body.capacity)
    ? body.capacity
    : null;
  const startsAt = fechaFutura(body.startsAt);

  const tituloLargo = largoTexto(title);
  if (tituloLargo < 3 || tituloLargo > 80 || tieneControles(title)) {
    return c.json({ error: "el título debe tener entre 3 y 80 caracteres" }, 422);
  }
  if (description !== null && (description === undefined || largoTexto(description) > 500 || tieneControles(description))) {
    return c.json({ error: "la descripción no puede pasar de 500 caracteres" }, 422);
  }
  const lugarLargo = largoTexto(place);
  if (lugarLargo < 3 || lugarLargo > 100 || tieneControles(place)) {
    return c.json({ error: "el sitio debe tener entre 3 y 100 caracteres" }, 422);
  }
  if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return c.json({ error: "coordenadas inválidas" }, 422);
  }
  if (capacity === null || capacity < 1 || capacity > 50) {
    return c.json({ error: "el aforo debe estar entre 1 y 50" }, 422);
  }
  if (!startsAt || startsAt.getTime() <= Date.now()) {
    return c.json({ error: "la fecha debe ser futura y con zona horaria" }, 422);
  }

  const [plan] = await db
    .insert(plans)
    .values({
      creatorVisitor: visitor,
      title,
      description,
      place,
      lat,
      lng,
      startsAt,
      capacity,
    })
    .returning();

  return c.json({ data: { id: plan.id } }, 201);
});

app.get("/api/plans", async (c) => {
  const visitor = c.get("visitor");
  const lat = numeroDeQuery(c.req.query("lat"));
  const lng = numeroDeQuery(c.req.query("lng"));
  const radioQuery = numeroDeQuery(c.req.query("radius"));

  if (lat === null || lng === null || radioQuery === null) {
    return c.json({ error: "coordenadas o radio inválidos" }, 422);
  }
  if ((lat === undefined) !== (lng === undefined)) {
    return c.json({ error: "manda lat y lng juntos" }, 422);
  }
  if (radioQuery !== undefined && lat === undefined) {
    return c.json({ error: "el radio necesita lat y lng" }, 422);
  }
  if (lat !== undefined && (Math.abs(lat) > 90 || Math.abs(lng!) > 180)) {
    return c.json({ error: "coordenadas inválidas" }, 422);
  }
  const radio = radioQuery ?? 25;
  if (!(radio > 0) || radio > 200) {
    return c.json({ error: "el radio debe estar entre 0 y 200 km" }, 422);
  }

  const condiciones = [gt(plans.startsAt, sql`now()`)];
  if (visitor) {
    condiciones.push(notExists(
      db.select().from(blocks).where(bloqueoEntre(visitor, plans.creatorVisitor)),
    ));
  }

  const campos = {
    id: plans.id,
    title: plans.title,
    description: plans.description,
    place: plans.place,
    startsAt: plans.startsAt,
    capacity: plans.capacity,
    creatorVisitor: plans.creatorVisitor,
  };

  let filas: (typeof campos extends never ? never : Record<string, unknown>)[];
  if (lat !== undefined && lng !== undefined) {
    const distancia = distanciaKmSql(lat, lng);
    filas = await db
      .select({ ...campos, distanceKm: distancia })
      .from(plans)
      .where(and(...condiciones, sql`${distancia} <= ${radio}`))
      .orderBy(distancia, plans.startsAt)
      .limit(50);
  } else {
    filas = await db
      .select({ ...campos, distanceKm: sql<number | null>`null` })
      .from(plans)
      .where(and(...condiciones))
      .orderBy(plans.startsAt)
      .limit(50);
  }

  const ids = filas.map((f) => f.id as number);
  const confirmados = await conteosDePlanes(ids);
  const mios = await misEstadosDePlanes(visitor, ids);

  return c.json({
    data: filas.map((f) => {
      const confirmed = confirmados.get(f.id as number) ?? 0;
      const capacity = f.capacity as number;
      return {
        id: f.id,
        title: f.title,
        description: f.description,
        place: f.place,
        startsAt: f.startsAt,
        distanceKm: f.distanceKm === null ? null : Number(f.distanceKm),
        capacity,
        confirmed,
        spotsLeft: Math.max(0, capacity - confirmed),
        isCreator: f.creatorVisitor === visitor,
        myStatus: mios.get(f.id as number) ?? null,
      };
    }),
  });
});

app.get("/api/plans/:id", async (c) => {
  const id = idValido(c.req.param("id"));
  if (id === null) return c.json({ error: "plan no encontrado" }, 404);

  const [plan] = await db.select().from(plans).where(eq(plans.id, id)).limit(1);
  if (!plan) return c.json({ error: "plan no encontrado" }, 404);

  const visitor = c.get("visitor");
  if (visitor && await estanBloqueados(visitor, plan.creatorVisitor)) {
    return c.json({ error: "plan no encontrado" }, 404);
  }

  const [confirmados] = await db
    .select({ cuantos: count() })
    .from(planAttendees)
    .where(and(eq(planAttendees.planId, id), eq(planAttendees.status, "confirmado")));

  const creator = await perfilDe(plan.creatorVisitor);
  const [mio] = visitor
    ? await db
      .select()
      .from(planAttendees)
      .where(and(eq(planAttendees.planId, id), eq(planAttendees.visitorId, visitor)))
      .limit(1)
    : [];

  return c.json({
    data: {
      id: plan.id,
      title: plan.title,
      description: plan.description,
      place: plan.place,
      startsAt: plan.startsAt,
      capacity: plan.capacity,
      confirmed: Number(confirmados.cuantos),
      spotsLeft: Math.max(0, plan.capacity - Number(confirmados.cuantos)),
      isCreator: plan.creatorVisitor === visitor,
      myStatus: mio?.status ?? null,
      creator: creator ? { alias: creator.alias, publicId: creator.publicId } : null,
    },
  });
});

app.post("/api/plans/:id/join", async (c) => {
  const id = idValido(c.req.param("id"));
  if (id === null) return c.json({ error: "plan no encontrado" }, 404);

  const visitor = c.get("visitor");
  if (!visitor) return c.json({ error: "inicia sesión" }, 401);
  if (!(await perfilDe(visitor))) return c.json({ error: "necesitas un alias" }, 403);

  const [plan] = await db.select().from(plans).where(eq(plans.id, id)).limit(1);
  if (!plan) return c.json({ error: "plan no encontrado" }, 404);
  if (await estanBloqueados(visitor, plan.creatorVisitor)) {
    return c.json({ error: "no puedes interactuar con esa persona" }, 403);
  }

  let estado = "confirmado";
  const salida = { valor: "ok" as "ok" | "pasado" | "no-existe" };

  await db.transaction(async (tx) => {
    const [vivo] = await tx
      .select()
      .from(plans)
      .where(eq(plans.id, id))
      .limit(1)
      .for("update");
    if (!vivo) {
      salida.valor = "no-existe";
      return;
    }
    if (vivo.startsAt.getTime() <= Date.now()) {
      salida.valor = "pasado";
      return;
    }

    const [existente] = await tx
      .select()
      .from(planAttendees)
      .where(and(eq(planAttendees.planId, id), eq(planAttendees.visitorId, visitor)))
      .limit(1);
    if (existente) {
      estado = existente.status;
      return;
    }

    const [confirmados] = await tx
      .select({ cuantos: count() })
      .from(planAttendees)
      .where(and(eq(planAttendees.planId, id), eq(planAttendees.status, "confirmado")));

    estado = Number(confirmados.cuantos) < vivo.capacity ? "confirmado" : "espera";
    await tx.insert(planAttendees).values({ planId: id, visitorId: visitor, status: estado });
  });

  if (salida.valor === "no-existe") return c.json({ error: "plan no encontrado" }, 404);
  if (salida.valor === "pasado") return c.json({ error: "el plan ya ha pasado" }, 409);

  return c.json({ data: { status: estado } });
});

app.delete("/api/plans/:id/leave", async (c) => {
  const id = idValido(c.req.param("id"));
  if (id === null) return c.json({ error: "plan no encontrado" }, 404);

  const visitor = c.get("visitor");
  if (!visitor) return c.json({ error: "inicia sesión" }, 401);

  const [plan] = await db.select().from(plans).where(eq(plans.id, id)).limit(1);
  if (!plan) return c.json({ error: "plan no encontrado" }, 404);

  await db.transaction(async (tx) => {
    const [vivo] = await tx
      .select()
      .from(plans)
      .where(eq(plans.id, id))
      .limit(1)
      .for("update");
    if (!vivo) return;

    const [fuera] = await tx
      .delete(planAttendees)
      .where(and(eq(planAttendees.planId, id), eq(planAttendees.visitorId, visitor)))
      .returning();
    if (!fuera || fuera.status !== "confirmado") return;

    const espera = await tx
      .select()
      .from(planAttendees)
      .where(and(eq(planAttendees.planId, id), eq(planAttendees.status, "espera")))
      .orderBy(planAttendees.id);

    for (const candidato of espera) {
      const [bloqueo] = await tx
        .select()
        .from(blocks)
        .where(bloqueoEntre(vivo.creatorVisitor, candidato.visitorId))
        .limit(1);
      if (bloqueo) continue;
      await tx
        .update(planAttendees)
        .set({ status: "confirmado" })
        .where(eq(planAttendees.id, candidato.id));
      break;
    }
  });

  return c.body(null, 204);
});

app.get("/api/plans/:id/attendees", async (c) => {
  const id = idValido(c.req.param("id"));
  if (id === null) return c.json({ error: "plan no encontrado" }, 404);

  const visitor = c.get("visitor");
  if (!visitor) return c.json({ error: "inicia sesión" }, 401);

  const [plan] = await db.select().from(plans).where(eq(plans.id, id)).limit(1);
  if (!plan) return c.json({ error: "plan no encontrado" }, 404);
  if (plan.creatorVisitor !== visitor) {
    return c.json({ error: "solo el creador ve los asistentes" }, 403);
  }

  const filas = await db
    .select({
      publicId: profiles.publicId,
      alias: profiles.alias,
      status: planAttendees.status,
      visitorId: planAttendees.visitorId,
    })
    .from(planAttendees)
    .innerJoin(profiles, eq(profiles.visitorId, planAttendees.visitorId))
    .where(eq(planAttendees.planId, id))
    .orderBy(planAttendees.id);

  const data = [];
  for (const fila of filas) {
    if (await estanBloqueados(visitor, fila.visitorId)) continue;
    data.push({ publicId: fila.publicId, alias: fila.alias, status: fila.status });
  }

  return c.json({ data });
});

// -------------------------------------------------------------- notificaciones
const publicaNotificacion = (n: {
  id: number;
  type: string;
  bottleId: number | null;
  conversationId: number | null;
  readAt: Date | null;
  createdAt: Date;
}) => ({
  id: n.id,
  type: n.type,
  bottleId: n.bottleId,
  conversationId: n.conversationId,
  read: n.readAt !== null,
  createdAt: n.createdAt,
});

app.get("/api/notifications", async (c) => {
  const visitor = c.get("visitor");
  if (!visitor) return c.json({ error: "inicia sesión" }, 401);

  // Red de seguridad: reservas expiradas mías que nadie haya barrido todavía.
  await db.transaction(async (tx) => {
    await barrerExpiradas(tx, [eq(reservations.visitorId, visitor)]);
  });

  const filas = await db
    .select()
    .from(notifications)
    .where(eq(notifications.visitorId, visitor))
    .orderBy(desc(notifications.id))
    .limit(50);

  const [pendientes] = await db
    .select({ cuantas: count() })
    .from(notifications)
    .where(and(eq(notifications.visitorId, visitor), isNull(notifications.readAt)));

  return c.json({
    data: filas.map(publicaNotificacion),
    unread: Number(pendientes.cuantas),
  });
});

app.post("/api/notifications/read-all", async (c) => {
  const visitor = c.get("visitor");
  if (!visitor) return c.json({ error: "inicia sesión" }, 401);

  await db
    .update(notifications)
    .set({ readAt: sql`now()` })
    .where(and(eq(notifications.visitorId, visitor), isNull(notifications.readAt)));

  return c.body(null, 204);
});

app.post("/api/notifications/:id/read", async (c) => {
  const visitor = c.get("visitor");
  if (!visitor) return c.json({ error: "inicia sesión" }, 401);

  const id = idValido(c.req.param("id"));
  if (id === null) return c.json({ error: "notificación no encontrada" }, 404);

  const [actualizada] = await db
    .update(notifications)
    .set({ readAt: sql`now()` })
    .where(and(eq(notifications.id, id), eq(notifications.visitorId, visitor)))
    .returning();
  if (!actualizada) return c.json({ error: "notificación no encontrada" }, 404);

  return c.body(null, 204);
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

import { Hono } from "@hono/hono";
import type { Context } from "@hono/hono";
import { logger } from "@hono/hono/logger";
import { bodyLimit } from "@hono/hono/body-limit";
import { HTTPException } from "@hono/hono/http-exception";
import { and, count, eq, gt, gte, isNull, lt, ne, notExists, sql } from "drizzle-orm";
import { db } from "./db/client.ts";
import { bottleViews, bottles, profiles, reservations, type Bottle } from "./db/schema.ts";

const VISITOR_COOKIE = "visitor";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const visitante = (c: Context): string | null => {
  const raw = c.req.header("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    const value = rest.join("=");
    if (name === VISITOR_COOKIE && UUID.test(value)) return value.toLowerCase();
  }
  return null;
};

const identificar = (c: Context): string => {
  const existente = visitante(c);
  if (existente) return existente;

  const visitor = crypto.randomUUID();
  c.header(
    "set-cookie",
    `${VISITOR_COOKIE}=${visitor}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
  );
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

const perfilDe = async (visitor: string) => {
  const [perfil] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.visitorId, visitor))
    .limit(1);
  return perfil ?? null;
};

export const app = new Hono();

app.use(logger());
app.use("/api/*", bodyLimit({ maxSize: 8 * 1024 }));

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

// -------------------------------------------------------------------- perfil
app.get("/api/profile", async (c) => {
  const visitor = visitante(c);
  if (!visitor) return c.json({ data: null });

  const perfil = await perfilDe(visitor);
  return c.json({ data: perfil ? { alias: perfil.alias } : null });
});

app.put("/api/profile", async (c) => {
  const body = await leerCuerpo(c);
  if (!body) return c.json({ error: "cuerpo inválido" }, 400);

  if (typeof body.alias !== "string") {
    return c.json({ error: "el alias es obligatorio" }, 422);
  }

  const alias = body.alias.trim();
  if (alias.length < 3 || alias.length > 20) {
    return c.json({ error: "el alias debe tener entre 3 y 20 caracteres" }, 422);
  }

  const visitor = identificar(c);

  const [perfil] = await db
    .insert(profiles)
    .values({ visitorId: visitor, alias })
    .onConflictDoUpdate({ target: profiles.visitorId, set: { alias } })
    .returning();

  return c.json({ data: { alias: perfil.alias } });
});

// ------------------------------------------------------------------- botellas
app.post("/api/bottles", async (c) => {
  const body = await leerCuerpo(c);
  if (!body) return c.json({ error: "cuerpo inválido" }, 400);

  if (typeof body.text !== "string") {
    return c.json({ error: "el texto es obligatorio" }, 422);
  }

  const text = body.text.trim();
  if (text.length === 0) {
    return c.json({ error: "el texto no puede estar vacío" }, 422);
  }
  if (text.length < 5) {
    return c.json({ error: "el texto debe tener al menos 5 caracteres" }, 422);
  }
  if (text.length > 240) {
    return c.json({ error: "el texto no puede superar los 240 caracteres" }, 422);
  }

  const visitor = visitante(c);
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
  const visitor = identificar(c);

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

    const [elegida] = await tx
      .select()
      .from(bottles)
      .where(and(
        isNull(bottles.destroyedAt),
        ne(bottles.authorVisitor, visitor),
        notExists(vistas),
        notExists(reservadas),
      ))
      .orderBy(sql`random()`)
      .limit(1)
      .for("update", { skipLocked: true });

    if (!elegida) return null;

    await tx.insert(bottleViews).values({ bottleId: elegida.id, visitorId: visitor })
      .onConflictDoNothing();

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

  const visitor = visitante(c);
  const [vista] = visitor
    ? await db
      .select()
      .from(bottleViews)
      .where(and(eq(bottleViews.bottleId, id), eq(bottleViews.visitorId, visitor)))
      .limit(1)
    : [];
  if (!vista) return c.json({ error: "no has visto esa botella" }, 403);

  if (action === "destroy") {
    const [activa] = await db
      .select()
      .from(reservations)
      .where(and(eq(reservations.bottleId, id), gt(reservations.expiresAt, sql`now()`)))
      .limit(1);
    if (activa && activa.visitorId !== visitor) {
      return c.json({ error: "la botella está reservada por otra persona" }, 409);
    }

    const [destruida] = await db
      .update(bottles)
      .set({ destroyedAt: new Date() })
      .where(and(eq(bottles.id, id), isNull(bottles.destroyedAt)))
      .returning();
    if (!destruida) return c.json({ error: "botella no encontrada" }, 404);
    return c.json({ data: publica(destruida) });
  }

  return c.json({ data: publica(bottle) });
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

  const visitor = visitante(c);
  if (!visitor) return c.json({ error: "no has visto esa botella" }, 403);

  const perfil = await perfilDe(visitor);
  if (!perfil) return c.json({ error: "necesitas un alias antes de recoger botellas" }, 403);

  const [vista] = await db
    .select()
    .from(bottleViews)
    .where(and(eq(bottleViews.bottleId, id), eq(bottleViews.visitorId, visitor)))
    .limit(1);
  if (!vista) return c.json({ error: "no has visto esa botella" }, 403);

  try {
    await db.transaction(async (tx) => {
      await tx
        .delete(reservations)
        .where(and(eq(reservations.visitorId, visitor), lt(reservations.expiresAt, sql`now()`)));
      await tx
        .insert(reservations)
        .values({ bottleId: id, visitorId: visitor, expiresAt: sql`now() + interval '48 hours'` });
    });
  } catch (err) {
    if (codigoError(err) === "23505") {
      return c.json({ error: "ya tienes una reserva o la botella ya está reservada" }, 409);
    }
    throw err;
  }

  const autora = await perfilDe(bottle.authorVisitor);
  return c.json({ data: { ...publica(bottle), authorAlias: autora?.alias ?? null } });
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

  const visitor = visitante(c);
  if (!visitor) return c.json({ error: "esa reserva no es tuya" }, 403);

  const [reserva] = await db
    .select()
    .from(reservations)
    .where(and(eq(reservations.bottleId, id), gt(reservations.expiresAt, sql`now()`)))
    .limit(1);
  if (!reserva) return c.json({ error: "no hay reserva vigente" }, 409);
  if (reserva.visitorId !== visitor) return c.json({ error: "esa reserva no es tuya" }, 403);

  await db.delete(reservations).where(eq(reservations.bottleId, id));
  return c.json({ data: publica(bottle) });
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

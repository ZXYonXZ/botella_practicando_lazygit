import { Hono } from "@hono/hono";
import { logger } from "@hono/hono/logger";
import { sql } from "drizzle-orm";
import { db } from "./db/client.ts";
import { bottles } from "./db/schema.ts";

export const app = new Hono();

app.use(logger());

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

// ------------------------------------------------------------------- botellas
app.post("/api/bottles", async (c) => {
  const body = await c.req.json();

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

  const [created] = await db.insert(bottles).values({ text: body.text }).returning();
  return c.json({ data: created }, 201);
});

// ------------------------------------------------------------------- errores
app.notFound((c) => c.json({ error: "ruta no encontrada", path: c.req.path }, 404));

app.onError((err, c) => {
  console.error("💥", err);
  return c.json({ error: "error interno del servidor" }, 500);
});

const port = Number(Deno.env.get("PORT") ?? 8000);

if (import.meta.main) {
  Deno.serve({ port }, (request) => app.fetch(request));
  console.log(`🔥 Hono escuchando en http://localhost:${port}`);
}

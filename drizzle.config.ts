import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dialect: "postgresql",
  driver: "pglite",
  dbCredentials: {
    url: Deno.env.get("PGDATA_DIR") ?? "./data/pgdata",
  },
  verbose: true,
  // En un proyecto real pon `strict: true` (pide confirmación antes de aplicar cambios).
  // Aquí lo dejamos en false para que `deno task db:push` funcione sin TTY.
  strict: false,
});

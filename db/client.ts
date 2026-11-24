import { drizzle } from "drizzle-orm/pglite";
import * as schema from "./schema.ts";

/**
 * PGlite persiste en ./data/pgdata (por defecto).
 * Para usar otra ruta: PGDATA_DIR=/otra/ruta deno task dev
 */
export const db = drizzle(Deno.env.get("PGDATA_DIR") ?? "./data/pgdata", { schema });

export { schema };

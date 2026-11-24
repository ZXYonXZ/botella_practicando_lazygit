# Botella

App de citas donde el primer contacto nace de una botella lanzada al mar.

API con **Hono + Deno + Drizzle ORM + PGlite** (Postgres en WASM, sin servidor externo).

## Requisitos

- Deno 2.9+ (`deno --version`)

## Puesta en marcha

```bash
deno install            # crea node_modules para el tooling de drizzle-kit
mkdir -p data           # PGlite necesita el directorio padre
deno task db:push       # sincroniza el esquema
deno task dev           # http://localhost:8000
```

> La primera vez `deno install` y `db:push` descargan dependencias (npm + JSR).

## Endpoints

| Método | Ruta      | Descripción                  |
| ------ | --------- | ---------------------------- |
| GET    | `/`       | Saludo                       |
| GET    | `/health` | Estado + versión de Postgres |

```bash
curl http://localhost:8000/health
```

## Tareas

| Tarea                   | Qué hace                                     |
| ----------------------- | -------------------------------------------- |
| `deno task dev`         | Servidor con `--watch`                       |
| `deno task start`       | Servidor sin watch                           |
| `deno task check`       | Type-check                                   |
| `deno task db:push`     | Sincroniza el esquema con la BD (desarrollo) |
| `deno task db:generate` | Genera SQL de migración en `db/migrations/`  |
| `deno task db:studio`   | Drizzle Studio                               |

## Estructura

```
main.ts             # app Hono + rutas
drizzle.config.ts   # configuración de drizzle-kit
db/
  schema.ts         # tablas y relaciones
  client.ts         # conexión PGlite + drizzle
  migrations/       # (se genera con db:generate)
data/pgdata/        # datos de PGlite (ignorado en git)
```

## Notas

- **Variables**: `PORT` (por defecto `8000`), `PGDATA_DIR` (por defecto `./data/pgdata`).
- **PGlite** es una sola conexión: perfecto para desarrollo local. En producción cambia
  `db/client.ts` por Neon/Supabase (`drizzle-orm/postgres-js`), Turso (`drizzle-orm/libsql`) o
  Cloudflare D1 (`drizzle-orm/d1`); el esquema y las consultas no cambian.
- `drizzle-kit` se ejecuta con Deno (`deno run -A npm:drizzle-kit`), no hace falta Node.
- Deno 2.9 aplica una política de **edad mínima de dependencias (24 h)**. Si una versión recién
  publicada queda bloqueada, usa `--min-dep-age 0` o fija una versión anterior.
- Los scripts que usan PGlite deben cerrar la conexión (`await db.$client.close()`), o el proceso no
  termina.

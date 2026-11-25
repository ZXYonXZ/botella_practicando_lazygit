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

| Método | Ruta                        | Descripción                                         |
| ------ | --------------------------- | --------------------------------------------------- |
| GET    | `/`                         | Saludo                                              |
| GET    | `/health`                   | Estado + versión de Postgres                        |
| POST   | `/api/auth/register`        | Crear cuenta (`{ email, password }`) → `{ token, email }` |
| POST   | `/api/auth/login`           | Iniciar sesión → `{ token, email }`                 |
| GET    | `/api/auth/me`              | Email de la cuenta (requiere `Bearer`)              |
| POST   | `/api/auth/logout`          | Cerrar la sesión actual                             |
| POST   | `/api/auth/logout-all`      | Cerrar todas las sesiones de la cuenta              |
| GET    | `/api/bottles/mine`         | Mis botellas con estado; `?before=<id>` para paginar |
| GET    | `/api/profile`              | Mi alias (o `null`)                                 |
| PUT    | `/api/profile`              | Crear o cambiar mi alias (`{ "alias" }`, 3–20)      |
| POST   | `/api/bottles`              | Lanzar botella (`{ "text" }`, 5–240) · 5 al día (429) |
| GET    | `/api/sea`                  | Una botella libre que este visitante no haya visto  |
| POST   | `/api/bottles/:id/discard`  | Descartar (`{ "action": "destroy" \| "return" }`)   |
| POST   | `/api/bottles/:id/pick`     | Recoger: reserva la botella 48 h                    |
| POST   | `/api/bottles/:id/release`  | Liberar mi reserva antes de tiempo                  |
| POST   | `/api/bottles/:id/messages` | Escribir en la conversación (`{ "text" }`, 1–500)   |
| GET    | `/api/bottles/:id/messages` | Últimos 50 mensajes; `?before=<id>` para los previos |

La identidad anónima viaja en la cookie `visitor` (UUID). Con cuenta se usa `Authorization: Bearer <token>`;
si el visitante de la cookie tiene cuenta, la cookie deja de valer (`401`).

Variables de entorno: `PORT` (8000), `PGDATA_DIR` (`./data/pgdata`) y **`TOKEN_PEPPER`** (≥32 bytes, obligatorio
en producción; sin él se usa uno de desarrollo y se avisa por consola). Las contraseñas se guardan con
PBKDF2-SHA256 (600 000 iteraciones) y los tokens solo como HMAC-SHA256 con ese pimiento.

Reglas: descartar exige haber visto la botella (`403` si no); una conversación fijada no se puede descartar ni liberar (`409`); mensajes de 1–500 con `?before=<id>` para paginar; `destroy` la saca del mar para todos para siempre y `return` no cambia su disponibilidad. El cuerpo de las peticiones está limitado a 8 KB (`413`).

```bash
curl http://localhost:8000/health
curl -X POST http://localhost:8000/api/bottles \
  -H 'content-type: application/json' \
  -d '{"text":"Hola desde el mar"}'
curl -c cookies.txt http://localhost:8000/api/sea
curl -b cookies.txt -X POST http://localhost:8000/api/bottles/1/discard \
  -H 'content-type: application/json' \
  -d '{"action":"return"}'
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
| `deno task test`        | Sincroniza la BD de test y corre la suite    |
| `deno task db:push:test`| Solo sincroniza el esquema de `data/test-pgdata` |

## Estructura

```
main.ts             # app Hono + rutas
api_test.ts         # tests HTTP de la API
drizzle.config.ts   # configuración de drizzle-kit
db/
  schema.ts         # tablas y relaciones
  client.ts         # conexión PGlite + drizzle
  migrations/       # (se genera con db:generate)
data/pgdata/        # datos de PGlite en desarrollo (ignorado en git)
data/test-pgdata/   # base separada para los tests (ignorada en git)
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
# botella_practicando_lazygit

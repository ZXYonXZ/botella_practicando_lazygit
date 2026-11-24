# Botella

## Producto

App de citas para público general. El primer contacto nace de una botella lanzada al mar: un mensaje que solo una persona puede tener recogido a la vez y que no caduca nunca. Cada persona puede lanzar 5 botellas nuevas al día. Gratis por ahora.

Decisiones caras de revertir: ninguna identificada.

## Stack

Decidido: Deno 2.9 + Hono 4 + Drizzle ORM + PGlite (Postgres en WASM, local). `drizzle-kit` se ejecuta con Deno.

## Convenciones

- Toda validación de entrada responde `422` con `{ "error": "motivo" }`; cuerpo ilegible o `null`, `400`.
- La identidad anónima viaja en la cookie `visitor` (UUID); no hay tabla de visitantes.
- Ver una botella la excluye para siempre para ese visitante (`bottle_views`).
- Destruir una botella es soft delete (`bottles.destroyed_at`); el mar ignora las destruidas.
- La API solo expone `{ id, text }` de una botella.
- Los tests son HTTP y corren con `deno task test` contra `data/test-pgdata`.
- Las rutas bajo `/api/*` limitan el cuerpo a 8 KB (`413`).
- Descartar exige haber visto la botella (`403` si no).
- Perfil obligatorio para lanzar y recoger: alias de 3–20 caracteres en `profiles` (cookie `visitor`). Sin perfil, `403`.
- El alias del autor solo se revela en la respuesta de `pick` (`authorAlias`); el mar y el descarte siguen sin identidad.
- El mar nunca te muestra tus propias botellas.
- Cupo: 5 botellas nuevas por visitante y día natural UTC (`429` al pasarse). Se cuenta `bottles.author_visitor`; destruir o recoger no devuelve cupo.
- Reservas: tabla `reservations(bottle_id PK, visitor_id UNIQUE, expires_at)`; una por visitante y botella. La expiración la calcula la BD (`now() + interval '48 hours'`) y es perezosa: no hay cron.

## Método

Flujo XP con los skills instalados: `/backlog` → `/story` → `/pair`.

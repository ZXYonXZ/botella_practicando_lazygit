# Botella

## Producto

App de citas para público general. El primer contacto nace de una botella lanzada al mar: un mensaje que solo una persona puede tener recogido a la vez y que no caduca nunca. Cada persona puede lanzar 5 botellas nuevas al día. Gratis por ahora.

Decisiones caras de revertir: ninguna identificada.

## Stack

Decidido: Deno 2.9 + Hono 4 + Drizzle ORM + PGlite (Postgres en WASM, local). `drizzle-kit` se ejecuta con Deno.

## Convenciones

- Toda validación de entrada responde `422` con `{ "error": "motivo" }`; cuerpo ilegible o `null`, `400`.
- Identidad: `Authorization: Bearer <token>` (cuentas) o cookie `visitor` (anónimos). Si la cookie pertenece a una cuenta, `401`: la cookie no sirve como identidad de cuenta.
- Cuentas: `accounts(email único normalizado, password_hash, visitor_id único)` adopta el UUID del visitante. `sessions(token_hash = HMAC-SHA256 con TOKEN_PEPPER, expires_at)`; caducidad 30 días; `logout` y `logout-all` la revocan al instante y limpian la cookie.
- PBKDF2-SHA256 600k para contraseñas; rate limit de 10 intentos por email y 15 min en login y registro.
- Ver una botella la excluye para siempre para ese visitante (`bottle_views`).
- Destruir una botella es soft delete (`bottles.destroyed_at`); el mar ignora las destruidas.
- La API expone `{ id, text }` de una botella; `pick` añade `authorAlias`, `authorPublicId`, `authorBio` y `authorPhotos`; los mensajes son `{ id, text, alias, publicId, mine, createdAt }`.
- Los tests son HTTP y corren con `deno task test` contra `data/test-pgdata`.
- Las rutas bajo `/api/*` limitan el cuerpo a 8 KB (`413`); `/api/profile/photos` acepta hasta 6 MB de cuerpo (5 MB por archivo) y el límite se aplica **antes** de la identidad.
- Fotos: `photos(id uuid, visitor_id → profiles, filename, mime)` y archivos en `UPLOADS_DIR`. El tipo se detecta por bytes con comprobación estructural (PNG con IHDR, JPEG con EOI, WebP con chunk VP8), máximo 6 por perfil con advisory lock y 10 subidas/día. `GET /api/photos/:id` es público por UUID y se salta identidad; los bytes se guardan tal cual (sin quitar EXIF).
- Bio: `profiles.bio` de 0–300, se expone en mi perfil y en `pick` como `authorBio` junto a `authorPhotos`; el mar nunca la muestra.
- Descartar exige haber visto la botella (`403` si no).
- Perfil obligatorio para lanzar y recoger: alias de 3–20 caracteres en `profiles` (cookie `visitor`). Sin perfil, `403`.
- El alias del autor solo se revela en la respuesta de `pick` (`authorAlias`); el mar y el descarte siguen sin identidad.
- Identidad pública: `profiles.public_id` (UUID) se expone en `GET /api/profile`, en `pick` (`authorPublicId`), en cada mensaje (`publicId`) y en `GET /api/blocks`. Nunca se expone el UUID del visitante.
- Bloqueo: `blocks(blocker_id, blocked_id)` en un solo sentido pero con efecto mutuo. Oculta el mar en ambos, corta el chat (`403` antes de confirmar), impide recoger y descartar; `release` sigue permitido. Bloquear libera reservas sin confirmar entre los dos. Desbloquear borra solo mi fila.
- Afinidad: 6 preguntas fijas en código (`affinity_answers`), opcional y parcial. `PUT /api/affinity` reemplaza (borra lo omitido). Afinidad entera 0–100 sobre preguntas en común; con menos de 2 en común es neutra (50). Se expone en `GET /api/profile` (`affinity.answers`) y en `pick` (`authorAffinity`); el mar ordena por afinidad y luego azar.
- Notificaciones: `notifications(visitor_id, type, bottle_id, read_at)` con tipos `botella_recogida`, `mensaje_nuevo` y `reserva_caducada`. Se insertan **dentro** de la transacción del evento; el aviso de caducidad se emite al borrar la reserva expirada (pick, bloqueo, destrucción). Retención: últimas 50 por visitante, recortando solo al insertar. La bandeja exige identidad (`401` sin cookie/Bearer).
- Reportes: `reports` con motivo fijo (`acoso`, `spam`, `perfil_falso`, `otro`), texto opcional de 1–500 y `bottleId` opcional; máximo 10 al día por visitante (`429`). Reportar no bloquea.
- El mar nunca te muestra tus propias botellas ni registra vistas si no tienes perfil.
- Mis botellas: `GET /api/bottles/mine` devuelve `{ id, text, status, createdAt }` (estado `en_el_mar`, `reservada`, `conversacion` o `destruida`, en ese orden de precedencia) y nunca revela quién la recogió.
- Chat: tabla `messages` por botella (con `sender_alias` congelado al escribir). El primer mensaje lo escribe quien recogió y fija la reserva (`confirmed_at`, `expires_at = 'infinity'`); a partir de ahí escriben los dos. La botella fijada es intocable: `discard` y `release` responden `409`.
- El índice único de reservas es parcial (`where confirmed_at is null`): una sola reserva sin confirmar por visitante, sin límite de conversaciones fijas.
- Las reservas expiradas se limpian al recoger; devolver al mar o destruir libera la reserva salvo que la conversación esté fijada (`409`).
- Toda operación que cambia el estado de una botella (recoger, destruir, devolver, liberar, confirmar) bloquea la fila con `FOR UPDATE` dentro de su transacción.
- Textos, mensajes y alias se miden en puntos de código (como `length()` de Postgres) y rechazan controles invisibles (`\p{Cc}`/`\p{Cf}`, salvo salto de línea y tabulador) y bidi.
- Cupo: 5 botellas nuevas por visitante y día natural UTC (`429` al pasarse). Se cuenta `bottles.author_visitor`; destruir o recoger no devuelve cupo.
- Reservas: tabla `reservations(bottle_id PK, visitor_id, expires_at, confirmed_at)` con índice único **parcial** sobre `visitor_id where confirmed_at is null`. La expiración la calcula la BD (`now() + interval '48 hours'`) y es perezosa: no hay cron.

## Método

Flujo XP con los skills instalados: `/backlog` → `/story` → `/pair`.

**Antes de aprobar un plan y su lista de tests**, pásale un reviewer en contexto fresco (subagente sin historial): que critique el plan contra el código y busque carreras, huecos y tests flojos. Se aplican los hallazgos antes de implementar.

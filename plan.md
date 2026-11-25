# Plan — Historia 2a (aprobada)

## Story
As a person, I want to write a text bottle and throw it into the sea, so that someone I don't know can find it.

## Acceptance criteria
- [ ] Given escribo un texto de 5 a 240 caracteres, when lo lanzo, then la botella queda en el mar disponible para ser asignada y no muestra quién la escribió.
- [ ] Given el texto está vacío, tiene menos de 5 o supera los 240 caracteres, when intento lanzarla, then no se lanza y veo el motivo.
- [ ] Given ya tengo botellas en el mar, when lanzo otra, then la nueva se suma sin afectar a las anteriores.

## Plan
- Pantalla para escribir la botella y lanzarla.
- Guardar la botella con su texto y estado «en el mar», sin ningún dato visible del autor.
- Validar texto vacío y longitud máxima (240) antes de aceptar el lanzamiento.
- Mostrar confirmación al lanzar y un estado vacío claro en el mar.
- Nada de listas, perfiles, notificaciones ni chat todavía.

## Out of scope
- Tope de 5 botellas nuevas al día (historia #3).
- Perfil e identidad de quien lanza (historia #4).
- Chat al recogerla (historia #5) y ver mis botellas (#6).
- Fotos o audio en la botella.
- Cómo se elige a quién se asigna (la afinidad llega en la #11; aquí cualquiera libre).

## Suggestions (your call)
- Ninguna: el proyecto está vacío, no hay código que justifique ningún patrón.

## Pendiente antes de implementar
- Stack sin decidir (historia #1).

---

# Plan — Historia 2b (aprobada)

## Story
As a person, I want the sea to show me one free bottle I haven't seen before, so that I only get bottles that are new to me.

## Acceptance criteria
- [ ] Given hay botellas libres que no he visto, when pido una, then recibo una (texto e id, sin autor) y el servidor me identifica con una cookie anónima si aún no la tengo.
- [ ] Given ya vi una botella, when pido otra, then esa no me vuelve a tocar mientras queden otras.
- [ ] Given no quedan botellas libres que no haya visto, when pido una, then recibo `200` con `data: null`.

## Plan
- `GET /api/sea`: una botella al azar que este visitante no haya visto.
- Cookie anónima puesta por el servidor la primera vez, con duración larga.
- Tabla de vistas (visitante, botella): lo mostrado a alguien no se le vuelve a mostrar, pero sigue libre para los demás.
- `200` con `data: null` cuando no queda ninguna.
- Sin perfiles, reservas ni chat.

## Out of scope
- Descartar y sus dos resultados (historia 2d).
- Reserva de 48 h (2c), perfiles (4), tope diario (3), ver mis botellas (6).

---

# Plan — Historia 2d (aprobada)

## Story
As a person, I want to decide what happens to a bottle I don't want, so that I can destroy it or put it back in the sea.

## Acceptance criteria
- [ ] Given veo una botella que no quiero, when la descarto destruyéndola, then nadie más puede recibirla y a mí tampoco me vuelve a tocar.
- [ ] Given veo una botella que no quiero, when la descarto devolviéndola al mar, then otros sí pueden recibirla, pero a mí no me vuelve a tocar.

## Plan
- `POST /api/bottles/:id/discard` con `{ "action": "destroy" | "return" }`.
- Destruir: saca la botella del mar para todos, para siempre.
- Devolver: no cambia su disponibilidad; solo queda registrado que yo ya no la veré.
- Rechazar con `422` cualquier `action` distinta de esas dos.
- Sin perfiles ni notificaciones.

## Out of scope
- Recoger la botella y reservarla (2c).
- Cualquiera que vea la botella puede destruirla (aunque no sea suya).

---

# Plan — Historia 2c (aprobada)

## Story
As a person, I want a bottle I pick to stay reserved to me for 48 hours, so that nobody else takes it while I decide. Requires: 2a, 2b

## Acceptance criteria
- [ ] Given una botella que me tocó ver y no está reservada, when la recojo, then queda reservada a mí 48 h y ninguna otra visita puede recibirla.
- [ ] Given mi reserva expira o la libero, when alguien pide en el mar, then puede recibirla, pero a mí no me vuelve a tocar.
- [ ] Given no la he visto, ya tengo otra reserva vigente o la tiene otro, when intento recogerla, then recibo un error y nada cambia.

## Plan
- Tabla `reservations(bottle_id PK, visitor_id UNIQUE, expires_at)`: la PK impide que dos personas reserven la misma botella y el `UNIQUE(visitor_id)` impide dos reservas a la vez. Nada de columnas en `bottles`.
- `expires_at` lo calcula la **base de datos** (`now() + interval '48 hours'`), no la aplicación: un solo reloj.
- Al recoger, en una transacción: borrar mis reservas expiradas, insertar la nueva. El choque de claves es el que decide, no un `SELECT` previo.
- El mar excluye las botellas con reserva vigente (`expires_at > now()`); expirar es perezoso, sin proceso en segundo plano.
- Liberar borra mi reserva y la devuelve al mar. Destruir una botella reservada por otro responde `409`.

## Reglas decididas
- Una sola botella reservada a la vez.
- Solo se puede recoger una botella que conste en `bottle_views` de ese visitante.
- Reservar exige que la botella no esté destruida.
- Al expirar, vuelve al mar para otros, pero ese visitante ya no la vuelve a ver (las vistas no se borran).
- Se puede liberar antes de tiempo, y **liberar es irreversible para quien libera**: no la volverá a ver aunque vuelva al mar.
- Si soy yo quien tiene la reserva: puedo destruirla (desaparece) o devolverla (se libera y queda para otros). Si es de otro: `409`.

## Rutas
- `POST /api/bottles/:id/pick`
- `POST /api/bottles/:id/release`

## Precedencia de errores
1. `404` si la botella no existe o está destruida.
2. `403` si no me tocó verla, o si intento liberar una reserva que no es mía.
3. `409` si ya la tiene otro, si ya tengo otra reserva vigente o si ya la tengo yo.

## Out of scope
- Responder, chat y avisos (historias 5, 10).
- Ver «mis botellas» y el estado de cada reserva (historia 6).
- Qué pasa al responder antes de las 48 h (historia 5).
- Avisar a quien reservó de que su reserva expiró (historia 10).

## Nota de test
La expiración se simula poniendo `expires_at` en el pasado en la BD del test. Al calcularla la BD, el borde de las 48 h no depende del reloj del proceso y la prueba es determinista.

---

# Plan — Historia 3 (aprobada)

## Story
As a person, I want to throw at most 5 new bottles a day, so that the sea doesn't flood with throwaway messages.

## Acceptance criteria
- [ ] Given he lanzado menos de 5 botellas hoy, when lanzo otra, then se publica en el mar y mi cupo del día baja en uno.
- [ ] Given ya lancé 5 hoy, when intento lanzar la sexta, then recibo `429` y no se publica.
- [ ] Given ha cambiado el día (UTC), when lanzo, then vuelvo a tener 5 disponibles.

## Plan
- `bottles.author_visitor` (la cookie `visitor`): `POST /api/bottles` identifica al visitante y reparte cookie si falta.
- El cupo no se guarda en ninguna tabla: se cuentan las botellas del visitante con `created_at` en el día UTC actual, según el reloj de la BD.
- Si ya hay 5, `429` antes de insertar. Destruir o recoger no devuelve cupo: cuenta todo lanzamiento.
- Contar e insertar van en una transacción con `pg_advisory_xact_lock` sobre el visitante.
- Nada de «mis botellas» ni de UI (historia 6).

## Out of scope
- Ver cuántas me quedan o la lista de las mías (historia 6).
- Límites por IP, captchas o antispam.
- Que el cupo se recupere de forma parcial o móvil.

---

# Plan — Historia 4 (aprobada)

## Story
As a person, I want a minimal profile when I throw or pick a bottle, so that the other person knows who they're talking to.

## Acceptance criteria
- [ ] Given no tengo perfil, when pongo un alias de 3–20 caracteres, then queda guardado y asociado a mi cookie de visitante.
- [ ] Given no tengo perfil, when intento lanzar o recoger una botella, then recibo `403` y no ocurre nada.
- [ ] Given recogí una botella, when la recojo, then veo el alias de quien la lanzó; en el mar y para el resto, sigue siendo anónima.
- [ ] Given lancé una botella, when alguien la recoge, then yo no veo quién la recogió.

## Plan
- Tabla `profiles(visitor_id PK, alias varchar(20))`; sin cuentas todavía (historia 8).
- `PUT /api/profile` crea o actualiza mi alias y reparte cookie; `GET /api/profile` devuelve el mío o `null`.
- `POST /api/bottles` y `/pick` exigen perfil (`403` si no).
- El alias del autor solo viaja en la respuesta de `pick`; el mar y `discard` siguen devolviendo `{ id, text }`.
- Nada de fotos, edad ni chat (historias 7, 5).

## Out of scope
- Fotos, edad, género.
- Ver el perfil de quien recogió (simetría). No hay endpoint que lo exponga.
- Alias únicos: dos personas pueden llamarse igual.

---

# Plan — Historia 5 (aprobada)

## Story
As a person, I want to chat with the person whose bottle I picked up, so that the first contact can continue.

## Acceptance criteria
- [ ] Given recogí una botella, when envío el primer mensaje, then la conversación queda fija y la botella no vuelve al mar nunca.
- [ ] Given la conversación está fija, when el autor responde, then ambos escribimos y leemos, cada uno con el alias del otro.
- [ ] Given no soy participante, o soy el autor y no hay primer mensaje, when intento leer o escribir, then recibo `403`.

## Modelo
- `messages(id serial, bottle_id, sender_visitor, text varchar(500), created_at)`; la conversación es la botella.
- `messages.bottle_id` referencia `bottles` con `on delete cascade` e índice `(bottle_id, id)`.
- `reservations.confirmed_at` nullable. Al confirmar: `confirmed_at = now()` y `expires_at = 'infinity'`.
- El `UNIQUE(visitor_id)` pasa a **índice único parcial** `where confirmed_at is null`: solo se puede tener una reserva sin confirmar, pero las conversaciones fijas no ocupan hueco.

## Reglas
- Primer mensaje: solo quien tiene la reserva vigente. Es una sola sentencia atómica (`update … where bottle_id = $1 and visitor_id = $2 and confirmed_at is null and expires_at > now()`) más el `insert` del mensaje, en la misma transacción. Si no actualiza fila → `409`.
- Tras confirmar, escriben los dos. El autor nunca puede escribir sin primer mensaje.
- Leer: el que recoge puede leer el chat vacío antes de escribir (`200 []`); el autor, `403` hasta que exista el primer mensaje; un tercero, `403` siempre.
- Mensajes de 1–500 caracteres, medidos en puntos de código, sin caracteres de control.
- Botella con conversación fija: **intocable** — `discard` (destroy o return) y `release` responden `409`.
- El mar excluye las conversaciones fijas (al poner `expires_at = 'infinity'` ya queda fuera).
- Tras fijar, quien recogió puede recoger otra botella.

## Rutas
- `POST /api/bottles/:id/messages` → `201 { data: { id, text, alias, mine, createdAt } }`
- `GET /api/bottles/:id/messages?before=<id>` → `200 { data: [...] }`, últimos 50 en orden ascendente

`alias` es el del emisor; `mine` indica si el mensaje es de quien consulta (los alias pueden repetirse).

## Out of scope
- Tiempo real, notificaciones (historia 10).
- Fotos o audio, borrar mensajes, bloqueo (historia 9).
- «Mis botellas» y el estado de la conversación (historia 6).
- Cerrar o archivar conversaciones.

## Nota de test
La expiración se simula poniendo `expires_at` en el pasado en la BD, igual que en la 2c.

---

# Plan — Historia 6 (aprobada)

## Story
As a person, I want to see the bottles I threw and whether they were picked up, so that I know if I got an answer.

## Acceptance criteria
- [ ] Given tengo botellas lanzadas, when pido mi lista, then veo solo las mías con texto, fecha y estado: `en_el_mar`, `reservada`, `conversacion` o `destruida`.
- [ ] Given tengo más de 50, when pido la lista, then recibo las últimas 50 y puedo pedir las anteriores con `?before=<id>`.
- [ ] Given una botella de mi lista, when la miro, then no aparece quién la recogió.

## Plan
- `GET /api/bottles/mine?before=<id>` → `{ data: [{ id, text, status, createdAt }] }`, últimas 50 en orden ascendente.
- Estado derivado en una consulta con `left join` a `reservations`: `destruida` si `destroyed_at`; `conversacion` si `confirmed_at`; `reservada` si `expires_at > now()`; si no, `en_el_mar`.
- Filtra por `author_visitor`; sin cookie, `200 []`.
- Nunca expone `author_visitor` ni quién la recogió.
- Solo lectura.

## Out of scope
- Editar o borrar botellas (hoy nadie puede destruir la suya propia: no tiene vista de ella).
- Contadores, notificaciones (historia 10).
- Ver el chat desde aquí.

---

# Plan — Historia 8 (aprobada v4: sesiones opacas)

## Story
As a person, I want to sign in again on another device and keep my chats, so that I don't lose my history.

## Acceptance criteria
- [ ] Given soy anónimo con perfil, botellas o chats, when me registro con email y contraseña, then mi historia pasa a la cuenta y recibo un token de sesión.
- [ ] Given tengo cuenta, when inicio sesión en otro dispositivo, then veo las mismas botellas, chats y alias.
- [ ] Given mi visitante ya tiene cuenta, when uso solo la cookie, then recibo `401`.
- [ ] Given un token se filtra, when cierro esa sesión (o todas), then ese token deja de valer al instante.

## Sesiones
- `sessions(id serial, account_id not null → accounts on delete cascade, token_hash varchar(64) not null unique, created_at, expires_at not null)` + índice por `account_id`.
- Token de 32 bytes aleatorios, base64url (43 caracteres), en `Authorization: Bearer`.
- En BD se guarda `hex(HMAC-SHA256(token, TOKEN_PEPPER))`. Se calcula **una vez** y se busca por el índice único; no se re-verifica con `subtle.verify` (comparar digests en SQL es suficiente y no tiene el problema de «verify necesita el dato original»).
- `TOKEN_PEPPER` (≥32 bytes) se inyecta al construir la app (`crearAuth(pepper)`); validar solo al arrancar el servidor, para que los tests puedan pasar uno propio. Rotarlo invalida todas las sesiones.
- Caducidad absoluta 30 días con el reloj de la BD (`expires_at > now()`). Sin renovación deslizante.
- `POST /api/auth/logout` borra la sesión actual y **limpia la cookie `visitor`** (`Max-Age=0`), para que el dispositivo pueda volver a ser anónimo. `POST /api/auth/logout-all` borra todas las de la cuenta y también limpia la cookie.

## Identidad y migración
- `accounts(id, email varchar(254) not null unique, password_hash, visitor_id varchar(64) not null unique, created_at)`. Email guardado ya normalizado (`trim().toLowerCase()`), así `UNIQUE` basta.
- La cuenta adopta el UUID del visitante actual: perfil, botellas, vistas, reservas y mensajes siguen colgando de él sin migrar datos.
- Registro e login **reescriben la cookie `visitor`** con el UUID de la cuenta (mismo helper de cookie, `Path=/; HttpOnly; SameSite=Lax`; `Secure` en producción).
- Registro sin cookie: se crea un visitante y se adopta.
- Registro con cookie de un visitante que ya tiene cuenta → `409`.
- El historial anónimo de **otro** dispositivo (cookie W) no se fusiona: se abandona, y su cupo de 5/día no se transfiere (documentado).

## Middleware
- Resuelve identidad, **no crea visitantes**.
- `Bearer` presente: HMAC → sesión vigente → cuenta. Inválido, caducado o revocado → `401` (nunca cae a la cookie).
- Cookie cuyo visitante tiene cuenta → `401` en todo `/api/*` salvo `/api/auth/*`. Se normaliza a minúsculas antes de buscar la cuenta.
- Cookie anónima (aunque esté malformada) → se ignora y la ruta decide; las rutas que reparten cookie lo hacen con `repartirCookie()`: solo `GET /api/sea` y `PUT /api/profile`, y nunca si llegó `Bearer`.
- Las rutas leen `identidad(c)`; se conservan las ramas de identidad nula (`release` sin cookie → `403`, `mine` → `[]`, `profile` → `null`).
- Sustituir los 10 usos actuales de `visitante()`/`identificar()` uno por uno, con test de regresión.

## Contraseñas
- PBKDF2-SHA256, 600 000 iteraciones, sal de 16 bytes: `pbkdf2-sha256$600000$<sal>$<hash>`; verificación comparando byte a byte con XOR (no `===`) y validando el número de iteraciones guardado.
- Longitud 8–128 **puntos de código**, sin recortar la contraseña.
- Login con email inexistente y contraseña incorrecta: mismo `401` (mismo cuerpo) y derivación falsa en el caso inexistente.
- Rate limit en memoria por **email normalizado**: 10 intentos cada 15 minutos → `429`; si hay proxy y cabecera de IP fiable, también por IP. Exportar `resetRateLimit()` para los tests.

## Rutas
- `POST /api/auth/register` → `201 { data: { token, email } }` (en transacción: cuenta + sesión; `23505` → `409`)
- `POST /api/auth/login` → `200 { data: { token, email } }`
- `GET /api/auth/me` → `200 { data: { email } }` con Bearer; `401` sin él
- `POST /api/auth/logout` → `204` · `POST /api/auth/logout-all` → `204`
- Nunca se devuelven `visitor_id`, `password_hash` ni el hash del token.

## Out of scope
- Recuperar o cambiar contraseña, verificar email, borrar cuenta.
- Renovación deslizante, listar dispositivos, 2FA.
- Fusionar el historial anónimo de un segundo dispositivo.
- OAuth o passkeys.

## Nota de test
`TOKEN_PEPPER` de test se define antes de importar `main.ts`; la app se construye con `crearAuth(pepper)` para poder probar otro pimiento. La caducidad se simula poniendo `expires_at` en el pasado.

## Lista de tests

| # | Test |
|---|---|
| 1 | Registro: claves exactas `{token,email}`, cookie `visitor` = UUID de la cuenta, `/me` con el token |
| 2 | Registro sin cookie reparte visitante y lo adopta |
| 3 | Registro con cookie de un visitante que ya tiene cuenta → `409` |
| 4 | Email duplicado, también con distinto caso → `409`; nunca `500` |
| 5 | Dos registros concurrentes con el mismo email: uno `201`, otro `409` |
| 6 | Contraseña de 7 y de 129 puntos de código (emojis incluidos) → `422`; email inválido o demasiado largo → `422` |
| 7 | Login con email en mayúsculas y con espacios → `200` |
| 8 | Contraseña incorrecta y email inexistente → mismo `401` y ninguna sesión creada |
| 9 | En BD no hay contraseña ni token en claro; el digest HMAC no vale como Bearer; dos cuentas con la misma contraseña tienen hashes distintos |
| 10 | La historia anónima (perfil, botellas, reservas, mensajes) se ve con el token y sin cookie |
| 11 | Cookie sola con cuenta → `401` en `sea`, `mine`, `profile` y `messages` |
| 12 | Cookie de cuenta en mayúsculas → `401` |
| 13 | Token basura, inexistente, caducado o calculado con otro pimiento → `401` |
| 14 | `logout` invalida ese token y deja viva otra sesión de la misma cuenta |
| 15 | `logout-all` invalida todas las sesiones de la cuenta |
| 16 | `logout` limpia la cookie `visitor` y el dispositivo vuelve a ser anónimo |
| 17 | `Bearer` válido + cookie ajena usa la cuenta y no emite `Set-Cookie` en `sea` ni en `PUT /profile` |
| 18 | `Bearer` inválido + cookie con cuenta → `401`, sin degradar a cookie |
| 19 | Cookie anónima malformada sigue comportándose como hoy (se ignora, no `401`) |
| 20 | Cupo entre dispositivos: 5 lanzadas con A, login en B, la 6.ª → `429` |
| 21 | Rate limit: 11 intentos del mismo email (con y sin mayúsculas) → `429`; otro email no se ve afectado |
| 22 | Regresión: los 90 tests siguen verdes; limpieza de `accounts`/`sessions` y `resetRateLimit()` |

---

# Plan — Historia 9 (aprobada v2: bloquear y reportar)

## Story
As a person, I want to block and report someone, so that I can cut off unwanted contact.

## Acceptance criteria
- [ ] Given bloqueo a alguien, when miro el mar, intento recoger o escribimos, then nada de eso ocurre en ningún sentido; un tercero sigue viendo todo.
- [ ] Given yo lo bloqueé y no hay bloqueo de vuelta, when lo desbloqueo, then el mar y el chat vuelven a la normalidad.
- [ ] Given alguien me acosa, when lo reporto con un motivo, then queda registrado para moderación y el reporte no bloquea.

## Modelo
- `blocks(blocker_id varchar(64), blocked_id varchar(64), created_at, PK(blocker_id, blocked_id))`, `CHECK (blocker_id <> blocked_id)` e índice por `blocked_id`.
- Un bloqueo se guarda en un sentido y **surte efecto en ambos**. Desbloquear borra **solo mi fila**: si la otra persona también me bloqueó, sigue bloqueado (documentado).
- `reports(id, reporter_id, reported_id, reason, text, bottle_id nullable, created_at)` con `CHECK` de motivo y longitud.
- `profiles.public_id uuid UNIQUE DEFAULT gen_random_uuid()`: identificador público para bloquear y reportar. **Nunca** se expone el UUID del visitante.
- `public_id` se expone en `GET /api/profile`, en `pick` como `authorPublicId`, en cada mensaje como `senderPublicId` y en `GET /api/blocks`. Es estable al cambiar de alias.

## Rutas
- `POST /api/blocks` `{ publicId }` → `201` (idempotente: repetir devuelve `201` sin duplicar)
- `DELETE /api/blocks/:publicId` → `204`; `404` si no existía
- `GET /api/blocks` → `{ data: [{ publicId, alias }] }`, orden por fecha de bloqueo, máximo 50
- `POST /api/reports` `{ publicId, reason, text?, bottleId? }` → `201`

## Efectos (tabla completa)
| Ruta | Con bloqueo entre las dos personas |
|---|---|
| `GET /api/sea` | No aparecen botellas del otro en ningún sentido |
| `POST /pick` | `403` |
| `POST /discard` (destroy/return) | `403` |
| `POST /messages` (GET y POST) | `403`; **antes** de confirmar la reserva |
| `POST /release` | Permitido: no se puede dejar a nadie atrapado en una reserva |
| `GET /api/bottles/mine` | Sin cambios (siguen siendo mis botellas) |
| `GET /api/blocks` | Solo mis bloqueos |

- Al crear un bloqueo, las **reservas sin confirmar** entre los dos se liberan y la botella vuelve al mar. Una conversación ya confirmada no se borra: queda ilegible (`403`) hasta desbloquear.
- El bloqueo no destruye botellas ni mensajes: un tercero no nota nada.

## Reglas y errores
1. `400` cuerpo inválido · `422` `publicId` malformado, motivo inventado, texto >500 o con invisibles, bloquearse a sí mismo · `404` `publicId` inexistente · `401` identidad requerida (las dos partes necesitan perfil).
2. Motivos: `acoso`, `spam`, `perfil_falso`, `otro`; `text` opcional de 1–500 puntos de código; `bottleId` opcional debe existir (contexto para moderación).
3. Reportes: máximo 10 al día por visitante → `429`. El reporte **no** crea bloqueo.

## Out of scope
- Panel de moderación, resolver reportes, avisar al reportado.
- Bloquear por botella o mensaje; «reportar y bloquear» en una acción.
- Límite de bloqueos o deduplicación de reportes.

## Nota de test
`crearVisita` pasa a devolver `{ cookie, visitorId, publicId }`. La limpieza borra `blocks` y `reports` además de `bottles`.

## Lista de tests

| # | Test |
|---|---|
| 1 | Bloquear oculta sus botellas en mi mar y las mías en el suyo; un tercero sigue viendo ambas |
| 2 | El chat responde `403` en ambos sentidos (GET y POST) y el historial sigue en BD |
| 3 | No puedo recoger ni descartar su botella tras bloquear |
| 4 | Desbloquear (sin bloqueo de vuelta) restaura mar y chat |
| 5 | Si ambos se bloquearon, mi desbloqueo no basta: sigue `403` |
| 6 | Bloquear libera una reserva sin confirmar entre los dos y la botella vuelve al mar |
| 7 | Bloquear con conversación confirmada: no se puede escribir, y no se confirma nada nuevo |
| 8 | No puedo bloquearme ni reportarme a mí mismo → `422`; `publicId` inexistente → `404` |
| 9 | Bloquear dos veces es idempotente: una sola fila |
| 10 | `GET /api/blocks` devuelve `publicId` y alias, nunca el UUID del visitante; el `publicId` es UUID y sobrevive a un cambio de alias |
| 11 | Reporte válido se guarda con motivo, texto y botella (comprobado en BD, filtrado por reportero) |
| 12 | Motivo inventado, texto de 501, bidi o `bottleId` inexistente → `422` |
| 13 | El reporte no bloquea: el chat sigue funcionando y no hay fila en `blocks` |
| 14 | Más de 10 reportes al día → `429` |
| 15 | Bloquear y reportar funcionan con identidad de cuenta (Bearer) |
| 16 | Los 111 tests actuales siguen verdes con la nueva limpieza |

---

# Plan — Historia 7 (aprobada v2: fotos y bio)

## Story
As a person, I want to add photos and a few words about me, so that others can decide whether to answer.

## Acceptance criteria
- [ ] Given tengo perfil, when subo hasta 6 fotos JPEG/PNG/WebP de 5 MB, then se guardan y aparecen en mi perfil.
- [ ] Given un perfil con fotos y bio, when alguien recoge mi botella, then las ve junto a mi alias; en el mar nada de eso aparece.
- [ ] Given una foto o mi bio, when la borro o la cambio, then mi perfil refleja el cambio.

## Modelo
- `photos(id uuid PK default gen_random_uuid(), visitor_id varchar(64) → profiles(visitor_id) on delete cascade, filename unique, mime, created_at)` + índice por `visitor_id`.
- `profiles.bio varchar(300)` nullable con `CHECK (bio is null or length(bio) between 0 and 300)`.
- Archivos en `UPLOADS_DIR` (por defecto `./data/uploads`, ignorado por git), nombre `<uuid>.<ext>`; nunca el nombre del cliente.
- `GET /api/profile` → `{ alias, publicId, bio, photos: [{ id, url }] }` ordenadas por `created_at`.
- `pick` añade `authorBio` y `authorPhotos` (mismo formato). El mar, `mine`, `discard` y `release` no cambian.

## Rutas
- `POST /api/profile/photos` (multipart, campo `photo`) → `201 { id, url }`
- `DELETE /api/profile/photos/:id` → `204`; `404` si no es mía
- `GET /api/photos/:id` → bytes con el `Content-Type` **derivado de los bytes**, `X-Content-Type-Options: nosniff` y `Cache-Control: private, no-store`
- `PUT /api/profile` `{ alias, bio? }`: sin `bio` se conserva; `""` la borra

## Límites y validación
- `bodyLimit` global de 8 KB **se salta** en `/api/profile/photos`; esa ruta tiene su propio límite de 5 MB. El middleware de identidad también se salta `/api/photos/*` (las etiquetas `<img>` no mandan `Bearer`).
- Tipo por **firma completa**: PNG `89 50 4E 47 0D 0A 1A 0A`, JPEG `FF D8 FF` + mínimo razonable, WebP `RIFF`, tamaño ≥ 12 y `uint32LE(4) = length-8`. SVG, HTML o cualquier otra cosa → `422`.
- Máximo 6 fotos por perfil → `409`, con `pg_advisory_xact_lock` sobre el visitante y conteo + insert en la misma transacción.
- Subir exige perfil (`403`). Máximo 10 subidas al día por visitante → `429`.
- Escritura atómica: archivo temporal → commit de la fila → renombrar; si falla el commit, se borra el temporal. Al borrar: primero la fila, luego `unlink` tolerando `ENOENT`.
- `GET /api/photos/:id` es público por UUID no adivinable (lo necesita `<img>`), incluso tras un bloqueo: **se documenta** como limitación de esta historia.

## Out of scope
- Reordenar, foto principal, miniaturas, recorte.
- Moderación de imágenes.
- Cuotas de almacenamiento por cuenta (solo el límite de subidas).
- Autorización de fotos por bloqueo o por participante.

## Nota de test
Los tests usan `UPLOADS_DIR` apuntando a un directorio temporal y limpian `photos` y los archivos. Las fotos se construyen con `FormData` + `File`.

## Lista de tests

| # | Test |
|---|---|
| 1 | Subir un PNG real devuelve `201`; `GET /api/photos/:id` devuelve los mismos bytes, `image/png`, `nosniff`, y el archivo existe en `UPLOADS_DIR` con nombre distinto al subido |
| 2 | Bytes de texto con `Content-Type: image/png` → `422`; PNG real con `Content-Type: text/plain` → `201` servido como `image/png` |
| 3 | Firmas incompletas (PNG truncado, JPEG solo `FF D8`, RIFF con tamaño malo) → `422` |
| 4 | Archivo de 5 MB se acepta y de 5 MB + 1 → `413` |
| 5 | Dos subidas simultáneas en el límite de 6: quedan 6 filas, una recibe `409` y no deja archivo |
| 6 | Borrar mi foto quita fila, archivo y `GET` → `404`; segundo delete → `404` |
| 7 | No puedo borrar la foto de otra persona → `404` |
| 8 | Bio: se guarda, se conserva si no se envía, `""` la borra, 301 o invisibles → `422` |
| 9 | `GET /api/profile` devuelve exactamente `alias, publicId, bio, photos` y las fotos ordenadas |
| 10 | Al recoger se ven `authorBio` y `authorPhotos`; el mar, `mine`, `discard` y `messages` no las exponen |
| 11 | Subir sin perfil → `403`; con Bearer y alias → `201` |
| 12 | `GET /api/photos/:id` con cookie de cuenta (regresión de `<img>`) → `200` |
| 13 | Más de 10 subidas al día → `429` |
| 14 | `GET /api/photos/<uuid inválido>` y un `filename` con `../` → `404`, nunca `500` |

---

# Plan — Historia 10 (aprobada v2: bandeja in-app)

## Story
As a person, I want to be notified when someone picks my bottle or replies, so that I don't have to keep checking.

## Acceptance criteria
- [ ] Given lancé una botella, when alguien la recoge, then tengo una notificación en mi bandeja.
- [ ] Given hay una conversación, when la otra persona escribe, then me llega una notificación y al que escribe no.
- [ ] Given mi reserva expiró sin mensajes, when abro la bandeja, then veo el aviso una sola vez (aunque otro la haya recogido antes).

## Modelo
- `notifications(id serial, visitor_id varchar(64), type varchar(20), bottle_id → bottles on delete set null, read_at nullable, created_at)` con `CHECK type in ('botella_recogida','mensaje_nuevo','reserva_caducada')` e índice `(visitor_id, id)`.
- Retención: tras insertar, `delete … where visitor_id = $1 and id < (select id from notifications where visitor_id = $1 order by id desc offset 49 limit 1)`. Solo se recorta al insertar, nunca al leer.
- Si se recortan no leídas, desaparecen; el contador `unread` se calcula sobre las que quedan.
- Nunca se guarda ni se expone quién provocó el evento.

## Eventos (dentro de la misma transacción que los provoca)
- **Recogida**: al crear la reserva en `POST /pick`, se notifica al autor. Se emite dentro de la transacción de la reserva; si la reserva falla (`409`), no hay notificación.
- **Mensaje**: al insertar el mensaje, se notifica al otro participante. Nunca a quien escribe, ni si el chat está bloqueado (`403` antes de insertar).
- **Reserva caducada**: se emite con `DELETE … RETURNING` en **todos** los sitios que limpian reservas expiradas: el barrido de `pick`, liberar al bloquear y destruir. Así no se pierde el aviso aunque otro recoja la botella antes de que el dueño abra la bandeja.
- El barrido perezoso dentro de `GET /api/notifications` queda como red de seguridad, en **una** transacción con `DELETE … RETURNING` filtrado por visitante (idempotente entre dos GET simultáneos).

## Rutas
- `GET /api/notifications` → `{ data: [{ id, type, bottleId, read, createdAt }], unread }`, más recientes primero, máximo 50. Sin identidad → `401` y **sin** repartir cookie.
- `POST /api/notifications/:id/read` → `204`; `404` si no es mía (un solo `UPDATE … WHERE id AND visitor_id RETURNING`).
- `POST /api/notifications/read-all` → `204` (idempotente).

## Out of scope
- Email, push, WebSocket.
- Preferencias por tipo, agrupar mensajes consecutivos, silenciar.
- Notificar bloqueos, reportes o cambios de perfil.
- Paginación más allá de las 50.

## Lista de tests

| # | Test |
|---|---|
| 1 | Recoger notifica al autor y no al que recoge; un `pick` rechazado (`409`) no notifica |
| 2 | Un mensaje notifica al otro participante en ambos sentidos, no a quien escribe |
| 3 | Expirar y que **otro** recoja antes de abrir la bandeja: el dueño ve su `reserva_caducada` exactamente una vez |
| 4 | Dos `GET` simultáneos tras una expiración generan una sola notificación y ambos responden `200` |
| 5 | `GET` devuelve `{ data, unread }` con claves exactas, orden descendente y `read` booleano |
| 6 | Marcar una como leída baja `unread`; segunda vez `204`; ajena `404` y no toca la del dueño |
| 7 | `read-all` idempotente y `unread` a cero |
| 8 | Retención: 49/50/51 notificaciones, y dos visitantes no se pisan |
| 9 | Sin identidad la bandeja da `401` y no emite `Set-Cookie`; cookie de cuenta → `401` |
| 10 | Ids inválidos (`abc`, `0`, `1.5`, >int4) → `404`, nunca `500` |
| 11 | Destruir una botella deja sus notificaciones con `bottleId: null` y el `GET` no falla |
| 12 | Los mensajes bloqueados y los picks bloqueados no crean notificaciones |

---

# Plan — Historia 11 (aprobada v2: afinidad)

## Story
As a person, I want to answer a short affinity questionnaire shown on my profile, so that bottles reach people more like me.

## Cuestionario (fijo en código, única fuente de verdad)
6 preguntas con 3–4 opciones: `plan_ideal`, `finde`, `conversacion`, `ritmo`, `comida`, `viaje`. Cada respuesta guardada se valida contra esa lista y **se filtran** preguntas u opciones que ya no existan al leer y al puntuar.

## Modelo
- `affinity_answers(visitor_id varchar(64) → profiles on delete cascade, question varchar(20) not null, option varchar(20) not null, PK(visitor_id, question))`.
- Afinidad **entera 0–100**: `round(coincidencias / comunes * 100)`.
- Si hay **menos de 2 preguntas en común** → `null` (afinidad neutra, 50 al ordenar). Evita que un 1/1 dé 100%.
- Responder es opcional y parcial; `PUT` **reemplaza**: hace upsert de lo enviado y borra las preguntas omitidas en la misma transacción. `answers: {}` vacía todo.

## Rutas
- `GET /api/affinity/questions` → `{ data: [{ id, text, options: [{ id, text }] }] }`, público, sin cookie.
- `PUT /api/affinity` → `{ answers: { plan_ideal: "cena", … } }` → `{ data: { answers } }`. Exige identidad con perfil (`403` sin alias, sin repartir cookie). Soporta Bearer y cookie anónima.
- `GET /api/profile` añade `affinity: { answers }`.
- `pick` añade `authorAffinity: { percentage: number | null, answers: Record<string,string> }`; sin perfil del autor → `percentage: null`, `answers: {}`.

## Mar
- Orden con subconsulta escalar **sin GROUP BY** (compatible con `FOR UPDATE SKIP LOCKED`):
  `coalesce((select … coincidencias …) * 100 / nullif((select … comunes …), 0), 50) DESC, random()`.
- Si el autor o yo no tenemos respuestas (o comunes < 2) → 50, empatando con el azar.
- Sin afinidad no cambia el resto de exclusiones (vistas, reservadas, destruidas, propias, bloqueadas).

## Out of scope
- Preguntas editables o administración.
- Filtro duro, historial o explicación de la afinidad.
- Muestreo top-K para evitar que botellas de afinidad baja queden relegadas (se anota como deuda).
- Ponderar por intereses de la historia 13.

## Nota de test
La suite limpia `affinity_answers` donde cuenta filas. El test de claves exactas de `/api/profile` se actualiza con `affinity`.

## Lista de tests

| # | Test |
|---|---|
| 1 | `GET /api/affinity/questions` devuelve las 6 preguntas y opciones esperadas, sin cookie |
| 2 | `PUT` guarda respuestas; `GET /api/profile` las muestra |
| 3 | Pregunta u opción desconocidas, valor no textual, 21 caracteres o control → `422` |
| 4 | Sin perfil → `403` sin `Set-Cookie`; con Bearer + alias → `200`; cookie de cuenta → `401` |
| 5 | `PUT` reemplaza: omitir una pregunta la borra, `{}` vacía y no quedan filas duplicadas |
| 6 | Afinidad 100% (respuestas idénticas), 0% (todas distintas) y `null` si hay menos de 2 en común |
| 7 | Cálculo simétrico: A recogiendo de B da el mismo porcentaje que B recogiendo de A |
| 8 | `pick` devuelve `authorAffinity` con claves exactas; sin respuestas del autor, `null` y `{}` |
| 9 | El mar prioriza la botella de mayor afinidad cuando las puntuaciones son distintas |
| 10 | El mar sigue funcionando sin respuestas (neutro) y no expone afinidad en la respuesta |
| 11 | Un bloqueado no aparece en el mar ni puede recoger (sin filtrar respuestas) |
| 12 | Una respuesta con pregunta obsoleta insertada en BD se ignora al leer y al puntuar |
| 13 | Claves exactas en perfil y `pick`; `sea`, `mine`, `discard` y `messages` no exponen afinidad |

---

# Plan — Historia 12 (aprobada v2: swipe y matches)

## Story
As a person, I want to see one profile at a time and like or discard it, so that I can also meet people without waiting for a bottle.

## Refactor: conversaciones
- `conversations(id serial, bottle_id nullable UNIQUE → bottles on delete cascade, visitor_a → profiles, visitor_b → profiles, created_at)` con `CHECK visitor_a <> visitor_b`.
- `messages.conversation_id NOT NULL → conversations on delete cascade` e índice `(conversation_id, id)`. Sin datos de producción: se recrea la tabla y se documenta el reset de `data/pgdata` y `data/test-pgdata`.
- El chat de botella mantiene sus rutas `/api/bottles/:id/messages`; resuelve su conversación y **solo la crea al confirmar la reserva**, dentro de la misma transacción. Antes del primer mensaje, quien recoge lee `[]` y no se crea nada.
- Carrera de confirmación: `insert … on conflict (bottle_id) do nothing` + relectura, luego insertar el mensaje; todo en una transacción.
- `GET/POST /api/conversations/:id/messages` sirve **solo conversaciones de match** (`bottle_id is null`), con `idValido` y participantes; un tercero `403`.

## Swipe
- `swipes(visitor_id, target_visitor, action ('like'|'discard'), created_at, PK(visitor,target))` con `CHECK visitor_id <> target_visitor` y `CHECK action in ('like','discard')`.
- `GET /api/deck` → `{ data: { publicId, alias, bio, photos, affinity: { percentage } } | null }`. Excluye yo, ya deslizados y bloqueos en ambos sentidos; orden por afinidad y azar. Exige perfil: `403` sin alias y **sin repartir cookie**.
- `POST /api/swipes` `{ publicId, action }` → `201 { data: { match, conversationId? } }`.
  - `discard`: no vuelve nunca.
  - `like`: si existe el like recíproco, se crea el match.
  - Repetir un like ya casado devuelve `200 { match: true, conversationId }` (idempotente); repetir un discard o un like sin match → `409`.
- `GET /api/matches` → `{ data: [{ conversationId, publicId, alias, createdAt }] }`, solo matches (`bottle_id is null`), sin bloqueados, máximo 50.

## Match (una transacción)
1. `pg_advisory_xact_lock` sobre el par ordenado (mismo lock que usa bloquear).
2. Insertar el swipe; si `23505`, se trata como repetido.
3. Releer el like recíproco; si existe y no hay conversación, crearla con un índice único canónico `(least(a,b), greatest(a,b)) where bottle_id is null`.
4. Notificar `match_nuevo` a ambos **después** de crear la conversación, dentro de la misma transacción.

## Bloqueos y privacidad
- Bloquear borra los likes pendientes entre la pareja y oculta los matches existentes; el chat responde `403`.
- El mazo muestra alias, bio, fotos y porcentaje de afinidad de un desconocido: **excepción deliberada** al modelo «alias solo al recoger», documentada en `AGENTS.md`. Nunca muestra `publicId` del visitante ni sus respuestas de afinidad.

## Notificaciones
- `notifications.conversation_id nullable → conversations on delete set null` y tipo `match_nuevo` en el CHECK; la respuesta de la bandeja añade `conversationId`.

## Errores
`400` cuerpo · `422` auto-swipe, acción o `publicId` malformado · `404` público inexistente · `403` sin perfil, bloqueado o conversación ajena · `409` swipe repetido sin match.

## Out of scope
- Deshacer swipe o match, listas de quién te dio like, «me gusta» pagados.
- Mensajes con foto/audio.
- Estabilidad del mazo entre peticiones (los empates se rebarajan).

## Nota de test
Helpers nuevos: `limpiarSwipes` y `limpiarConversaciones` (incluyen mensajes de match). Los tests que cuentan mensajes se filtran por conversación.

## Lista de tests

| # | Test |
|---|---|
| 1 | `GET /api/deck` devuelve claves exactas, sin UUID de visitante ni respuestas de afinidad |
| 2 | Mazo vacío → `{ data: null }`; sin perfil → `403` sin `Set-Cookie` |
| 3 | Excluye mi perfil, ya deslizados y bloqueados en ambos sentidos |
| 4 | Prioriza mayor afinidad entre dos candidatos |
| 5 | Descartar lo quita para siempre; repetir dislike → `409` |
| 6 | Like sin reciprocidad no crea match ni conversación |
| 7 | Like mutuo: una sola conversación, dos notificaciones, aparece en `/api/matches` de ambos |
| 8 | Likes mutuos simultáneos: exactamente una conversación y dos avisos |
| 9 | Repetir like tras match devuelve `200` con el mismo `conversationId` y no duplica avisos |
| 10 | Chat de match en ambos sentidos con alias y `publicId`; tercero `403`; id inválido `404` |
| 11 | Bloqueo posterior corta el chat, oculta el match y borra likes pendientes |
| 12 | Validación de mensajes (vacío, 501, bidi) aplica al chat de match |
| 13 | La notificación `match_nuevo` lleva `conversationId` y no identidades internas |
| 14 | Regresión: chat de botella, `[]` antes del primer mensaje, confirmación única y reserva caducada/liberada con nueva conversación correcta |
| 15 | Acceso por `/api/conversations/:id` a una conversación de botella → `404`; a una ajena → `403` |
| 16 | Tras un match, `delete from bottles` y la suite siguen funcionando (FKs correctas) |
| 17 | Retención de 50 y bandeja siguen funcionando con `match_nuevo` mezclado |
| 18 | Los 170 tests actuales siguen verdes |

---

# Plan — Historia 13 (aprobada v2: grupos por intereses)

## Story
As a person, I want to talk in groups by interests, so that conversations don't depend on a single bottle.

## Modelo
- Grupos **fijos y estables en código**: `musica`, `cine`, `viajes`, `libros`, `deporte`, `cocina`. Cualquier id fuera de la lista → `404` **antes** de tocar la BD.
- `group_members(group_id varchar(20), visitor_id varchar(64) → profiles on delete cascade, joined_at default now(), PK(group_id, visitor_id))` + índice por `visitor_id`.
- `group_messages(id serial, group_id varchar(20), sender_visitor varchar(64), sender_alias varchar(20), text varchar(500), created_at)` con índice `(group_id, id)` y `CHECK length(text) between 1 and 500`.
- Si un grupo desaparece del código sus filas quedan huérfanas e ignoradas (`404` en todas las rutas). Se documenta el SQL de limpieza; los ids no se reutilizan.

## Rutas
- `GET /api/groups` → `{ data: [{ id, title, description, members, joined }] }` en el orden fijo del código. Sin identidad `200` y sin repartir cookie; **con cookie de cuenta → `401`** (regla global). `members` se calcula con un único agregado.
- `POST /api/groups/:id/join` → `204` idempotente; exige perfil (`403`). Dos uniones simultáneas dejan una fila.
- `DELETE /api/groups/:id/leave` → `204` siempre que el grupo exista (idempotente). Salir **no borra** el historial: al volver a unirse se siguen viendo los mensajes anteriores.
- `GET /api/groups/:id/messages?before=<id>` → `{ data }`, últimos 50 ascendentes, **solo miembros** (`403`). `before` inválido → `422`.
- `POST /api/groups/:id/messages` → `201 { data: { id, text, alias, publicId, mine, createdAt } }`; solo miembros, 1–500 puntos de código sin invisibles.

## Reglas
- Precedencia: `400` cuerpo → `422` texto o `before` inválido → `404` grupo → `401` sin identidad → `403` sin perfil o sin membresía.
- Comprobar membresía e insertar el mensaje va en **una transacción** con la fila de membresía bloqueada (`FOR UPDATE`), para que un `leave` concurrente no permita escribir.
- Bloqueos: filtrado **en SQL** con `NOT EXISTS` antes del `LIMIT`, en ambos sentidos. Las filas siguen en BD; un tercero las ve. Puede haber huecos de paginación (documentado).
- `publicId` sale de un join con `profiles`; si faltara el perfil, `null`.
- Sin notificaciones por unirse, salir ni escribir. Sin límite de retención ni rate limit en esta historia (deuda declarada).

## Out of scope
- Crear, editar o borrar grupos; roles, expulsiones, grupos privados.
- Notificaciones o contadores de no leídos por grupo.
- Purga o retención de mensajes de grupo.

## Nota de test
Helper `limpiarGrupos()`: borra `group_messages` y `group_members`. Se prueba el doble sentido del bloqueo con más de 50 mensajes intercalados.

## Lista de tests

| # | Test |
|---|---|
| 1 | `GET /api/groups`: 6 grupos en orden fijo, claves exactas, `members` entero y `joined` booleano |
| 2 | Sin cookie: `200` sin `Set-Cookie`; con cookie de cuenta: `401` |
| 3 | Unirse sin perfil → `403`; repetir y dos uniones simultáneas → una sola fila y `204` |
| 4 | Salir es idempotente (`204` siempre) y no borra el historial al reincorporarse |
| 5 | Sin membresía leer y escribir → `403`; sin identidad → `401` |
| 6 | Un miembro escribe y otro lee con alias, `publicId`, `mine` y claves exactas |
| 7 | Validación: vacío, 1 y 500 aceptados, 501, bidi e invisibles → `422`; cuerpo nulo → `400` |
| 8 | Paginación: 55 mensajes, 50 y `?before` con los 5 restantes; `before` inválido → `422` |
| 9 | Bloqueo en ambos sentidos con mensajes intercalados: no se ven, el tercero sí los ve y no hay `500` |
| 10 | Grupo inexistente → `404` en las cuatro rutas, sin `500` y sin tocar filas huérfanas |
| 11 | Alias congelado: renombrarse no cambia mensajes antiguos; alias repetidos con `mine` correcto |
| 12 | Ni unirse, ni salir, ni escribir crean notificaciones ni recortan las existentes |
| 13 | Membresía con Bearer sobrevive a un login en otro dispositivo |
| 14 | Los 184 tests actuales siguen verdes |

---

# Plan — Historia 14 (aprobada: planes presenciales)

## Story
As a person, I want to see nearby plans and sign up, so that I can meet people in person.

## Modelo
- `plans(id, creator_visitor, title varchar(80), description varchar(500), place_name varchar(100), lat double precision, lng double precision, starts_at, capacity int, created_at)` con `CHECK` de rangos (lat -90..90, lng -180..180, capacity 1..50, título 3–80, descripción ≤500).
- `plan_attendees(plan_id → plans cascade, visitor_id, status ('confirmado'|'espera'), created_at, PK(plan,visitor))` con índice por plan y estado.
- Sin geolocalización propia del usuario: el cliente manda `lat`/`lng` al listar. Si no los manda, se ordena por fecha.

## Rutas
- `POST /api/plans` `{ title, description?, place, lat, lng, startsAt, capacity }` → `201 { data: { id } }`; exige perfil.
- `GET /api/plans?lat=&lng=&radius=<km>` → planes futuros, máximo 50: `{ id, title, place, startsAt, distanceKm, confirmed, capacity, spotsLeft, myStatus }`. `radius` por defecto 25 km, máximo 200.
- `GET /api/plans/:id` → detalle con los mismos campos + `creator: { alias, publicId }`.
- `POST /api/plans/:id/join` → `200 { data: { status } }` (`confirmado` o `espera`), idempotente.
- `DELETE /api/plans/:id/leave` → `204`; si quien se va estaba confirmado, **asciende al primero de la espera**.

## Reglas
- Distancia Haversine en SQL (`6371 * acos(...)`), orden por distancia y luego por fecha.
- Apuntarse y salir van en una transacción con `pg_advisory_xact_lock` sobre el plan: el aforo no se rebasa y la promoción de la espera es única.
- Planes pasados (`starts_at <= now()`) no se listan ni admiten altas (`409`).
- Bloqueos: un plan de alguien bloqueado no aparece y no se puede uno apuntar (`403`).
- Sin notificaciones al apuntarse.
- Errores: `400` cuerpo · `422` validación · `404` plan · `401` sin identidad · `403` sin perfil o bloqueado · `409` plan pasado.

## Out of scope
- Editar o cancelar planes, borrar asistentes, invitaciones.
- Geolocalización del dispositivo o mapa.
- Notificaciones de plazas o recordatorios.
- Planes pasados en el historial.

## Lista de tests

| # | Test |
|---|---|
| 1 | Crear un plan válido y verlo en el listado |
| 2 | Validación: título corto, fecha pasada, lat/lng fuera de rango, aforo 0 → `422`; sin perfil → `403` |
| 3 | El listado ordena por distancia y excluye planes pasados |
| 4 | `distanceKm` coherente (dos planes a distancias conocidas, orden correcto) |
| 5 | Sin `lat`/`lng` se lista por fecha |
| 6 | Apuntarse confirma mientras hay plazas; `spotsLeft` baja y `myStatus` se ve |
| 7 | Con el aforo lleno, el siguiente queda en `espera` |
| 8 | Salir estando confirmado asciende al primero de la espera |
| 9 | Salir estando en espera no promueve a nadie |
| 10 | Apuntarse dos veces es idempotente y no consume dos plazas |
| 11 | Un plan de alguien bloqueado no aparece y apuntarse da `403` |
| 12 | Plan inexistente o id inválido → `404`; plan pasado al apuntarse → `409` |
| 13 | El detalle expone alias y `publicId` del creador, nunca su UUID |
| 14 | Apuntarse no crea notificaciones |
| 15 | Claves exactas en listado, detalle y respuestas de unirse/salir |

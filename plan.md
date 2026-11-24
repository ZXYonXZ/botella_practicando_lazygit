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

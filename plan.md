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

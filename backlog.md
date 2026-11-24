# Backlog — Botella

## Context

App de citas para público general donde el primer contacto nace de una botella lanzada al mar: un mensaje que solo una persona puede recoger y que no caduca nunca. Cada persona puede lanzar 5 botellas nuevas al día. Gratis por ahora.
Expensive decisions: ninguna.

## Backlog

1. As the product owner, I want the stack decided, so that every later story is built on a known base.
2a. As a person, I want to write a text bottle and throw it into the sea, so that someone I don't know can find it.
2b. As a person, I want the sea to show me one free bottle I haven't seen before, so that I only get bottles that are new to me.
2c. As a person, I want a bottle I pick to stay reserved to me for 48 hours, so that nobody else takes it while I decide. Requires: 2a, 2b
2d. As a person, I want to decide what happens to a bottle I don't want, so that I can destroy it or put it back in the sea. Requires: 2b
3. As a person, I want to throw at most 5 new bottles a day, so that the sea doesn't flood with throwaway messages.
4. As a person, I want a minimal profile when I throw or pick a bottle, so that the other person knows who they're talking to.
5. As a person, I want to chat with the person whose bottle I picked up, so that the first contact can continue.
6. As a person, I want to see the bottles I threw and whether they were picked up, so that I know if I got an answer.
7. As a person, I want to add photos and a few words about me, so that others can decide whether to answer. Requires: #4
8. As a person, I want to sign in again on another device and keep my chats, so that I don't lose my history.
9. As a person, I want to block and report someone, so that I can cut off unwanted contact.
10. As a person, I want to be notified when someone picks my bottle or replies, so that I don't have to keep checking.
11. As a person, I want to answer a short affinity questionnaire shown on my profile, so that bottles reach people more like me.
12. As a person, I want to see one profile at a time and like or discard it, so that I can also meet people without waiting for a bottle.
13. As a person, I want to talk in groups by interests, so that conversations don't depend on a single bottle.
14. As a person, I want to see nearby plans and sign up, so that I can meet people in person.

## Notas

- Las botellas no caducan nunca: siguen en el mar hasta que alguien las recoge.
- Tus propias botellas no te aparecen en el mar.
- Texto de la botella: entre 5 y 240 caracteres.
- Una botella recogida queda reservada 48 horas; si no hay respuesta, vuelve al mar.
- Descartar tiene dos resultados: destruir (sale del mar para todos, para siempre) o devolver (sigue disponible para otros, pero no para quien la descartó).
- El tope es de 5 botellas **nuevas** al día, aunque las anteriores sigan en el mar, así que el número de botellas propias a la deriva puede crecer sin límite (la lista de «mis botellas» debe soportarlo).
- Stack decidido: Deno 2.9 + Hono 4 + Drizzle ORM + PGlite.

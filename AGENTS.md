# Botella

## Producto

App de citas para público general. El primer contacto nace de una botella lanzada al mar: un mensaje que solo una persona puede recoger y que no caduca nunca. Cada persona puede lanzar 5 botellas nuevas al día. Gratis por ahora.

Decisiones caras de revertir: ninguna identificada.

## Stack

Decidido: Deno 2.9 + Hono 4 + Drizzle ORM + PGlite (Postgres en WASM, local). `drizzle-kit` se ejecuta con Deno. `db/schema.ts` está vacío hasta que la historia 2a añada su tabla.

## Método

Flujo XP con los skills instalados: `/backlog` → `/story` → `/pair`.

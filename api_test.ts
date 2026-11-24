import { assertEquals } from "@std/assert";

// La BD de test vive en data/test-pgdata, separada de la de desarrollo.
Deno.env.set("PGDATA_DIR", "./data/test-pgdata");

const { app } = await import("./main.ts");
const { db } = await import("./db/client.ts");

const lanzar = (body: unknown) =>
  app.request("/api/bottles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

Deno.test("Lanzar una botella con texto válido devuelve 201 con la botella creada", async () => {
  await db.execute("delete from bottles");

  const res = await lanzar({ text: "Hola desde el mar" });

  assertEquals(res.status, 201);
  const { data } = await res.json();
  assertEquals(data.text, "Hola desde el mar");
});

Deno.test("Rechaza texto vacío", async () => {
  await db.execute("delete from bottles");

  const res = await lanzar({ text: "" });

  assertEquals(res.status, 422);
  const body = await res.json();
  assertEquals(typeof body.error, "string");
});

Deno.test("Rechaza texto de solo espacios", async () => {
  await db.execute("delete from bottles");

  const res = await lanzar({ text: "   " });

  assertEquals(res.status, 422);
});

Deno.test("Rechaza texto de 241 caracteres", async () => {
  await db.execute("delete from bottles");

  const res = await lanzar({ text: "a".repeat(241) });

  assertEquals(res.status, 422);
});

Deno.test("Acepta texto de 240 caracteres (borde)", async () => {
  await db.execute("delete from bottles");
  const texto = "a".repeat(240);

  const res = await lanzar({ text: texto });

  assertEquals(res.status, 201);
  const { data } = await res.json();
  assertEquals(data.text, texto);
});

Deno.test("Rechaza texto de 4 caracteres", async () => {
  await db.execute("delete from bottles");

  const res = await lanzar({ text: "abcd" });

  assertEquals(res.status, 422);
});

Deno.test("Acepta texto de 5 caracteres (borde)", async () => {
  await db.execute("delete from bottles");

  const res = await lanzar({ text: "abcde" });

  assertEquals(res.status, 201);
});

Deno.test("Lanzar una segunda botella no altera la primera", async () => {
  await db.execute("delete from bottles");

  const primera = await lanzar({ text: "La primera botella" });
  const { data: creada } = await primera.json();

  const segunda = await lanzar({ text: "La segunda botella" });
  assertEquals(segunda.status, 201);

  const filas = await db.execute("select id, text from bottles order by id");
  assertEquals(filas.rows.length, 2);
  assertEquals(filas.rows[0], { id: creada.id, text: "La primera botella" });
});

Deno.test("La botella devuelta no revela quién la escribió", async () => {
  await db.execute("delete from bottles");

  const res = await lanzar({ text: "Un mensaje anónimo" });

  const { data } = await res.json();
  assertEquals("author" in data, false);
  assertEquals("authorId" in data, false);
  assertEquals("userId" in data, false);
});

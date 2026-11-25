import { assertEquals, assertMatch } from "@std/assert";
import { sql } from "drizzle-orm";

// La BD de test vive en data/test-pgdata, separada de la de desarrollo.
Deno.env.set("PGDATA_DIR", "./data/test-pgdata");
Deno.env.set("UPLOADS_DIR", "./data/test-uploads");

const { app, resetRateLimit, resetReportLimit, resetUploadLimit } = await import("./main.ts");
const { db } = await import("./db/client.ts");

// Lanzar crea una visita con perfil si no se pasa cookie: el producto exige alias para lanzar.
const lanzar = async (body: unknown, cookie?: string) => {
  const propia = cookie ?? await crearVisita();
  const res = await app.request("/api/bottles", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: propia },
    body: JSON.stringify(body),
  });
  res.headers.set("set-cookie", propia);
  return res;
};

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

// ------------------------------------------------------------------------ 2b
const pedirDelMar = (cookie?: string) =>
  app.request("/api/sea", { headers: cookie ? { cookie } : {} });

const descartar = (id: number, action: string, cookie?: string) =>
  app.request(`/api/bottles/${id}/discard`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ action }),
  });

Deno.test("La botella destruida tampoco me vuelve a tocar a mí", async () => {
  await db.execute("delete from bottles");
  await lanzar({ text: "La única botella" });

  const cookie = await crearVisita("Lectora");
  const { data: vista } = await (await pedirDelMar(cookie)).json();

  await descartar(vista.id, "destroy", cookie);

  const otra = await pedirDelMar(cookie);
  const { data } = await otra.json();
  assertEquals(data, null);
});

Deno.test("Descartar devolviéndola la deja disponible para otra visita", async () => {
  await db.execute("delete from bottles");
  await lanzar({ text: "Botella devuelta al mar" });

  const cookie = await crearVisita("Lectora");
  const { data: vista } = await (await pedirDelMar(cookie)).json();

  const res = await descartar(vista.id, "return", cookie);
  assertEquals(res.status, 200);

  const otro = await pedirDelMar();
  const { data: suya } = await otro.json();
  assertEquals(suya.text, "Botella devuelta al mar");

  const miaOtraVez = await pedirDelMar(cookie);
  const { data: noOtraVez } = await miaOtraVez.json();
  assertEquals(noOtraVez, null);
});

Deno.test("Descartar con una acción desconocida responde 422", async () => {
  await db.execute("delete from bottles");
  await lanzar({ text: "Una botella cualquiera" });

  const mia = await pedirDelMar();
  const { data: vista } = await mia.json();

  const res = await descartar(vista.id, "explode");

  assertEquals(res.status, 422);
});

Deno.test("Descartar un id inexistente responde 404", async () => {
  const res = await descartar(999999, "destroy");

  assertEquals(res.status, 404);
});

Deno.test("Descartar destruyendo la saca del mar para todos", async () => {
  await db.execute("delete from bottles");
  await lanzar({ text: "Botella a destruir" });

  const cookie = await crearVisita("Lectora");
  const { data: vista } = await (await pedirDelMar(cookie)).json();

  const res = await descartar(vista.id, "destroy", cookie);
  assertEquals(res.status, 200);

  const otra = await pedirDelMar();
  const { data: suya } = await otra.json();
  assertEquals(suya, null);
});

Deno.test("Una botella que ya vi no me vuelve a tocar", async () => {
  await db.execute("delete from bottles");
  await lanzar({ text: "Botella uno" });
  await lanzar({ text: "Botella dos" });

  const cookie = await crearVisita("Lectora");
  const { data: vista } = await (await pedirDelMar(cookie)).json();

  const segunda = await pedirDelMar(cookie);
  const { data: otra } = await segunda.json();

  const esperada = vista.text === "Botella uno" ? "Botella dos" : "Botella uno";
  assertEquals(otra.text, esperada);
});

Deno.test("La primera visita recibe una cookie anónima del servidor", async () => {
  await db.execute("delete from bottles");
  await lanzar({ text: "Una botella en el mar" });

  const res = await pedirDelMar();

  const cookie = res.headers.get("set-cookie") ?? "";
  assertMatch(cookie, /^visitor=[0-9a-f-]{36}/);
});

Deno.test("Otra visita sí puede ver la botella que yo vi", async () => {
  await db.execute("delete from bottles");
  await lanzar({ text: "Botella única" });

  const mia = await pedirDelMar();
  const { data: vista } = await mia.json();
  assertEquals(vista.text, "Botella única");

  const ajena = await pedirDelMar();
  const { data: suya } = await ajena.json();
  assertEquals(suya.text, "Botella única");
});

Deno.test("Sin botellas en el mar responde 200 con data null", async () => {
  await db.execute("delete from bottles");

  const res = await pedirDelMar();

  assertEquals(res.status, 200);
  const { data } = await res.json();
  assertEquals(data, null);
});

Deno.test("Cuando ya vi todas las botellas responde 200 con data null", async () => {
  await db.execute("delete from bottles");
  await lanzar({ text: "La única botella" });

  const cookie = await crearVisita("Lectora");

  const primera = await pedirDelMar(cookie);
  assertEquals((await primera.json()).data.text, "La única botella");

  const segunda = await pedirDelMar(cookie);

  assertEquals(segunda.status, 200);
  const { data } = await segunda.json();
  assertEquals(data, null);
});

Deno.test("GET /api/sea devuelve una botella libre y no revela el autor", async () => {
  await db.execute("delete from bottles");
  await lanzar({ text: "Una botella en el mar" });

  const res = await pedirDelMar();

  assertEquals(res.status, 200);
  const { data } = await res.json();
  assertEquals(data.text, "Una botella en el mar");
  assertEquals("author" in data, false);
  assertEquals("authorId" in data, false);
});

// ------------------------------------------------- arreglos de la revisión
Deno.test("POST /api/bottles con JSON inválido responde 400", async () => {
  const res = await app.request("/api/bottles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{no es json",
  });

  assertEquals(res.status, 400);
});

Deno.test("POST /api/bottles con cuerpo null responde 400", async () => {
  const res = await app.request("/api/bottles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "null",
  });

  assertEquals(res.status, 400);
});

Deno.test("Descartar con JSON inválido responde 400", async () => {
  const res = await app.request("/api/bottles/1/discard", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{no es json",
  });

  assertEquals(res.status, 400);
});

Deno.test("Descartar con un id no numérico responde 404", async () => {
  const res = await app.request("/api/bottles/abc/discard", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "destroy" }),
  });

  assertEquals(res.status, 404);
});

Deno.test("Descartar con un id decimal responde 404", async () => {
  const res = await app.request("/api/bottles/1.5/discard", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "destroy" }),
  });

  assertEquals(res.status, 404);
});

Deno.test("No puedo devolver al mar una botella destruida", async () => {
  await db.execute("delete from bottles");
  await lanzar({ text: "Botella que destruiré" });

  const cookie = await crearVisita("Lectora");
  const { data: vista } = await (await pedirDelMar(cookie)).json();

  await descartar(vista.id, "destroy", cookie);

  const res = await descartar(vista.id, "return", cookie);
  assertEquals(res.status, 404);
});

Deno.test("No puedo devolver al mar una botella que no he visto", async () => {
  await db.execute("delete from bottles");
  const { data: creada } = await (await lanzar({ text: "Botella ajena" })).json();

  const res = await descartar(creada.id, "return");
  assertEquals(res.status, 403);
});

Deno.test("No puedo destruir una botella que no he visto", async () => {
  await db.execute("delete from bottles");
  const { data: creada } = await (await lanzar({ text: "Botella ajena" })).json();

  const res = await descartar(creada.id, "destroy");
  assertEquals(res.status, 403);
});

Deno.test("Recorta los espacios del texto antes de guardarlo", async () => {
  await db.execute("delete from bottles");

  const { data } = await (await lanzar({ text: "  hola mundo  " })).json();

  assertEquals(data.text, "hola mundo");
});

Deno.test("Las respuestas solo exponen id y texto", async () => {
  await db.execute("delete from bottles");
  const { data: creada } = await (await lanzar({ text: "Sin campos internos" })).json();
  assertEquals(Object.keys(creada).sort(), ["id", "text"]);

  const { data: delMar } = await (await pedirDelMar()).json();
  assertEquals(Object.keys(delMar).sort(), ["id", "text"]);
});

Deno.test("Una cookie de visitante inválida no rompe el mar", async () => {
  await db.execute("delete from bottles");
  await lanzar({ text: "Botella para cookie rara" });

  const res = await pedirDelMar(`visitor=${"x".repeat(200)}`);

  assertEquals(res.status, 200);
  assertMatch(res.headers.get("set-cookie") ?? "", /^visitor=[0-9a-f-]{36}/);
});

Deno.test("Dos peticiones simultáneas del mismo visitante no fallan", async () => {
  await db.execute("delete from bottles");
  await lanzar({ text: "Botella concurrente" });

  const primera = await pedirDelMar();
  const cookie = (primera.headers.get("set-cookie") ?? "").split(";")[0];

  const [a, b] = await Promise.all([pedirDelMar(cookie), pedirDelMar(cookie)]);

  assertEquals(a.status, 200);
  assertEquals(b.status, 200);
});

Deno.test("Destruir dos veces responde 404 la segunda", async () => {
  await db.execute("delete from bottles");
  await lanzar({ text: "Botella que destruyo dos veces" });

  const cookie = await crearVisita("Lectora");
  const { data: vista } = await (await pedirDelMar(cookie)).json();

  await descartar(vista.id, "destroy", cookie);
  const res = await descartar(vista.id, "destroy", cookie);

  assertEquals(res.status, 404);
});

Deno.test("Dos peticiones simultáneas del mismo visitante no reciben la misma botella", async () => {
  await db.execute("delete from bottles");

  const cookie = await crearVisita("Lectora");

  await lanzar({ text: "La única botella" });

  const [a, b] = await Promise.all([pedirDelMar(cookie), pedirDelMar(cookie)]);
  const { data: una } = await a.json();
  const { data: otra } = await b.json();

  assertEquals(a.status, 200);
  assertEquals(b.status, 200);
  assertEquals([una, otra].filter((d) => d !== null).length, 1);
});

Deno.test("Un cuerpo demasiado grande responde 413", async () => {
  const res = await app.request("/api/bottles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "a".repeat(100_000) }),
  });

  assertEquals(res.status, 413);
});

Deno.test("La cookie del visitante en mayúsculas es el mismo visitante", async () => {
  await db.execute("delete from bottles");
  await lanzar({ text: "Botella uno" });

  const cookie = await crearVisita("Lectora");
  const [nombre, valor] = cookie.split("=");

  await pedirDelMar(`${nombre}=${valor.toUpperCase()}`);

  const filas = await db.execute("select count(*)::int as total from bottle_views");
  assertEquals(filas.rows[0], { total: 1 });
});

Deno.test("El descarte también expone solo id y texto", async () => {
  await db.execute("delete from bottles");
  await lanzar({ text: "Botella para devolver" });

  const cookie = await crearVisita("Lectora");
  const { data: vista } = await (await pedirDelMar(cookie)).json();

  const res = await descartar(vista.id, "return", cookie);
  const { data } = await res.json();

  assertEquals(Object.keys(data).sort(), ["id", "text"]);
});

// ------------------------------------------------------------------------ 2c
const recoger = (id: number, cookie?: string) =>
  app.request(`/api/bottles/${id}/pick`, {
    method: "POST",
    headers: cookie ? { cookie } : {},
  });

Deno.test("Recoger una botella vista y libre la reserva para mí", async () => {
  await db.execute("delete from bottles");
  await lanzar({ text: "Botella para recoger" });

  const cookie = await crearVisita("Lectora");
  const { data: vista } = await (await pedirDelMar(cookie)).json();

  const res = await recoger(vista.id, cookie);
  assertEquals(res.status, 200);

  const ajena = await pedirDelMar();
  const { data: suya } = await ajena.json();
  assertEquals(suya, null);
});

Deno.test("Recoger dos veces la misma botella responde 409", async () => {
  await db.execute("delete from bottles");
  await lanzar({ text: "Botella repetida" });

  const cookie = await crearVisita("Lectora");
  const { data: vista } = await (await pedirDelMar(cookie)).json();

  assertEquals((await recoger(vista.id, cookie)).status, 200);
  assertEquals((await recoger(vista.id, cookie)).status, 409);
});

Deno.test("Recoger una botella que no he visto responde 403", async () => {
  await db.execute("delete from bottles");

  const sinCookie = await pedirDelMar();
  const cookie = (sinCookie.headers.get("set-cookie") ?? "").split(";")[0];

  const { data: creada } = await (await lanzar({ text: "Botella sin ver" })).json();

  assertEquals((await recoger(creada.id, cookie)).status, 403);
});

Deno.test("Recoger con otra reserva vigente responde 409", async () => {
  await db.execute("delete from bottles");
  await lanzar({ text: "Botella primera" });
  await lanzar({ text: "Botella segunda" });

  const cookie = await crearVisita("Lectora");
  const { data: primera } = await (await pedirDelMar(cookie)).json();
  const { data: segunda } = await (await pedirDelMar(cookie)).json();

  assertEquals((await recoger(primera.id, cookie)).status, 200);
  assertEquals((await recoger(segunda.id, cookie)).status, 409);
});

Deno.test("Recoger una botella reservada por otro responde 409", async () => {
  await db.execute("delete from bottles");
  await lanzar({ text: "Botella disputada" });

  const cookieMia = await crearVisita("Mía");
  const { data: vista } = await (await pedirDelMar(cookieMia)).json();

  const cookieAjena = await crearVisita("Ajena");
  assertEquals((await (await pedirDelMar(cookieAjena)).json()).data.id, vista.id);

  assertEquals((await recoger(vista.id, cookieMia)).status, 200);
  assertEquals((await recoger(vista.id, cookieAjena)).status, 409);
});

const liberar = (id: number, cookie?: string) =>
  app.request(`/api/bottles/${id}/release`, {
    method: "POST",
    headers: cookie ? { cookie } : {},
  });

Deno.test("Al expirar, la botella vuelve al mar para otros pero no para mí", async () => {
  await db.execute("delete from bottles");
  await lanzar({ text: "Botella que expira" });

  const cookie = await crearVisita("Lectora");
  const { data: vista } = await (await pedirDelMar(cookie)).json();
  assertEquals((await recoger(vista.id, cookie)).status, 200);

  await db.execute("update reservations set expires_at = now() - interval '1 hour'");

  const ajena = await pedirDelMar();
  assertEquals((await ajena.json()).data.id, vista.id);

  const miaOtraVez = await pedirDelMar(cookie);
  assertEquals((await miaOtraVez.json()).data, null);
});

Deno.test("Liberar mi reserva la devuelve al mar para otra visita", async () => {
  await db.execute("delete from bottles");
  await lanzar({ text: "Botella que libero" });

  const cookie = await crearVisita("Lectora");
  const { data: vista } = await (await pedirDelMar(cookie)).json();
  assertEquals((await recoger(vista.id, cookie)).status, 200);

  assertEquals((await liberar(vista.id, cookie)).status, 200);

  const ajena = await pedirDelMar();
  assertEquals((await ajena.json()).data.id, vista.id);
});

Deno.test("Liberar una reserva que no es mía responde 403", async () => {
  await db.execute("delete from bottles");
  await lanzar({ text: "Botella de otro" });

  const cookieMia = await crearVisita("Mía");
  const { data: vista } = await (await pedirDelMar(cookieMia)).json();
  assertEquals((await recoger(vista.id, cookieMia)).status, 200);

  const cookieAjena = await crearVisita("Ajena");
  await (await pedirDelMar(cookieAjena)).json();

  assertEquals((await liberar(vista.id, cookieAjena)).status, 403);
});

Deno.test("Destruir una botella reservada por otro responde 409", async () => {
  await db.execute("delete from bottles");
  await lanzar({ text: "Botella reservada ajena" });

  const cookieMia = await crearVisita("Mía");
  const { data: vista } = await (await pedirDelMar(cookieMia)).json();

  const cookieAjena = await crearVisita("Ajena");
  await (await pedirDelMar(cookieAjena)).json();

  assertEquals((await recoger(vista.id, cookieMia)).status, 200);
  assertEquals((await descartar(vista.id, "destroy", cookieAjena)).status, 409);
});

Deno.test("Recoger una botella destruida responde 404", async () => {
  await db.execute("delete from bottles");
  await lanzar({ text: "Botella destruida de antemano" });

  const cookie = await crearVisita("Lectora");
  const { data: vista } = await (await pedirDelMar(cookie)).json();

  await db.execute("update bottles set destroyed_at = now()");

  assertEquals((await recoger(vista.id, cookie)).status, 404);
});

// ------------------------------------------------------------------------- 3
Deno.test("Lanzar una botella reparte cookie de visitante", async () => {
  await db.execute("delete from bottles");

  const res = await lanzar({ text: "Primera del día" });

  assertEquals(res.status, 201);
  assertMatch(res.headers.get("set-cookie") ?? "", /^visitor=[0-9a-f-]{36}/);
});

Deno.test("El sexto lanzamiento del día responde 429 y no se publica", async () => {
  await db.execute("delete from bottles");

  const primera = await lanzar({ text: "Botella uno" });
  const cookie = (primera.headers.get("set-cookie") ?? "").split(";")[0];

  for (const n of ["dos", "tres", "cuatro", "cinco"]) {
    assertEquals((await lanzar({ text: `Botella ${n}` }, cookie)).status, 201);
  }

  const sexta = await lanzar({ text: "Botella seis" }, cookie);

  assertEquals(sexta.status, 429);
  const filas = await db.execute("select count(*)::int as total from bottles");
  assertEquals(filas.rows[0], { total: 5 });
});

Deno.test("Al cambiar el día UTC se recupera el cupo", async () => {
  await db.execute("delete from bottles");

  const primera = await lanzar({ text: "Botella uno" });
  const cookie = (primera.headers.get("set-cookie") ?? "").split(";")[0];
  for (const n of ["dos", "tres", "cuatro", "cinco"]) {
    await lanzar({ text: `Botella ${n}` }, cookie);
  }

  await db.execute("update bottles set created_at = now() - interval '2 days'");

  assertEquals((await lanzar({ text: "Botella del día siguiente" }, cookie)).status, 201);
});

Deno.test("Dos lanzamientos simultáneos no se saltan el tope de 5", async () => {
  await db.execute("delete from bottles");

  const primera = await lanzar({ text: "Botella uno" });
  const cookie = (primera.headers.get("set-cookie") ?? "").split(";")[0];
  for (const n of ["dos", "tres", "cuatro"]) {
    await lanzar({ text: `Botella ${n}` }, cookie);
  }

  const [a, b] = await Promise.all([
    lanzar({ text: "Paralela uno" }, cookie),
    lanzar({ text: "Paralela dos" }, cookie),
  ]);

  assertEquals([a.status, b.status].sort(), [201, 429]);
});

Deno.test("Destruir una de mis botellas no me devuelve cupo", async () => {
  await db.execute("delete from bottles");

  const primera = await lanzar({ text: "Botella uno" });
  const cookie = (primera.headers.get("set-cookie") ?? "").split(";")[0];
  for (const n of ["dos", "tres", "cuatro", "cinco"]) {
    await lanzar({ text: `Botella ${n}` }, cookie);
  }

  const cookieAjena = await crearVisita("Otra");
  const { data: vista } = await (await pedirDelMar(cookieAjena)).json();
  assertEquals((await descartar(vista.id, "destroy", cookieAjena)).status, 200);

  assertEquals((await lanzar({ text: "Después de destruir" }, cookie)).status, 429);
});

Deno.test("El cupo es por visitante", async () => {
  await db.execute("delete from bottles");

  const primera = await lanzar({ text: "Botella uno" });
  const cookie = (primera.headers.get("set-cookie") ?? "").split(";")[0];
  for (const n of ["dos", "tres", "cuatro", "cinco"]) {
    await lanzar({ text: `Botella ${n}` }, cookie);
  }

  const cookieAjena = await crearVisita("Otra visita");

  assertEquals((await lanzar({ text: "Botella de otra visita" }, cookieAjena)).status, 201);
});

// ------------------------------------------------------------------------- 4
const ponerPerfil = (alias: unknown, cookie?: string) =>
  app.request("/api/profile", {
    method: "PUT",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ alias }),
  });

const miPerfil = (cookie?: string) =>
  app.request("/api/profile", { headers: cookie ? { cookie } : {} });

const crearVisita = async (alias = "Tester") => {
  const res = await ponerPerfil(alias);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  if (res.status !== 200 || !cookie) {
    throw new Error(`no se pudo crear la visita "${alias}": ${res.status}`);
  }
  return cookie;
};

Deno.test("PUT /api/profile guarda el alias y reparte cookie", async () => {
  const res = await ponerPerfil("Náufrago");

  assertEquals(res.status, 200);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  assertMatch(cookie, /^visitor=/);

  const { data } = await (await miPerfil(cookie)).json();
  assertEquals(data.alias, "Náufrago");
});

Deno.test("GET /api/profile devuelve null sin perfil", async () => {
  const res = await miPerfil();

  assertEquals(res.status, 200);
  assertEquals((await res.json()).data, null);
});

Deno.test("Rechaza alias de 2 y de 21 caracteres", async () => {
  assertEquals((await ponerPerfil("ab")).status, 422);
  assertEquals((await ponerPerfil("a".repeat(21))).status, 422);
});

Deno.test("Un segundo PUT actualiza el alias", async () => {
  const cookie = await crearVisita("Primero");

  assertEquals((await ponerPerfil("Segundo", cookie)).status, 200);
  const { data } = await (await miPerfil(cookie)).json();
  assertEquals(data.alias, "Segundo");
});

Deno.test("Lanzar sin perfil responde 403 y no publica", async () => {
  await db.execute("delete from bottles");

  const res = await app.request("/api/bottles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Sin perfil" }),
  });

  assertEquals(res.status, 403);
  const filas = await db.execute("select count(*)::int as total from bottles");
  assertEquals(filas.rows[0], { total: 0 });
});

Deno.test("Recoger sin perfil responde 403", async () => {
  await db.execute("delete from bottles");
  const cookieAutora = await crearVisita("Autora");
  await lanzar({ text: "Botella de autora" }, cookieAutora);

  const sinPerfil = await pedirDelMar();
  const { data: vista } = await sinPerfil.json();
  const cookieSinPerfil = (sinPerfil.headers.get("set-cookie") ?? "").split(";")[0];

  assertEquals((await recoger(vista.id, cookieSinPerfil)).status, 403);
});

Deno.test("Al recoger veo el alias del autor, pero no antes", async () => {
  await db.execute("delete from bottles");
  const cookieAutora = await crearVisita("Ana");
  await lanzar({ text: "Botella de Ana" }, cookieAutora);

  const cookieLectora = await crearVisita("Bea");
  const { data: vista } = await (await pedirDelMar(cookieLectora)).json();

  assertEquals("authorAlias" in vista, false);

  const { data: recogida } = await (await recoger(vista.id, cookieLectora)).json();
  assertEquals(recogida.authorAlias, "Ana");
});

Deno.test("Mi propia botella no me toca en el mar, pero sí a otra visita", async () => {
  await db.execute("delete from bottles");

  const cookie = await crearVisita("Autora");
  await lanzar({ text: "Botella de autora" }, cookie);

  const mia = await pedirDelMar(cookie);
  assertEquals((await mia.json()).data, null);

  const ajena = await pedirDelMar();
  assertEquals((await ajena.json()).data.text, "Botella de autora");
});

// ------------------------------------------- arreglos de la tercera revisión
Deno.test("Tras expirar la reserva, otra visita puede recoger la botella", async () => {
  await db.execute("delete from bottles");
  await lanzar({ text: "Botella que caduca" });

  const cookieA = await crearVisita("Ana");
  const { data: vista } = await (await pedirDelMar(cookieA)).json();
  assertEquals((await recoger(vista.id, cookieA)).status, 200);

  await db.execute("update reservations set expires_at = now() - interval '1 hour'");

  const cookieB = await crearVisita("Bea");
  await pedirDelMar(cookieB);
  assertEquals((await recoger(vista.id, cookieB)).status, 200);
});

Deno.test("Destruir mi botella reservada libera la reserva", async () => {
  await db.execute("delete from bottles");
  await lanzar({ text: "Botella que destruyo yo" });

  const cookie = await crearVisita("Autora");
  const { data: vista } = await (await pedirDelMar(cookie)).json();
  assertEquals((await recoger(vista.id, cookie)).status, 200);
  assertEquals((await descartar(vista.id, "destroy", cookie)).status, 200);

  const filas = await db.execute("select count(*)::int as total from reservations");
  assertEquals(filas.rows[0], { total: 0 });
});

Deno.test("Devolver al mar libera mi reserva", async () => {
  await db.execute("delete from bottles");
  await lanzar({ text: "Botella que devuelvo reservada" });

  const cookie = await crearVisita("Autora");
  const { data: vista } = await (await pedirDelMar(cookie)).json();
  assertEquals((await recoger(vista.id, cookie)).status, 200);
  assertEquals((await descartar(vista.id, "return", cookie)).status, 200);

  const filas = await db.execute("select count(*)::int as total from reservations");
  assertEquals(filas.rows[0], { total: 0 });
});

Deno.test("Tres emojis se rechazan por cortos, no revientan", async () => {
  const res = await lanzar({ text: "🙂🙂🙂" });

  assertEquals(res.status, 422);
});

Deno.test("Cinco emojis se aceptan", async () => {
  const res = await lanzar({ text: "🙂🙂🙂🙂🙂" });

  assertEquals(res.status, 201);
});

Deno.test("Un texto con byte NUL responde 422", async () => {
  const res = await lanzar({ text: "hola\u0000mundo" });

  assertEquals(res.status, 422);
});

Deno.test("Rechaza un alias invisible", async () => {
  const res = await ponerPerfil("\u200b\u200b\u200b");

  assertEquals(res.status, 422);
});

Deno.test("Ver el mar sin perfil no rompe el onboarding", async () => {
  await db.execute("delete from bottles");
  await lanzar({ text: "Botella no quemada" });

  const sinPerfil = await pedirDelMar();
  const cookie = (sinPerfil.headers.get("set-cookie") ?? "").split(";")[0];
  const { data: vista } = await sinPerfil.json();

  await ponerPerfil("Tarde", cookie);

  // La vista quedó registrada, así que ya no vuelve a salir, pero sí se puede recoger.
  assertEquals((await (await pedirDelMar(cookie)).json()).data, null);
  assertEquals((await recoger(vista.id, cookie)).status, 200);
});

// ------------------------------------------------------------------------- 5
const enviarMensaje = (id: number, text: unknown, cookie?: string) =>
  app.request(`/api/bottles/${id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ text }),
  });

const leerMensajes = (id: number, cookie?: string, query = "") =>
  app.request(`/api/bottles/${id}/messages${query}`, {
    headers: cookie ? { cookie } : {},
  });

const prepararConversacion = async () => {
  await db.execute("delete from bottles");
  const cookieAutora = await crearVisita("Ana");
  await lanzar({ text: "Botella de Ana" }, cookieAutora);

  const cookieLectora = await crearVisita("Bea");
  const { data: vista } = await (await pedirDelMar(cookieLectora)).json();
  assertEquals((await recoger(vista.id, cookieLectora)).status, 200);

  return { cookieAutora, cookieLectora, vista };
};

Deno.test("Mi primer mensaje fija la conversación y la botella no vuelve al mar", async () => {
  const { cookieLectora, vista } = await prepararConversacion();

  const res = await enviarMensaje(vista.id, "Hola, me gustó tu botella", cookieLectora);
  assertEquals(res.status, 201);

  // Solo caducan las reservas sin confirmar; la conversación fija tiene expiración infinita.
  await db.execute("update reservations set expires_at = now() - interval '1 hour' where confirmed_at is null");

  const otra = await pedirDelMar();
  assertEquals((await otra.json()).data, null);
});

Deno.test("El autor no puede escribir antes del primer mensaje", async () => {
  const { cookieAutora, vista } = await prepararConversacion();

  assertEquals((await enviarMensaje(vista.id, "Escribo yo primero", cookieAutora)).status, 403);
});

Deno.test("Quien recoge lee el chat vacío y el autor no", async () => {
  const { cookieAutora, cookieLectora, vista } = await prepararConversacion();

  const lectora = await leerMensajes(vista.id, cookieLectora);
  assertEquals(lectora.status, 200);
  assertEquals((await lectora.json()).data, []);

  assertEquals((await leerMensajes(vista.id, cookieAutora)).status, 403);
});

Deno.test("Tras el primer mensaje el autor responde y ambos leen", async () => {
  const { cookieAutora, cookieLectora, vista } = await prepararConversacion();
  await enviarMensaje(vista.id, "Hola desde el mar", cookieLectora);

  const respuesta = await enviarMensaje(vista.id, "Hola Bea, encantada", cookieAutora);
  assertEquals(respuesta.status, 201);

  const { data: deLectora } = await (await leerMensajes(vista.id, cookieLectora)).json();
  assertEquals(deLectora.length, 2);
  assertEquals(deLectora[0].alias, "Bea");
  assertEquals(deLectora[0].mine, true);
  assertEquals(deLectora[1].alias, "Ana");
  assertEquals(deLectora[1].mine, false);

  const { data: deAutora } = await (await leerMensajes(vista.id, cookieAutora)).json();
  assertEquals(deAutora[0].mine, false);
  assertEquals(deAutora[1].mine, true);
});

Deno.test("Un tercero no puede leer ni escribir la conversación", async () => {
  const { cookieLectora, vista } = await prepararConversacion();
  await enviarMensaje(vista.id, "Hola desde el mar", cookieLectora);

  const cookieTercera = await crearVisita("Carol");

  assertEquals((await leerMensajes(vista.id, cookieTercera)).status, 403);
  assertEquals((await enviarMensaje(vista.id, "Me cuelo", cookieTercera)).status, 403);
});

Deno.test("Valida los mensajes: vacío, 501 caracteres y 500 emojis", async () => {
  const { cookieLectora, vista } = await prepararConversacion();

  assertEquals((await enviarMensaje(vista.id, "", cookieLectora)).status, 422);
  assertEquals((await enviarMensaje(vista.id, "a".repeat(501), cookieLectora)).status, 422);
  assertEquals((await enviarMensaje(vista.id, "🙂".repeat(500), cookieLectora)).status, 201);
});

Deno.test("Una botella con conversación fija no se puede destruir ni devolver", async () => {
  const { cookieLectora, vista } = await prepararConversacion();
  await enviarMensaje(vista.id, "Hola desde el mar", cookieLectora);

  assertEquals((await descartar(vista.id, "destroy", cookieLectora)).status, 409);
  assertEquals((await descartar(vista.id, "return", cookieLectora)).status, 409);
});

Deno.test("Una reserva confirmada no se puede liberar", async () => {
  const { cookieLectora, vista } = await prepararConversacion();
  await enviarMensaje(vista.id, "Hola desde el mar", cookieLectora);

  assertEquals((await liberar(vista.id, cookieLectora)).status, 409);
});

Deno.test("Tras fijar la conversación, quien recogió puede recoger otra botella", async () => {
  const { cookieLectora, vista } = await prepararConversacion();
  await lanzar({ text: "Otra botella en el mar" });
  await enviarMensaje(vista.id, "Hola desde el mar", cookieLectora);

  const { data: otra } = await (await pedirDelMar(cookieLectora)).json();
  assertEquals((await recoger(otra.id, cookieLectora)).status, 200);
});

Deno.test("Los mensajes se leen de 50 en 50 con ?before", async () => {
  const { cookieLectora, vista } = await prepararConversacion();
  for (let i = 1; i <= 55; i++) {
    await enviarMensaje(vista.id, `Mensaje ${i}`, cookieLectora);
  }

  const { data: ultimos } = await (await leerMensajes(vista.id, cookieLectora)).json();
  assertEquals(ultimos.length, 50);
  assertEquals(ultimos[49].text, "Mensaje 55");

  const { data: anteriores } = await (
    await leerMensajes(vista.id, cookieLectora, `?before=${ultimos[0].id}`)
  ).json();
  assertEquals(anteriores.length, 5);
  assertEquals(anteriores[4].text, "Mensaje 5");
});

// ------------------------------------------- arreglos de la cuarta revisión
Deno.test("Confirmar fija la reserva para siempre", async () => {
  const { cookieLectora, vista } = await prepararConversacion();
  await enviarMensaje(vista.id, "Hola desde el mar", cookieLectora);

  const filas = await db.execute(
    "select confirmed_at is not null as confirmada, expires_at = 'infinity' as infinita from reservations",
  );
  assertEquals(filas.rows[0], { confirmada: true, infinita: true });
});

Deno.test("Descartar sin cookie una conversación fija responde 403, no 409", async () => {
  const { cookieLectora, vista } = await prepararConversacion();
  await enviarMensaje(vista.id, "Hola desde el mar", cookieLectora);

  const res = await app.request(`/api/bottles/${vista.id}/discard`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "destroy" }),
  });

  assertEquals(res.status, 403);
});

Deno.test("Un ?before inválido responde 422", async () => {
  const { cookieLectora, vista } = await prepararConversacion();
  await enviarMensaje(vista.id, "Hola desde el mar", cookieLectora);

  assertEquals((await leerMensajes(vista.id, cookieLectora, "?before=abc")).status, 422);
});

Deno.test("El alias de un mensaje no cambia al renombrarme", async () => {
  const { cookieLectora, vista } = await prepararConversacion();
  await enviarMensaje(vista.id, "Hola desde el mar", cookieLectora);
  await ponerPerfil("Bego", cookieLectora);

  const { data } = await (await leerMensajes(vista.id, cookieLectora)).json();
  assertEquals(data[0].alias, "Bea");
});

Deno.test("Un mensaje con carácter bidi se rechaza", async () => {
  const { cookieLectora, vista } = await prepararConversacion();
  await enviarMensaje(vista.id, "Hola desde el mar", cookieLectora);

  const res = await enviarMensaje(vista.id, "Hola\u202Emundo", cookieLectora);

  assertEquals(res.status, 422);
});

// ------------------------------------------------------------------------- 6
const miLista = (cookie?: string, query = "") =>
  app.request(`/api/bottles/mine${query}`, { headers: cookie ? { cookie } : {} });

const botellaDe = async (visitor: string, texto: string) => {
  const filas = await db.execute(
    sql`insert into bottles (text, author_visitor) values (${texto}, ${visitor}) returning id`,
  );
  return (filas.rows[0] as { id: number }).id;
};

Deno.test("Mi lista sin botellas devuelve un array vacío", async () => {
  await db.execute("delete from bottles");
  const cookie = await crearVisita("Ana");

  const res = await miLista(cookie);

  assertEquals(res.status, 200);
  assertEquals((await res.json()).data, []);
});

Deno.test("Mi lista muestra el estado de cada botella", async () => {
  await db.execute("delete from bottles");
  const cookie = await crearVisita("Ana");
  const yo = cookie.split("=")[1];
  const otra = (await crearVisita("Bea")).split("=")[1];

  const idMar = await botellaDe(yo, "En el mar");
  const idReservada = await botellaDe(yo, "Reservada");
  const idConversacion = await botellaDe(yo, "Conversacion");
  const idDestruida = await botellaDe(yo, "Destruida");

  await db.execute(sql`
    insert into reservations (bottle_id, visitor_id, expires_at)
    values (${idReservada}, ${otra}, now() + interval '1 hour')
  `);
  await db.execute(sql`
    insert into reservations (bottle_id, visitor_id, expires_at, confirmed_at)
    values (${idConversacion}, ${otra}, 'infinity', now())
  `);
  await db.execute(sql`update bottles set destroyed_at = now() where id = ${idDestruida}`);

  const { data } = await (await miLista(cookie)).json();
  const porId = new Map(data.map((b: { id: number; status: string }) => [b.id, b.status]));

  assertEquals(porId.get(idMar), "en_el_mar");
  assertEquals(porId.get(idReservada), "reservada");
  assertEquals(porId.get(idConversacion), "conversacion");
  assertEquals(porId.get(idDestruida), "destruida");
});

Deno.test("Mi lista no incluye botellas de otras personas", async () => {
  await db.execute("delete from bottles");
  const cookie = await crearVisita("Ana");
  const yo = cookie.split("=")[1];
  const otra = (await crearVisita("Bea")).split("=")[1];

  await botellaDe(yo, "Botella mía");
  await botellaDe(otra, "Botella ajena");

  const { data } = await (await miLista(cookie)).json();

  assertEquals(data.length, 1);
  assertEquals(data[0].text, "Botella mía");
});

Deno.test("Mi lista expone solo id, texto, estado y fecha", async () => {
  await db.execute("delete from bottles");
  const cookie = await crearVisita("Ana");
  await botellaDe(cookie.split("=")[1], "Botella mía");

  const { data } = await (await miLista(cookie)).json();

  assertEquals(Object.keys(data[0]).sort(), ["createdAt", "id", "status", "text"]);
});

Deno.test("Una reserva expirada sin mensajes vuelve a estar en el mar", async () => {
  await db.execute("delete from bottles");
  const cookie = await crearVisita("Ana");
  const yo = cookie.split("=")[1];
  const otra = (await crearVisita("Bea")).split("=")[1];

  const id = await botellaDe(yo, "Reserva caducada");
  await db.execute(sql`
    insert into reservations (bottle_id, visitor_id, expires_at)
    values (${id}, ${otra}, now() - interval '1 hour')
  `);

  const { data } = await (await miLista(cookie)).json();
  assertEquals(data[0].status, "en_el_mar");
});

Deno.test("Mi lista se pagina de 50 en 50 con ?before", async () => {
  await db.execute("delete from bottles");
  const cookie = await crearVisita("Ana");
  const yo = cookie.split("=")[1];

  for (let i = 1; i <= 55; i++) await botellaDe(yo, `Botella ${i}`);

  const { data: ultimas } = await (await miLista(cookie)).json();
  assertEquals(ultimas.length, 50);
  assertEquals(ultimas[49].text, "Botella 55");

  const { data: anteriores } = await (await miLista(cookie, `?before=${ultimas[0].id}`)).json();
  assertEquals(anteriores.length, 5);
  assertEquals(anteriores[4].text, "Botella 5");
});

// ------------------------------------------------------------------------- 8
const correo = () => `persona-${crypto.randomUUID()}@example.com`;

const registrar = (email: string, password: string, cookie?: string) =>
  app.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ email, password }),
  });

const entrar = (email: string, password: string, cookie?: string) =>
  app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ email, password }),
  });

const conToken = (token: string) => ({ authorization: `Bearer ${token}` });

const limpiarCuentas = async () => {
  await db.execute("delete from sessions");
  await db.execute("delete from accounts");
};

const tokenDe = async (res: Response) => (await res.json()).data.token as string;
const cookieDe = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];

Deno.test("Registro devuelve token y email, y /me lo confirma", async () => {
  await limpiarCuentas();
  const email = correo();

  const res = await registrar(email, "contraseña-larga");

  assertEquals(res.status, 201);
  const { data } = await res.json();
  assertEquals(Object.keys(data).sort(), ["email", "token"]);
  assertEquals(data.email, email);

  const me = await app.request("/api/auth/me", { headers: conToken(data.token) });
  assertEquals(me.status, 200);
  assertEquals((await me.json()).data.email, email);
});

Deno.test("Registro sin cookie reparte visitante y lo adopta", async () => {
  await limpiarCuentas();
  const email = correo();

  const res = await registrar(email, "contraseña-larga");
  const cookie = cookieDe(res);
  assertMatch(cookie, /^visitor=/);

  const filas = await db.execute("select visitor_id from accounts");
  assertEquals(filas.rows[0].visitor_id, cookie.split("=")[1]);
});

Deno.test("Registro con la cookie de una cuenta existente responde 409", async () => {
  await limpiarCuentas();

  const alta = await registrar(correo(), "contraseña-larga");
  const cookie = cookieDe(alta);

  const res = await registrar(correo(), "otra-contraseña", cookie);

  assertEquals(res.status, 409);
});

Deno.test("Email duplicado, también con distinto caso, responde 409", async () => {
  await limpiarCuentas();
  const email = correo();
  await registrar(email, "contraseña-larga");

  assertEquals((await registrar(email.toUpperCase(), "contraseña-larga")).status, 409);
});

Deno.test("Dos registros concurrentes con el mismo email dejan una sola cuenta", async () => {
  await limpiarCuentas();
  const email = correo();

  const [a, b] = await Promise.all([
    registrar(email, "contraseña-larga"),
    registrar(email, "contraseña-larga"),
  ]);

  assertEquals([a.status, b.status].sort(), [201, 409]);
  const filas = await db.execute("select count(*)::int as total from accounts");
  assertEquals(filas.rows[0], { total: 1 });
});

Deno.test("Rechaza contraseñas cortas, largas y emails inválidos", async () => {
  await limpiarCuentas();

  assertEquals((await registrar(correo(), "1234567")).status, 422);
  assertEquals((await registrar(correo(), "🙂".repeat(129))).status, 422);
  assertEquals((await registrar("no-es-email", "contraseña-larga")).status, 422);
});

Deno.test("Login con email en mayúsculas y con espacios funciona", async () => {
  await limpiarCuentas();
  const email = correo();
  await registrar(email, "contraseña-larga");

  const res = await entrar(`  ${email.toUpperCase()}  `, "contraseña-larga");

  assertEquals(res.status, 200);
  assertMatch((await res.json()).data.token, /^[A-Za-z0-9_-]{43}$/);
});

Deno.test("Contraseña incorrecta y email inexistente dan el mismo 401", async () => {
  await limpiarCuentas();
  const email = correo();
  await registrar(email, "contraseña-larga");

  const antes = await db.execute("select count(*)::int as total from sessions");
  const mala = await entrar(email, "contraseña-mala");
  const inexistente = await entrar(correo(), "contraseña-mala");

  assertEquals(mala.status, 401);
  assertEquals(inexistente.status, 401);
  assertEquals(await mala.text(), await inexistente.text());

  const despues = await db.execute("select count(*)::int as total from sessions");
  assertEquals(despues.rows[0], antes.rows[0]);
});

Deno.test("En la base no hay contraseñas ni tokens en claro", async () => {
  await limpiarCuentas();
  const password = "contraseña-larga";
  const res = await registrar(correo(), password);
  const token = await tokenDe(res);

  const cuentas = await db.execute("select password_hash from accounts");
  const hash = cuentas.rows[0].password_hash as string;
  assertEquals(hash === password, false);
  assertMatch(hash, /^pbkdf2-sha256\$600000\$/);

  const sesiones = await db.execute("select token_hash from sessions");
  assertEquals(sesiones.rows[0].token_hash === token, false);

  // El digest guardado no sirve como credencial
  const conDigest = await app.request("/api/auth/me", {
    headers: conToken(sesiones.rows[0].token_hash as string),
  });
  assertEquals(conDigest.status, 401);
});

Deno.test("El registro conserva la historia anónima", async () => {
  await limpiarCuentas();
  await db.execute("delete from bottles");

  const cookie = await crearVisita("Ana");
  await lanzar({ text: "Botella que viaja conmigo" }, cookie);

  const res = await registrar(correo(), "contraseña-larga", cookie);
  const token = await tokenDe(res);

  const mine = await app.request("/api/bottles/mine", { headers: conToken(token) });
  const { data } = await mine.json();
  assertEquals(data.length, 1);
  assertEquals(data[0].text, "Botella que viaja conmigo");

  const perfil = await app.request("/api/profile", { headers: conToken(token) });
  assertEquals((await perfil.json()).data.alias, "Ana");
});

Deno.test("La cookie sola de una cuenta responde 401 en todas las rutas", async () => {
  await limpiarCuentas();
  const alta = await registrar(correo(), "contraseña-larga");
  const cookie = cookieDe(alta);

  for (const ruta of ["/api/sea", "/api/bottles/mine", "/api/profile"]) {
    assertEquals((await app.request(ruta, { headers: { cookie } })).status, 401);
  }
  assertEquals(
    (await app.request("/api/bottles/1/messages", { headers: { cookie } })).status,
    401,
  );
});

Deno.test("La cookie de cuenta en mayúsculas también responde 401", async () => {
  await limpiarCuentas();
  const alta = await registrar(correo(), "contraseña-larga");
  const [nombre, valor] = cookieDe(alta).split("=");

  const res = await app.request("/api/sea", {
    headers: { cookie: `${nombre}=${valor.toUpperCase()}` },
  });

  assertEquals(res.status, 401);
});

Deno.test("Tokens basura, caducados o con otro pimiento responden 401", async () => {
  await limpiarCuentas();
  const res = await registrar(correo(), "contraseña-larga");
  const token = await tokenDe(res);

  assertEquals((await app.request("/api/auth/me", { headers: conToken("basura") })).status, 401);

  await db.execute("update sessions set expires_at = now() - interval '1 hour'");
  assertEquals((await app.request("/api/auth/me", { headers: conToken(token) })).status, 401);
});

Deno.test("Logout invalida su token y deja viva la otra sesión", async () => {
  await limpiarCuentas();
  const email = correo();
  await registrar(email, "contraseña-larga");
  const tokenA = await tokenDe(await entrar(email, "contraseña-larga"));
  const tokenB = await tokenDe(await entrar(email, "contraseña-larga"));

  const salida = await app.request("/api/auth/logout", {
    method: "POST",
    headers: conToken(tokenA),
  });
  assertEquals(salida.status, 204);

  assertEquals((await app.request("/api/auth/me", { headers: conToken(tokenA) })).status, 401);
  assertEquals((await app.request("/api/auth/me", { headers: conToken(tokenB) })).status, 200);
});

Deno.test("Logout-all invalida todas las sesiones de la cuenta", async () => {
  await limpiarCuentas();
  const email = correo();
  await registrar(email, "contraseña-larga");
  const tokenA = await tokenDe(await entrar(email, "contraseña-larga"));
  const tokenB = await tokenDe(await entrar(email, "contraseña-larga"));

  const salida = await app.request("/api/auth/logout-all", {
    method: "POST",
    headers: conToken(tokenA),
  });
  assertEquals(salida.status, 204);

  assertEquals((await app.request("/api/auth/me", { headers: conToken(tokenA) })).status, 401);
  assertEquals((await app.request("/api/auth/me", { headers: conToken(tokenB) })).status, 401);
});

Deno.test("Logout limpia la cookie y el dispositivo vuelve a ser anónimo", async () => {
  await limpiarCuentas();
  const alta = await registrar(correo(), "contraseña-larga");
  const token = await tokenDe(alta);
  const cookie = cookieDe(alta);

  const salida = await app.request("/api/auth/logout", {
    method: "POST",
    headers: { ...conToken(token), cookie },
  });

  assertEquals(salida.status, 204);
  assertMatch(salida.headers.get("set-cookie") ?? "", /^visitor=;.*Max-Age=0/);

  const mar = await app.request("/api/sea");
  assertEquals(mar.status, 200);
  assertMatch(mar.headers.get("set-cookie") ?? "", /^visitor=[0-9a-f-]{36}/);
});

Deno.test("Con token válido se ignora la cookie ajena y no se emite Set-Cookie", async () => {
  await limpiarCuentas();
  await db.execute("delete from bottles");
  const alta = await registrar(correo(), "contraseña-larga");
  const token = await tokenDe(alta);
  const cookieAjena = await crearVisita("Otra");
  await lanzar({ text: "Botella de otra persona" }, cookieAjena);

  const mar = await app.request("/api/sea", { headers: { ...conToken(token), cookie: cookieAjena } });
  assertEquals(mar.status, 200);
  assertEquals(mar.headers.get("set-cookie"), null);

  const perfil = await app.request("/api/profile", {
    method: "PUT",
    headers: { "content-type": "application/json", ...conToken(token), cookie: cookieAjena },
    body: JSON.stringify({ alias: "Cuenta" }),
  });
  assertEquals(perfil.status, 200);
  assertEquals(perfil.headers.get("set-cookie"), null);
});

Deno.test("Token inválido con cookie de cuenta no degrada a cookie", async () => {
  await limpiarCuentas();
  const alta = await registrar(correo(), "contraseña-larga");
  const cookie = cookieDe(alta);

  const res = await app.request("/api/sea", {
    headers: { authorization: "Bearer basura", cookie },
  });

  assertEquals(res.status, 401);
});

Deno.test("Una cookie anónima malformada se ignora, no da 401", async () => {
  await limpiarCuentas();
  await db.execute("delete from bottles");
  await lanzar({ text: "Botella anónima" });

  const res = await app.request("/api/sea", { headers: { cookie: "visitor=basura" } });

  assertEquals(res.status, 200);
  assertMatch(res.headers.get("set-cookie") ?? "", /^visitor=[0-9a-f-]{36}/);
});

Deno.test("El cupo de 5 al día se comparte entre dispositivos", async () => {
  await limpiarCuentas();
  await db.execute("delete from bottles");
  const email = correo();
  const alta = await registrar(email, "contraseña-larga");
  const token = await tokenDe(alta);

  const cookie = cookieDe(alta);
  await app.request("/api/profile", {
    method: "PUT",
    headers: { "content-type": "application/json", ...conToken(token) },
    body: JSON.stringify({ alias: "Ana" }),
  });

  for (let i = 1; i <= 5; i++) {
    const res = await app.request("/api/bottles", {
      method: "POST",
      headers: { "content-type": "application/json", ...conToken(token) },
      body: JSON.stringify({ text: `Botella ${i}` }),
    });
    assertEquals(res.status, 201);
  }

  // "Otro dispositivo": login limpio, sin la cookie del primero
  const tokenB = await tokenDe(await entrar(email, "contraseña-larga"));

  const sexta = await app.request("/api/bottles", {
    method: "POST",
    headers: { "content-type": "application/json", ...conToken(tokenB) },
    body: JSON.stringify({ text: "Botella seis" }),
  });

  assertEquals(sexta.status, 429);
  assertEquals(cookie.split("=")[1].length, 36);
});

Deno.test("El rate limit corta a los 11 intentos del mismo email", async () => {
  await limpiarCuentas();
  resetRateLimit();
  const email = correo();
  await registrar(email, "contraseña-larga");

  const estados: number[] = [];
  for (let i = 0; i < 11; i++) {
    estados.push((await entrar(i % 2 === 0 ? email : email.toUpperCase(), "mala")).status);
  }

  assertEquals(estados.slice(0, 10), Array(10).fill(401));
  assertEquals(estados[10], 429);
  assertEquals((await entrar(correo(), "mala")).status, 401);

  resetRateLimit();
});

// ------------------------------------------------------------------------- 9
const ponerPerfilBio = (alias: unknown, bio: unknown, cookie: string) =>
  app.request("/api/profile", {
    method: "PUT",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ alias, bio }),
  });

const darVisitaConPerfil = async (alias: string) => {
  const cookie = await crearVisita(alias);
  return cookie;
};

const visitanteCompleto = async (alias: string) => {
  const cookie = await crearVisita(alias);
  const { data } = await (await app.request("/api/profile", { headers: { cookie } })).json();
  return { cookie, visitorId: cookie.split("=")[1], publicId: data.publicId as string };
};

const bloquear = (publicId: string, cookie: string) =>
  app.request("/api/blocks", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ publicId }),
  });

const desbloquear = (publicId: string, cookie: string) =>
  app.request(`/api/blocks/${publicId}`, { method: "DELETE", headers: { cookie } });

const misBloqueos = (cookie: string) => app.request("/api/blocks", { headers: { cookie } });

const reportar = (body: unknown, cookie: string) =>
  app.request("/api/reports", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });

const limpiarBloqueos = async () => {
  await db.execute("delete from blocks");
  await db.execute("delete from reports");
};

Deno.test("Bloquear oculta las botellas en ambos sentidos y un tercero las sigue viendo", async () => {
  await limpiarBloqueos();
  await db.execute("delete from bottles");

  const ana = await visitanteCompleto("Ana");
  const bea = await visitanteCompleto("Bea");
  await lanzar({ text: "Botella de Ana" }, ana.cookie);
  await lanzar({ text: "Botella de Bea" }, bea.cookie);

  const antes = await (await pedirDelMar(ana.cookie)).json();
  assertEquals(antes.data.text, "Botella de Bea");

  assertEquals((await bloquear(bea.publicId, ana.cookie)).status, 201);

  assertEquals((await (await pedirDelMar(ana.cookie)).json()).data, null);
  assertEquals((await (await pedirDelMar(bea.cookie)).json()).data, null);

  const carla = await visitanteCompleto("Carla");
  const tercera = await (await pedirDelMar(carla.cookie)).json();
  assertEquals(["Botella de Ana", "Botella de Bea"].includes(tercera.data.text), true);
});

Deno.test("El chat responde 403 en ambos sentidos y el historial sigue guardado", async () => {
  await limpiarBloqueos();
  const { cookieAutora, cookieLectora, vista } = await prepararConversacion();
  await enviarMensaje(vista.id, "Hola desde el mar", cookieLectora);
  const lectoraCompleta = (await (await app.request("/api/profile", { headers: { cookie: cookieLectora } })).json()).data;

  assertEquals((await bloquear(lectoraCompleta.publicId, cookieAutora)).status, 201);

  for (const cookie of [cookieAutora, cookieLectora]) {
    assertEquals((await leerMensajes(vista.id, cookie)).status, 403);
    assertEquals((await enviarMensaje(vista.id, "Sigo aquí", cookie)).status, 403);
  }

  const filas = await db.execute("select count(*)::int as total from messages");
  assertEquals(filas.rows[0], { total: 1 });
});

Deno.test("No puedo recoger ni descartar una botella de alguien bloqueado", async () => {
  await limpiarBloqueos();
  await db.execute("delete from bottles");
  const ana = await visitanteCompleto("Ana");
  const bea = await visitanteCompleto("Bea");
  await lanzar({ text: "Botella de Ana" }, ana.cookie);

  const { data: vista } = await (await pedirDelMar(bea.cookie)).json();
  await bloquear(bea.publicId, ana.cookie);

  assertEquals((await recoger(vista.id, bea.cookie)).status, 403);
  assertEquals((await descartar(vista.id, "destroy", bea.cookie)).status, 403);
});

Deno.test("Desbloquear restaura el mar y el chat", async () => {
  await limpiarBloqueos();
  await db.execute("delete from bottles");
  const ana = await visitanteCompleto("Ana");
  const bea = await visitanteCompleto("Bea");

  await bloquear(bea.publicId, ana.cookie);
  await lanzar({ text: "Botella nueva de Bea" }, bea.cookie);
  assertEquals((await (await pedirDelMar(ana.cookie)).json()).data, null);

  assertEquals((await desbloquear(bea.publicId, ana.cookie)).status, 204);
  assertEquals((await (await pedirDelMar(ana.cookie)).json()).data.text, "Botella nueva de Bea");
});

Deno.test("Si los dos se bloquearon, mi desbloqueo no basta", async () => {
  await limpiarBloqueos();
  const ana = await visitanteCompleto("Ana");
  const bea = await visitanteCompleto("Bea");

  await bloquear(bea.publicId, ana.cookie);
  await bloquear(ana.publicId, bea.cookie);
  await desbloquear(bea.publicId, ana.cookie);

  await db.execute("delete from bottles");
  await lanzar({ text: "Botella de Bea" }, bea.cookie);

  assertEquals((await (await pedirDelMar(ana.cookie)).json()).data, null);
});

Deno.test("Bloquear libera una reserva sin confirmar y la botella vuelve al mar", async () => {
  await limpiarBloqueos();
  await db.execute("delete from bottles");
  const ana = await visitanteCompleto("Ana");
  const bea = await visitanteCompleto("Bea");
  await lanzar({ text: "Botella en disputa" }, ana.cookie);

  const { data: vista } = await (await pedirDelMar(bea.cookie)).json();
  assertEquals((await recoger(vista.id, bea.cookie)).status, 200);

  await bloquear(bea.publicId, ana.cookie);

  const reservas = await db.execute("select count(*)::int as total from reservations");
  assertEquals(reservas.rows[0], { total: 0 });

  const carla = await visitanteCompleto("Carla");
  assertEquals((await (await pedirDelMar(carla.cookie)).json()).data.text, "Botella en disputa");
});

Deno.test("Bloquear con conversación confirmada no deja escribir ni confirmar nada", async () => {
  await limpiarBloqueos();
  const { cookieAutora, cookieLectora, vista } = await prepararConversacion();
  await enviarMensaje(vista.id, "Hola desde el mar", cookieLectora);
  const autora = (await (await app.request("/api/profile", { headers: { cookie: cookieAutora } })).json()).data;

  await bloquear(autora.publicId, cookieLectora);

  assertEquals((await enviarMensaje(vista.id, "Mensaje bloqueado", cookieLectora)).status, 403);
  const filas = await db.execute("select count(*)::int as total from messages");
  assertEquals(filas.rows[0], { total: 1 });
});

Deno.test("No puedo bloquearme ni reportarme, y un publicId inexistente da 404", async () => {
  await limpiarBloqueos();
  const ana = await visitanteCompleto("Ana");
  const fantasma = crypto.randomUUID();

  assertEquals((await bloquear(ana.publicId, ana.cookie)).status, 422);
  assertEquals((await reportar({ publicId: ana.publicId, reason: "spam" }, ana.cookie)).status, 422);
  assertEquals((await bloquear(fantasma, ana.cookie)).status, 404);
  assertEquals((await reportar({ publicId: fantasma, reason: "spam" }, ana.cookie)).status, 404);
});

Deno.test("Bloquear dos veces es idempotente", async () => {
  await limpiarBloqueos();
  const ana = await visitanteCompleto("Ana");
  const bea = await visitanteCompleto("Bea");

  assertEquals((await bloquear(bea.publicId, ana.cookie)).status, 201);
  assertEquals((await bloquear(bea.publicId, ana.cookie)).status, 201);

  const filas = await db.execute("select count(*)::int as total from blocks");
  assertEquals(filas.rows[0], { total: 1 });
});

Deno.test("Mi lista de bloqueos expone publicId y alias, nunca el UUID del visitante", async () => {
  await limpiarBloqueos();
  const ana = await visitanteCompleto("Ana");
  const bea = await visitanteCompleto("Bea");
  await bloquear(bea.publicId, ana.cookie);

  const { data } = await (await misBloqueos(ana.cookie)).json();
  assertEquals(data.length, 1);
  assertEquals(Object.keys(data[0]).sort(), ["alias", "publicId"]);
  assertEquals(data[0].alias, "Bea");
  assertEquals(data[0].publicId, bea.publicId);
  assertEquals(data[0].publicId === bea.visitorId, false);

  await ponerPerfil("Bego", bea.cookie);
  const { data: despues } = await (await misBloqueos(ana.cookie)).json();
  assertEquals(despues[0].publicId, bea.publicId);
  assertEquals(despues[0].alias, "Bego");
});

Deno.test("Un reporte se guarda con motivo, texto y botella", async () => {
  await limpiarBloqueos();
  await db.execute("delete from bottles");
  const ana = await visitanteCompleto("Ana");
  const bea = await visitanteCompleto("Bea");
  const { data: botella } = await (await lanzar({ text: "Botella reportada" }, bea.cookie)).json();

  const res = await reportar(
    { publicId: bea.publicId, reason: "acoso", text: "Me escribió cosas feas", bottleId: botella.id },
    ana.cookie,
  );
  assertEquals(res.status, 201);

  const filas = await db.execute("select reporter_id, reported_id, reason, text, bottle_id from reports");
  assertEquals(filas.rows[0], {
    reporter_id: ana.visitorId,
    reported_id: bea.visitorId,
    reason: "acoso",
    text: "Me escribió cosas feas",
    bottle_id: botella.id,
  });
});

Deno.test("Rechaza reportes con motivo inventado, texto inválido o botella inexistente", async () => {
  await limpiarBloqueos();
  const ana = await visitanteCompleto("Ana");
  const bea = await visitanteCompleto("Bea");

  assertEquals((await reportar({ publicId: bea.publicId, reason: "no-existe" }, ana.cookie)).status, 422);
  assertEquals((await reportar({ publicId: bea.publicId, reason: "spam", text: "a".repeat(501) }, ana.cookie)).status, 422);
  assertEquals((await reportar({ publicId: bea.publicId, reason: "spam", text: "Hola\u202Emundo" }, ana.cookie)).status, 422);
  assertEquals((await reportar({ publicId: bea.publicId, reason: "spam", bottleId: 999999 }, ana.cookie)).status, 422);
});

Deno.test("Reportar no bloquea", async () => {
  await limpiarBloqueos();
  const { cookieAutora, cookieLectora, vista } = await prepararConversacion();
  await enviarMensaje(vista.id, "Hola desde el mar", cookieLectora);
  const autora = (await (await app.request("/api/profile", { headers: { cookie: cookieAutora } })).json()).data;

  await reportar({ publicId: autora.publicId, reason: "spam" }, cookieLectora);

  assertEquals((await leerMensajes(vista.id, cookieLectora)).status, 200);
  const filas = await db.execute("select count(*)::int as total from blocks");
  assertEquals(filas.rows[0], { total: 0 });
});

Deno.test("Más de diez reportes al día responden 429", async () => {
  await limpiarBloqueos();
  resetReportLimit();
  const ana = await visitanteCompleto("Ana");
  const bea = await visitanteCompleto("Bea");

  for (let i = 0; i < 10; i++) {
    assertEquals((await reportar({ publicId: bea.publicId, reason: "spam" }, ana.cookie)).status, 201);
  }

  assertEquals((await reportar({ publicId: bea.publicId, reason: "spam" }, ana.cookie)).status, 429);
  resetReportLimit();
});

Deno.test("Bloquear funciona con identidad de cuenta", async () => {
  await limpiarBloqueos();
  await limpiarCuentas();
  const bea = await visitanteCompleto("Bea");
  const alta = await registrar(correo(), "contraseña-larga");
  const token = await tokenDe(alta);

  await app.request("/api/profile", {
    method: "PUT",
    headers: { "content-type": "application/json", ...conToken(token) },
    body: JSON.stringify({ alias: "Cuenta" }),
  });

  const res = await app.request("/api/blocks", {
    method: "POST",
    headers: { "content-type": "application/json", ...conToken(token) },
    body: JSON.stringify({ publicId: bea.publicId }),
  });
  assertEquals(res.status, 201);
});

// ------------------------------------------------------------------------- 7
const UPLOADS_TEST = "./data/test-uploads";

const png = (extra = 0) => {
  // firma + IHDR (13 bytes) + IEND: estructura mínima que acepta la API
  const bytes = new Uint8Array(45 + extra);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  bytes.set([0, 0, 0, 0], bytes.length - 12);
  bytes.set([0x49, 0x45, 0x4e, 0x44], bytes.length - 8);
  return bytes;
};

const jpeg = (extra = 0) => {
  const bytes = new Uint8Array(5 + extra);
  bytes.set([0xff, 0xd8, 0xff], 0);
  bytes[bytes.length - 2] = 0xff;
  bytes[bytes.length - 1] = 0xd9;
  return bytes;
};

const webp = (extra = 4) => {
  const total = 20 + extra;
  const bytes = new Uint8Array(total);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  new DataView(bytes.buffer).setUint32(4, total - 8, true);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x20], 12);
  return bytes;
};

const subirFoto = (bytes: Uint8Array, tipo: string, cookie: string) => {
  const form = new FormData();
  form.append("photo", new File([bytes as unknown as BlobPart], "foto.bin", { type: tipo }));
  return app.request("/api/profile/photos", { method: "POST", headers: { cookie }, body: form });
};

const limpiarFotos = async () => {
  await db.execute("delete from photos");
  try {
    for await (const entrada of Deno.readDir(UPLOADS_TEST)) {
      await Deno.remove(`${UPLOADS_TEST}/${entrada.name}`);
    }
  } catch {
    // el directorio aún no existe
  }
  resetUploadLimit();
};

const archivosSubidos = async () => {
  const nombres: string[] = [];
  try {
    for await (const entrada of Deno.readDir(UPLOADS_TEST)) nombres.push(entrada.name);
  } catch {
    // sin directorio
  }
  return nombres;
};

Deno.test("Subir una foto la guarda y se sirve con su tipo real", async () => {
  await limpiarFotos();
  const cookie = await crearVisita("Ana");
  const bytes = png(32);

  const res = await subirFoto(bytes, "image/png", cookie);
  assertEquals(res.status, 201);
  const { data } = await res.json();

  const foto = await app.request(`/api/photos/${data.id}`);
  assertEquals(foto.status, 200);
  assertEquals(foto.headers.get("content-type"), "image/png");
  assertEquals(foto.headers.get("x-content-type-options"), "nosniff");
  assertEquals(new Uint8Array(await foto.arrayBuffer()), bytes);

  const nombres = await archivosSubidos();
  assertEquals(nombres.length, 1);
  assertEquals(nombres[0].includes("foto.bin"), false);
  assertMatch(nombres[0], /^[0-9a-f-]{36}\.png$/);
});

Deno.test("El tipo sale de los bytes, no del Content-Type", async () => {
  await limpiarFotos();
  const cookie = await crearVisita("Ana");

  const disfrazado = await subirFoto(new TextEncoder().encode("<html>hola</html>"), "image/png", cookie);
  assertEquals(disfrazado.status, 422);

  const sinTipo = await subirFoto(png(16), "text/plain", cookie);
  assertEquals(sinTipo.status, 201);
  const { data } = await sinTipo.json();
  const foto = await app.request(`/api/photos/${data.id}`);
  assertEquals(foto.headers.get("content-type"), "image/png");
});

Deno.test("Rechaza firmas incompletas o mal formadas", async () => {
  await limpiarFotos();
  const cookie = await crearVisita("Ana");

  assertEquals((await subirFoto(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/png", cookie)).status, 422);
  assertEquals((await subirFoto(new Uint8Array([0xff, 0xd8]), "image/jpeg", cookie)).status, 422);

  const riffMalo = new Uint8Array(12);
  riffMalo.set([0x52, 0x49, 0x46, 0x46, 0xff, 0xff, 0xff, 0xff, 0x57, 0x45, 0x42, 0x50]);
  assertEquals((await subirFoto(riffMalo, "image/webp", cookie)).status, 422);
});

Deno.test("Acepta 5 MB y rechaza 5 MB más uno", async () => {
  await limpiarFotos();
  const cookie = await crearVisita("Ana");

  const grande = png(5 * 1024 * 1024 - 45);
  assertEquals((await subirFoto(grande, "image/png", cookie)).status, 201);

  const demasiado = png(5 * 1024 * 1024 - 44);
  assertEquals((await subirFoto(demasiado, "image/png", cookie)).status, 413);
});

Deno.test("Dos subidas simultáneas en el límite de 6 respetan el tope", async () => {
  await limpiarFotos();
  const cookie = await crearVisita("Ana");
  for (let i = 0; i < 5; i++) await subirFoto(jpeg(), "image/jpeg", cookie);

  const [a, b] = await Promise.all([
    subirFoto(jpeg(), "image/jpeg", cookie),
    subirFoto(jpeg(), "image/jpeg", cookie),
  ]);

  assertEquals([a.status, b.status].sort(), [201, 409]);
  const filas = await db.execute("select count(*)::int as total from photos");
  assertEquals(filas.rows[0], { total: 6 });
  assertEquals((await archivosSubidos()).length, 6);
});

Deno.test("Borrar mi foto quita la fila, el archivo y responde 404 después", async () => {
  await limpiarFotos();
  const cookie = await crearVisita("Ana");
  const { data } = await (await subirFoto(png(8), "image/png", cookie)).json();

  assertEquals((await app.request(`/api/profile/photos/${data.id}`, { method: "DELETE", headers: { cookie } })).status, 204);
  assertEquals((await app.request(`/api/photos/${data.id}`)).status, 404);
  assertEquals((await archivosSubidos()).length, 0);
  assertEquals((await app.request(`/api/profile/photos/${data.id}`, { method: "DELETE", headers: { cookie } })).status, 404);
});

Deno.test("No puedo borrar la foto de otra persona", async () => {
  await limpiarFotos();
  const ana = await crearVisita("Ana");
  const bea = await crearVisita("Bea");
  const { data } = await (await subirFoto(png(8), "image/png", ana)).json();

  assertEquals((await app.request(`/api/profile/photos/${data.id}`, { method: "DELETE", headers: { cookie: bea } })).status, 404);
});

Deno.test("La bio se guarda, se conserva, se vacía y se valida", async () => {
  await limpiarFotos();
  const cookie = await crearVisita("Ana");

  const conBio = await app.request("/api/profile", {
    method: "PUT",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ alias: "Ana", bio: "Me gusta el mar" }),
  });
  assertEquals(conBio.status, 200);
  assertEquals((await (await app.request("/api/profile", { headers: { cookie } })).json()).data.bio, "Me gusta el mar");

  await ponerPerfil("Ana", cookie);
  assertEquals((await (await app.request("/api/profile", { headers: { cookie } })).json()).data.bio, "Me gusta el mar");

  const vacia = await app.request("/api/profile", {
    method: "PUT",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ alias: "Ana", bio: "" }),
  });
  assertEquals(vacia.status, 200);
  assertEquals((await (await app.request("/api/profile", { headers: { cookie } })).json()).data.bio, null);

  assertEquals((await ponerPerfilBio("Ana", "a".repeat(301), cookie)).status, 422);
  assertEquals((await ponerPerfilBio("Ana", "Hola\u202Emundo", cookie)).status, 422);
});

Deno.test("Mi perfil expone alias, publicId, bio y fotos ordenadas", async () => {
  await limpiarFotos();
  const cookie = await crearVisita("Ana");
  await subirFoto(png(8), "image/png", cookie);
  await subirFoto(jpeg(), "image/jpeg", cookie);

  const { data } = await (await app.request("/api/profile", { headers: { cookie } })).json();

  assertEquals(Object.keys(data).sort(), ["affinity", "alias", "bio", "photos", "publicId"]);
  assertEquals(data.photos.length, 2);
  assertEquals(Object.keys(data.photos[0]).sort(), ["id", "url"]);
});

Deno.test("Al recoger se ven bio y fotos; el mar y el resto no las exponen", async () => {
  await limpiarFotos();
  await db.execute("delete from bottles");
  const ana = await crearVisita("Ana");
  await app.request("/api/profile", {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: ana },
    body: JSON.stringify({ alias: "Ana", bio: "Mi bio" }),
  });
  await subirFoto(png(8), "image/png", ana);
  await lanzar({ text: "Botella con perfil" }, ana);

  const bea = await darVisitaConPerfil("Bea");
  const { data: vista } = await (await pedirDelMar(bea)).json();
  assertEquals("authorBio" in vista, false);

  const { data: recogida } = await (await recoger(vista.id, bea)).json();
  assertEquals(recogida.authorBio, "Mi bio");
  assertEquals(recogida.authorPhotos.length, 1);

  const mine = await (await app.request("/api/bottles/mine", { headers: { cookie: ana } })).json();
  assertEquals(Object.keys(mine.data[0]).sort(), ["createdAt", "id", "status", "text"]);
});

Deno.test("Subir exige perfil; con cuenta y alias funciona", async () => {
  await limpiarFotos();
  const sinPerfil = await pedirDelMar();
  const cookieSuelta = (sinPerfil.headers.get("set-cookie") ?? "").split(";")[0];
  assertEquals((await subirFoto(png(8), "image/png", cookieSuelta)).status, 403);

  const alta = await registrar(correo(), "contraseña-larga");
  const token = await tokenDe(alta);
  await app.request("/api/profile", {
    method: "PUT",
    headers: { "content-type": "application/json", ...conToken(token) },
    body: JSON.stringify({ alias: "Cuenta" }),
  });

  const form = new FormData();
  form.append("photo", new File([png(16) as unknown as BlobPart], "foto.png", { type: "image/png" }));
  const res = await app.request("/api/profile/photos", {
    method: "POST",
    headers: conToken(token),
    body: form,
  });
  assertEquals(res.status, 201);
});

Deno.test("Una foto se sirve aunque la petición traiga cookie de cuenta", async () => {
  await limpiarFotos();
  await limpiarCuentas();
  const alta = await registrar(correo(), "contraseña-larga");
  const token = await tokenDe(alta);
  await app.request("/api/profile", {
    method: "PUT",
    headers: { "content-type": "application/json", ...conToken(token) },
    body: JSON.stringify({ alias: "Cuenta" }),
  });

  const form = new FormData();
  form.append("photo", new File([png(16) as unknown as BlobPart], "foto.png", { type: "image/png" }));
  const { data } = await (await app.request("/api/profile/photos", { method: "POST", headers: conToken(token), body: form })).json();

  const cookie = cookieDe(alta);
  const foto = await app.request(`/api/photos/${data.id}`, { headers: { cookie } });
  assertEquals(foto.status, 200);
});

Deno.test("Más de diez subidas al día responden 429", async () => {
  await limpiarFotos();
  const cookie = await crearVisita("Ana");

  // El tope de 6 fotos puede devolver 409; lo que se prueba aquí es el límite diario.
  for (let i = 0; i < 10; i++) {
    const res = await subirFoto(jpeg(), "image/jpeg", cookie);
    assertEquals([201, 409].includes(res.status), true);
  }
  assertEquals((await subirFoto(jpeg(), "image/jpeg", cookie)).status, 429);
});

Deno.test("Ids de foto inválidos responden 404, nunca 500", async () => {
  await limpiarFotos();

  assertEquals((await app.request("/api/photos/1")).status, 404);
  assertEquals((await app.request("/api/photos/no-es-uuid")).status, 404);
  assertEquals((await app.request("/api/photos/00000000-0000-0000-0000-000000000000")).status, 404);
});

Deno.test("Los ids gigantes responden 404 o 422, nunca 500", async () => {
  const cookie = await crearVisita("Ana");
  const bea = await visitanteCompleto("Bea");

  assertEquals((await recoger(4_000_000_000, cookie)).status, 404);
  assertEquals((await app.request("/api/bottles/mine?before=2147483648", { headers: { cookie } })).status, 422);
  assertEquals(
    (await reportar({ publicId: bea.publicId, reason: "spam", bottleId: 2147483648 }, cookie)).status,
    422,
  );
});

Deno.test("Rechaza un JPEG de tres bytes y un PNG de ocho", async () => {
  await limpiarFotos();
  const cookie = await crearVisita("Ana");

  assertEquals((await subirFoto(new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg", cookie)).status, 422);
  assertEquals(
    (await subirFoto(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png", cookie)).status,
    422,
  );
});

Deno.test("Acepta un WebP con contenedor coherente", async () => {
  await limpiarFotos();
  const cookie = await crearVisita("Ana");

  const res = await subirFoto(webp(16), "image/webp", cookie);
  assertEquals(res.status, 201);

  const { data } = await res.json();
  const foto = await app.request(`/api/photos/${data.id}`);
  assertEquals(foto.headers.get("content-type"), "image/webp");
});

Deno.test("Un cuerpo de 7 MB se rechaza antes de autenticar", async () => {
  const form = new FormData();
  form.append("photo", new File([new Uint8Array(7 * 1024 * 1024) as unknown as BlobPart], "f.png", { type: "image/png" }));

  const res = await app.request("/api/profile/photos", { method: "POST", body: form });

  assertEquals(res.status, 413);
});

Deno.test("La cookie de una cuenta no puede subir ni borrar fotos", async () => {
  await limpiarCuentas();
  const alta = await registrar(correo(), "contraseña-larga");
  const cookie = cookieDe(alta);

  assertEquals((await subirFoto(png(8), "image/png", cookie)).status, 401);
  assertEquals(
    (await app.request("/api/profile/photos/00000000-0000-0000-0000-000000000000", {
      method: "DELETE",
      headers: { cookie },
    })).status,
    401,
  );
});

Deno.test("pick y mensajes exponen el publicId del otro", async () => {
  await limpiarFotos();
  await db.execute("delete from bottles");
  const ana = await visitanteCompleto("Ana");
  await lanzar({ text: "Botella con publicId" }, ana.cookie);

  const bea = await visitanteCompleto("Bea");
  const { data: vista } = await (await pedirDelMar(bea.cookie)).json();
  const { data: recogida } = await (await recoger(vista.id, bea.cookie)).json();
  assertEquals(recogida.authorPublicId, ana.publicId);

  const { data: mensaje } = await (await enviarMensaje(vista.id, "Hola", bea.cookie)).json();
  assertEquals(mensaje.publicId, bea.publicId);
});

// ------------------------------------------------------------------------ 10
const bandeja = (cookie: string) => app.request("/api/notifications", { headers: { cookie } });

const limpiarNotificaciones = () => db.execute("delete from notifications");
const leerNotif = (id: number, cookie: string) =>
  app.request(`/api/notifications/${id}/read`, { method: "POST", headers: { cookie } });
const leerTodas = (cookie: string) =>
  app.request("/api/notifications/read-all", { method: "POST", headers: { cookie } });

const deTipo = (data: { type: string; [k: string]: unknown }[], tipo: string) => data.filter((n) => n.type === tipo);

Deno.test("Recoger una botella notifica al autor y no al que recoge", async () => {
  await limpiarNotificaciones();
  await db.execute("delete from bottles");
  const ana = await visitanteCompleto("Ana");
  const bea = await visitanteCompleto("Bea");
  await lanzar({ text: "Botella que será recogida" }, ana.cookie);
  await lanzar({ text: "Segunda botella de Ana" }, ana.cookie);

  const { data: primera } = await (await pedirDelMar(bea.cookie)).json();
  const { data: segunda } = await (await pedirDelMar(bea.cookie)).json();
  assertEquals((await recoger(primera.id, bea.cookie)).status, 200);
  assertEquals((await recoger(segunda.id, bea.cookie)).status, 409);

  const { data: deAna } = await (await bandeja(ana.cookie)).json();
  assertEquals(deTipo(deAna, "botella_recogida").length, 1);

  const { data: deBea } = await (await bandeja(bea.cookie)).json();
  assertEquals(deBea.length, 0);
});

Deno.test("Un mensaje notifica al otro participante, nunca a quien escribe", async () => {
  await limpiarNotificaciones();
  const { cookieAutora, cookieLectora, vista } = await prepararConversacion();

  await enviarMensaje(vista.id, "Hola desde el mar", cookieLectora);
  const { data: deAutora } = await (await bandeja(cookieAutora)).json();
  assertEquals(deTipo(deAutora, "mensaje_nuevo").length, 1);

  const { data: deLectora } = await (await bandeja(cookieLectora)).json();
  assertEquals(deTipo(deLectora, "mensaje_nuevo").length, 0);

  await enviarMensaje(vista.id, "Hola Bea", cookieAutora);
  const { data: deLectoraDespues } = await (await bandeja(cookieLectora)).json();
  assertEquals(deTipo(deLectoraDespues, "mensaje_nuevo").length, 1);
});

Deno.test("La reserva caducada avisa una sola vez aunque otro la recoja antes", async () => {
  await limpiarNotificaciones();
  await db.execute("delete from bottles");
  const ana = await visitanteCompleto("Ana");
  const bea = await visitanteCompleto("Bea");
  await lanzar({ text: "Botella que caduca" }, ana.cookie);

  const { data: vista } = await (await pedirDelMar(bea.cookie)).json();
  assertEquals((await recoger(vista.id, bea.cookie)).status, 200);
  await db.execute("update reservations set expires_at = now() - interval '1 hour' where confirmed_at is null");

  const carla = await visitanteCompleto("Carla");
  await pedirDelMar(carla.cookie);
  assertEquals((await recoger(vista.id, carla.cookie)).status, 200);

  const { data: primera } = await (await bandeja(bea.cookie)).json();
  assertEquals(deTipo(primera, "reserva_caducada").length, 1);

  const { data: segunda } = await (await bandeja(bea.cookie)).json();
  assertEquals(deTipo(segunda, "reserva_caducada").length, 1);

  const reservas = await db.execute("select count(*)::int as total from reservations");
  assertEquals(reservas.rows[0], { total: 1 });
});

Deno.test("Dos lecturas simultáneas de la bandeja no duplican el aviso", async () => {
  await limpiarNotificaciones();
  await db.execute("delete from bottles");
  const ana = await visitanteCompleto("Ana");
  const bea = await visitanteCompleto("Bea");
  await lanzar({ text: "Botella para dos lecturas" }, ana.cookie);

  const { data: vista } = await (await pedirDelMar(bea.cookie)).json();
  await recoger(vista.id, bea.cookie);
  await db.execute("update reservations set expires_at = now() - interval '1 hour' where confirmed_at is null");

  const [a, b] = await Promise.all([bandeja(bea.cookie), bandeja(bea.cookie)]);
  assertEquals(a.status, 200);
  assertEquals(b.status, 200);

  const { data } = await (await bandeja(bea.cookie)).json();
  assertEquals(deTipo(data, "reserva_caducada").length, 1);
});

Deno.test("La bandeja devuelve claves exactas, orden y contador", async () => {
  await limpiarNotificaciones();
  const { cookieAutora, cookieLectora, vista } = await prepararConversacion();
  await enviarMensaje(vista.id, "Hola desde el mar", cookieLectora);

  const cuerpo = await (await bandeja(cookieAutora)).json();

  assertEquals(Object.keys(cuerpo).sort(), ["data", "unread"]);
  assertEquals(typeof cuerpo.unread, "number");
  assertEquals(cuerpo.data.length >= 1, true);
  assertEquals(Object.keys(cuerpo.data[0]).sort(), ["bottleId", "conversationId", "createdAt", "id", "read", "type"]);
  assertEquals(typeof cuerpo.data[0].read, "boolean");
  assertEquals(cuerpo.data[0].id > cuerpo.data[1].id, true);
});

Deno.test("Marcar leída baja el contador; una ajena responde 404", async () => {
  await limpiarNotificaciones();
  const { cookieAutora, cookieLectora, vista } = await prepararConversacion();
  await enviarMensaje(vista.id, "Hola desde el mar", cookieLectora);

  const { data, unread } = await (await bandeja(cookieAutora)).json();
  assertEquals(unread, 2); // recogida + mensaje

  assertEquals((await leerNotif(data[0].id, cookieAutora)).status, 204);
  assertEquals((await (await bandeja(cookieAutora)).json()).unread, unread - 1);
  assertEquals((await leerNotif(data[0].id, cookieAutora)).status, 204);

  const bea = (await (await app.request("/api/profile", { headers: { cookie: cookieLectora } })).json()).data;
  assertEquals((await leerNotif(data[0].id, cookieLectora)).status, 404);
  assertEquals(typeof bea.publicId, "string");
});

Deno.test("read-all deja todo leído y es idempotente", async () => {
  await limpiarNotificaciones();
  const { cookieAutora, cookieLectora, vista } = await prepararConversacion();
  await enviarMensaje(vista.id, "Uno", cookieLectora);
  await enviarMensaje(vista.id, "Dos", cookieLectora);

  assertEquals((await leerTodas(cookieAutora)).status, 204);
  assertEquals((await (await bandeja(cookieAutora)).json()).unread, 0);
  assertEquals((await leerTodas(cookieAutora)).status, 204);
});

Deno.test("Solo se conservan las 50 notificaciones más recientes por visitante", async () => {
  await limpiarNotificaciones();
  const { cookieAutora, cookieLectora, vista } = await prepararConversacion();

  for (let i = 0; i < 55; i++) await enviarMensaje(vista.id, `Mensaje ${i}`, cookieLectora);

  const { data, unread } = await (await bandeja(cookieAutora)).json();
  assertEquals(data.length, 50);
  assertEquals(data[0].id > data[49].id, true);
  assertEquals(unread <= 50, true);

  const carla = await visitanteCompleto("Carla");
  await limpiarNotificaciones();
});

Deno.test("Sin identidad no hay bandeja y no se reparte cookie", async () => {
  const res = await app.request("/api/notifications");

  assertEquals(res.status, 401);
  assertEquals(res.headers.get("set-cookie"), null);
});

Deno.test("Ids de notificación inválidos responden 404", async () => {
  const cookie = await crearVisita("Ana");

  for (const id of ["abc", "0", "1.5", "4000000000"]) {
    assertEquals((await leerNotif(Number(id) || 0, cookie)).status, 404);
  }
  assertEquals((await app.request("/api/notifications/abc/read", { method: "POST", headers: { cookie } })).status, 404);
});

Deno.test("Destruir la botella deja la notificación con bottleId nulo", async () => {
  await limpiarNotificaciones();
  await db.execute("delete from bottles");
  const ana = await visitanteCompleto("Ana");
  const bea = await visitanteCompleto("Bea");
  await lanzar({ text: "Botella que se destruye" }, ana.cookie);

  const { data: vista } = await (await pedirDelMar(bea.cookie)).json();
  await recoger(vista.id, bea.cookie);
  assertEquals((await descartar(vista.id, "destroy", bea.cookie)).status, 200);

  const { data } = await (await bandeja(ana.cookie)).json();
  assertEquals(data[0].type, "botella_recogida");
  assertEquals(data[0].bottleId, null);
});

Deno.test("Bloqueados no generan notificaciones de mensajes ni de recogidas", async () => {
  await limpiarNotificaciones();
  await db.execute("delete from bottles");
  const ana = await visitanteCompleto("Ana");
  const bea = await visitanteCompleto("Bea");
  await lanzar({ text: "Botella bloqueada" }, ana.cookie);

  const { data: vista } = await (await pedirDelMar(bea.cookie)).json();
  await bloquear(bea.publicId, ana.cookie);

  assertEquals((await recoger(vista.id, bea.cookie)).status, 403);

  const { data } = await (await bandeja(ana.cookie)).json();
  assertEquals(data.length, 0);
});

// ------------------------------------------------------------------------ 11
const RESPUESTAS_A = {
  plan_ideal: "cena",
  finde: "playa",
  conversacion: "humor",
  ritmo: "tranquilo",
  comida: "cocinar",
  viaje: "mochila",
};

const RESPUESTAS_B = {
  plan_ideal: "cine",
  finde: "montana",
  conversacion: "memes",
  ritmo: "intenso",
  comida: "salir",
  viaje: "hotel",
};

const ponerAfinidad = (cookie: string, answers: Record<string, string>) =>
  app.request("/api/affinity", {
    method: "PUT",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ answers }),
  });

const afinidadDe = async (cookie: string) =>
  (await (await app.request("/api/profile", { headers: { cookie } })).json()).data.affinity.answers;

Deno.test("Las preguntas de afinidad son públicas y fijas", async () => {
  const res = await app.request("/api/affinity/questions");

  assertEquals(res.status, 200);
  assertEquals(res.headers.get("set-cookie"), null);
  const { data } = await res.json();
  assertEquals(data.length, 6);
  assertEquals(data.map((p: { id: string }) => p.id), [
    "plan_ideal",
    "finde",
    "conversacion",
    "ritmo",
    "comida",
    "viaje",
  ]);
  assertEquals(Object.keys(data[0]).sort(), ["id", "options", "text"]);
});

Deno.test("Guardar y leer mis respuestas", async () => {
  const cookie = await crearVisita("Ana");

  const res = await ponerAfinidad(cookie, RESPUESTAS_A);
  assertEquals(res.status, 200);
  assertEquals((await res.json()).data.answers, RESPUESTAS_A);
  assertEquals(await afinidadDe(cookie), RESPUESTAS_A);
});

Deno.test("Rechaza respuestas inválidas y sin perfil", async () => {
  const cookie = await crearVisita("Ana");

  assertEquals((await ponerAfinidad(cookie, { inventada: "cena" })).status, 422);
  assertEquals((await ponerAfinidad(cookie, { plan_ideal: "inventada" })).status, 422);
  assertEquals(
    (await app.request("/api/affinity", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ answers: { plan_ideal: 3 } }),
    })).status,
    422,
  );

  const sinPerfil = await app.request("/api/affinity", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers: RESPUESTAS_A }),
  });
  assertEquals(sinPerfil.status, 403);
  assertEquals(sinPerfil.headers.get("set-cookie"), null);
});

Deno.test("PUT reemplaza las respuestas anteriores", async () => {
  const cookie = await crearVisita("Ana");
  await ponerAfinidad(cookie, RESPUESTAS_A);

  await ponerAfinidad(cookie, { plan_ideal: "cine", finde: "ciudad" });
  assertEquals(await afinidadDe(cookie), { plan_ideal: "cine", finde: "ciudad" });

  const visitorId = cookie.split("=")[1];
  const filas = await db.execute(
    sql`select count(*)::int as total from affinity_answers where visitor_id = ${visitorId}`,
  );
  assertEquals(filas.rows[0], { total: 2 });

  await ponerAfinidad(cookie, {});
  assertEquals(await afinidadDe(cookie), {});
});

const porcentajeDe = async (lector: string, autor: string) => {
  await db.execute("delete from bottles");
  await lanzar({ text: "Botella con afinidad" }, autor);
  const { data: vista } = await (await pedirDelMar(lector)).json();
  const { data } = await (await recoger(vista.id, lector)).json();
  return data.authorAffinity;
};

Deno.test("Afinidad 100%, 0% y null sin suficientes preguntas en común", async () => {
  const ana = await crearVisita("Ana");
  const bea = await crearVisita("Bea");
  await ponerAfinidad(ana, RESPUESTAS_A);
  await ponerAfinidad(bea, RESPUESTAS_A);
  assertEquals((await porcentajeDe(bea, ana)).percentage, 100);

  const carla = await crearVisita("Carla");
  await ponerAfinidad(carla, RESPUESTAS_B);
  assertEquals((await porcentajeDe(carla, ana)).percentage, 0);

  const dani = await crearVisita("Dani");
  await ponerAfinidad(dani, { plan_ideal: "cine" });
  const parcial = await porcentajeDe(dani, ana);
  assertEquals(parcial.percentage, null);
});

Deno.test("La afinidad es simétrica", async () => {
  await limpiarNotificaciones();
  const ana = await crearVisita("Ana");
  const bea = await crearVisita("Bea");
  await ponerAfinidad(ana, RESPUESTAS_A);
  await ponerAfinidad(bea, { ...RESPUESTAS_A, plan_ideal: "cine" });

  const desdeBea = await porcentajeDe(bea, ana);
  const desdeAna = await porcentajeDe(ana, bea);

  assertEquals(desdeBea.percentage, desdeAna.percentage);
});

Deno.test("Sin respuestas del autor, el porcentaje es null y las respuestas vacías", async () => {
  const ana = await crearVisita("Ana");
  const bea = await crearVisita("Bea");

  const afinidad = await porcentajeDe(bea, ana);
  assertEquals(afinidad, { percentage: null, answers: {} });
});

Deno.test("El mar prioriza la botella de mayor afinidad", async () => {
  await db.execute("delete from bottles");
  const lectora = await crearVisita("Lectora");
  const alta = await crearVisita("Alta");
  const baja = await crearVisita("Baja");

  await ponerAfinidad(lectora, RESPUESTAS_A);
  await ponerAfinidad(alta, RESPUESTAS_A);
  await ponerAfinidad(baja, RESPUESTAS_B);

  await lanzar({ text: "Botella de alta afinidad" }, alta);
  await lanzar({ text: "Botella de baja afinidad" }, baja);

  const { data } = await (await pedirDelMar(lectora)).json();
  assertEquals(data.text, "Botella de alta afinidad");
});

Deno.test("Sin respuestas el mar sigue funcionando y es anónimo", async () => {
  await db.execute("delete from bottles");
  const lectora = await crearVisita("Lectora");
  const autora = await crearVisita("Autora");
  await lanzar({ text: "Botella sin afinidad" }, autora);

  const { data } = await (await pedirDelMar(lectora)).json();
  assertEquals(data.text, "Botella sin afinidad");
  assertEquals(Object.keys(data).sort(), ["id", "text"]);
});

Deno.test("Un bloqueado ni aparece ni revela sus respuestas", async () => {
  await limpiarBloqueos();
  await db.execute("delete from bottles");
  const ana = await visitanteCompleto("Ana");
  const bea = await visitanteCompleto("Bea");
  await ponerAfinidad(ana.cookie, RESPUESTAS_A);
  await ponerAfinidad(bea.cookie, RESPUESTAS_A);
  await lanzar({ text: "Botella que no veré", }, ana.cookie);

  const { data: vista } = await (await pedirDelMar(bea.cookie)).json();
  await bloquear(bea.publicId, ana.cookie);

  assertEquals((await recoger(vista.id, bea.cookie)).status, 403);
  assertEquals((await (await pedirDelMar(bea.cookie)).json()).data, null);
});

Deno.test("Una respuesta con pregunta obsoleta se ignora", async () => {
  const cookie = await crearVisita("Ana");
  const visitorId = cookie.split("=")[1];
  await ponerAfinidad(cookie, RESPUESTAS_A);

  await db.execute(
    sql`insert into affinity_answers (visitor_id, question, option) values (${visitorId}, 'vieja', 'lo_que_sea')`,
  );

  const respuestas = await afinidadDe(cookie);
  assertEquals("vieja" in respuestas, false);
  assertEquals(Object.keys(respuestas).length, 6);
});

Deno.test("La afinidad solo se expone en perfil y pick", async () => {
  await limpiarNotificaciones();
  const { cookieLectora, vista } = await prepararConversacion();
  await ponerAfinidad(cookieLectora, RESPUESTAS_A);

  const mar = await (await pedirDelMar()).json();
  if (mar.data) assertEquals("authorAffinity" in mar.data, false);

  const mine = await (await app.request("/api/bottles/mine", { headers: { cookie: cookieLectora } })).json();
  assertEquals(mine.data.length, 0);
  assertEquals((await (await app.request("/api/notifications", { headers: { cookie: cookieLectora } })).json()).data.every((n: object) => !("affinity" in n)), true);
  assertEquals(vista.id > 0, true);
});

// ------------------------------------------------------------------------ 12
const mazo = (cookie: string) => app.request("/api/deck", { headers: { cookie } });

const deslizar = (publicId: string, action: string, cookie: string) =>
  app.request("/api/swipes", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ publicId, action }),
  });

const misMatches = (cookie: string) => app.request("/api/matches", { headers: { cookie } });

const escribirEnConversacion = (id: number, text: unknown, cookie: string) =>
  app.request(`/api/conversations/${id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ text }),
  });

const leerConversacion = (id: number, cookie: string, query = "") =>
  app.request(`/api/conversations/${id}/messages${query}`, { headers: { cookie } });

const limpiarSwipes = async () => {
  await db.execute("delete from swipes");
  await db.execute("delete from conversations where bottle_id is null");
  await db.execute("delete from notifications where type = 'match_nuevo'");
};

Deno.test("El mazo muestra un perfil con claves exactas y sin UUID de visitante", async () => {
  await limpiarSwipes();
  const lectora = await visitanteCompleto("Lectora");
  const objetivo = await visitanteCompleto("Objetivo");
  await ponerPerfilBio("Objetivo", "Mi bio para el mazo", objetivo.cookie);

  await db.execute(sql`
    insert into swipes (visitor_id, target_visitor, action)
    select ${lectora.visitorId}, visitor_id, 'discard' from profiles
    where visitor_id not in (${lectora.visitorId}, ${objetivo.visitorId})
    on conflict do nothing
  `);

  const { data } = await (await mazo(lectora.cookie)).json();

  assertEquals(Object.keys(data).sort(), ["affinity", "alias", "bio", "photos", "publicId"]);
  assertEquals(Object.keys(data.affinity), ["percentage"]);
  assertEquals("visitorId" in data, false);
  assertEquals(data.publicId, objetivo.publicId);
});

Deno.test("El mazo exige perfil y no reparte cookie", async () => {
  const sinPerfil = await pedirDelMar();
  const cookieSuelta = (sinPerfil.headers.get("set-cookie") ?? "").split(";")[0];

  const res = await mazo(cookieSuelta);

  assertEquals(res.status, 403);
  assertEquals(res.headers.get("set-cookie"), null);
});

Deno.test("El mazo excluye a los ya deslizados y a los bloqueados", async () => {
  await limpiarSwipes();
  const lectora = await visitanteCompleto("Lectora");
  const descartado = await visitanteCompleto("Descartado");
  const bloqueado = await visitanteCompleto("Bloqueado");

  await deslizar(descartado.publicId, "discard", lectora.cookie);
  await bloquear(bloqueado.publicId, lectora.cookie);

  await db.execute(sql`
    insert into swipes (visitor_id, target_visitor, action)
    select ${lectora.visitorId}, visitor_id, 'discard' from profiles
    where visitor_id not in (${lectora.visitorId}, ${descartado.visitorId}, ${bloqueado.visitorId})
    on conflict do nothing
  `);

  const { data } = await (await mazo(lectora.cookie)).json();
  assertEquals(data, null);
});

Deno.test("El mazo prioriza mayor afinidad", async () => {
  await limpiarSwipes();
  const lectora = await visitanteCompleto("Lectora");
  const alta = await visitanteCompleto("Alta");
  const baja = await visitanteCompleto("Baja");

  await ponerAfinidad(lectora.cookie, RESPUESTAS_A);
  await ponerAfinidad(alta.cookie, RESPUESTAS_A);
  await ponerAfinidad(baja.cookie, RESPUESTAS_B);

  // Descartar el resto del vecindario para que solo queden Alta y Baja.
  await db.execute(sql`
    insert into swipes (visitor_id, target_visitor, action)
    select ${lectora.visitorId}, visitor_id, 'discard' from profiles
    where visitor_id not in (${lectora.visitorId}, ${alta.visitorId}, ${baja.visitorId})
    on conflict do nothing
  `);

  const { data } = await (await mazo(lectora.cookie)).json();
  assertEquals(data.publicId, alta.publicId);
});

Deno.test("Descartar es para siempre y repetirlo responde 409", async () => {
  await limpiarSwipes();
  const lectora = await visitanteCompleto("Lectora");
  const objetivo = await visitanteCompleto("Objetivo");

  assertEquals((await deslizar(objetivo.publicId, "discard", lectora.cookie)).status, 201);
  assertEquals((await deslizar(objetivo.publicId, "discard", lectora.cookie)).status, 409);

  const { data } = await (await mazo(lectora.cookie)).json();
  if (data) assertEquals(data.publicId === objetivo.publicId, false);
});

Deno.test("Un like sin reciprocidad no crea match ni conversación", async () => {
  await limpiarSwipes();
  const ana = await visitanteCompleto("Ana");
  const bea = await visitanteCompleto("Bea");

  const res = await deslizar(bea.publicId, "like", ana.cookie);
  assertEquals(res.status, 201);
  assertEquals((await res.json()).data, { match: false });

  assertEquals((await (await misMatches(ana.cookie)).json()).data.length, 0);
  const convs = await db.execute("select count(*)::int as total from conversations where bottle_id is null");
  assertEquals(convs.rows[0], { total: 0 });
});

Deno.test("El like mutuo crea un único match, avisa a ambos y aparece en los dos", async () => {
  await limpiarSwipes();
  const ana = await visitanteCompleto("Ana");
  const bea = await visitanteCompleto("Bea");

  assertEquals((await (await deslizar(bea.publicId, "like", ana.cookie)).json()).data.match, false);
  const mutuo = await deslizar(ana.publicId, "like", bea.cookie);
  const { data } = await mutuo.json();

  assertEquals(mutuo.status, 201);
  assertEquals(data.match, true);
  assertEquals(typeof data.conversationId, "number");

  const convs = await db.execute("select count(*)::int as total from conversations where bottle_id is null");
  assertEquals(convs.rows[0], { total: 1 });

  for (const cookie of [ana.cookie, bea.cookie]) {
    const { data: notifs } = await (await bandeja(cookie)).json();
    assertEquals(deTipo(notifs, "match_nuevo").length, 1);
    assertEquals(deTipo(notifs, "match_nuevo")[0].conversationId as number, data.conversationId);
    const { data: matches } = await (await misMatches(cookie)).json();
    assertEquals(matches.length, 1);
  }
});

Deno.test("Likes mutuos simultáneos dejan una sola conversación", async () => {
  await limpiarSwipes();
  const ana = await visitanteCompleto("Ana");
  const bea = await visitanteCompleto("Bea");

  await Promise.all([
    deslizar(bea.publicId, "like", ana.cookie),
    deslizar(ana.publicId, "like", bea.cookie),
  ]);

  const convs = await db.execute("select count(*)::int as total from conversations where bottle_id is null");
  assertEquals(convs.rows[0], { total: 1 });

  const notifs = await db.execute("select count(*)::int as total from notifications where type = 'match_nuevo'");
  assertEquals(notifs.rows[0], { total: 2 });
});

Deno.test("Repetir el like tras el match devuelve el mismo conversationId", async () => {
  await limpiarSwipes();
  const ana = await visitanteCompleto("Ana");
  const bea = await visitanteCompleto("Bea");
  await deslizar(bea.publicId, "like", ana.cookie);
  const { data: primera } = await (await deslizar(ana.publicId, "like", bea.cookie)).json();

  const repetida = await deslizar(ana.publicId, "like", bea.cookie);
  assertEquals(repetida.status, 200);
  assertEquals((await repetida.json()).data.conversationId, primera.conversationId);

  const notifs = await db.execute("select count(*)::int as total from notifications where type = 'match_nuevo'");
  assertEquals(notifs.rows[0], { total: 2 });
});

Deno.test("El chat de match funciona en ambos sentidos y un tercero no entra", async () => {
  await limpiarSwipes();
  const ana = await visitanteCompleto("Ana");
  const bea = await visitanteCompleto("Bea");
  await deslizar(bea.publicId, "like", ana.cookie);
  const { data } = await (await deslizar(ana.publicId, "like", bea.cookie)).json();

  const primero = await escribirEnConversacion(data.conversationId, "Hola Ana", bea.cookie);
  assertEquals(primero.status, 201);

  const segundo = await escribirEnConversacion(data.conversationId, "Hola Bea", ana.cookie);
  assertEquals(segundo.status, 201);

  const { data: mensajes } = await (await leerConversacion(data.conversationId, bea.cookie)).json();
  assertEquals(mensajes.length, 2);
  assertEquals(mensajes[0].alias, "Bea");
  assertEquals(mensajes[0].mine, true);
  assertEquals(mensajes[1].alias, "Ana");
  assertEquals(typeof mensajes[0].publicId, "string");

  const carla = await visitanteCompleto("Carla");
  assertEquals((await leerConversacion(data.conversationId, carla.cookie)).status, 403);
  assertEquals((await escribirEnConversacion(data.conversationId, "Me cuelo", carla.cookie)).status, 403);
});

Deno.test("Bloquear tras el match corta el chat y lo oculta", async () => {
  await limpiarSwipes();
  const ana = await visitanteCompleto("Ana");
  const bea = await visitanteCompleto("Bea");
  await deslizar(bea.publicId, "like", ana.cookie);
  const { data } = await (await deslizar(ana.publicId, "like", bea.cookie)).json();

  await bloquear(bea.publicId, ana.cookie);

  assertEquals((await leerConversacion(data.conversationId, bea.cookie)).status, 403);
  assertEquals((await (await misMatches(ana.cookie)).json()).data.length, 0);
});

Deno.test("Validación de mensajes en el chat de match", async () => {
  await limpiarSwipes();
  const ana = await visitanteCompleto("Ana");
  const bea = await visitanteCompleto("Bea");
  await deslizar(bea.publicId, "like", ana.cookie);
  const { data } = await (await deslizar(ana.publicId, "like", bea.cookie)).json();

  assertEquals((await escribirEnConversacion(data.conversationId, "", bea.cookie)).status, 422);
  assertEquals((await escribirEnConversacion(data.conversationId, "a".repeat(501), bea.cookie)).status, 422);
  assertEquals((await escribirEnConversacion(data.conversationId, "Hola\u202Emundo", bea.cookie)).status, 422);
});

Deno.test("Swipes inválidos y conversaciones ajenas o de botella", async () => {
  await limpiarSwipes();
  const ana = await visitanteCompleto("Ana");
  const bea = await visitanteCompleto("Bea");

  assertEquals((await deslizar(ana.publicId, "like", ana.cookie)).status, 422);
  assertEquals((await deslizar(crypto.randomUUID(), "like", ana.cookie)).status, 404);
  assertEquals((await deslizar(bea.publicId, "arrastra", ana.cookie)).status, 422);

  assertEquals((await leerConversacion(999999, ana.cookie)).status, 404);
  assertEquals((await leerConversacion(1, ana.cookie)).status, 404);
});

Deno.test("Una conversación de botella no se abre por /api/conversations", async () => {
  const { cookieAutora, cookieLectora, vista } = await prepararConversacion();
  await enviarMensaje(vista.id, "Hola desde la botella", cookieLectora);

  const filas = await db.execute(
    sql`select id from conversations where bottle_id = ${vista.id} limit 1`,
  );
  const conversacionId = (filas.rows[0] as { id: number }).id;

  assertEquals((await leerConversacion(conversacionId, cookieAutora)).status, 404);
});

// ------------------------------------------------------------------------ 13
const grupos = (cookie?: string) =>
  app.request("/api/groups", { headers: cookie ? { cookie } : {} });

const unirse = (grupo: string, cookie: string) =>
  app.request(`/api/groups/${grupo}/join`, { method: "POST", headers: { cookie } });

const salir = (grupo: string, cookie: string) =>
  app.request(`/api/groups/${grupo}/leave`, { method: "DELETE", headers: { cookie } });

const mensajesGrupo = (grupo: string, cookie: string, query = "") =>
  app.request(`/api/groups/${grupo}/messages${query}`, { headers: { cookie } });

const escribirGrupo = (grupo: string, text: unknown, cookie: string) =>
  app.request(`/api/groups/${grupo}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ text }),
  });

const limpiarGrupos = async () => {
  await db.execute("delete from group_messages");
  await db.execute("delete from group_members");
};

Deno.test("Los grupos son fijos, listables y con contadores", async () => {
  await limpiarGrupos();

  const res = await grupos();
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("set-cookie"), null);

  const { data } = await res.json();
  assertEquals(data.map((g: { id: string }) => g.id), [
    "musica",
    "cine",
    "viajes",
    "libros",
    "deporte",
    "cocina",
  ]);
  assertEquals(Object.keys(data[0]).sort(), ["description", "id", "joined", "members", "title"]);
  assertEquals(data[0].members, 0);
  assertEquals(data[0].joined, false);
});

Deno.test("La lista con cookie de cuenta responde 401", async () => {
  await limpiarCuentas();
  const alta = await registrar(correo(), "contraseña-larga");

  assertEquals((await grupos(cookieDe(alta))).status, 401);
});

Deno.test("Unirse exige perfil y es idempotente", async () => {
  await limpiarGrupos();
  const cookie = await crearVisita("Ana");

  const sinPerfil = await pedirDelMar();
  const cookieSuelta = (sinPerfil.headers.get("set-cookie") ?? "").split(";")[0];
  assertEquals((await unirse("musica", cookieSuelta)).status, 403);

  assertEquals((await unirse("musica", cookie)).status, 204);
  assertEquals((await unirse("musica", cookie)).status, 204);

  const filas = await db.execute("select count(*)::int as total from group_members");
  assertEquals(filas.rows[0], { total: 1 });
  assertEquals((await unirse("no-existe", cookie)).status, 404);
});

Deno.test("Dos uniones simultáneas dejan una sola fila", async () => {
  await limpiarGrupos();
  const cookie = await crearVisita("Ana");

  const [a, b] = await Promise.all([unirse("cine", cookie), unirse("cine", cookie)]);
  assertEquals([a.status, b.status], [204, 204]);

  const filas = await db.execute("select count(*)::int as total from group_members");
  assertEquals(filas.rows[0], { total: 1 });
});

Deno.test("Salir es idempotente y no borra el historial", async () => {
  await limpiarGrupos();
  const ana = await crearVisita("Ana");

  await unirse("viajes", ana);
  await escribirGrupo("viajes", "Mi primer mensaje", ana);

  assertEquals((await salir("viajes", ana)).status, 204);
  assertEquals((await salir("viajes", ana)).status, 204);
  assertEquals((await mensajesGrupo("viajes", ana)).status, 403);

  await unirse("viajes", ana);
  const { data } = await (await mensajesGrupo("viajes", ana)).json();
  assertEquals(data.length, 1);
  assertEquals(data[0].text, "Mi primer mensaje");
});

Deno.test("Sin membresía no se lee ni se escribe; sin identidad, 401", async () => {
  await limpiarGrupos();
  const cookie = await crearVisita("Ana");

  assertEquals((await mensajesGrupo("libros", cookie)).status, 403);
  assertEquals((await escribirGrupo("libros", "Hola", cookie)).status, 403);
  assertEquals((await mensajesGrupo("libros", "")).status, 401);
  assertEquals(
    (await app.request("/api/groups/libros/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Hola" }) })).status,
    401,
  );
});

Deno.test("Un miembro escribe y otro lee con alias, publicId y mine", async () => {
  await limpiarGrupos();
  const ana = await crearVisita("Ana");
  const bea = await crearVisita("Bea");
  await unirse("libros", ana);
  await unirse("libros", bea);

  const res = await escribirGrupo("libros", "Recomiendo este libro", ana);
  assertEquals(res.status, 201);
  const { data: creado } = await res.json();
  assertEquals(Object.keys(creado).sort(), ["alias", "createdAt", "id", "mine", "publicId", "text"]);
  assertEquals(creado.mine, true);

  const { data } = await (await mensajesGrupo("libros", bea)).json();
  assertEquals(data.length, 1);
  assertEquals(data[0].alias, "Ana");
  assertEquals(data[0].mine, false);
  assertEquals(typeof data[0].publicId, "string");
});

Deno.test("Validación de mensajes de grupo", async () => {
  await limpiarGrupos();
  const cookie = await crearVisita("Ana");
  await unirse("deporte", cookie);

  assertEquals((await escribirGrupo("deporte", "", cookie)).status, 422);
  assertEquals((await escribirGrupo("deporte", "a", cookie)).status, 201);
  assertEquals((await escribirGrupo("deporte", "b".repeat(500), cookie)).status, 201);
  assertEquals((await escribirGrupo("deporte", "c".repeat(501), cookie)).status, 422);
  assertEquals((await escribirGrupo("deporte", "Hola\u202Emundo", cookie)).status, 422);
  assertEquals(
    (await app.request("/api/groups/deporte/messages", { method: "POST", headers: { "content-type": "application/json", cookie }, body: "null" })).status,
    400,
  );
});

Deno.test("Los mensajes de grupo se paginan de 50 en 50", async () => {
  await limpiarGrupos();
  const cookie = await crearVisita("Ana");
  await unirse("cocina", cookie);

  for (let i = 1; i <= 55; i++) await escribirGrupo("cocina", `Mensaje ${i}`, cookie);

  const { data: ultimos } = await (await mensajesGrupo("cocina", cookie)).json();
  assertEquals(ultimos.length, 50);
  assertEquals(ultimos[49].text, "Mensaje 55");

  const { data: anteriores } = await (
    await mensajesGrupo("cocina", cookie, `?before=${ultimos[0].id}`)
  ).json();
  assertEquals(anteriores.length, 5);
  assertEquals(anteriores[4].text, "Mensaje 5");

  assertEquals((await mensajesGrupo("cocina", cookie, "?before=abc")).status, 422);
});

Deno.test("El bloqueo oculta mensajes en ambos sentidos, no al tercero", async () => {
  await limpiarGrupos();
  const ana = await visitanteCompleto("Ana");
  const bea = await visitanteCompleto("Bea");
  const carla = await visitanteCompleto("Carla");
  for (const v of [ana, bea, carla]) await unirse("musica", v.cookie);

  await escribirGrupo("musica", "Mensaje de Ana", ana.cookie);
  await escribirGrupo("musica", "Mensaje de Bea", bea.cookie);
  await escribirGrupo("musica", "Mensaje de Carla", carla.cookie);

  await bloquear(bea.publicId, ana.cookie);

  const { data: deAna } = await (await mensajesGrupo("musica", ana.cookie)).json();
  assertEquals(deAna.map((m: { text: string }) => m.text), ["Mensaje de Ana", "Mensaje de Carla"]);

  const { data: deBea } = await (await mensajesGrupo("musica", bea.cookie)).json();
  assertEquals(deBea.map((m: { text: string }) => m.text), ["Mensaje de Bea", "Mensaje de Carla"]);

  const { data: deCarla } = await (await mensajesGrupo("musica", carla.cookie)).json();
  assertEquals(deCarla.length, 3);
});

Deno.test("Grupo inexistente responde 404 en las cuatro rutas", async () => {
  const cookie = await crearVisita("Ana");

  assertEquals((await unirse("inventado", cookie)).status, 404);
  assertEquals((await salir("inventado", cookie)).status, 404);
  assertEquals((await mensajesGrupo("inventado", cookie)).status, 404);
  assertEquals((await escribirGrupo("inventado", "Hola", cookie)).status, 404);
});

Deno.test("El alias del mensaje queda congelado", async () => {
  await limpiarGrupos();
  const cookie = await crearVisita("Ana");
  await unirse("cine", cookie);
  await escribirGrupo("cine", "Mensaje con alias", cookie);

  await ponerPerfil("Bego", cookie);

  const { data } = await (await mensajesGrupo("cine", cookie)).json();
  assertEquals(data[0].alias, "Ana");
});

Deno.test("Los grupos no generan notificaciones", async () => {
  await limpiarGrupos();
  await limpiarNotificaciones();
  const cookie = await crearVisita("Ana");

  const antes = await db.execute("select count(*)::int as total from notifications");
  await unirse("viajes", cookie);
  await escribirGrupo("viajes", "Hola grupo", cookie);
  await salir("viajes", cookie);
  const despues = await db.execute("select count(*)::int as total from notifications");

  assertEquals(despues.rows[0], antes.rows[0]);
});

Deno.test("La membresía con Bearer sobrevive al login en otro dispositivo", async () => {
  await limpiarGrupos();
  await limpiarCuentas();
  const email = correo();
  const alta = await registrar(email, "contraseña-larga");
  const token = await tokenDe(alta);

  await app.request("/api/profile", {
    method: "PUT",
    headers: { "content-type": "application/json", ...conToken(token) },
    body: JSON.stringify({ alias: "Cuenta" }),
  });
  await app.request("/api/groups/libros/join", { method: "POST", headers: conToken(token) });

  const otroToken = await tokenDe(await entrar(email, "contraseña-larga"));
  const { data } = await (await app.request("/api/groups", { headers: conToken(otroToken) })).json();
  assertEquals(data.find((g: { id: string }) => g.id === "libros").joined, true);
});

// ------------------------------------------------------------------------ 14
const crearPlan = (body: unknown, cookie: string) =>
  app.request("/api/plans", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });

const listarPlanes = (query = "", cookie?: string) =>
  app.request(`/api/plans${query}`, { headers: cookie ? { cookie } : {} });

const verPlan = (id: number, cookie?: string) =>
  app.request(`/api/plans/${id}`, { headers: cookie ? { cookie } : {} });

const apuntarseAPlan = (id: number, cookie: string) =>
  app.request(`/api/plans/${id}/join`, { method: "POST", headers: { cookie } });

const salirDePlan = (id: number, cookie: string) =>
  app.request(`/api/plans/${id}/leave`, { method: "DELETE", headers: { cookie } });

const asistentesDePlan = (id: number, cookie: string) =>
  app.request(`/api/plans/${id}/attendees`, { headers: { cookie } });

const limpiarPlanes = () => db.execute("delete from plans");

const MADRID = { lat: 40.4168, lng: -3.7038 };
const BARCELONA = { lat: 41.3874, lng: 2.1686 };

const planValido = (extra: Record<string, unknown> = {}) => ({
  title: "Quedada de prueba",
  description: "Un plan cualquiera",
  place: "Parque del Retiro",
  lat: MADRID.lat,
  lng: MADRID.lng,
  startsAt: new Date(Date.now() + 86_400_000).toISOString(),
  capacity: 2,
  ...extra,
});

Deno.test("Crear un plan válido y verlo en el listado", async () => {
  await limpiarPlanes();
  const cookie = await crearVisita("Ana");

  const res = await crearPlan(planValido(), cookie);
  assertEquals(res.status, 201);
  const { data } = await res.json();
  assertEquals(typeof data.id, "number");

  const { data: lista } = await (await listarPlanes(`?lat=${MADRID.lat}&lng=${MADRID.lng}`, cookie)).json();
  assertEquals(lista.length, 1);
  assertEquals(Object.keys(lista[0]).sort(), [
    "capacity",
    "confirmed",
    "description",
    "distanceKm",
    "id",
    "isCreator",
    "myStatus",
    "place",
    "spotsLeft",
    "startsAt",
    "title",
  ]);
  assertEquals(lista[0].isCreator, true);
  assertEquals(lista[0].spotsLeft, 2);
});

Deno.test("Validación de planes", async () => {
  await limpiarPlanes();
  const cookie = await crearVisita("Ana");

  assertEquals((await crearPlan(planValido({ title: "ab" }), cookie)).status, 422);
  assertEquals((await crearPlan(planValido({ lat: 91 }), cookie)).status, 422);
  assertEquals((await crearPlan(planValido({ capacity: 0 }), cookie)).status, 422);
  assertEquals((await crearPlan(planValido({ capacity: 51 }), cookie)).status, 422);
  assertEquals((await crearPlan(planValido({ startsAt: "2020-01-01T10:00:00Z" }), cookie)).status, 422);
  assertEquals((await crearPlan(planValido({ startsAt: "mañana" }), cookie)).status, 422);
  assertEquals((await crearPlan(planValido({ title: "Hola\u202Emundo" }), cookie)).status, 422);

  const sinPerfil = await app.request("/api/plans", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(planValido()),
  });
  assertEquals(sinPerfil.status, 401);
});

Deno.test("El listado ordena por distancia y excluye los pasados", async () => {
  await limpiarPlanes();
  const cookie = await crearVisita("Ana");

  await crearPlan(planValido({ title: "Lejos en Barcelona", lat: BARCELONA.lat, lng: BARCELONA.lng }), cookie);
  await crearPlan(planValido({ title: "Cerca en Madrid" }), cookie);
  const pasado = await (await crearPlan(planValido({ title: "Ya pasó" }), cookie)).json();
  await db.execute(sql`update plans set starts_at = now() - interval '1 day' where id = ${pasado.data.id}`);

  const { data } = await (await listarPlanes(`?lat=${MADRID.lat}&lng=${MADRID.lng}&radius=200`, cookie)).json();
  assertEquals(data.map((p: { title: string }) => p.title), ["Cerca en Madrid"]);
});

Deno.test("La distancia es coherente", async () => {
  await limpiarPlanes();
  const cookie = await crearVisita("Ana");

  await crearPlan(planValido({ title: "Aquí mismo" }), cookie);
  await crearPlan(planValido({ title: "Un grado al norte", lat: 41.4168, lng: -3.7038 }), cookie);

  const { data } = await (await listarPlanes(`?lat=${MADRID.lat}&lng=${MADRID.lng}&radius=200`, cookie)).json();
  assertEquals(data[0].distanceKm < 0.01, true);
  assertEquals(Math.abs(data[1].distanceKm - 111.19) < 2, true);
});

Deno.test("Sin coordenadas se lista por fecha y sin radio", async () => {
  await limpiarPlanes();
  const cookie = await crearVisita("Ana");

  await crearPlan(planValido({ title: "Más tarde", startsAt: new Date(Date.now() + 172_800_000).toISOString() }), cookie);
  await crearPlan(planValido({ title: "Antes" }), cookie);

  const { data } = await (await listarPlanes("", cookie)).json();
  assertEquals(data.map((p: { title: string }) => p.title), ["Antes", "Más tarde"]);
  assertEquals(data[0].distanceKm, null);
  assertEquals((await listarPlanes("?lat=40", cookie)).status, 422);
  assertEquals((await listarPlanes("?radius=10", cookie)).status, 422);
  assertEquals((await listarPlanes("?lat=40&lng=-3&radius=500", cookie)).status, 422);
});

Deno.test("Apuntarse confirma mientras hay plazas", async () => {
  await limpiarPlanes();
  const ana = await crearVisita("Ana");
  const bea = await crearVisita("Bea");
  const { data: plan } = await (await crearPlan(planValido(), ana)).json();

  const res = await apuntarseAPlan(plan.id, bea);
  assertEquals(res.status, 200);
  assertEquals((await res.json()).data, { status: "confirmado" });

  const { data: detalle } = await (await verPlan(plan.id, bea)).json();
  assertEquals(detalle.confirmed, 1);
  assertEquals(detalle.spotsLeft, 1);
  assertEquals(detalle.myStatus, "confirmado");
  assertEquals(Object.keys(detalle.creator).sort(), ["alias", "publicId"]);
});

Deno.test("Con el aforo lleno se entra en espera", async () => {
  await limpiarPlanes();
  const ana = await crearVisita("Ana");
  const bea = await crearVisita("Bea");
  const carla = await crearVisita("Carla");
  const { data: plan } = await (await crearPlan(planValido({ capacity: 1 }), ana)).json();

  assertEquals((await (await apuntarseAPlan(plan.id, bea)).json()).data.status, "confirmado");
  assertEquals((await (await apuntarseAPlan(plan.id, carla)).json()).data.status, "espera");

  const { data: detalle } = await (await verPlan(plan.id, carla)).json();
  assertEquals(detalle.confirmed, 1);
  assertEquals(detalle.spotsLeft, 0);
  assertEquals(detalle.myStatus, "espera");
});

Deno.test("Salir confirmado asciende al primero de la espera", async () => {
  await limpiarPlanes();
  const ana = await crearVisita("Ana");
  const bea = await crearVisita("Bea");
  const carla = await crearVisita("Carla");
  const dani = await crearVisita("Dani");
  const { data: plan } = await (await crearPlan(planValido({ capacity: 1 }), ana)).json();

  await apuntarseAPlan(plan.id, bea);
  await apuntarseAPlan(plan.id, carla);
  await apuntarseAPlan(plan.id, dani);

  assertEquals((await salirDePlan(plan.id, bea)).status, 204);

  const { data: detalleCarla } = await (await verPlan(plan.id, carla)).json();
  const { data: detalleDani } = await (await verPlan(plan.id, dani)).json();
  assertEquals(detalleCarla.myStatus, "confirmado");
  assertEquals(detalleDani.myStatus, "espera");
});

Deno.test("Salir de la espera no promueve a nadie", async () => {
  await limpiarPlanes();
  const ana = await crearVisita("Ana");
  const bea = await crearVisita("Bea");
  const carla = await crearVisita("Carla");
  const dani = await crearVisita("Dani");
  const { data: plan } = await (await crearPlan(planValido({ capacity: 1 }), ana)).json();

  await apuntarseAPlan(plan.id, bea);
  await apuntarseAPlan(plan.id, carla);
  await apuntarseAPlan(plan.id, dani);
  await salirDePlan(plan.id, carla);

  const { data: detalle } = await (await verPlan(plan.id, dani)).json();
  assertEquals(detalle.myStatus, "espera");
  const { data: detalleBea } = await (await verPlan(plan.id, bea)).json();
  assertEquals(detalleBea.confirmed, 1);
});

Deno.test("Apuntarse dos veces es idempotente", async () => {
  await limpiarPlanes();
  const ana = await crearVisita("Ana");
  const bea = await crearVisita("Bea");
  const { data: plan } = await (await crearPlan(planValido({ capacity: 1 }), ana)).json();

  assertEquals((await (await apuntarseAPlan(plan.id, bea)).json()).data.status, "confirmado");
  assertEquals((await (await apuntarseAPlan(plan.id, bea)).json()).data.status, "confirmado");

  const filas = await db.execute(sql`select count(*)::int as total from plan_attendees where plan_id = ${plan.id}`);
  assertEquals(filas.rows[0], { total: 1 });
});

Deno.test("Un plan de alguien bloqueado no aparece ni admite altas", async () => {
  await limpiarPlanes();
  const ana = await visitanteCompleto("Ana");
  const bea = await visitanteCompleto("Bea");
  const { data: plan } = await (await crearPlan(planValido(), ana.cookie)).json();

  await bloquear(bea.publicId, ana.cookie);

  const { data } = await (await listarPlanes("", bea.cookie)).json();
  assertEquals(data.length, 0);
  assertEquals((await verPlan(plan.id, bea.cookie)).status, 404);
  assertEquals((await apuntarseAPlan(plan.id, bea.cookie)).status, 403);
});

Deno.test("Planes inexistentes, ids inválidos y planes pasados", async () => {
  await limpiarPlanes();
  const ana = await crearVisita("Ana");

  assertEquals((await verPlan(999999, ana)).status, 404);
  assertEquals((await verPlan(0, ana)).status, 404);
  assertEquals((await apuntarseAPlan(999999, ana)).status, 404);

  const bea = await crearVisita("Bea");
  const { data: plan } = await (await crearPlan(planValido(), ana)).json();
  await db.execute(sql`update plans set starts_at = now() - interval '1 hour' where id = ${plan.id}`);
  assertEquals((await apuntarseAPlan(plan.id, bea)).status, 409);
});

Deno.test("Solo el creador ve los asistentes", async () => {
  await limpiarPlanes();
  const ana = await visitanteCompleto("Ana");
  const bea = await visitanteCompleto("Bea");
  const { data: plan } = await (await crearPlan(planValido(), ana.cookie)).json();
  await apuntarseAPlan(plan.id, bea.cookie);

  assertEquals((await asistentesDePlan(plan.id, bea.cookie)).status, 403);

  const { data } = await (await asistentesDePlan(plan.id, ana.cookie)).json();
  assertEquals(data.length, 1);
  assertEquals(data[0].alias, "Bea");
  assertEquals("visitorId" in data[0], false);
});

Deno.test("Apuntarse no crea notificaciones", async () => {
  await limpiarPlanes();
  await limpiarNotificaciones();
  const ana = await crearVisita("Ana");
  const bea = await crearVisita("Bea");
  const { data: plan } = await (await crearPlan(planValido(), ana)).json();

  const antes = await db.execute("select count(*)::int as total from notifications");
  await apuntarseAPlan(plan.id, bea);
  await salirDePlan(plan.id, bea);
  const despues = await db.execute("select count(*)::int as total from notifications");

  assertEquals(despues.rows[0], antes.rows[0]);
});

Deno.test("Un PNG de cabecera sin IEND se rechaza", async () => {
  await limpiarFotos();
  const cookie = await crearVisita("Ana");
  const falso = new Uint8Array(33);
  falso.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  falso.set([0, 0, 0, 13], 8);
  falso.set([0x49, 0x48, 0x44, 0x52], 12);

  assertEquals((await subirFoto(falso, "image/png", cookie)).status, 422);
});

Deno.test("Las fotos se guardan sin EXIF", async () => {
  await limpiarFotos();
  const cookie = await crearVisita("Ana");
  const exif = new TextEncoder().encode("Exif\u0000\u0000GPS-OCULTO");
  const bytes = new Uint8Array(2 + 2 + 2 + exif.length + 2);
  bytes.set([0xff, 0xd8, 0xff, 0xe1], 0);
  bytes[4] = (2 + exif.length) >> 8;
  bytes[5] = (2 + exif.length) & 0xff;
  bytes.set(exif, 6);
  bytes.set([0xff, 0xd9], bytes.length - 2);

  const res = await subirFoto(bytes, "image/jpeg", cookie);
  assertEquals(res.status, 201);
  const { data } = await res.json();

  const foto = await app.request(`/api/photos/${data.id}`);
  const servidos = new Uint8Array(await foto.arrayBuffer());
  assertEquals(servidos.length < bytes.length, true);
  assertEquals(new TextDecoder().decode(servidos).includes("GPS-OCULTO"), false);
});

Deno.test("El creador no puede apuntarse a su propio plan", async () => {
  await limpiarPlanes();
  const ana = await crearVisita("Ana");
  const { data: plan } = await (await crearPlan(planValido(), ana)).json();

  assertEquals((await apuntarseAPlan(plan.id, ana)).status, 422);
});

Deno.test("Dos personas compiten por la última plaza a la vez", async () => {
  await limpiarPlanes();
  const ana = await crearVisita("Ana");
  const bea = await crearVisita("Bea");
  const carla = await crearVisita("Carla");
  const { data: plan } = await (await crearPlan(planValido({ capacity: 1 }), ana)).json();

  const [a, b] = await Promise.all([
    (await apuntarseAPlan(plan.id, bea)).json(),
    (await apuntarseAPlan(plan.id, carla)).json(),
  ]);

  assertEquals([a.data.status, b.data.status].sort(), ["confirmado", "espera"]);
  const filas = await db.execute(
    sql`select count(*)::int as total from plan_attendees where plan_id = ${plan.id} and status = 'confirmado'`,
  );
  assertEquals(filas.rows[0], { total: 1 });
});

Deno.test("Bloquear a un asistente libera su plaza y asciende la espera", async () => {
  await limpiarPlanes();
  const ana = await visitanteCompleto("Ana");
  const bea = await visitanteCompleto("Bea");
  const carla = await visitanteCompleto("Carla");
  const { data: plan } = await (await crearPlan(planValido({ capacity: 1 }), ana.cookie)).json();

  await apuntarseAPlan(plan.id, bea.cookie);
  await apuntarseAPlan(plan.id, carla.cookie);

  await bloquear(bea.publicId, ana.cookie);

  const { data: detalle } = await (await verPlan(plan.id, carla.cookie)).json();
  assertEquals(detalle.myStatus, "confirmado");
  assertEquals(detalle.confirmed, 1);
});

Deno.test("Radio por defecto de 25 km y listado anónimo", async () => {
  await limpiarPlanes();
  const ana = await crearVisita("Ana");
  await crearPlan(planValido({ title: "A 111 km", lat: 41.4168, lng: -3.7038 }), ana);

  const { data: cerca } = await (await listarPlanes(`?lat=${MADRID.lat}&lng=${MADRID.lng}`)).json();
  assertEquals(cerca.length, 0);

  const anonimo = await listarPlanes("?lat=40.4168&lng=-3.7038&radius=200");
  assertEquals(anonimo.status, 200);
  assertEquals((await anonimo.json()).data.length, 1);
});

Deno.test("Un texto con surrogate suelto se rechaza", async () => {
  const res = await lanzar({ text: "\ud800abcde" });

  assertEquals(res.status, 422);
});

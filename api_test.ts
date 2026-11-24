import { assertEquals, assertMatch } from "@std/assert";

// La BD de test vive en data/test-pgdata, separada de la de desarrollo.
Deno.env.set("PGDATA_DIR", "./data/test-pgdata");

const { app } = await import("./main.ts");
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

  const primera = await pedirDelMar();
  const cookie = (primera.headers.get("set-cookie") ?? "").split(";")[0];
  const { data: vista } = await primera.json();

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

  const primera = await pedirDelMar();
  const cookie = (primera.headers.get("set-cookie") ?? "").split(";")[0];

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

  const inicial = await pedirDelMar();
  const cookie = (inicial.headers.get("set-cookie") ?? "").split(";")[0];

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

  const mia = await pedirDelMar();
  const [cookie] = (mia.headers.get("set-cookie") ?? "").split(";");
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
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
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

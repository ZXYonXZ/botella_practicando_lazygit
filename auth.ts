const encoder = new TextEncoder();

const aBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const deBase64Url = (texto: string) => {
  const base64 = texto.replace(/-/g, "+").replace(/_/g, "/");
  const relleno = "=".repeat((4 - (base64.length % 4)) % 4);
  const binario = atob(base64 + relleno);
  return Uint8Array.from(binario, (c) => c.charCodeAt(0));
};

const aHex = (bytes: Uint8Array) =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

const ITERACIONES = 600_000;
const LARGO_SAL = 16;

const derivar = async (password: string, sal: Uint8Array, iteraciones: number, largo: number) => {
  const clave = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password) as unknown as BufferSource,
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: sal as unknown as BufferSource, iterations: iteraciones },
    clave,
    largo * 8,
  );
  return new Uint8Array(bits);
};

const igualesEnTiempoConstante = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false;
  let diferencia = 0;
  for (let i = 0; i < a.length; i++) diferencia |= a[i] ^ b[i];
  return diferencia === 0;
};

/** Token opaco de 32 bytes, seguro para usar como credencial Bearer. */
export const generarToken = () =>
  aBase64Url(crypto.getRandomValues(new Uint8Array(32)));

/** `pbkdf2-sha256$<iteraciones>$<sal>$<hash>`. La contraseña nunca se guarda. */
export const hashPassword = async (password: string) => {
  const sal = crypto.getRandomValues(new Uint8Array(LARGO_SAL));
  const hash = await derivar(password, sal, ITERACIONES, 32);
  return `pbkdf2-sha256$${ITERACIONES}$${aBase64Url(sal)}$${aBase64Url(hash)}`;
};

export const verificarPassword = async (password: string, guardado: string) => {
  const [algoritmo, iteracionesTexto, salTexto, hashTexto] = guardado.split("$");
  if (algoritmo !== "pbkdf2-sha256" || !salTexto || !hashTexto) return false;

  const iteraciones = Number(iteracionesTexto);
  if (!Number.isSafeInteger(iteraciones) || iteraciones < 1) return false;

  const sal = deBase64Url(salTexto);
  const esperado = deBase64Url(hashTexto);
  if (sal.length === 0 || esperado.length === 0) return false;

  const calculado = await derivar(password, sal, iteraciones, esperado.length);
  return igualesEnTiempoConstante(calculado, esperado);
};

/**
 * Hash de los tokens de sesión: HMAC-SHA256 con un pimiento del servidor.
 * En la BD solo queda el HMAC; con la BD robada y sin el pimiento no se puede verificar nada.
 */
export const crearDigestDeTokens = async (pepper: string) => {
  const clave = await crypto.subtle.importKey(
    "raw",
    encoder.encode(pepper) as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return async (token: string) =>
    aHex(new Uint8Array(await crypto.subtle.sign("HMAC", clave, encoder.encode(token))));
};

/** Cuenta puntos de código, igual que `length()` de Postgres. */
export const largoTexto = (texto: string) => [...texto].length;

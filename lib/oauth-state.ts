import { importKey } from "@/lib/auth";

// Estado (state) del flujo OAuth con Mercado Libre, guardado en una cookie firmada de vida corta.
//
// /api/auth/login (que exige sesión) genera un nonce aleatorio, lo manda a ML como `state` y lo guarda aquí firmado
// con HMAC (misma clave que la sesión, con un prefijo de dominio para que un token de sesión nunca valga como estado).
// /api/auth/callback solo continúa si la cookie es válida y su nonce coincide con el `state` que vuelve de ML. Así un
// `code` ajeno (el de otra cuenta de ML) no puede conectarse a esta app, y solo un navegador con sesión pudo iniciar el flujo.
//
// Corre también en el middleware (Edge): solo usa Web Crypto.

export const OAUTH_STATE_COOKIE = "ml_oauth_state";
export const OAUTH_STATE_PATH = "/api/auth/callback"; // la cookie solo viaja a esta ruta
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const DOMINIO = "oauth-state:";

function aBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function deBase64Url(texto: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(texto.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}

async function firmar(payload: string): Promise<string> {
  const firma = await crypto.subtle.sign("HMAC", await importKey(), new TextEncoder().encode(DOMINIO + payload));
  return aBase64Url(new Uint8Array(firma));
}

// Devuelve el nonce (para mandarlo a ML como `state`) y el valor firmado de la cookie: "nonce.exp.firma".
export async function crearEstadoOauth(): Promise<{ nonce: string; cookie: string }> {
  const nonce = aBase64Url(crypto.getRandomValues(new Uint8Array(24)));
  const payload = `${nonce}.${Date.now() + OAUTH_STATE_TTL_MS}`;
  return { nonce, cookie: `${payload}.${await firmar(payload)}` };
}

// Devuelve el nonce si la cookie existe, no venció y su firma es válida; null en cualquier otro caso.
export async function leerEstadoOauth(cookie: string | undefined): Promise<string | null> {
  if (!cookie) return null;
  try {
    const partes = cookie.split(".");
    if (partes.length !== 3) return null;
    const [nonce, expTexto, firma] = partes;
    const exp = Number(expTexto);
    if (!nonce || !Number.isFinite(exp) || Date.now() > exp) return null;
    const valida = await crypto.subtle.verify(
      "HMAC", await importKey(), deBase64Url(firma), new TextEncoder().encode(DOMINIO + `${nonce}.${expTexto}`)
    );
    return valida ? nonce : null;
  } catch {
    return null;
  }
}

// Comparación en tiempo constante (para el `state` que vuelve en la URL).
export function mismoTexto(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diferencia = 0;
  for (let i = 0; i < a.length; i++) diferencia |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diferencia === 0;
}

// Atributos de la cookie (iguales al crearla y al borrarla). SameSite=Lax y no Strict: la vuelta desde ML es una
// navegación de primer nivel entre sitios, y con Strict algunos navegadores no envían la cookie en esa redirección.
export function opcionesCookieOauth(maxAgeSegundos: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: maxAgeSegundos,
    path: OAUTH_STATE_PATH,
  };
}

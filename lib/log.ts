// Log de errores del servidor SIN datos sensibles.
//
// console.error(etiqueta, error) con un error de axios imprime error.config completo, incluido el header
// Authorization (el Bearer de ML) y los params. Los logs de Vercel los ve cualquiera con acceso al proyecto, así que
// acá se imprime SOLO: contexto, tipo de error, mensaje (con tokens censurados), código HTTP y método + ruta de la
// llamada saliente (sin query ni IDs largos). Nunca config, headers, params, body ni stack.

const MAX_MENSAJE = 300;

// Censura Bearer/Basic, tokens de ML (APP_USR-…, TG-…) y claves PEM por si algún mensaje de error los arrastra.
function censurar(texto: string): string {
  return texto
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [censurado]")
    .replace(/\b(APP_USR|TG)-[A-Za-z0-9_-]{8,}/g, "[token censurado]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[clave censurada]");
}

// Ruta sin host, sin query y sin IDs numéricos largos (user_id, order_id…) ni IDs de publicación.
function rutaSegura(url: unknown): string | null {
  if (typeof url !== "string" || !url) return null;
  let ruta = url;
  try { ruta = new URL(url, "http://x").pathname; } catch { ruta = url.split("?")[0]; }
  // También IDs largos alfanuméricos (p. ej. el ID del spreadsheet en las URLs de Sheets).
  return censurar(ruta.replace(/[A-Za-z0-9_-]{20,}/g, ":id").replace(/\d{6,}/g, ":id")).slice(0, 120);
}

type ErrorConDetalle = {
  name?: unknown; message?: unknown; code?: unknown; status?: unknown;
  response?: { status?: unknown };
  config?: { url?: unknown; method?: unknown };
};

export function describirError(error: unknown): string {
  if (error === null || error === undefined) return "error desconocido";
  if (typeof error === "string") return censurar(error).slice(0, MAX_MENSAJE);
  if (typeof error !== "object") return censurar(String(error)).slice(0, MAX_MENSAJE);

  const e = error as ErrorConDetalle;
  const nombre = typeof e.name === "string" && e.name ? e.name : "Error";
  const mensaje = censurar(typeof e.message === "string" ? e.message : "sin mensaje").slice(0, MAX_MENSAJE);
  const partes = [`${nombre}: ${mensaje}`];

  // Código HTTP: axios lo trae en response.status; gaxios (googleapis) en status o en code numérico.
  const status = [e.response?.status, e.status, e.code].find((v) => typeof v === "number" || (typeof v === "string" && /^\d{3}$/.test(v)));
  if (status !== undefined) partes.push(`status=${status}`);
  else if (typeof e.code === "string" && /^[A-Z0-9_]{3,40}$/.test(e.code)) partes.push(`code=${e.code}`); // ECONNABORTED, ETIMEDOUT…

  const ruta = rutaSegura(e.config?.url);
  if (ruta) partes.push(`${typeof e.config?.method === "string" ? e.config.method.toUpperCase() : "GET"} ${ruta}`);
  return partes.join(" | ");
}

export function logError(contexto: string, error: unknown): void {
  console.error(`[${contexto}] ${describirError(error)}`);
}

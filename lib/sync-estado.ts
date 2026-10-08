// Estado del sync de Publicaciones para la pantalla de Sync. /api/ml-sync devuelve
// ok: true si Publicaciones O Ventas funcionó, así que una falla solo de Publicaciones
// (p. ej. el aborto por no poder leer la hoja anterior) queda en erroresSync con
// publicaciones: null. Esta función la detecta sin cambiar la respuesta de la API.
export type RespuestaSync = { ok: boolean; publicaciones?: number | null; erroresSync?: string[] };

// Devuelve el detalle del error de Publicaciones, o null si Publicaciones no falló.
// Un error solo de Ventas, un error de red o una corrida normal devuelven null.
export function errorPublicaciones(r: RespuestaSync): string | null {
  const e = (r.erroresSync ?? []).find((x) => x.startsWith("Publicaciones:"));
  if (e) return e.replace(/^Publicaciones:\s*(Error:\s*)?/, "") || "sin detalle";
  if (r.publicaciones === null) return "Publicaciones no devolvió resultado (sin detalle).";
  return null;
}

// "No se borró nada" solo es cierto si fue el aborto previo a limpiar la hoja (mensaje de
// ml-sync con "sin borrar ni escribir nada"). Un error posterior (p. ej. al escribir tras
// limpiar) puede haber dejado la hoja vacía o a medias, y el banner no debe afirmar lo contrario.
export function abortoSinBorrar(detalle: string): boolean {
  return detalle.includes("sin borrar ni escribir nada");
}

// Última vez que ESTE navegador vio un sync con Publicaciones correcto. No hay otra
// fuente sin llamadas nuevas: la columna R de la hoja guarda solo la fecha y la lectura
// de la hoja es justo la que puede fallar.
const CLAVE = "ml-tracker:ultimoSyncPublicaciones";
export function leerUltimoSyncPublicaciones(): string | null {
  try { return window.localStorage.getItem(CLAVE); } catch { return null; }
}
export function guardarUltimoSyncPublicaciones(iso: string) {
  try { window.localStorage.setItem(CLAVE, iso); } catch { /* sin almacenamiento: el banner omite la hora */ }
}

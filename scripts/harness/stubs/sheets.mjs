// Sheets: en "record" lee de verdad (solo lectura) y graba por rango; en "replay" sirve lo grabado.
// Cualquier escritura falla.
const H = () => globalThis.__H;
export async function readSheet(range) {
  const h = H();
  if (h.mode === "replay") {
    if (!(range in h.db.sheets)) throw new Error("harness: rango no grabado " + range);
    return JSON.parse(JSON.stringify(h.db.sheets[range]));
  }
  const rows = await h.leerReal(range);
  h.db.sheets[range] = rows;
  return JSON.parse(JSON.stringify(rows));
}
const noEscribir = (n) => async () => { throw new Error("harness: escritura no permitida (" + n + ")"); };
export const writeSheet = noEscribir("writeSheet");
export const appendSheet = noEscribir("appendSheet");
export const clearSheet = noEscribir("clearSheet");
export const ensureSheets = async () => {};

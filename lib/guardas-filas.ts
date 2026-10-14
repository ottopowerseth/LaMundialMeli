// Guardas anti-carrera para escrituras que se dirigen por NÚMERO de fila (S-08).
//
// Varias rutas leen una hoja, el usuario (o el propio request) tarda un rato, y después borran o marcan «la fila N». Entre medio
// puede correr un sync (ml-sync reescribe Publicaciones completa y puede reordenarla) o el usuario puede haber borrado otra fila,
// y la fila N ya no es la misma. Mismo patrón que lib/costo-auto.ts (verificarFilas): se vuelve a leer la fila JUSTO antes de
// escribir y, si ya no contiene lo esperado, no se toca nada.
//
// Límite: no hay lectura-y-borrado atómico en la API de Sheets; la ventana entre la verificación y el borrado queda en el orden
// de cientos de milisegundos, no en cero.

export type ItemFila = { fila: number; id: string };
export type DiscrepanciaFila = { fila: number; esperado: string; encontrado: string };

const texto = (v: unknown) => String(v ?? "").trim();

// idsActuales = lectura de Publicaciones!A2:A… (la posición 0 es la fila 2 de la hoja).
export function discrepanciasDeProductos(idsActuales: unknown[][], items: ItemFila[]): DiscrepanciaFila[] {
  const malos: DiscrepanciaFila[] = [];
  for (const it of items) {
    const encontrado = texto(idsActuales[it.fila - 2]?.[0]);
    if (encontrado !== texto(it.id)) malos.push({ fila: it.fila, esperado: texto(it.id), encontrado });
  }
  return malos;
}

export function mensajeDiscrepancias(malos: DiscrepanciaFila[], accion: string): string {
  const ej = malos.slice(0, 3).map((m) => `fila ${m.fila}: esperaba ${m.esperado}, ahora hay ${m.encontrado || "(vacía)"}`).join("; ");
  return `La hoja Publicaciones cambió desde que se listó (${malos.length} fila(s) ya no contienen lo esperado: ${ej}${malos.length > 3 ? "…" : ""}). ¿Hay un sync en curso? No se ${accion} nada; vuelve a listar y reintenta.`;
}

// Fila de la hoja Auditoría: mes (col A, leído formateado) y fecha de análisis (col N en el esquema de 14 columnas, col P en el
// vigente: mismo criterio que loadHistorial en page.tsx). Devuelve el motivo si NO coincide, o null si es la fila esperada.
export function discrepanciaAuditoria(fila: unknown[] | undefined, mesEsperado: string, analizadoEsperado: string): string | null {
  if (!fila || fila.length === 0 || !texto(fila[0])) return "La fila indicada ya no existe en la hoja Auditoría.";
  const mes = texto(fila[0]);
  const analizado = texto(fila.length <= 14 ? fila[13] : fila[15]);
  if (mes !== texto(mesEsperado) || analizado !== texto(analizadoEsperado)) {
    return `La fila ya no contiene lo esperado (esperaba ${texto(mesEsperado)} analizado ${texto(analizadoEsperado) || "(sin fecha)"}; ahora hay ${mes} analizado ${analizado || "(sin fecha)"}). La hoja cambió desde que se cargó el historial; recárgalo y reintenta.`;
  }
  return null;
}

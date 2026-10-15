// HERRAMIENTA DE UN SOLO USO (restauración de C-16): núcleo puro (sin red) para comparar la hoja viva contra su respaldo. Sin datos reales.
// Una celda se compara por su VALOR INTERNO (effectiveValue), su TEXTO MOSTRADO (formattedValue) y su FORMATO de número.
export const L = (i) => String.fromCharCode(65 + i);
export const numeroColumna = (c) => c.charCodeAt(0) - 65;
export const valorInterno = (x) => JSON.stringify(x?.effectiveValue ?? null);
export const mostrado = (x) => String(x?.formattedValue ?? "");
export const formato = (x) => JSON.stringify(x?.userEnteredFormat?.numberFormat ?? null);

// G y B: filas de includeGridData (rowData[]), con .values[] por columna A..Z. `excluir`: conjunto de claves «J22» que no se comparan (las celdas que la restauración escribe).
// Devuelve las celdas distintas (hasta `max` por categoría, con el total aparte).
export function compararGrids(G, B, excluir = new Set(), max = 10) {
  const out = { valor: [], mostrado: [], formato: [], totales: { valor: 0, mostrado: 0, formato: 0 }, celdas: 0 };
  const filas = Math.max(G.length, B.length);
  for (let f = 1; f <= filas; f++) for (let k = 0; k < 26; k++) {
    const c = L(k) + f; if (excluir.has(c)) continue; out.celdas++;
    const x = G[f - 1]?.values?.[k] ?? null, y = B[f - 1]?.values?.[k] ?? null;
    for (const [cat, fn] of [["valor", valorInterno], ["mostrado", mostrado], ["formato", formato]]) if (fn(x) !== fn(y)) { out.totales[cat]++; if (out[cat].length < max) out[cat].push(c); }
  }
  return out;
}

// ¿La celda es TEXTO (stringValue) sin formato de número? Es lo que dejó S-07 en J y K y lo que escribe C-16.
export const esTextoSinFormato = (x) => x?.effectiveValue?.stringValue !== undefined && !x?.userEnteredFormat?.numberFormat;
export const texto = (x) => String(x?.effectiveValue?.stringValue ?? "").trim();

// Estado de una fila del plan en la hoja viva respecto del respaldo: «aplicada» (J y K = «despues» del plan), «restaurada» (= «antes» del respaldo) u «otra».
export function estadoFila(viva, respaldo, c) {
  const j = viva?.[9], k = viva?.[10], jb = respaldo?.[9], kb = respaldo?.[10];
  if (texto(j) === c.despues.J && texto(k) === c.despues.K && esTextoSinFormato(j) && esTextoSinFormato(k)) return c.despues.J === texto(jb) && c.despues.K === texto(kb) ? "restaurada" : "aplicada";
  if (valorInterno(j) === valorInterno(jb) && valorInterno(k) === valorInterno(kb) && formato(j) === formato(jb) && formato(k) === formato(kb)) return "restaurada";
  return "otra";
}

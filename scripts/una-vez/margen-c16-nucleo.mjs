// HERRAMIENTA DE UN SOLO USO (núcleo puro del recálculo C-16): sin red ni datos reales.
// Núcleo PURO (sin red) del ensayo de recálculo de márgenes de Rentabilidad (C-16, fase 1). Recibe calcularMargen y numeroComoTexto del código real para no duplicar fórmulas.
// Versiones de la fórmula (historial de git): V1 = bb72bcd/b589417 (2026-08-24): todo BRUTO sin IVA · V2 = 1a0c521 (2026-09-29 10:48): precio, comisión, envío y pérdida a neto, COGS tal cual
// (correcta si el COGS era NETO) · V3 = 692f8c2 (2026-09-29 17:05, la actual): todo a neto (÷1,19; correcta si el COGS es BRUTO).
export const IVA = 0.19;
const num = (t) => { const s = String(t ?? "").trim(); if (s === "") return NaN; return Number(s.replace(",", ".")); };
const r1 = (x) => Math.round(x * 10) / 10; const TOL = 0.15; const cerca = (a, b) => Math.abs(a - b) <= TOL;

// Filas de Rentabilidad (valores MOSTRADOS, A2:Q) que tienen COGS y margen neto guardado. Columnas: C ítem, E precio, F cogs, G comisión, H envío, I pérdida, J margen neto, K margen %, N unidades.
export function leerFilas(valores) {
  return valores.map((r, i) => ({ fila: i + 2, item: String(r[2] ?? ""), E: num(r[4]), F: num(r[5]), G: num(r[6]), H: num(r[7]), I: num(r[8]), J: num(r[9]), K: num(r[10]), N: num(r[13]) || 1 }))
    .filter((x) => [x.E, x.F, x.G, x.H, x.I, x.J].every(Number.isFinite));
}
// ¿Con qué versión de la fórmula se calculó el margen neto guardado?
export function clasificarVersion(x) {
  const v1 = r1(x.E - x.F - x.G - x.H - x.I);
  const v2 = r1(x.E / (1 + IVA) - x.F - x.G / (1 + IVA) - x.H / (1 + IVA) - x.I / (1 + IVA));
  const v3 = r1(x.E / (1 + IVA) - x.F / (1 + IVA) - x.G / (1 + IVA) - x.H / (1 + IVA) - x.I / (1 + IVA));
  if (cerca(v3, x.J) && !cerca(v2, x.J)) return "V3"; if (cerca(v2, x.J)) return "V2"; if (cerca(v1, x.J)) return "V1"; return "otra";
}
// Margen corregido con la fórmula ACTUAL (calcularMargen), bajo una hipótesis sobre el COGS guardado:
//   "bruto": el COGS guardado trae IVA → se usa tal cual.   "neto": el COGS guardado es neto → se lleva a bruto (×1,19) antes de aplicar la fórmula actual.
export function margenCorregido(x, hipotesis, calcularMargen) {
  const cogs = hipotesis === "neto" ? x.F * (1 + IVA) : x.F;
  const { margenNeto, margenPct } = calcularMargen(x.E, cogs, x.G, x.H, x.I); return { J: margenNeto, K: margenPct };
}
// Lo que muestra la tarjeta de la pestaña Rentabilidad (page.tsx): margen total, % promedio y órdenes con margen negativo, sobre las filas con margen.
export function tarjeta(filas) { const g = filas.filter((x) => Number.isFinite(x.J)); const n = g.length; return { n, margenTotal: r1(g.reduce((s, x) => s + x.J, 0)), pctPromedio: n ? r1(g.reduce((s, x) => s + (Number.isFinite(x.K) ? x.K : 0), 0) / n) : 0, negativas: g.filter((x) => x.J < 0).length }; }
export const signo = (n) => (n > 0 ? 1 : n < 0 ? -1 : 0);

// Escenario: función ítem → hipótesis. Devuelve, por fila, el margen guardado y el corregido.
export function aplicarEscenario(filas, hipotesisDe, calcularMargen) {
  return filas.map((x) => { const h = hipotesisDe(x.item); const c = margenCorregido(x, h, calcularMargen); return { ...x, hipotesis: h, Jn: c.J, Kn: c.K, cambia: !(Number.isFinite(c.J) && cerca(c.J, x.J)), cambiaSigno: signo(c.J) !== signo(x.J) }; });
}
export function resumenPorItem(filasEscenario) {
  const items = [...new Set(filasEscenario.map((x) => x.item))]; return items.map((it) => { const f = filasEscenario.filter((x) => x.item === it); return { item: it, filas: f.length, versiones: f.reduce((a, x) => { a[x.version] = (a[x.version] ?? 0) + 1; return a; }, {}), guardado: r1(f.reduce((s, x) => s + x.J, 0)), corregido: r1(f.reduce((s, x) => s + x.Jn, 0)), cambianSigno: f.filter((x) => x.cambiaSigno).length, cambian: f.filter((x) => x.cambia).length }; });
}
// Escritura propuesta (NO se ejecuta): solo las columnas J:K de las filas cuyo margen cambia. Los números van como TEXTO con el apóstrofo del ayudante de números (S-07).
export function escrituraJK(x, numeroComoTexto) { return { range: `Rentabilidad!J${x.fila}:K${x.fila}`, values: [[numeroComoTexto(x.Jn), numeroComoTexto(x.Kn)]] }; }
export function escriturasPropuestas(filasEscenario, numeroComoTexto) { return filasEscenario.filter((x) => x.cambia && Number.isFinite(x.Jn)).map((x) => escrituraJK(x, numeroComoTexto)); }

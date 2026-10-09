// Pruebas de lib/reposicion-full.ts (sin red).
// Uso:  node scripts/test-reposicion-full.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ts = require(path.join(PROJ, "node_modules", "typescript"));
const out = fs.mkdtempSync(path.join(os.tmpdir(), "reposicion-test-"));
fs.writeFileSync(path.join(out, "r.js"), ts.transpileModule(fs.readFileSync(`${PROJ}/lib/reposicion-full.ts`, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText);
const R = require(path.join(out, "r.js"));
let ok = 0; const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); ok++; console.log("  ✓", m); };

const AHORA = Date.parse("2026-10-09T12:00:00Z");
const dia = (n) => AHORA - n * 86400000;
const F = "fulfillment", X = "xd_drop_off";
const linea = (item, cantidad, diasAtras, logistic) => ({ item, cantidad, ms: dia(diasAtras), logistic });
const it = (id, estado, stock, extra = {}) => ({ id, titulo: "T " + id, estado, subEstado: estado === "paused" ? ["out_of_stock"] : [], stock, full: true, ...extra });
const vel = (v) => ({ velocidad: v, diasSinStock: 0, velocidadConfiable: true });
const armar = (items, lineas, velocidades, margenes, extra = {}) => R.armarReposicion({ items, lineas, ahoraMs: AHORA, velocidades: new Map(Object.entries(velocidades).map(([k, v]) => [k, vel(v)])), margenUnitario: new Map(Object.entries(margenes)), ...extra });

console.log("pausadas por out_of_stock que vendían en Full");
{
  const items = [it("P1", "paused", 0), it("P2", "paused", 0), it("P3", "paused", 0, { subEstado: ["deleted"] }), it("P4", "paused", 0), it("P5", "paused", 0)];
  const lineas = [linea("P1", 10, 5, F), linea("P1", 30, 45, F), linea("P2", 4, 100, F), linea("P3", 9, 3, F), linea("P4", 7, 10, X), linea("P5", 2, 130, F)];
  const r = armar(items, lineas, { P1: 2, P2: 0.1 }, { P1: 300, P2: 200, P3: 100, P4: 100, P5: 100 });
  eq(r.filas.map((f) => f.id), ["P1", "P2"], "entra P1 y P2 (Full en 120 d); no P3 (cerrada, no out_of_stock), ni P4 (solo vendió por otro canal), ni P5 (Full hace 130 días)");
  const p1 = r.filas[0];
  eq([p1.f30, p1.f60, p1.f90, p1.f120, p1.tipo, p1.cobertura], [10, 40, 40, 40, "pausada", 0], "ventanas Full 30/60/90/120 d y cobertura 0 en una pausada");
  eq([p1.margenPerdidoDia, p1.sugerido], [600, 60], "margen perdido por día = 2 u/día × $300; sugerido = 2 × 30 − 0 = 60");
  eq(r.filas[1].f120, 4, "P2 vendió Full a los 100 días: entra por la ventana de 120");
}

console.log("por agotarse");
{
  const items = [it("A1", "active", 3), it("A2", "active", 40), it("A3", "active", 5, { full: false }), it("A4", "active", 4), it("A5", "active", 0)];
  const velocidades = { A1: 1.5, A2: 1.5, A3: 2, A4: 0.1, A5: 1 };
  const r = armar(items, [], velocidades, { A1: 100, A2: 100, A3: 100, A4: 100, A5: 100 });
  eq(r.filas.map((f) => f.id).sort(), ["A1", "A5"], "A1 (3 ÷ 1,5 = 2 días) y A5 (stock 0) sí; A2 (26,7 días), A3 (no es Full) y A4 (velocidad < 0,3) no");
  const a1 = r.filas.find((f) => f.id === "A1");
  eq([a1.cobertura, a1.sugerido, a1.tipo], [2, 42, "por_agotarse"], "cobertura 2 d; sugerido = ceil(1,5 × 30 − 3) = 42");
  eq(r.filas.find((f) => f.id === "A5").cobertura, 0, "stock 0 activa: cobertura 0");
}

console.log("margen negativo o sin Costo: no se sugiere");
{
  const items = [it("N1", "paused", 0), it("N2", "paused", 0), it("N3", "paused", 0)];
  const lineas = [linea("N1", 10, 5, F), linea("N2", 10, 5, F), linea("N3", 10, 5, F)];
  const r = armar(items, lineas, { N1: 1.4, N2: 1, N3: 1 }, { N1: -266, N2: null, N3: 0 });
  const por = Object.fromEntries(r.filas.map((f) => [f.id, f]));
  eq([por.N1.revisar, por.N1.sugerido, por.N1.margenPerdidoDia], ["margen_negativo", null, null], "margen unitario negativo → revisar, sin sugerido ni margen perdido");
  eq([por.N2.revisar, por.N2.sugerido], ["sin_costo", null], "sin Costo (margen null) → revisar");
  eq(por.N3.revisar, "margen_negativo", "margen 0 tampoco se repone sin revisar");
  eq(r.resumen.revisar, 3, "el resumen cuenta las 3 en revisión");
}

console.log("orden por margen perdido por día y resumen");
{
  const items = [it("O1", "paused", 0), it("O2", "paused", 0), it("O3", "paused", 0), it("O4", "paused", 0)];
  const lineas = items.flatMap((i) => [linea(i.id, 10, 5, F), linea(i.id, 1, 100, F)]);
  const r = armar(items, lineas, { O1: 1, O2: 3, O3: 2, O4: 5 }, { O1: 100, O2: 200, O3: 100, O4: -5 });
  eq(r.filas.map((f) => f.id), ["O2", "O3", "O1", "O4"], "orden: O2 (600), O3 (200), O1 (100) y al final la de margen negativo");
  eq([r.resumen.pausadas, r.resumen.margenPerdidoDiaTotal, r.resumen.sugeridoTotal], [4, 900, 30 + 90 + 60], "resumen: 4 pausadas, $900/día, sugerido 180 (sin la negativa)");
}

console.log("canal mezclado y velocidad de respaldo");
{
  const r = armar([it("M1", "paused", 0)], [linea("M1", 6, 5, F), linea("M1", 12, 20, X), linea("M1", 6, 100, X)], {}, { M1: 100 });
  eq([r.filas[0].n90, r.filas[0].f90], [12, 6], "n90 cuenta lo vendido por otro canal en 90 d (el de 100 d no)");
  eq(r.filas[0].velocidad, 0.86, "sin velocidad del Tablero usa Full 90 d ÷ los días en Full (6 u, primera venta hace 5 días → mínimo 7 días = 0,86)");
}

console.log("piso de velocidad: promedio Full de 90 días");
{
  const r = armar([it("V1", "paused", 0), it("V2", "paused", 0)], [linea("V1", 38, 40, F), linea("V1", 1, 100, F), linea("V2", 90, 10, F), linea("V2", 1, 100, F)], { V1: 0, V2: 0.5 }, { V1: 145, V2: 100 });
  const por = Object.fromEntries(r.filas.map((f) => [f.id, f]));
  eq([por.V1.velocidad, por.V1.sugerido], [0.42, 13], "sin ventas en los últimos 30 días la velocidad no es 0: 38 ÷ 90 = 0,42 → sugerido 13");
  eq(por.V2.velocidad, 1, "si el promedio de 90 días supera a la velocidad del Tablero (90 ÷ 90 = 1 > 0,5) se usa el promedio");
}

console.log("velocidad de 30 vs 90 días y aviso de pico reciente");
{
  // F: 90 u en 90 d → v90 = 1. Tablero dice 1,6 (> 1,5×) / 1,5 (= 1,5×, no) / 0,4 / v90 = 0
  const items = ["K1", "K2", "K3", "K4"].map((i) => it(i, "paused", 0));
  const lineas = [linea("K1", 90, 10, F), linea("K2", 90, 10, F), linea("K3", 90, 10, F), linea("K1", 1, 100, F), linea("K2", 1, 100, F), linea("K3", 1, 100, F), linea("K4", 1, 150, F), linea("K4", 5, 200, X)];
  const r = armar(items, lineas, { K1: 1.6, K2: 1.5, K3: 0.4, K4: 2 }, { K1: 100, K2: 100, K3: 100, K4: 100 });
  const por = Object.fromEntries(r.filas.map((f) => [f.id, f]));
  eq([por.K1.velocidad30, por.K1.velocidad90, por.K1.picoReciente], [1.6, 1, true], "30 d (1,6) > 1,5 × 90 d (1,0): posible pico reciente");
  eq(por.K2.picoReciente, false, "exactamente 1,5× no se marca (es estrictamente mayor)");
  eq([por.K3.velocidad, por.K3.picoReciente], [1, false], "si la de 30 días es menor, el sugerido usa el piso de 90 días y no hay aviso");
  eq(por.K4, undefined, "K4 no tiene ventas Full en 120 d → no entra");
  eq(R.FACTOR_PICO_RECIENTE, 1.5, "el factor es una constante visible");
}

console.log("tope de unidades sugeridas");
{
  eq([R.aplicarTope(243, 100), R.aplicarTope(50, 100), R.aplicarTope(243, null), R.aplicarTope(243, 0), R.aplicarTope(243, -5), R.aplicarTope(243, NaN), R.aplicarTope(243, undefined)], [100, 50, 243, 243, 243, 243, 243], "tope: limita hacia abajo; null, 0, negativo, NaN o ausente = sin tope");
  eq(R.aplicarTope(243, 99.9), 99, "el tope se redondea hacia abajo");
}

console.log("publicación que entró a Full hace poco: el promedio no se diluye");
{
  // 60 u en los últimos 20 días, primera venta Full hace 20 días: 60 ÷ 20 = 3 (no 60 ÷ 90 = 0,67)
  const r = armar([it("E1", "paused", 0), it("E2", "paused", 0)], [linea("E1", 30, 20, F), linea("E1", 30, 5, F), linea("E2", 9, 2, F)], { E1: 3.5, E2: 0.2 }, { E1: 100, E2: 100 });
  const por = Object.fromEntries(r.filas.map((f) => [f.id, f]));
  eq([por.E1.velocidad90, por.E1.diasEnFull, por.E1.picoReciente], [3, 20, false], "entró hace 20 días: 60 ÷ 20 = 3,0; 3,5 no supera 1,5 × 3 → sin aviso (con ÷ 90 habría avisado)");
  eq([por.E2.diasEnFull, por.E2.velocidad90], [7, 1.29], "mínimo de 7 días: 9 u ÷ 7 = 1,29 (no 9 ÷ 2)");
}

console.log("cobertura objetivo y fórmula del cliente");
{
  eq([R.sugeridoPara(2, 10, 30), R.sugeridoPara(2, 100, 30), R.sugeridoPara(1.5, 3, 45), R.sugeridoPara(2, null, 10)], [50, 0, 65, 20], "sugeridoPara: nunca negativo; disponible null cuenta como 0");
  const r = armar([it("C1", "paused", 0)], [linea("C1", 10, 5, F)], { C1: 2 }, { C1: 100 }, { coberturaObjetivoDias: 45 });
  eq([r.filas[0].sugerido, r.supuestos.coberturaObjetivoDias], [90, 45], "la cobertura objetivo configurable cambia el sugerido y queda en los supuestos");
}

console.log(`\n${ok} comprobaciones OK`);

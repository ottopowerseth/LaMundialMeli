// Pruebas de lib/full-vs-normal.ts (sin red).
// Uso:  node scripts/test-full-vs-normal.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ts = require(path.join(PROJ, "node_modules", "typescript"));
const out = fs.mkdtempSync(path.join(os.tmpdir(), "fvn-test-"));
fs.writeFileSync(path.join(out, "f.js"), ts.transpileModule(fs.readFileSync(`${PROJ}/lib/full-vs-normal.ts`, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText);
const M = require(path.join(out, "f.js"));
let ok = 0; const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); ok++; console.log("  ✓", m); };

const AHORA = Date.parse("2026-10-09T12:00:00Z");
const dia = (n) => AHORA - n * 86400000;
let ord = 0;
const linea = (item, cantidad, diasAtras, logistic, precio = 1000) => ({ orden: "O" + ++ord, ms: dia(diasAtras), item, titulo: "T " + item, cantidad, precio, fee: 100, logistic });
const esFull = (l) => (l.logistic ? l.logistic === "fulfillment" : false);
const esReal = (l) => !!l.logistic;
// analizar de prueba: margen = 10 % del ingreso; "SC" no tiene Costo (sin margen); estado ok el resto
const analizar = (lineas) => {
  // margen = 10 % del ingreso; "SC" no tiene Costo. Reparte por tipo de venta como analizarMargen.
  const acc = new Map();
  for (const l of lineas) { const a = acc.get(l.item) ?? { full: { u: 0, ing: 0 }, estandar: { u: 0, ing: 0 } }; const k = esFull(l) ? "full" : "estandar"; a[k].u += l.cantidad; a[k].ing += l.cantidad * l.precio; acc.set(l.item, a); }
  const filas = [], detalle = new Map();
  for (const [id, a] of acc) {
    const sc = id === "SC"; const tot = a.full.ing + a.estandar.ing;
    filas.push({ id, titulo: "T " + id, full: false, unidades: a.full.u + a.estandar.u, ingreso: tot, precioProm: 0, costo: sc ? null : 500, comisionPct: 0.1, envioUnidad: 100, envioFuente: "medido", margenPct: sc ? null : 10, margenPesos: sc ? null : Math.round(tot * 0.1), estado: sc ? "sin_costo" : "ok", menosFiable: false, pierde: false, fueraDeAlcance: false });
    const det = {}; for (const k of ["full", "estandar"]) if (a[k].u > 0) det[k] = { unidades: a[k].u, ingreso: a[k].ing, margenPesos: sc ? null : a[k].ing * 0.1, margenPct: sc ? null : 10, estado: sc ? "sin_costo" : "ok", menosFiable: false };
    detalle.set(id, det);
  }
  const sub = (k) => { let ing = 0, mp = 0, n = 0; for (const [, d] of detalle) if (d[k] && d[k].margenPesos !== null) { ing += d[k].ingreso; mp += d[k].margenPesos; n++; } return { ingreso: ing, margenPct: ing > 0 ? 10 : null, margenPesos: Math.round(mp), publicaciones: n }; };
  return { filas, detalle, resumen: { total: { ...sub("full"), coberturaPct: 100, ingresoVentana: 0 }, porTipo: { full: sub("full"), estandar: sub("estandar") }, menosFiable: { pctIngreso: 0, fullEstimado: 0 }, pierden: { publicaciones: 0, pctIngreso: 0 }, margenBajo: { publicaciones: 0 }, sinCosto: { publicaciones: 0, pctIngreso: 0 } } };
};
const item = (id, extra = {}) => [id, { titulo: "T " + id, estado: "active", stock: 10, full: false, ...extra }];
const armar = (lineas, items, extra = {}) => M.armarFullVsNormal({ lineas, ahoraMs: AHORA, esFull, esReal, analizar, items: new Map(items), ...extra });

console.log("canales por período");
{
  const F = "fulfillment", X = "xd_drop_off";
  const lineas = [linea("A", 10, 5, F), linea("A", 5, 10, X), linea("B", 20, 40, X), linea("C", 4, 100, F), linea("SC", 6, 3, X), linea("R", 2, 2, undefined)];
  const r = armar(lineas, [item("A"), item("B"), item("C"), item("SC"), item("R")]);
  const p30 = r.periodos.find((p) => p.dias === 30), p90 = r.periodos.find((p) => p.dias === 90), p120 = r.periodos.find((p) => p.dias === 120);
  eq([p30.canales.full.unidades, p30.canales.normal.unidades], [10, 5 + 6 + 2], "30 d: Full 10 u; Normal 13 u (A 5 + SC 6 + R 2 con respaldo Normal)");
  eq([p90.canales.normal.unidades, p120.canales.full.unidades], [33, 14], "90 d: Normal 33 u (B entra a los 40 d); 120 d: Full 14 u (C a los 100 d)");
  eq([p30.canales.full.pctUnidades + p30.canales.normal.pctUnidades, p30.canales.full.pctIngreso + p30.canales.normal.pctIngreso], [100, 100], "los % de unidades y de ingreso suman 100");
  eq([p30.canales.full.ordenes, p30.canales.full.ticket], [1, 10000], "órdenes distintas y ticket = ingreso ÷ órdenes");
  eq(p30.respaldoPct, Math.round((2000 / 23000) * 1000) / 10, "respaldoPct: 2.000 de 23.000 sin tipo real (8,7 %)");
}

console.log("margen por canal y publicaciones sin Costo");
{
  const F = "fulfillment", X = "xd_drop_off";
  const r = armar([linea("A", 10, 5, F), linea("SC", 6, 3, X), linea("B", 4, 4, X)], [item("A"), item("SC"), item("B")]);
  const p = r.periodos[0];
  eq([p.canales.full.margenPesos, p.canales.full.margenPct, p.canales.normal.margenPesos], [1000, 10, 400], "margen Full $1.000 (10 % de 10.000); Normal $400: SC sin Costo queda fuera");
  eq([p.canales.normal.sinCosto.publicaciones, p.canales.normal.sinCosto.ingreso, p.canales.normal.sinCosto.lista[0].id], [1, 6000, "SC"], "SC listada como sin Costo con su ingreso");
  eq(p.canales.normal.ingresoConMargenPct, 40, "el margen cubre el 40 % del ingreso Normal (4.000 de 10.000)");
}

console.log("ingreso sin margen calculable");
{
  const X = "xd_drop_off", F = "fulfillment";
  const r = armar([linea("A", 10, 5, F), linea("SC", 6, 3, X), linea("B", 4, 4, X)], [item("A"), item("SC"), item("B")]);
  const c = r.periodos[0].canales;
  eq([c.full.ingresoSinMargen, c.normal.ingresoSinMargen, c.normal.sinCosto.ingreso], [0, 6000, 6000], "Normal: $6.000 de ventas fuera del margen (SC sin Costo); Full: 0");
}

console.log("tabla por producto");
{
  const F = "fulfillment", X = "xd_drop_off";
  const r = armar([linea("A", 10, 5, F), linea("A", 5, 10, X), linea("B", 3, 5, X)], [item("A"), item("B")]);
  const prods = r.periodos[0].productos;
  eq(prods.map((x) => x.id), ["A", "B"], "ordenada por ingreso total");
  eq([prods[0].full.unidades, prods[0].normal.unidades, prods[1].full], [10, 5, null], "A vende en ambos canales; B solo en Normal (full = null)");
}

console.log("tope de 200 publicaciones por período");
{
  const X = "xd_drop_off";
  const lineas = [], items = [];
  for (let i = 1; i <= 205; i++) { lineas.push(linea("P" + String(i).padStart(3, "0"), 5, 5, X, 1000 + i)); items.push(item("P" + String(i).padStart(3, "0"))); }
  const r = armar(lineas, items);
  const p = r.periodos[0];
  eq([p.productos.length, p.productosTotal], [200, 205], "la tabla trae 200 y informa el total (205): 5 quedaron fuera");
  eq([p.productos[0].id, p.productos[199].id], ["P205", "P006"], "son los 200 de mayor venta (precio crece con el número)");
  eq(r.candidatos.length, 205, "los candidatos se evalúan sobre TODAS las publicaciones, no solo las 200 de la tabla");
}

console.log("candidatos Normal → Full");
{
  const X = "xd_drop_off", F = "fulfillment";
  const lineas = [];
  for (let s = 0; s < 8; s++) lineas.push(linea("N1", 4, 3 + s * 7, X)); // 32 u en 8 semanas
  lineas.push(linea("N2", 30, 2, X)); // 30 u en 1 semana
  lineas.push(linea("N3", 3, 5, X)); // pocas unidades
  lineas.push(linea("N4", 25, 4, X), linea("N4", 3, 6, F)); // vendió por Full
  lineas.push(linea("N5", 25, 4, X)); // hoy es Full
  lineas.push(linea("SC", 25, 4, X)); // sin Costo
  const r = armar(lineas, [item("N1"), item("N2"), item("N3"), item("N4"), item("N5", { full: true }), item("SC"), item("N6", { estado: "paused" })]);
  eq(r.candidatos.map((c) => c.id).sort(), ["N1", "N2", "SC"], "entran Normal puro, activas y con ≥ 5 u en 90 d (no N3 con 3 u, ni N4 que vendió por Full, ni N5 que ya es Full)");
  const n1 = r.candidatos.find((c) => c.id === "N1");
  eq([n1.u90, n1.semanasConVenta, n1.margenUnitario, n1.margenMes], [32, 8, 100, Math.round((32 / 3) * 100)], "N1: 32 u, 8 semanas con ventas, margen $100/u, margen mensual al ritmo de 90 d");
  eq(r.candidatos.find((c) => c.id === "SC").margenUnitario, null, "sin Costo: margen unitario null (no califica)");
  eq(r.candidatos.map((c) => c.id)[2], "SC", "los sin margen van al final");
  eq(M.evaluarCandidato(n1, 20, 6), { rotacion: true, estable: true, margen: true, califica: true }, "N1 califica con 20 u y 6 semanas");
  eq(M.evaluarCandidato(r.candidatos.find((c) => c.id === "N2"), 20, 6), { rotacion: true, estable: false, margen: true, califica: false }, "N2 rota pero no es estable (1 semana)");
  eq(M.evaluarCandidato(n1, 40, 6).califica, false, "subir el umbral de unidades a 40 la saca");
  eq(r.noEvaluado.length >= 4, true, "lista lo que no se pudo evaluar");
}

console.log("en Full con ventas bajas");
{
  const X = "xd_drop_off", F = "fulfillment";
  const lineas = [linea("F1", 2, 5, F), linea("F2", 40, 5, F)];
  const costo = new Map([["F1", 1000], ["F2", 500], ["F3", null]]);
  const items = [item("F1", { full: true, stock: 50 }), item("F2", { full: true, stock: 50 }), item("F3", { full: true, stock: 7 }), item("F4", { full: true, stock: 0 }), item("F5", { full: true, stock: 9, estado: "paused" })];
  const r = armar(lineas, items, { costoPorItem: costo });
  eq(r.fullVentasBajas.map((x) => x.id), ["F1", "F3"], "F1 (2 u) y F3 (0 u) con stock; no F2 (40 u), F4 (sin stock) ni F5 (pausada)");
  eq([r.fullVentasBajas[0].capital, r.fullVentasBajas[1].capital], [50000, null], "capital inmovilizado = stock × Costo (null sin Costo)");
}

console.log(`\n${ok} comprobaciones OK`);

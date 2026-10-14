// Pruebas del Forecast por modo (lib/forecast.ts + /api/forecast). Sin red: datos sintéticos y readSheet simulado.
// Uso:  node scripts/test-forecast-modo.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ts = require(path.join(PROJ, "node_modules", "typescript"));
const out = fs.mkdtempSync(path.join(os.tmpdir(), "forecast-modo-test-"));
const compilar = (origen, destino) => {
  const src = fs.readFileSync(path.join(PROJ, origen), "utf8").replace(/from "@\/lib\/([\w-]+)"/g, 'from "./$1"');
  fs.writeFileSync(path.join(out, destino), ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);
};
for (const [o, d] of [["lib/forecast-demanda.ts", "forecast-demanda.js"], ["lib/forecast.ts", "forecast.js"], ["lib/logistica.ts", "logistica.js"], ["app/api/forecast/route.ts", "route.js"]]) compilar(o, d);
fs.writeFileSync(path.join(out, "log.js"), "exports.logError = () => {};");
fs.writeFileSync(path.join(out, "sheets.js"), "exports.readSheet = async (range) => globalThis.__leer(range);");
fs.mkdirSync(path.join(out, "node_modules", "next"), { recursive: true });
fs.writeFileSync(path.join(out, "node_modules", "next", "server.js"), "exports.NextResponse = { json: (b, i) => ({ body: b, status: i?.status ?? 200 }) }; exports.NextRequest = class {};");
const F = require(path.join(out, "forecast.js")); const D = require(path.join(out, "forecast-demanda.js")); const { GET } = require(path.join(out, "route.js"));
let ok = 0; const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); ok++; console.log("  ✓", m); }; const check = (c, m) => { assert.ok(c, m); ok++; console.log("  ✓", m); };

const hoy = new Date(2026, 9, 14); const desde = new Date(hoy.getTime() - 30 * 86400000);
const dia = (n) => { const d = new Date(hoy.getTime() - n * 86400000); return `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${d.getFullYear()}`; };
const v = (orden, haceDias, cant, estado, item, k) => ["'" + orden, dia(haceDias), "t", "sku", cant, 1000, 1000, "c", estado, item, k ?? ""];

console.log("modo por tipo y clasificación de la publicación");
eq([F.modoDeTipo("fulfillment"), F.modoDeTipo("xd_drop_off"), F.modoDeTipo("cross_docking"), F.modoDeTipo("self_service"), F.modoDeTipo(""), F.modoDeTipo("  ")], ["full", "normal", "normal", "normal", null, null], "Full = fulfillment; cualquier otro valor = Normal; vacío = sin dato");
eq(F.clasificarPublicacion("fulfillment", "normal"), { modo: "full", fuente: "publicacion" }, "T llena: manda T aunque la última venta sea Normal");
eq(F.clasificarPublicacion("xd_drop_off", "full"), { modo: "normal", fuente: "publicacion" }, "T llena (xd_drop_off) → Normal");
eq(F.clasificarPublicacion("", "full"), { modo: "full", fuente: "ultima_venta" }, "T vacía → respaldo por la última venta clasificada");
eq(F.clasificarPublicacion("", undefined), { modo: "sin_clasificar", fuente: "ninguna" }, "T vacía y sin ventas clasificadas → Sin clasificar");

console.log("tipo de la orden: columna K y, si falta, ShippingCache");
{ const cache = new Map([["77", "fulfillment"]]);
  eq(F.tipoDeOrden(v("77", 1, 1, "paid", "A", "xd_drop_off"), cache), "xd_drop_off", "K manda sobre ShippingCache");
  eq(F.tipoDeOrden(v("77", 1, 1, "paid", "A", ""), cache), "fulfillment", "K vacía → ShippingCache (el backfill escribe ahí sin tocar Ventas); el «'» del ID se ignora");
  eq(F.tipoDeOrden(v("88", 1, 1, "paid", "A", ""), cache), "", "sin K ni cache → «»"); }

console.log("demanda por modo");
{ const cache = new Map([["3", "fulfillment"]]);
  const filas = [v("1", 2, 2, "paid", "A", "fulfillment"), v("2", 3, 3, "paid", "A", "xd_drop_off"), v("3", 4, 4, "paid", "A", ""), v("4", 5, 5, "paid", "A", ""), v("5", 6, 7, "cancelled", "A", "fulfillment"), v("6", 60, 9, "paid", "A", "fulfillment")];
  const d = F.demandaPorItem(filas, desde, cache);
  eq(d.get("A"), { total: 14, full: 6, normal: 3, sinTipo: 5 }, "desglosa Full (K y cache), Normal y sin tipo; excluye canceladas y lo anterior a la ventana");
  eq([...D.unidadesPorItem(filas, desde)], [["A", d.get("A").total]], "el total coincide con unidadesPorItem (commit de canceladas)"); }

console.log("última venta clasificada");
{ const U = (f) => Object.fromEntries(F.ultimaVentaClasificada(f, new Map()));
  eq(U([v("1", 10, 1, "paid", "A", "xd_drop_off"), v("2", 2, 1, "paid", "A", "fulfillment")]), { A: "full" }, "gana la venta más reciente");
  eq(U([v("1", 10, 1, "paid", "A", "fulfillment"), v("2", 2, 1, "cancelled", "A", "xd_drop_off"), v("3", 1, 1, "paid", "A", "")]), { A: "full" }, "ignora canceladas y ventas sin tipo");
  eq(U([v("1", 3, 5, "paid", "A", "xd_drop_off"), v("2", 3, 2, "paid", "A", "fulfillment")]), { A: "normal" }, "empate de fecha: el modo con más unidades");
  eq(U([v("1", 3, 2, "paid", "A", "xd_drop_off"), v("2", 3, 2, "paid", "A", "fulfillment")]), { A: "full" }, "empate total: Full");
  eq(U([v("1", 3, 2, "paid", "A", "")]), {}, "sin ventas clasificadas → no aparece"); }

console.log("filas: plazos por modo, stock, «migró»");
{ const pubs = [
    { id: "F1", titulo: "Full", stock: 30, estadoML: "active", tipoT: "fulfillment" }, { id: "N1", titulo: "Normal", stock: 30, estadoML: "active", tipoT: "xd_drop_off" },
    { id: "S1", titulo: "Sin T, venta Full", stock: 10, estadoML: "active", tipoT: "" }, { id: "X1", titulo: "Sin nada", stock: 10, estadoML: "paused", tipoT: "" },
    { id: "M1", titulo: "Migró a Full", stock: 5, estadoML: "active", tipoT: "fulfillment" }, { id: "M2", titulo: "Salió de Full", stock: 5, estadoML: "active", tipoT: "xd_drop_off" }];
  const demanda = new Map([["F1", { total: 30, full: 30, normal: 0, sinTipo: 0 }], ["N1", { total: 30, full: 0, normal: 30, sinTipo: 0 }], ["S1", { total: 30, full: 30, normal: 0, sinTipo: 0 }], ["M1", { total: 13, full: 3, normal: 7, sinTipo: 3 }], ["M2", { total: 4, full: 4, normal: 0, sinTipo: 0 }]]);
  const rows = F.armarFilasForecast({ publicaciones: pubs, demanda, ultimaVenta: new Map([["S1", "full"]]), parametros: { full: { lead: 20, safety: 10 }, normal: { lead: 15, safety: 7 } }, hoy });
  const r = Object.fromEntries(rows.map((x) => [x.id, x]));
  eq([r.F1.modo, r.N1.modo, r.S1.modo, r.X1.modo], ["full", "normal", "full", "sin_clasificar"], "modos: T llena, T llena, respaldo por última venta, sin clasificar");
  eq([r.S1.fuenteModo, r.F1.fuenteModo, r.X1.fuenteModo], ["ultima_venta", "publicacion", "ninguna"], "fuente del modo registrada en cada fila");
  eq([r.F1.leadTimeDays, r.F1.safetyDays, r.N1.leadTimeDays, r.N1.safetyDays, r.X1.leadTimeDays], [20, 10, 15, 7, 15], "plazos por modo; Sin clasificar usa los de Normal");
  eq([r.F1.cantidadSugerida, r.N1.cantidadSugerida], [Math.max(0, Math.ceil(1 * 30 - 30)), Math.max(0, Math.ceil(1 * 22 - 30))], "sugerido = velocidad × (lead + seguridad) − stock con los plazos de cada modo (Full 30 días, Normal 22)");
  eq([r.M1.migro, r.M2.migro, r.F1.migro, r.N1.migro, r.X1.migro], [true, true, false, false, false], "«migró»: vendió en el modo contrario al actual (en ambos sentidos)");
  eq([r.M1.ventasFull30d, r.M1.ventasNormal30d, r.M1.ventasSinTipo30d, r.M1.ventas30d], [3, 7, 3, 13], "la demanda es la TOTAL (13) y se conserva el desglose por modo");
  eq(r.X1.prioridad, "SIN_DATOS", "sin ventas y con stock → SIN_DATOS"); check(rows.length === 6, "todas las publicaciones quedan en rows (compatibilidad)");

  console.log("resumen");
  const res = F.armarResumen(rows, new Map([["F1", "SKU-A"], ["N1", "SKU-A"], ["S1", "SKU-B"], ["M1", "SKU-C"], ["M2", "SKU-C"], ["X1", "SKU-A"]]));
  eq([res.porModo.full.publicaciones, res.porModo.normal.publicaciones, res.porModo.sin_clasificar.publicaciones, res.sinClasificar], [3, 2, 1, 1], "publicaciones por modo y cuenta de Sin clasificar");
  eq([res.porModo.full.stockUnidades, res.porModo.full.ventas30d], [30 + 10 + 5, 30 + 30 + 13], "totales del modo: stock y ventas 30 días");
  eq(res.porFuente, { publicacion: 4, ultima_venta: 1, ninguna: 1 }, "cuántas se clasificaron por T, por la última venta o por nada");
  eq(res.skusEnAmbosModos.map((x) => [x.sku, x.full, x.normal]), [["SKU-A", ["F1"], ["N1"]], ["SKU-C", ["M1"], ["M2"]]], "SKU en ambos modos (la publicación sin clasificar no cuenta)");
  eq(res.migraron.map((x) => [x.id, x.full, x.normal, x.sinTipo]), [["M1", 3, 7, 3], ["M2", 4, 0, 0]], "migraron: desglose por modo, ordenadas por volumen"); }

console.log("endpoint: T llena, T vacía y fila corta de 19 columnas");
{ const pub = (id, stock, estado, t) => { const f = Array(19).fill(""); f[0] = id; f[2] = "Prod " + id; f[3] = stock; f[10] = estado; if (t !== undefined) f[19] = t; return f; };
  const PUB = [pub("L1", 50, "active", "fulfillment"), pub("L2", 50, "active", "xd_drop_off"), pub("L3", 50, "active", ""), pub("L4", 50, "active"), pub("L5", 8, "closed", "fulfillment")];
  const VEN = [v("1", 2, 30, "paid", "L1", "fulfillment"), v("2", 2, 30, "paid", "L2", "xd_drop_off"), v("3", 2, 30, "paid", "L3", "fulfillment"), v("4", 2, 30, "paid", "L4", "xd_drop_off")];
  globalThis.__leer = async (range) => range.startsWith("Publicaciones") ? PUB : range.startsWith("Ventas") ? VEN : range.startsWith("ShippingCache") ? [] : range.startsWith("CostoOrigen") ? [["L1", "S1", "", "", "", "", "COD-1"], ["L2", "", "", "", "", "", "COD-1"]] : [];
  const pedir = async (qs) => (await GET({ url: "http://x/api/forecast" + qs })).body;
  const b = await pedir(""); const m = Object.fromEntries(b.rows.map((x) => [x.id, x]));
  check(b.ok && b.rows.length === 4, "devuelve las publicaciones no cerradas (4 de 5)");
  eq([m.L1.modo, m.L2.modo, m.L3.modo, m.L4.modo], ["full", "normal", "full", "normal"], "T llena manda (L1, L2); T vacía (L3) y fila corta (L4) → respaldo por la última venta clasificada");
  eq([m.L1.fuenteModo, m.L3.fuenteModo, m.L4.fuenteModo], ["publicacion", "ultima_venta", "ultima_venta"], "la fuente del modo queda registrada");
  eq([b.leadTimeDays, b.safetyDays, b.parametros], [15, 7, { full: { lead: 15, safety: 7 }, normal: { lead: 15, safety: 7 } }], "valores por defecto 15 y 7 para los dos modos; leadTimeDays/safetyDays siguen en la respuesta");
  eq(b.resumen.skusEnAmbosModos.map((x) => x.sku), ["COD-1"], "el resumen lista el SKU de CostoOrigen que está en Full y en Normal");
  const c = await pedir("?leadTimeDays=10&safetyDays=3&leadTimeFull=25&safetyFull=0"); eq(c.parametros, { full: { lead: 25, safety: 0 }, normal: { lead: 10, safety: 3 } }, "plazos distintos por modo; el margen de seguridad 0 es válido");
  const d = await pedir("?leadTimeDays=abc&safetyDays=-4&leadTimeNormal=0"); eq(d.parametros, { full: { lead: 15, safety: 7 }, normal: { lead: 15, safety: 7 } }, "valores inválidos (texto, negativo, lead 0) vuelven al valor por defecto");
  const cambia = (await pedir("?leadTimeFull=60")).rows.find((x) => x.id === "L1"); check(cambia.leadTimeDays === 60 && cambia.cantidadSugerida > m.L1.cantidadSugerida, "subir el plazo de Full sube el sugerido de las publicaciones Full y no el de las Normal");
  const e = await pedir("?leadTimeFull=60"); eq(e.rows.find((x) => x.id === "L2").cantidadSugerida, m.L2.cantidadSugerida, "…el de las Normal no cambia");
  globalThis.__leer = async (range) => { if (range.startsWith("CostoOrigen")) throw new Error("no existe la pestaña"); return range.startsWith("Publicaciones") ? PUB : range.startsWith("Ventas") ? VEN : []; };
  const f = await pedir(""); check(f.ok && f.resumen.skusEnAmbosModos.length === 0 && /CostoOrigen/.test(f.avisoTope), "si CostoOrigen no se puede leer, el Forecast sigue y avisa"); }
console.log("archivo de pedido (hojas del XLSX)");
{ const pubs = [{ id: "F1", titulo: "Full urgente", stock: 5, estadoML: "active", tipoT: "fulfillment" }, { id: "F2", titulo: "Full OK", stock: 500, estadoML: "active", tipoT: "fulfillment" }, { id: "N1", titulo: "Normal sin stock", stock: 0, estadoML: "active", tipoT: "xd_drop_off" }, { id: "S1", titulo: "Sin clasificar", stock: 0, estadoML: "active", tipoT: "" }];
  const demanda = new Map([["F1", { total: 30, full: 20, normal: 10, sinTipo: 0 }], ["F2", { total: 30, full: 30, normal: 0, sinTipo: 0 }], ["N1", { total: 15, full: 0, normal: 15, sinTipo: 0 }], ["S1", { total: 6, full: 0, normal: 0, sinTipo: 6 }]]);
  const parametros = { full: { lead: 15, safety: 7 }, normal: { lead: 10, safety: 5 } }; const rows = F.armarFilasForecast({ publicaciones: pubs, demanda, ultimaVenta: new Map(), parametros, hoy });
  const resumen = F.armarResumen(rows, new Map()); const h = F.hojasPedido({ rows, resumen, parametros, notas: ["nota de ejemplo"], generado: "ahora" });
  eq(Object.keys(h), ["Full", "Normal", "Sin clasificar", "Resumen"], "el archivo tiene las hojas Full, Normal, Sin clasificar y Resumen");
  eq(h.Full.slice(1).map((f) => f[0]), ["Full urgente"], "la hoja Full solo trae lo que hay que pedir de Full (Full OK queda fuera)");
  eq(h.Normal.slice(1).map((f) => [f[0], f[6], f[8]]), [["Normal sin stock", Math.ceil((15 / 30) * 15), 15]], "la hoja Normal trae lo de Normal con su sugerido y su plazo (10 + 5)");
  eq(h["Sin clasificar"].slice(1).map((f) => f[0]), ["Sin clasificar"], "la hoja Sin clasificar trae lo suyo");
  check(h.Full[1][9] === "Full 20 · Normal 10", "la hoja Full indica el desglose por modo de las que migraron");
  check(h.Full[0].length === h.Full[1].length && h.Normal[0].length === h.Normal[1].length, "encabezados y filas tienen el mismo ancho");
  const flat = h.Resumen.map((f) => f.join(" | ")).join("\n"); check(/Full \| 15 \+ 7 = 22 días \(Tablero: 30\)/.test(flat) && /Normal \/ Sin clasificar \| 10 \+ 5 = 15 días/.test(flat), "el Resumen indica los plazos por modo y la comparación con el Tablero");
  check(/Publicaciones Sin clasificar \| 1/.test(flat) && /nota de ejemplo/.test(flat) && /SKU en Full y en Normal/.test(flat) && /Publicaciones que migraron de modo/.test(flat), "el Resumen trae la cuenta de Sin clasificar, SKU en ambos modos, migraron y las diferencias con el Tablero"); }
console.log("tipo logístico poco claro (not_specified)");
{ const mk = (id, tipoT) => ({ id, titulo: "P " + id, stock: 0, estadoML: "active", tipoT }); const dem = new Map([["A", { total: 15, full: 0, normal: 15, sinTipo: 0 }], ["B", { total: 15, full: 0, normal: 15, sinTipo: 0 }], ["C", { total: 15, full: 0, normal: 15, sinTipo: 0 }]]);
  const rows = F.armarFilasForecast({ publicaciones: [mk("A", "not_specified"), mk("B", "xd_drop_off"), mk("C", "")], demanda: dem, ultimaVenta: new Map([["C", "normal"]]), parametros: { full: { lead: 15, safety: 7 }, normal: { lead: 15, safety: 7 } }, hoy });
  eq(rows.map((r) => [r.id, r.modo, F.tipoNormalPocoClaro(r)]).sort(), [["A", "normal", true], ["B", "normal", false], ["C", "normal", false]], "not_specified es Normal y se marca como poco claro; xd_drop_off y el respaldo por última venta no");
  const res = F.armarResumen(rows, new Map()); eq(res.tipoPocoClaro, [{ id: "A", titulo: "P A", tipo: "not_specified" }], "el resumen lista las poco claras");
  const hj = F.hojasPedido({ rows, resumen: res, parametros: { full: { lead: 15, safety: 7 }, normal: { lead: 15, safety: 7 } }, notas: [], generado: "x" }); check(hj.Normal.find((f) => f[0] === "P A")[10].includes("not_specified") && hj.Normal.find((f) => f[0] === "P B")[10] === "", "la hoja Normal trae la NOTA solo en la publicación poco clara"); }
console.log("\n" + ok + " comprobaciones OK");

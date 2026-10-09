// Pruebas del muestreo de TarifaEnvio por (publicación, tipo logístico): lib/tarifa-envio.ts. Sin red: ML y la
// hoja son simulados.
// Uso:  node scripts/test-tarifa-envio-tipo.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ts = require(path.join(PROJ, "node_modules", "typescript"));
const out = fs.mkdtempSync(path.join(os.tmpdir(), "tarifa-tipo-test-"));
for (const f of ["envio-real", "envio-estimado", "tarifa-envio"]) {
  let js = ts.transpileModule(fs.readFileSync(`${PROJ}/lib/${f}.ts`, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText;
  js = js.replace(/require\("@\/lib\/([a-z-]+)"\)/g, 'require("./$1.js")');
  fs.writeFileSync(path.join(out, f + ".js"), js);
}
const T = require(path.join(out, "tarifa-envio.js"));
let ok = 0; const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); ok++; console.log("  ✓", m); };
const check = (c, m) => { assert.ok(c, m); ok++; console.log("  ✓", m); };

// ---- ML simulado: despachos y costos por id ----
const F = "fulfillment", X = "xd_drop_off";
const DESP = {
  1: { t: F, items: [["A", 1]], cost: 410 },
  2: { t: X, items: [["A", 1]], cost: 810 },
  3: { t: X, items: [["A", 2]], cost: 1620 },
  4: { t: X, items: [["A", 1], ["B", 1]], cost: 1620 },   // mixto
  5: { t: F, items: [["C", 1]], cost: 260 },
  6: { t: X, items: [["C", 1]], cost: 0 },                // costo 0 = dato faltante
  7: { t: X, items: [["D", 1]], cost: 830 },
  8: { t: F, items: [["E", 1]], cost: 410 },
  9: { t: X, items: [["E", 1]], cost: 830 },
  10: { t: X, items: [["D", 1]], cost: 0 },              // costo 0 de D
  11: { t: X, items: [["G", 1]], cost: 850, s: "ready_to_ship" }, // despacho aún no entregado
  12: { t: X, items: [["H", 1]], cost: 900, s: "delivered" },
  13: { t: X, items: [["H", 1]], cost: 900, s: "ready_to_ship" },
};
const llamadas = [];
const mlGet = async (url) => {
  llamadas.push(url);
  let m = url.match(/^\/shipments\/(\d+)\/costs$/);
  if (m) { const d = DESP[m[1]]; return { data: { senders: [{ cost: d.cost }] } }; }
  m = url.match(/^\/shipments\/(\d+)$/);
  if (m) { const d = DESP[m[1]]; return { data: { logistic_type: d.t, status: d.s ?? "delivered", shipping_items: d.items.map(([id, quantity]) => ({ id, quantity })) } }; }
  throw new Error("url inesperada " + url);
};
const desp = (...ids) => ids.map((shippingId) => ({ shippingId, fecha: "2026-10-01" }));

console.log("calcularTarifaItem con tipoObjetivo");
{
  const r = await T.calcularTarifaItem("A", desp(1, 2, 3, 4), mlGet, 2, 6, "otro");
  eq([r.estado, r.tarifaPorUnidad, r.tipoLogistico, r.muestras], ["ok", 810, X, 2], "objetivo despacho: toma los despachos de despacho (810 y 1620/2), ignora el de Full y el mixto");
  const f = await T.calcularTarifaItem("A", desp(1, 2, 3), mlGet, 2, 6, "fulfillment");
  eq([f.estado, f.tarifaPorUnidad, f.tipoLogistico, f.muestras], ["ok", 410, F, 1], "objetivo Full: una sola muestra limpia → ok con muestras = 1");
  const nada = await T.calcularTarifaItem("C", desp(5), mlGet, 2, 6, "otro");
  eq([nada.estado, nada.tarifaPorUnidad, nada.muestras], ["sin_muestra", null, 0], "sin despachos del tipo objetivo: sin_muestra");
  const mix = await T.calcularTarifaItem("A", desp(4), mlGet, 2, 6, "otro");
  eq(mix.estado, "solo_despachos_mixtos", "solo despachos mixtos del tipo objetivo");
  const cero = await T.calcularTarifaItem("C", desp(6), mlGet, 2, 6, "otro");
  eq(cero.estado, "sin_costo", "costo $0 se trata como dato faltante");
  const sinObj = await T.calcularTarifaItem("A", desp(2, 1), mlGet);
  eq([sinObj.tipoLogistico, sinObj.tarifaPorUnidad, sinObj.muestras], [X, 810, 1], "sin tipoObjetivo (comportamiento anterior): la primera muestra limpia fija el tipo");
}

console.log("obtenerVentasPorItem con el tipo de cada orden");
{
  const orden = (id, item, q, p, ship, fecha) => ({ id, date_created: fecha, status: "paid", shipping: { id: ship }, order_items: [{ item: { id: item }, quantity: q, unit_price: p, sale_fee: 100 }] });
  const ordenes = [orden(11, "A", 1, 9000, 1, "2026-10-05T10:00:00Z"), orden(12, "A", 2, 9000, 2, "2026-10-04T10:00:00Z"), orden(13, "A", 1, 9000, 3, "2026-10-03T10:00:00Z"), orden(14, "B", 1, 5000, 7, "2026-10-02T10:00:00Z")];
  const ml = async (url) => ({ data: { paging: { total: ordenes.length }, results: ordenes } });
  const tipos = new Map([["11", F], ["12", X]]); // la 13 y la 14 sin tipo conocido
  const v = await T.obtenerVentasPorItem(ml, 1, 45, new Date("2026-10-09T00:00:00Z"), tipos);
  const a = v.get("A");
  eq(a.despachosPorTipo.fulfillment.map((d) => d.shippingId), [1, 3], "despachos Full: el tipado Full y el sin tipo conocido");
  eq(a.despachosPorTipo.otro.map((d) => d.shippingId), [2, 3], "despachos de despacho: el tipado y el sin tipo conocido (el muestreo verifica el tipo con /shipments)");
  eq([a.ingresoPorTipo.fulfillment, a.ingresoPorTipo.otro], [9000, 18000], "el ingreso por tipo solo cuenta las órdenes con tipo conocido");
  eq(a.tipoCrudo, { fulfillment: F, otro: X }, "tipo crudo observado por grupo");
  const sinTipos = await T.obtenerVentasPorItem(ml, 1, 45, new Date("2026-10-09T00:00:00Z"));
  eq(sinTipos.get("A").despachosPorTipo, undefined, "sin tipos por orden: comportamiento anterior (sin despachosPorTipo)");
  eq(T.paresConVenta(v, new Map([["B", F]])).map((p) => p.clave).sort(), ["A|F", "A|N", "B|F"], "pares: A vendió en los dos tipos; B no tiene ventas tipadas → un par con el tipo vigente de la publicación (Full)");
  eq(T.paresConVenta(v).map((p) => p.clave).sort(), ["A|F", "A|N", "B|N"], "sin tipo vigente conocido, el par de B cae en el grupo \"otro\"");
}
console.log("paresConVenta");
{
  const vt = (ing, desp, crudo) => ({ ingreso: 1, precio: 1, comision: 0, ingresoConComision: 0, despachos: [], despachosPorTipo: desp, ingresoPorTipo: ing, tipoCrudo: crudo });
  const ventas = new Map([
    ["A", vt({ fulfillment: 100, otro: 50 }, { fulfillment: desp(1), otro: desp(2) }, { fulfillment: F, otro: X })],
    ["B", vt({ fulfillment: 100, otro: 0 }, { fulfillment: desp(5), otro: [] }, { fulfillment: F })],
    ["C", { ingreso: 10, precio: 1, comision: 0, ingresoConComision: 0, despachos: desp(5) }],
  ]);
  const p = T.paresConVenta(ventas, new Map([["C", F]]));
  eq(p.map((x) => x.clave).sort(), ["A|F", "A|N", "B|F", "C|F"], "un par por tipo con ventas tipadas; sin tipos, uno con el tipo vigente");
  eq(p.find((x) => x.clave === "A|N").tipoCrudo, X, "el par conserva el tipo crudo");
}

console.log("procesarTarifas: clave (publicación, tipo)");
const ahora = new Date("2026-10-10T12:00:00Z");
const fila = (id, tarifa, tipo, estado = "ok", act = "2026-10-05T00:00:00.000Z", sku = "") => [id, sku, String(tarifa), tipo, "2", "0", "1", "1", estado, act, "", ""];
function hoja(filas) {
  const escritas = { append: [], batch: [], write: [] };
  return {
    escritas,
    readSheet: async (r) => (r.includes("A1:L1") ? [["x"]] : r.includes("ShippingCache") ? [] : filas.map((f) => [...f])),
    writeSheet: async (r, v) => { escritas.write.push([r, v]); },
    appendSheet: async (r, v) => { escritas.append.push([r, v]); },
    batchWriteSheet: async (u) => { escritas.batch.push(u); },
  };
}
const ventasAB = () => {
  const mk = (ing, desp, crudo) => ({ ingreso: 1, precio: 9000, comision: 0, ingresoConComision: 0, despachos: [], despachosPorTipo: desp, ingresoPorTipo: ing, tipoCrudo: crudo });
  return new Map([
    ["A", mk({ fulfillment: 9000, otro: 18000 }, { fulfillment: desp(1), otro: desp(2, 3) }, { fulfillment: F, otro: X })],
  ]);
};
const base = (h, extra = {}) => ({ mlGet, ...h, ventas: ventasAB(), skuPorItem: new Map([["A", "S1"]]), ahora, dryRun: false, forzar: false, limite: null, tiempoMaximoMs: 30000, ...extra });
{
  const h = hoja([fila("A", 410, F)]);
  const r = await T.procesarTarifas(base(h));
  eq([r.paresConVenta, r.vigentes, r.pendientesAntes, r.procesadas], [2, 1, 1, 1], "A tiene fila Full vigente: solo falta el par A|despacho");
  eq(h.escritas.append.length, 1, "una escritura de filas nuevas");
  const nueva = h.escritas.append[0][1][0];
  eq([nueva[0], nueva[2], nueva[3], nueva[4], nueva[8]], ["A", "810", X, "2", "ok"], "fila nueva: publicación, tarifa 810, tipo xd_drop_off, Muestras = 2, estado ok");
  eq(h.escritas.batch.length, 0, "no actualiza la fila de Full");
  eq(r.porMuestras, { 2: 1 }, "el resultado resume cuántas filas salieron con 0, 1 o 2 muestras");
}
{
  const h = hoja([fila("A", 410, F)]);
  const r = await T.procesarTarifas(base(h, { dryRun: true }));
  eq([r.procesadas, h.escritas.append.length, h.escritas.batch.length, h.escritas.write.length], [1, 0, 0, 0], "en simulación no escribe nada");
}
console.log("guarda de claves repetidas");
{
  let error = null;
  try { await T.procesarTarifas(base(hoja([fila("A", 410, F), fila("A", 810, X)]))); } catch (e) { error = e; }
  eq(error, null, "dos filas de la misma publicación con tipos distintos NO abortan");
  error = null;
  try { await T.procesarTarifas(base(hoja([fila("A", 810, X), fila("A", 830, X)]))); } catch (e) { error = e; }
  check(error && /misma publicación y tipo/.test(error.message), "dos filas con la MISMA clave (publicación, tipo) abortan");
  error = null;
  try { await T.procesarTarifas(base(hoja([fila("A", 410, F), fila("A", 420, F)]))); } catch (e) { error = e; }
  check(!!error, "ídem para Full");
}
console.log("vigencia y modo piloto por clave");
{
  // fila de Full vencida (40 días) y fila de despacho vigente: solo el par Full está pendiente
  const h = hoja([fila("A", 410, F, "ok", "2026-08-20T00:00:00.000Z"), fila("A", 810, X, "ok", "2026-10-08T00:00:00.000Z")]);
  const r = await T.procesarTarifas(base(h));
  eq([r.pendientesAntes, r.escritas], [1, { nuevas: 0, actualizadas: 1 }], "la vigencia es por clave: la de Full vencida se actualiza en su propia fila");
  const rango = h.escritas.batch[0][0].range;
  eq(rango, "TarifaEnvio!A2:L2", "se actualiza la fila de Full (la 2), no la de despacho");
  // piloto: solo pares sin NINGUNA fila de su tipo
  const h2 = hoja([fila("A", 410, F, "ok", "2026-08-20T00:00:00.000Z")]);
  const r2 = await T.procesarTarifas(base(h2, { soloSinFilaDelTipo: true }));
  eq([r2.pendientesAntes, r2.escritas], [1, { nuevas: 1, actualizadas: 0 }], "soloSinFilaDelTipo: ignora el par Full (tiene fila aunque esté vencida) y toma el de despacho");
}
console.log("par sin muestra limpia: estimador sin la propia publicación");
{
  // D solo vendió por despacho, con un único despacho cuyo costo es 0 (sin muestra) → estimada
  const ventas = new Map([["D", { ingreso: 1, precio: 9000, comision: 0, ingresoConComision: 0, despachos: [], despachosPorTipo: { fulfillment: [], otro: desp(10) }, ingresoPorTipo: { fulfillment: 0, otro: 9000 }, tipoCrudo: { otro: X } }]]);
  // muestras vigentes en la hoja: P (despacho, $8k, 810), Q (despacho, $9k, 830)
  const filas = [fila("P", 810, X), fila("Q", 830, X)];
  const ventasConP = new Map([...ventas, ["P", { ingreso: 1, precio: 8000, comision: 0, ingresoConComision: 0, despachos: [] }], ["Q", { ingreso: 1, precio: 9000, comision: 0, ingresoConComision: 0, despachos: [] }]]);
  const h = hoja(filas);
  const r = await T.procesarTarifas(base(h, { ventas: ventasConP, skuPorItem: new Map(), soloSinFilaDelTipo: true, limite: 1 }));
  const nueva = h.escritas.append[0][1][0];
  eq([nueva[0], nueva[2], nueva[3], nueva[4], nueva[8], nueva[11]], ["D", "820", X, "0", "estimado", "sin_costo"], "sin muestra limpia: fila estimada (mediana del tramo de despacho), tipo del par, Muestras = 0 y motivo");
  eq(r.porEstado, { estimado: 1 }, "cuenta como estimada");
}
console.log("estimador: no usa la tarifa del otro tipo de la propia publicación");
{
  // D tiene fila Full medida (410, SKU S9) y vendió por despacho sin muestra limpia. Su gemela R (SKU S9) tiene despacho 830.
  const mk = (precio) => ({ ingreso: 1, precio, comision: 0, ingresoConComision: 0, despachos: [] });
  const ventas = new Map([["D", { ...mk(9000), despachosPorTipo: { fulfillment: [], otro: desp(10) }, ingresoPorTipo: { fulfillment: 0, otro: 9000 }, tipoCrudo: { otro: X } }], ["R", mk(9000)]]);
  const h = hoja([fila("D", 410, F, "ok", "2026-10-05T00:00:00.000Z", "S9"), fila("R", 830, X, "ok", "2026-10-05T00:00:00.000Z", "S9")]);
  await T.procesarTarifas(base(h, { ventas, skuPorItem: new Map([["D", "S9"], ["R", "S9"]]), soloSinFilaDelTipo: true }));
  const nueva = h.escritas.append[0][1][0];
  eq([nueva[2], nueva[10]], ["830", "sku (n=1)"], "SKU gemelo = R (830, n=1); con la Full de la propia D sería la mediana 620 (n=2)");
}
console.log("una sola muestra");
{
  const ventas = new Map([["D", { ingreso: 1, precio: 9000, comision: 0, ingresoConComision: 0, despachos: [], despachosPorTipo: { fulfillment: [], otro: desp(7) }, ingresoPorTipo: { fulfillment: 0, otro: 9000 }, tipoCrudo: { otro: X } }]]);
  const h = hoja([]);
  const r = await T.procesarTarifas(base(h, { ventas, skuPorItem: new Map() }));
  const f = h.escritas.append[0][1][0];
  eq([f[2], f[4], f[8]], ["830", "1", "ok"], "con un solo despacho candidato la fila queda ok con Muestras = 1");
  eq(r.porMuestras, { 1: 1 }, "porMuestras refleja el 1");
}
console.log("modo anterior (sin tipo por orden): se comporta como antes");
{
  const ventasLegacy = () => new Map([["A", { ingreso: 1, precio: 9000, comision: 0, ingresoConComision: 0, despachos: desp(2, 3) }]]);
  const lega = (h, extra = {}) => ({ mlGet, ...h, ventas: ventasLegacy(), skuPorItem: new Map(), logisticoPorItem: new Map([["A", X]]), ahora, dryRun: false, forzar: false, limite: null, tiempoMaximoMs: 30000, ...extra });
  const h1 = hoja([fila("A", 410, F)]);
  const r1 = await T.procesarTarifas(lega(h1));
  eq([r1.pendientesAntes, r1.vigentes, h1.escritas.append.length], [0, 1, 0], "una fila vigente de la publicación basta (la clave es la publicación), aunque su tipo no sea el vigente");
  const h2 = hoja([fila("A", 410, F, "ok", "2026-08-20T00:00:00.000Z")]);
  const r2 = await T.procesarTarifas(lega(h2));
  eq([r2.escritas, h2.escritas.batch[0][0].range], [{ nuevas: 0, actualizadas: 1 }, "TarifaEnvio!A2:L2"], "fila vencida: se actualiza en su lugar, sin agregar filas");
  eq(h2.escritas.batch[0][0].values[0][3], X, "la primera muestra limpia fija el tipo de la fila (sin tipo objetivo)");
  let error = null;
  try { await T.procesarTarifas(lega(hoja([fila("A", 410, F), fila("A", 810, X)]))); } catch (e) { error = e; }
  check(error && /usar porTipo/.test(error.message), "dos filas de la misma publicación (filas por tipo) abortan en el modo anterior y piden usar porTipo");
}
console.log("soloMuestraReal: solo se escriben las filas medidas");
{
  const mk = (desps, ing, crudo) => ({ ingreso: 1, precio: 9000, comision: 0, ingresoConComision: 0, despachos: [], despachosPorTipo: { fulfillment: [], otro: desps }, ingresoPorTipo: { fulfillment: 0, otro: ing }, tipoCrudo: crudo });
  // A|despacho tiene muestra limpia (2 y 3); D|despacho solo tiene un despacho con costo 0 → quedaría estimada
  const ventas = new Map([["A", mk(desp(2, 3), 18000, { otro: X })], ["D", mk(desp(10), 9000, { otro: X })]]);
  const h = hoja([fila("P", 810, X), fila("Q", 830, X)]);
  const r = await T.procesarTarifas(base(h, { ventas: new Map([...ventas, ["P", { ingreso: 1, precio: 8000, comision: 0, ingresoConComision: 0, despachos: [] }], ["Q", { ingreso: 1, precio: 9000, comision: 0, ingresoConComision: 0, despachos: [] }]]), skuPorItem: new Map(), soloSinFilaDelTipo: true, soloMuestraReal: true }));
  eq([r.procesadas, r.escritas, r.omitidas], [2, { nuevas: 1, actualizadas: 0 }, 1], "se calculan 2 pares, se escribe 1 (la medida) y se omite 1 (la que quedaría estimada)");
  const filas = h.escritas.append[0][1];
  eq(filas.map((x) => [x[0], x[8], x[4]]), [["A", "ok", "2"]], "la única fila escrita es la medida, con Muestras = 2");
  eq(r.filas.find((x) => x.itemId === "D").r.estado, "sin_costo", "la omitida figura en el informe con su estado real (sin estimar: no se calcula el respaldo)");
  const hs = hoja([]);
  const rs = await T.procesarTarifas(base(hs, { ventas, skuPorItem: new Map(), soloSinFilaDelTipo: true, soloMuestraReal: true, dryRun: true }));
  eq([rs.omitidas, hs.escritas.append.length], [1, 0], "en simulación informa lo que omitiría y no escribe nada");
}
console.log("soloEntregados: no se escriben filas apoyadas en despachos sin entregar");
{
  const mk = (desps, ing) => ({ ingreso: 1, precio: 9000, comision: 0, ingresoConComision: 0, despachos: [], despachosPorTipo: { fulfillment: [], otro: desps }, ingresoPorTipo: { fulfillment: 0, otro: ing }, tipoCrudo: { otro: X } });
  // A: 2 despachos entregados; G: 1 despacho listo para despachar; H: 1 entregado + 1 sin entregar (muestra mixta de estados)
  const ventas = new Map([["A", mk(desp(2, 3), 18000)], ["G", mk(desp(11), 9000)], ["H", mk(desp(12, 13), 9000)]]);
  const r0 = await T.calcularTarifaItem("G", desp(11), mlGet, 2, 6, "otro");
  eq([r0.estado, r0.muestras, r0.noEntregadas], ["ok", 1, 1], "calcularTarifaItem informa cuántas muestras vienen de despachos sin entregar");
  const h = hoja([]);
  const r = await T.procesarTarifas(base(h, { ventas, skuPorItem: new Map(), soloSinFilaDelTipo: true, soloMuestraReal: true, soloEntregados: true }));
  eq([r.procesadas, r.escritas, r.omitidas], [3, { nuevas: 1, actualizadas: 0 }, 2], "se calculan 3 pares; se escribe solo A (todas sus muestras entregadas) y se omiten G y H");
  eq(h.escritas.append[0][1].map((x) => [x[0], x[4]]), [["A", "2"]], "la fila escrita es A con Muestras = 2");
  const h2 = hoja([]);
  const r2 = await T.procesarTarifas(base(h2, { ventas, skuPorItem: new Map(), soloSinFilaDelTipo: true, soloMuestraReal: true }));
  eq(r2.escritas.nuevas, 3, "sin soloEntregados se escribirían las 3 (G y H con muestras sin entregar)");
  const h3 = hoja([]);
  const r3 = await T.procesarTarifas(base(h3, { ventas, skuPorItem: new Map(), soloSinFilaDelTipo: true, soloEntregados: true }));
  check(r3.escritas.nuevas >= 1 && h3.escritas.append[0][1].every((x) => x[0] === "A" || x[8] !== "ok"), "soloEntregados solo retiene filas medidas sin entregar; las estimadas siguen el flujo normal");
}
console.log("publicacionesEsperadas: no escribe si el conjunto no coincide");
{
  const mk = (desps, ing) => ({ ingreso: 1, precio: 9000, comision: 0, ingresoConComision: 0, despachos: [], despachosPorTipo: { fulfillment: [], otro: desps }, ingresoPorTipo: { fulfillment: 0, otro: ing }, tipoCrudo: { otro: X } });
  const ventas = new Map([["A", mk(desp(2, 3), 18000)], ["H", mk(desp(12), 9000)]]);
  const h = hoja([]);
  let error = null;
  try { await T.procesarTarifas(base(h, { ventas, skuPorItem: new Map(), soloSinFilaDelTipo: true, soloMuestraReal: true, publicacionesEsperadas: ["A"] })); } catch (e) { error = e; }
  check(error && /No se escribió nada/.test(error.message), "se iban a escribir A y H y se esperaba solo A: lanza error");
  eq([h.escritas.append.length, h.escritas.batch.length, h.escritas.write.length], [0, 0, 0], "y no escribe nada en la hoja");
  const h2 = hoja([]);
  const r2 = await T.procesarTarifas(base(h2, { ventas, skuPorItem: new Map(), soloSinFilaDelTipo: true, soloMuestraReal: true, publicacionesEsperadas: ["H", "A"] }));
  eq([r2.escritas.nuevas, h2.escritas.append.length], [2, 1], "con el conjunto exacto (en cualquier orden) escribe");
  const h3 = hoja([]);
  await T.procesarTarifas(base(h3, { ventas, skuPorItem: new Map(), soloSinFilaDelTipo: true, soloMuestraReal: true, dryRun: true, publicacionesEsperadas: ["A"] }));
  eq(h3.escritas.append.length, 0, "en simulación la guarda no aplica ni escribe");
}
console.log(`\n${ok} comprobaciones OK`);

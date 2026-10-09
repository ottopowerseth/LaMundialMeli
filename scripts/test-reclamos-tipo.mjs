// Pruebas de lib/reclamos-tipo.ts (sin red).
// Uso:  node scripts/test-reclamos-tipo.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ts = require(path.join(PROJ, "node_modules", "typescript"));
const out = fs.mkdtempSync(path.join(os.tmpdir(), "reclamos-test-"));
fs.writeFileSync(path.join(out, "r.js"), ts.transpileModule(fs.readFileSync(`${PROJ}/lib/reclamos-tipo.ts`, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText);
const R = require(path.join(out, "r.js"));
let ok = 0; const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); ok++; console.log("  ✓", m); };

const DESDE = Date.parse("2026-06-01T00:00:00Z"), HASTA = Date.parse("2026-10-01T00:00:00Z");
const F = "fulfillment", X = "xd_drop_off";
const orden = (id, status, tipo, extra = {}) => ({ o: { id, status, date_created: "2026-08-01T12:00:00.000-04:00", shippingId: 900 + id, pagos: [5000 + id], ...extra }, tipo });
const armar = (lista) => ({ ordenes: lista.map((x) => x.o), tipoPorOrden: new Map(lista.filter((x) => x.tipo).map((x) => [String(x.o.id), x.tipo])) });
const rec = (id, type, resource, resource_id, fecha = "2026-08-10T10:00:00.000-04:00") => ({ id, type, resource, resource_id, date_created: fecha });
const calc = (lista, reclamos, extra = {}) => R.calcularReclamosPorTipo({ reclamos, desdeMs: DESDE, hastaMs: HASTA, ...armar(lista), ...extra });

console.log("fechas con el offset real");
eq(R.parsearFechaReclamo("2022-12-01T03:43:49.000-04:00"), Date.parse("2022-12-01T07:43:49Z"), "-04:00 se respeta (03:43 local = 07:43Z)");
eq(R.parsearFechaReclamo("2026-01-15T03:00:00.000-03:00"), Date.parse("2026-01-15T06:00:00Z"), "-03:00 (verano) se respeta: no se fija -04:00");
eq(R.parsearFechaReclamo("2026-08-10T10:00:00Z"), Date.parse("2026-08-10T10:00:00Z"), "Z");
eq(Number.isNaN(R.parsearFechaReclamo("2026-08-10T10:00:00")), true, "sin offset es ambigua: NaN");
eq(Number.isNaN(R.parsearFechaReclamo(undefined)), true, "ausente: NaN");
{
  // límite de la ventana (HASTA = 01-oct 00:00Z): 30-sep 19:30 -04:00 = 23:30Z (dentro); 30-sep 20:30 -04:00 = 00:30Z del 01-oct (fuera)
  const r1 = calc([orden(1, "paid", F)], [rec(1, "mediations", "order", 1, "2026-09-30T19:30:00.000-04:00"), rec(2, "mediations", "order", 1, "2026-09-30T20:30:00.000-04:00")]);
  eq(r1.eventos.enVentana, 1, "la ventana se evalúa en UTC con el offset real: 19:30 -04:00 dentro, 20:30 -04:00 fuera");
}

console.log("cruce por orden, envío y pago");
{
  const L = [orden(1, "paid", F), orden(2, "paid", X), orden(3, "paid", X)];
  const r = calc(L, [rec(10, "mediations", "order", 1), rec(11, "mediations", "shipment", 902), rec(12, "mediations", "payment", 5003)]);
  eq([r.series.mediaciones.full.eventos, r.series.mediaciones.otro.eventos, r.series.mediaciones.sinTipo], [1, 2, 0], "order→orden 1 (Full); shipment 902→orden 2 y payment 5003→orden 3 (otro)");
  eq(r.eventos.porRecurso, { order: { total: 1, conTipo: 1 }, shipment: { total: 1, conTipo: 1 }, payment: { total: 1, conTipo: 1 } }, "cobertura por recurso");
  eq(r.eventos.coberturaPct, 100, "cobertura 100 %");
  eq(r.cotaInferior, false, "con todo cruzado y listado completo no hay cota");
  // el mapa de envíos de ShippingCache sirve aunque la orden no esté en el listado
  const r2 = calc([], [rec(20, "mediations", "shipment", 777)], { tipoPorOrden: new Map([["55", X]]), ordenPorEnvio: new Map([["777", "55"]]) });
  eq(r2.series.mediaciones.otro.eventos, 1, "envío resuelto con ordenPorEnvio de ShippingCache");
}

console.log("sin cruce");
{
  const L = [orden(1, "paid", F), orden(2, "paid", null)];
  const r = calc(L, [rec(10, "mediations", "order", 999), rec(11, "mediations", "shipment", 12345), rec(12, "mediations", "payment", 1), rec(13, "cancel_purchase", "order", 2)]);
  eq([r.series.mediaciones.sinTipo, r.series.cancelaciones.sinTipo], [2, 1], "orden inexistente, envío desconocido y orden sin tipo → sin tipo (no se reparten)");
  eq([r.eventos.conTipo, r.eventos.sinTipo, r.eventos.pagosSinOrden, r.eventos.coberturaPct], [0, 3, 1, 0], "el pago desconocido va aparte (pagosSinOrden), fuera de sin tipo y de la cobertura");
  eq([r.denominador.full, r.denominador.otro, r.denominador.sinTipo], [1, 0, 1], "denominador: la orden sin tipo va aparte");
  eq(r.cotaInferior, true, "hay eventos sin tipo → cota inferior");
  eq(r.motivosCota, ["3 reclamos sin tipo logístico (sin cruce con una orden clasificada)"], "la cota cuenta solo los 3 sin tipo, no el pago sin orden");
  const soloPago = calc([orden(1, "paid", F)], [rec(50, "mediations", "payment", 424242)]);
  eq([soloPago.eventos.pagosSinOrden, soloPago.eventos.sinTipo, soloPago.cotaInferior, soloPago.series.mediaciones.total], [1, 0, false, 0], "un reclamo de pago sin orden NO activa la cota inferior ni suma a la serie");
  const pagoConOrden = calc([orden(1, "paid", F)], [rec(51, "mediations", "payment", 5001)]);
  eq([pagoConOrden.eventos.pagosSinOrden, pagoConOrden.series.mediaciones.full.eventos], [0, 1], "un pago que sí está en una orden listada se asigna a su tipo");
  const pagoOrdenSinTipo = calc([orden(2, "paid", null)], [rec(52, "mediations", "payment", 5002)]);
  eq([pagoOrdenSinTipo.eventos.pagosSinOrden, pagoOrdenSinTipo.eventos.sinTipo], [0, 1], "pago de una orden listada pero sin tipo: sin tipo (no 'sin orden')");
  const r2 = calc([orden(1, "paid", F)], [], { listadoCompleto: false });
  eq([r2.cotaInferior, r2.motivosCota], [true, ["listado de reclamos incompleto"]], "listado incompleto → cota inferior aunque no haya eventos sin tipo");
  const r3 = calc([orden(1, "paid", F)], [rec(1, "mediations", "order", 1, "2026-08-10T10:00:00")]);
  eq([r3.eventos.fechaInvalida, r3.eventos.enVentana, r3.cotaInferior], [1, 0, true], "fecha sin offset: excluida y avisada");
}

console.log("denominador: pagadas, canceladas y parcialmente reembolsadas");
{
  const L = [orden(1, "paid", F), orden(2, "cancelled", F), orden(3, "partially_refunded", X), orden(4, "paid", X), orden(5, "payment_required", X), orden(6, "cancelled", null)];
  const r = calc(L, []);
  eq([r.denominador.full, r.denominador.otro, r.denominador.sinTipo, r.denominador.total], [2, 2, 1, 5], "paid, cancelled y partially_refunded entran; payment_required no");
  eq([r.denominador.excluidasPorEstado, r.denominador.porEstado.partially_refunded, r.denominador.porEstado.cancelled], [1, 1, 2], "estados contados en código, sin filtro en el listado");
  const rr = calc([orden(1, "partially_refunded", X)], [rec(1, "cancel_purchase", "order", 1)]);
  eq(rr.series.cancelaciones.otro.eventos, 1, "un reclamo sobre una orden parcialmente reembolsada se asigna a su tipo");
  const dup = R.calcularReclamosPorTipo({ reclamos: [], desdeMs: DESDE, hastaMs: HASTA, ordenes: [orden(1, "paid", F).o, orden(1, "paid", F).o], tipoPorOrden: new Map([["1", F]]) });
  eq(dup.denominador.total, 1, "orden repetida en el listado: se cuenta una vez");
  const fuera = R.calcularReclamosPorTipo({ reclamos: [], desdeMs: DESDE, hastaMs: HASTA, ordenes: [{ id: 1, status: "paid", date_created: "2026-01-01T00:00:00.000-04:00" }], tipoPorOrden: new Map([["1", F]]) });
  eq(fuera.denominador.total, 0, "orden creada fuera de la ventana: no entra");
}

console.log("series separadas, ventana y duplicados");
{
  const L = [orden(1, "paid", F), orden(2, "paid", X)];
  const r = calc(L, [rec(1, "cancel_purchase", "order", 1), rec(2, "mediations", "order", 1), rec(3, "returns", "order", 2), rec(4, "mediations", "order", 2, "2025-01-01T00:00:00.000-04:00"), rec(2, "mediations", "order", 1)]);
  eq([r.series.cancelaciones.full.eventos, r.series.cancelaciones.otro.eventos], [1, 0], "cancelaciones aparte");
  eq([r.series.mediaciones.full.eventos, r.series.mediaciones.otro.eventos], [1, 1], "mediaciones incluyen returns y quedan aparte de las cancelaciones");
  eq([r.eventos.enVentana, r.eventos.duplicados], [3, 1], "el reclamo fuera de la ventana no cuenta y el id repetido se descarta");
}

console.log("mínimo de 20 eventos para mostrar tasa");
{
  const L = []; for (let i = 1; i <= 200; i++) L.push(orden(i, "paid", i <= 100 ? F : X));
  const rs = []; for (let i = 1; i <= 19; i++) rs.push(rec(i, "mediations", "order", i)); // 19 en Full
  for (let i = 101; i <= 120; i++) rs.push(rec(1000 + i, "mediations", "order", i)); // 20 en otro
  const r = calc(L, rs);
  eq(r.series.mediaciones.full, { eventos: 19, ordenes: 100, tasaPor100: null }, "19 eventos: se muestra el conteo, NO la tasa");
  eq(r.series.mediaciones.otro, { eventos: 20, ordenes: 100, tasaPor100: 20 }, "20 eventos: conteo y tasa (20 por 100 órdenes)");
  eq(Object.keys(r.series.mediaciones.full).sort(), ["eventos", "ordenes", "tasaPor100"], "solo números: sin textos ni comparaciones entre tipos");
  const r2 = calc(L, rs, { minEventos: 5 });
  eq(r2.series.mediaciones.full.tasaPor100, 19, "el mínimo se puede cambiar (aquí 5)");
  const sinOrdenes = calc([], Array.from({ length: 25 }, (_, i) => rec(i + 1, "mediations", "order", i + 1)), { tipoPorOrden: new Map(Array.from({ length: 25 }, (_, i) => [String(i + 1), F])) });
  eq(sinOrdenes.series.mediaciones.full.tasaPor100, null, "sin órdenes en el denominador no hay tasa (no divide por 0)");
}

console.log("cota inferior");
{
  const L = [orden(1, "paid", F)];
  eq(calc(L, [rec(1, "mediations", "order", 1)]).cotaInferior, false, "sin faltantes: no es cota");
  eq(calc(L, [rec(1, "mediations", "order", 1), rec(2, "mediations", "order", 77)]).cotaInferior, true, "un evento sin tipo basta para marcarla");
  eq(R.tipoDeLogistico("self_service"), "otro", "cualquier tipo no Full va a 'otro'");
  eq([R.tipoDeLogistico(""), R.tipoDeLogistico(null)], [null, null], "vacío = sin tipo");
}

console.log("resumirReclamosPeriodo: cada reclamo cuenta una vez");
{
  const base = [{ id: 1, status: "closed", type: "mediations", date_created: "2026-08-10T10:00:00.000-04:00" }, { id: 2, status: "opened", type: "cancel_purchase", date_created: "2026-08-11T10:00:00.000-04:00" }];
  const repetido = [...base, { ...base[0] }, { ...base[1] }, { id: 3, status: "closed", type: "mediations", date_created: "2025-01-01T10:00:00.000-04:00" }];
  const r = R.resumirReclamosPeriodo(repetido, DESDE, HASTA);
  eq([r.total, r.duplicados], [2, 2], "ids repetidos entre páginas: 4 filas del período → 2 reclamos, 2 duplicados");
  eq([r.porStatus, r.porTipo], [{ closed: 1, opened: 1 }, { mediations: 1, cancel_purchase: 1 }], "por status y por type sin doble conteo");
  eq(R.resumirReclamosPeriodo([{ id: 9, date_created: "2026-08-10T10:00:00" }], DESDE, HASTA).fechaInvalida, 1, "fecha sin offset: se excluye y se informa");
  eq(R.resumirReclamosPeriodo(base, DESDE, HASTA).total, 2, "sin repetidos el resultado no cambia");
}

console.log("armado de entradas desde ML y ShippingCache");
{
  const o = R.ordenesParaReclamos([{ id: 1, status: "paid", date_created: "2026-08-01T12:00:00.000-04:00", shipping: { id: 77 }, payments: [{ id: 5 }, { id: 6 }] }, { id: 2, status: "cancelled", shipping: null, payments: null }]);
  eq([o[0].shippingId, o[0].pagos, o[1].shippingId, o[1].pagos], [77, [5, 6], null, []], "orden con envío y pagos; orden sin envío ni pagos");
  const m = R.mapasShippingCache([["'123", "'456", "fulfillment"], ["789", "012", ""], ["", "3", "xd_drop_off"]]);
  eq([[...m.tipoPorOrden], [...m.ordenPorEnvio]], [[["123", "fulfillment"]], [["456", "123"], ["012", "789"]]], "ids sin apóstrofo; sin tipo no entra a tipoPorOrden; el envío sin orden se ignora");
  const r = R.calcularReclamosPorTipo({ reclamos: [{ id: 1, type: "mediations", resource: "shipment", resource_id: "456", date_created: "2026-08-10T10:00:00.000-04:00" }], ordenes: o, ...m, desdeMs: DESDE, hastaMs: HASTA });
  eq(r.series.mediaciones.full.eventos, 1, "de punta a punta: reclamo por envío → orden 123 (Full) vía ShippingCache");
}

console.log(`\n${ok} comprobaciones OK`);

// Pruebas de la tarifa de envío por tipo logístico: lib/envio-medido.ts (parser, tarifaDe, orden de búsqueda),
// el indicador de cobertura de lib/tablero-resumen.ts y el margen por tipo de lib/tablero-margen.ts. Sin red.
// Uso:  node scripts/test-envio-tipo.mjs
// Transpila las librerías TypeScript a una carpeta temporal con el compilador del proyecto.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ts = require(path.join(PROJ, "node_modules", "typescript"));
const out = fs.mkdtempSync(path.join(os.tmpdir(), "envio-tipo-test-"));
for (const f of ["rentabilidad", "envio-estimado", "envio-medido", "logistica", "tablero-resumen", "tablero-margen"]) {
  let js = ts.transpileModule(fs.readFileSync(`${PROJ}/lib/${f}.ts`, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText;
  js = js.replace(/require\("@\/lib\/([a-z-]+)"\)/g, 'require("./$1.js")');
  fs.writeFileSync(path.join(out, f + ".js"), js);
}
const M = require(path.join(out, "envio-medido.js"));
const R = require(path.join(out, "tablero-resumen.js"));
const G = require(path.join(out, "tablero-margen.js"));
let ok = 0; const check = (c, m) => { assert.ok(c, m); ok++; console.log("  ✓", m); };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); ok++; console.log("  ✓", m); };
const sinOrigen = (r) => ({ envio: r.envio, fuente: r.fuente }); // para comparar valor y fuente sin el origen

// fila de TarifaEnvio: ID, SKU, Tarifa, Tipo, Muestras, Dispersión, Despacho, Unidades, Estado, Actualizado, Fuente, Motivo
const fila = (id, tarifa, tipo, estado = "ok", sku = "", act = "2026-10-01T00:00:00.000Z") => [id, sku, String(tarifa), tipo, "2", "0", "1", "1", estado, act, "", ""];
const F = "fulfillment", X = "xd_drop_off";

console.log("parser por tipo");
{
  const t = M.parsearTarifasEnvio([fila("A", 410, F), fila("A", 810, X), fila("B", 799, F), fila("C", 830, X, "estimado"), fila("D", 500, ""), fila("E", 0, F), fila("F", "x", F), ["", "", "100", F]]);
  eq([...t.keys()].sort(), ["A", "B", "C", "D"], "ignora filas sin id, con tarifa 0 o no numérica");
  eq([t.get("A").full.tarifa, t.get("A").noFull.tarifa], [410, 810], "una publicación con dos filas: una por grupo (Full / no Full)");
  eq([t.get("B").full.tarifa, t.get("B").noFull], [799, undefined], "fila vieja de una sola publicación: queda en su grupo");
  eq(t.get("C").noFull.estado, "estimado", "el estado se conserva por fila");
  eq(t.get("D").sinTipo.tarifa, 500, "fila sin Tipo Logístico (hoja anterior): sinTipo");
  eq(M.tarifaDe(t, "D", true).tarifa + M.tarifaDe(t, "D", false).tarifa, 1000, "la fila sin tipo vale para los dos tipos");
  eq(M.tarifaDe(t, "A", false).tarifa, 810, "tarifaDe devuelve la del tipo pedido");
  eq(M.tarifaOtroTipo(t, "A", false).tarifa, 410, "tarifaOtroTipo devuelve la del otro tipo");
  eq(M.tarifaOtroTipo(t, "D", true), undefined, "tarifaOtroTipo no devuelve la fila sin tipo");
  eq(M.tarifaDe(t, "ZZZ", true), undefined, "publicación inexistente");
}
console.log("duplicados del mismo (publicación, grupo)");
{
  const t = M.parsearTarifasEnvio([fila("A", 999, F, "estimado", "", "2026-10-09T00:00:00.000Z"), fila("A", 410, F, "ok", "", "2026-09-01T00:00:00.000Z")]);
  eq(t.get("A").full.tarifa, 410, "gana la medida aunque sea más vieja que la estimada");
  const t2 = M.parsearTarifasEnvio([fila("A", 410, F, "ok", "", "2026-09-01T00:00:00.000Z"), fila("A", 420, F, "ok", "", "2026-10-01T00:00:00.000Z")]);
  eq(t2.get("A").full.tarifa, 420, "entre dos medidas gana la más reciente");
  const t3 = M.parsearTarifasEnvio([fila("A", 410, F, "ok", "", "2026-10-01T00:00:00.000Z"), fila("A", 420, F, "ok", "", "2026-09-01T00:00:00.000Z")]);
  eq(t3.get("A").full.tarifa, 410, "el orden en la hoja no importa si las fechas difieren");
}

const ctxDe = (filas, precios = {}, skus = {}, logisticos = {}) => {
  const t = M.parsearTarifasEnvio(filas);
  return M.armarContextoEnvio(t, new Map(Object.entries(precios)), new Map(Object.entries(skus)), new Map(Object.entries(logisticos)));
};

console.log("resolverEnvio: pasos 1, 2 y 4 sin estimador disponible (sin precios no hay muestras)");
{
  const ctx = ctxDe([fila("A", 410, F), fila("A", 810, X), fila("D", 700, F, "dispersa"), fila("E", 830, X, "estimado"), fila("G", 410, F), fila("H", 410, F, "estimado"), fila("H", 810, X, "ok")]);
  eq(M.resolverEnvio("A", 9000, true, null, ctx), { envio: 410, fuente: "medido", origen: "hoja" }, "1. tarifa medida del mismo tipo (Full)");
  eq(M.resolverEnvio("A", 9000, false, null, ctx), { envio: 810, fuente: "medido", origen: "hoja" }, "1. tarifa medida del mismo tipo (despacho): usa la suya, no la de Full");
  eq(sinOrigen(M.resolverEnvio("D", 9000, true, null, ctx)), { envio: 700, fuente: "medido" }, "1. 'dispersa' cuenta como medida");
  eq(M.resolverEnvio("E", 9000, false, null, ctx), { envio: 830, fuente: "estimado", origen: "hoja" }, "2. tarifa estimada del mismo tipo");
  eq(M.resolverEnvio("G", 9000, false, null, ctx), { envio: 410, fuente: "estimado_otro_tipo", origen: "otro_tipo" }, "4. sin estimador: usa la tarifa de Full tal cual, marcada 'otro tipo'");
  eq(sinOrigen(M.resolverEnvio("E", 9000, true, null, ctx)), { envio: 830, fuente: "estimado_otro_tipo" }, "4. el otro tipo puede ser una tarifa estimada");
  eq(sinOrigen(M.resolverEnvio("H", 9000, true, null, ctx)), { envio: 410, fuente: "estimado" }, "2 antes que 4: la estimada del mismo tipo gana a la medida del otro tipo");
  eq(sinOrigen(M.resolverEnvio("H", 9000, false, null, ctx)), { envio: 810, fuente: "medido" }, "1 antes que todo: la medida del mismo tipo");
  eq(M.resolverEnvio("A", 9000, true, null, ctx).envio, 410, "sin factor de corrección: el valor es el de la hoja");
  eq(M.resolverEnvio("NUEVO", 8800, true, null, ctxDe([])), { envio: null, fuente: null }, "sin ninguna referencia: null (nunca 0)");
}
console.log("resolverEnvio: paso 3, el estimador va ANTES que el otro tipo");
{
  // muestras: despacho P1 (810, $8k) y P2 (830, $9k) en el tramo <$10k; Full P3 (410, $8,5k). G solo tiene Full (400, $8,8k).
  const ctx = ctxDe(
    [fila("P1", 810, X), fila("P2", 830, X), fila("P3", 410, F), fila("G", 400, F)],
    { P1: 8000, P2: 9000, P3: 8500, G: 8800 }, {}, { P1: X, P2: X, P3: F, G: F }
  );
  eq(M.resolverEnvio("G", 8800, false, null, ctx), { envio: 820, fuente: "estimado", origen: "estimador" }, "venta por despacho de G (solo tiene Full): mediana del tramo de despacho (820), no la tarifa Full (400)");
  eq(M.resolverEnvio("NUEVO", 8800, true, null, ctx), { envio: 405, fuente: "estimado", origen: "estimador" }, "sin fila: mediana del tramo Full (410 de P3 y 400 de G)");
  eq(M.resolverEnvio("NUEVO", 15000, true, null, ctx).fuente, null, "tramo sin ninguna muestra: null");
}
console.log("resolverEnvio: el estimador excluye la propia publicación");
{
  // K tiene Full 410 (SKU S1). L (SKU S1) tiene despacho 830. Venta de K por despacho: SKU gemelo = L (830), sin contar a K.
  const ctx = ctxDe([fila("K", 410, F, "ok", "S1"), fila("L", 830, X, "ok", "S1")], { K: 8000, L: 8000 }, { K: "S1", L: "S1" }, { K: F, L: X });
  eq(M.resolverEnvio("K", 8000, false, "S1", ctx), { envio: 830, fuente: "estimado", origen: "estimador" }, "SKU gemelo = L (830); el 410 de la propia K no entra a la mediana (con K sería 620)");
  // M2 es la única publicación con muestras en su tramo y SKU: sin la propia no hay estimador → usa el otro tipo
  const solo = ctxDe([fila("M2", 410, F, "ok", "S2")], { M2: 8000 }, { M2: "S2" }, { M2: F });
  eq(M.resolverEnvio("M2", 8000, false, "S2", solo), { envio: 410, fuente: "estimado_otro_tipo", origen: "otro_tipo" }, "sin más muestras que la propia: no hay estimador, recién ahí se usa el otro tipo");
  // una publicación SIN muestras propias usa los índices completos
  // El nivel SKU gemelo solo usa muestras del MISMO tipo logístico que la venta (K es Full 410; L es despacho 830).
  eq(M.resolverEnvio("OTRA", 8000, false, "S1", ctx).envio, 830, "una publicación sin muestras propias usa los índices ya armados: venta por despacho → solo la gemela de despacho (830)");
  eq(M.resolverEnvio("OTRA", 8000, true, "S1", ctx).envio, 410, "venta Full → solo la gemela Full (410)");
}
console.log("resolverEnvio: nivel SKU gemelo antes que el tramo");
{
  const ctx = ctxDe([fila("P1", 810, X), fila("P2", 830, X), fila("Q1", 1200, X, "ok", "S1")], { P1: 8000, P2: 9000, Q1: 15000 }, { Q1: "S1" }, { P1: X, P2: X, Q1: X });
  eq(sinOrigen(M.resolverEnvio("NUEVO", 8800, false, "S1", ctx)), { envio: 1200, fuente: "estimado" }, "SKU gemelo antes que el tramo");
  eq(sinOrigen(M.resolverEnvio("NUEVO", 8800, false, null, ctx)), { envio: 820, fuente: "estimado" }, "sin SKU: mediana del tramo <$10k de despacho");
}
console.log("SKU gemelo: solo del mismo tipo logístico (corrección del -49%)");
{
  // La gemela Full cuesta $410. Dos publicaciones de despacho en el tramo <$10k dan 820. Una venta por despacho de la
  // misma familia (SKU S1) NO debe tomar los $410 de Full.
  const ctx = ctxDe([fila("GF", 410, F, "ok", "S1"), fila("P1", 810, X), fila("P2", 830, X), fila("P3", 410, F)], { GF: 8000, P1: 8000, P2: 9000, P3: 8500 }, { GF: "S1" }, { GF: F, P1: X, P2: X, P3: F });
  const r = M.resolverEnvio("NUEVO", 8800, false, "S1", ctx);
  eq([r.envio, r.fuente], [820, "estimado"], "gemela Full $410 y venta por despacho: no usa los $410, pasa al tramo de despacho (820)");
  eq(M.resolverEnvio("NUEVO", 8800, true, "S1", ctx).envio, 410, "la misma gemela sí sirve para una venta Full (410)");
  // Si la gemela es la única referencia de todo el tramo y es de otro tipo, el tramo usa el otro tipo como último recurso (comportamiento previo del tramo)
  const sola = ctxDe([fila("GF", 410, F, "ok", "S1")], { GF: 8000 }, { GF: "S1" }, { GF: F });
  const rs = M.resolverEnvio("NUEVO", 8800, false, "S1", sola);
  eq([rs.envio, rs.origen], [410, "estimador"], "sin gemela ni muestras de despacho en el tramo: el tramo cae a la muestra del otro tipo (último recurso del tramo, no del nivel SKU)");
  // gemela del mismo tipo gana al tramo
  const ctx2 = ctxDe([fila("GX", 1200, X, "ok", "S2"), fila("P1", 810, X), fila("P2", 830, X)], { GX: 15000, P1: 8000, P2: 9000 }, { GX: "S2" }, { GX: X, P1: X, P2: X });
  eq(M.resolverEnvio("NUEVO", 8800, false, "S2", ctx2).envio, 1200, "gemela del mismo tipo (despacho 1.200) antes que el tramo (820)");
  // armarMuestrasEnvio directo: el índice por SKU lleva el tipo en la clave
  const E = require(path.join(out, "envio-estimado.js"));
  const filas = [["", "", "A", "", "8000", "", "", "", "", "", "", "", "", "", "410"], ["", "", "B", "", "8000", "", "", "", "", "", "", "", "", "", "830"]];
  const idx = E.armarMuestrasEnvio(filas, new Map([["A", "S"], ["B", "S"]]), new Map([["A", F], ["B", X]]));
  eq([...idx.porSku.keys()].sort(), ["S|fulfillment", "S|otro"], "el índice porSku se separa por tipo logístico");
  eq([E.calcularEnvioEstimadoPorUnidad("Z", 8000, false, idx, "S").envio, E.calcularEnvioEstimadoPorUnidad("Z", 8000, true, idx, "S").envio], [830, 410], "calcularEnvioEstimadoPorUnidad: despacho → 830, Full → 410");
}
console.log("armarContextoEnvio: una muestra por (publicación, tipo), con su propio tipo");
{
  const ctx = ctxDe([fila("P", 410, F), fila("P", 810, X), fila("Q", 830, X)], { P: 8000, Q: 8000 }, {}, { P: F, Q: X });
  eq(M.resolverEnvio("N", 8000, false, null, ctx).envio, 820, "tramo despacho = mediana de las muestras de despacho (810 de P y 830 de Q), aunque P hoy sea Full");
  eq(M.resolverEnvio("N", 8000, true, null, ctx).envio, 410, "tramo Full = la muestra Full de P");
  eq(ctx.crudas.length, 3, "una muestra cruda por tarifa medida");
}

console.log("indicador de cobertura por línea de venta (misma jerarquía que resolverEnvio)");
const linea = (orden, item, cant, precio, logistic) => ({ orden, ms: 0, item, titulo: item, cantidad: cant, precio, fee: 100, logistic });
{
  // Sin estimador posible (no hay precios para armar muestras): las ventas sin fila del tipo caen en "otro tipo" o "sin dato".
  const tarifas = M.parsearTarifasEnvio([fila("A", 410, F), fila("A", 810, X), fila("B", 410, F), fila("C", 830, X, "estimado"), fila("D", 830, X)]);
  const ctx = M.armarContextoEnvio(tarifas, new Map(), new Map(), new Map());
  const entrada = (lineas, extra = {}) => ({ lineas, costoPorItem: new Map(), origenPorItem: new Map(), ctxEnvio: ctx, skuPorItem: new Map(), ...extra });
  const lineas = [
    linea("1", "A", 1, 1000, F),  // medida del tipo correcto
    linea("2", "A", 1, 1000, X),  // medida del tipo correcto
    linea("3", "B", 1, 1000, X),  // solo Full y la venta fue por despacho, sin estimador → otro tipo
    linea("4", "C", 1, 1000, X),  // estimada del tipo correcto (hoja)
    linea("5", "D", 1, 1000, F),  // solo despacho, venta Full, sin estimador → otro tipo
    linea("6", "Z", 1, 1000, X),  // sin ninguna referencia
  ];
  const c = R.calcularConfianza(entrada(lineas));
  eq(c.envioMedido, { pct: 33.3, estimado: 16.7, estimador: 0, otroTipo: 33.3, sinDato: 16.7 }, "medido 2/6, estimado 1/6, otro tipo 2/6, sin dato 1/6 (por ingreso)");
  eq(Math.round(Object.values(c.envioMedido).reduce((a, b) => a + b, 0) * 10) / 10, 100, "las cinco categorías suman 100%");
  const sinReal = [linea("1", "A", 1, 1000, null), linea("2", "B", 1, 1000, null)];
  const c2 = R.calcularConfianza(entrada(sinReal, { fullPorItem: new Map([["A", false], ["B", true]]) }));
  eq(c2.envioMedido.pct, 100, "línea sin tipo real: usa el tipo actual de la publicación (A despacho → 810 medida; B Full → 410 medida)");
  const c3 = R.calcularConfianza(entrada([linea("1", "B", 1, 1000, null)], { fullPorItem: new Map([["B", false]]) }));
  eq(c3.envioMedido.otroTipo, 100, "ídem, con el tipo actual no Full de B (solo tiene Full) y sin estimador → otro tipo");
  const c5 = R.calcularConfianza(entrada([linea("1", "A", 1, 1000, F), linea("2", "Z", 1, 1000, X)], { fueraDeAlcance: new Set(["Z"]) }));
  eq([c5.ingresoVentana, c5.envioMedido.pct, c5.excluidas.publicaciones], [1000, 100, 1], "una cerrada sin Costo no entra al total ni a la cobertura");
  // con estimador: la misma venta de B por despacho ya no es 'otro tipo' sino 'estimador'
  const tarifas2 = M.parsearTarifasEnvio([fila("B", 410, F), fila("P1", 810, X), fila("P2", 830, X)]);
  const ctx2 = M.armarContextoEnvio(tarifas2, new Map([["B", 8000], ["P1", 8000], ["P2", 9000]]), new Map(), new Map());
  const c4 = R.calcularConfianza({ lineas: [linea("1", "B", 1, 8000, X)], costoPorItem: new Map(), origenPorItem: new Map(), ctxEnvio: ctx2, skuPorItem: new Map() });
  eq(c4.envioMedido, { pct: 0, estimado: 0, estimador: 100, otroTipo: 0, sinDato: 0 }, "con muestras en el tramo: la venta por despacho de B se cuenta como 'estimador', no como 'otro tipo'");
}

console.log("margen: rótulo, menosFiable y valor según la fuente");
{
  const tarifas = M.parsearTarifasEnvio([fila("A", 410, F), fila("B", 410, F)]);
  const ctx = M.armarContextoEnvio(tarifas, new Map(), new Map(), new Map());
  const entrada = (lineas, c = ctx) => ({ lineas, costoPorItem: new Map([["A", 3000], ["B", 3000]]), fullPorItem: new Map([["A", true], ["B", true]]), skuPorItem: new Map(), ctxEnvio: c });
  const ln = (orden, item, logistic, precio = 10000) => ({ orden, ms: 0, item, titulo: item, cantidad: 1, precio, fee: 1300, logistic });
  const rFull = G.analizarMargen(entrada([ln("1", "A", F)])).filas[0];
  eq([rFull.envioFuente, rFull.menosFiable, rFull.envioUnidad], ["medido", false, 410], "venta Full con tarifa Full: medido, no marcado");
  const rDesp = G.analizarMargen(entrada([ln("2", "A", X)])).filas[0];
  eq([rDesp.envioFuente, rDesp.menosFiable, rDesp.envioUnidad], ["estimado_otro_tipo", true, 410], "venta por despacho con solo tarifa Full y sin estimador: 'otro tipo', menosFiable, valor 410");
  const mixta = G.analizarMargen(entrada([ln("3", "A", F), ln("4", "A", X)])).filas[0];
  eq([mixta.envioFuente, mixta.menosFiable, mixta.envioUnidad], ["estimado_otro_tipo", true, 410], "publicación mixta sin estimador: marcada 'otro tipo', envío sin ruido de coma flotante");
  // con estimador en el tramo: el envío de la venta por despacho es el del estimador (820), no el de Full (410)
  const tarifas2 = M.parsearTarifasEnvio([fila("A", 410, F), fila("P1", 810, X), fila("P2", 830, X)]);
  const ctx2 = M.armarContextoEnvio(tarifas2, new Map([["A", 9000], ["P1", 8000], ["P2", 9000]]), new Map(), new Map());
  const e2 = (lineas) => ({ lineas, costoPorItem: new Map([["A", 3000]]), fullPorItem: new Map([["A", true]]), skuPorItem: new Map(), ctxEnvio: ctx2 });
  const rEst = G.analizarMargen(e2([ln("5", "A", X, 9000)])).filas[0];
  const rFull9 = G.analizarMargen(e2([ln("6", "A", F, 9000)])).filas[0];
  eq([rEst.envioFuente, rEst.menosFiable, rEst.envioUnidad], ["estimado", true, 820], "venta por despacho de A con muestras en el tramo: estimador (820), no la tarifa de Full");
  // el resumen cuenta el ingreso con envío no medido por tipo de venta (no marca entera una publicación mixta)
  const mix = G.analizarMargen(entrada([ln("7", "A", F), ln("8", "A", X)]));
  eq([mix.filas[0].menosFiable, mix.resumen.menosFiable.pctIngreso], [true, 50], "publicación mixta (una venta Full medida, una por despacho sin estimador): la fila queda marcada pero el resumen dice 50% del ingreso, no 100%");
  check(rEst.margenPct < rFull9.margenPct, "el margen baja porque el envío de despacho (820) es mayor que el de Full (410)");
}
console.log(`\n${ok} comprobaciones OK`);

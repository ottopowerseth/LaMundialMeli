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

console.log("resolverEnvio: orden de búsqueda");
const ctxDe = (filas, precios = {}, skus = {}, logisticos = {}) => {
  const t = M.parsearTarifasEnvio(filas);
  return M.armarContextoEnvio(t, new Map(Object.entries(precios)), new Map(Object.entries(skus)), new Map(Object.entries(logisticos)));
};
{
  const ctx = ctxDe([fila("A", 410, F), fila("A", 810, X), fila("D", 700, F, "dispersa"), fila("E", 830, X, "estimado"), fila("G", 410, F), fila("H", 410, F, "estimado"), fila("H", 810, X, "ok")]);
  eq(M.resolverEnvio("A", 9000, true, null, ctx), { envio: 410, fuente: "medido" }, "1. tarifa medida del mismo tipo (Full)");
  eq(M.resolverEnvio("A", 9000, false, null, ctx), { envio: 810, fuente: "medido" }, "1. tarifa medida del mismo tipo (despacho): usa la suya, no la de Full");
  eq(M.resolverEnvio("D", 9000, true, null, ctx), { envio: 700, fuente: "medido" }, "1. 'dispersa' cuenta como medida");
  eq(M.resolverEnvio("E", 9000, false, null, ctx), { envio: 830, fuente: "estimado" }, "2. tarifa estimada del mismo tipo");
  eq(M.resolverEnvio("G", 9000, false, null, ctx), { envio: 410, fuente: "estimado_otro_tipo" }, "3. solo hay Full medida y la venta fue por despacho: usa la de Full tal cual, marcada 'otro tipo'");
  eq(M.resolverEnvio("E", 9000, true, null, ctx), { envio: 830, fuente: "estimado_otro_tipo" }, "3. el otro tipo puede ser una tarifa estimada");
  eq(M.resolverEnvio("H", 9000, true, null, ctx), { envio: 410, fuente: "estimado" }, "2 antes que 3: la estimada del mismo tipo gana a la medida del otro tipo");
  eq(M.resolverEnvio("H", 9000, false, null, ctx), { envio: 810, fuente: "medido" }, "1 antes que todo: la medida del mismo tipo");
  eq(M.resolverEnvio("A", 9000, true, null, ctx).envio, 410, "sin factor de corrección: el valor es el de la hoja");
}
console.log("resolverEnvio: respaldo del estimador");
{
  // muestras medidas: dos publicaciones de despacho en el tramo <$10k y una Full; otra con el SKU "S1"
  const ctx = ctxDe(
    [fila("P1", 810, X), fila("P2", 830, X), fila("P3", 410, F), fila("Q1", 1200, X, "ok", "S1")],
    { P1: 8000, P2: 9000, P3: 8500, Q1: 15000 }, { Q1: "S1" }, { P1: X, P2: X, P3: F, Q1: X }
  );
  const sinFila = M.resolverEnvio("NUEVO", 8800, false, null, ctx);
  eq([sinFila.fuente, sinFila.envio], ["estimado", 820], "4. sin fila: mediana del tramo para el tipo de la venta (despacho)");
  const sinFilaFull = M.resolverEnvio("NUEVO", 8800, true, null, ctx);
  eq([sinFilaFull.fuente, sinFilaFull.envio], ["estimado", 410], "4. sin fila: mediana del tramo Full cuando la venta es Full");
  const porSku = M.resolverEnvio("NUEVO", 8800, false, "S1", ctx);
  eq([porSku.fuente, porSku.envio], ["estimado", 1200], "4. SKU gemelo antes que el tramo");
  eq(M.resolverEnvio("NUEVO", 15000, true, null, ctx), { envio: 1200, fuente: "estimado" }, "4. el tramo solo tiene muestras del otro tipo: las usa (comportamiento del estimador), marcado estimado");
  eq(M.resolverEnvio("NUEVO", 50000, true, null, ctx), { envio: null, fuente: null }, "4. un tramo sin ninguna muestra: null");
  const vacio = ctxDe([]);
  eq(M.resolverEnvio("NUEVO", 8800, true, null, vacio), { envio: null, fuente: null }, "sin ninguna referencia: null (nunca 0)");
  // el estimador no se alimenta de la propia publicación con otro tipo: la propia 'otro tipo' ya se usó en el paso 3
  const ctx2 = ctxDe([fila("Z", 410, F)], { Z: 8000 }, {}, { Z: F });
  eq(M.resolverEnvio("Z", 8000, false, null, ctx2), { envio: 410, fuente: "estimado_otro_tipo" }, "una publicación con solo Full vendida por despacho no pasa por el estimador");
}
console.log("armarContextoEnvio: una muestra por (publicación, tipo), con su propio tipo");
{
  // P: Full 410 y despacho 810, ambas medidas. Una venta nueva (sin fila) en el mismo tramo debe usar la mediana de SU tipo.
  const ctx = ctxDe([fila("P", 410, F), fila("P", 810, X), fila("Q", 830, X)], { P: 8000, Q: 8000 }, {}, { P: F, Q: X });
  eq(M.resolverEnvio("N", 8000, false, null, ctx).envio, 820, "tramo despacho = mediana de las muestras de despacho (810 de P y 830 de Q), aunque P hoy sea Full");
  eq(M.resolverEnvio("N", 8000, true, null, ctx).envio, 410, "tramo Full = la muestra Full de P");
}

console.log("indicador de cobertura por línea de venta");
const linea = (orden, item, cant, precio, logistic) => ({ orden, ms: 0, item, titulo: item, cantidad: cant, precio, fee: 100, logistic });
{
  const tarifas = M.parsearTarifasEnvio([fila("A", 410, F), fila("A", 810, X), fila("B", 410, F), fila("C", 830, X, "estimado"), fila("D", 830, X)]);
  const entrada = (lineas, extra = {}) => ({ lineas, costoPorItem: new Map(), origenPorItem: new Map(), tarifas, ...extra });
  const lineas = [
    linea("1", "A", 1, 1000, F),  // medida del tipo correcto
    linea("2", "A", 1, 1000, X),  // medida del tipo correcto
    linea("3", "B", 1, 1000, X),  // solo Full y la venta fue por despacho → otro tipo
    linea("4", "C", 1, 1000, X),  // estimada del tipo correcto
    linea("5", "D", 1, 1000, F),  // solo despacho, venta Full → otro tipo
    linea("6", "Z", 1, 1000, X),  // sin fila
  ];
  const c = R.calcularConfianza(entrada(lineas));
  eq(c.envioMedido, { pct: 33.3, estimado: 16.7, otroTipo: 33.3, sinDato: 16.7 }, "medido 2/6, estimado 1/6, otro tipo 2/6, sin dato 1/6 (por ingreso)");
  eq(Math.round((c.envioMedido.pct + c.envioMedido.estimado + c.envioMedido.otroTipo + c.envioMedido.sinDato) * 10) / 10, 100, "las cuatro categorías suman 100%");
  // sin tipo real: usa el tipo ACTUAL de la publicación (respaldo)
  const sinReal = [linea("1", "A", 1, 1000, null), linea("2", "B", 1, 1000, null)];
  const c2 = R.calcularConfianza(entrada(sinReal, { fullPorItem: new Map([["A", false], ["B", true]]) }));
  eq(c2.envioMedido, { pct: 100, estimado: 0, otroTipo: 0, sinDato: 0 }, "línea sin tipo real: usa el tipo actual de la publicación (A despacho → 810 medida; B Full → 410 medida)");
  const c3 = R.calcularConfianza(entrada([linea("1", "B", 1, 1000, null)], { fullPorItem: new Map([["B", false]]) }));
  eq(c3.envioMedido.otroTipo, 100, "ídem, con el tipo actual no Full de B (solo tiene Full) → otro tipo");
  // equivalencia con el criterio anterior cuando el tipo de la venta coincide con la fila (una fila por publicación)
  const soloUna = M.parsearTarifasEnvio([fila("A", 410, F), fila("C", 830, X, "estimado")]);
  const c4 = R.calcularConfianza({ lineas: [linea("1", "A", 2, 1000, F), linea("2", "C", 1, 1000, X), linea("3", "Z", 1, 1000, X)], costoPorItem: new Map(), origenPorItem: new Map(), tarifas: soloUna });
  eq([c4.envioMedido.pct, c4.envioMedido.estimado, c4.envioMedido.otroTipo, c4.envioMedido.sinDato], [50, 25, 0, 25], "con ventas del tipo de la fila: medido/estimado/sin dato como antes y otro tipo = 0");
  // publicaciones fuera de alcance siguen sin contar
  const c5 = R.calcularConfianza(entrada([linea("1", "A", 1, 1000, F), linea("2", "Z", 1, 1000, X)], { fueraDeAlcance: new Set(["Z"]) }));
  eq([c5.ingresoVentana, c5.envioMedido.pct, c5.excluidas.publicaciones], [1000, 100, 1], "una cerrada sin Costo no entra al total ni a la cobertura");
}

console.log("margen: rótulo 'otro tipo' y menosFiable; los números no cambian");
{
  const tarifas = M.parsearTarifasEnvio([fila("A", 410, F), fila("B", 410, F)]);
  const ctx = M.armarContextoEnvio(tarifas, new Map(), new Map(), new Map());
  const entrada = (lineas) => ({ lineas, costoPorItem: new Map([["A", 3000], ["B", 3000]]), fullPorItem: new Map([["A", true], ["B", true]]), skuPorItem: new Map(), ctxEnvio: ctx });
  const ln = (orden, item, logistic) => ({ orden, ms: 0, item, titulo: item, cantidad: 1, precio: 10000, fee: 1300, logistic });
  const rFull = G.analizarMargen(entrada([ln("1", "A", F)])).filas[0];
  eq([rFull.envioFuente, rFull.menosFiable, rFull.envioUnidad], ["medido", false, 410], "venta Full con tarifa Full: medido, no marcado");
  const rDesp = G.analizarMargen(entrada([ln("2", "A", X)])).filas[0];
  eq([rDesp.envioFuente, rDesp.menosFiable, rDesp.envioUnidad], ["estimado_otro_tipo", true, 410], "venta por despacho con solo tarifa Full: 'otro tipo', menosFiable, mismo valor 410");
  eq(rDesp.margenPct, rFull.margenPct, "el margen es el mismo número (se usa la misma tarifa), solo cambia el rótulo");
  const mixta = G.analizarMargen(entrada([ln("3", "A", F), ln("4", "A", X)])).filas[0];
  eq([mixta.envioFuente, mixta.menosFiable], ["estimado_otro_tipo", true], "publicación mixta: la fila queda marcada 'otro tipo'");
  eq(mixta.envioUnidad, 410, "envío promedio de la mixta sin ruido de coma flotante");
}
console.log(`\n${ok} comprobaciones OK`);

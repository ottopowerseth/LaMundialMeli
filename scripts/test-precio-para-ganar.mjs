// Pruebas de lib/precio-para-ganar.ts y lib/precio-para-ganar-datos.ts (sin red, ML simulado).
// Uso:  node scripts/test-precio-para-ganar.mjs
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
const out = fs.mkdtempSync(path.join(os.tmpdir(), "precio-test-"));
for (const f of ["rentabilidad", "precio-para-ganar", "precio-para-ganar-datos"]) {
  let js = ts.transpileModule(fs.readFileSync(`${PROJ}/lib/${f}.ts`, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText;
  js = js.replace(/require\("@\/lib\/([a-z-]+)"\)/g, 'require("./$1.js")');
  fs.writeFileSync(path.join(out, f + ".js"), js);
}
const P = require(path.join(out, "precio-para-ganar.js")); const D = require(path.join(out, "precio-para-ganar-datos.js"));
let ok = 0; const check = (c, m) => { assert.ok(c, m); ok++; console.log("  ✓", m); };
const near = (a, b, e = 0.06) => a !== null && Math.abs(a - b) <= e;

const fm = (id, o = {}) => ({ id, titulo: id, full: false, unidades: 3, ingreso: 100000, precioProm: 11900, costo: 5950, comisionPct: 0.14, envioUnidad: 1190, envioFuente: "medido", margenPct: 26, estado: "ok", menosFiable: false, pierde: false, fueraDeAlcance: false, ...o });
const F = (id, estado) => ({ id, descripcion: id, estado });
const NUESTROS = [F("fulfillment", "boosted"), F("free_shipping", "opportunity"), F("free_installments", "opportunity")];
const ptw = (id, o = {}) => ({ itemId: id, status: "competing", precioActual: 11900, precioParaGanar: 8100, visitShare: "minimum", competidoresCompartiendo: null, razones: [], factores: NUESTROS, ganador: { itemId: "W", precio: 9000, factores: NUESTROS }, ...o });

console.log("equilibrio y margen");
check(near(P.precioEquilibrio(5950, 0.14, 1190), 8302.3, 0.1), "equilibrio = (5.950 + 1.190) / (1 − 0,14) = $8.302");
check(near(P.margenAlPrecio(P.precioEquilibrio(5950, 0.14, 1190), 5950, 0.14, 1190), 0, 0.06), "al precio de equilibrio el margen de contribución es 0");
check(P.precioEquilibrio(null, 0.14, 1190) === null && P.precioEquilibrio(5950, null, 1190) === null && P.precioEquilibrio(5950, 0.14, null) === null && P.precioEquilibrio(5950, 1, 0) === null, "sin Costo, comisión o envío (o comisión 100%): null, nunca se asume");
check(near(P.margenAlPrecio(8100, 5950, 0.14, 1190), -2.1), "margen a $8.100 = (8.100 − 5.950 − 1.134 − 1.190) / 8.100 = −2,1%");

console.log("análisis por publicación");
const margenFilas = [
  fm("A"), fm("B", { ingreso: 50000 }), fm("C", { ingreso: 20000 }), fm("D", { ingreso: 30000 }), fm("J", { costo: null, margenPct: null, estado: "sin_costo", ingreso: 10000 }),
  fm("E", { ingreso: 7000 }), fm("F2", { ingreso: 3000 }), fm("G", { ingreso: 9000 }), fm("H", { ingreso: 2000 }), fm("I", { ingreso: 1000 }),
];
const ptwMap = new Map([
  ["A", ptw("A")], // paraGanar 8.100, ganador cobra menos (9.000 < 11.900)
  ["B", ptw("B", { precioParaGanar: 11000, ganador: { itemId: "W", precio: 12500, factores: [F("fulfillment", "boosted"), F("free_shipping", "boosted"), F("free_installments", "opportunity")] } })], // ganador cobra más y tiene un factor que no tenemos
  ["C", ptw("C", { precioParaGanar: 11000, ganador: { itemId: "W", precio: 12500, factores: NUESTROS } })], // ganador cobra más, mismos factores
  ["D", ptw("D", { status: "winning", precioParaGanar: 11900, visitShare: "maximum", ganador: { itemId: "D", precio: 11900, factores: NUESTROS } })],
  ["J", ptw("J", { ganador: null })],
  ["E", { itemId: "E", status: "not_listed", precioActual: null, precioParaGanar: null, visitShare: null, competidoresCompartiendo: null, razones: ["item_not_opted_in"], factores: [], ganador: null }],
  ["F2", { itemId: "F2", status: "not_listed", precioActual: null, precioParaGanar: null, visitShare: null, competidoresCompartiendo: null, razones: ["item_not_opted_in"], factores: [], ganador: null }],
  ["I", null],
]);
const r = P.analizarPrecioParaGanar({
  margenFilas, estadoPorItem: new Map([["A", "active"], ["B", "active"], ["C", "active"], ["D", "active"], ["J", "active"], ["E", "active"], ["F2", "active"], ["G", "paused"], ["H", "closed"], ["I", "active"]]),
  ptw: ptwMap, esCatalogo: new Map([["E", false], ["F2", true]]), envioTipicoTramo: (precio) => (precio < 9000 ? 799 : 1190),
});
const a = r.filas.find((x) => x.id === "A"), b = r.filas.find((x) => x.id === "B"), c = r.filas.find((x) => x.id === "C"), d = r.filas.find((x) => x.id === "D"), j = r.filas.find((x) => x.id === "J");
check(near(a.equilibrio, 8302.3, 0.1) && a.posicion === "bajo" && near(a.brechaPct, 2.4), "A: precio para ganar $8.100 queda 'bajo' el equilibrio $8.302 (brecha 2,4% del equilibrio)");
check(near(a.margenAlPrecioParaGanarPct, -2.1) && near(a.margenHoyPct, 26, 0.01), "A: margen a ese precio −2,1% (estimado) contra 26,0% hoy");
check(a.envioTramo === 799 && near(a.equilibrioEnvioTramo, 7847.7, 0.1) && a.posicionEnvioTramo === "sobre" && near(a.margenAlPrecioParaGanarTramoPct, 2.7), "A con el envío típico del tramo ($799): equilibrio $7.848 y el precio para ganar queda 'sobre'; margen 2,7%");
check(near(a.equilibrioMayorNeto, 9616.9, 0.1) && a.posicionMayorNeto === "bajo", "A si el Mayor fuera neto: equilibrio $9.617 (Costo × 1,19), 'bajo' con mayor brecha");
check(a.ganadorCobra === "menos" && a.precioGanador === 9000, "A: el ganador cobra menos que nosotros ($9.000 < $11.900)");
check(b.ganadorCobra === "mas" && b.posicion === "sobre" && JSON.stringify(b.factoresGanadorQueNoTenemos) === '["free_shipping"]', "B: el ganador cobra MÁS; tiene 'free_shipping' boosted que nosotros no (solo ese factor, no los compartidos)");
check(c.ganadorCobra === "mas" && c.factoresGanadorQueNoTenemos.length === 0, "C: el ganador cobra más y NO tiene ningún factor boosted que nosotros no tengamos");
check(d.estado === "winning" && d.visitShare === "maximum", "D: ganando, con participación de visitas máxima");
check(j.equilibrio === null && j.posicion === null && j.margenAlPrecioParaGanarPct === null && j.equilibrioMayorNeto === null && j.brechaPct === null, "J sin Costo: equilibrio, posición y margen null (la fila igual se muestra)");

console.log("resumen");
const s = r.resumen;
check(s.enTabla.competing.n === 4 && s.enTabla.winning.n === 1 && s.enTabla.sharing_first_place.n === 0 && s.enTabla.competing.ingreso === 180000, "en la tabla: 4 en competencia ($180.000), 1 ganando");
check(s.noParticipan.total.n === 3 && s.noParticipan.propias.n === 1 && s.noParticipan.catalogo.n === 1 && s.noParticipan.sinDato.n === 1 && s.noParticipan.total.ingreso === 11000, "no participan (activas): 3 = 1 propia + 1 de catálogo + 1 sin dato, $11.000");
check(s.pausadasOtras.pausadas.n === 1 && s.pausadasOtras.pausadas.ingreso === 9000 && s.pausadasOtras.otras.n === 1, "pausadas: 1 ($9.000); cerradas u otras: 1; ninguna se consulta");
const cp = s.competencia;
check(cp.n === 4 && cp.evaluables === 3, "competencia: 4, de las cuales 3 son evaluables (J no tiene Costo)");
check(cp.bajo.envioActual === 1 && cp.bajo.envioTramo === 0 && cp.bajo.sinEnvio === 0 && cp.bajo.mayorNeto === 1, "por debajo del equilibrio: 1 con envío actual, 0 con envío del tramo, 0 sin envío, 1 si el Mayor fuera neto");
check(cp.ingresoBajoEnvioActual === 100000 && near(cp.brechaMedianaPct, -32.5, 0.1), "ingreso de las que quedan bajo (envío actual) $100.000; brecha mediana −32,5% (negativa = el precio para ganar queda sobre el equilibrio)");
check(cp.ganadorCobraMas === 2 && cp.ganadorCobraMenos === 1 && cp.ganadorCobraIgual === 0, "el ganador cobra más en 2, menos en 1");
check(cp.ganadorMasCaroConFactorQueNoTenemos === 1 && cp.conFactorDelGanadorQueNoTenemos === 1, "de las 2 donde el ganador cobra más, solo 1 tiene un factor boosted que nosotros no");
check(cp.relacionParaGanarSobreGanadorMediana === 0.88, "precio para ganar / precio del ganador: mediana 0,88");

const r2 = P.analizarPrecioParaGanar({ margenFilas: [fm("X")], estadoPorItem: new Map([["X", "active"]]), ptw: new Map([["X", ptwMap.get("E")]]), esCatalogo: new Map(), envioTipicoTramo: () => null });
check(r2.resumen.noParticipan.sinDato.n === 1 && r2.resumen.noParticipan.propias.n === 0 && r2.resumen.noParticipan.catalogo.n === 0, "si no se pudo saber si es de catálogo, la que no participa queda 'sin dato' (no se supone propia)");
console.log("cargadores (con ML simulado)");
(async () => {
  const llamadas = [];
  const mlGet = async (url) => {
    llamadas.push(url);
    const id = /items\/(MLC\d+)\//.exec(url)?.[1];
    if (id === "MLC3") throw new Error("429");
    if (id === "MLC2") return { data: { item_id: id, status: "not_listed", current_price: null, price_to_win: null, boosts: null, reason: ["item_not_opted_in"], winner: undefined } };
    if (id) return { data: { item_id: id, status: "competing", current_price: 6090, price_to_win: 5445, visit_share: "minimum", competitors_sharing_first_place: null, reason: [], boosts: [{ id: "fulfillment", description: "Envíos Full", status: "boosted" }], winner: { item_id: "W", price: 6640, boosts: [{ id: "free_shipping", description: "Envío gratis", status: "boosted" }] } } };
    const ids = /ids=([^&]+)/.exec(url)[1].split(",");
    return { data: ids.map((x) => ({ code: x === "MLC9" ? 404 : 200, body: { id: x, catalog_listing: Number(x.slice(3)) % 2 === 0 } })) };
  };
  const m = await D.cargarPriceToWin(mlGet, ["MLC1", "MLC2", "MLC3"]);
  check(m.get("MLC1").status === "competing" && m.get("MLC1").precioParaGanar === 5445 && m.get("MLC1").ganador.precio === 6640 && m.get("MLC1").factores[0].estado === "boosted" && m.get("MLC1").ganador.factores[0].id === "free_shipping", "parsea estado, precios, ganador y factores (nuestros y del ganador)");
  check(m.get("MLC2").status === "not_listed" && m.get("MLC2").precioParaGanar === null && m.get("MLC2").razones[0] === "item_not_opted_in" && m.get("MLC2").ganador === null, "not_listed: sin precios ni ganador, con la razón");
  check(m.get("MLC3") === null && llamadas.length === 3 && llamadas[0].includes("version=v2") && llamadas[0].includes("siteId=MLC"), "una consulta que falla queda en null (no tira el lote); usa siteId=MLC y version=v2");
  llamadas.length = 0;
  const cat = await D.cargarEsCatalogo(mlGet, Array.from({ length: 45 }, (_, i) => "MLC" + (i + 1)));
  check(llamadas.length === 3 && cat.size === 44 && cat.get("MLC2") === true && cat.get("MLC1") === false && !cat.has("MLC9"), "tipo de publicación en lotes de 20 (3 llamadas para 45); una respuesta 404 no se inventa");
  console.log(`\n${ok} comprobaciones OK`);
})().catch((e) => { console.error("FALLÓ:", e.message); process.exit(1); });

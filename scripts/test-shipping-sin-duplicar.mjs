// Pruebas de S-08 (commit 2): rentabilidad/analyze y lib/envio-real escriben en ShippingCache sin duplicar. Sin red y sin Sheets reales:
// la hoja es un arreglo en memoria y ML es un simulador. NO limpia duplicados existentes (eso queda fuera de este commit).
// Uso:  node scripts/test-shipping-sin-duplicar.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ts = require(path.join(PROJ, "node_modules", "typescript"));
const out = fs.mkdtempSync(path.join(os.tmpdir(), "ship-sin-dup-"));
for (const f of ["envio-real", "backfill-shipping"]) {
  let js = ts.transpileModule(fs.readFileSync(`${PROJ}/lib/${f}.ts`, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText;
  js = js.replace(/require\("@\/lib\/([a-z-]+)"\)/g, 'require("./$1.js")');
  fs.writeFileSync(path.join(out, f + ".js"), js);
}
const E = require(path.join(out, "envio-real.js"));
let ok = 0; const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); ok++; console.log("  ✓", m); };

const idPlano = (v) => String(v ?? "").replace(/^'/, "").trim();
// Fila de Rentabilidad: A orden, B fecha, C item, E precio, F cogs, G comisión, H envío, I pérdida, N unidades, P fuente.
const filaRent = (orden) => [`'${orden}`, "2026-10-01", "MLC1", "T", "10000", "5000", "1000", "", "0", "", "", "", "", "1", "", ""];

function armar({ rentabilidad, cache, alLlamarML }) {
  const hoja = { Rentabilidad: rentabilidad, ShippingCache: cache, appends: [] };
  const colA = (rango) => rango.startsWith("ShippingCache");
  return {
    hoja,
    opciones: {
      mlGet: async (url) => {
        alLlamarML?.(hoja, url);
        if (/^\/orders\//.test(url)) return { data: { shipping: { id: 900 }, order_items: [{ quantity: 1 }] } };
        if (/\/costs$/.test(url)) return { data: { senders: [{ cost: 3000 }] } };
        return { data: { logistic_type: "fulfillment", shipping_items: [{ id: "MLC1", quantity: 1 }] } };
      },
      readSheet: async (rango) => {
        if (rango.startsWith("Rentabilidad")) return hoja.Rentabilidad.map((f) => [...f]);
        if (colA(rango)) return rango.includes(":A100000") ? hoja.ShippingCache.map((f) => [f[0]]) : hoja.ShippingCache.map((f) => [...f]);
        return [];
      },
      appendSheet: async (rango, filas) => { hoja.appends.push({ rango, n: filas.length }); if (colA(rango)) hoja.ShippingCache.push(...filas.map((f) => [...f])); },
      batchWriteSheet: async () => {},
      calcularMargen: () => ({ margenNeto: 1, margenPct: 1 }),
      forzarReintentos: false, dryRun: false, dryRunLimite: 10, omitirMarca: false, limite: null, tiempoMaximoMs: 60000,
    },
  };
}
const ids = (hoja) => hoja.ShippingCache.map((f) => idPlano(f[0]));

console.log("envio-real: orden nueva");
{ const { hoja, opciones } = armar({ rentabilidad: [filaRent("111")], cache: [] });
  await E.procesarTanda(opciones);
  eq(ids(hoja), ["111"], "se agrega una sola fila"); }

console.log("envio-real: otra corrida agrega la misma orden mientras ésta consulta a ML");
{ const { hoja, opciones } = armar({ rentabilidad: [filaRent("111"), filaRent("222")], cache: [],
    alLlamarML: (h, url) => { if (url === "/orders/111" && !h.ShippingCache.some((f) => idPlano(f[0]) === "111")) h.ShippingCache.push(["'111", "'900", "fulfillment", "x", "3000", "1", "1", "costs", ""]); } });
  await E.procesarTanda(opciones);
  eq(ids(hoja).sort(), ["111", "222"], "la 111 no se duplica (la otra corrida ya la escribió) y la 222 sí se agrega"); }

console.log("envio-real: reintento billing → costs de una orden ya cacheada (no se pierde la mejora)");
{ const { hoja, opciones } = armar({ rentabilidad: [filaRent("111").map((v, i) => (i === 15 ? "billing_sin_costs" : v))], cache: [["'111", "'900", "fulfillment", "x", "", "", "1", "billing", ""]] });
  opciones.forzarReintentos = true;
  await E.procesarTanda(opciones);
  eq(ids(hoja), ["111", "111"], "se agrega la fila mejorada (el lector se queda con la última)");
  eq(hoja.ShippingCache.at(-1)[7], "costs", "la última fila de la orden es la de fuente costs"); }

console.log("envio-real: no toca duplicados existentes");
{ const dup = [["'333", "'1", "fulfillment", "x"], ["'333", "'1", "fulfillment", "x", "3000", "1", "1", "costs", ""]];
  const { hoja, opciones } = armar({ rentabilidad: [filaRent("111")], cache: dup.map((f) => [...f]) });
  await E.procesarTanda(opciones);
  eq(ids(hoja), ["333", "333", "111"], "los 2 duplicados previos quedan igual y solo se suma la orden nueva"); }

console.log(`\n${ok} comprobaciones OK`);

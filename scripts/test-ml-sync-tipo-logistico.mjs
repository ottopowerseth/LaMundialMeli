// Pruebas de la columna T «Tipo logístico» de Publicaciones (ml-sync) y de lib/logistica.ts → tipoLogisticoItem.
// Ruta REAL de /api/ml-sync + lib/lock-sheets REAL, con ML (axios) y Sheets simulados en memoria: nada llama a Mercado Libre ni a Sheets.
// Uso:  node scripts/test-ml-sync-tipo-logistico.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import Module, { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ts = require(path.join(PROJ, "node_modules", "typescript"));
process.env.NODE_PATH = path.join(PROJ, "node_modules"); Module._initPaths();
const out = fs.mkdtempSync(path.join(os.tmpdir(), "ml-sync-tipo-"));
const compilar = (origen, destino) => {
  const src = fs.readFileSync(path.join(PROJ, origen), "utf8").replace(/from "@\/lib\/([\w-]+)"/g, 'from "./$1"');
  fs.writeFileSync(path.join(out, destino), ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);
};
for (const [o, d] of [["lib/log.ts", "log.js"], ["lib/http-retry.ts", "http-retry.js"], ["lib/rentabilidad.ts", "rentabilidad.js"], ["lib/backfill-shipping.ts", "backfill-shipping.js"], ["lib/ventas-historial.ts", "ventas-historial.js"],
  ["lib/guardas-filas.ts", "guardas-filas.js"], ["lib/lock-sheets.ts", "lock-sheets.js"], ["lib/texto-seguro.ts", "texto-seguro.js"], ["lib/logistica.ts", "logistica.js"], ["app/api/ml-sync/route.ts", "ml-sync.js"]]) compilar(o, d);

// ---- simulados ----
fs.writeFileSync(path.join(out, "ml-token.js"), `exports.getValidAccessToken = async () => "token-falso"; exports.instalarReintento401 = () => {};`);
fs.mkdirSync(path.join(out, "node_modules", "axios"), { recursive: true });
fs.writeFileSync(path.join(out, "node_modules", "axios", "index.js"), `const api = { create: () => ({ get: async (url) => ({ data: globalThis.__ml(url) }), interceptors: { response: { use: () => 0 } } }) }; module.exports = { __esModule: true, default: api, ...api };`);
fs.writeFileSync(path.join(out, "sheets.js"), `
const H = () => globalThis.__hojas;
const col = (L) => L.split("").reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0) - 1;
function parse(range) { const [hoja, ref] = range.split("!"); const m = ref.match(/^([A-Z]+)(\\d*)(?::([A-Z]+)(\\d*))?$/); const r1 = m[2] ? +m[2] - 1 : 0; return { hoja, c1: col(m[1]), c2: m[3] ? col(m[3]) : col(m[1]), r1, r2: m[4] ? +m[4] - 1 : (m[3] ? Infinity : (m[2] ? r1 : Infinity)) }; }
const recortar = (r) => { const s = [...r]; while (s.length && (s.at(-1) === "" || s.at(-1) === undefined)) s.pop(); return s; };
exports.ensureSheets = async () => {};
exports.readSheet = async (range) => { const p = parse(range); const filas = (H()[p.hoja] ??= []); return filas.slice(p.r1, p.r2 + 1).map((r) => recortar((r ?? []).slice(p.c1, p.c2 + 1))); };
exports.writeSheet = async (range, values) => { const p = parse(range); const filas = (H()[p.hoja] ??= []); values.forEach((fila, i) => { const r = (filas[p.r1 + i] ??= []); fila.forEach((v, j) => { r[p.c1 + j] = v; }); }); };
exports.appendSheet = async (range, values) => { (H()[parse(range).hoja] ??= []).push(...values.map((v) => [...v])); };
exports.reemplazarHoja = async (hoja, valores) => { globalThis.__reemplazos.push({ hoja, valores: JSON.parse(JSON.stringify(valores)) }); H()[hoja] = valores.map((f) => [...f]); return { sobranteLimpio: true }; };
exports.borrarFilasHoja = async () => {};`);
const { POST } = require(path.join(out, "ml-sync.js")); const { tipoLogisticoItem } = require(path.join(out, "logistica.js"));
let ok = 0; const check = (c, m) => { assert.ok(c, m); ok++; console.log("  ✓", m); }; const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); ok++; console.log("  ✓", m); };

console.log("tipoLogisticoItem");
eq([tipoLogisticoItem({ shipping: { logistic_type: "fulfillment" } }), tipoLogisticoItem({ shipping: { logistic_type: " xd_drop_off " } })], ["fulfillment", "xd_drop_off"], "devuelve el logistic_type de shipping (recortado)");
eq([tipoLogisticoItem({}), tipoLogisticoItem({ shipping: null }), tipoLogisticoItem({ shipping: {} }), tipoLogisticoItem({ shipping: { logistic_type: null } }), tipoLogisticoItem({ shipping: { logistic_type: 5 } }), tipoLogisticoItem(null), tipoLogisticoItem(undefined)], ["", "", "", "", "", "", ""], "sin shipping, sin logistic_type o con un valor que no es texto → «»");

console.log("ml-sync escribe la columna T en Publicaciones");
const item = (id, titulo, lt, extra = {}) => ({ id, category_id: "MLC1", title: titulo, available_quantity: 5, sold_quantity: 10, price: 10000, status: "active", listing_type_id: "gold_special", permalink: "https://x/" + id, shipping: lt === undefined ? undefined : { logistic_type: lt }, ...extra });
const ITEMS = [item("MLC100", "Producto Full", "fulfillment"), item("MLC200", "Producto Normal", "xd_drop_off"), item("MLC300", "Sin shipping", undefined), item("MLC400", "=SUMA(1;1)", "cross_docking")];
globalThis.__ml = (url) => {
  if (url === "/users/me") return { id: "42" };
  if (url.startsWith("/users/42/items/search?status=active")) return { results: ITEMS.map((i) => i.id), paging: { total: ITEMS.length } };
  if (url.includes("/items/search")) return { results: [], paging: { total: 0 } };
  if (url.startsWith("/items?ids=")) { const ids = url.slice("/items?ids=".length).split("&")[0].split(","); return ids.map((id) => ({ code: 200, body: ITEMS.find((i) => i.id === id) })); }
  return { results: [], paging: { total: 0 }, elements: [] };
};
const nuevo = (pubs) => { globalThis.__hojas = { Locks: [["Clave", "Token", "Vence (epoch s)", "Liberado"]], Publicaciones: pubs ?? [["ID"]], Ventas: [["ID"]], ShippingCache: [["ID"]] }; globalThis.__reemplazos = []; };
const silencio = async (fn) => { const e = console.error, w = console.warn, l = console.log; console.error = () => {}; console.warn = () => {}; console.log = () => {}; try { return await fn(); } finally { console.error = e; console.warn = w; console.log = l; } };
{ nuevo(); const res = await silencio(() => POST()); const pub = globalThis.__reemplazos.find((r) => r.hoja === "Publicaciones");
  check(!!pub, "el sync llegó a escribir Publicaciones (estado " + res.status + ")");
  const [enc, ...filas] = pub.valores; eq([enc.length, enc[18], enc[19]], [20, "Unidades", "Tipo logístico"], "el encabezado tiene 20 columnas: S = Unidades (sin mover) y T = Tipo logístico");
  check(filas.every((f) => f.length === 20), "todas las filas tienen 20 columnas");
  const porId = Object.fromEntries(filas.map((f) => [f[0], f])); eq([porId.MLC100[19], porId.MLC200[19], porId.MLC300[19], porId.MLC400[19]], ["fulfillment", "xd_drop_off", "", "cross_docking"], "T = shipping.logistic_type de cada publicación (vacío si ML no lo informa)");
  eq([porId.MLC100[0], porId.MLC100[3], porId.MLC100[5], porId.MLC100[8], porId.MLC100[18]], ["MLC100", 5, "", "", "1"], "las columnas A–S no cambian (ID, Stock, Costo, Envío, Unidades)");
  eq(porId.MLC400[2].startsWith("'"), true, "un título que empieza con «=» sigue protegido (texto externo)"); }

console.log("los datos manuales (Costo, Envío, Unidades) se siguen conservando y T se reescribe");
{ const previa = [["ID", "Categoría", "Título", "Stock", "Vendidos", "Costo", "Precio de Venta", "Comisión $", "Envío", "Comisión %", "Estado ML", "Tipo Publicación", "Ganancia", "Margen %", "Días de Stock", "Alerta", "URL", "Actualizado", "Unidades"],
    ["MLC100", "MLC1", "Producto Full", 5, 10, 4000, 10000, "", 2500, 0.13, "active", "gold_special", "", "", "", "", "", "", "3"]];
  nuevo(previa); await silencio(() => POST()); const f = globalThis.__reemplazos.find((r) => r.hoja === "Publicaciones").valores.find((r) => r[0] === "MLC100");
  eq([f[5], f[8], f[18], f[19]], [4000, 2500, "3", "fulfillment"], "Costo, Envío y Unidades manuales se preservan y T trae el tipo actual"); }
console.log("\n" + ok + " comprobaciones OK");

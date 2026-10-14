// Pruebas de S-07 (commit 2): protección de textos EXTERNOS que empiezan con = + - @ (lib/texto-seguro.ts). Hojas en memoria que modelan lo medido en la
// sonda del 2026-10-15 (USER_ENTERED: «=1+1» y «+1» → fórmula; «-A1» y «@x» → texto; un apóstrofo inicial se consume y deja TEXTO). Datos sintéticos.
// Nada llama a Mercado Libre ni a Sheets.  Uso:  node scripts/test-texto-seguro.mjs
//  A. el ayudante  B. modelo de Sheets: sin ayudante se ejecutaría, con ayudante queda el texto original  C. dónde se aplica (y dónde NO)
//  D. comportamiento: importar (Lista Defontana), rentabilidad/analyze (producto) y costo-auto (SKU, código, artículo)
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
const XLSX = require(path.join(PROJ, "node_modules", "xlsx"));
const out = fs.mkdtempSync(path.join(os.tmpdir(), "texto-seguro-"));
const compilar = (origen, destino) => {
  const src = fs.readFileSync(path.join(PROJ, origen), "utf8").replace(/from "@\/lib\/([\w-]+)"/g, 'from "./$1"');
  fs.writeFileSync(path.join(out, destino), ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);
};
for (const [o, d] of [["lib/log.ts", "log.js"], ["lib/http-retry.ts", "http-retry.js"], ["lib/rentabilidad.ts", "rentabilidad.js"], ["lib/backfill-shipping.ts", "backfill-shipping.js"], ["lib/numero-texto.ts", "numero-texto.js"],
  ["lib/texto-seguro.ts", "texto-seguro.js"], ["lib/envio-real.ts", "envio-real.js"], ["lib/guardas-filas.ts", "guardas-filas.js"], ["lib/lock-sheets.ts", "lock-sheets.js"], ["lib/defontana.ts", "defontana.js"],
  ["lib/costo-auto.ts", "costo-auto.js"], ["app/api/rentabilidad/analyze/route.ts", "analyze.js"], ["app/api/lista-defontana/importar/route.ts", "importar.js"]]) compilar(o, d);
fs.writeFileSync(path.join(out, "ml-token.js"), `exports.getValidAccessToken = async () => "token-falso"; exports.instalarReintento401 = () => {};`);
fs.mkdirSync(path.join(out, "node_modules", "axios"), { recursive: true });
fs.writeFileSync(path.join(out, "node_modules", "axios", "index.js"), `const api = { create: () => ({ get: async (url) => globalThis.__ml(url) }) }; module.exports = { __esModule: true, default: api, ...api };`);
fs.writeFileSync(path.join(out, "sheets.js"), `
const H = () => globalThis.__hojas;
const col = (L) => L.split("").reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0) - 1;
function parse(range) { const [hoja, ref] = range.split("!"); const m = ref.match(/^([A-Z]+)(\\d*)(?::([A-Z]+)(\\d*))?$/); const r1 = m[2] ? +m[2] - 1 : 0; return { hoja, c1: col(m[1]), c2: m[3] ? col(m[3]) : col(m[1]), r1, r2: m[4] ? +m[4] - 1 : (m[3] ? Infinity : (m[2] ? r1 : Infinity)) }; }
const guarda = (v) => (typeof v === "string" && v.startsWith("'") ? v.slice(1) : v);
const mostrado = (v) => (v === undefined || v === null ? "" : String(v));
const recortar = (r) => { const s = [...r]; while (s.length && (s.at(-1) === "" || s.at(-1) === undefined)) s.pop(); return s; };
exports.ensureSheets = async () => {};
exports.readSheet = async (range) => { const p = parse(range); const filas = (H()[p.hoja] ??= []); const res = filas.slice(p.r1, p.r2 + 1).map((r) => recortar((r ?? []).slice(p.c1, p.c2 + 1).map(mostrado))); while (res.length && res.at(-1).length === 0) res.pop(); return res; };
exports.writeSheet = async (range, values) => { const p = parse(range); const filas = (H()[p.hoja] ??= []); globalThis.__raw.push({ op: "write", hoja: p.hoja, range, values }); values.forEach((fila, i) => { const r = (filas[p.r1 + i] ??= []); fila.forEach((v, j) => { r[p.c1 + j] = guarda(v); }); }); };
exports.appendSheet = async (range, values) => { const p = parse(range); globalThis.__raw.push({ op: "append", hoja: p.hoja, range, values }); (H()[p.hoja] ??= []).push(...values.map((f) => f.map(guarda))); };
exports.reemplazarHoja = async (hoja, valores) => { globalThis.__raw.push({ op: "reemplazar", hoja, values: valores }); globalThis.__hojas[hoja] = valores.map((f) => f.map(guarda)); return { sobranteLimpio: true }; };
exports.borrarFilasHoja = async () => {};`);
const TS = require(path.join(out, "texto-seguro.js")); const NT = require(path.join(out, "numero-texto.js"));
let ok = 0; const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); ok++; console.log("  ✓", m); }; const check = (c, m) => { assert.ok(c, m); ok++; console.log("  ✓", m); };
const f = TS.textoExternoSeguro;

console.log("A. el ayudante textoExternoSeguro");
eq([f("=1+1"), f("+1+1"), f("-A1"), f("@x")], ["'=1+1", "'+1+1", "'-A1", "'@x"], "prefija los cuatro caracteres iniciales (=, +, -, @)");
eq([f('=IMPORTXML("http://x";"//a")'), f("+cmd|' /C calc'!A0"), f("-1+1"), f("@SUMA(1;1)")], ["'=IMPORTXML(\"http://x\";\"//a\")", "'+cmd|' /C calc'!A0", "'-1+1", "'@SUMA(1;1)"], "fórmulas reales de ataque: quedan intactas con el apóstrofo delante");
eq([f(" =1+1"), f("\t=1+1"), f("\n@x")], ["' =1+1", "'\t=1+1", "'\n@x"], "también si empiezan con espacio, tabulador o salto de línea");
eq([f(-5), f(-2537.9), f("-5"), f("-2537.9"), f("-2537,9"), f("+5"), f("-0.5"), f(" -5 ")], ["-5", "-2537.9", "-5", "-2537.9", "-2537,9", "+5", "-0.5", " -5 "], "los NEGATIVOS NUMÉRICOS no se alteran (número JS o texto numérico, con punto o coma, y +5)");
eq([f("Shampoo Elvive 400 ml"), f("Crema 2x1"), f("ÑANDÚ café ☕"), f("100% algodón"), f("A-B=C"), f("a@b.cl"), f("(=x)")], ["Shampoo Elvive 400 ml", "Crema 2x1", "ÑANDÚ café ☕", "100% algodón", "A-B=C", "a@b.cl", "(=x)"], "un texto normal queda igual (con tildes, emojis y esos caracteres en medio)");
eq([f(""), f(null), f(undefined), f("   ")], ["", "", "", "   "], "vacío, null y undefined → \"\"; solo espacios queda igual");
eq([f("'=1+1"), f(f("=1+1")), f(f(f("-A1")))], ["'=1+1", "'=1+1", "'-A1"], "idempotente: lo que ya empieza con apóstrofo no se prefija otra vez (ni aplicado varias veces)");
eq([f("="), f("+"), f("-"), f("@")], ["'=", "'+", "'-", "'@"], "los caracteres solos también se protegen");

console.log("B. modelo de Sheets (USER_ENTERED): sin el ayudante se ejecutaría; con el ayudante queda el texto original");
{ const interpretar = (v) => (typeof v !== "string" ? { tipo: "numero", valor: v } : v.startsWith("'") ? { tipo: "texto", valor: v.slice(1) } : /^[=+]/.test(v) ? { tipo: "FÓRMULA", valor: v } : { tipo: "texto", valor: v });
  const ataques = ['=IMPORTXML("http://x";"//a")', "+1+1", "=HYPERLINK(\"http://x\";\"clic\")", "=1+1"];
  check(ataques.every((a) => interpretar(a).tipo === "FÓRMULA"), "SIN ayudante, «=...» y «+...» se guardan como FÓRMULA (lo medido en la sonda)");
  check(ataques.every((a) => { const r = interpretar(f(a)); return r.tipo === "texto" && r.valor === a; }), "CON ayudante quedan como TEXTO y lo que se lee de vuelta es EXACTAMENTE el texto original");
  check(["-A1", "@x", "Shampoo", "-5"].every((a) => interpretar(f(a)).valor === a), "«-A1», «@x», un texto normal y «-5» se leen de vuelta idénticos"); }

console.log("C. dónde se aplica y dónde NO (revisión del código fuente)");
{ const leer = (rel) => fs.readFileSync(path.join(PROJ, rel), "utf8").replace(/\r\n/g, "\n");
  const cuenta = (src, t) => src.split(t).length - 1;
  const ml = leer("app/api/ml-sync/route.ts");
  check(ml.includes("textoExternoSeguro(item.title)") && ml.includes("textoExternoSeguro((item?.item as Record<string, unknown>)?.title)") && ml.includes("?.seller_sku)") && ml.includes("?.nickname)") && cuenta(ml, "textoExternoSeguro(") === 4, "ml-sync: título de Publicaciones y título, SKU y comprador de Ventas (4 usos)");
  check(!/textoExternoSeguro\([^\n]*(quantity|unit_price|total_amount|sold_quantity|price)/.test(ml), "ml-sync: ninguna columna numérica (cantidad, precios, totales) usa el ayudante");
  const an = leer("app/api/rentabilidad/analyze/route.ts"); check(an.includes("textoExternoSeguro(fila.producto)") && cuenta(an, "textoExternoSeguro(") === 1, "rentabilidad/analyze: solo el producto");
  const ca = leer("lib/costo-auto.ts"); check(ca.includes("textoExternoSeguro(r.p.sku)") && ca.includes("textoExternoSeguro(r.calculo.codigo)") && ca.includes("textoExternoSeguro(r.calculo.articulo)") && cuenta(ca, "textoExternoSeguro(") === 3, "costo-auto: SKU, código y artículo (3 usos); el costo y el resto no");
  const im = leer("app/api/lista-defontana/importar/route.ts"); check(["proveedor", "marca", "familia", "cod", "barras", "articulo"].every((c) => im.includes(`textoExternoSeguro(f.${c})`)) && im.includes("String(f.mayor)") && cuenta(im, "textoExternoSeguro(") === 6, "importar: proveedor, marca, familia, código, barras y artículo (6 usos); el MAYOR queda como estaba");
  const ta = leer("lib/tarifa-envio.ts"); check(ta.includes("textoExternoSeguro(f.sku)") && cuenta(ta, "textoExternoSeguro(") === 1, "tarifa-envio: solo el SKU");
  const conAmbos = ["app/api/ml-sync/route.ts", "app/api/rentabilidad/analyze/route.ts", "lib/costo-auto.ts", "app/api/lista-defontana/importar/route.ts", "lib/tarifa-envio.ts", "lib/envio-real.ts"].flatMap((rel) => leer(rel).split("\n").filter((l) => l.includes("textoExternoSeguro(") && l.includes("numeroComoTexto(")));
  eq(conAmbos, [], "ninguna línea mezcla el ayudante de texto con el de números (las columnas numéricas no usan textoExternoSeguro)");
  const usan = []; const recorrer = (d) => { for (const e of fs.readdirSync(path.join(PROJ, d), { withFileTypes: true })) { const rel = `${d}/${e.name}`; if (e.isDirectory()) recorrer(rel); else if (/\.(ts|tsx)$/.test(e.name) && leer(rel).includes("textoExternoSeguro(") && rel !== "lib/texto-seguro.ts") usan.push(rel); } }; recorrer("app"); recorrer("lib");
  eq(usan.sort(), ["app/api/lista-defontana/importar/route.ts", "app/api/ml-sync/route.ts", "app/api/rentabilidad/analyze/route.ts", "lib/costo-auto.ts", "lib/tarifa-envio.ts"], "el ayudante solo se usa en esos 5 escritores"); }

console.log("D. comportamiento de los escritores (hojas en memoria, datos sintéticos)");
const nuevoMundo = () => { globalThis.__hojas = { Locks: [["Clave", "Token", "Vence (epoch s)", "Liberado"]], Rentabilidad: [["Orden"]], RentabilidadProgreso: [], ShippingCache: [["ID"]], Publicaciones: [["ID"], ["MLC111", "cat", "Producto de prueba", "10", "5", "20000"]], "Auditoría": [["Mes"]] }; globalThis.__raw = []; };
{ // D1. importar la Lista Defontana con textos peligrosos del «proveedor»
  const importar = require(path.join(out, "importar.js")); nuevoMundo();
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["PROVEEDOR", "MARCA", "FAMILIA", "cod", "barras", "articulo", "MAYOR"],
    ["=HYPERLINK(\"http://x\";\"y\")", "+cmd|calc", "-A1", "@x", "7801234567890", "=IMPORTXML(\"http://x\";\"//a\")", 1234.5], ["Proveedor Normal", "Marca Normal", "Familia Normal", "COD-1", "-5", "Shampoo normal 400 ml", -250.5]]), "PRECIOS");
  const fd = new FormData(); fd.append("archivo", new File([XLSX.write(wb, { type: "buffer", bookType: "xlsx" })], "lista.xlsx"));
  const e = console.error; console.error = () => {}; let res; try { res = await importar.POST(new Request("http://x", { method: "POST", body: fd })); } finally { console.error = e; }
  const filas = globalThis.__raw.find((x) => x.op === "reemplazar" && x.hoja === "Lista Defontana").values.slice(1);
  eq([res.status, filas.length], [200, 2], "importar: responde ok con 2 filas");
  eq(filas[0].slice(0, 6), ["'=HYPERLINK(\"http://x\";\"y\")", "'+cmd|calc", "'-A1", "'@x", "7801234567890", "'=IMPORTXML(\"http://x\";\"//a\")"], "los textos peligrosos del proveedor se escribieron con apóstrofo; las barras numéricas quedan igual");
  eq(filas[1].slice(0, 6), ["Proveedor Normal", "Marca Normal", "Familia Normal", "COD-1", "-5", "Shampoo normal 400 ml"], "los textos normales y el «-5» numérico NO se alteran");
  eq([filas[0][6], filas[1][6]], ["1234.5", "-250.5"], "el MAYOR (numérico, incluso negativo) no se toca");
  const guardada = globalThis.__hojas["Lista Defontana"][1]; eq(guardada.slice(0, 3), ['=HYPERLINK("http://x";"y")', "+cmd|calc", "-A1"], "lo que devuelve la hoja es el texto original (el apóstrofo se consumió)"); }
{ // D2. rentabilidad/analyze: título de producto peligroso en la Billing
  const { POST } = require(path.join(out, "analyze.js")); nuevoMundo();
  globalThis.__ml = async (url) => {
    if (url.includes("/billing/")) return { data: { total: 2, results: [
      { charge_info: { detail_sub_type: "CV", detail_amount: -1000 }, sales_info: [{ order_id: 2000111, sale_date_time: "2026-09-01T10:00:00", transaction_amount: 10000 }], items_info: [{ item_id: "MLC111", item_title: '=HYPERLINK("http://x";"y")', order_id: 2000111, item_amount: 1 }] },
      { charge_info: { detail_sub_type: "CV", detail_amount: -900 }, sales_info: [{ order_id: 2000112, sale_date_time: "2026-09-02T10:00:00", transaction_amount: 9000 }], items_info: [{ item_id: "MLC111", item_title: "Shampoo normal 400 ml", order_id: 2000112, item_amount: 1 }] }] } };
    if (/^\/orders\//.test(url)) return { data: { shipping: { id: 900 }, order_items: [{ quantity: 1 }] } };
    if (/\/costs$/.test(url)) return { data: { senders: [{ cost: 3000 }] } };
    return { data: { logistic_type: "fulfillment", shipping_items: [{ id: "MLC111", quantity: 1 }] } }; };
  const e = console.error, w = console.warn; console.error = () => {}; console.warn = () => {}; let res; try { res = await POST(new Request("http://x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mes: "2026-09" }) })); } finally { console.error = e; console.warn = w; }
  const j = await res.json(); const filas = globalThis.__raw.filter((x) => x.hoja === "Rentabilidad" && x.op === "append").flatMap((x) => x.values).filter((r) => String(r[0]).startsWith("'2000"));
  check(res.status === 200 && j.ordenesNuevas === 2 && filas.length === 2, "analyze: 2 órdenes nuevas");
  const peligrosa = filas.find((r) => r[0] === "'2000111"), normal = filas.find((r) => r[0] === "'2000112");
  eq([peligrosa[3], normal[3]], ["'=HYPERLINK(\"http://x\";\"y\")", "Shampoo normal 400 ml"], "el producto peligroso se escribe con apóstrofo y el normal queda igual");
  check(peligrosa[9].startsWith("'-") && normal[9].startsWith("'-") && peligrosa[4] === "'10000", "los números (incluido el margen NEGATIVO) siguen con el ayudante de números y NO se confunden con texto: «" + peligrosa[9] + "»");
  eq(globalThis.__hojas.Rentabilidad.find((r) => r[0] === "2000111")[3], '=HYPERLINK("http://x";"y")', "lo que devuelve la hoja es el producto original"); }
{ // D3. costo-auto: SKU, código y artículo (de Defontana) peligrosos en CostoOrigen
  const CA = require(path.join(out, "costo-auto.js")); nuevoMundo(); const S = require(path.join(out, "sheets.js"));
  const defontana = { proveedor: "P", marca: "M", familia: "F", cod: "=SUMA(1;1)", barras: "", articulo: "+SHAMPOO 500 ML", mayor: 1234.5 };
  globalThis.__hojas.Publicaciones = [["ID"], ["MLC1"], ["MLC2"]];
  const normal = { proveedor: "P", marca: "M", familia: "F", cod: "COD-OK", barras: "", articulo: "Shampoo normal", mayor: 900 };
  const pub = (id, sku, titulo, fila) => ({ id, titulo, sku, gtin: null, precio: 5000, estado: "active", unidades: 1, costoActual: "", fila, ingreso30d: 0 });
  const op = { readSheet: S.readSheet, writeSheet: S.writeSheet, appendSheet: S.appendSheet, batchWriteSheet: async () => {}, publicaciones: [pub("MLC1", "=SUMA(1;1)", "Shampoo 500 ml", 2), pub("MLC2", "COD-OK", "Otro", 3)], porCod: new Map([["=SUMA(1;1)", defontana], ["COD-OK", normal]]), porBarras: new Map(), equivalencias: new Map(), ahora: new Date("2026-10-15T12:00:00Z"), dryRun: false };
  await CA.procesarCostoAuto(op); const filas = globalThis.__raw.filter((x) => x.hoja === "CostoOrigen" && x.op === "append").flatMap((x) => x.values);
  const f1 = filas.find((r) => r[0] === "MLC1"), f2 = filas.find((r) => r[0] === "MLC2");
  check(!!f1 && !!f2, "costo-auto: se registran las 2 publicaciones en CostoOrigen");
  eq([f1[1], f1[6], f1[7]], ["'=SUMA(1;1)", "'=SUMA(1;1)", "'+SHAMPOO 500 ML"], "SKU, código y artículo peligrosos se escriben con apóstrofo");
  eq([f2[0], f2[1], f2[6], f2[7]], ["MLC2", "COD-OK", "COD-OK", "Shampoo normal"], "el ID, un SKU normal, su código y su artículo quedan igual"); }

console.log("E. ida y vuelta: título y SKU que empiezan con -, =, + y @ se escriben con el ayudante y se leen de vuelta IDÉNTICOS (hoja en memoria que consume el apóstrofo)");
const TITULOS = ["-Oferta 2x1 shampoo", "=Shampoo (nuevo) 400 ml", "+Combo familiar", "@Promo 2026"]; const SKUS = ["-SKU-1", "=SKU2", "+SKU3", "@SKU4"];
{ // E1. el ayudante contra la hoja
  const S = require(path.join(out, "sheets.js")); nuevoMundo(); globalThis.__hojas.Prueba = [];
  await S.writeSheet("Prueba!A1:B4", TITULOS.map((t, i) => [f(t), f(SKUS[i])]));
  const raw = globalThis.__raw.at(-1).values; check(raw.every((fila) => fila.every((c) => c.startsWith("'"))), "lo escrito lleva apóstrofo en las 8 celdas (4 títulos y 4 SKU): " + raw[0].join(" | "));
  const leido = await S.readSheet("Prueba!A1:B4"); eq(leido, TITULOS.map((t, i) => [t, SKUS[i]]), "la hoja devuelve los 4 títulos y los 4 SKU exactamente como eran"); }
{ // E2. importar (Lista Defontana): código = SKU y artículo = título
  const importar = require(path.join(out, "importar.js")); nuevoMundo();
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["PROVEEDOR", "MARCA", "FAMILIA", "cod", "barras", "articulo", "MAYOR"], ...SKUS.map((s, i) => ["Proveedor", "Marca", "Familia", s, "", TITULOS[i], 100 + i])]), "PRECIOS");
  const fd = new FormData(); fd.append("archivo", new File([XLSX.write(wb, { type: "buffer", bookType: "xlsx" })], "lista.xlsx"));
  const e = console.error; console.error = () => {}; let res; try { res = await importar.POST(new Request("http://x", { method: "POST", body: fd })); } finally { console.error = e; }
  eq(res.status, 200, "importar responde ok"); const hoja = globalThis.__hojas["Lista Defontana"].slice(1); eq([hoja.map((r) => r[3]), hoja.map((r) => r[5])], [SKUS, TITULOS], "importar: los 4 códigos (SKU) y los 4 artículos (títulos) se leen de vuelta idénticos"); }
{ // E3. rentabilidad/analyze: producto = título
  const { POST } = require(path.join(out, "analyze.js")); nuevoMundo();
  globalThis.__ml = async (url) => {
    if (url.includes("/billing/")) return { data: { total: 4, results: TITULOS.map((t, i) => ({ charge_info: { detail_sub_type: "CV", detail_amount: -1000 }, sales_info: [{ order_id: 2000211 + i, sale_date_time: "2026-09-01T10:00:00", transaction_amount: 10000 }], items_info: [{ item_id: "MLC111", item_title: t, order_id: 2000211 + i, item_amount: 1 }] })) } };
    if (/^\/orders\//.test(url)) return { data: { shipping: { id: 900 }, order_items: [{ quantity: 1 }] } };
    if (/\/costs$/.test(url)) return { data: { senders: [{ cost: 3000 }] } };
    return { data: { logistic_type: "fulfillment", shipping_items: [{ id: "MLC111", quantity: 1 }] } }; };
  const e = console.error, w = console.warn; console.error = () => {}; console.warn = () => {}; let res; try { res = await POST(new Request("http://x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mes: "2026-09" }) })); } finally { console.error = e; console.warn = w; }
  const j = await res.json(); eq([res.status, j.ordenesNuevas], [200, 4], "analyze procesa las 4 órdenes");
  const filas = globalThis.__hojas.Rentabilidad.slice(1).sort((a, b) => String(a[0]).localeCompare(String(b[0]))); eq(filas.map((r) => r[3]), TITULOS, "analyze: los 4 títulos de producto se leen de vuelta idénticos"); }
{ // E4. costo-auto: SKU y artículo
  const CA = require(path.join(out, "costo-auto.js")); nuevoMundo(); const S = require(path.join(out, "sheets.js")); globalThis.__hojas.Publicaciones = [["ID"], ...SKUS.map((_, i) => ["MLC" + (i + 1)])];
  const porCod = new Map(SKUS.map((s, i) => [s.toUpperCase(), { proveedor: "P", marca: "M", familia: "F", cod: s, barras: "", articulo: TITULOS[i], mayor: 1000 + i * 10 }]));
  const pubs = SKUS.map((s, i) => ({ id: "MLC" + (i + 1), titulo: TITULOS[i], sku: s, gtin: null, precio: 5000, estado: "active", unidades: 1, costoActual: "", fila: i + 2, ingreso30d: 0 }));
  await CA.procesarCostoAuto({ readSheet: S.readSheet, writeSheet: S.writeSheet, appendSheet: S.appendSheet, batchWriteSheet: async () => {}, publicaciones: pubs, porCod, porBarras: new Map(), equivalencias: new Map(), ahora: new Date("2026-10-15T12:00:00Z"), dryRun: false });
  const filas = globalThis.__hojas.CostoOrigen.slice(1).sort((a, b) => String(a[0]).localeCompare(String(b[0]))); eq([filas.map((r) => r[1]), filas.map((r) => r[7])], [SKUS, TITULOS], "costo-auto: los 4 SKU y los 4 artículos se leen de vuelta idénticos en CostoOrigen"); }
{ // E5. los lectores que comparan contra valores guardados siguen igual: el valor leído (sin apóstrofo) coincide con el valor crudo que calcula el código
  const S = require(path.join(out, "sheets.js")); nuevoMundo(); globalThis.__hojas.Prueba = []; await S.writeSheet("Prueba!A1:A4", SKUS.map((s) => [f(s)])); const leidos = (await S.readSheet("Prueba!A1:A4")).map((r) => r[0]);
  check(SKUS.every((s, i) => leidos[i] === s && leidos[i].toUpperCase() === s.toUpperCase()), "comparar un SKU leído de la hoja con el SKU crudo (también en mayúsculas, como hace el cruce con Defontana) da lo mismo que antes de proteger"); }

console.log("\n" + ok + " comprobaciones OK");

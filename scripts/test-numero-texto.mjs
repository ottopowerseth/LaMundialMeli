// Pruebas de S-07 (commit 1): números como TEXTO con apóstrofo en Rentabilidad, ShippingCache y TarifaEnvio. Hojas en memoria; ML simulado con valores
// sintéticos (nada de datos reales). Nada llama a Mercado Libre ni a Sheets.  Uso:  node scripts/test-numero-texto.mjs
//  A. el ayudante  B. los lectores actuales (Number y leerNumeroHoja) leen igual lo prefijado  C. el verificador estático falla si alguien lo rompe
//  D. envio-real (filas nuevas de ShippingCache y ACTUALIZACIONES de Rentabilidad)  E. rentabilidad/analyze de punta a punta con una Billing sintética
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import Module, { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ts = require(path.join(PROJ, "node_modules", "typescript"));
process.env.NODE_PATH = path.join(PROJ, "node_modules"); Module._initPaths();
const out = fs.mkdtempSync(path.join(os.tmpdir(), "numero-texto-"));
const compilar = (origen, destino) => {
  const src = fs.readFileSync(path.join(PROJ, origen), "utf8").replace(/from "@\/lib\/([\w-]+)"/g, 'from "./$1"');
  fs.writeFileSync(path.join(out, destino), ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);
};
for (const [o, d] of [["lib/log.ts", "log.js"], ["lib/http-retry.ts", "http-retry.js"], ["lib/rentabilidad.ts", "rentabilidad.js"], ["lib/backfill-shipping.ts", "backfill-shipping.js"], ["lib/numero-texto.ts", "numero-texto.js"], ["lib/texto-seguro.ts", "texto-seguro.js"],
  ["lib/numero-hoja.ts", "numero-hoja.js"], ["lib/envio-real.ts", "envio-real.js"], ["lib/guardas-filas.ts", "guardas-filas.js"], ["lib/lock-sheets.ts", "lock-sheets.js"], ["app/api/rentabilidad/analyze/route.ts", "analyze.js"]]) compilar(o, d);

// Hojas en memoria que se comportan como Sheets con USER_ENTERED para lo que importa aquí (medido en la sonda del 2026-10-15): un apóstrofo inicial se
// consume y la celda guarda TEXTO. Se registra también lo que se ESCRIBIÓ (con el apóstrofo) para comprobar a los escritores.
fs.writeFileSync(path.join(out, "ml-token.js"), `exports.getValidAccessToken = async () => "token-falso"; exports.instalarReintento401 = () => {};`);
fs.mkdirSync(path.join(out, "node_modules", "axios"), { recursive: true });
fs.writeFileSync(path.join(out, "node_modules", "axios", "index.js"), `const api = { create: () => ({ get: async (url) => globalThis.__ml(url) }) }; module.exports = { __esModule: true, default: api, ...api };`);
fs.writeFileSync(path.join(out, "sheets.js"), `
const H = () => globalThis.__hojas;
const col = (L) => L.split("").reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0) - 1;
function parse(range) { const [hoja, ref] = range.split("!"); const m = ref.match(/^([A-Z]+)(\\d*)(?::([A-Z]+)(\\d*))?$/); const r1 = m[2] ? +m[2] - 1 : 0; return { hoja, c1: col(m[1]), c2: m[3] ? col(m[3]) : col(m[1]), r1, r2: m[4] ? +m[4] - 1 : (m[3] ? Infinity : (m[2] ? r1 : Infinity)) }; }
const guarda = (v) => (typeof v === "string" && v.startsWith("'") ? v.slice(1) : v); // lo que Sheets conserva
const mostrado = (v) => (v === undefined || v === null ? "" : String(v));          // lo que devuelve readSheet (valor mostrado)
const recortar = (r) => { const s = [...r]; while (s.length && (s.at(-1) === "" || s.at(-1) === undefined)) s.pop(); return s; };
exports.ensureSheets = async () => {};
exports.readSheet = async (range) => { const p = parse(range); const filas = (H()[p.hoja] ??= []); const res = filas.slice(p.r1, p.r2 + 1).map((r) => recortar((r ?? []).slice(p.c1, p.c2 + 1).map(mostrado))); while (res.length && res.at(-1).length === 0) res.pop(); return res; };
exports.writeSheet = async (range, values) => { const p = parse(range); const filas = (H()[p.hoja] ??= []); (globalThis.__raw.push({ op: "write", hoja: p.hoja, range, values })); values.forEach((fila, i) => { const r = (filas[p.r1 + i] ??= []); fila.forEach((v, j) => { r[p.c1 + j] = guarda(v); }); }); };
exports.appendSheet = async (range, values) => { const p = parse(range); globalThis.__raw.push({ op: "append", hoja: p.hoja, range, values }); (H()[p.hoja] ??= []).push(...values.map((f) => f.map(guarda))); };
exports.borrarFilasHoja = async () => {};`);
const NT = require(path.join(out, "numero-texto.js")); const NH = require(path.join(out, "numero-hoja.js")); const ER = require(path.join(out, "envio-real.js"));
let ok = 0; const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); ok++; console.log("  ✓", m); }; const check = (c, m) => { assert.ok(c, m); ok++; console.log("  ✓", m); };
const guardaSheets = (v) => (typeof v === "string" && v.startsWith("'") ? v.slice(1) : v);

console.log("A. el ayudante numeroComoTexto");
{ const f = NT.numeroComoTexto;
  eq([f(""), f(null), f(undefined), f("   ")], ["", "", "", ""], "vacío (null, undefined, \"\" o solo espacios) devuelve \"\" sin apóstrofo suelto");
  eq([f(15), f("15"), f(0), f("0")], ["'15", "'15", "'0", "'0"], "enteros (número o texto, incluido el cero)");
  eq([f(4989.6), f("4989.6"), f(-2537.9), f("-2537.9"), f(-5), f(10.2)], ["'4989.6", "'4989.6", "'-2537.9", "'-2537.9", "'-5", "'10.2"], "un decimal y negativos");
  eq([f(1019.05), f("1019.05"), f(1000.25), f(0.05)], ["'1019.05", "'1019.05", "'1000.25", "'0.05"], "dos decimales (incluida la forma x.0d)");
  eq([f("'15"), f("'-2537.9"), f(f(4989.6)), f(f(f(1019.05)))], ["'15", "'-2537.9", "'4989.6", "'1019.05"], "idempotente: lo que ya empieza con apóstrofo no se prefija otra vez, ni aplicado varias veces");
  eq(f(1e21), "'1e+21", "no oculta valores raros (se prefija tal cual)"); }

console.log("B. los lectores actuales leen igual lo prefijado (la hoja guarda texto sin apóstrofo y devuelve el valor mostrado)");
{ const valores = [-2537.9, 15, 4989.6, 1019.05, 0, -0.5, 799.4, 1000.25, 1234567.8, 0.05, 10.2, -5, 3000];
  const mostrado = (n) => String(guardaSheets(NT.numeroComoTexto(n))); // lo que leería readSheet
  check(valores.every((n) => !mostrado(n).startsWith("'")), "lo que devuelve la hoja NO trae apóstrofo (se consumió)");
  check(valores.every((n) => Number(mostrado(n)) === n), "Number(...) lee exactamente el mismo número: " + valores.map((n) => `${n}→${Number(mostrado(n))}`).join(" "));
  check(valores.every((n) => NH.leerNumeroHoja(mostrado(n)) === n), "leerNumeroHoja (el de la pantalla) lee el mismo número en los 13 casos");
  check(valores.every((n) => Number(mostrado(n)) === Number(String(n))), "idéntico a lo que se leía antes de S-07 con un texto sin apóstrofo (compatibilidad con las 790 celdas que ya eran texto)");
  eq([NH.leerNumeroHoja(""), Number("")], [0, 0], "una celda vacía se sigue leyendo como 0 (no queda un apóstrofo suelto)"); }

console.log("C. el verificador estático falla si alguien rompe la regla (se prueba sobre una COPIA alterada del código)");
{ const raiz = fs.mkdtempSync(path.join(os.tmpdir(), "verif-copia-")); for (const d of ["app", "lib"]) fs.cpSync(path.join(PROJ, d), path.join(raiz, d), { recursive: true });
  const correr = () => spawnSync(process.execPath, [path.join(PROJ, "scripts", "verificar-escritores-texto.mjs")], { env: { ...process.env, S07_RAIZ: raiz }, encoding: "utf8" });
  const alterar = (rel, de, a) => { const f = path.join(raiz, rel); const orig = fs.readFileSync(f, "utf8"); const s = orig.split("\r\n").join("\n"); assert.ok(s.includes(de), "no se encontró " + de); fs.writeFileSync(f, s.replace(de, a)); return () => fs.writeFileSync(f, orig); };
  let r = correr(); check(r.status === 0, "el código actual pasa");
  let deshacer = alterar("app/api/rentabilidad/analyze/route.ts", "numeroComoTexto(fila.envio),", "String(fila.envio),"); r = correr(); check(r.status === 1 && /columna #7 \(H\)/.test(r.stderr), "analyze: una columna numérica de Rentabilidad sin el ayudante hace fallar: " + (r.stderr.split("\n")[1] ?? "").trim().slice(0, 100)); deshacer();
  deshacer = alterar("app/api/rentabilidad/analyze/route.ts", "          textoExternoSeguro(fila.producto),\n", "          numeroComoTexto(fila.producto),\n"); r = correr(); check(r.status === 1 && /NO es numérica/.test(r.stderr), "analyze: aplicar el ayudante a una columna de TEXTO (producto) también hace fallar"); deshacer();
  deshacer = alterar("app/api/rentabilidad/analyze/route.ts", "              numeroComoTexto(resultado.costoTotalDespacho),", "              String(resultado.costoTotalDespacho),"); r = correr(); check(r.status === 1 && /ShippingCache/.test(r.stderr), "analyze: la entrada de ShippingCache sin el ayudante hace fallar"); deshacer();
  deshacer = alterar("lib/envio-real.ts", "values: [[numeroComoTexto(envio)]]", "values: [[envio]]"); r = correr(); check(r.status === 1 && /actualización de H/.test(r.stderr), "envio-real: la ACTUALIZACIÓN de H sin el ayudante hace fallar"); deshacer();
  deshacer = alterar("lib/envio-real.ts", "values: [[numeroComoTexto(margenNeto), numeroComoTexto(margenPct)]]", "values: [[margenNeto, numeroComoTexto(margenPct)]]"); r = correr(); check(r.status === 1 && /J:K/.test(r.stderr), "envio-real: J:K con una sola columna sin el ayudante hace fallar"); deshacer();
  deshacer = alterar("lib/envio-real.ts", "numeroComoTexto(unidadesEstaOrden),", "String(unidadesEstaOrden),"); r = correr(); check(r.status === 1, "envio-real: una entrada de ShippingCache sin el ayudante hace fallar"); deshacer();
  deshacer = alterar("lib/tarifa-envio.ts", "    numeroComoTexto(r.dispersionPct),", "    String(r.dispersionPct),"); r = correr(); check(r.status === 1 && /tarifa-envio/.test(r.stderr), "tarifa-envio: una columna numérica sin el ayudante hace fallar"); deshacer();
  fs.mkdirSync(path.join(raiz, "app/api/nuevo"), { recursive: true }); fs.writeFileSync(path.join(raiz, "app/api/nuevo/route.ts"), 'import { appendSheet } from "@/lib/sheets";\nexport async function POST() { await appendSheet("Rentabilidad!A:Q", [["x"]]); }\n');
  r = correr(); check(r.status === 1 && /no está registrado/.test(r.stderr), "un escritor NUEVO de esas hojas, sin registrar, hace fallar"); fs.rmSync(path.join(raiz, "app/api/nuevo"), { recursive: true });
  r = correr(); check(r.status === 0, "y al deshacer todo vuelve a pasar"); fs.rmSync(raiz, { recursive: true, force: true }); }

// ---- datos sintéticos (ningún dato real) ----
const nuevoMundo = () => { globalThis.__hojas = { Locks: [["Clave", "Token", "Vence (epoch s)", "Liberado"]], Rentabilidad: [["Orden"]], RentabilidadProgreso: [], ShippingCache: [["ID"]], Publicaciones: [["ID"], ["MLC111", "cat", "Producto de prueba", "10", "5", "20000"]], "Auditoría": [["Mes"]] }; globalThis.__raw = []; };
const rawDe = (hoja, op) => globalThis.__raw.filter((x) => x.hoja === hoja && (!op || x.op === op));
const COSTO = 4989.6; // decimal que Sheets tomaría por fecha (año 4989, mes 6)

console.log("D. envio-real (procesarTanda): filas nuevas de ShippingCache y ACTUALIZACIONES de filas existentes de Rentabilidad");
{ const filaRent = ["'2000111", "2026-09-01", "MLC111", "Producto de prueba", "10000", "20000", "1190", "", "0", "", "", "", "", "1", "", "", ""];
  const armar = (omitirMarca, costoOk = true) => { nuevoMundo(); globalThis.__hojas.Rentabilidad.push([...filaRent]); const ml = async (url) => { if (/^\/orders\//.test(url)) return { data: { shipping: { id: 900 }, order_items: [{ quantity: 1 }] } }; if (/\/costs$/.test(url)) return { data: { senders: costoOk ? [{ cost: COSTO }] : [] } }; return { data: { logistic_type: "fulfillment", shipping_items: [{ id: "MLC111", quantity: 1 }] } }; };
    const S = require(path.join(out, "sheets.js")); const updates = [];
    return { updates, op: { mlGet: ml, readSheet: S.readSheet, appendSheet: S.appendSheet, batchWriteSheet: async (u) => { updates.push(...u); for (const x of u) await S.writeSheet(x.range, x.values); }, calcularMargen: () => ({ margenNeto: -2537.9, margenPct: -25.4 }), forzarReintentos: false, dryRun: false, dryRunLimite: 10, omitirMarca, limite: null, tiempoMaximoMs: 60000 } }; };
  let m = armar(false); await ER.procesarTanda(m.op);
  eq(m.updates.map((u) => [u.range.replace(/\d+/g, "#"), u.values]), [["Rentabilidad!H#:H#", [["'4989.6"]]], ["Rentabilidad!J#:K#", [["'-2537.9", "'-25.4"]]], ["Rentabilidad!O#:Q#", [["'4989.6", "costs", ""]]]], "las ACTUALIZACIONES de H, J:K y O escriben texto con apóstrofo (negativos y decimales); P (fuente) y Q (mixto) quedan como están");
  const sc = rawDe("ShippingCache", "append")[0]?.values[0]; eq(sc.slice(4, 8), ["'4989.6", "'1", "'1", "costs"], "la fila nueva de ShippingCache: costo, unidades del despacho y de la orden con apóstrofo; la fuente («costs») sin él");
  eq([sc[0], sc[1]], ["'2000111", "'900"], "los IDs conservan su apóstrofo de siempre");
  m = armar(true); await ER.procesarTanda(m.op); eq(m.updates.at(-1).values, [["'4989.6", "costs"]], "con omitirMarca: O y P → [número con apóstrofo, fuente]");
  m = armar(false, false); await ER.procesarTanda(m.op); eq(m.updates.map((u) => u.values), [[["billing_sin_costs", ""]]], "sin costos (billing_sin_costs) solo se escriben P y Q (texto): no hay números que prefijar");
  m = armar(false); await ER.procesarTanda(m.op); const guardado = globalThis.__hojas.Rentabilidad[1]; check(Number(guardado[7]) === 4989.6 && Number(guardado[9]) === -2537.9 && Number(guardado[10]) === -25.4 && Number(guardado[14]) === 4989.6, "tras guardar, la hoja devuelve H, J, K y O sin apóstrofo y los lectores leen 4989.6, -2537.9, -25.4 y 4989.6"); }

console.log("E. rentabilidad/analyze de punta a punta (Billing y ML sintéticos): filas nuevas de Rentabilidad y de ShippingCache");
{ const { POST } = require(path.join(out, "analyze.js")); nuevoMundo();
  globalThis.__ml = async (url) => {
    if (url.includes("/billing/")) return { data: { total: 1, results: [{ charge_info: { detail_sub_type: "CV", detail_amount: -1190.5 }, sales_info: [{ order_id: 2000111, sale_date_time: "2026-09-01T10:00:00", transaction_amount: 10000 }], items_info: [{ item_id: "MLC111", item_title: "Producto de prueba", order_id: 2000111, item_amount: 1 }] }] } };
    if (/^\/orders\//.test(url)) return { data: { shipping: { id: 900 }, order_items: [{ quantity: 1 }] } };
    if (/\/costs$/.test(url)) return { data: { senders: [{ cost: COSTO }] } };
    return { data: { logistic_type: "fulfillment", shipping_items: [{ id: "MLC111", quantity: 1 }] } }; };
  const e = console.error, w = console.warn; console.error = () => {}; console.warn = () => {};
  let res; try { res = await POST(new Request("http://x/api/rentabilidad/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mes: "2026-09" }) })); } finally { console.error = e; console.warn = w; }
  const j = await res.json(); check(res.status === 200 && j.ok && j.ordenesNuevas === 1, "el análisis procesó 1 orden nueva (" + JSON.stringify({ status: res.status, nuevas: j.ordenesNuevas }) + ")");
  const fila = rawDe("Rentabilidad", "append").find((x) => x.values[0][0] === "'2000111")?.values[0]; check(!!fila && fila.length === 17, "se agregó la fila de Rentabilidad (17 columnas)");
  const numericas = [4, 5, 6, 7, 8, 9, 10, 13, 14]; check(numericas.every((i) => fila[i] === "" || fila[i].startsWith("'")), "las columnas numéricas E, F, G, H, I, J, K, N y O se escribieron con apóstrofo: " + numericas.map((i) => fila[i]).join(" | "));
  check(fila[4] === "'10000" && fila[5] === "'20000" && fila[6] === "'1190.5" && fila[7] === "'" + COSTO && fila[13] === "'1" && fila[14] === "'" + COSTO, "valores esperados: precio, COGS (20000 de Publicaciones), comisión 1190.5 (otro decimal que Sheets tomaría por fecha), envío 4989.6, unidades y envío por unidad");
  check(fila[9].startsWith("'-") && fila[10].startsWith("'-"), "el margen neto y el % son NEGATIVOS (la orden pierde plata) y llevan el apóstrofo delante del signo: «" + fila[9] + "», «" + fila[10] + "»");
  check([0, 1, 2, 3, 11, 12, 15, 16].every((i) => !String(fila[i]).replace(/^'2000111$/, "").startsWith("'")), "las columnas de fecha, ID (salvo el apóstrofo de siempre del ID de orden), texto, fuente y mixto NO llevan apóstrofo");
  const cache = rawDe("ShippingCache", "append")[0]?.values[0]; check(!!cache && cache[4] === "'" + COSTO && cache[5] === "'1" && cache[6] === "'1" && cache[7] === "costs", "la entrada de ShippingCache: costo 4989.6, unidades del despacho y de la orden con apóstrofo; fuente sin él");
  const guardada = globalThis.__hojas.Rentabilidad.find((r) => r[0] === "2000111");
  check([4, 5, 6, 7, 13, 14].every((i) => !String(guardada[i]).startsWith("'")) && Number(guardada[7]) === COSTO && Number(guardada[9]) < 0, "lo que devuelve la hoja no trae apóstrofo, y Number() lee H = 4989.6 y J negativo");
  check(NH.leerNumeroHoja(guardada[7]) === COSTO && NH.leerNumeroHoja(guardada[10]) === Number(guardada[10]), "leerNumeroHoja (pantalla) lee los mismos valores"); }

console.log("\n" + ok + " comprobaciones OK");

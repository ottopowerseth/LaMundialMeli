// Pruebas de /api/rentabilidad/analyze bajo el lock «rentabilidad:{mes}» (S-08): ruta REAL + lib/lock-sheets REAL, con Sheets en memoria y la
// Billing API de ML simulada (devuelve 0 cargos). Nada llama a Mercado Libre ni a Sheets.  Uso:  node scripts/test-rentabilidad-lock.mjs
// El análisis de cargos reales (Billing → filas de Rentabilidad) no se simula aquí: lo cubren los tests de lib/rentabilidad y envio-real.
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
const out = fs.mkdtempSync(path.join(os.tmpdir(), "rent-lock-"));
const compilar = (origen, destino) => {
  const src = fs.readFileSync(path.join(PROJ, origen), "utf8").replace(/from "@\/lib\/([\w-]+)"/g, 'from "./$1"');
  fs.writeFileSync(path.join(out, destino), ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);
};
for (const [o, d] of [["lib/log.ts", "log.js"], ["lib/http-retry.ts", "http-retry.js"], ["lib/rentabilidad.ts", "rentabilidad.js"], ["lib/backfill-shipping.ts", "backfill-shipping.js"], ["lib/envio-real.ts", "envio-real.js"], ["lib/numero-texto.ts", "numero-texto.js"],
  ["lib/guardas-filas.ts", "guardas-filas.js"], ["lib/lock-sheets.ts", "lock-sheets.js"], ["app/api/rentabilidad/analyze/route.ts", "analyze.js"]]) compilar(o, d);

fs.writeFileSync(path.join(out, "ml-token.js"), `exports.getValidAccessToken = async () => { globalThis.__tokenPedido++; return "token-falso"; }; exports.instalarReintento401 = () => {};`);
fs.mkdirSync(path.join(out, "node_modules", "axios"), { recursive: true });
fs.writeFileSync(path.join(out, "node_modules", "axios", "index.js"), `const api = { create: () => ({ get: async (url) => { globalThis.__llamadasML++; if (globalThis.__demoraML) await new Promise((r) => setTimeout(r, globalThis.__demoraML)); if (globalThis.__errorML) throw Object.assign(new Error("Request failed with status code 400"), { response: { status: 400 } }); return { data: { results: [], total: 0 } }; } }) }; module.exports = { __esModule: true, default: api, ...api };`);
fs.writeFileSync(path.join(out, "sheets.js"), `
const H = () => globalThis.__hojas; const LOG = () => globalThis.__log;
const col = (L) => L.split("").reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0) - 1;
function parse(range) { const [hoja, ref] = range.split("!"); const m = ref.match(/^([A-Z]+)(\\d*)(?::([A-Z]+)(\\d*))?$/); const r1 = m[2] ? +m[2] - 1 : 0; return { hoja, c1: col(m[1]), c2: m[3] ? col(m[3]) : col(m[1]), r1, r2: m[4] ? +m[4] - 1 : (m[3] ? Infinity : (m[2] ? r1 : Infinity)) }; }
const recortar = (r) => { const s = [...r]; while (s.length && (s.at(-1) === "" || s.at(-1) === undefined)) s.pop(); return s; };
const falla = (range) => { if (globalThis.__fallaLocks && range.startsWith("Locks!")) throw Object.assign(new Error(globalThis.__fallaLocks === "429" ? "Quota exceeded for quota metric 'Read requests'" : "falla simulada en Locks"), globalThis.__fallaLocks === "429" ? { code: 429 } : {}); };
exports.ensureSheets = async () => {};
exports.readSheet = async (range) => { falla(range); const p = parse(range); const filas = (H()[p.hoja] ??= []); const res = filas.slice(p.r1, p.r2 + 1).map((r) => recortar((r ?? []).slice(p.c1, p.c2 + 1))); while (res.length && res.at(-1).length === 0) res.pop(); return res; };
exports.writeSheet = async (range, values) => { falla(range); LOG().push({ op: "write", range }); const p = parse(range); const filas = (H()[p.hoja] ??= []); values.forEach((fila, i) => { const r = (filas[p.r1 + i] ??= []); fila.forEach((v, j) => { r[p.c1 + j] = v; }); }); };
exports.appendSheet = async (range, values) => { falla(range); LOG().push({ op: "append", range }); (H()[parse(range).hoja] ??= []).push(...values.map((v) => [...v])); };
exports.borrarFilasHoja = async (hoja, filas) => { for (const f of [...new Set(filas)].sort((a, b) => b - a)) H()[hoja].splice(f - 2, 1); };`);
const { POST } = require(path.join(out, "analyze.js"));

let ok = 0; const check = (c, m) => { assert.ok(c, m); ok++; console.log("  ✓", m); };
const ENCABEZADO = ["Clave", "Token", "Vence (epoch s)", "Liberado"];
const nuevo = () => { globalThis.__hojas = { Locks: [[...ENCABEZADO]], Rentabilidad: [["Orden"]], RentabilidadProgreso: [], ShippingCache: [["ID"]], Publicaciones: [["ID"]], "Auditoría": [["Mes"]] }; globalThis.__log = []; globalThis.__fallaLocks = false; globalThis.__tokenPedido = 0; globalThis.__llamadasML = 0; globalThis.__demoraML = 0; globalThis.__errorML = false; };
const silencio = async (fn) => { const e = console.error, w = console.warn; console.error = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.error = e; console.warn = w; } };
const analizar = async (cuerpo) => { const res = await silencio(() => POST(new Request("http://x/api/rentabilidad/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo) }))); return { status: res.status, j: await res.json() }; };
const escrituras = () => globalThis.__log.filter((l) => !l.range.startsWith("Locks"));
const activos = (clave) => globalThis.__hojas.Locks.slice(1).filter((r) => r[0] === clave && !r[3]).length;
const MES = "2026-09";

console.log("mes inválido: 400 antes de tocar nada (misma regla que audit/analyze)");
for (const cuerpo of [{}, { mes: "" }, { mes: null }, { mes: 202609 }, { mes: ["2026-09"] }, { mes: "2026-13" }, { mes: "2026-00" }, { mes: "2026-9" }, { mes: "26-09" }, { mes: "2026-09 " }, { mes: "2026-09\n" }, { mes: "rentabilidad:2026-09" }, { mes: "2026-09-01" }, "{no es json"]) {
  nuevo(); const r = await analizar(cuerpo);
  check(r.status === 400 && /AAAA-MM/.test(r.j.error) && escrituras().length === 0 && globalThis.__hojas.Locks.length === 1 && globalThis.__tokenPedido === 0 && globalThis.__llamadasML === 0, "cuerpo " + JSON.stringify(cuerpo) + ": 400, sin lock, sin token y sin ML"); }

console.log("análisis normal bajo el lock (Billing simulada sin cargos)");
{ nuevo(); const r = await analizar({ mes: MES });
  check(r.status === 200 && r.j.ok && r.j.completo === true && r.j.mes === MES, "responde ok y completo");
  check(globalThis.__llamadasML === 1 && globalThis.__hojas.RentabilidadProgreso.some((f) => f[0] === MES && f[3] === "Sí"), "consultó la Billing API y guardó el progreso del mes");
  check(activos("rentabilidad:" + MES) === 0 && globalThis.__hojas.Locks.slice(1).every((r) => !!r[3]), "el ticket quedó liberado");
  const claves = [...new Set(globalThis.__hojas.Locks.slice(1).map((r) => r[0]))]; check(JSON.stringify(claves) === JSON.stringify(["rentabilidad:" + MES]), "la clave es «rentabilidad:{mes}» (sin clave global)"); }

console.log("lock ocupado → 409, sin procesar ni escribir");
{ nuevo(); globalThis.__hojas.Locks.push(["rentabilidad:" + MES, "tk-otra-invocacion", Math.floor(Date.now() / 1000) + 60, ""]); const r = await analizar({ mes: MES });
  check(r.status === 409 && r.j.ok === false, "responde 409");
  check(/otro análisis de Rentabilidad del mes 2026-09 en curso/.test(r.j.error) && /No se procesó ni se guardó nada/.test(r.j.error), "mensaje para el usuario: «" + r.j.error + "»");
  check(globalThis.__tokenPedido === 0 && globalThis.__llamadasML === 0 && escrituras().length === 0, "no pidió el token, no llamó a ML y no escribió en Rentabilidad, ShippingCache ni RentabilidadProgreso");
  check(activos("rentabilidad:" + MES) === 1, "el ticket de la otra invocación sigue intacto y el del intento rechazado se liberó"); }

console.log("Sheets falla al pedir el lock (error y cuota 429) → 503, falla cerrado");
for (const tipo of [true, "429"]) { nuevo(); globalThis.__fallaLocks = tipo; const r = await analizar({ mes: MES });
  check(r.status === 503 && r.j.ok === false && /No se pudo proteger la escritura de Rentabilidad del mes 2026-09/.test(r.j.error) && /lo ya procesado de este mes se conserva/.test(r.j.error), (tipo === "429" ? "cuota 429" : "error de Sheets") + " → 503: «" + r.j.error + "»");
  check(globalThis.__tokenPedido === 0 && globalThis.__llamadasML === 0 && escrituras().length === 0, "   sin token, sin ML y sin escrituras"); }

console.log("el lock se libera aunque el análisis falle");
{ nuevo(); globalThis.__errorML = true; const r = await analizar({ mes: MES }); check(r.status === 500 && activos("rentabilidad:" + MES) === 0, "500 por el error de ML y el ticket quedó liberado");
  globalThis.__errorML = false; const r2 = await analizar({ mes: MES }); check(r2.status === 200 && r2.j.completo === true, "el reintento siguiente corre sin esperar"); }

console.log("dos invocaciones del mismo mes casi a la vez: una corre y la otra recibe 409; meses distintos no se bloquean");
{ nuevo(); globalThis.__demoraML = 60; const [a, b] = await Promise.all([analizar({ mes: MES }), analizar({ mes: MES })]);
  const estados = [a.status, b.status].sort(); check(JSON.stringify(estados) === JSON.stringify([200, 409]), "una responde 200 y la otra 409 (" + estados.join(" / ") + ")");
  check(globalThis.__llamadasML === 1 && globalThis.__hojas.RentabilidadProgreso.filter((f) => f[0] === MES).length === 1, "solo una procesó el mes (una sola consulta a Billing y una sola fila de progreso)");
  nuevo(); globalThis.__demoraML = 60; const [c, d] = await Promise.all([analizar({ mes: "2026-08" }), analizar({ mes: "2026-09" })]);
  check(c.status === 200 && d.status === 200, "2026-08 y 2026-09 a la vez: las dos corren (claves distintas)");
  nuevo(); globalThis.__hojas.Locks.push(["audit:2026-09", "tk-aud", Math.floor(Date.now() / 1000) + 60, ""], ["ml-sync", "tk-sync", Math.floor(Date.now() / 1000) + 60, ""]); const e = await analizar({ mes: MES });
  check(e.status === 200, "un análisis de Auditoría o un sync en curso NO bloquea a Rentabilidad"); }

console.log("invocaciones SECUENCIALES del mismo mes (el bucle del cliente): ninguna recibe 409 por el ticket de la anterior");
{ nuevo(); const estados = []; let ticketsAlResponder = [];
  for (let i = 0; i < 12; i++) { const r = await analizar({ mes: MES }); estados.push(r.status); ticketsAlResponder.push(activos("rentabilidad:" + MES)); }
  check(estados.every((e) => e === 200), "12 invocaciones seguidas, sin pausa entre una respuesta y la siguiente petición: todas 200 (" + [...new Set(estados)].join(",") + ")");
  check(ticketsAlResponder.every((n) => n === 0), "cuando cada respuesta llega, su ticket ya está liberado (la liberación termina ANTES de responder)");
  check(globalThis.__hojas.Locks.slice(1).length === 12 && globalThis.__hojas.Locks.slice(1).every((r) => !!r[3]), "quedaron 12 tickets, todos liberados"); }
{ // misma secuencia, pero la petición siguiente sale en el mismo instante en que llega la respuesta, y con retardos de Sheets en cada paso
  nuevo(); const base = globalThis.__hojas; const lat = () => new Promise((r) => setTimeout(r, 3));
  const estados = []; for (let i = 0; i < 6; i++) { await lat(); const res = await analizar({ mes: MES }); estados.push(res.status); }
  check(estados.every((e) => e === 200), "con retardos entre pasos tampoco hay 409 entre invocaciones sucesivas"); }
{ // contraste: si la liberación FALLA, el siguiente intento inmediato SÍ recibe 409 (límite documentado: hasta que venza, 90 s)
  nuevo(); const r1 = await analizar({ mes: MES }); check(r1.status === 200, "primera invocación ok");
  globalThis.__hojas.Locks.slice(1).forEach((r) => { r[3] = ""; }); // simula un ticket que no se pudo liberar
  const r2 = await analizar({ mes: MES }); check(r2.status === 409, "contraste: con un ticket sin liberar, el reintento inmediato recibe 409 (se resuelve solo al vencer, a los 90 s)"); }

console.log("tiempo: el lock se descuenta del presupuesto de la invocación");
{ const src = fs.readFileSync(path.join(PROJ, "app/api/rentabilidad/analyze/route.ts"), "utf8");
  check(src.includes("const gastadoLockMs = Date.now() - inicioRuta + RESERVA_LIBERAR_LOCK_MS;") && src.includes("createSyncBudget(2, Math.max(1000, 45000 - gastadoLockMs))") && src.includes("const inicio = Date.now() - gastadoLockMs;"), "el presupuesto de reintentos y el tiempo de la invocación descuentan lo gastado en adquirir el lock más 1 s para liberarlo");
  check(src.indexOf("const gastadoLockMs") < src.indexOf("await ensureSheets("), "se calcula al inicio de la tarea, antes de ensureSheets y del token (lo que ya se gastaba antes no se descuenta)"); }

console.log("\n" + ok + " comprobaciones OK");

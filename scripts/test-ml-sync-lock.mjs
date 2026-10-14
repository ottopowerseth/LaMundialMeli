// Pruebas de /api/ml-sync bajo el lock «ml-sync» (S-08): ruta REAL + lib/lock-sheets REAL, con Sheets en memoria y ML/ml-token simulados.
// Nada llama a Mercado Libre ni a Sheets. El camino feliz completo del sync (Publicaciones/Ventas) no se simula aquí: ver
// test-reemplazar-hoja.mjs y test-ventas-historial.mjs.  Uso:  node scripts/test-ml-sync-lock.mjs
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
const out = fs.mkdtempSync(path.join(os.tmpdir(), "ml-sync-lock-"));
const compilar = (origen, destino) => {
  const src = fs.readFileSync(path.join(PROJ, origen), "utf8").replace(/from "@\/lib\/([\w-]+)"/g, 'from "./$1"');
  fs.writeFileSync(path.join(out, destino), ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);
};
for (const [o, d] of [["lib/log.ts", "log.js"], ["lib/http-retry.ts", "http-retry.js"], ["lib/rentabilidad.ts", "rentabilidad.js"], ["lib/backfill-shipping.ts", "backfill-shipping.js"], ["lib/ventas-historial.ts", "ventas-historial.js"],
  ["lib/guardas-filas.ts", "guardas-filas.js"], ["lib/lock-sheets.ts", "lock-sheets.js"], ["app/api/ml-sync/route.ts", "ml-sync.js"]]) compilar(o, d);

// ---- simulados: ml-token (cuenta las veces que se pide el token), axios (no debería llamarse) y Sheets en memoria con la hoja Locks ----
fs.writeFileSync(path.join(out, "ml-token.js"), `exports.getValidAccessToken = async () => { globalThis.__tokenPedido++; if (globalThis.__demoraToken) await new Promise((r) => setTimeout(r, globalThis.__demoraToken)); throw new Error("token no disponible (simulado)"); }; exports.instalarReintento401 = () => {};`);
fs.mkdirSync(path.join(out, "node_modules", "axios"), { recursive: true });
fs.writeFileSync(path.join(out, "node_modules", "axios", "index.js"), `const api = { create: () => ({ get: async () => { globalThis.__llamadasML++; throw new Error("no debe llamar a ML"); }, interceptors: { response: { use: () => 0 } } }) }; module.exports = { __esModule: true, default: api, ...api };`);
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
exports.reemplazarHoja = async (hoja) => { LOG().push({ op: "reemplazar", range: hoja + "!A1" }); return { sobranteLimpio: true }; };
exports.borrarFilasHoja = async (hoja, filas) => { for (const f of [...new Set(filas)].sort((a, b) => b - a)) H()[hoja].splice(f - 2, 1); };`);
const { POST } = require(path.join(out, "ml-sync.js"));

let ok = 0; const check = (c, m) => { assert.ok(c, m); ok++; console.log("  ✓", m); };
const ENCABEZADO = ["Clave", "Token", "Vence (epoch s)", "Liberado"];
const nuevo = () => { globalThis.__hojas = { Locks: [[...ENCABEZADO]], Publicaciones: [["ID"], ["MLC1"]], Ventas: [["ID"]] }; globalThis.__log = []; globalThis.__fallaLocks = false; globalThis.__tokenPedido = 0; globalThis.__llamadasML = 0; globalThis.__demoraToken = 0; };
const silencio = async (fn) => { const e = console.error, w = console.warn; console.error = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.error = e; console.warn = w; } };
const sync = async () => { const res = await silencio(() => POST()); return { status: res.status, j: await res.json() }; };
const escrituras = () => globalThis.__log.filter((l) => !l.range.startsWith("Locks"));
const activos = () => globalThis.__hojas.Locks.slice(1).filter((r) => r[0] === "ml-sync" && !r[3]).length;

console.log("lock ocupado → 409 y no se hace nada");
{ nuevo(); globalThis.__hojas.Locks.push(["ml-sync", "tk-otro-sync", Math.floor(Date.now() / 1000) + 60, ""]); const r = await sync();
  check(r.status === 409 && r.j.ok === false, "responde 409");
  check(/Ya hay una sincronización en curso/.test(r.j.error) && /No se hizo nada/.test(r.j.error), "mensaje para el usuario: «" + r.j.error + "»");
  check(globalThis.__tokenPedido === 0 && globalThis.__llamadasML === 0 && escrituras().length === 0, "no pidió el token de ML, no llamó a ML y no escribió en Publicaciones/Ventas/ShippingCache");
  check(activos() === 1, "el ticket del otro sync queda intacto y el del intento rechazado se liberó"); }

console.log("Sheets falla al pedir el lock (error y cuota 429) → 503, falla cerrado");
for (const tipo of [true, "429"]) { nuevo(); globalThis.__fallaLocks = tipo; const r = await sync();
  check(r.status === 503 && r.j.ok === false && /No se pudo proteger la sincronización/.test(r.j.error) && /no se sincronizó ni se escribió nada/.test(r.j.error), (tipo === "429" ? "cuota 429" : "error de Sheets") + " → 503: «" + r.j.error + "»");
  check(globalThis.__tokenPedido === 0 && globalThis.__llamadasML === 0 && escrituras().length === 0, "   sin token, sin ML y sin escrituras"); }

console.log("la tarea falla a mitad de camino → 500 y el lock se libera");
{ nuevo(); const r = await sync(); check(r.status === 500 && /token no disponible/.test(r.j.error), "500 con el error de la tarea");
  check(globalThis.__tokenPedido === 1 && activos() === 0, "el sync sí corrió (pidió el token) y su ticket quedó liberado");
  const r2 = await sync(); check(r2.status === 500 && globalThis.__tokenPedido === 2, "el reintento siguiente vuelve a correr sin esperar (no queda bloqueado)"); }

console.log("dos syncs casi a la vez: uno corre, el otro recibe 409");
{ nuevo(); globalThis.__demoraToken = 60; const [a, b] = await Promise.all([sync(), sync()]);
  const estados = [a.status, b.status].sort(); check(JSON.stringify(estados) === JSON.stringify([409, 500]), "uno llegó a correr (500 por el token simulado) y el otro recibió 409 (" + estados.join(" / ") + ")");
  check(globalThis.__tokenPedido === 1, "el token de ML se pidió una sola vez: solo un sync corrió");
  check(activos() === 0, "ambos tickets quedaron liberados"); }

console.log("la clave es solo «ml-sync» (sin clave global)");
{ nuevo(); await sync(); const claves = [...new Set(globalThis.__hojas.Locks.slice(1).map((r) => r[0]))]; check(JSON.stringify(claves) === JSON.stringify(["ml-sync"]), "el único lock usado es «ml-sync»");
  nuevo(); globalThis.__hojas.Locks.push(["audit:2026-09", "tk-auditoria", Math.floor(Date.now() / 1000) + 60, ""], ["rentabilidad:2026-09", "tk-rent", Math.floor(Date.now() / 1000) + 60, ""]); const r = await sync();
  check(r.status === 500 && globalThis.__tokenPedido === 1, "un análisis de Auditoría o de Rentabilidad en curso NO bloquea al sync (claves distintas)"); }

console.log("presupuesto de tiempo: se mide desde que empieza la ruta (cuenta el tiempo del lock)");
{ const src = fs.readFileSync(path.join(PROJ, "app/api/ml-sync/route.ts"), "utf8");
  check(src.includes("const PRESUPUESTO_SYNC_MS = 44000") && src.includes("createSyncBudget(2, Math.max(1000, PRESUPUESTO_SYNC_MS - (Date.now() - inicioRuta)))"), "ml-sync descuenta lo ya gastado desde inicioRuta de un presupuesto de 44 s (45 s menos ~1 s para liberar el lock)");
  const hr = require(path.join(out, "http-retry.js")); const realNow = Date.now; const t0 = realNow();
  const corta = (gastadoMs, transcurridoMs) => { const presupuesto = hr.createSyncBudget(5, Math.max(1000, 44000 - gastadoMs)); Date.now = () => t0 + transcurridoMs; try { presupuesto.recordExhausted(); return false; } catch (e) { return /tiempo máximo/.test(String(e.message)); } finally { Date.now = realNow; } };
  // El presupuesto se crea con 3,5 s ya gastados (lock + ensureSheets + token): su corte cae a los 44 s DESDE EL INICIO DE LA RUTA.
  check(!corta(3500, 40000) && corta(3500, 41000), "con 3,5 s ya gastados el corte por tiempo salta a los 40,5 s de sync = 44 s desde el inicio de la ruta (antes del lock: 45 s desde después de ensureSheets + token)");
  check(!corta(0, 43000) && corta(0, 45000), "sin tiempo previo equivale a 44 s");
}

console.log("\n" + ok + " comprobaciones OK");

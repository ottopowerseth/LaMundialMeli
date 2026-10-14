// Pruebas de /api/audit/analyze (fuente de ventas_brutas en la columna R y rechazo de tasas > 100 %) con Sheets en memoria, un
// /orders/search SIMULADO y lib/audit simulado: nada llama a Mercado Libre ni a Sheets.  Uso:  node scripts/test-audit-analyze.mjs
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
const out = fs.mkdtempSync(path.join(os.tmpdir(), "audit-analyze-test-"));
const compilar = (origen, destino) => {
  const src = fs.readFileSync(path.join(PROJ, origen), "utf8").replace(/from "@\/lib\/([\w-]+)"/g, 'from "./$1"');
  fs.writeFileSync(path.join(out, destino), ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);
};
for (const [o, d] of [["lib/log.ts", "log.js"], ["lib/http-retry.ts", "http-retry.js"], ["lib/backfill-shipping.ts", "backfill-shipping.js"], ["lib/audit-referencia.ts", "audit-referencia.js"], ["lib/audit-guardado.ts", "audit-guardado.js"], ["lib/guardas-filas.ts", "guardas-filas.js"], ["lib/lock-sheets.ts", "lock-sheets.js"], ["app/api/audit/analyze/route.ts", "analyze.js"]]) compilar(o, d);

// ---- simulados ----
fs.writeFileSync(path.join(out, "audit.js"), `
const DIA = 86400000;
exports.parseAuditFiles = () => ({});
exports.detectarMesesEnArchivo = () => [{ year: 2026, month: 9, count: 1 }];
exports.cicloEsperado = (mes) => { const [y, m] = mes.split("-").map(Number); return { desde: new Date(Date.UTC(y, m - 2, 15)), hasta: new Date(Date.UTC(y, m - 1, 14)) }; };
exports.calculateAudit = (mes, data, ventasBrutasML) => { const c = globalThis.__calc; const ventas = ventasBrutasML !== undefined ? ventasBrutasML : c.ventasArchivo;
  if (c.cobertura) return { error_cobertura: c.cobertura, ventas_brutas: 0, total_comisiones: 0, errores: [], detalle_errores: [] };
  return { ventas_brutas: ventas, ventas_netas: ventas, comisiones_ml: 55000, comisiones_mp: c.comisiones - 55000, comisiones_mp_px: 0, total_comisiones: c.comisiones, notas_credito_ml: 0, recuperable: 0, neto_recibido_mp: 1, tasa_efectiva: ventas > 0 ? +(c.comisiones / ventas * 100).toFixed(2) : 0, flex_credito: 0, flex_debito: 0, errores_count: 0, errores: [], resumen: "Mes " + mes + ": ventas brutas " + ventas, detalle_errores: [] }; };`);
fs.writeFileSync(path.join(out, "ml-token.js"), `exports.getValidAccessToken = async () => "token-falso"; exports.instalarReintento401 = () => {};`);
fs.writeFileSync(path.join(out, "sheets.js"), `
const H = () => globalThis.__hojas; const LOG = () => globalThis.__log;
const col = (L) => L.split("").reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0) - 1;
function parse(range) { const [hoja, ref] = range.split("!"); const m = ref.match(/^([A-Z]+)(\\d*)(?::([A-Z]+)(\\d*))?$/); return { hoja, c1: col(m[1]), r1: m[2] ? +m[2] - 1 : 0, c2: m[3] ? col(m[3]) : col(m[1]) }; }
const recortar = (r) => { const s = [...r]; while (s.length && (s.at(-1) === "" || s.at(-1) === undefined)) s.pop(); return s; };
exports.ensureSheets = async () => { globalThis.__ensures = (globalThis.__ensures ?? 0) + 1; };
const rango = (range) => { const m = range.split("!")[1].match(/^([A-Z]+)(\\d*)(?::([A-Z]+)(\\d*))?$/); const r1 = m[2] ? +m[2] - 1 : 0; return { r1, r2: m[4] ? +m[4] - 1 : (m[3] ? Infinity : (m[2] ? r1 : Infinity)) }; };
const fallaLocks = (range) => { if (globalThis.__fallaLocks && range.startsWith("Locks!")) throw Object.assign(new Error(globalThis.__fallaLocks === "429" ? "Quota exceeded for quota metric 'Read requests per minute per user'" : "falla simulada de Sheets en Locks"), globalThis.__fallaLocks === "429" ? { code: 429 } : {}); };
exports.readSheet = async (range) => { (globalThis.__reads ??= []).push(range); fallaLocks(range); const p = parse(range); const filas = (H()[p.hoja] ??= []); const { r1, r2 } = rango(range);
  const res = filas.slice(r1, r2 + 1).map((r) => recortar((r ?? []).slice(p.c1, p.c2 + 1))); while (res.length && res.at(-1).length === 0) res.pop(); return res; };
exports.borrarFilasHoja = async (hoja, filas) => { for (const f of [...new Set(filas)].sort((a, b) => b - a)) H()[hoja].splice(f - 2, 1); };
exports.writeSheet = async (range, values) => { fallaLocks(range); LOG().push({ op: "write", range, values: JSON.parse(JSON.stringify(values)) }); const p = parse(range); const filas = (H()[p.hoja] ??= []);
  values.forEach((fila, i) => { const r = (filas[p.r1 + i] ??= []); fila.forEach((v, j) => { r[p.c1 + j] = v; }); }); };
exports.appendSheet = async (range, values) => { fallaLocks(range); LOG().push({ op: "append", range, values: JSON.parse(JSON.stringify(values)) }); const p = parse(range); (H()[p.hoja] ??= []).push(...values.map((v) => [...v])); };`);
fs.mkdirSync(path.join(out, "node_modules", "axios"), { recursive: true });
fs.writeFileSync(path.join(out, "node_modules", "axios", "index.js"), `const api = { create: () => ({ get: (url) => globalThis.__ml.get(url) }) }; module.exports = { __esModule: true, default: api, ...api };`);
const { POST } = require(path.join(out, "analyze.js"));

let ok = 0; const check = (c, m) => { assert.ok(c, m); ok++; console.log("  ✓", m); };
const DIA = 86400000;
// ML simulado: /users/me y /orders/search (sobrepaso del borde ~56 min, tope offset+limit ≤ 10.000)
function crearML(ordenes, { fallaUsuario = false } = {}) {
  const ml = { llamadas: 0, get: async (url) => {
    ml.llamadas++;
    if (fallaUsuario) throw Object.assign(new Error("Request failed with status code 500"), { response: { status: 500 } });
    if (url.startsWith("/users/me")) return { data: { id: 1 } };
    const q = new URL(url, "http://ml").searchParams; const desde = Date.parse(q.get("order.date_created.from")), hasta = Date.parse(q.get("order.date_created.to")) + 56 * 60000; const off = +q.get("offset"), lim = +q.get("limit");
    if (off + lim > 10000) throw Object.assign(new Error("offset"), { response: { status: 400 } });
    const l = ordenes.filter((o) => { const t = Date.parse(o.date_created); return t >= desde && t <= hasta && o.status === "paid"; }).sort((a, b) => Date.parse(b.date_created) - Date.parse(a.date_created));
    return { data: { results: l.slice(off, off + lim), paging: { total: l.length } } }; } };
  return ml;
}
let id = 7_000_000_000_000;
const MES = "2026-09"; const D0 = Date.UTC(2026, 7, 15), H0 = Date.UTC(2026, 8, 14) + DIA; // ciclo 15-ago → 14-sep
const generar = (porDia, monto = 20000) => { const o = []; for (let d = D0, i = 0; d < H0; d += DIA, i++) for (let k = 0; k < porDia; k++) o.push({ id: ++id, date_created: new Date(d + 1800000 + Math.floor((k / porDia) * (DIA - 3600000))).toISOString(), status: "paid", total_amount: monto }); return o; };
const unaAlTope = () => [...generar(20), ...Array.from({ length: 10_300 }, (_, k) => ({ id: ++id, date_created: new Date(D0 + 3 * DIA + 3600000 + Math.floor((k / 10_300) * (DIA - 7200000))).toISOString(), status: "paid", total_amount: 5000 }))];
const HEADER_VIEJO = ["Mes", "Ventas Brutas", "Ventas Netas", "Comisiones ML", "Comisiones MP", "Total Comisiones", "Recuperable", "Tasa Efectiva %", "Errores", "Resumen", "Analizado"];
const nuevaHoja = (filas = []) => { globalThis.__hojas = { "Auditoría": [[...HEADER_VIEJO], ...filas], AuditoriaLocks: [["Sin tocar", "1"]], Locks: [["Clave", "Token", "Vence (epoch s)", "Liberado"]] }; globalThis.__log = []; globalThis.__fallaLocks = false; globalThis.__reads = []; globalThis.__ensures = 0; };
async function analizar({ ml, ventasArchivo, comisiones, cobertura = null, mes = MES }) {
  globalThis.__ml = ml; globalThis.__calc = { ventasArchivo, comisiones, cobertura };
  const fd = new FormData(); if (mes !== null) fd.append("mes", mes); fd.append("file", new Blob(["x"]), "Reporte_MercadoLibre.csv");
  const warns = []; const w = console.warn; const e = console.error; console.warn = (...a) => warns.push(a.join(" ")); console.error = () => {};
  try { const res = await POST(new Request("http://x/api/audit/analyze", { method: "POST", body: fd })); return { status: res.status, j: await res.json(), warns }; } finally { console.warn = w; console.error = e; }
}
const filaGuardada = () => globalThis.__hojas["Auditoría"].find((r, i) => i > 0 && r[0] === MES);
const escrituras = () => globalThis.__log.filter((l) => !l.range.startsWith("Locks"));
const ticketsActivos = (clave) => (globalThis.__hojas.Locks ?? []).slice(1).filter((r) => r[0] === clave && !r[3]).length;
const locksLiberados = () => (globalThis.__hojas.Locks ?? []).slice(1).every((r) => !!r[3]);

console.log("A. referencia ML completa");
{ nuevaHoja(); const ventasRef = generar(10).length * 20000; const r = await analizar({ ml: crearML(generar(10)), ventasArchivo: 9_999_999, comisiones: Math.round(ventasRef * 0.15) });
  const f = filaGuardada();
  check(r.status === 200 && r.j.ok && r.j.avisos.length === 0, "guarda y responde ok, sin avisos");
  check(f[4] === "" && f[5] === "" && f[9] === "" && f[3] === 55000 && f[6] === Math.round(ventasRef * 0.15), "C-12: las comisiones de MP (E y F) y el neto de MP (J) NO se guardan (celdas vacías); Total = cargos de ML");
  check(f[1] === ventasRef && f.length === 18 && f[16] === "" && f[17] === "referencia ML", `la fila tiene 18 columnas: ventas_brutas = referencia ML ($${ventasRef.toLocaleString("es-CL")}), Q vacía y R = «${f[17]}»`);
  check(globalThis.__hojas["Auditoría"][0][17] === "Fuente Ventas Brutas", "el encabezado de R se agregó a la hoja (la hoja traía el encabezado viejo de 11 columnas)");
  check(locksLiberados(), "el lock del mes quedó liberado"); }
console.log("B. referencia incompleta (una ventana llega al tope de ML)");
{ nuevaHoja(); const r = await analizar({ ml: crearML(unaAlTope()), ventasArchivo: 4_000_000, comisiones: 600_000 }); const f = filaGuardada();
  check(r.j.ok && f[1] === 4_000_000 && f[17] === "referencia incompleta", `ventas_brutas queda con el valor del archivo ($4.000.000) y R = «${f[17]}»`);
  check(r.j.avisos.some((a) => /incompleta/.test(a)) && r.warns.some((w) => /incompleta/.test(w)) && !/Bearer|token/i.test(r.warns.join(" ")), "aviso en el resultado y en el log (sin tokens)"); }
console.log("C. ML falla");
{ nuevaHoja(); const r = await analizar({ ml: crearML([], { fallaUsuario: true }), ventasArchivo: 4_000_000, comisiones: 600_000 }); const f = filaGuardada();
  check(r.j.ok && r.j.referenciaML === null && f[1] === 4_000_000 && f[17] === "archivo ML (sin referencia)", `análisis sigue con el archivo; R = «${f[17]}»`); }
console.log("D. ML devuelve 0 ventas");
{ nuevaHoja(); const r = await analizar({ ml: crearML([]), ventasArchivo: 4_000_000, comisiones: 600_000 }); const f = filaGuardada();
  check(r.j.ok && f[1] === 4_000_000 && f[17] === "archivo ML (sin referencia)" && r.j.avisos.some((a) => /devolvió 0 ventas/.test(a)), "un 0 no pisa ventas_brutas; fuente «archivo ML (sin referencia)» y aviso visible"); }
console.log("E. tasa mayor al 100 % → no se guarda");
for (const [etiqueta, ml, ventasArchivo] of [["con referencia completa", crearML(generar(2)), 0], ["camino sin referencia (ML falla)", crearML([], { fallaUsuario: true }), 1_651_272]]) {
  nuevaHoja(); const antes = JSON.stringify(globalThis.__hojas["Auditoría"]); const r = await analizar({ ml, ventasArchivo, comisiones: 2_129_408 });
  check(r.status === 422 && r.j.ok === false && r.j.tasaRechazada === true && /superan las ventas brutas/.test(r.j.error) && /no se guardó nada/i.test(r.j.error), `${etiqueta}: 422 con mensaje claro: «${r.j.error.slice(0, 110)}…»`);
  check(JSON.stringify(globalThis.__hojas["Auditoría"]) === antes && escrituras().length === 0, `${etiqueta}: la hoja Auditoría no recibió ninguna escritura (ni fila ni encabezado)`);
  check(locksLiberados(), `${etiqueta}: el lock se libera igual`); }
console.log("F. ventas 0 con comisiones");
{ nuevaHoja(); const r = await analizar({ ml: crearML([], { fallaUsuario: true }), ventasArchivo: 0, comisiones: 50_000 }); check(r.status === 422 && /no se puede calcular la tasa/.test(r.j.error) && escrituras().length === 0, "ventas brutas $0 con comisiones → rechazado y sin escrituras"); }
console.log("G. sin aviso por rango (se eliminó el 8 %-25 %): cualquier tasa entre 0 y 100 % se guarda sin aviso");
for (const [com, etiqueta] of [[200_000, "2 %"], [3_000_000, "30 %"], [5_400_000, "54 %"]]) { nuevaHoja(); const r = await analizar({ ml: crearML([], { fallaUsuario: true }), ventasArchivo: 10_000_000, comisiones: com });
  check(r.status === 200 && r.j.ok && !!filaGuardada() && r.j.avisos.length === 0, `tasa ${etiqueta}: se guarda y NO aparece ningún aviso de rango`); }
{ nuevaHoja(); const r = await analizar({ ml: crearML([], { fallaUsuario: true }), ventasArchivo: 10_000_000, comisiones: 1_400_000 }); check(r.j.avisos.length === 0, "tasa de 14 %: sin aviso"); }
{ nuevaHoja(); const r = await analizar({ ml: crearML([], { fallaUsuario: true }), ventasArchivo: 10_000_000, comisiones: 10_000_000 }); check(r.status === 200 && r.j.ok && r.j.avisos.length === 0, "tasa de exactamente 100 %: no se rechaza (solo > 100 %) y no avisa"); }
console.log("H. re-análisis de un mes existente: no se pisa la columna Q (Almacenamiento de Rentabilidad)");
{ nuevaHoja([[MES, 1, 1, 1, 1, 1, 0, 1, 14.5, 0, 0, 0, "viejo", "01-01-2026", "", "", "1234"]]); const ventasRef = generar(10).length * 20000; const r = await analizar({ ml: crearML(generar(10)), ventasArchivo: 1, comisiones: Math.round(ventasRef * 0.14) }); const f = globalThis.__hojas["Auditoría"][1];
  const w = escrituras().filter((l) => l.op === "write").map((l) => l.range);
  check(r.j.ok && f[16] === "1234" && f[17] === "referencia ML" && f[1] === ventasRef, "la fila existente se actualiza: Q conserva «1234» y R = referencia ML");
  check(w.includes("Auditoría!A2:P2") && w.includes("Auditoría!R2:R2") && !w.some((x) => /Q\d/.test(x) && !/R/.test(x)), `escribe A2:P2 y R2:R2 por separado (rangos: ${w.join(", ")})`); }
console.log("I. error de cobertura: no se guarda");
{ nuevaHoja(); const r = await analizar({ ml: crearML(generar(3)), ventasArchivo: 1, comisiones: 1, cobertura: "Falta Facturación MP" }); check(r.j.ok && r.j.result.error_cobertura && escrituras().length === 0 && Array.isArray(r.j.avisos), "con error de cobertura no escribe nada; la respuesta conserva el campo avisos"); }
console.log("J. mes inválido: se rechaza ANTES de leer o escribir nada (S-06)");
for (const mes of [null, "", "Sin especificar", "2026-13", "2026-00", "26-09", "2026-9", "2026-09 ", " 2026-09", "2026-09\n", "2026/09", "audit:2026-09", "2026-09-01", "20260-9"]) {
  nuevaHoja(); const ml = crearML(generar(2)); const r = await analizar({ ml, ventasArchivo: 1, comisiones: 1, mes });
  check(r.status === 400 && /AAAA-MM/.test(r.j.error) && escrituras().length === 0 && globalThis.__hojas.Locks.length === 1 && ml.llamadas === 0, "mes " + JSON.stringify(mes) + ": 400, sin escrituras, sin lock y sin llamar a ML"); }
for (const mes of ["2026-01", "2026-09", "2026-12"]) { nuevaHoja(); const r = await analizar({ ml: crearML([], { fallaUsuario: true }), ventasArchivo: 10_000_000, comisiones: 500_000, mes }); check(r.status === 200 && r.j.ok, "mes " + mes + " válido: se analiza"); }

console.log("K. el lock del mes está ocupado → 409, sin escribir y sin llamar a ML");
{ nuevaHoja(); const ahoraS = Math.floor(Date.now() / 1000); globalThis.__hojas.Locks.push(["audit:" + MES, "tk-otro-analisis", ahoraS + 60, ""]);
  const ml = crearML(generar(2)); const r = await analizar({ ml, ventasArchivo: 1, comisiones: 1 });
  check(r.status === 409 && r.j.ok === false, "responde 409");
  check(/otro análisis del mes 2026-09 en curso/.test(r.j.error) && /No se guardó nada/.test(r.j.error), "mensaje para el usuario: «" + r.j.error + "»");
  check(escrituras().length === 0 && ml.llamadas === 0, "no escribió en Auditoría ni llamó a ML");
  check(ticketsActivos("audit:" + MES) === 1, "el ticket del otro análisis sigue intacto y el del intento rechazado se liberó");
  const r2 = await analizar({ ml: crearML([], { fallaUsuario: true }), ventasArchivo: 10_000_000, comisiones: 500_000, mes: "2026-08" }); check(r2.status === 200 && r2.j.ok, "otro mes (2026-08) no queda bloqueado"); }

console.log("L. Sheets falla al pedir el lock → 503, falla cerrado (nada se escribe)");
{ nuevaHoja(); globalThis.__fallaLocks = true; const ml = crearML(generar(2)); const r = await analizar({ ml, ventasArchivo: 1, comisiones: 1 });
  check(r.status === 503 && r.j.ok === false, "responde 503");
  check(/No se pudo proteger la escritura del mes 2026-09/.test(r.j.error) && /no se analizó ni se guardó nada/.test(r.j.error), "mensaje para el usuario: «" + r.j.error + "»");
  check(escrituras().length === 0 && ml.llamadas === 0 && globalThis.__hojas["Auditoría"].length === 1, "no escribió en Auditoría ni llamó a ML"); }

console.log("L2. cuota de Sheets (429) al adquirir el lock → 503, falla cerrado, mensaje claro");
{ nuevaHoja(); globalThis.__fallaLocks = "429"; const ml = crearML(generar(2)); const r = await analizar({ ml, ventasArchivo: 1, comisiones: 1 });
  check(r.status === 503 && r.j.ok === false && /No se pudo proteger la escritura del mes 2026-09/.test(r.j.error) && /Reintenta en un momento/.test(r.j.error), "429 → 503: «" + r.j.error + "»");
  check(escrituras().length === 0 && ml.llamadas === 0 && globalThis.__hojas["Auditoría"].length === 1, "no analizó, no llamó a ML y no escribió en Auditoría");
  globalThis.__fallaLocks = false; const r2 = await analizar({ ml: crearML([], { fallaUsuario: true }), ventasArchivo: 10_000_000, comisiones: 500_000 }); check(r2.status === 200 && r2.j.ok, "pasada la cuota, el reintento se analiza normal"); }

console.log("L3. lecturas de Sheets de un análisis (instancia con la pestaña Locks ya verificada)");
{ nuevaHoja(); globalThis.__reads = []; globalThis.__ensures = 0; const r = await analizar({ ml: crearML([], { fallaUsuario: true }), ventasArchivo: 10_000_000, comisiones: 500_000 });
  const lecturas = globalThis.__reads.map((x) => x.replace(/B2:B\d+/, "B2:B{fila}")); check(r.status === 200, "análisis ok");
  check(JSON.stringify(lecturas) === JSON.stringify(["Locks!A2:D", "Auditoría!A:A", "Auditoría!R1:R1", "Locks!B2:B{fila}"]), "4 lecturas de valores: releer Locks al adquirir, Auditoría!A:A, Auditoría!R1:R1 y la verificación del token al liberar");
  check(globalThis.__ensures === 1, "+ 1 consulta de metadatos (ensureSheets de Auditoría) = 5 solicitudes de lectura en total (instancia fría: +2 para verificar la pestaña Locks)"); }

console.log("M. el lock se libera aunque el análisis falle a mitad de camino");
{ nuevaHoja(); globalThis.__ml = crearML([]); globalThis.__calc = null; // calculateAudit lanza (TypeError) con __calc nulo
  const fd = new FormData(); fd.append("mes", MES); fd.append("file", new Blob(["x"]), "Reporte_MercadoLibre.csv"); const e = console.error; console.error = () => {};
  let res; try { res = await POST(new Request("http://x/api/audit/analyze", { method: "POST", body: fd })); } finally { console.error = e; }
  check(res.status === 500 && ticketsActivos("audit:" + MES) === 0, "500 por el error del análisis y el ticket quedó liberado");
  const r = await analizar({ ml: crearML([], { fallaUsuario: true }), ventasArchivo: 10_000_000, comisiones: 500_000 }); check(r.status === 200 && r.j.ok, "y el reintento siguiente se analiza sin esperar"); }

console.log("N. dos análisis del mismo mes casi a la vez: uno guarda, el otro recibe 409 (C-10: ya no crece AuditoriaLocks)");
{ nuevaHoja(); const lento = crearML([], { fallaUsuario: true }); const getOriginal = lento.get; lento.get = async (u) => { await new Promise((r) => setTimeout(r, 40)); return getOriginal(u); };
  const [a, b] = await Promise.all([analizar({ ml: lento, ventasArchivo: 10_000_000, comisiones: 500_000 }), analizar({ ml: lento, ventasArchivo: 10_000_000, comisiones: 500_000 })]);
  const estados = [a.status, b.status].sort(); check(JSON.stringify(estados) === JSON.stringify([200, 409]), "una responde 200 y la otra 409 (" + estados.join(" / ") + ")");
  check(globalThis.__hojas["Auditoría"].filter((r, i) => i > 0 && r[0] === MES).length === 1, "la hoja Auditoría tiene exactamente UNA fila del mes");
  check(JSON.stringify(globalThis.__hojas.AuditoriaLocks) === JSON.stringify([["Sin tocar", "1"]]), "AuditoriaLocks no se tocó (ya no se usa ni crece con filas en blanco)");
  check(locksLiberados(), "todos los tickets de Locks quedaron liberados"); }

console.log("\n" + ok + " comprobaciones OK");

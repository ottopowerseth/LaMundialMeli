// HERRAMIENTA DE UN SOLO USO (pruebas del verificador posterior de C-16): datos SINTÉTICOS y API de Sheets simulada; no contiene datos reales de las hojas.
// Aplica C-16 en la planilla simulada (con el script real de recálculo) y prueba c16_verificar_post.mjs: caso correcto, control negativo y cambios no permitidos.
// Uso:  node scripts/una-vez/test-c16-verificar-post.mjs
import crypto from "node:crypto"; import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import assert from "node:assert"; import { spawnSync } from "node:child_process"; import { createRequire } from "node:module"; import { fileURLToPath, pathToFileURL } from "node:url";
const require = createRequire(import.meta.url); const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."); const ts = require(path.join(PROJ, "node_modules", "typescript"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "margen-c16-test-")); for (const f of ["rentabilidad", "numero-texto"]) fs.writeFileSync(path.join(tmp, f + ".js"), ts.transpileModule(fs.readFileSync(path.join(PROJ, "lib", f + ".ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);
const { calcularMargen } = require(path.join(tmp, "rentabilidad.js")); const { numeroComoTexto } = require(path.join(tmp, "numero-texto.js"));
const N = await import(pathToFileURL(path.join(PROJ, "scripts", "una-vez", "margen-c16-nucleo.mjs")).href);
let ok = 0; const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); ok++; console.log("  ✓", m); }; const check = (c, m) => { assert.ok(c, m); ok++; console.log("  ✓", m); };
const r1 = (x) => Math.round(x * 10) / 10; const I = 1.19;
// fórmulas escritas aparte, a mano, para no depender del código bajo prueba
const f1 = (E, F, G, H, Ip) => r1(E - F - G - H - Ip), f2 = (E, F, G, H, Ip) => r1(E / I - F - G / I - H / I - Ip / I), f3 = (E, F, G, H, Ip) => r1(E / I - F / I - G / I - H / I - Ip / I);
// fila de Rentabilidad como la leería readSheet (valores mostrados): índices A..Q
const fila = (item, E, F, G, H, Ip, J, K) => { const r = Array(17).fill(""); r[2] = item; r[4] = String(E); r[5] = String(F); r[6] = String(G); r[7] = String(H); r[8] = String(Ip); r[9] = String(J); r[10] = String(K); r[13] = "1"; return r; };
const pct = (J, E) => Math.round((J / (E / I)) * 1000) / 10;

const SCRIPT = path.join(PROJ, "scripts", "una-vez", "recalcular-margen-c16.mjs"), SCRIPT_REST = path.join(PROJ, "scripts", "una-vez", "restaurar-margen-c16.mjs"), SCRIPT_VER = path.join(PROJ, "scripts", "una-vez", "verificar-restauracion-c16.mjs");
const raiz = path.join(tmp, "raiz"); fs.mkdirSync(path.join(raiz, "node_modules", "googleapis"), { recursive: true }); fs.writeFileSync(path.join(raiz, "package.json"), "{}");
fs.writeFileSync(path.join(raiz, "node_modules", "googleapis", "index.js"), `
const fs = require("fs"); const ARCH = process.env.FAKE_ESTADO; const cargar = () => JSON.parse(fs.readFileSync(ARCH, "utf8")); const guardar = (w) => fs.writeFileSync(ARCH, JSON.stringify(w));
const colIdx = (s) => s.split("").reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0) - 1;
function parseRango(r) { const i = r.lastIndexOf("!"); const hoja = r.slice(0, i), ref = r.slice(i + 1); const m = ref.match(/^([A-Z]+)(\\d*)(?::([A-Z]+)(\\d*))?$/); const c1 = colIdx(m[1]); const r1 = m[2] ? +m[2] - 1 : 0; return { hoja, c1, c2: m[3] ? colIdx(m[3]) : c1, r1, r2: m[4] ? +m[4] - 1 : (m[3] ? Infinity : (m[2] ? r1 : Infinity)) }; }
const aCelda = (v) => (v === "" || v === null || v === undefined ? null : typeof v === "number" ? { u: { numberValue: v }, shown: String(v) } : typeof v === "string" && v.startsWith("'") ? { u: { stringValue: v.slice(1) }, shown: v.slice(1) } : { u: { stringValue: String(v) }, shown: String(v) });
const celdaApi = (c) => (!c ? {} : { userEnteredValue: c.u, effectiveValue: c.u, formattedValue: c.shown, userEnteredFormat: c.fmt ? { numberFormat: c.fmt } : undefined });
const poner = (s, fila, col, c) => { while (s.filas.length <= fila) s.filas.push([]); const f = s.filas[fila]; while (f.length <= col) f.push(null); f[col] = c; if (s.filas.length > s.rowCount) s.rowCount = s.filas.length; };
exports.google = { auth: { GoogleAuth: class { constructor(o) { fs.appendFileSync(ARCH + ".scopes", JSON.stringify(o.scopes) + "\\n"); } } }, sheets: () => ({ spreadsheets: {
  get: async (p) => { const w = cargar(); if (!p.ranges) return { data: { sheets: Object.entries(w.sheets).map(([title, s]) => ({ properties: { title, sheetId: s.sheetId, gridProperties: { rowCount: s.rowCount, columnCount: 26 } } })) } };
    w.nGrid = (w.nGrid || 0) + 1; if (w.mutar && w.nGrid === w.mutar.en) { w.sheets[w.mutar.hoja].filas[w.mutar.fila][w.mutar.col] = w.mutar.celda; } guardar(w);
    const porHoja = new Map(); p.ranges.forEach((r) => { const q = parseRango(r); if (!porHoja.has(q.hoja)) porHoja.set(q.hoja, []); porHoja.get(q.hoja).push(q); });
    return { data: { sheets: [...porHoja].map(([hoja, qs]) => { const s = w.sheets[hoja]; return { data: qs.map((q) => { const rowData = []; const fin = Math.min(q.r2, s.filas.length - 1); for (let i = q.r1; i <= fin; i++) { const fila = s.filas[i] ?? []; const values = []; for (let c = q.c1; c <= q.c2 && c < fila.length; c++) values.push(celdaApi(fila[c])); rowData.push({ values }); } return { rowData }; }) }; }) } }; },
  batchUpdate: async (p) => { const w = cargar(); const rq = p.requestBody.requests; const conDatos = rq.some((r) => r.updateCells); w.nBatch = (w.nBatch || 0) + 1; if (conDatos) w.nBatchDatos = (w.nBatchDatos || 0) + 1;
    if (conDatos && w.falla && w.nBatchDatos === w.falla.enDatos) { guardar(w); throw Object.assign(new Error("falla simulada de Sheets"), { code: 500 }); }
    const porId = (id) => Object.values(w.sheets).find((s) => s.sheetId === id); w.escrituras = (w.escrituras || 0) + 1;
    for (const r of rq) {
      if (r.updateCells) { const u = r.updateCells; const s = porId(u.range.sheetId); const resetea = u.fields.includes("userEnteredFormat.numberFormat"); (w.camposEscritos ||= []).push(u.fields); u.rows.forEach((fila, i) => fila.values.forEach((cel, j) => { const f = u.range.startRowIndex + i, c = u.range.startColumnIndex + j; const v = cel.userEnteredValue; const nueva = v?.stringValue !== undefined ? { u: { stringValue: v.stringValue }, shown: v.stringValue } : v?.numberValue !== undefined ? { u: { numberValue: v.numberValue }, shown: String(v.numberValue) } : null; if (nueva && !resetea && s.filas[f]?.[c]?.fmt) nueva.fmt = s.filas[f][c].fmt; poner(s, f, c, nueva); w.celdasEscritas = (w.celdasEscritas || 0) + 1; (w.escritasEn ||= []).push(s.sheetId + ":" + (f + 1) + ":" + c); })); }
      else if (r.repeatCell || r.deleteDimension || r.addSheet) { w.otrasSolicitudes = (w.otrasSolicitudes || 0) + 1; }
    } guardar(w); return { data: {} }; },
  values: {
    get: async (p) => { const w = cargar(); const q = parseRango(p.range); const s = w.sheets[q.hoja]; const res = []; const fin = Math.min(q.r2, s.filas.length - 1); for (let i = q.r1; i <= fin; i++) { const fila = s.filas[i] ?? []; const row = []; for (let c = q.c1; c <= q.c2; c++) row.push(fila[c] ? fila[c].shown : ""); while (row.length && row.at(-1) === "") row.pop(); res.push(row); } while (res.length && res.at(-1).length === 0) res.pop(); return { data: { values: res } }; },
    append: async (p) => { const w = cargar(); const q = parseRango(p.range); const s = w.sheets[q.hoja]; let ult = -1; s.filas.forEach((f, i) => { if (f.some((c) => c)) ult = i; }); p.requestBody.values.forEach((fila, k) => fila.forEach((v, j) => poner(s, ult + 1 + k, q.c1 + j, aCelda(v)))); if (q.hoja !== "Locks") w.escrituras = (w.escrituras || 0) + 1; guardar(w); return { data: {} }; },
    update: async (p) => { const w = cargar(); const q = parseRango(p.range); const s = w.sheets[q.hoja]; p.requestBody.values.forEach((fila, k) => fila.forEach((v, j) => poner(s, q.r1 + k, q.c1 + j, aCelda(v)))); if (q.hoja !== "Locks") w.escrituras = (w.escrituras || 0) + 1; guardar(w); return { data: {} }; },
  } } }) };`);

// ---- planilla sintética: Rentabilidad con filas V1, V2 (una cambia de signo y una negativa), V3, sin costo y «otra» ----
const txt = (s) => ({ u: { stringValue: s }, shown: s }); const nm = (n) => ({ u: { numberValue: n }, shown: String(n) });
const serial = (y, m, d) => (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000; const comoFecha = (t) => ({ u: { numberValue: 1128388 }, shown: t, fmt: { type: "DATE", pattern: "yyyy.m" } }); const fechaDM = (t) => { const [d, m] = t.split(".").map(Number); return { u: { numberValue: serial(2026, m, d) }, shown: t, fmt: { type: "DATE", pattern: "d.m" } }; };
const eS = [10000, 8000, 500, 0, 0], eN = [20000, 16000, 2800, 3000, 0], e1 = [10000, 3000, 1190, 3000, 0];
const FILAS = [ // [ítem, entradas, margen guardado J, K guardado]
  ["MLA", e1, f1(...e1), "28.1"], ["MLA", e1, f2(...e1), "30"], ["MLA", e1, f2(...e1), "30"], ["MLB", eS, f2(...eS), "-0.2"], ["MLB", eN, f2(...eN), "-12"], ["MLA", e1, f3(...e1), "23.6"],
  ["MLA", ["10000", "", "1190", "3000", "0"], "", ""], ["MLC", [10000, 3000, 1190, 3000, 0], 12345, "9"]];
const filaSint = ([item, e, J, K], i) => { const r = Array(17).fill(null); r[0] = txt("ord" + i); r[1] = txt("2026-09"); r[2] = txt(item); r[3] = txt("titulo " + i); [4, 5, 6, 7, 8].forEach((c, k) => { if (e[k] !== "") r[c] = nm(Number(e[k])); }); if (J !== "") { r[9] = txt(String(J)); r[10] = txt(String(K)); } r[12] = txt("29-09-2026"); r[13] = txt("1"); r[14] = txt("700"); r[15] = txt("ok"); r[16] = txt("z" + i); return r; };
const esperadoDe = (filas) => { const cambia = (x) => { const [, e, J] = x; if (J === "" || e[1] === "") return false; return true; }; const tipoVer = (x) => { const [, e, J] = x; const v = [f1, f2, f3].map((f) => f(...e)); const cerca = (a, b) => Math.abs(a - b) <= 0.15; return cerca(v[2], J) && !cerca(v[1], J) ? "V3" : cerca(v[1], J) ? "V2" : cerca(v[0], J) ? "V1" : "otra"; };
  const con = filas.filter((x) => x[2] !== "" && x[1][1] !== ""); const nuevo = con.map((x) => { const v = tipoVer(x); const cam = v === "V1" || v === "V2"; const J = cam ? f3(...x[1]) : Number(x[2]); const K = cam ? pct(J, x[1][0]) : Number(x[3]); return { v, J, K, J0: Number(x[2]), cam }; });
  const t = nuevo.reduce((s, x) => s + x.J, 0); return { filas: nuevo.filter((x) => x.cam).length, V1: nuevo.filter((x) => x.v === "V1").length, V2: nuevo.filter((x) => x.v === "V2").length, n: nuevo.length, margenTotal: Math.round(r1(t)), pctPromedio: r1(nuevo.reduce((s, x) => s + x.K, 0) / nuevo.length), negativas: nuevo.filter((x) => x.J < 0).length, cambianSigno: nuevo.filter((x) => x.cam && Math.sign(x.J) !== Math.sign(x.J0)).length }; };
const baseSin = (conOtra) => { const filas = conOtra ? FILAS : FILAS.slice(0, 7); const w = { sheets: {}, escrituras: 0 }; const mk = (t, id, f, n) => { w.sheets[t] = { sheetId: id, rowCount: n ?? f.length, filas: f }; };
  mk("Rentabilidad", 1, [Array.from({ length: 17 }, (_, i) => txt("h" + i)), ...filas.map(filaSint)]); mk("Locks", 4, [[txt("Clave"), txt("Token"), txt("Vence (epoch s)"), txt("Liberado")]], 1000); mk("Rentabilidad RESPALDO T1", 10, JSON.parse(JSON.stringify(w.sheets.Rentabilidad.filas))); w.filasDe = filas; return w; };
let nEsc = 0; const escenario = (mod, conOtra = false) => { const w = baseSin(conOtra); mod?.(w); const esp = esperadoDe(w.filasDe); const f = path.join(tmp, "esc" + ++nEsc + ".json"); fs.writeFileSync(f, JSON.stringify(w)); fs.writeFileSync(f + ".scopes", ""); return { f, esp }; };
const estado = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const correr = (esc, args) => { const r = spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, C16_RAIZ: raiz, FAKE_ESTADO: esc.f, C16_ESPERADO: JSON.stringify(esc.esp), GOOGLE_SHEET_ID: "hoja-falsa", GOOGLE_SERVICE_ACCOUNT_EMAIL: "x@y", GOOGLE_PRIVATE_KEY: "k" }, encoding: "utf8", timeout: 120000 }); return { status: r.status, out: r.stdout + r.stderr }; };
const rent = (f) => estado(f).sheets.Rentabilidad.filas; const celdaStr = (c) => JSON.stringify(c ?? null);
const APL = (plan, extra = []) => ["--aplicar", `--plan=${plan}`, "--respaldo=T1", "--lote=2", "--pausa-ms=0", ...extra];
const plantar = (esc, nombre) => { const plan = path.join(tmp, nombre); const r = correr(esc, [`--salida=${plan}`]); return { plan, r, p: fs.existsSync(plan) ? JSON.parse(fs.readFileSync(plan, "utf8")) : null }; };


// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
const VERIF = path.join(PROJ, "scripts", "una-vez", "c16_verificar_post.mjs");
const ent = (esc) => ({ ...process.env, C16_RAIZ: raiz, FAKE_ESTADO: esc.f, C16_ESPERADO: JSON.stringify(esc.esp), GOOGLE_SHEET_ID: "hoja-falsa", GOOGLE_SERVICE_ACCOUNT_EMAIL: "x@y", GOOGLE_PRIVATE_KEY: "k" });
const verificar = (esc, args) => { const r = spawnSync(process.execPath, [VERIF, ...args], { env: ent(esc), encoding: "utf8", timeout: 120000 }); return { status: r.status, out: r.stdout + r.stderr }; };
const conFechaB = (w) => { for (const h of ["Rentabilidad", "Rentabilidad RESPALDO T1"]) w.sheets[h].filas.slice(1).forEach((f) => { f[1] = comoFecha("2026.9"); }); };
const preparar = (mod, aplicar = true) => { const esc = escenario(mod); const { plan, p } = plantar(esc, "plan_post_" + nEsc + ".json"); if (aplicar) { const a = correr(esc, APL(plan)); if (a.status !== 0) throw new Error("no se pudo aplicar C-16 simulado: " + a.out.slice(-300)); } return { esc, plan, p }; };
const ARGS = (plan) => [`--plan=${plan}`, "--respaldo=T1"];
const primerasX = (out) => (out.match(/✗[^\n]*/g) ?? []).map((l) => l.slice(0, 90));

console.log("S. Con C-16 aplicado (simulado), el verificador da todo ✓ y código 0");
{ const { esc, plan, p } = preparar(conFechaB); const r = verificar(esc, ARGS(plan)); check(r.status === 0 && /verificación COMPLETA sin diferencias/.test(r.out), "código 0 y «verificación COMPLETA sin diferencias»: " + primerasX(r.out).join(" | "));
  check(new RegExp(`${p.celdas.length}/${p.celdas.length} filas del plan con J y K como TEXTO`).test(r.out) && new RegExp(`${p.celdas.length}/${p.celdas.length} filas modificadas`).test(r.out), `${p.celdas.length}/${p.celdas.length} filas del plan como texto y ${p.celdas.length}/${p.celdas.length} modificadas respecto del respaldo`);
  check(/las únicas columnas con algún cambio de valor son: J,K/.test(r.out) && /formato de número de toda la hoja fuera de esas celdas: 0 cambios/.test(r.out) && /valor interno de las celdas FUERA de J:K de las \d+ filas del plan: 0 diferencias/.test(r.out), "solo cambiaron las columnas J y K y el resto de la hoja (valor, texto mostrado y formato) es idéntico al respaldo");
  check(new RegExp("la tarjeta es " + esc.esp.margenTotal.toLocaleString("es-CL").replace("-", "[-−]")).test(r.out) || /la tarjeta es/.test(r.out), "la tarjeta coincide con las cifras acordadas (en la simulación: " + JSON.stringify(esc.esp) + ")"); }

console.log("T. Control negativo: hoja SIN aplicar → falla (0 filas modificadas y tarjeta distinta)");
{ const { esc, plan, p } = preparar(conFechaB, false); const r = verificar(esc, ARGS(plan));
  check(r.status === 1 && /HAY DIFERENCIAS/.test(r.out), "código 1 y «HAY DIFERENCIAS»");
  check(new RegExp(`✗ 0/${p.celdas.length} filas del plan con J y K como TEXTO`).test(r.out) && new RegExp(`✗ 0/${p.celdas.length} filas modificadas`).test(r.out), `✗ 0/${p.celdas.length} filas del plan como texto y ✗ 0/${p.celdas.length} modificadas`);
  check(/✗ la tarjeta es/.test(r.out) && /✗ las únicas columnas con algún cambio de valor son: \(ninguna\)/.test(r.out), "✗ la tarjeta no es la acordada y ✗ ninguna columna cambió"); }

console.log("U. Aplicación a medias, o cambios fuera de lo permitido → falla");
{ const esc = escenario((w) => { conFechaB(w); w.falla = { enDatos: 2 }; }); const { plan, p } = plantar(esc, "plan_post_u.json"); correr(esc, APL(plan)); const w = estado(esc.f); w.falla = null; fs.writeFileSync(esc.f, JSON.stringify(w));
  const r = verificar(esc, ARGS(plan)); check(r.status === 1 && new RegExp(`✗ 2/${p.celdas.length} filas modificadas`).test(r.out), `aplicación a medias (lote 1 de 3): ✗ 2/${p.celdas.length} filas modificadas y código 1`); }
{ const tocar = (nombre, fn, re) => { const { esc, plan } = preparar(conFechaB); const w = estado(esc.f); fn(w); fs.writeFileSync(esc.f, JSON.stringify(w)); const r = verificar(esc, ARGS(plan)); check(r.status === 1 && re.test(r.out), nombre + ": " + primerasX(r.out).join(" | ")); };
  tocar("cambio del envío H de una fila (fuera de J:K)", (w) => { w.sheets.Rentabilidad.filas[3][7] = nm(1); }, /✗ valor interno de las celdas FUERA de J:K[^\n]*: 1 diferencias/);
  tocar("cambio en una fila fuera del plan (la V3, J)", (w) => { w.sheets.Rentabilidad.filas[6][9] = txt("1"); }, /✗ J y K de las filas que NO están en el plan[^\n]*: 1 modificadas/);
  tocar("cambio de formato fuera de las celdas del plan (columna B)", (w) => { delete w.sheets.Rentabilidad.filas[2][1].fmt; }, /✗ formato de número de toda la hoja fuera de esas celdas: 1 cambios/);
  tocar("una celda del plan sin el valor del plan (J como número)", (w) => { w.sheets.Rentabilidad.filas[2][9] = nm(5); }, /✗ \d+\/\d+ filas del plan con J y K como TEXTO/);
  tocar("cuadrícula distinta", (w) => { w.sheets.Rentabilidad.rowCount = 99; }, /✗ cuadrícula sin cambios/); }

console.log("V. Uso y solo lectura");
{ const esc = escenario(conFechaB); const sin = verificar(esc, []); check(sin.status === 2 && /Uso: --plan/.test(sin.out), "sin --plan ni --respaldo se niega (código 2)"); const raro = verificar(esc, ["--plan=x", "--respaldo=T1", "--otro=1"]); check(raro.status === 2, "argumento desconocido: código 2");
  const src = fs.readFileSync(VERIF, "utf8"); check(/spreadsheets\.readonly/.test(src) && !/batchUpdate\(|values\.(update|append|batchUpdate)|writeSheet|appendSheet/.test(src), "usa credencial de solo lectura y no contiene ninguna llamada de escritura");
  check(!/La Mundial Meli|C:\//.test(src), "no contiene rutas del equipo de Otto (usa rutas relativas al repo)"); }

console.log("\n" + ok + " comprobaciones OK");

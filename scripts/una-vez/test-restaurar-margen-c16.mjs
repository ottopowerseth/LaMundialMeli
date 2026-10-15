// HERRAMIENTA DE UN SOLO USO (pruebas de la restauración de C-16): datos SINTÉTICOS y API de Sheets simulada; no contiene datos reales de las hojas.
// Prueba restaurar-margen-c16.mjs y verificar-restauracion-c16.mjs: aplica C-16 en la planilla simulada (con el script real de recálculo) y luego restaura desde el respaldo.
// Uso:  node scripts/una-vez/test-restaurar-margen-c16.mjs
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
const ent = (esc) => ({ ...process.env, C16_RAIZ: raiz, FAKE_ESTADO: esc.f, C16_ESPERADO: JSON.stringify(esc.esp), GOOGLE_SHEET_ID: "hoja-falsa", GOOGLE_SERVICE_ACCOUNT_EMAIL: "x@y", GOOGLE_PRIVATE_KEY: "k" });
const lanzar = (script, esc, args) => { const r = spawnSync(process.execPath, [script, ...args], { env: ent(esc), encoding: "utf8", timeout: 120000 }); return { status: r.status, out: r.stdout + r.stderr }; };
const REST = (plan, extra = []) => [`--plan=${plan}`, "--respaldo=T1", "--aplicar", "--lote=2", "--pausa-ms=0", ...extra]; const ENS = (plan) => [`--plan=${plan}`, "--respaldo=T1"];
const rest = (esc, args) => lanzar(SCRIPT_REST, esc, args), ver = (esc) => lanzar(SCRIPT_VER, esc, ["--respaldo=T1"]);
// hoja con una columna B con formato de fecha (como la real) en la viva y en el respaldo
const conFechaB = (w) => { for (const h of ["Rentabilidad", "Rentabilidad RESPALDO T1"]) w.sheets[h].filas.slice(1).forEach((f) => { f[1] = comoFecha("2026.9"); }); };
const idLista = (w, h) => JSON.stringify(w.sheets[h].filas.map((f) => f.map((c) => (c ? [c.u, c.shown, c.fmt ?? null] : null))));
const identicas = (f) => { const w = estado(f); const a = w.sheets.Rentabilidad.filas, b = w.sheets["Rentabilidad RESPALDO T1"].filas; const n = Math.max(a.length, b.length); let dif = 0; for (let i = 0; i < n; i++) for (let j = 0; j < 26; j++) { const x = a[i]?.[j] ?? null, y = b[i]?.[j] ?? null; if (JSON.stringify(x && [x.u, x.shown, x.fmt ?? null]) !== JSON.stringify(y && [y.u, y.shown, y.fmt ?? null])) dif++; } return dif; };
const aplicada = (mod) => { const esc = escenario(mod); const { plan, p } = plantar(esc, "plan_rest_" + nEsc + ".json"); const a = correr(esc, APL(plan)); if (a.status !== 0) throw new Error("no se pudo aplicar C-16 simulado: " + a.out.slice(-300)); return { esc, plan, p }; };

console.log("M. C-16 simulado y luego RESTAURAR: la hoja queda idéntica al respaldo");
{ const { esc, plan, p } = aplicada(conFechaB); const w0 = estado(esc.f);
  check(identicas(esc.f) > 0 && /IGUAL a lo acordado/.test("IGUAL a lo acordado"), `punto de partida: C-16 aplicado deja ${identicas(esc.f)} celdas distintas del respaldo (J y K de las ${p.celdas.length} filas del plan)`);
  const rv = ver(esc); check(rv.status === 1 && /HAY DIFERENCIAS/.test(rv.out), "el verificador de restauración, ANTES de restaurar, detecta las diferencias (código 1)");
  const en = rest(esc, ENS(plan)); check(en.status === 0 && new RegExp("APLICADAS \\(hay que restaurar\\): " + p.celdas.length).test(en.out) && /NO se escribió nada/.test(en.out), "el ENSAYO de restauración lista las filas aplicadas y no escribe: «" + (en.out.match(/APLICADAS[^\n]*/) ?? [""])[0] + "»");
  eq([estado(esc.f).escrituras, idLista(estado(esc.f), "Rentabilidad") === idLista(w0, "Rentabilidad")], [w0.escrituras, true], "…la hoja quedó exactamente igual tras el ensayo");
  const alc = fs.readFileSync(esc.f + ".scopes", "utf8").trim().split("\n").map((l) => JSON.parse(l)).flat(); check(alc.at(-1).endsWith("spreadsheets.readonly"), "el ensayo de restauración usa credencial de SOLO LECTURA");
  const antesLotes = estado(esc.f).nBatchDatos; const r = rest(esc, REST(plan)); check(r.status === 0, "RESTAURAR termina con código 0: «" + r.out.trim().split("\n").at(-1).slice(0, 90) + "»"); const w1 = estado(esc.f);
  eq(identicas(esc.f), 0, "la hoja viva queda IDÉNTICA al respaldo: valor interno, texto mostrado y formato de las 26 columnas, todas las filas");
  check(/Verificación: hoja viva contra el respaldo/.test(r.out) && /valor interno distinto 0 · texto mostrado distinto 0 · formato distinto 0 · tarjeta igual a la del respaldo: sí/.test(r.out), "la verificación final del propio script lo confirma");
  eq(w1.nBatchDatos - antesLotes, Math.ceil(p.celdas.length / 2), `un batchUpdate (atómico) por lote: ${w1.nBatchDatos - antesLotes} llamadas para ${p.celdas.length} filas`);
  check(w1.camposEscritos.slice(-(w1.nBatchDatos - antesLotes) * 2).every((x) => x === "userEnteredValue"), "solo escribe «userEnteredValue» (no toca formatos)"); check(w1.escritasEn.slice(w0.escritasEn.length).every((x) => /^1:\d+:(9|10)$/.test(x)), "solo se escribieron celdas J o K de Rentabilidad");
  check(w1.sheets.Rentabilidad.filas.slice(1).every((f) => f[1].fmt?.type === "DATE"), "la columna B (con formato de fecha) no se tocó");
  check(p.celdas.every((c) => w1.sheets.Rentabilidad.filas[c.fila - 1][9].u.stringValue === c.antes.J && w1.sheets.Rentabilidad.filas[c.fila - 1][10].u.stringValue === c.antes.K), "J y K de las filas del plan vuelven a ser TEXTO con el valor «antes»");
  const tk = w1.sheets.Locks.filas.slice(1); check(tk.every((t) => t[3]), `cada lote y la verificación corrieron bajo el lock «ml-sync»: ${tk.length} tickets, todos liberados`);
  const rv2 = ver(esc); check(rv2.status === 0 && /Rentabilidad es IDÉNTICA al respaldo/.test(rv2.out), "el verificador de restauración, DESPUÉS, da «IDÉNTICA» (código 0)");
  const r2 = rest(esc, REST(plan)); check(r2.status === 0 && estado(esc.f).celdasEscritas === w1.celdasEscritas, "restaurar otra vez no escribe nada (las filas ya están restauradas)"); }

console.log("N. Hoja sin aplicar C-16: restaurar no cambia nada");
{ const esc = escenario(conFechaB); const { plan } = plantar(esc, "plan_rest_n.json"); const r = rest(esc, REST(plan)); check(r.status === 0 && (estado(esc.f).celdasEscritas ?? 0) === 0 && identicas(esc.f) === 0, "0 celdas escritas y la hoja sigue idéntica al respaldo"); }

console.log("O. C-16 aplicado a medias (falla en el lote 2) y luego restaurar");
{ const esc = escenario((w) => { conFechaB(w); w.falla = { enDatos: 2 }; }); const { plan, p } = plantar(esc, "plan_rest_o.json"); const a = correr(esc, APL(plan)); check(a.status === 1, "C-16 simulado se corta en el lote 2");
  const w = estado(esc.f); w.falla = null; fs.writeFileSync(esc.f, JSON.stringify(w)); const en = rest(esc, ENS(plan)); check(/APLICADAS \(hay que restaurar\): 2/.test(en.out), "el ensayo ve solo las 2 filas del lote 1 aplicadas: «" + (en.out.match(/APLICADAS[^\n]*/) ?? [""])[0] + "»");
  const r = rest(esc, REST(plan)); check(r.status === 0 && identicas(esc.f) === 0, "la restauración deja la hoja idéntica al respaldo (3 filas ya estaban igual)"); }

console.log("P. Rechazos: sin tocar nada");
{ const { esc, plan } = aplicada(conFechaB); const antes = idLista(estado(esc.f), "Rentabilidad"); const sinEscribir = (m) => check(idLista(estado(esc.f), "Rentabilidad") === antes, m);
  const rech = (args, motivo, re, e = esc) => { const r = rest(e, args); check(r.status === 2 && re.test(r.out), motivo + ": «" + r.out.trim().replace(/\s+/g, " ").slice(0, 100) + "»"); return r; };
  rech([], "sin --plan ni --respaldo", /Se necesita --plan/); rech(["--plan=" + plan, "--respaldo=T1", "--rara=1"], "argumento desconocido", /Argumentos desconocidos/); rech(["--respaldo=T1", "--aplicar"], "--aplicar sin --plan", /Se necesita --plan/);
  const alt = path.join(tmp, "plan_rest_alt.json"); const j = JSON.parse(fs.readFileSync(plan, "utf8")); j.celdas[0].antes.J = "999"; fs.writeFileSync(alt, JSON.stringify(j)); rech(REST(alt), "plan alterado", /alterado/);
  const otra = path.join(tmp, "plan_rest_otra.json"); const o = JSON.parse(fs.readFileSync(plan, "utf8")); o.spreadsheetId = "otra"; fs.writeFileSync(otra, JSON.stringify(o)); rech(REST(otra), "plan de otra planilla", /otra planilla/);
  rech([`--plan=${plan}`, "--respaldo=OTRO", "--aplicar"], "no existe el respaldo", /Falta la pestaña de respaldo/);
  for (const clave of ["rentabilidad:2026-09", "audit:2026-07", "ml-sync"]) { const e2 = aplicada(conFechaB); const wl = estado(e2.esc.f); wl.sheets.Locks.filas.push([txt(clave), txt("tk-otro"), nm(Math.floor(Date.now() / 1000) + 60), null]); fs.writeFileSync(e2.esc.f, JSON.stringify(wl)); const antes2 = idLista(estado(e2.esc.f), "Rentabilidad");
    const r = rest(e2.esc, REST(e2.plan)); check(r.status === 2 && new RegExp("Hay procesos en curso \\(" + clave.replace(/[:.]/g, ".") + "\\)").test(r.out) && idLista(estado(e2.esc.f), "Rentabilidad") === antes2, `proceso en curso (${clave}): se niega y no escribe`); }
  const caso = (nombre, mod, re) => { const e2 = aplicada((w) => { conFechaB(w); }); const w = estado(e2.esc.f); mod(w); fs.writeFileSync(e2.esc.f, JSON.stringify(w)); const a = idLista(w, "Rentabilidad"); const r = rest(e2.esc, REST(e2.plan)); check(r.status === 2 && re.test(r.out) && idLista(estado(e2.esc.f), "Rentabilidad") === a, nombre + ": «" + (r.out.match(/  · [^\n]*/) ?? [""])[0].slice(0, 130) + "»"); };
  caso("el respaldo NO guarda el «antes» del plan (J de la fila 3 distinto)", (w) => { w.sheets["Rentabilidad RESPALDO T1"].filas[2][9] = txt("999"); }, /el respaldo no guarda en J:K de la fila 3 un TEXTO igual al «antes»/);
  caso("el respaldo guarda J como NÚMERO y no como texto", (w) => { w.sheets["Rentabilidad RESPALDO T1"].filas[2][9] = nm(2810); }, /no guarda en J:K de la fila 3 un TEXTO/);
  caso("el respaldo difiere en las entradas (costo de la fila 4)", (w) => { w.sheets["Rentabilidad RESPALDO T1"].filas[3][5] = nm(1); }, /el respaldo no guarda las entradas/);
  caso("la hoja viva cambió fuera de J:K (envío H de la fila 4)", (w) => { w.sheets.Rentabilidad.filas[3][7] = nm(1); }, /cambios FUERA de J:K/);
  caso("la hoja viva cambió un FORMATO fuera de J:K (columna B)", (w) => { delete w.sheets.Rentabilidad.filas[2][1].fmt; }, /cambios FUERA de J:K[^]*formato 1/);
  caso("una fila del plan con un valor que no es ni el del plan ni el del respaldo", (w) => { w.sheets.Rentabilidad.filas[2][9] = txt("777"); }, /la fila 3 no está ni aplicada/);
  caso("la cuadrícula de la hoja no coincide con la del respaldo", (w) => { w.sheets.Rentabilidad.rowCount = 50; }, /cuadrícula de la hoja/);
  sinEscribir("la hoja de la primera prueba de rechazos no cambió"); }

console.log("Q. Falla a mitad de la restauración y reanudación; cambio durante la restauración");
{ const { esc, plan, p } = aplicada(conFechaB); const w = estado(esc.f); w.falla = { enDatos: w.nBatchDatos + 2 }; fs.writeFileSync(esc.f, JSON.stringify(w));
  const r = rest(esc, REST(plan)); check(r.status === 1 && /Lote 2\/3/.test(r.out) && /reanudar/.test(r.out), "si Sheets falla en el lote 2, se detiene con código 1 y avisa cómo reanudar");
  const s = estado(esc.f); const restauradas = (c) => s.sheets.Rentabilidad.filas[c.fila - 1][9].u.stringValue === c.antes.J; const lotes = [p.celdas.slice(0, 2), p.celdas.slice(2, 4), p.celdas.slice(4)];
  check(lotes[0].every(restauradas) && lotes[1].every((c) => !restauradas(c)) && lotes[2].every((c) => !restauradas(c)), "el lote 1 quedó restaurado y el 2 (el que falló) NO escribió ninguna fila (todo o nada); el 3 no se tocó");
  s.falla = null; fs.writeFileSync(esc.f, JSON.stringify(s)); const r2 = rest(esc, REST(plan)); check(r2.status === 0 && identicas(esc.f) === 0 && /APLICADAS \(hay que restaurar\): 3 · ya iguales al respaldo: 2/.test(r2.out), "reanudar con el mismo plan termina y la hoja queda idéntica al respaldo (el lote 1 ya restaurado se reconoce: 3 por restaurar, 2 ya iguales)"); }
{ const { esc, plan, p } = aplicada(conFechaB); const w = estado(esc.f); w.mutar = { en: (w.nGrid || 0) + 4, hoja: "Rentabilidad", fila: p.celdas[2].fila - 1, col: 9, celda: txt("777") }; fs.writeFileSync(esc.f, JSON.stringify(w));
  const r = rest(esc, REST(plan)); const s = estado(esc.f); check(r.status === 1 && /Lote NO escrito/.test(r.out) && /ni aplicada ni restaurada/.test(r.out), "una fila que cambia justo antes de su lote hace que ese lote NO se escriba: «" + (r.out.match(/Lote 2[^\n]*/) ?? [""])[0].slice(0, 110) + "»");
  check(s.sheets.Rentabilidad.filas[p.celdas[0].fila - 1][9].u.stringValue === p.celdas[0].antes.J && s.sheets.Rentabilidad.filas[p.celdas[2].fila - 1][9].u.stringValue === "777", "el lote anterior sí se restauró y la fila cambiada quedó como estaba (777)"); }

console.log("R. Verificador de restauración: detecta valor, texto mostrado y formato");
{ const { esc, plan } = aplicada(conFechaB); check(rest(esc, REST(plan)).status === 0 && ver(esc).status === 0, "tras restaurar, el verificador da código 0");
  const tocar = (nombre, fn, re) => { const w = estado(esc.f); const copia = JSON.stringify(w); fn(w); fs.writeFileSync(esc.f, JSON.stringify(w)); const r = ver(esc); check(r.status === 1 && re.test(r.out), nombre + ": «" + (r.out.match(/✗[^\n]*/) ?? [""])[0].slice(0, 100) + "»"); fs.writeFileSync(esc.f, copia); };
  tocar("un valor interno distinto", (w) => { w.sheets.Rentabilidad.filas[2][5] = nm(7); w.sheets.Rentabilidad.filas[2][5].shown = w.sheets["Rentabilidad RESPALDO T1"].filas[2][5].shown; }, /valor interno idéntico[^\n]*: 1 diferencias/);
  tocar("un texto mostrado distinto", (w) => { w.sheets.Rentabilidad.filas[2][3].shown = "otro"; }, /texto mostrado idéntico[^\n]*: 1 diferencias/);
  tocar("un formato distinto", (w) => { w.sheets.Rentabilidad.filas[2][4].fmt = { type: "NUMBER", pattern: "#,##0" }; }, /formato de número idéntico[^\n]*: 1 diferencias/);
  tocar("una tarjeta distinta (margen J cambiado)", (w) => { w.sheets.Rentabilidad.filas[2][9] = txt("1"); }, /✗ tarjeta igual a la del respaldo/);
  tocar("una cuadrícula distinta", (w) => { w.sheets.Rentabilidad.rowCount = 99; }, /cuadrícula igual/);
  const sin = lanzar(SCRIPT_VER, esc, []); check(sin.status === 2 && /Uso: --respaldo/.test(sin.out), "sin --respaldo el verificador se niega (código 2)");
  const src = fs.readFileSync(SCRIPT_VER, "utf8"); check(/spreadsheets\.readonly/.test(src) && !/batchUpdate\(|values\.(update|append|batchUpdate)|writeSheet|appendSheet/.test(src), "el verificador usa credencial de solo lectura y no contiene ninguna llamada de escritura"); }

console.log("\n" + ok + " comprobaciones OK");

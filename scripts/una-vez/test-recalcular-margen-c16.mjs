// HERRAMIENTA DE UN SOLO USO (pruebas de el recálculo C-16): datos SINTÉTICOS y API de Sheets simulada; no contiene datos reales de las hojas.
// Pruebas del núcleo del ensayo de recálculo de márgenes (C-16, fase 1) con filas SINTÉTICAS y del rechazo de --aplicar. Sin red; nada toca una hoja.
// Uso:  node scripts/una-vez/test-recalcular-margen-c16.mjs
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

console.log("A. clasificar la versión de la fórmula que reproduce el margen guardado");
{ const e = [10000, 3000, 1190, 3000, 0]; const v = N.leerFilas([fila("A", ...e, f1(...e), 0), fila("A", ...e, f2(...e), 0), fila("A", ...e, f3(...e), 0)]);
  eq(v.map(N.clasificarVersion), ["V1", "V2", "V3"], "reconoce V1 (todo bruto), V2 (COGS tal cual) y V3 (todo neto) con valores de prueba");
  eq(N.leerFilas([fila("A", 10000, "", 1190, 3000, 0, "", ""), fila("B", 10000, 3000, 1190, 3000, 0, f3(10000, 3000, 1190, 3000, 0), 5)]).map((x) => x.fila), [3], "las filas sin COGS o sin margen guardado no entran (fila 2 sin COGS, queda la 3)"); }

console.log("B. margen corregido bajo las dos hipótesis");
{ const x = N.leerFilas([fila("A", 10000, 3000, 1190, 3000, 0, f1(10000, 3000, 1190, 3000, 0), 0)])[0];
  const b = N.margenCorregido(x, "bruto", calcularMargen), n = N.margenCorregido(x, "neto", calcularMargen);
  eq([b.J, b.K], [f3(10000, 3000, 1190, 3000, 0), pct(f3(10000, 3000, 1190, 3000, 0), 10000)], "hipótesis BRUTO = fórmula actual (calcularMargen) con el COGS tal cual");
  eq(n.J, f2(10000, 3000, 1190, 3000, 0), "hipótesis NETO = fórmula con el COGS llevado a bruto (×1,19) = la V2 (el COGS neto no se divide)"); check(n.J < b.J, "con COGS neto el margen es MENOR que con COGS bruto (el costo real es más alto)"); }

console.log("C. escenario, filas que cambian de signo y tarjeta");
{ const e1 = [10000, 3000, 1190, 3000, 0], e2 = [20000, 14000, 2800, 3000, 0];
  const filas = N.leerFilas([fila("A", ...e1, f2(...e1), pct(f2(...e1), 10000)), fila("A", ...e1, f2(...e1), pct(f2(...e1), 10000)), fila("B", ...e2, f2(...e2), pct(f2(...e2), 20000)), fila("B", ...e2, f1(...e2), 0)]).map((x) => ({ ...x, version: N.clasificarVersion(x) }));
  eq(filas.map((x) => x.version), ["V2", "V2", "V2", "V1"], "las 4 filas de prueba: 3 de V2 y 1 de V1"); eq(N.tarjeta(filas.map((x) => ({ J: x.J, K: x.K }))).n, 4, "la tarjeta cuenta las 4 filas con margen");
  const bruto = N.aplicarEscenario(filas, () => "bruto", calcularMargen), neto = N.aplicarEscenario(filas, () => "neto", calcularMargen), mixto = N.aplicarEscenario(filas, (it) => (it === "B" ? "neto" : "bruto"), calcularMargen);
  check(bruto.filter((x) => x.item === "A").every((x) => x.cambia) && bruto.filter((x) => x.item === "B").every((x) => x.cambia), "todo bruto: cambian las filas V2 y la V1");
  eq(neto.map((x) => x.cambia), [false, false, false, true], "todo neto: las filas V2 NO cambian (ya eran correctas con COGS neto); solo cambia la V1");
  eq(mixto.map((x) => x.cambia), [true, true, false, true], "mixto (B neto, A bruto): A cambia, B-V2 no, B-V1 sí");
  const sg = (esc) => esc.filter((x) => x.cambiaSigno).length; check(sg(bruto) >= 1 && sg(bruto) <= 4, "las filas que cambian de signo se cuentan (bruto: " + sg(bruto) + ")");
  const tb = N.tarjeta(bruto.map((x) => ({ J: x.Jn, K: x.Kn }))); check(tb.margenTotal === r1(bruto.reduce((s, x) => s + x.Jn, 0)) && tb.n === 4, "la tarjeta corregida suma los márgenes corregidos"); eq(N.resumenPorItem(neto).find((r) => r.item === "B").versiones, { V2: 1, V1: 1 }, "el resumen por ítem muestra el estado V1/V2/V3 de sus filas"); }

console.log("D. escrituras propuestas: solo J:K, con apóstrofo, solo filas que cambian");
{ const e = [10000, 3000, 1190, 3000, 0]; const filas = N.leerFilas([fila("A", ...e, f1(...e), 0), fila("A", ...e, f3(...e), pct(f3(...e), 10000)), fila("A", 10000, 25000, 1190, 3000, 0, f1(10000, 25000, 1190, 3000, 0), 0)]).map((x) => ({ ...x, version: N.clasificarVersion(x) }));
  const esc = N.escriturasPropuestas(N.aplicarEscenario(filas, () => "bruto", calcularMargen), numeroComoTexto);
  eq(esc.length, 2, "solo 2 de 3 filas se reescriben: la que ya coincide con la fórmula actual no se toca (idempotente)"); check(esc.every((x) => /^Rentabilidad!J\d+:K\d+$/.test(x.range)), "el rango es siempre J:K de la fila (no toca H, O, P ni Q)");
  check(esc.every((x) => x.values[0].every((v) => String(v).startsWith("'"))), "todos los valores llevan el apóstrofo del ayudante de números: " + esc.map((x) => x.values[0].join("|")).join(" ; "));
  check(esc.some((x) => x.values[0][0].startsWith("'-")), "los negativos llevan el apóstrofo ANTES del signo (el signo no se altera)"); eq(esc.map((x) => x.values[0].map((v) => numeroComoTexto(v))), esc.map((x) => x.values[0]), "aplicar el ayudante otra vez no cambia nada (idempotente)");
  const segunda = N.escriturasPropuestas(N.aplicarEscenario(filas.map((x, i) => ({ ...x, J: N.aplicarEscenario(filas, () => "bruto", calcularMargen)[i].Jn, K: N.aplicarEscenario(filas, () => "bruto", calcularMargen)[i].Kn })), () => "bruto", calcularMargen), numeroComoTexto);
  eq(segunda.length, 0, "tras escribir los valores corregidos, un segundo ensayo no propone ninguna escritura"); }


// =====================================================================================================================================================================
// Pruebas del script completo (ensayo / aplicar) contra una API de Sheets SIMULADA (estado en un archivo temporal, datos sintéticos). El modo APLICAR corre solo contra esa simulación.
// =====================================================================================================================================================================
const SCRIPT = path.join(PROJ, "scripts", "una-vez", "recalcular-margen-c16.mjs");
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

console.log("\nF. ENSAYO contra la planilla simulada: solo lectura, plan de las filas V1 y V2");
{ const esc = escenario(); const { plan, r, p } = plantar(esc, "plan_f.json"); const antes = JSON.stringify(estado(esc.f).sheets); check(r.status === 0, "el ensayo termina bien: «" + r.out.trim().split("\n").at(-3).slice(0, 80) + "»");
  eq(p.celdas.map((c) => c.fila), [2, 3, 4, 5, 6], "el plan contiene SOLO las filas V1 y V2 (filas 2–6); la V3 (7) y la sin costo (8) quedan fuera");
  eq(p.celdas.map((c) => c.version), ["V1", "V2", "V2", "V2", "V2"], "cada fila del plan lleva la versión de fórmula con que se guardó");
  eq([p.resumen.filas, p.resumen.V1, p.resumen.V2, p.resumen.cambianSigno, p.resumen.despues.n], [esc.esp.filas, esc.esp.V1, esc.esp.V2, esc.esp.cambianSigno, esc.esp.n], "el resumen del plan coincide con el cálculo independiente (filas, V1, V2, cambios de signo, n)");
  eq([Math.round(p.resumen.despues.margenTotal), p.resumen.despues.pctPromedio, p.resumen.despues.negativas], [esc.esp.margenTotal, esc.esp.pctPromedio, esc.esp.negativas], "…y la tarjeta corregida (margen total, % promedio, negativas) también");
  check(p.celdas.every((c) => numeroComoTexto(Number(c.despues.J)) === "'" + c.despues.J && numeroComoTexto(Number(c.despues.K)) === "'" + c.despues.K), "cada valor del plan sale de numeroComoTexto: con el apóstrofo es exactamente «'» + el texto del plan");
  check(p.celdas.some((c) => c.despues.J.startsWith("-")) && numeroComoTexto(Number(p.celdas.find((c) => c.despues.J.startsWith("-")).despues.J)).startsWith("'-"), "un margen negativo lleva el apóstrofo ANTES del signo");
  const e = estado(esc.f); eq([e.escrituras, JSON.stringify(e.sheets) === antes], [0, true], "no escribió NADA (0 escrituras, contenido idéntico)");
  const alc = fs.readFileSync(esc.f + ".scopes", "utf8").trim().split("\n").map((l) => JSON.parse(l)).flat(); check(alc.every((a) => a.endsWith("spreadsheets.readonly")), "el ensayo usa credenciales de SOLO LECTURA");
  const igual = correr(esc, [`--salida=${path.join(tmp, "plan_f2.json")}`, `--comparar-con=${plan}`]); check(/El plan es IGUAL al anterior/.test(igual.out), "--comparar-con reconoce un plan igual al anterior");
  const pisa = correr(esc, [`--salida=${plan}`]); check(pisa.status === 2 && /NO sobrescribe planes/.test(pisa.out) && JSON.parse(fs.readFileSync(plan, "utf8")).sha256 === p.sha256, "el ensayo se niega a sobrescribir un plan existente (el original queda intacto)"); }

console.log("G. APLICAR exige bandera, plan íntegro, sin ambiguas, resumen acordado, respaldo igual, nada corriendo y limpieza previa");
{ const esc = escenario(); const { plan, p } = plantar(esc, "plan_g.json"); const antes = JSON.stringify(estado(esc.f).sheets); const rech = (args, motivo, re, e = esc) => { const r = correr(e, args); check(r.status === 2 && re.test(r.out), motivo + ": «" + r.out.trim().split("\n").at(-1).slice(0, 80) + "»"); };
  rech([`--plan=${plan}`, "--respaldo=T1"], "--plan sin --aplicar solo hace ensayo y se rechaza", /solo se usan con --aplicar/); rech(["--aplicar"], "--aplicar sin plan ni respaldo", /exige --plan/); rech(["--aplicar", `--plan=${plan}`], "--aplicar sin --respaldo", /exige --plan/);
  const alt = path.join(tmp, "plan_g_alt.json"); const j = JSON.parse(JSON.stringify(p)); j.celdas[0].despues.J = "999"; fs.writeFileSync(alt, JSON.stringify(j)); rech(APL(alt), "plan alterado", /alterado/);
  const amb = path.join(tmp, "plan_g_amb.json"); const k = JSON.parse(JSON.stringify(p)); k.celdas[0].ambigua = true; k.sha256 = crypto.createHash("sha256").update(JSON.stringify(k.celdas)).digest("hex"); fs.writeFileSync(amb, JSON.stringify(k)); rech(APL(amb), "plan con filas ambiguas", /AMBIGUA/);
  const dist = path.join(tmp, "plan_g_res.json"); const m = JSON.parse(JSON.stringify(p)); m.resumen.despues.negativas += 1; fs.writeFileSync(dist, JSON.stringify(m)); rech(APL(dist), "resumen distinto de lo acordado", /no coincide con lo acordado/);
  const otra = path.join(tmp, "plan_g_otra.json"); const o = JSON.parse(JSON.stringify(p)); o.spreadsheetId = "otra-planilla"; fs.writeFileSync(otra, JSON.stringify(o)); rech(APL(otra), "plan de otra planilla", /otra planilla/);
  rech(["--aplicar", `--plan=${plan}`, "--respaldo=OTRO", "--pausa-ms=0"], "no existe el respaldo", /Falta la pestaña de respaldo/);
  const e2 = escenario((w) => { w.sheets["Rentabilidad RESPALDO T1"].filas[6][4] = nm(5); }); const p2 = plantar(e2, "plan_g2.json"); rech(APL(p2.plan), "el respaldo difiere de la hoja real en una fila fuera del plan (mensaje: duplicar de nuevo y repetir el ensayo)", /NO coincide con la hoja real[^]*REPITE EL ENSAYO/, e2);
  const e2b = escenario((w) => { w.sheets["Rentabilidad RESPALDO T1"].filas[2][5] = nm(5); }); const p2b = plantar(e2b, "plan_g2b.json"); rech(APL(p2b.plan), "el respaldo fue modificado en una fila del plan (el costo, no el margen)", /NO guarda el «antes» del plan en la fila 3[^]*REPITE EL ENSAYO/, e2b);
  const e2c = escenario((w) => { w.sheets["Rentabilidad RESPALDO T1"].filas[3][9] = txt("1"); }); const p2c = plantar(e2c, "plan_g2c.json"); rech(APL(p2c.plan), "el respaldo fue modificado en el margen J de una fila del plan", /NO guarda el «antes» del plan en la fila 4[^]*duplicar la pestaña Rentabilidad/, e2c);
  for (const clave of ["rentabilidad:2026-09", "audit:2026-07", "ml-sync"]) { const e3 = escenario((w) => { w.sheets.Locks.filas.push([txt(clave), txt("tk-otro"), nm(Math.floor(Date.now() / 1000) + 60), null]); }); const p3 = plantar(e3, "plan_g3.json"); rech(APL(p3.plan), `proceso en curso (${clave})`, new RegExp("Hay procesos en curso \\(" + clave.replace(/[:.]/g, ".") + "\\)"), e3); }
  eq([estado(esc.f).escrituras, JSON.stringify(estado(esc.f).sheets) === antes], [0, true], "ninguno de esos rechazos escribió nada en la hoja");
  const ef = escenario((w) => { for (const h of ["Rentabilidad", "Rentabilidad RESPALDO T1"]) w.sheets[h].filas[3][9] = comoFecha(w.sheets[h].filas[3][9].shown); }); const pf = plantar(ef, "plan_g4.json"); const antesJ5 = estado(ef.f).sheets.Rentabilidad.filas[4][9].u.stringValue; const rf = correr(ef, APL(pf.plan));
  check(rf.status === 1 && /aún tiene formato de FECHA/.test(rf.out) && /falta la limpieza de formatos/.test(rf.out) && /Lote NO escrito/.test(rf.out), "si J o K de una fila del plan sigue con formato de fecha (limpieza pendiente), se detiene: «" + (rf.out.match(/J o K de la fila [^.]*/) ?? [""])[0].slice(0, 60) + "…»");
  const sinEsc = estado(ef.f); check(sinEsc.sheets.Rentabilidad.filas[3][9].u.numberValue === 1128388 && sinEsc.sheets.Rentabilidad.filas[4][9].u.numberValue === undefined && sinEsc.sheets.Rentabilidad.filas[4][9].u.stringValue === antesJ5, "…y no escribió ni la fila con fecha ni la otra de su lote (la fila 5 sigue igual)"); }

console.log("H. APLICAR completo (lotes de 2): solo J:K del plan, como texto, y la verificación final");
{ const esc = escenario(); const { plan, p } = plantar(esc, "plan_h.json"); const w0 = estado(esc.f); const r = correr(esc, APL(plan)); check(r.status === 0, "termina con código 0: «" + r.out.trim().split("\n").at(-2).slice(0, 110) + "»"); const w1 = estado(esc.f);
  check(p.celdas.every((c) => { const f = w1.sheets.Rentabilidad.filas[c.fila - 1]; return f[9].u.stringValue === c.despues.J && f[10].u.stringValue === c.despues.K && f[9].shown === c.despues.J && !f[9].fmt; }), `las ${p.celdas.length} filas del plan quedaron con J y K como TEXTO (el efecto del apóstrofo) con el valor corregido`);
  const tocadas = new Set(p.celdas.flatMap((c) => [`${c.fila - 1}|9`, `${c.fila - 1}|10`])); let resto = true; w0.sheets.Rentabilidad.filas.forEach((fila, i) => fila.forEach((c, j) => { if (!tocadas.has(`${i}|${j}`) && celdaStr(c) !== celdaStr(w1.sheets.Rentabilidad.filas[i]?.[j])) resto = false; }));
  check(resto, "ninguna otra celda cambió: H, O, P, Q, el costo F, las filas V3, la «otra» y la sin costo quedaron idénticas"); check(JSON.stringify(w0.sheets["Rentabilidad RESPALDO T1"]) === JSON.stringify(w1.sheets["Rentabilidad RESPALDO T1"]), "la pestaña de respaldo no se tocó");
  check(w1.camposEscritos.every((x) => x === "userEnteredValue"), "updateCells solo escribe «userEnteredValue» (no toca formatos)"); check(w1.escritasEn.every((x) => /^1:\d+:(9|10)$/.test(x)), "todas las celdas escritas son de Rentabilidad y de las columnas J o K");
  eq(w1.nBatchDatos, Math.ceil(p.celdas.length / 2), `un batchUpdate (atómico) por lote: ${w1.nBatchDatos} llamadas para ${p.celdas.length} filas`); eq(w1.otrasSolicitudes ?? 0, 0, "no hubo repeatCell, borrados ni pestañas nuevas");
  const tk = w1.sheets.Locks.filas.slice(1); check(tk.length >= Math.ceil(p.celdas.length / 2) + 1 && tk.every((t) => t[3]), `cada lote y la verificación corrieron dentro del lock «ml-sync»: ${tk.length} tickets, todos liberados`);
  check(/IGUAL a lo acordado/.test(r.out) && /un nuevo ensayo propone 0 filas/.test(r.out) && /resto de la hoja sin cambios \(solo J:K del plan\) = sí/.test(r.out), "la verificación final confirma resumen, resto sin cambios y 0 propuestas nuevas");
  const r2 = correr(esc, APL(plan)); check(r2.status === 0 && estado(esc.f).celdasEscritas === w1.celdasEscritas, "una segunda corrida con el MISMO plan termina bien y no reescribe nada (reanudable)");
  const en = plantar(esc, "plan_h2.json"); eq(en.p.celdas.length, 0, "repetir el ensayo tras aplicar no propone ninguna fila"); }

console.log("I. Falla a mitad: el lote que falla no escribe nada y se puede reanudar");
{ const esc = escenario((w) => { w.falla = { enDatos: 2 }; }); const { plan, p } = plantar(esc, "plan_i.json"); const r = correr(esc, APL(plan)); check(r.status === 1, "si Sheets falla en el lote 2, el script se detiene con código 1"); const w = estado(esc.f);
  const hecho = (c) => w.sheets.Rentabilidad.filas[c.fila - 1][9].u.stringValue === c.despues.J; const lotes = [p.celdas.slice(0, 2), p.celdas.slice(2, 4), p.celdas.slice(4)];
  check(lotes[0].every(hecho), "el lote 1 quedó escrito completo"); check(lotes[1].every((c) => !hecho(c)) && lotes[2].every((c) => !hecho(c)), "el lote 2 que falló NO escribió NINGUNA de sus filas (todo o nada) y el 3 no se tocó"); check(/Se detiene/.test(r.out) && /reanudar/.test(r.out), "avisa qué lote falló y cómo reanudar");
  const w2 = estado(esc.f); w2.falla = null; fs.writeFileSync(esc.f, JSON.stringify(w2)); const r2 = correr(esc, APL(plan)); check(r2.status === 0, "reanudar con el mismo plan termina bien: «" + r2.out.trim().split("\n").at(-2).slice(0, 70) + "»");
  const w3 = estado(esc.f); check(p.celdas.every((c) => w3.sheets.Rentabilidad.filas[c.fila - 1][9].u.stringValue === c.despues.J), "al final todas las filas del plan están corregidas"); check(/filas escritas 0, ya escritas 2/.test(r2.out), "el lote 1 se reconoció como ya escrito en la reanudación"); }

console.log("J. Si alguien cambia una fila entre la comprobación y la escritura, el lote NO se escribe; si cambia antes de duplicar, ni arranca");
{ const esc = escenario((w) => { w.mutar = { en: 2, hoja: "Rentabilidad", fila: 3, col: 5, celda: nm(3100) }; }); const { plan, p } = plantar(esc, "plan_j.json"); const r = correr(esc, APL(plan)); const w2 = estado(esc.f);
  check(r.status === 1 && /La fila 4 cambió desde el ensayo/.test(r.out) && /Lote NO escrito/.test(r.out), "el costo de la fila 4 cambia justo antes del lote 2: se detiene en ese lote: «" + (r.out.match(/La fila 4[^.]*/) ?? [""])[0].slice(0, 70) + "…»");
  const hecho = (c) => w2.sheets.Rentabilidad.filas[c.fila - 1][9].u.stringValue === c.despues.J; check(p.celdas.slice(0, 2).every(hecho), "el lote anterior (sin cambios) sí se escribió"); check(p.celdas.slice(2).every((c) => !hecho(c)), "el lote con la fila cambiada y los siguientes quedaron intactos");
  const e2 = escenario(); const p2 = plantar(e2, "plan_j2.json"); const x = estado(e2.f); for (const h of ["Rentabilidad", "Rentabilidad RESPALDO T1"]) x.sheets[h].filas[3][5] = nm(3100); fs.writeFileSync(e2.f, JSON.stringify(x));
  const r2 = correr(e2, APL(p2.plan)); check(r2.status === 2 && /NO guarda el «antes» del plan en la fila 4/.test(r2.out) && /REPITE EL ENSAYO/.test(r2.out), "si algo cambió después del ensayo y antes de duplicar, ni arranca (el respaldo no guarda el «antes»): pide duplicar y repetir el ensayo"); }

console.log("K. Fila «otra» (margen que no calza con ninguna fórmula): el ensayo la marca y aplicar se niega");
{ const esc = escenario(null, true); const { plan, r, p } = plantar(esc, "plan_k.json"); check(r.status === 0 && p.celdas.filter((c) => c.ambigua).length === 1 && /AMBIGUAS/.test(r.out), "el ensayo marca 1 fila ambigua (la «otra»)"); const r2 = correr(esc, APL(plan)); check(r2.status === 2 && /AMBIGUA/.test(r2.out), "aplicar se niega mientras haya una"); }

console.log("L. La limpieza de formatos no altera el plan (mismo sha256) y el ensayo no depende del formato");
{ const a = escenario((w) => { for (const h of ["Rentabilidad", "Rentabilidad RESPALDO T1"]) { w.sheets[h].filas[1][10] = comoFecha("28.1"); } }); const pa = plantar(a, "plan_l1.json"); const w = estado(a.f); for (const h of ["Rentabilidad", "Rentabilidad RESPALDO T1"]) w.sheets[h].filas[1][10] = txt("28.1"); fs.writeFileSync(a.f, JSON.stringify(w)); const pb = plantar(a, "plan_l2.json");
  check(pa.p.sha256 === pb.p.sha256, "el plan es el mismo antes y después de limpiar el formato de fecha de K (sha256 " + pa.p.sha256.slice(0, 12) + "…)"); const c = correr(a, [`--salida=${path.join(tmp, "plan_l3.json")}`, `--comparar-con=${pa.plan}`]); check(/El plan es IGUAL al anterior/.test(c.out), "--comparar-con lo confirma"); }

console.log("\n" + ok + " comprobaciones OK");

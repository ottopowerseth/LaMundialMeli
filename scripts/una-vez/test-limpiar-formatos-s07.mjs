// HERRAMIENTA DE UN SOLO USO (pruebas de la limpieza S-07): datos SINTÉTICOS y API de Sheets simulada; no contiene datos reales de las hojas.
// Pruebas de scripts/una-vez/limpiar-formatos-s07.mjs contra una API de Sheets SIMULADA (estado en un archivo temporal, datos sintéticos). El modo APLICAR se ejecuta solo contra esa
// simulación: nada de esto toca una hoja real ni a Mercado Libre.  Uso:  node scripts/una-vez/test-limpiar-formatos-s07.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(PROJ, "scripts", "una-vez", "limpiar-formatos-s07.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "limpieza-test-"));
let ok = 0; const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); ok++; console.log("  ✓", m); }; const check = (c, m) => { assert.ok(c, m); ok++; console.log("  ✓", m); };

// ---- API simulada ----
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
    const porHoja = new Map(); p.ranges.forEach((r) => { const q = parseRango(r); if (!porHoja.has(q.hoja)) porHoja.set(q.hoja, []); porHoja.get(q.hoja).push(q); });
    return { data: { sheets: [...porHoja].map(([hoja, qs]) => { const s = w.sheets[hoja]; return { data: qs.map((q) => { const rowData = []; const fin = Math.min(q.r2, s.filas.length - 1); for (let i = q.r1; i <= fin; i++) { const fila = s.filas[i] ?? []; const values = []; for (let c = q.c1; c <= q.c2 && c < fila.length; c++) values.push(celdaApi(fila[c])); rowData.push({ values }); } return { rowData }; }) }; }) } }; },
  batchUpdate: async (p) => { const w = cargar(); const rq = p.requestBody.requests; const conDatos = rq.some((r) => r.updateCells); w.nBatch = (w.nBatch || 0) + 1; if (conDatos) w.nBatchDatos = (w.nBatchDatos || 0) + 1;
    if (conDatos && w.falla && w.nBatchDatos === w.falla.enDatos) { guardar(w); throw Object.assign(new Error("falla simulada de Sheets"), { code: 500 }); }
    const porId = (id) => Object.values(w.sheets).find((s) => s.sheetId === id); w.escrituras = (w.escrituras || 0) + 1;
    for (const r of rq) {
      if (r.addSheet) { const id = 1000 + Object.keys(w.sheets).length; w.sheets[r.addSheet.properties.title] = { sheetId: id, rowCount: 1000, filas: [] }; }
      else if (r.deleteDimension) { const d = r.deleteDimension.range; porId(d.sheetId).filas.splice(d.startIndex, d.endIndex - d.startIndex); }
      else if (r.updateCells) { const u = r.updateCells; const s = porId(u.range.sheetId); const resetea = u.fields.includes("userEnteredFormat.numberFormat"); u.rows.forEach((fila, i) => fila.values.forEach((cel, j) => { const f = u.range.startRowIndex + i, c = u.range.startColumnIndex + j; const v = cel.userEnteredValue; const nueva = v?.stringValue !== undefined ? { u: { stringValue: v.stringValue }, shown: v.stringValue } : v?.numberValue !== undefined ? { u: { numberValue: v.numberValue }, shown: String(v.numberValue) } : null; if (nueva && !resetea && s.filas[f]?.[c]?.fmt) nueva.fmt = s.filas[f][c].fmt; poner(s, f, c, nueva); w.celdasEscritas = (w.celdasEscritas || 0) + 1; })); }
      else if (r.repeatCell) { const g = r.repeatCell.range; const s = porId(g.sheetId); for (let f = g.startRowIndex; f < Math.min(g.endRowIndex, s.filas.length); f++) for (let c = g.startColumnIndex; c < g.endColumnIndex; c++) { const cel = s.filas[f]?.[c]; if (cel && r.repeatCell.fields.includes("numberFormat")) delete cel.fmt; } (w.formatoReset ||= []).push({ hoja: Object.keys(w.sheets).find((k) => w.sheets[k].sheetId === g.sheetId), col: g.startColumnIndex, desde: g.startRowIndex, hasta: g.endRowIndex }); }
    } guardar(w); return { data: {} }; },
  values: {
    get: async (p) => { const w = cargar(); const q = parseRango(p.range); const s = w.sheets[q.hoja]; const res = []; const fin = Math.min(q.r2, s.filas.length - 1); for (let i = q.r1; i <= fin; i++) { const fila = s.filas[i] ?? []; const row = []; for (let c = q.c1; c <= q.c2; c++) row.push(fila[c] ? fila[c].shown : ""); while (row.length && row.at(-1) === "") row.pop(); res.push(row); } while (res.length && res.at(-1).length === 0) res.pop(); return { data: { values: res } }; },
    append: async (p) => { const w = cargar(); const q = parseRango(p.range); const s = w.sheets[q.hoja]; let ult = -1; s.filas.forEach((f, i) => { if (f.some((c) => c)) ult = i; }); p.requestBody.values.forEach((fila, k) => fila.forEach((v, j) => poner(s, ult + 1 + k, q.c1 + j, aCelda(v)))); w.escrituras = (w.escrituras || 0) + 1; guardar(w); return { data: {} }; },
    update: async (p) => { const w = cargar(); const q = parseRango(p.range); const s = w.sheets[q.hoja]; p.requestBody.values.forEach((fila, k) => fila.forEach((v, j) => poner(s, q.r1 + k, q.c1 + j, aCelda(v)))); w.escrituras = (w.escrituras || 0) + 1; guardar(w); return { data: {} }; },
  } } }) };`);

// ---- planilla sintética ----
const serial = (y, m, d) => (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000;
const fechaYM = (txt) => { const [y, m] = txt.split(".").map(Number); return { u: { numberValue: serial(y, m, 1) }, shown: txt, fmt: { type: "DATE", pattern: "yyyy.m" } }; };
const fechaDM = (txt) => { const [d, m] = txt.split(".").map(Number); return { u: { numberValue: serial(2026, m, d) }, shown: txt, fmt: { type: "DATE", pattern: "d.m" } }; };
const num = (n) => ({ u: { numberValue: n }, shown: String(n) }); const txt = (s) => ({ u: { stringValue: s }, shown: s });
const COL = (c) => c.charCodeAt(0) - 65;
function hoja(ncol, nfilas, columnas) { const filas = [Array.from({ length: ncol }, (_, i) => txt("h" + i))]; for (let r = 1; r <= nfilas; r++) filas.push(Array.from({ length: ncol }, (_, c) => (c === 0 ? txt("id" + r) : null))); for (const [col, celdas] of Object.entries(columnas)) celdas.forEach((c, i) => { if (c) filas[i + 1][COL(col)] = c; }); return filas; }
const base = () => { const w = { sheets: {}, escrituras: 0 }; const mk = (titulo, id, filas, rowCount) => { w.sheets[titulo] = { sheetId: id, rowCount: rowCount ?? filas.length, filas }; };
  mk("Rentabilidad", 1, hoja(17, 9, { H: [fechaYM("4989.6"), num(222), txt("799.4"), fechaYM("1019.9"), num(150), null, fechaYM("3959.2"), num(3000), txt("1200")], J: [fechaYM("5652.3"), num(8), txt("-2537.9"), null, num(-5), fechaYM("1063.6"), null, txt("866"), null], K: [fechaDM("10.2"), num(23), txt("33.3"), fechaDM("28.3"), null, null, num(-35), null, fechaDM("3.3")], O: [fechaYM("1849.4"), fechaYM("1849.4"), num(185), txt("809.9"), fechaYM("2059.4"), null, null, null, null] }));
  mk("ShippingCache", 2, hoja(9, 6, { E: [fechaYM("1598.8"), num(3000), txt("799.4"), fechaYM("2488.5"), null, fechaYM("1019.9")] }));
  mk("TarifaEnvio", 3, hoja(12, 6, { C: [fechaYM("1019.9"), num(1020), txt("999.6"), null, fechaYM("1039.5"), num(810)], F: [fechaDM("3.9"), num(12), null, num(7), null, fechaDM("3.7")] }));
  mk("Locks", 4, [[txt("Clave"), txt("Token"), txt("Vence (epoch s)"), txt("Liberado")]], 1000);
  for (const h of ["Rentabilidad", "ShippingCache", "TarifaEnvio"]) mk(`${h} RESPALDO T1`, 10 + Object.keys(w.sheets).length, JSON.parse(JSON.stringify(w.sheets[h].filas)));
  return w; };
const conteoEsperado = (w) => { let fecha = 0, plano = 0; const cols = { Rentabilidad: "HJKO", ShippingCache: "E", TarifaEnvio: "CF" }; for (const [h, cs] of Object.entries(cols)) for (const c of cs) w.sheets[h].filas.slice(1).forEach((f) => { const x = f[COL(c)]; if (x?.u?.numberValue !== undefined) x.fmt ? fecha++ : plano++; }); return { fecha, plano, total: fecha + plano }; };
const escenario = (nombre, mod) => { const w = base(); mod?.(w); const f = path.join(tmp, nombre + ".json"); fs.writeFileSync(f, JSON.stringify(w)); fs.writeFileSync(f + ".scopes", ""); return f; };
const estado = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const correr = (f, args) => { const r = spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, S07_RAIZ: raiz, FAKE_ESTADO: f, GOOGLE_SHEET_ID: "hoja-falsa", GOOGLE_SERVICE_ACCOUNT_EMAIL: "x@y", GOOGLE_PRIVATE_KEY: "k" }, encoding: "utf8", timeout: 120000 }); return { status: r.status, out: r.stdout + r.stderr }; };
const valores = (w) => Object.fromEntries(Object.entries(w.sheets).map(([k, s]) => [k, s.filas.map((f) => f.map((c) => (c ? [c.u, c.fmt ?? null, c.shown] : null)))]));

const esperado = conteoEsperado(base()); console.log(`Planilla sintética: ${esperado.total} celdas numéricas (${esperado.fecha} con formato de fecha, ${esperado.plano} planos)`);
console.log("A. ENSAYO (modo por defecto): solo lectura");
{ const f = escenario("ensayo"); const plan = path.join(tmp, "plan_a.json"); const antes = JSON.stringify(valores(estado(f)));
  const r = correr(f, [`--salida=${plan}`]); check(r.status === 0, "termina bien"); const p = JSON.parse(fs.readFileSync(plan, "utf8"));
  eq([p.celdas.length, p.celdas.filter((c) => c.antes.tipo === "fecha").length, p.celdas.filter((c) => c.antes.tipo === "numero").length, p.celdas.filter((c) => c.ambigua).length], [esperado.total, esperado.fecha, esperado.plano, 0], "el plan tiene todas las celdas numéricas: fecha, planos y 0 ambiguas");
  check(p.celdas.every((c) => typeof c.despues === "string" && /^-?\d+(\.\d+)?$/.test(c.despues)), "cada celda propone un texto numérico (lo que muestra hoy la hoja)");
  check(!p.celdas.some((c) => c.hoja === "Rentabilidad" && c.col === "H" && c.fila === 4), "los textos («799.4») y las celdas vacías no entran al plan");
  const e = estado(f); eq([e.escrituras || 0, JSON.stringify(valores(e)) === antes], [0, true], "no escribió NADA en la planilla (0 escrituras, contenido idéntico)");
  const alcances = fs.readFileSync(f + ".scopes", "utf8").trim().split("\n").map((l) => JSON.parse(l)).flat(); check(alcances.every((a) => a.endsWith("spreadsheets.readonly")), "el ensayo usa credenciales de SOLO LECTURA: " + [...new Set(alcances)].join(", "));
  check(/repeatCell/.test(r.out) && /userEnteredFormat\.numberFormat/.test(r.out), "muestra el repeatCell propuesto (no lo ejecuta)");
  const pisa = correr(f, [`--salida=${plan}`]); check(pisa.status === 2 && /NO sobrescribe planes/.test(pisa.out) && JSON.parse(fs.readFileSync(plan, "utf8")).sha256 === p.sha256, "el ensayo se niega a sobrescribir un plan existente (el original queda intacto)"); }

console.log("B. APLICAR exige bandera, plan íntegro, sin ambiguas, respaldo igual y nada corriendo");
{ const f = escenario("rechazos"); const plan = path.join(tmp, "plan_b.json"); correr(f, [`--salida=${plan}`]); const antes = JSON.stringify(valores(estado(f)));
  const sin = (args, motivo, re) => { const r = correr(f, args); check(r.status === 2 && re.test(r.out), motivo + ": «" + r.out.trim().split("\n").at(-1).slice(0, 90) + "»"); };
  sin([`--plan=${plan}`, "--respaldo=T1"], "--plan sin --aplicar solo hace ensayo y se rechaza", /solo se usan con --aplicar/); sin(["--aplicar"], "--aplicar sin plan ni respaldo", /exige --plan/); sin(["--aplicar", `--plan=${plan}`], "--aplicar sin --respaldo", /exige --plan/);
  const alterado = path.join(tmp, "plan_alterado.json"); const j = JSON.parse(fs.readFileSync(plan, "utf8")); j.celdas[0].despues = "999"; fs.writeFileSync(alterado, JSON.stringify(j)); sin(["--aplicar", `--plan=${alterado}`, "--respaldo=T1"], "plan alterado", /alterado/);
  const amb = path.join(tmp, "plan_amb.json"); const k = JSON.parse(fs.readFileSync(plan, "utf8")); k.celdas[0].ambigua = true; k.sha256 = require_hash(k.celdas); fs.writeFileSync(amb, JSON.stringify(k)); sin(["--aplicar", `--plan=${amb}`, "--respaldo=T1"], "plan con celdas ambiguas", /AMBIGUA/);
  sin(["--aplicar", `--plan=${plan}`, "--respaldo=OTRO"], "no existe el respaldo", /Falta la pestaña de respaldo/);
  const f2 = escenario("respaldo_distinto", (w) => { w.sheets["ShippingCache RESPALDO T1"].filas[1][4] = txt("5"); }); const plan2 = path.join(tmp, "plan_b2.json"); correr(f2, [`--salida=${plan2}`]); const r2 = correr(f2, ["--aplicar", `--plan=${plan2}`, "--respaldo=T1"]); check(r2.status === 2 && /NO coincide con la hoja real/.test(r2.out), "el respaldo no coincide con la hoja real");
  const f3 = escenario("proceso_en_curso", (w) => { w.sheets.Locks.filas.push([txt("rentabilidad:2026-09"), txt("tk-otro"), num(Math.floor(Date.now() / 1000) + 60), null]); }); const plan3 = path.join(tmp, "plan_b3.json"); correr(f3, [`--salida=${plan3}`]); const r3 = correr(f3, ["--aplicar", `--plan=${plan3}`, "--respaldo=T1"]); check(r3.status === 2 && /Hay procesos en curso \(rentabilidad:2026-09\)/.test(r3.out), "un análisis de Rentabilidad en curso impide aplicar");
  eq([estado(f).escrituras || 0, JSON.stringify(valores(estado(f))) === antes], [0, true], "ninguno de esos rechazos escribió nada"); }
function require_hash(x) { return crypto.createHash("sha256").update(JSON.stringify(x)).digest("hex"); }

console.log("C. APLICAR completo (lotes de 7, que cruzan de una hoja a otra)");
{ const f = escenario("aplicar"); const plan = path.join(tmp, "plan_c.json"); correr(f, [`--salida=${plan}`]); const w0 = estado(f); const p = JSON.parse(fs.readFileSync(plan, "utf8"));
  const r = correr(f, ["--aplicar", `--plan=${plan}`, "--respaldo=T1", "--lote=7", "--pausa-ms=0"]); check(r.status === 0, "termina con código 0: «" + r.out.trim().split("\n").at(-1).slice(0, 110) + "»"); const w1 = estado(f);
  const celdaDe = (w, c) => w.sheets[c.hoja].filas[c.fila - 1][COL(c.col)];
  check(p.celdas.every((c) => { const x = celdaDe(w1, c); return x.u.stringValue === c.despues && !x.fmt && x.shown === c.despues; }), `las ${p.celdas.length} celdas quedaron como TEXTO con el valor mostrado y sin formato`);
  check(p.celdas.every((c) => celdaDe(w0, c).shown === celdaDe(w1, c).shown), "el valor MOSTRADO de cada celda es exactamente el mismo que antes");
  const tocadas = new Set(p.celdas.map((c) => `${c.hoja}|${c.fila - 1}|${COL(c.col)}`)); let intactas = true; for (const h of ["Rentabilidad", "ShippingCache", "TarifaEnvio", "Rentabilidad RESPALDO T1", "ShippingCache RESPALDO T1", "TarifaEnvio RESPALDO T1"]) w0.sheets[h].filas.forEach((fila, i) => fila.forEach((c, j) => { if (!tocadas.has(`${h}|${i}|${j}`) && JSON.stringify(c) !== JSON.stringify(w1.sheets[h].filas[i]?.[j] ?? null)) intactas = false; }));
  check(intactas, "ninguna otra celda cambió (textos, vacías, encabezados y las pestañas de respaldo quedaron iguales)");
  const cols = { Rentabilidad: "HJKO", ShippingCache: "E", TarifaEnvio: "CF" }; let fechas = 0; for (const [h, cs] of Object.entries(cols)) for (const c of cs) w1.sheets[h].filas.slice(1).forEach((f) => { if (f[COL(c)]?.fmt) fechas++; }); eq(fechas, 0, "0 celdas con formato de fecha en las columnas numéricas");
  eq((w1.formatoReset ?? []).map((x) => `${x.hoja}!${String.fromCharCode(65 + x.col)}`).sort(), ["Rentabilidad!H", "Rentabilidad!J", "Rentabilidad!K", "Rentabilidad!O", "ShippingCache!E", "TarifaEnvio!C", "TarifaEnvio!F"], "el repeatCell restableció el formato de número de las 7 columnas");
  check((w1.formatoReset ?? []).every((x) => x.desde === 1 && x.hasta === w1.sheets[x.hoja].rowCount), "…de la fila 2 al final de la cuadrícula");
  const lotes = Math.ceil(p.celdas.length / 7); const batchesDatos = w1.nBatchDatos; eq(batchesDatos, lotes, `un batchUpdate (atómico) por lote: ${lotes} lotes → ${batchesDatos} llamadas con datos`);
  const tickets = w1.sheets.Locks.filas.slice(1); check(tickets.length >= lotes + 1 && tickets.every((t) => t[3]), `cada lote corrió dentro del lock «ml-sync»: ${tickets.length} tickets, todos liberados`);
  const r2 = correr(f, ["--aplicar", `--plan=${plan}`, "--respaldo=T1", "--lote=7", "--pausa-ms=0"]); check(r2.status === 0, "una segunda corrida con el MISMO plan termina bien (reanudable): «" + r2.out.trim().split("\n").at(-1).slice(0, 60) + "»");
  check(estado(f).celdasEscritas === w1.celdasEscritas, "la segunda corrida no reescribió ninguna celda (las reconoció como ya convertidas)"); }

console.log("D. Todo o nada por lote y reanudación");
{ const f = escenario("falla_lote", (w) => { w.falla = { enDatos: 3 }; }); const plan = path.join(tmp, "plan_d.json"); correr(f, [`--salida=${plan}`]); const p = JSON.parse(fs.readFileSync(plan, "utf8"));
  const r = correr(f, ["--aplicar", `--plan=${plan}`, "--respaldo=T1", "--lote=7", "--pausa-ms=0"]); check(r.status === 1, "si Sheets falla en el lote 3, el script se detiene con código 1"); const w = estado(f); const celdaDe = (c) => w.sheets[c.hoja].filas[c.fila - 1][COL(c.col)];
  const lotes = []; for (let i = 0; i < p.celdas.length; i += 7) lotes.push(p.celdas.slice(i, i + 7));
  check(lotes[0].every((c) => celdaDe(c).u.stringValue === c.despues) && lotes[1].every((c) => celdaDe(c).u.stringValue === c.despues), "los lotes 1 y 2 quedaron escritos completos");
  check(lotes[2].every((c) => celdaDe(c).u.numberValue !== undefined), "el lote 3 que falló NO escribió NINGUNA de sus 7 celdas (todo o nada)"); check(lotes.slice(3).every((l) => l.every((c) => celdaDe(c).u.numberValue !== undefined)), "los lotes siguientes no se tocaron");
  check(/Se detiene|Lote 3\/\d+/.test(r.out), "avisa qué lote falló y cómo reanudar"); const w2 = estado(f); w2.falla = null; fs.writeFileSync(f, JSON.stringify(w2));
  const r2 = correr(f, ["--aplicar", `--plan=${plan}`, "--respaldo=T1", "--lote=7", "--pausa-ms=0"]); check(r2.status === 0, "reanudar con el mismo plan, sin la falla, termina bien (los lotes 1 y 2 se reconocen como ya convertidos)"); const w3 = estado(f);
  check(p.celdas.every((c) => { const x = w3.sheets[c.hoja].filas[c.fila - 1][COL(c.col)]; return x.u.stringValue === c.despues && !x.fmt; }), "al final todas las celdas del plan están convertidas"); }

console.log("E. Si alguien cambia una celda después del ensayo, el lote NO se escribe");
{ const f = escenario("cambio"); const plan = path.join(tmp, "plan_e.json"); correr(f, [`--salida=${plan}`]); const p = JSON.parse(fs.readFileSync(plan, "utf8")); const objetivo = p.celdas[10];
  // alguien cambió la celda DESPUÉS del ensayo; el respaldo se tomó después del cambio (igual a la hoja real), así que lo único que lo delata es el «antes» del plan
  const w = estado(f); w.sheets[objetivo.hoja].filas[objetivo.fila - 1][COL(objetivo.col)] = num(777); w.sheets[objetivo.hoja + " RESPALDO T1"].filas[objetivo.fila - 1][COL(objetivo.col)] = num(777); fs.writeFileSync(f, JSON.stringify(w));
  const r = correr(f, ["--aplicar", `--plan=${plan}`, "--respaldo=T1", "--lote=7", "--pausa-ms=0"]); check(r.status === 1 && /ya no coincide con el plan/.test(r.out) && /Lote NO escrito/.test(r.out), "se detiene en el lote de esa celda: «" + (r.out.match(/La celda [^.]*/) ?? [""])[0].slice(0, 70) + "…»");
  const w2 = estado(f); const loteBueno = p.celdas.slice(0, 7); check(loteBueno.every((c) => w2.sheets[c.hoja].filas[c.fila - 1][COL(c.col)].u.stringValue === c.despues), "el lote anterior (sin cambios) sí se escribió");
  const lote2 = p.celdas.slice(7, 14); check(lote2.every((c) => w2.sheets[c.hoja].filas[c.fila - 1][COL(c.col)].u.stringValue === undefined) && w2.sheets[objetivo.hoja].filas[objetivo.fila - 1][COL(objetivo.col)].u.numberValue === 777, "el lote con la celda cambiada quedó intacto, incluida la celda cambiada (777)"); }

console.log("F. Celdas ambiguas: el ensayo las marca y aplicar se niega");
{ const f = escenario("ambigua", (w) => { const c = w.sheets.ShippingCache.filas[1][COL("E")]; c.fmt = { type: "DATE", pattern: "yyyy/mm/dd" }; }); const plan = path.join(tmp, "plan_f.json"); const r = correr(f, [`--salida=${plan}`]); const p = JSON.parse(fs.readFileSync(plan, "utf8"));
  check(r.status === 0 && p.celdas.filter((c) => c.ambigua).length === 1 && /AMBIGUAS/.test(r.out), "el ensayo marca 1 celda ambigua (patrón desconocido)"); const r2 = correr(f, ["--aplicar", `--plan=${plan}`, "--respaldo=T1"]); check(r2.status === 2 && /AMBIGUA/.test(r2.out), "aplicar se niega mientras haya una"); }

console.log("G. Una celda con formato de fecha que aparece DESPUÉS del ensayo: no se restablece el formato (el repeatCell la dejaría mostrando el número interno)");
{ const f = escenario("fecha_nueva"); const plan = path.join(tmp, "plan_g.json"); correr(f, [`--salida=${plan}`]); const w = estado(f);
  // aparece una celda nueva con formato de fecha en una columna de las 7 (y se refleja también en el respaldo, como si el respaldo fuera posterior)
  for (const h of ["Rentabilidad", "Rentabilidad RESPALDO T1"]) w.sheets[h].filas[8][COL("K")] = fechaDM("5.7"); fs.writeFileSync(f, JSON.stringify(w));
  const r = correr(f, ["--aplicar", `--plan=${plan}`, "--respaldo=T1", "--lote=7", "--pausa-ms=0"]); const w2 = estado(f);
  check(r.status === 1 && /Quedan 1 celda\(s\) numérica\(s\) con formato de fecha FUERA del plan/.test(r.out) && /NO se restableció el formato/.test(r.out), "se detiene antes del repeatCell: «" + (r.out.match(/Quedan [^.]*/) ?? [""])[0].slice(0, 80) + "…»");
  check(!(w2.formatoReset ?? []).length, "el repeatCell NO se ejecutó (ninguna columna se tocó)"); check(w2.sheets.Rentabilidad.filas[8][COL("K")].fmt?.type === "DATE" && w2.sheets.Rentabilidad.filas[8][COL("K")].shown === "5.7", "la celda nueva quedó intacta y se sigue viendo «5.7»");
  const p = JSON.parse(fs.readFileSync(plan, "utf8")); check(p.celdas.every((c) => w2.sheets[c.hoja].filas[c.fila - 1][COL(c.col)].u.stringValue === c.despues), "las celdas del plan sí quedaron convertidas (se puede generar un plan nuevo y terminar)"); }

console.log("\n" + ok + " comprobaciones OK");

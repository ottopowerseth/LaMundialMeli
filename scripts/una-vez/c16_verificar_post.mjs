// HERRAMIENTA DE UN SOLO USO — C-16: verificación posterior a la aplicación. SOLO LECTURA. Compara Rentabilidad (ahora) con «Rentabilidad RESPALDO <SUFIJO>» (antes) y con el plan.
// USO: node scripts/una-vez/c16_verificar_post.mjs --plan=RUTA --respaldo=SUFIJO   (código 0 si todo coincide, 1 si no)
// Comprueba: las filas del plan con J y K como TEXTO con el valor del plan y modificadas; que solo cambiaron las columnas J y K; que el resto de la hoja (valor interno, texto mostrado y
// formato de número) es idéntico al respaldo; y la tarjeta (−15.612 / −14,4 % / 89 negativas / 10 cambios de signo). Sin datos reales: lee la planilla indicada en .env.local.
import fs from "node:fs"; import path from "node:path"; import Module, { createRequire } from "node:module"; import { fileURLToPath } from "node:url";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RAIZ_API = process.env.C16_RAIZ ? path.resolve(process.env.C16_RAIZ) : REPO; // C16_RAIZ: solo para probar el script contra una API simulada (no lee .env.local)
if (!process.env.C16_RAIZ) { for (const l of fs.readFileSync(REPO + "/.env.local", "utf-8").split("\n")) { const [k, ...r] = l.split("="); if (k && r.length) process.env[k.trim()] = r.join("=").trim(); } }
process.env.NODE_PATH = [path.join(RAIZ_API, "node_modules"), path.join(REPO, "node_modules")].join(path.delimiter); Module._initPaths();
const { google } = createRequire(path.join(RAIZ_API, "package.json"))("googleapis");
const auth = new google.auth.GoogleAuth({ credentials: { client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/^"|"$/g, "") }, scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a, true]; })); if (typeof args.plan !== "string" || typeof args.respaldo !== "string" || Object.keys(args).some((k) => !["plan", "respaldo"].includes(k))) { console.error("Uso: --plan=RUTA (el plan de C-16) --respaldo=SUFIJO (pestaña «Rentabilidad RESPALDO <SUFIJO>»)."); process.exit(2); }
const PLAN_ARG = args.plan, NOMBRE = `Rentabilidad RESPALDO ${args.respaldo}`;
const sh = google.sheets({ version: "v4", auth }); const spreadsheetId = process.env.GOOGLE_SHEET_ID; const plan = JSON.parse(fs.readFileSync(PLAN_ARG, "utf8"));
const L = (i) => String.fromCharCode(65 + i); let todoOk = true; const ok = (c, t) => { if (!c) todoOk = false; console.log("   ", c ? "✓" : "✗", t); };
const meta = Object.fromEntries((await sh.spreadsheets.get({ spreadsheetId, fields: "sheets(properties(title,gridProperties))" })).data.sheets.map((s) => [s.properties.title, s.properties.gridProperties]));
const grid = async (h) => { const { data } = await sh.spreadsheets.get({ spreadsheetId, ranges: [`${h}!A1:Z${meta[h].rowCount}`], includeGridData: true, fields: "sheets(data(rowData(values(effectiveValue,formattedValue,userEnteredFormat(numberFormat)))))" }); return data.sheets[0].data[0].rowData ?? []; };
const fmt = (x) => JSON.stringify(x?.userEnteredFormat?.numberFormat ?? null); const G = await grid("Rentabilidad"), B = await grid(NOMBRE);
console.log("plan: sha256", plan.sha256.slice(0, 16), "· filas", plan.celdas.length);
ok(`${meta.Rentabilidad.rowCount}×${meta.Rentabilidad.columnCount}` === `${meta[NOMBRE].rowCount}×${meta[NOMBRE].columnCount}`, "cuadrícula sin cambios");
const filasPlan = new Map(plan.celdas.map((c) => [c.fila, c])); const enPlan = new Set(plan.celdas.flatMap((c) => [`J${c.fila}`, `K${c.fila}`]));
// 1. las 120 filas: J y K como TEXTO con el valor del plan, sin formato; y cambiaron respecto del respaldo
let bien = 0, cambiaron = 0, mal = []; for (const c of plan.celdas) { const jx = G[c.fila - 1]?.values?.[9], kx = G[c.fila - 1]?.values?.[10], jy = B[c.fila - 1]?.values?.[9], ky = B[c.fila - 1]?.values?.[10];
  const textoOk = jx?.effectiveValue?.stringValue === c.despues.J && kx?.effectiveValue?.stringValue === c.despues.K && !jx?.userEnteredFormat?.numberFormat && !kx?.userEnteredFormat?.numberFormat; if (textoOk) bien++; else mal.push(c.fila);
  if (String(jx?.formattedValue) !== String(jy?.formattedValue) || String(kx?.formattedValue) !== String(ky?.formattedValue)) cambiaron++; }
ok(bien === plan.celdas.length, `${bien}/${plan.celdas.length} filas del plan con J y K como TEXTO con el valor del plan y sin formato de número` + (mal.length ? " · fallan filas " + mal.slice(0, 8) : ""));
ok(cambiaron === plan.celdas.length, `${cambiaron}/${plan.celdas.length} filas modificadas respecto del respaldo (el texto mostrado de J o K cambió)`);
// 2. resto idéntico al respaldo: valor interno y texto mostrado de TODAS las celdas A:Z fuera de J:K de las 120 filas; formatos de TODAS las celdas fuera de esas
const filas = Math.max(G.length, B.length); const difVal = [], difMostr = [], difFmt = [], colsTocadas = new Set();
for (let f = 1; f <= filas; f++) for (let k = 0; k < 26; k++) { const x = G[f - 1]?.values?.[k] ?? null, y = B[f - 1]?.values?.[k] ?? null; const c = L(k) + f; const cambioValor = JSON.stringify(x?.effectiveValue ?? null) !== JSON.stringify(y?.effectiveValue ?? null) || String(x?.formattedValue ?? "") !== String(y?.formattedValue ?? ""); if (cambioValor) colsTocadas.add(L(k));
  if (!enPlan.has(c)) { if (JSON.stringify(x?.effectiveValue ?? null) !== JSON.stringify(y?.effectiveValue ?? null)) difVal.push(c); if (String(x?.formattedValue ?? "") !== String(y?.formattedValue ?? "")) difMostr.push(c); if (fmt(x) !== fmt(y)) difFmt.push(c); } }
ok(difVal.length === 0, `valor interno de las celdas FUERA de J:K de las ${plan.celdas.length} filas del plan: ${difVal.length} diferencias con el respaldo` + (difVal.length ? " " + JSON.stringify(difVal.slice(0, 8)) : ""));
ok(difMostr.length === 0, `texto mostrado fuera de esas celdas: ${difMostr.length} diferencias`); ok(difFmt.length === 0, `formato de número de toda la hoja fuera de esas celdas: ${difFmt.length} cambios`);
ok([...colsTocadas].sort().join("") === "JK" || (colsTocadas.size === 0 && false), `las únicas columnas con algún cambio de valor son: ${[...colsTocadas].sort().join(",") || "(ninguna)"}  (esperado: J,K)`);
const otrasFilas = []; for (let f = 1; f <= filas; f++) if (!filasPlan.has(f)) for (const k of [9, 10]) { const x = G[f - 1]?.values?.[k], y = B[f - 1]?.values?.[k]; if (JSON.stringify(x?.effectiveValue ?? null) !== JSON.stringify(y?.effectiveValue ?? null)) otrasFilas.push(L(k) + f); }
ok(otrasFilas.length === 0, `J y K de las filas que NO están en el plan (las V3 y las sin costo): ${otrasFilas.length} modificadas`);
// 3. la tarjeta, calculada como la pantalla (Rentabilidad!A2:Q, valores mostrados)
const v = (await sh.spreadsheets.values.get({ spreadsheetId, range: "Rentabilidad!A2:Q20000", valueRenderOption: "FORMATTED_VALUE" })).data.values ?? []; const num = (t) => { const s = String(t ?? "").trim(); return s === "" ? NaN : Number(s.replace(",", ".")); };
const f = v.map((r) => ({ J: num(r[9]), K: num(r[10]) })).filter((x) => Number.isFinite(x.J)); const total = Math.round(f.reduce((s, x) => s + x.J, 0) * 10) / 10, prom = Math.round((f.reduce((s, x) => s + (Number.isFinite(x.K) ? x.K : 0), 0) / f.length) * 10) / 10, neg = f.filter((x) => x.J < 0).length;
const vb = (await sh.spreadsheets.values.get({ spreadsheetId, range: `${NOMBRE}!A2:Q20000`, valueRenderOption: "FORMATTED_VALUE" })).data.values ?? []; const sg = (n) => (n > 0 ? 1 : n < 0 ? -1 : 0); let cambiaSigno = 0; for (const c of plan.celdas) { if (sg(num(vb[c.fila - 2]?.[9])) !== sg(num(v[c.fila - 2]?.[9]))) cambiaSigno++; }
console.log(`   tarjeta ahora: margen total ${Math.round(total).toLocaleString("es-CL")} · % promedio ${String(prom).replace(".", ",")} · órdenes negativas ${neg} · filas que cambiaron de signo respecto del respaldo ${cambiaSigno} · filas con margen ${f.length}`);
// cifras acordadas (planilla del 2026-10-14); C16_ESPERADO solo se admite junto con C16_RAIZ, para probar contra la API simulada
const ESP = process.env.C16_RAIZ && process.env.C16_ESPERADO ? JSON.parse(process.env.C16_ESPERADO) : { margenTotal: -15612, pctPromedio: -14.4, negativas: 89, cambianSigno: 10 };
ok(Math.round(total) === ESP.margenTotal && prom === ESP.pctPromedio && neg === ESP.negativas && cambiaSigno === ESP.cambianSigno, `la tarjeta es ${ESP.margenTotal.toLocaleString("es-CL")} / ${String(ESP.pctPromedio).replace(".", ",")} % / ${ESP.negativas} negativas / ${ESP.cambianSigno} cambios de signo`);
const lk = (await sh.spreadsheets.values.get({ spreadsheetId, range: "Locks!A2:D" })).data.values ?? []; console.log(`   Locks: ${lk.length} tickets · activos: ${lk.filter((t) => !String(t[3] ?? "").trim() && Number(t[2]) > Date.now() / 1000).length} · todos liberados: ${lk.every((t) => t[3])}`);
console.log(todoOk ? "\nRESULTADO: verificación COMPLETA sin diferencias." : "\nRESULTADO: HAY DIFERENCIAS (ver ✗)."); process.exit(todoOk ? 0 : 1);

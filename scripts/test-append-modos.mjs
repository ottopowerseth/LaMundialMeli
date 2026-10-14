// Pruebas de appendSheet y de sus llamadores (C-14): INSERT_ROWS por defecto, OVERWRITE explícito en las hojas con formatos mixtos.
// googleapis simulado; nada llama a Sheets ni a Mercado Libre.  Uso:  node scripts/test-append-modos.mjs
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
const out = fs.mkdtempSync(path.join(os.tmpdir(), "append-modos-"));
fs.writeFileSync(path.join(out, "sheets.js"), ts.transpileModule(fs.readFileSync(path.join(PROJ, "lib/sheets.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);
fs.mkdirSync(path.join(out, "node_modules", "googleapis"), { recursive: true });
fs.writeFileSync(path.join(out, "node_modules", "googleapis", "index.js"), `exports.google = { auth: { GoogleAuth: class {} }, sheets: () => ({ spreadsheets: { values: { append: async (r) => { globalThis.__appends.push(r); return {}; } } } }) };`);
const S = require(path.join(out, "sheets.js"));
let ok = 0; const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); ok++; console.log("  ✓", m); }; const check = (c, m) => { assert.ok(c, m); ok++; console.log("  ✓", m); };
process.env.GOOGLE_SHEET_ID = "hoja-falsa";

console.log("appendSheet: INSERT_ROWS por defecto, modo explícito para quien lo necesite");
{ globalThis.__appends = [];
  await S.appendSheet("Auditoría!A1", [["x"]]); await S.appendSheet("ShippingCache!A:D", [["x"]], { modo: "OVERWRITE" }); await S.appendSheet("Locks!A:D", [["x"]], { modo: "INSERT_ROWS" }); await S.appendSheet("CostoOrigen!A:J", [["x"]], {});
  eq(globalThis.__appends.map((a) => a.insertDataOption), ["INSERT_ROWS", "OVERWRITE", "INSERT_ROWS", "INSERT_ROWS"], "sin opciones → INSERT_ROWS; modo OVERWRITE explícito → OVERWRITE; opciones vacías → INSERT_ROWS");
  check(globalThis.__appends.every((a) => a.valueInputOption === "USER_ENTERED"), "el valueInputOption sigue siendo USER_ENTERED en todos (no cambia cómo se interpretan los valores; S-07 queda aparte)");
  eq(globalThis.__appends[0].requestBody.values, [["x"]], "los valores viajan igual"); }

// ---- vigilancia estática: ningún llamador de una hoja con formato mixto usa el modo por defecto ----
console.log("llamadores: las hojas con formatos mixtos (ShippingCache, Rentabilidad, TarifaEnvio) conservan OVERWRITE explícito");
const leer = (rel) => fs.readFileSync(path.join(PROJ, rel), "utf8").replace(/\r\n/g, "\n");
function llamadas(rel) { // cada llamada «appendSheet(» directa, con el texto hasta el cierre de su paréntesis
  const s = leer(rel); const res = []; let i = 0;
  while ((i = s.indexOf("appendSheet(", i)) >= 0) { const previo = s.slice(Math.max(0, i - 12), i); if (/(function |import \{ |, )$/.test(previo) && !s.slice(i, i + 60).includes("[")) { i += 12; continue; }
    let prof = 0, j = i + "appendSheet".length; for (; j < s.length; j++) { if (s[j] === "(") prof++; if (s[j] === ")") { prof--; if (prof === 0) break; } } res.push(s.slice(i, j + 1)); i = j; }
  return res; }
const MIXTAS = /ShippingCache|Rentabilidad!|\$\{hoja\}/; const RUTAS_DIRECTAS = ["app/api/ml-sync/route.ts", "app/api/backfill-shipping/route.ts", "app/api/rentabilidad/analyze/route.ts", "lib/envio-real.ts"];
for (const rel of RUTAS_DIRECTAS) { const c = llamadas(rel).filter((x) => /appendSheet\("/.test(x) || /appendSheet\(`/.test(x)); const mixtas = c.filter((x) => /ShippingCache|"Rentabilidad!/.test(x));
  if (rel === "lib/envio-real.ts") { check(!leer(rel).includes('from "@/lib/sheets"') && mixtas.length === 2, `${rel}: no importa appendSheet de lib/sheets; usa el inyectado (las rutas que lo llaman lo envuelven con OVERWRITE, verificado abajo)`); continue; }
  check(mixtas.length > 0 && mixtas.every((x) => x.includes('{ modo: "OVERWRITE" }')), `${rel}: sus ${mixtas.length} append(s) a ShippingCache/Rentabilidad pasan { modo: "OVERWRITE" }`); }
for (const rel of ["app/api/rentabilidad/recalcular-envio/route.ts", "app/api/rentabilidad/completar/route.ts"]) check(/appendSheet: \(rango, valores\) => appendSheet\(rango, valores, \{ modo: "OVERWRITE" \}\)/.test(leer(rel)), `${rel}: inyecta un appendSheet con OVERWRITE (solo agrega a ShippingCache)`);
check(/appendSheet: \(rango, valores\) => appendSheet\(rango, valores, \{ modo: "OVERWRITE" \}\)/.test(leer("app/api/tarifa-envio/route.ts")), "app/api/tarifa-envio/route.ts: inyecta un appendSheet con OVERWRITE (TarifaEnvio)");
console.log("llamadores: las hojas con formato uniforme usan el modo por defecto (INSERT_ROWS)");
{ const aud = llamadas("app/api/audit/analyze/route.ts").filter((x) => /appendSheet\("Auditoría/.test(x)); check(aud.length === 2 && aud.every((x) => !/modo/.test(x)), "Auditoría (2 appends): modo por defecto");
  const prog = llamadas("app/api/rentabilidad/analyze/route.ts").filter((x) => /RentabilidadProgreso/.test(x)); check(prog.length === 2 && prog.every((x) => !/modo/.test(x)), "RentabilidadProgreso (2 appends): modo por defecto");
  check(/appendSheet: appendSheet|readSheet, writeSheet, appendSheet, batchWriteSheet/.test(leer("app/api/costo-auto/route.ts")), "costo-auto → CostoOrigen: pasa appendSheet tal cual (modo por defecto)");
  check(!/insertarFilas/.test(leer("lib/lock-sheets.ts")) && !/insertarFilas/.test(leer("lib/sheets.ts")), "ya no queda la opción provisional insertarFilas"); }

console.log("\n" + ok + " comprobaciones OK");

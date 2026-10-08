// Pruebas de lib/mayor-en-revision.ts (sin red).
// Uso:  node scripts/test-mayor-en-revision.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ts = require(path.join(PROJ, "node_modules", "typescript"));
const out = fs.mkdtempSync(path.join(os.tmpdir(), "mayor-rev-test-"));
const js = ts.transpileModule(fs.readFileSync(`${PROJ}/lib/mayor-en-revision.ts`, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText;
fs.writeFileSync(path.join(out, "m.js"), js);
const { mayoresEnRevision } = require(path.join(out, "m.js"));
let ok = 0; const check = (c, m) => { assert.ok(c, m); ok++; console.log("  ✓", m); };

const fila = (id, origen, motivo) => [id, "SKU", origen, "1000", "1000", "sku", "COD", "Artículo", motivo ?? "", "2026-10-08T13:04:44Z"];
const m = mayoresEnRevision([
  fila("MLC1", "revisar", "costo igual al precio"),
  fila("MLC2", "auto", ""),
  fila("MLC3", "manual", ""),
  fila("MLC4", " revisar ", "costo/precio muy bajo (0.20) + título x3 vs Defontana x50 (Unidades=1)"),
  fila("MLC5", "revisar", ""),
  ["MLC6", "SKU", "revisar"], // fila corta: sin columna de motivo
  ["", "SKU", "revisar", "", "", "", "", "", "sin id"],
]);
console.log("lectura de CostoOrigen");
check(m.size === 4 && m.has("MLC1") && m.has("MLC4") && m.has("MLC5") && m.has("MLC6"), "solo las filas con origen 'revisar' (con espacios incluidos) quedan en revisión");
check(!m.has("MLC2") && !m.has("MLC3"), "auto y manual NO quedan en revisión");
check(m.get("MLC1") === "costo igual al precio" && m.get("MLC4").startsWith("costo/precio muy bajo"), "se conserva el motivo registrado");
check(m.get("MLC5") === "sin motivo registrado" && m.get("MLC6") === "sin motivo registrado", "sin motivo (celda vacía o fila corta): 'sin motivo registrado', no se rompe");
check(mayoresEnRevision([]).size === 0, "hoja vacía o inexistente: nadie queda en revisión");
console.log(`\n${ok} comprobaciones OK`);

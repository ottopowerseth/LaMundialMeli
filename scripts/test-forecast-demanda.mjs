// Pruebas de lib/forecast-demanda.ts (sin red). Uso:  node scripts/test-forecast-demanda.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ts = require(path.join(PROJ, "node_modules", "typescript"));
const out = fs.mkdtempSync(path.join(os.tmpdir(), "forecast-demanda-test-"));
fs.writeFileSync(path.join(out, "d.js"), ts.transpileModule(fs.readFileSync(`${PROJ}/lib/forecast-demanda.ts`, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText);
const D = require(path.join(out, "d.js"));
let ok = 0; const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); ok++; console.log("  ✓", m); };

const hoy = new Date(2026, 9, 14); const desde = new Date(hoy.getTime() - 30 * 86400000);
const fila = (fecha, cant, estado, item) => ["'1", fecha, "t", "sku", cant, 1000, 1000, "c", estado, item];
console.log("unidadesPorItem");
eq([...D.unidadesPorItem([fila("10-10-2026", 2, "paid", "A"), fila("11-10-2026", 3, "paid", "A")], desde)], [["A", 5]], "suma las unidades pagadas de un ítem");
eq([...D.unidadesPorItem([fila("10-10-2026", 2, "paid", "A"), fila("11-10-2026", 4, "cancelled", "A")], desde)], [["A", 2]], "excluye las órdenes canceladas");
eq([...D.unidadesPorItem([fila("11-10-2026", 4, "cancelled", "A")], desde)], [], "un ítem con solo canceladas no aparece");
eq([...D.unidadesPorItem([fila("11-10-2026", 6, "partially_refunded", "A")], desde)], [["A", 6]], "partially_refunded SÍ se cuenta (decisión de Otto)");
eq([...D.unidadesPorItem([fila("01-08-2026", 9, "paid", "A")], desde)], [], "ignora lo anterior a la ventana");
eq([...D.unidadesPorItem([fila("10-10-2026", 2, "paid", ""), fila("", 2, "paid", "A"), fila("10-10-2026", 0, "paid", "A")], desde)], [], "ignora filas sin ID Item, sin fecha o con cantidad 0");
eq([...D.unidadesPorItem([fila("10-10-2026", 2, " cancelled ", "A")], desde)], [], "tolera espacios en el estado");
eq([...D.unidadesPorItem([["'1", "10-10-2026", "t", "s", 1, 1, 1, "c"]], desde)], [], "una fila corta (sin estado ni ID Item) no rompe");
console.log("\n" + ok + " comprobaciones OK");

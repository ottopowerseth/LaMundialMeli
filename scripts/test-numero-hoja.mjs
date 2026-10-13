// Pruebas de lib/numero-hoja.ts (sin red).  Uso:  node scripts/test-numero-hoja.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ts = require(path.join(PROJ, "node_modules", "typescript"));
const out = fs.mkdtempSync(path.join(os.tmpdir(), "numero-hoja-test-"));
fs.writeFileSync(path.join(out, "n.js"), ts.transpileModule(fs.readFileSync(`${PROJ}/lib/numero-hoja.ts`, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText);
const { leerNumeroHoja: n } = require(path.join(out, "n.js"));
let ok = 0; const check = (c, m) => { assert.ok(c, m); ok++; console.log("  ✓", m); };
const igual = (v, esperado, m) => check(Object.is(n(v), esperado) || (Number.isNaN(esperado) && Number.isNaN(n(v))), `${m}: ${JSON.stringify(v)} → ${Number.isNaN(n(v)) ? "NaN" : n(v)}`);

console.log("coma decimal (número guardado como número, planilla es_ES)");
igual("14,5", 14.5, "decimal con coma"); igual("2,74", 2.74, "tasa"); igual("128,96", 128.96, "tasa > 100"); igual("-25,6", -25.6, "negativo"); igual("0,5", 0.5, "menor que 1"); igual("12,50", 12.5, "ceros a la derecha");
console.log("punto de miles + coma decimal"); igual("1.234,5", 1234.5, "miles y decimal"); igual("1.234.567,89", 1234567.89, "millones"); igual("-1.234,5", -1234.5, "negativo con miles");
console.log("texto con punto decimal (como la fila 2 de Auditoría): comportamiento de siempre"); igual("14.5", 14.5, "punto decimal"); igual("2.74", 2.74, "fila 2"); igual("12.50", 12.5, "dos decimales"); igual("-25.6", -25.6, "negativo con punto"); igual("1280.5", 1280.5, "envío por unidad");
console.log("enteros, vacíos y no numéricos"); igual("1234", 1234, "entero"); igual("0", 0, "cero"); igual("", 0, "vacío (igual que Number(\"\"); los llamadores usan «|| 0» o comparan con \"\")"); igual("   ", 0, "solo espacios"); igual(undefined, NaN, "undefined"); igual(null, 0, "null (igual que Number(null))"); igual("COGS no disponible", NaN, "texto"); igual("12,5 kg", NaN, "texto con coma"); igual("1,234,5", NaN, "comas repetidas (inválido)"); igual("1.23,4", NaN, "puntos de miles mal puestos"); igual(",5", NaN, "sin parte entera");
console.log("CASO AMBIGUO (intencional, ver el comentario de lib/numero-hoja.ts): punto sin coma = punto DECIMAL, no separador de miles");
igual("1.234", 1.234, "«1.234» se lee como 1,234 y NO como 1234"); igual("12.345", 12.345, "«12.345» se lee como 12,345"); igual("1.234.567", NaN, "varios puntos sin coma no son un número válido (NaN), no se adivinan como miles");
check(n("1.234") !== n("1.234,0") && n("1.234,0") === 1234, "…en cambio «1.234,0» (con coma) sí es 1234: la coma es la que marca el formato es_ES");
console.log("números ya numéricos"); igual(14.5, 14.5, "number"); igual(0, 0, "number 0");
console.log("compatibilidad con lo anterior: todo lo que Number() ya entendía da lo mismo");
for (const v of ["0", "1", "-3", "1234567", "0.5", "1e3", "12.50", "  7  ", ""]) check(Object.is(n(v), Number(v)), `n(${JSON.stringify(v)}) === Number(...) = ${Number(v)}`);
console.log(`\n${ok} comprobaciones OK`);

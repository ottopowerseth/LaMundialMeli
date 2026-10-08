// Pruebas de lib/sync-estado.ts (sin red).  Uso:  node scripts/test-sync-estado.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ts = require(path.join(PROJ, "node_modules", "typescript"));
const out = fs.mkdtempSync(path.join(os.tmpdir(), "sync-estado-test-"));
fs.writeFileSync(path.join(out, "s.js"), ts.transpileModule(fs.readFileSync(`${PROJ}/lib/sync-estado.ts`, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText);
const { errorPublicaciones, abortoSinBorrar } = require(path.join(out, "s.js"));
let ok = 0; const check = (c, m) => { assert.ok(c, m); ok++; console.log("  ✓", m); };

check(errorPublicaciones({ ok: true, publicaciones: 620, ventas: 2050, erroresSync: [] }) === null, "corrida normal → sin banner");
check(errorPublicaciones({ ok: true, publicaciones: 620 }) === null, "corrida normal sin erroresSync → sin banner");
check(errorPublicaciones({ ok: true, publicaciones: 620, erroresSync: ["Ventas: Error: HTTP 500"] }) === null, "error solo de Ventas → sin banner (como hoy)");
const msg = "Publicaciones: Error: No se pudo leer la hoja Publicaciones anterior (cuota). Se aborta el sync.";
check(errorPublicaciones({ ok: true, publicaciones: null, erroresSync: [msg] })?.startsWith("No se pudo leer la hoja Publicaciones anterior"), "Publicaciones aborta → banner con el detalle, sin el prefijo técnico");
check(errorPublicaciones({ ok: true, publicaciones: null, erroresSync: [] }) !== null, "publicaciones null sin detalle → banner igual");
check(errorPublicaciones({ ok: true, publicaciones: 620, erroresSync: [msg] }) !== null, "erroresSync de Publicaciones aunque venga un número → banner");
check(errorPublicaciones({ ok: false, publicaciones: null, erroresSync: [msg, "Ventas: Error: x"] }) !== null, "fallan ambos (ok:false) → banner");
check(errorPublicaciones({ ok: false }) === null, "error de red / de ruta (sin publicaciones ni erroresSync) → sin banner, lo muestra el error de siempre");
console.log(`\n${ok} comprobaciones OK`);

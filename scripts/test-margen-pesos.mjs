// Pruebas del margen en pesos de lib/tablero-margen.ts (sin red, con montos conocidos).
// Uso:  node scripts/test-margen-pesos.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ts = require(path.join(PROJ, "node_modules", "typescript"));
const out = fs.mkdtempSync(path.join(os.tmpdir(), "margen-pesos-test-"));
for (const f of fs.readdirSync(`${PROJ}/lib`).filter((x) => x.endsWith(".ts") && ["tablero-margen.ts", "rentabilidad.ts", "envio-medido.ts", "envio-estimado.ts"].includes(x))) {
  const js = ts.transpileModule(fs.readFileSync(`${PROJ}/lib/${f}`, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText.replace(/require\("@\/lib\/([a-z-]+)"\)/g, 'require("./$1.js")');
  fs.writeFileSync(path.join(out, f.replace(/\.ts$/, ".js")), js);
}
const { analizarMargen } = require(path.join(out, "tablero-margen.js"));
const { armarContextoEnvio } = require(path.join(out, "envio-medido.js"));
let ok = 0; const check = (c, m) => { assert.ok(c, m); ok++; console.log("  ✓", m); };

// Montos brutos (con IVA) como los de ML. margen neto por unidad = (precio − costo − comisión − envío) / 1,19.
const linea = (item, cantidad, precio, fee) => ({ orden: "O" + item, ms: 0, item, titulo: item, cantidad, precio, fee });
const tarifas = new Map([["A", { tarifa: 1190, estado: "ok", sku: "", tipo: "xd_drop_off" }], ["H", { tarifa: 1019.9, estado: "ok", sku: "", tipo: "xd_drop_off" }],
  ["N", { tarifa: 1190, estado: "ok", sku: "", tipo: "xd_drop_off" }], ["F", { tarifa: 800, estado: "ok", sku: "", tipo: "fulfillment" }], ["E", { tarifa: 900, estado: "estimado", sku: "", tipo: "xd_drop_off" }]]);
const ctx = armarContextoEnvio(tarifas, new Map(), new Map(), new Map());
const lineas = [
  linea("A", 3, 11900, 1666), // fee 14%
  linea("H", 2, 12350, 1605.5), // Hot Vainilla: Mayor 9.250 tratado como CON IVA (supuesto pendiente de confirmar), comisión 13%
  linea("N", 2, 6000, 840), // pierde: 6000 − 5950 − 840 − 1190 < 0
  linea("S", 5, 5000, 700), // sin Costo
  linea("F", 1, 10000, 1300), // Full
  linea("E", 1, 10000, 1300), // envío estimado
];
const costos = new Map([["A", 5950], ["H", 9250], ["N", 5950], ["S", null], ["F", 5000], ["E", 5000]]);
const full = new Map([["F", true]]);
const { filas, resumen } = analizarMargen({ lineas, costoPorItem: costos, fullPorItem: full, skuPorItem: new Map(), ctxEnvio: ctx });
const f = (id) => filas.find((x) => x.id === id);

console.log("margen en pesos por publicación");
check(f("A").margenPesos === 7800 && f("A").margenPct === 26, "A: (11.900 − 5.950 − 1.666 − 1.190) / 1,19 = $2.600 por unidad × 3 = $7.800 (26%)");
const h = f("H"); check(Math.abs(h.margenPesos - 798) <= 1 && h.margenPct === 3.8, "Hot Vainilla con Mayor $9.250 supuesto CON IVA: $399 por unidad × 2 ≈ $798 (3,8%, el mismo del Tablero real)");
check(f("N").pierde && f("N").margenPesos < 0, "una publicación que pierde tiene margen en pesos negativo");
check(f("S").margenPesos === null && f("S").margenPct === null && f("S").estado === "sin_costo", "sin Costo: no hay margen en pesos (no se asume 0)");
check(filas.every((x) => (x.margenPct === null) === (x.margenPesos === null)), "margenPesos es null exactamente cuando margenPct es null");
for (const x of filas.filter((y) => y.margenPesos !== null)) {
  const ingNeto = (x.precioProm / 1.19) * x.unidades;
  check(Math.abs((x.margenPesos / ingNeto) * 100 - x.margenPct) <= 0.1, `${x.id}: margenPesos / ingreso neto coincide con margenPct`);
}

console.log("subtotales");
const conMargen = filas.filter((x) => x.margenPesos !== null);
const suma = conMargen.reduce((s, x) => s + x.margenPesos, 0);
check(Math.abs(resumen.total.margenPesos - suma) <= conMargen.length, "total.margenPesos = suma de los márgenes de las publicaciones con margen (±1 por redondeo de cada una)");
check(resumen.total.publicaciones === conMargen.length, "el total solo cuenta publicaciones con margen (la sin Costo no entra)");
check(Math.abs(resumen.porTipo.full.margenPesos + resumen.porTipo.estandar.margenPesos - resumen.total.margenPesos) <= 1, "Full + estándar = total");
check(resumen.porTipo.full.margenPesos === f("F").margenPesos, "Full contiene solo la publicación Full");
check(f("E").menosFiable && f("E").margenPesos !== null, "con envío estimado el margen en pesos se calcula y la fila sigue marcada menos fiable");
const vacio = analizarMargen({ lineas: [], costoPorItem: new Map(), fullPorItem: new Map(), skuPorItem: new Map(), ctxEnvio: ctx });
check(vacio.resumen.total.margenPesos === 0 && vacio.resumen.total.margenPct === null, "sin ventas: total en pesos = 0 y % = null");
console.log(`\n${ok} comprobaciones OK`);

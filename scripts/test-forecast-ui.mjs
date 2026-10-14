// Prueba de render de app/ForecastPorModo.tsx (react-dom/server, datos fijos, sin red ni navegador).
// Uso:  node scripts/test-forecast-ui.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ts = require(path.join(PROJ, "node_modules", "typescript"));
const out = fs.mkdtempSync(path.join(os.tmpdir(), "forecast-ui-test-"));
for (const f of ["forecast", "forecast-demanda"]) fs.writeFileSync(path.join(out, f + ".js"), ts.transpileModule(fs.readFileSync(path.join(PROJ, "lib", f + ".ts"), "utf8").replace(/from "@\/lib\/([\w-]+)"/g, 'from "./$1"'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);
fs.writeFileSync(path.join(out, "ForecastPorModo.js"), ts.transpileModule(fs.readFileSync(path.join(PROJ, "app", "ForecastPorModo.tsx"), "utf8").replace(/from "@\/lib\/([\w-]+)"/g, 'from "./$1"'),{ compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText);
process.env.NODE_PATH = path.join(PROJ, "node_modules"); (await import("node:module")).default._initPaths();
const React = require(path.join(PROJ, "node_modules", "react")); const { renderToStaticMarkup } = require(path.join(PROJ, "node_modules", "react-dom", "server"));
const Forecast = require(path.join(out, "ForecastPorModo.js")).default;
let ok = 0; const check = (c, m) => { assert.ok(c, m); ok++; console.log("  ✓", m); };

const fila = (o) => ({ id: "X", titulo: "Producto", stockActual: 10, ventas30d: 30, velocidadDiaria: 1, diasRestantes: 10, fechaQuiebre: "24-10-2026", cantidadSugerida: 12, prioridad: "URGENTE", estadoML: "active", modo: "full", fuenteModo: "publicacion", tipoLogistico: "fulfillment", leadTimeDays: 15, safetyDays: 7, ventasFull30d: 30, ventasNormal30d: 0, ventasSinTipo30d: 0, migro: false, ...o });
const rows = [
  fila({ id: "F1", titulo: "Serum Full", cantidadSugerida: 12 }),
  fila({ id: "F2", titulo: "Crema Migrada", migro: true, ventasFull30d: 3, ventasNormal30d: 7, ventasSinTipo30d: 3, prioridad: "SIN_STOCK", stockActual: 0 }),
  fila({ id: "N1", titulo: "Shampoo Normal", modo: "normal", tipoLogistico: "xd_drop_off", ventasFull30d: 0, ventasNormal30d: 30, prioridad: "PRONTO" }),
  fila({ id: "S1", titulo: "Sin T", modo: "sin_clasificar", fuenteModo: "ninguna", tipoLogistico: "", ventasFull30d: 0, ventasNormal30d: 0, ventasSinTipo30d: 30, prioridad: "OK", cantidadSugerida: 0 }),
  fila({ id: "N3", titulo: "Tipo no especificado", modo: "normal", tipoLogistico: "not_specified", ventasFull30d: 0, ventasNormal30d: 30, prioridad: "OK", cantidadSugerida: 0 }),
  fila({ id: "N2", titulo: "Por ultima venta", modo: "normal", fuenteModo: "ultima_venta", tipoLogistico: "", prioridad: "OK", cantidadSugerida: 0 }),
];
const pri = (x) => ({ SIN_STOCK: 0, URGENTE: 0, PRONTO: 0, OK: 0, SIN_DATOS: 0, ...x });
const resumen = {
  porModo: { full: { publicaciones: 2, stockUnidades: 10, ventas30d: 60, sugeridoTotal: 24, porPrioridad: pri({ URGENTE: 1, SIN_STOCK: 1 }) }, normal: { publicaciones: 2, stockUnidades: 20, ventas30d: 60, sugeridoTotal: 12, porPrioridad: pri({ PRONTO: 1, OK: 1 }) }, sin_clasificar: { publicaciones: 1, stockUnidades: 10, ventas30d: 30, sugeridoTotal: 0, porPrioridad: pri({ OK: 1 }) } },
  sinClasificar: 1, porFuente: { publicacion: 4, ultima_venta: 1, ninguna: 1 }, tipoPocoClaro: [{ id: "N3", titulo: "Tipo no especificado", tipo: "not_specified" }],
  skusEnAmbosModos: [{ sku: "COD-9", full: ["F1"], normal: ["N1"] }], migraron: [{ id: "F2", titulo: "Crema Migrada", modo: "full", full: 3, normal: 7, sinTipo: 3 }],
};
const datos = { ok: true, parametros: { full: { lead: 15, safety: 7 }, normal: { lead: 15, safety: 7 } }, rows, resumen, notasDiferenciaTablero: ["Velocidad: ejemplo de nota."], avisoTope: undefined };
const html = (pestana) => renderToStaticMarkup(React.createElement(Forecast, { resultadoInicial: datos, pestanaInicial: pestana }));

console.log("parámetros visibles y por modo");
{ const h = html("full");
  check(["Full: tiempo de reposición (días)", "Full: margen de seguridad (días)", "Normal: tiempo de reposición (días)", "Normal: margen de seguridad (días)"].every((t) => h.includes(t)), "los cuatro campos (lead y seguridad de Full y de Normal) están en pantalla");
  check((h.match(/value="15"/g) ?? []).length === 2 && (h.match(/value="7"/g) ?? []).length === 2, "valores por defecto 15 y 7 en cada modo");
  check(h.includes("Valores por defecto: 15 y 7 días"), "se indica el valor por defecto"); }
console.log("pestaña Full");
{ const h = html("full");
  check(h.includes("objetivo 22 días (Tablero: 30)"), "dice explícitamente «objetivo 22 días (Tablero: 30)»");
  check(h.includes("Serum Full") && h.includes("Crema Migrada") && !h.includes("Shampoo Normal") && !h.includes("Sin T"), "lista solo las publicaciones Full");
  check(h.includes("migró · Full 3 · Normal 7 · sin tipo 3"), "marca «migró» con el desglose por modo");
  check(h.includes("Stock Full") && !h.includes("En transferencia</th>"), "la columna es «Stock Full» y no hay columna «En transferencia» (omitida: requiere llamadas nuevas a ML)");
  check(h.includes("Full (2)") && h.includes("Normal (3)") && h.includes("Sin clasificar (1)") && h.includes(">Resumen<"), "las cuatro pestañas con su conteo"); }
console.log("pestañas Normal y Sin clasificar");
{ const n = html("normal"); check(n.includes("Shampoo Normal") && n.includes("Por ultima venta") && !n.includes("Serum Full"), "Normal lista solo las Normal");
  check(n.includes("Tipo no especificado") && n.includes("tipo: not_specified · se trata como Normal") && !n.includes("tipo: xd_drop_off"), "una publicación Normal con not_specified lleva una nota visible; las xd_drop_off no"); check(n.includes("modo por última venta"), "marca las que se clasificaron por la última venta (T vacía)");
  const s = html("sin_clasificar"); check(s.includes("Sin T") && !s.includes("Serum Full"), "Sin clasificar lista solo esas"); check(s.includes("columna T vacía") && s.includes("plazos de Normal"), "explica qué significa y qué plazos usa"); }
console.log("pestaña inactiva");
check(renderToStaticMarkup(React.createElement(Forecast, { activo: false, resultadoInicial: datos })) === "", "con activo=false el componente no pinta nada (la pestaña no está a la vista)");
console.log("pestaña Resumen");
{ const r = html("resumen");
  check(r.includes("Sin clasificar:</b> 1 publicaciones") || r.includes("1 publicaciones"), "cuenta de publicaciones Sin clasificar");
  check(r.includes("COD-9") && r.includes("SKU en Full y en Normal (1)"), "SKU en ambos modos");
  check(r.includes("Normal por un tipo logístico poco claro (1)") && r.includes("not_specified"), "el Resumen lista las publicaciones con tipo poco claro");
  check(r.includes("Publicaciones que migraron de modo (1)") && r.includes("Crema Migrada") && r.includes("Full 3 · Normal 7 · sin tipo 3"), "publicaciones «migró» con desglose por modo");
  check(r.includes("Diferencias con el panel «Reposición Full» del Tablero") && r.includes("Velocidad: ejemplo de nota."), "diferencias con el Tablero documentadas");
  check(r.includes("15 + 7 = 22 d (Tablero: 30)"), "el plazo de Full se muestra con la comparación con el Tablero"); }
console.log("archivo XLSX generado y leído de vuelta");
{ const XLSX = require(path.join(PROJ, "node_modules", "xlsx")); const F = require(path.join(out, "forecast.js"));
  const hojas = F.hojasPedido({ rows: datos.rows, resumen: datos.resumen, parametros: datos.parametros, notas: datos.notasDiferenciaTablero, generado: "ahora" });
  const archivo = path.join(out, "pedido.xlsx"); XLSX.writeFile(F.libroDesdeHojas(XLSX, hojas), archivo); const libro = XLSX.readFile(archivo, { cellStyles: true });
  check(fs.statSync(archivo).size > 1000 && JSON.stringify(libro.SheetNames) === JSON.stringify(["Full", "Normal", "Sin clasificar", "Resumen"]), "el archivo existe y trae las hojas Full, Normal, Sin clasificar y Resumen, en ese orden");
  const leer = (n) => XLSX.utils.sheet_to_json(libro.Sheets[n], { header: 1, defval: "" });
  const full = leer("Full"), normal = leer("Normal"), sin = leer("Sin clasificar"), res = leer("Resumen");
  check(full[0].length === 11 && full[0][10] === "NOTA" && full.slice(1).every((f) => f.length === 11), "Full: encabezado de 11 columnas (incluye NOTA) y todas las filas del mismo ancho");
  check(full.slice(1).map((f) => f[0]).join("|") === "Serum Full|Crema Migrada" && full[2][9] === "Full 3 · Normal 7 · sin tipo 3", "Full: solo lo que hay que pedir de Full, con el desglose de la que migró");
  check(normal.length === 2 && normal[1][0] === "Shampoo Normal" && normal[1][6] === 12 && normal[1][8] === 22, "Normal: solo lo que hay que pedir (Shampoo, 12 u., plazo 22 d); las OK quedan fuera");
  check(sin.length === 1, "Sin clasificar: solo encabezado (su única publicación no necesita pedido)");
  const texto = res.map((f) => f.join(" | ")).join("\n"); check(/Full \| 15 \+ 7 = 22 días \(Tablero: 30\)/.test(texto) && /Por modo \| Publicaciones/.test(texto) && /COD-9/.test(texto) && /Crema Migrada/.test(texto) && /Tipo no especificado \(N3\) \| not_specified/.test(texto) && /Velocidad: ejemplo de nota\./.test(texto), "Resumen: plazos, totales por modo, SKU en ambos modos, migraron, tipo poco claro y diferencias con el Tablero");
  check(libro.Sheets.Full["!cols"].length === 11 && libro.Sheets.Full["!cols"].every((c) => c.wch >= 10 && c.wch <= 45), "anchos de columna dentro de los límites"); }
console.log("\n" + ok + " comprobaciones OK");

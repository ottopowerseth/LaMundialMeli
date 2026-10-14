// Pruebas de reemplazarHoja (lib/sheets.ts, S-08 / C-07): escribe primero y limpia el sobrante después. La hoja es un arreglo en memoria
// y googleapis está simulado; nada llama a Sheets ni a Mercado Libre.  Uso:  node scripts/test-reemplazar-hoja.mjs
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
const out = fs.mkdtempSync(path.join(os.tmpdir(), "reemplazar-hoja-"));
fs.writeFileSync(path.join(out, "sheets.js"), ts.transpileModule(fs.readFileSync(path.join(PROJ, "lib/sheets.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);

// googleapis simulado: hojas en memoria (matriz de valores) + registro de llamadas + fallas inyectables por operación.
fs.mkdirSync(path.join(out, "node_modules", "googleapis"), { recursive: true });
fs.writeFileSync(path.join(out, "node_modules", "googleapis", "index.js"), `
const col = (L) => L.split("").reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0) - 1;
const rango = (ref) => { const m = ref.match(/^([A-Z]+)(\\d+)?(?::([A-Z]+)(\\d+)?)?$/); return { c1: col(m[1]), r1: m[2] ? +m[2] - 1 : 0, c2: m[3] ? col(m[3]) : col(m[1]), r2: m[4] ? +m[4] - 1 : 99999 }; };
const nombreYRef = (r) => { const i = r.lastIndexOf("!"); return [r.slice(0, i), r.slice(i + 1)]; };
const paso = (op) => { globalThis.__log.push(op); globalThis.__vista.push(JSON.stringify(globalThis.__hojas)); if (globalThis.__falla === op) { const e = new Error("falla simulada en " + op); e.code = 400; throw e; } };
exports.google = { auth: { GoogleAuth: class {} }, sheets: () => ({ spreadsheets: {
  get: async () => ({ data: { sheets: Object.keys(globalThis.__hojas).map((t, i) => ({ properties: { title: t, sheetId: i + 1, gridProperties: { rowCount: globalThis.__grid[t] ?? 1000 } } })) } }),
  batchUpdate: async (r) => { paso("formato"); const nombres = Object.keys(globalThis.__hojas); for (const q of r.requestBody.requests) { const rg = q.repeatCell.range; const t = nombres[rg.sheetId - 1]; globalThis.__formatos.push({ hoja: t, fin: rg.endRowIndex }); for (const i of [...globalThis.__sucio[t]]) if (i >= rg.startRowIndex && i < rg.endRowIndex) globalThis.__sucio[t].delete(i); } return {}; },
  values: {
    clear: async () => { paso("clear"); },
    update: async (r) => { paso("escribir"); globalThis.__opciones.push(r.valueInputOption); const [h, ref] = nombreYRef(r.range); const { c1, r1 } = rango(ref); const hoja = globalThis.__hojas[h]; globalThis.__grid[h] = Math.max(globalThis.__grid[h] ?? 1000, r1 + r.requestBody.values.length);
      r.requestBody.values.forEach((fila, i) => fila.forEach((v, j) => { (hoja[r1 + i] ??= [])[c1 + j] = v; })); },
    batchClear: async (r) => { paso("limpiar"); for (const rg of r.requestBody.ranges) { const [h, ref] = nombreYRef(rg); const { c1, r1, c2, r2 } = rango(ref); const hoja = globalThis.__hojas[h];
      for (let i = r1; i <= Math.min(r2, hoja.length - 1); i++) for (let j = c1; j <= c2; j++) if (hoja[i] && j < hoja[i].length) hoja[i][j] = undefined; } },
  } } }) };`);
const S = require(path.join(out, "sheets.js"));
let ok = 0; const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); ok++; console.log("  ✓", m); };
const check = (c, m) => { assert.ok(c, m); ok++; console.log("  ✓", m); };

// Lo que "ve" un lector: filas sin celdas vacías al final y sin filas vacías al final.
const leer = (nombre) => { const h = (globalThis.__hojas[nombre] ?? []).map((f) => { const s = [...(f ?? [])].map((v) => (v === undefined ? "" : v)); while (s.length && s.at(-1) === "") s.pop(); return s; }); while (h.length && h.at(-1).length === 0) h.pop(); return h; };
const nuevo = (hojas, falla = null) => { globalThis.__hojas = JSON.parse(JSON.stringify(hojas)); globalThis.__log = []; globalThis.__vista = []; globalThis.__falla = falla; globalThis.__grid = {}; globalThis.__sucio = Object.fromEntries(Object.keys(hojas).map((t) => [t, new Set()])); globalThis.__formatos = []; globalThis.__opciones = []; process.env.GOOGLE_SHEET_ID = "hoja-falsa"; };
const tabla = (filas, cols) => Array.from({ length: filas }, (_, i) => Array.from({ length: cols }, (_, j) => (i === 0 ? `H${j}` : `r${i}c${j}`)));
const nuncaVacia = (nombre) => globalThis.__vista.every((v) => (JSON.parse(v)[nombre] ?? []).some((f) => (f ?? []).some((x) => x !== null && x !== undefined && x !== "")));

console.log("tabla nueva MÁS LARGA que la anterior");
{ nuevo({ Publicaciones: tabla(3, 5) }); const nueva = tabla(7, 5);
  const r = await S.reemplazarHoja("Publicaciones", nueva);
  eq(leer("Publicaciones"), nueva, "la hoja queda exactamente igual a la tabla nueva");
  eq(r, { sobranteLimpio: true }, "sobranteLimpio = true");
  eq(globalThis.__log, ["formato", "escribir", "limpiar"], "orden: reset de formato → escribir sobre A1 → limpiar sobrante (no hay clear total)");
  check(nuncaVacia("Publicaciones"), "en ningún paso la hoja estuvo vacía"); }

console.log("tabla nueva MÁS CORTA que la anterior (sobran filas y columnas)");
{ nuevo({ Publicaciones: tabla(9, 7) }); const nueva = tabla(4, 5);
  const r = await S.reemplazarHoja("Publicaciones", nueva);
  eq(leer("Publicaciones"), nueva, "no quedan filas ni columnas viejas");
  eq(r.sobranteLimpio, true, "sobranteLimpio = true");
  check(nuncaVacia("Publicaciones"), "en ningún paso la hoja estuvo vacía"); }

console.log("celdas vacías de la tabla nueva pisan los valores viejos");
{ const vieja = tabla(3, 3); nuevo({ Publicaciones: vieja }); const nueva = [["A", "B", "C"], ["x", "", "z"], ["x2", "y2", ""]];
  await S.reemplazarHoja("Publicaciones", nueva);
  eq(leer("Publicaciones"), [["A", "B", "C"], ["x", "", "z"], ["x2", "y2"]], "Costo vacío en la tabla nueva no deja el valor viejo (supuesto: la API trata \"\" como celda vacía; se confirma en la copia de la pestaña)"); }

console.log("falla en el reset de formato → no se tocó nada");
{ nuevo({ Publicaciones: tabla(5, 4) }, "formato"); const antes = leer("Publicaciones");
  await assert.rejects(() => S.reemplazarHoja("Publicaciones", tabla(2, 4))); ok++; console.log("  ✓ lanza el error");
  eq(leer("Publicaciones"), antes, "la hoja anterior quedó intacta");
  eq(globalThis.__log, ["formato"], "no llegó a escribir ni a limpiar"); }

console.log("falla al escribir → hoja anterior intacta, nunca vacía");
{ nuevo({ Publicaciones: tabla(5, 4) }, "escribir"); const antes = leer("Publicaciones");
  await assert.rejects(() => S.reemplazarHoja("Publicaciones", tabla(2, 4))); ok++; console.log("  ✓ lanza el error");
  eq(leer("Publicaciones"), antes, "la hoja anterior quedó intacta");
  check(!globalThis.__log.includes("limpiar"), "no se limpió nada");
  check(nuncaVacia("Publicaciones"), "en ningún paso la hoja estuvo vacía"); }

console.log("falla al limpiar el sobrante (después de escribir) → tabla nueva escrita, avisa, y el siguiente reemplazo lo limpia");
{ const nueva = tabla(3, 4); nuevo({ Publicaciones: tabla(6, 4) }, "limpiar");
  const r = await S.reemplazarHoja("Publicaciones", nueva);
  eq(r.sobranteLimpio, false, "no lanza; devuelve sobranteLimpio = false"); check(/falla simulada/.test(r.errorSobrante), "con el motivo del error");
  eq(leer("Publicaciones").slice(0, 3), nueva, "la tabla nueva está completa en las primeras filas");
  eq(leer("Publicaciones").length, 6, "las filas viejas siguen debajo (estado intermedio documentado)");
  globalThis.__falla = null; const r2 = await S.reemplazarHoja("Publicaciones", nueva);
  eq([r2.sobranteLimpio, leer("Publicaciones")], [true, nueva], "el reemplazo siguiente deja la hoja limpia (se autocorrige)"); }

console.log("tabla de una sola fila (solo encabezados) y hoja con nombre con espacios");
{ nuevo({ "Lista Defontana": tabla(4, 3) }); const nueva = [["a", "b", "c"]];
  await S.reemplazarHoja("Lista Defontana", nueva); eq(leer("Lista Defontana"), nueva, "solo queda el encabezado"); }

console.log("tabla vacía → se rechaza antes de tocar la hoja");
{ nuevo({ Publicaciones: tabla(4, 3) }); const antes = leer("Publicaciones");
  await assert.rejects(() => S.reemplazarHoja("Publicaciones", [])); ok++; console.log("  ✓ lanza");
  eq([globalThis.__log, leer("Publicaciones")], [[], antes], "sin llamadas y con la hoja intacta"); }

console.log("formato: se limpia TODA la hoja, no solo las primeras 2000 filas");
{ const vieja = tabla(2600, 4); nuevo({ Ventas: vieja }); globalThis.__grid.Ventas = 3000; for (let i = 0; i < 3000; i++) globalThis.__sucio.Ventas.add(i);
  const nueva = tabla(2400, 4); await S.reemplazarHoja("Ventas", nueva);
  eq(globalThis.__formatos, [{ hoja: "Ventas", fin: 3000 }], "el reset cubre las 3000 filas de la cuadrícula (tabla nueva + sobrante), no 2000");
  eq(globalThis.__sucio.Ventas.size, 0, "las 3000 filas quedan sin formato (incluidas las > 2000 y el sobrante)"); }
{ nuevo({ Ventas: tabla(100, 4) }); globalThis.__grid.Ventas = 1000; for (let i = 0; i < 1000; i++) globalThis.__sucio.Ventas.add(i);
  await S.reemplazarHoja("Ventas", tabla(2500, 4));
  eq([globalThis.__sucio.Ventas.size, globalThis.__grid.Ventas], [0, 2500], "tabla más larga que la cuadrícula: la cuadrícula crece y todo queda sin formato"); }

console.log("valueInputOption: se escribe igual que writeSheet (USER_ENTERED)");
{ nuevo({ Publicaciones: tabla(3, 3) }); await S.reemplazarHoja("Publicaciones", [["a", "b", "=A1&B1"], ["4989.6", "x", ""]]);
  eq(globalThis.__opciones, ["USER_ENTERED"], "una sola escritura, con USER_ENTERED"); }

console.log("alcance de la limpieza: A:Z como clearSheet; nada más allá de Z");
{ const colAA = 26; const vieja = tabla(6, 26).map((f, i) => { const g = [...f]; g[colAA] = "manual-AA" + i; return g; }); nuevo({ Publicaciones: vieja });
  await S.reemplazarHoja("Publicaciones", tabla(3, 19));
  const h = globalThis.__hojas.Publicaciones; const enAZ = h.some((f) => (f ?? []).slice(19, 26).some((v) => v !== undefined && v !== ""));
  const nueva = tabla(3, 19);
  check(h.slice(0, 3).every((f, i) => f.slice(0, 19).every((v, j) => v === nueva[i][j])), "la tabla nueva está completa");
  check(!enAZ && h.slice(3).every((f) => (f ?? []).slice(0, 26).every((v) => v === undefined || v === "")), "A:Z fuera de la tabla nueva quedó vacío (columnas T:Z y filas sobrantes), igual que con clearSheet");
  eq(h.map((f) => f[colAA]), vieja.map((f) => f[colAA]), "la columna AA (fuera de A:Z) no se tocó, igual que antes"); }
{ nuevo({ Publicaciones: tabla(4, 5) }); await S.reemplazarHoja("Publicaciones", [["a", "b", "c"], ["x"], ["y", "z"]]);
  eq(leer("Publicaciones"), [["a", "b", "c"], ["x"], ["y", "z"]], "filas más cortas que el ancho: no quedan valores viejos en las celdas que la fila nueva no trae"); }

console.log("ml-sync ya no usa clearSheet ni el tope A2:S1000");
{ const src = fs.readFileSync(path.join(PROJ, "app/api/ml-sync/route.ts"), "utf8");
  check(!/clearSheet/.test(src), "no queda ninguna llamada a clearSheet en ml-sync");
  check(!/A2:S1000/.test(src), "la lectura previa de Publicaciones no tiene tope de 1000");
  check(/reemplazarHoja\("Publicaciones"/.test(src) && /reemplazarHoja\("Ventas"/.test(src), "Publicaciones y Ventas usan reemplazarHoja"); }

console.log(`\n${ok} comprobaciones OK`);

// Pruebas de S-08 / S-06 (commit 4): lista-defontana/importar y lista-defontana/equivalencias escriben primero y limpian el sobrante después,
// y equivalencias valida TODO antes de tocar la hoja. Hojas en memoria y googleapis simulado; nada llama a Sheets ni a ML.
// Uso:  node scripts/test-lista-defontana.mjs
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
const XLSX = require(path.join(PROJ, "node_modules", "xlsx"));
const out = fs.mkdtempSync(path.join(os.tmpdir(), "lista-defontana-"));
const compilar = (origen, destino) => {
  const src = fs.readFileSync(path.join(PROJ, origen), "utf8").replace(/from "@\/lib\/([\w-]+)"/g, 'from "./$1"');
  fs.writeFileSync(path.join(out, destino), ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);
};
for (const [o, d] of [["lib/log.ts", "log.js"], ["lib/sheets.ts", "sheets.js"], ["lib/defontana.ts", "defontana.js"], ["app/api/lista-defontana/importar/route.ts", "importar.js"], ["app/api/lista-defontana/equivalencias/route.ts", "equivalencias.js"]]) compilar(o, d);

fs.mkdirSync(path.join(out, "node_modules", "googleapis"), { recursive: true });
fs.writeFileSync(path.join(out, "node_modules", "googleapis", "index.js"), `
const col = (L) => L.split("").reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0) - 1;
const rango = (ref) => { const m = ref.match(/^([A-Z]+)(\\d+)?(?::([A-Z]+)(\\d+)?)?$/); return { c1: col(m[1]), r1: m[2] ? +m[2] - 1 : 0, c2: m[3] ? col(m[3]) : col(m[1]), r2: m[4] ? +m[4] - 1 : 99999 }; };
const nombreYRef = (r) => { const i = r.lastIndexOf("!"); return [r.slice(0, i), r.slice(i + 1)]; };
const paso = (op) => { globalThis.__log.push(op); if (globalThis.__falla === op) { const e = new Error("falla simulada en " + op); e.code = 400; throw e; } };
exports.google = { auth: { GoogleAuth: class {} }, sheets: () => ({ spreadsheets: {
  get: async () => ({ data: { sheets: Object.keys(globalThis.__hojas).map((t, i) => ({ properties: { title: t, sheetId: i + 1, gridProperties: { rowCount: 1000 } } })) } }),
  batchUpdate: async (r) => { for (const q of r.requestBody.requests) { if (q.addSheet) { globalThis.__hojas[q.addSheet.properties.title] = []; globalThis.__log.push("crear-hoja"); } else paso("formato"); } return {}; },
  values: {
    clear: async () => { paso("clear-total"); },
    update: async (r) => { paso("escribir"); const [h, ref] = nombreYRef(r.range); const { c1, r1 } = rango(ref); const hoja = globalThis.__hojas[h];
      r.requestBody.values.forEach((fila, i) => fila.forEach((v, j) => { (hoja[r1 + i] ??= [])[c1 + j] = v; })); },
    batchClear: async (r) => { paso("limpiar"); for (const rg of r.requestBody.ranges) { const [h, ref] = nombreYRef(rg); const { c1, r1, c2, r2 } = rango(ref); const hoja = globalThis.__hojas[h];
      for (let i = r1; i <= Math.min(r2, hoja.length - 1); i++) for (let j = c1; j <= c2; j++) if (hoja[i] && j < hoja[i].length) hoja[i][j] = undefined; } },
  } } }) };`);
const importar = require(path.join(out, "importar.js")); const equiv = require(path.join(out, "equivalencias.js"));
let ok = 0; const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); ok++; console.log("  ✓", m); };
const check = (c, m) => { assert.ok(c, m); ok++; console.log("  ✓", m); };

const leer = (nombre) => { const h = (globalThis.__hojas[nombre] ?? []).map((f) => { const s = [...(f ?? [])].map((v) => (v === undefined ? "" : v)); while (s.length && s.at(-1) === "") s.pop(); return s; }); while (h.length && h.at(-1).length === 0) h.pop(); return h; };
const nuevo = (hojas, falla = null) => { globalThis.__hojas = JSON.parse(JSON.stringify(hojas)); globalThis.__log = []; globalThis.__falla = falla; process.env.GOOGLE_SHEET_ID = "hoja-falsa"; };
const silencio = async (fn) => { const e = console.error, w = console.warn; console.error = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.error = e; console.warn = w; } };
const llamar = async (handler, req) => { const res = await silencio(() => handler(req)); return { status: res.status, j: await res.json() }; };
const jsonReq = (body) => new Request("http://x", { method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const xlsxReq = (filas, nombreHoja = "PRECIOS") => {
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["PROVEEDOR", "MARCA", "FAMILIA", "cod", "barras", "articulo", "MAYOR"], ...filas]), nombreHoja);
  const fd = new FormData(); fd.append("archivo", new File([XLSX.write(wb, { type: "buffer", bookType: "xlsx" })], "lista.xlsx")); return new Request("http://x", { method: "POST", body: fd });
};
const HEADERS_E = ["Publicacion ID", "Componente Cod", "Cantidad"];
const equivalenciasViejas = (n) => [HEADERS_E, ...Array.from({ length: n }, (_, i) => [`MLC${i}`, `C${i}`, "1"])];
const bien = (i) => ({ publicacionId: `MLC9${i}`, componenteCod: `K${i}`, cantidad: i + 1 });

console.log("equivalencias: tabla nueva más corta y más larga que la anterior");
{ nuevo({ "Equivalencias Defontana": equivalenciasViejas(8) }); const r = await llamar(equiv.POST, jsonReq({ equivalencias: [bien(0), bien(1)] }));
  eq([r.status, r.j.ok, r.j.filasGuardadas], [200, true, 2], "responde ok con 2 filas");
  eq(leer("Equivalencias Defontana"), [HEADERS_E, ["MLC90", "K0", "1"], ["MLC91", "K1", "2"]], "más corta: no quedan filas viejas debajo");
  check(!globalThis.__log.includes("clear-total"), "no hay limpieza total de la hoja (escribe primero, limpia solo el sobrante)");
  nuevo({ "Equivalencias Defontana": equivalenciasViejas(1) }); await llamar(equiv.POST, jsonReq({ equivalencias: [bien(0), bien(1), bien(2), bien(3)] }));
  eq(leer("Equivalencias Defontana").length, 5, "más larga: quedan encabezado + 4 filas"); }

console.log("equivalencias: se valida TODO antes de tocar la hoja");
{ const vieja = equivalenciasViejas(5);
  const malos = { "elemento null": [bien(0), null], "elemento número": [bien(0), 7], "falta publicacionId": [bien(0), { componenteCod: "X", cantidad: 1 }],
    "publicacionId vacío": [bien(0), { publicacionId: "  ", componenteCod: "X", cantidad: 1 }], "falta componenteCod": [{ publicacionId: "MLC1", cantidad: 1 }],
    "cantidad texto": [{ publicacionId: "MLC1", componenteCod: "X", cantidad: "abc" }], "cantidad 0": [{ publicacionId: "MLC1", componenteCod: "X", cantidad: 0 }],
    "cantidad negativa": [{ publicacionId: "MLC1", componenteCod: "X", cantidad: -2 }], "cantidad null (NaN en JSON)": [{ publicacionId: "MLC1", componenteCod: "X", cantidad: null }],
    "elemento inválido al final": [bien(0), bien(1), bien(2), { publicacionId: "MLC1", componenteCod: "X" }] };
  for (const [nombre, equivalencias] of Object.entries(malos)) {
    nuevo({ "Equivalencias Defontana": vieja }); const r = await llamar(equiv.POST, jsonReq({ equivalencias }));
    eq([r.status, r.j.ok, globalThis.__log, leer("Equivalencias Defontana")], [400, false, [], vieja], `${nombre}: 400, ninguna llamada a Sheets y la tabla anterior intacta`); }
  nuevo({ "Equivalencias Defontana": vieja }); const r = await llamar(equiv.POST, jsonReq({ equivalencias: [bien(0), bien(1), null] }));
  check(/Equivalencia 3 de 3/.test(r.j.error) && /No se escribió nada/.test(r.j.error), "el mensaje dice cuál elemento falla: «" + r.j.error + "»");
  for (const [nombre, body] of [["JSON roto", "{no es json"], ["sin equivalencias", {}], ["array vacío", { equivalencias: [] }], ["no es array", { equivalencias: "x" }]]) {
    nuevo({ "Equivalencias Defontana": vieja }); const rr = await llamar(equiv.POST, jsonReq(body));
    eq([rr.status, globalThis.__log, leer("Equivalencias Defontana")], [400, [], vieja], `${nombre}: 400 y hoja intacta`); } }

console.log("equivalencias: falla entre pasos");
{ const vieja = equivalenciasViejas(5);
  for (const paso of ["formato", "escribir"]) { nuevo({ "Equivalencias Defontana": vieja }, paso); const r = await llamar(equiv.POST, jsonReq({ equivalencias: [bien(0)] }));
    eq([r.status, leer("Equivalencias Defontana")], [500, vieja], `falla en «${paso}»: 500 y la tabla anterior sigue intacta`); }
  nuevo({ "Equivalencias Defontana": vieja }, "limpiar"); const r = await llamar(equiv.POST, jsonReq({ equivalencias: [bien(0)] }));
  eq([r.status, r.j.ok], [200, true], "falla al limpiar el sobrante: igual responde ok (la tabla nueva está escrita)"); check(/no se pudieron limpiar/.test(r.j.aviso), "…y trae un aviso: «" + r.j.aviso + "»");
  eq(leer("Equivalencias Defontana").slice(0, 2), [HEADERS_E, ["MLC90", "K0", "1"]], "la tabla nueva está completa arriba (con filas viejas debajo hasta el próximo guardado)"); }

console.log("importar: tabla nueva más corta y más larga");
{ const H = ["Proveedor", "Marca", "Familia", "Cod", "Barras", "Articulo", "Mayor", "Cargado"]; const vieja = [H, ...Array.from({ length: 6 }, (_, i) => ["P", "M", "F", `V${i}`, "", "art", "100", "x"])];
  nuevo({ "Lista Defontana": vieja }); let r = await llamar(importar.POST, xlsxReq([["P", "M", "F", "A1", "123", "uno", 500]]));
  eq([r.status, r.j.filasImportadas, leer("Lista Defontana").length], [200, 1, 2], "más corta: 1 fila importada y no quedan filas viejas");
  eq(leer("Lista Defontana")[1].slice(0, 7), ["P", "M", "F", "A1", "123", "uno", "500"], "valores escritos igual que antes (el mayor va como texto)");
  nuevo({ "Lista Defontana": vieja.slice(0, 2) }); r = await llamar(importar.POST, xlsxReq(Array.from({ length: 9 }, (_, i) => ["P", "M", "F", `N${i}`, "", "art", 10 + i])));
  eq([r.status, leer("Lista Defontana").length], [200, 10], "más larga: encabezado + 9 filas");
  check(!globalThis.__log.includes("clear-total"), "sin limpieza total de la hoja"); }

console.log("importar: archivo inválido o falla entre pasos → la lista anterior no se toca");
{ const vieja = [["Proveedor"], ["a"], ["b"]];
  nuevo({ "Lista Defontana": vieja }); let r = await llamar(importar.POST, xlsxReq([["P", "M", "F", "", "", "x", 1]]));
  eq([r.status, leer("Lista Defontana")], [400, vieja], "sin filas con cod: 400 y hoja intacta");
  nuevo({ "Lista Defontana": vieja }); r = await llamar(importar.POST, xlsxReq([["P", "M", "F", "A", "", "x", 1]], "OTRA"));
  eq([r.status >= 400, leer("Lista Defontana")], [true, vieja], "sin hoja PRECIOS: error y hoja intacta");
  for (const paso of ["formato", "escribir"]) { nuevo({ "Lista Defontana": vieja }, paso); r = await llamar(importar.POST, xlsxReq([["P", "M", "F", "A", "", "x", 1]]));
    eq([r.status, leer("Lista Defontana")], [500, vieja], `falla en «${paso}»: 500 y la lista anterior sigue intacta`); }
  nuevo({ "Lista Defontana": vieja }, "limpiar"); r = await llamar(importar.POST, xlsxReq([["P", "M", "F", "A", "", "x", 1]]));
  check(r.status === 200 && /no se pudieron limpiar/.test(r.j.aviso), "falla al limpiar el sobrante: ok con aviso"); }

console.log(`\n${ok} comprobaciones OK`);

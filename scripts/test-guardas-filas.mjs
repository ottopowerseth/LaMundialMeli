// Pruebas de las guardas anti-carrera de borrado (S-08): audit/delete-row, delete-from-sheet y detect-deleted, con Sheets en memoria
// y googleapis/axios simulados. Nada llama a Mercado Libre ni a Sheets reales.  Uso:  node scripts/test-guardas-filas.mjs
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
const out = fs.mkdtempSync(path.join(os.tmpdir(), "guardas-test-"));
const compilar = (origen, destino) => {
  const src = fs.readFileSync(path.join(PROJ, origen), "utf8").replace(/from "@\/lib\/([\w-]+)"/g, 'from "./$1"');
  fs.writeFileSync(path.join(out, destino), ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);
};
for (const [o, d] of [["lib/log.ts", "log.js"], ["lib/http-retry.ts", "http-retry.js"], ["lib/guardas-filas.ts", "guardas-filas.js"], ["app/api/audit/delete-row/route.ts", "delete-row.js"], ["app/api/delete-from-sheet/route.ts", "delete-from-sheet.js"], ["app/api/detect-deleted/route.ts", "detect-deleted.js"]]) compilar(o, d);

// ---- simulados ----
fs.writeFileSync(path.join(out, "ml-token.js"), `exports.getValidAccessToken = async () => "token-falso"; exports.instalarReintento401 = () => {};`);
fs.writeFileSync(path.join(out, "sheets.js"), `
const H = () => globalThis.__hojas; const col = (L) => L.split("").reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0) - 1;
exports.readSheet = async (range) => { globalThis.__lecturas.push(range); const n = globalThis.__lecturas.length;
  const [hoja, ref] = range.split("!"); const m = ref.match(/^([A-Z]+)(\\d+)?(?::([A-Z]+)(\\d+)?)?$/); const c1 = col(m[1]), r1 = m[2] ? +m[2] - 1 : 0, c2 = m[3] ? col(m[3]) : c1, r2 = m[4] ? +m[4] - 1 : (m[3] ? 9999 : r1);
  const filas = (H()[hoja] ?? []).slice(r1, r2 + 1).map((r) => { const s = r.slice(c1, c2 + 1); while (s.length && (s.at(-1) === "" || s.at(-1) === undefined)) s.pop(); return s; }); while (filas.length && filas.at(-1).length === 0) filas.pop(); if (globalThis.__alLeer) globalThis.__alLeer(n); return filas; }; // el hook corre DESPUÉS de leer: simula que la hoja cambia entre una lectura y la siguiente
exports.batchWriteSheet = async (u) => { globalThis.__escrituras.push(...u); };`);
fs.mkdirSync(path.join(out, "node_modules", "googleapis"), { recursive: true });
fs.writeFileSync(path.join(out, "node_modules", "googleapis", "index.js"), `exports.google = { auth: { GoogleAuth: class {} }, sheets: () => ({ spreadsheets: {
  get: async () => ({ data: { sheets: [{ properties: { title: "Auditoría", sheetId: 11 } }, { properties: { title: "Publicaciones", sheetId: 22 } }] } }),
  batchUpdate: async (r) => { globalThis.__borrados.push(...r.requestBody.requests.map((q) => q.deleteDimension.range)); return {}; } } }) };`);
fs.mkdirSync(path.join(out, "node_modules", "axios"), { recursive: true });
fs.writeFileSync(path.join(out, "node_modules", "axios", "index.js"), `const api = { create: () => ({ get: async (url) => url.startsWith("/users/me") ? { data: { id: 1 } } : { data: { results: globalThis.__idsML, paging: { total: globalThis.__idsML.length } } } }) }; module.exports = { __esModule: true, default: api, ...api };`);
const delRow = require(path.join(out, "delete-row.js")); const delSheet = require(path.join(out, "delete-from-sheet.js")); const detect = require(path.join(out, "detect-deleted.js"));
let ok = 0; const check = (c, m) => { assert.ok(c, m); ok++; console.log("  ✓", m); };
const nuevo = (hojas) => { globalThis.__hojas = hojas; globalThis.__lecturas = []; globalThis.__escrituras = []; globalThis.__borrados = []; globalThis.__alLeer = null; globalThis.__idsML = []; };
const req = (metodo, body) => new Request("http://x", { method: metodo, headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const silencio = async (fn) => { const e = console.error, w = console.warn; console.error = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.error = e; console.warn = w; } };
const llamar = async (handler, r) => { const res = await silencio(() => handler(r)); return { status: res.status, j: await res.json() }; };

// Hoja Auditoría: encabezado + 3 filas de junio (dos idénticas en el mismo segundo, una distinta) + una de esquema viejo (14 columnas)
const f16 = (mes, analizado) => [mes, 1, 1, 1, "", "", 1, 0, 0, "", "10", 0, 0, 0, "r", analizado];
const AUD = () => [["Mes", "Ventas"], f16("2026-06", "04-07-2026, 3:52:05 p. m."), f16("2026-06", "04-07-2026, 3:52:05 p. m."), f16("2026-06", "04-07-2026, 4:30:09 p. m."), ["2026-05", 1, 1, 1, 1, 1, 0, 1, 12, 0, 0, 0, "r", "01-06-2026, 9:00:00 a. m."]];

console.log("audit/delete-row: validación del índice");
nuevo({ "Auditoría": AUD() });
for (const rowIndex of [0, -1, 1.5, "2", null, undefined, NaN]) { const r = await llamar(delRow.DELETE, req("DELETE", { rowIndex, mes: "2026-06", analizado: "x" })); check(r.status === 400 && r.j.ok === false && globalThis.__borrados.length === 0, `rowIndex ${JSON.stringify(rowIndex)} → 400, no borra`); }
{ const r = await llamar(delRow.DELETE, req("DELETE", "{roto")); check(r.status === 400 && globalThis.__borrados.length === 0, "cuerpo JSON roto → 400, no borra"); }
{ const r = await llamar(delRow.DELETE, req("DELETE", { rowIndex: 2 })); check(r.status === 400 && /Faltan el mes y la fecha/.test(r.j.error) && globalThis.__borrados.length === 0, "sin mes ni fecha (cliente viejo) → 400, no borra"); }
console.log("audit/delete-row: verificación de la fila");
{ nuevo({ "Auditoría": AUD() }); const r = await llamar(delRow.DELETE, req("DELETE", { rowIndex: 3, mes: "2026-06", analizado: "04-07-2026, 4:30:09 p. m." }));
  check(r.status === 200 && r.j.ok && globalThis.__borrados.length === 1 && globalThis.__borrados[0].startIndex === 3 && globalThis.__borrados[0].endIndex === 4 && globalThis.__borrados[0].sheetId === 11, "la fila coincide (mes y fecha) → se borra exactamente esa fila"); }
{ nuevo({ "Auditoría": AUD() }); const r = await llamar(delRow.DELETE, req("DELETE", { rowIndex: 1, mes: "2026-06", analizado: "04-07-2026, 3:52:05 p. m." })); check(r.status === 200 && globalThis.__borrados.length === 1, "de dos filas idénticas, la primera se borra (son indistinguibles por diseño)"); }
{ nuevo({ "Auditoría": AUD() }); const r = await llamar(delRow.DELETE, req("DELETE", { rowIndex: 4, mes: "2026-05", analizado: "01-06-2026, 9:00:00 a. m." })); check(r.status === 200 && globalThis.__borrados.length === 1, "fila de esquema viejo (14 columnas): la fecha se lee de la columna N"); }
{ nuevo({ "Auditoría": AUD() }); const r = await llamar(delRow.DELETE, req("DELETE", { rowIndex: 2, mes: "2026-06", analizado: "04-07-2026, 4:30:09 p. m." })); check(r.status === 409 && /ya no contiene lo esperado/.test(r.j.error) && /No se borró nada/.test(r.j.error) && globalThis.__borrados.length === 0, `mismo mes pero otra fecha de análisis (la hoja cambió) → 409, no borra: «${r.j.error.slice(0, 95)}…»`); }
{ nuevo({ "Auditoría": AUD() }); const r = await llamar(delRow.DELETE, req("DELETE", { rowIndex: 4, mes: "2026-06", analizado: "04-07-2026, 3:52:05 p. m." })); check(r.status === 409 && globalThis.__borrados.length === 0, "otra fila ocupa ese índice (se borró una de arriba) → 409, no borra"); }
{ nuevo({ "Auditoría": AUD() }); const r = await llamar(delRow.DELETE, req("DELETE", { rowIndex: 40, mes: "2026-06", analizado: "x" })); check(r.status === 409 && /ya no existe/.test(r.j.error) && globalThis.__borrados.length === 0, "fila más allá del final → 409, no borra"); }
{ nuevo({ "Auditoría": AUD() }); await llamar(delRow.DELETE, req("DELETE", { rowIndex: 3, mes: "2026-06", analizado: "04-07-2026, 4:30:09 p. m." })); check(globalThis.__lecturas.length === 1 && globalThis.__lecturas[0] === "Auditoría!A4:R4", `verifica leyendo solo esa fila (${globalThis.__lecturas[0]})`); }

console.log("delete-from-sheet: contrato nuevo y verificación de IDs");
const PUB = () => [["ID", "x", "Titulo"], ...Array.from({ length: 12 }, (_, i) => [`MLC${100 + i}`, "", `Producto ${i}`])]; // fila 2 = MLC100 … fila 13 = MLC111
{ nuevo({ Publicaciones: PUB() }); const r = await llamar(delSheet.POST, req("POST", { filas: [3, 5] })); check(r.status === 400 && /Productos inválidos/.test(r.j.error) && globalThis.__borrados.length === 0, "el formato viejo (solo números de fila) ya no se acepta → 400, no borra"); }
for (const malo of [[{ fila: 1, id: "MLC100" }], [{ fila: 3.5, id: "MLC101" }], [{ fila: 3 }], [{ fila: 3, id: "" }], [{ id: "MLC1" }]]) { nuevo({ Publicaciones: PUB() }); const r = await llamar(delSheet.POST, req("POST", { productos: malo })); check(r.status === 400 && globalThis.__borrados.length === 0, `producto inválido ${JSON.stringify(malo[0])} → 400`); }
{ nuevo({ Publicaciones: PUB() }); const r = await llamar(delSheet.POST, req("POST", { productos: Array.from({ length: 101 }, (_, i) => ({ fila: i + 2, id: "x" })) })); check(r.status === 400 && /Máximo 100/.test(r.j.error), "más de 100 filas → 400"); }
{ nuevo({ Publicaciones: PUB() }); const r = await llamar(delSheet.POST, req("POST", { productos: [{ fila: 3, id: "MLC101" }, { fila: 7, id: "MLC105" }, { fila: 3, id: "MLC101" }] }));
  check(r.status === 200 && r.j.ok && r.j.borrados === 2 && globalThis.__borrados.map((b) => b.startIndex).join() === "6,2" && globalThis.__borrados.every((b) => b.sheetId === 22), "IDs coinciden → borra, sin repetir y de abajo hacia arriba (índices 6 y 2)"); }
{ nuevo({ Publicaciones: PUB() }); globalThis.__hojas.Publicaciones.splice(2, 0, ["MLC999", "", "Producto nuevo"]); // un sync insertó una fila arriba: todo se corrió
  const r = await llamar(delSheet.POST, req("POST", { productos: [{ fila: 3, id: "MLC101" }, { fila: 7, id: "MLC105" }] }));
  check(r.status === 409 && r.j.ok === false && globalThis.__borrados.length === 0 && r.j.discrepancias.length === 2, `la hoja se corrió una fila → 409 y NO se borra nada: «${r.j.error.slice(0, 120)}…»`); }
{ nuevo({ Publicaciones: PUB() }); globalThis.__hojas.Publicaciones[6][0] = "MLC777"; // una sola fila cambió; la otra sigue bien
  const r = await llamar(delSheet.POST, req("POST", { productos: [{ fila: 3, id: "MLC101" }, { fila: 7, id: "MLC105" }] })); check(r.status === 409 && globalThis.__borrados.length === 0 && r.j.discrepancias.length === 1 && r.j.discrepancias[0].fila === 7, "si una sola fila no coincide, tampoco se borra la que sí coincide (todo o nada)"); }
{ nuevo({ Publicaciones: PUB() }); const r = await llamar(delSheet.POST, req("POST", { productos: [{ fila: 30, id: "MLC130" }] })); check(r.status === 409 && globalThis.__borrados.length === 0 && /\(vacía\)/.test(r.j.error), "fila más allá del final de la hoja → 409, mensaje «(vacía)»"); }

console.log("detect-deleted: solo marca las filas que siguen siendo las mismas");
{ nuevo({ Publicaciones: PUB() }); globalThis.__idsML = PUB().slice(1).map((r) => r[0]).filter((id) => id !== "MLC103" && id !== "MLC108"); // ML ya no tiene 103 y 108
  const r = await llamar(detect.POST, new Request("http://x", { method: "POST" }));
  check(r.status === 200 && r.j.eliminados === 2 && globalThis.__escrituras.map((w) => w.range).join() === "Publicaciones!P5,Publicaciones!P10" && !r.j.aviso, "hoja sin cambios: marca ELIMINADA en P5 y P10 y no avisa"); }
{ nuevo({ Publicaciones: PUB() }); globalThis.__idsML = PUB().slice(1).map((r) => r[0]).filter((id) => id !== "MLC103" && id !== "MLC108");
  globalThis.__alLeer = (n) => { if (n === 1) globalThis.__hojas.Publicaciones.splice(2, 0, ["MLC999", "", "nuevo"]); }; // un sync inserta una fila entre la lectura y el marcado
  const r = await llamar(detect.POST, new Request("http://x", { method: "POST" }));
  check(r.status === 200 && globalThis.__escrituras.length === 0 && /no se marcaron/.test(r.j.aviso) && r.j.eliminados === 2, `la hoja se corrió durante la detección → no marca nada y avisa: «${r.j.aviso}»`); }
{ nuevo({ Publicaciones: PUB() }); globalThis.__idsML = PUB().slice(1).map((r) => r[0]).filter((id) => id !== "MLC103" && id !== "MLC108");
  globalThis.__alLeer = (n) => { if (n === 1) globalThis.__hojas.Publicaciones[9] = ["MLC555", "", "otro"]; }; // solo cambió la fila 10
  const r = await llamar(detect.POST, new Request("http://x", { method: "POST" })); check(globalThis.__escrituras.map((w) => w.range).join() === "Publicaciones!P5" && /1 fila/.test(r.j.aviso), "cambió solo una fila → marca la que sigue igual (P5) y omite la otra, avisando"); }
{ nuevo({ Publicaciones: PUB() }); globalThis.__idsML = PUB().slice(1).map((r) => r[0]); const r = await llamar(detect.POST, new Request("http://x", { method: "POST" })); check(r.j.eliminados === 0 && globalThis.__escrituras.length === 0, "sin eliminados no hay segunda lectura ni escrituras"); }
console.log(`\n${ok} comprobaciones OK`);

// Pruebas de la referencia de ventas de Auditoría (lib/audit-referencia.ts) con un /orders/search SIMULADO: nada llama a
// Mercado Libre ni a Sheets.  Uso:  node scripts/test-audit-referencia.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import Module, { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ts = require(path.join(PROJ, "node_modules", "typescript"));
process.env.NODE_PATH = path.join(PROJ, "node_modules"); Module._initPaths(); // lib/audit.ts importa xlsx
const out = fs.mkdtempSync(path.join(os.tmpdir(), "audit-ref-test-"));
for (const [origen, destino] of [["lib/backfill-shipping.ts", "backfill-shipping.js"], ["lib/audit-referencia.ts", "audit-referencia.js"], ["lib/audit.ts", "audit.js"]]) {
  const src = fs.readFileSync(path.join(PROJ, origen), "utf8").replace(/from "@\/lib\/([\w-]+)"/g, 'from "./$1"');
  fs.writeFileSync(path.join(out, destino), ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);
}
const { calcularReferenciaVentas, ventasBrutasParaAuditoria } = require(path.join(out, "audit-referencia.js"));
const { cicloEsperado } = require(path.join(out, "audit.js"));
let ok = 0; const check = (c, m) => { assert.ok(c, m); ok++; console.log("  ✓", m); };
const DIA = 86400000;

// ---- Mercado Libre simulado: sobrepaso del borde "to" (~56 min), sort=date_desc, tope offset+limit ≤ 10.000, repeticiones, fallos ----
function crearML(ordenes, { fallarEn = null } = {}) {
  const ml = { llamadas: 0, urls: [], get: null };
  ml.get = async (url) => {
    ml.llamadas++; ml.urls.push(url);
    const q = new URL(url, "http://ml").searchParams;
    if (fallarEn !== null && ml.llamadas === fallarEn) throw Object.assign(new Error("Request failed with status code 500"), { response: { status: 500 } });
    const desde = Date.parse(q.get("order.date_created.from")), hasta = Date.parse(q.get("order.date_created.to")) + 56 * 60000;
    const offset = Number(q.get("offset")), limit = Number(q.get("limit"));
    if (offset + limit > 10000) throw Object.assign(new Error("offset+limit > 10000"), { response: { status: 400 } });
    const lista = ordenes.filter((o) => { const t = Date.parse(o.date_created); return t >= desde && t <= hasta && (!q.get("order.status") || o.status === q.get("order.status")); })
      .sort((a, b) => Date.parse(b.date_created) - Date.parse(a.date_created));
    return { data: { results: lista.slice(offset, offset + limit), paging: { total: lista.length, offset, limit } } };
  };
  return ml;
}
let id = 5_000_000_000_000;
// órdenes distribuidas dentro de [desdeMs, hastaMs): `porDia` por cada día del ciclo; monto = 10.000 + k
function generar(desdeMs, hastaMs, porDia, { status = "paid" } = {}) {
  const o = []; for (let d = desdeMs, i = 0; d < hastaMs; d += DIA, i++) { const n = typeof porDia === "function" ? porDia(i) : porDia; for (let k = 0; k < n; k++) o.push({ id: ++id, date_created: new Date(d + 1800000 + Math.floor((k / Math.max(n, 1)) * (DIA - 3600000))).toISOString(), status, total_amount: 10000 + k }); }
  return o;
}
const rango = (mes) => { const { desde, hasta } = cicloEsperado(mes); return [desde.getTime(), hasta.getTime() + DIA]; }; // igual que fetchReferenciaML (hasta +1 día)

console.log("ciclo con más de 1.050 órdenes (2026-09: 15-ago → 14-sep)");
{ const [d, h] = rango("2026-09"); const todas = generar(d, h, (i) => 55 + (i % 4)); // ~1.750 órdenes
  const total = todas.reduce((a, o) => a + o.total_amount, 0); const ml = crearML(todas);
  // Control: el algoritmo anterior (offset ≤ 1000, de la más reciente a la más vieja)
  const viejo = []; for (let off = 0; off <= 1000; off += 50) { const { data } = await ml.get(`/orders/search?seller=1&order.status=paid&order.date_created.from=${new Date(d).toISOString()}&order.date_created.to=${new Date(h).toISOString()}&sort=date_desc&limit=50&offset=${off}`); viejo.push(...data.results); if (!data.results.length) break; }
  const totalViejo = viejo.reduce((a, o) => a + o.total_amount, 0);
  check(viejo.length === 1050 && totalViejo < total, `control: el algoritmo anterior sumaba ${viejo.length} de ${todas.length} órdenes (${(100 * (1 - totalViejo / total)).toFixed(1)} % menos: $${totalViejo.toLocaleString("es-CL")} contra $${total.toLocaleString("es-CL")})`);
  ml.llamadas = 0; const r = await calcularReferenciaVentas(ml.get, 1, d, h);
  check(r.cantidadVentas === todas.length && r.ventasBrutas === total, `ahora: ${r.cantidadVentas} órdenes y $${r.ventasBrutas.toLocaleString("es-CL")} = las del ciclo completo`);
  check(!r.incompleta && r.ventanasAlTope === 0 && r.aviso === null, "referencia completa, sin aviso");
  check(ventasBrutasParaAuditoria(r) === total, "una referencia completa SÍ puede pisar ventas_brutas");
  check(ml.urls.every((u) => u.includes("order.status=paid")), `todas las ${ml.llamadas} consultas llevan order.status=paid (solo pagadas, como antes)`); }

console.log("órdenes repetidas entre ventanas contiguas");
{ const [d, h] = rango("2026-08"); const todas = generar(d, h, 40); const ml = crearML(todas); const r = await calcularReferenciaVentas(ml.get, 1, d, h);
  check(r.cantidadVentas === todas.length && r.ventasBrutas === todas.reduce((a, o) => a + o.total_amount, 0), "ML devuelve órdenes del borde en dos ventanas (sobrepaso de ~56 min): cada orden se cuenta UNA sola vez"); }

console.log("una ventana que llega al tope de resultados de ML");
{ const [d, h] = rango("2026-09"); const todas = [...generar(d, h, 30), ...Array.from({ length: 10_300 }, (_, k) => ({ id: ++id, date_created: new Date(d + 5 * DIA + 3600000 + Math.floor((k / 10_300) * (DIA - 7200000))).toISOString(), status: "paid", total_amount: 5000 }))];
  const ml = crearML(todas); const r = await calcularReferenciaVentas(ml.get, 1, d, h);
  check(r.incompleta === true && r.ventanasAlTope >= 1, `la referencia se marca INCOMPLETA (${r.ventanasAlTope} ventana(s) al tope)`);
  check(r.aviso && /incompleta/.test(r.aviso) && /no se usó/.test(r.aviso) && !/Bearer|APP_USR|TG-|token/i.test(r.aviso), `aviso claro y sin tokens: «${r.aviso.slice(0, 95)}…»`);
  check(ventasBrutasParaAuditoria(r) === undefined, "una referencia incompleta NO pisa ventas_brutas (devuelve undefined: calculateAudit se queda con el valor del archivo de ML)"); }

console.log("fallo de Mercado Libre");
{ const [d, h] = rango("2026-08"); const ml = crearML(generar(d, h, 40), { fallarEn: 7 });
  const e = await calcularReferenciaVentas(ml.get, 1, d, h).then(() => null, (x) => x);
  check(e && e.response?.status === 500, "un 500 a mitad del listado hace fallar la referencia completa (no devuelve un total parcial como si fuera completo)");
  check(ventasBrutasParaAuditoria(null) === undefined, "la ruta convierte ese fallo en null → no pisa ventas_brutas"); }

console.log("ciclo sin ventas (ML devuelve 0): se trata como «sin referencia»");
{ const [d, h] = rango("2026-08"); const r = await calcularReferenciaVentas(crearML([]).get, 1, d, h);
  check(r.cantidadVentas === 0 && r.ventasBrutas === 0 && !r.incompleta && r.sinVentas === true, "sin órdenes: total 0, completa pero marcada sinVentas");
  check(ventasBrutasParaAuditoria(r) === undefined, "un total 0 NO pisa ventas_brutas (devuelve undefined: se queda el valor del archivo de ML)");
  check(/devolvió 0 ventas/.test(r.aviso) && /salen del archivo de ML/.test(r.aviso) && !/Bearer|APP_USR|TG-|token/i.test(r.aviso), `aviso claro y sin tokens: «${r.aviso}»`);
  const con = await calcularReferenciaVentas(crearML(generar(d, h, 5)).get, 1, d, h); check(con.sinVentas === false && con.aviso === null && ventasBrutasParaAuditoria(con) === con.ventasBrutas, "con ventas, sinVentas es false y la referencia sí se usa"); }
console.log(`\n${ok} comprobaciones OK`);

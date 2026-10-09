// Pruebas del pase opt-in de canceladas de lib/backfill-shipping.ts (sin red ni Sheets).
// Uso:  node scripts/test-backfill-canceladas.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ts = require(path.join(PROJ, "node_modules", "typescript"));
const out = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-canc-"));
fs.writeFileSync(path.join(out, "b.js"), ts.transpileModule(fs.readFileSync(`${PROJ}/lib/backfill-shipping.ts`, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText);
const B = require(path.join(out, "b.js"));
let ok = 0; const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); ok++; console.log("  ✓", m); };

const AHORA = Date.parse("2026-10-09T15:00:00Z");
const iso = (diasAtras) => new Date(AHORA - diasAtras * 86400000).toISOString();
// 1: pagada con tipo | 2: cancelada con envío y sin tipo | 3: cancelada con envío y con tipo | 4: cancelada sin envío
// 5: cancelada con envío y sin tipo | 6: pagada sin tipo | 7: cancelada vieja (fuera de la ventana de 30 días)
const ORDENES = [
  { id: 1, status: "paid", shipping: { id: 101 }, date_created: iso(1) },
  { id: 2, status: "cancelled", shipping: { id: 102 }, date_created: iso(2) },
  { id: 3, status: "cancelled", shipping: { id: 103 }, date_created: iso(3) },
  { id: 4, status: "cancelled", shipping: { id: null }, date_created: iso(4) },
  { id: 5, status: "cancelled", shipping: { id: 105 }, date_created: iso(5) },
  { id: 6, status: "paid", shipping: { id: 106 }, date_created: iso(6) },
  { id: 7, status: "cancelled", shipping: { id: 107 }, date_created: iso(60) },
];
const TIPOS = { 102: "fulfillment", 105: "xd_drop_off", 106: "fulfillment" };

function armar({ cache = [["'1", "'101", "fulfillment", "x"], ["'3", "'103", "xd_drop_off", "x"]], fallo = null, enHojaAlEscribir = null } = {}) {
  const log = { llamadas: [], envios: [], appends: [] };
  const get = async (url) => {
    log.llamadas.push(url);
    if (url.startsWith("/orders/search")) {
      const q = new URLSearchParams(url.split("?")[1]);
      const d = Date.parse(q.get("order.date_created.from")), h = Date.parse(q.get("order.date_created.to"));
      const lista = ORDENES.filter((o) => Date.parse(o.date_created) >= d && Date.parse(o.date_created) <= h);
      const off = Number(q.get("offset") ?? 0);
      return { data: { results: lista.slice(off, off + 50), paging: { total: lista.length } } };
    }
    const sid = Number(url.split("/shipments/")[1]);
    log.envios.push(sid);
    if (fallo && fallo === sid) { const e = new Error("HTTP"); e.response = { status: 429 }; throw e; }
    return { data: { logistic_type: TIPOS[sid] ?? "xd_drop_off" } };
  };
  let hoja = cache.map((f) => [...f]);
  const deps = {
    get, userId: "U", ahora: () => AHORA,
    leerHoja: async (rango) => (rango.endsWith("A100000") ? hoja.map((f) => [f[0]]) : hoja),
    agregarFilas: async (filas) => { log.appends.push(filas.map((f) => f.slice(0, 3))); hoja = hoja.concat(filas); },
  };
  return { deps, log, hoja: () => hoja };
}

console.log("por defecto: las canceladas siguen excluidas");
{
  const { deps, log } = armar();
  const r = await B.ejecutarBackfill(deps, { dias: 30, seco: true });
  eq([r.excluidasCanceladas, r.faltantes, r.pase], [4, 1, undefined], "modo normal: 4 canceladas excluidas, solo la pagada sin tipo (6) falta, sin sección pase");
  eq(log.appends.length, 0, "en seco no escribe");
}

console.log("simulación del pase");
{
  const { deps, log } = armar();
  const r = await B.ejecutarBackfill(deps, { dias: 30, seco: true, incluirCanceladas: true, idsEsperados: ["2", "5"] });
  eq(r.faltantesIds.sort(), ["2", "5"], "solo canceladas con envío y sin tipo (la 4 sin envío, la 3 con tipo y la 7 fuera de ventana no entran; la pagada 6 tampoco)");
  eq([r.pase.guarda, r.pase.sobran, r.pase.faltan, r.sinEnvio, r.yaEnCache], ["coincide", [], [], 1, 1], "la guarda coincide; 1 sin envío y 1 ya en caché");
  eq([log.envios.length, log.appends.length], [0, 0], "en seco no consulta /shipments ni escribe");
}

console.log("escritura con guarda exacta");
{
  const { deps, log, hoja } = armar();
  const antes = JSON.stringify(hoja());
  const r = await B.ejecutarBackfill(deps, { dias: 30, incluirCanceladas: true, idsEsperados: ["2", "5"] });
  eq(log.envios.sort(), [102, 105], "consulta solo los envíos de las 2 canceladas (ni la pagada 6 ni las ya resueltas)");
  eq(log.appends, [[["'2", "'102", "fulfillment"], ["'5", "'105", "xd_drop_off"]]], "agrega exactamente 2 filas con su tipo crudo");
  eq([r.nuevasEnCache, r.completo, r.pase.abortado], [2, true, undefined], "resultado: 2 nuevas, completo");
  eq(JSON.stringify(hoja().slice(0, 2)), JSON.stringify(JSON.parse(antes)), "las filas previas no cambian");
  const ids = hoja().map((f) => f[0]); eq(new Set(ids).size, ids.length, "sin ids duplicados");
  // segunda corrida: ya no hay nada que resolver y la guarda no coincide → no escribe
  const r2 = await B.ejecutarBackfill(deps, { dias: 30, incluirCanceladas: true, idsEsperados: ["2", "5"] });
  eq([r2.pase.guarda, log.appends.length], ["no_coincide", 1], "repetirla no agrega nada (idempotente)");
}

console.log("la guarda impide escribir");
{
  for (const [nombre, ids] of [["sobra una id (el real tiene 2 y se esperaba 1)", ["2"]], ["falta una id (se esperaba una que no está)", ["2", "5", "99"]], ["otro conjunto", ["6", "7"]]]) {
    const { deps, log } = armar();
    const r = await B.ejecutarBackfill(deps, { dias: 30, incluirCanceladas: true, idsEsperados: ids });
    eq([r.pase.guarda, log.envios.length, log.appends.length], ["no_coincide", 0, 0], "no_coincide, 0 llamadas a /shipments y 0 filas: " + nombre);
  }
  const a = armar(); const r = await B.ejecutarBackfill(a.deps, { dias: 30, incluirCanceladas: true });
  eq([r.pase.guarda, a.log.appends.length, !!r.pase.abortado], ["no_pedida", 0, true], "sin idsEsperados no escribe");
  const c = armar({ cache: [] }); const rc = await B.ejecutarBackfill(c.deps, { dias: 30, incluirCanceladas: true, idsEsperados: ORDENES.filter((o) => o.status === "cancelled" && o.shipping.id && o.id !== 7).map((o) => String(o.id)) });
  eq([c.log.appends.length, !!rc.pase.abortado], [0, true], "ShippingCache leída vacía: no escribe");
}

console.log("429: se detiene sin reintentar");
{
  const { deps, log } = armar({ fallo: 102 });
  const r = await B.ejecutarBackfill(deps, { dias: 30, incluirCanceladas: true, idsEsperados: ["2", "5"] });
  eq(log.envios.filter((s) => s === 102).length, 1, "el envío que dio 429 se pidió una sola vez");
  eq([!!r.pase.abortado, r.errores.http429], [true, 1], "el pase se corta y cuenta el 429");
}

console.log(`\n${ok} comprobaciones OK`);

// Pruebas del historial de Ventas de ml-sync (lib/ventas-historial.ts + ventanas de lib/backfill-shipping.ts) con un /orders/search
// SIMULADO: nada llama a Mercado Libre ni a Sheets.  Uso:  node scripts/test-ventas-historial.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ts = require(path.join(PROJ, "node_modules", "typescript"));
const out = fs.mkdtempSync(path.join(os.tmpdir(), "ventas-test-"));
for (const [origen, destino] of [["lib/backfill-shipping.ts", "backfill-shipping.js"], ["lib/ventas-historial.ts", "ventas-historial.js"]]) {
  const src = fs.readFileSync(path.join(PROJ, origen), "utf8").replace(/from "@\/lib\/([\w-]+)"/g, 'from "./$1"');
  fs.writeFileSync(path.join(out, destino), ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);
}
const { ventanasDeUnDia, listarOrdenesRango } = require(path.join(out, "backfill-shipping.js"));
const { cargarHistorialVentas, DIAS_HISTORIAL_VENTAS } = require(path.join(out, "ventas-historial.js"));
let ok = 0; const check = (c, m) => { assert.ok(c, m); ok++; console.log("  ✓", m); };
const DIA = 86400000; const AHORA = Date.parse("2026-10-13T18:00:00Z");

// ---- Mercado Libre simulado ----
// Reproduce lo medido: `order.date_created.to` se pasa hasta ~56 min, sort=date_desc, limit 50, tope offset+limit ≤ 10.000,
// y a veces repite una orden al inicio de la página siguiente.
function crearML(ordenes, { repetirEnPaginas = false } = {}) {
  const ml = { llamadas: 0, get: null };
  ml.get = async (url) => {
    ml.llamadas++;
    const q = new URL(url, "http://ml").searchParams;
    const desde = Date.parse(q.get("order.date_created.from")), hasta = Date.parse(q.get("order.date_created.to")) + 56 * 60000; // sobrepaso del borde "to"
    const offset = Number(q.get("offset")), limit = Number(q.get("limit"));
    if (offset + limit > 10000) throw Object.assign(new Error("offset+limit > 10000"), { response: { status: 400 } });
    const lista = ordenes.filter((o) => { const t = Date.parse(o.date_created); return t >= desde && t <= hasta && (!q.get("order.status") || o.status === q.get("order.status")); }).sort((a, b) => Date.parse(b.date_created) - Date.parse(a.date_created));
    let pagina = lista.slice(offset, offset + limit);
    if (repetirEnPaginas && offset > 0 && lista[offset - 1]) pagina = [lista[offset - 1], ...pagina.slice(0, limit - 1)]; // repite la última de la página anterior
    return { data: { results: pagina, paging: { total: lista.length, offset, limit } } };
  };
  return ml;
}
let idSeq = 2_000_000_000_000;
// cantidades[i] = órdenes del día i contado hacia atrás desde AHORA (0 = hoy)
function generar(cantidades) {
  const o = [];
  cantidades.forEach((n, i) => { for (let k = 0; k < n; k++) { const ms = AHORA - i * DIA - Math.floor(((k + 0.5) / n) * (DIA - 120000)) - 90000; o.push({ id: ++idSeq, date_created: new Date(ms).toISOString(), status: k % 9 === 0 ? "cancelled" : "paid", total_amount: 1000 + k, order_items: [{ item: { id: "MLC1" }, quantity: 1 }] }); } });
  return o;
}
const ventana35 = (o) => o.filter((x) => { const t = Date.parse(x.date_created); return t >= AHORA - DIAS_HISTORIAL_VENTAS * DIA && t < AHORA + 60000; });

console.log("el helper único de ventanas");
{ const d = AHORA - 35 * DIA, h = AHORA + 60000, v = ventanasDeUnDia(d, h);
  check(v.length === 36 && v[0].h === h && v.at(-1).d === d, `35 días + 1 min → ${v.length} ventanas, la más reciente termina en «hasta» y la más vieja empieza en «desde»`);
  check(v.every((x, i) => i === v.length - 1 || x.d === v[i + 1].h), "contiguas: cada ventana empieza donde termina la siguiente (sin huecos ni solapes)");
  check(v.slice(0, -1).every((x) => x.h - x.d === DIA) && v.at(-1).h - v.at(-1).d === 60000, "todas de un día salvo la más vieja, que es más corta"); }

console.log("más de 2.050 órdenes en el historial");
{ const todas = generar(Array.from({ length: 40 }, () => 75)); // 3.000 órdenes en 40 días → ~2.625 dentro de los 35 días
  const esperadas = ventana35(todas); const ml = crearML(todas);
  // Control: el algoritmo anterior (offset ≤ 2000, sin filtro de fecha)
  const viejo = []; for (let off = 0; off <= 2000; off += 50) { const { data } = await ml.get(`/orders/search?seller=1&sort=date_desc&limit=50&offset=${off}&order.date_created.from=2020-01-01T00:00:00.000Z&order.date_created.to=2030-01-01T00:00:00.000Z`); if (!data.results.length) break; viejo.push(...data.results); }
  const masViejaViejo = Math.min(...viejo.map((o) => Date.parse(o.date_created)));
  check(viejo.length <= 2051 && esperadas.length > viejo.length, `control: el algoritmo anterior se quedó en ${viejo.length} órdenes de las ${esperadas.length} que había en los 35 días`);
  check(masViejaViejo > AHORA - DIAS_HISTORIAL_VENTAS * DIA + 3 * DIA, `…y no llegaba a los 35 días: su orden más vieja era de hace ${((AHORA - masViejaViejo) / DIA).toFixed(1)} días`);
  ml.llamadas = 0; const h = await cargarHistorialVentas(ml.get, 1, AHORA);
  check(h.ordenes.length === esperadas.length, `ahora trae ${h.ordenes.length} órdenes = las ${esperadas.length} que hay en los 35 días`);
  check(new Set(h.ordenes.map((o) => String(o.id))).size === h.ordenes.length, "sin órdenes repetidas (dedupe por ID de orden)");
  const t = h.ordenes.map((o) => Date.parse(o.date_created)); check(t.every((x, i) => i === 0 || t[i - 1] >= x), "ordenadas de la más reciente a la más vieja (como la hoja y seleccionarEnviosPendientes)");
  check(Math.min(...t) >= AHORA - 35 * DIA && Math.max(...t) < AHORA + 60000, `rango: de hace ${((AHORA - Math.min(...t)) / DIA).toFixed(1)} días hasta ahora (pedido: 35 días)`);
  check(h.ordenes.some((o) => o.status === "cancelled") && h.ordenes.some((o) => o.status === "paid"), "trae TODOS los estados (la hoja los distingue por la columna Estado)");
  check(h.repetidas > 0, `ML devolvió ${h.repetidas} órdenes en dos ventanas contiguas (sobrepaso del borde): se descartaron`);
  check(h.ventanasAlTope === 0 && h.aviso === null, "sin aviso cuando ninguna ventana llega al tope"); console.log("    llamadas a /orders/search:", ml.llamadas); }

console.log("distribución real del historial (2.050 órdenes, máx. 134 por día) → cuántas llamadas hace");
{ const reales = [27, 108, 134, 116, 95, 37, 32, 51, 51, 76, 97, 67, 66, 35, 48, 79, 77, 70, 61, 57, 43, 33, 46, 91, 102, 47, 42, 46, 55, 82, 79];
  const todas = generar([...reales, 0, 0, 0, 0]); const ml = crearML(todas); const h = await cargarHistorialVentas(ml.get, 1, AHORA);
  check(h.ordenes.length === ventana35(todas).length, `trae las ${h.ordenes.length} órdenes de los 35 días (días sin ventas incluidos)`);
  check(ml.llamadas <= 90, `${ml.llamadas} llamadas a /orders/search para ${h.ventanas} ventanas (el algoritmo anterior hacía 42, en serie)`); console.log(`    con 4 llamadas en paralelo, a ~0,3-0,5 s cada una ≈ ${(ml.llamadas / 4 * 0.4).toFixed(0)} s`); }

console.log("un día sin ventas y huecos");
{ const todas = generar([60, 0, 0, 55, 0, 70, ...Array(30).fill(40)]); const ml = crearML(todas); const h = await cargarHistorialVentas(ml.get, 1, AHORA);
  check(h.ordenes.length === ventana35(todas).length && h.ventanas === 36, "días sin ventas no rompen nada: mismas órdenes que las esperadas, 36 ventanas recorridas"); }

console.log("ML repite una orden al inicio de la página siguiente");
{ const todas = generar(Array(36).fill(130)); const ml = crearML(todas, { repetirEnPaginas: true }); const h = await cargarHistorialVentas(ml.get, 1, AHORA);
  check(h.ordenes.length === ventana35(todas).length && new Set(h.ordenes.map((o) => String(o.id))).size === h.ordenes.length, "ventanas de 3 páginas con repetidos entre páginas → una sola copia de cada orden"); }

console.log("una ventana que llega al tope de resultados de ML");
{ const todas = [...generar([60, 50, 40]), ...Array.from({ length: 10_200 }, (_, k) => ({ id: ++idSeq, date_created: new Date(AHORA - 5 * DIA - 3600000 - Math.floor((k / 10_200) * (DIA - 7200000))).toISOString(), status: "paid", total_amount: 1 }))];
  const ml = crearML(todas); const avisos = []; const w = console.warn; console.warn = (...a) => avisos.push(a.join(" "));
  const h = await cargarHistorialVentas(ml.get, 1, AHORA); console.warn = w;
  check(h.ventanasAlTope >= 1 && h.aviso && /tope de resultados de Mercado Libre/.test(h.aviso), `se detecta y avisa: «${h.aviso}»`);
  check(h.ordenes.length < ventana35(todas).length, `…y se reconoce que quedó incompleta (${h.ordenes.length} de ${ventana35(todas).length}), no se trunca en silencio`);
  check(!/Bearer|APP_USR|TG-|token/i.test(h.aviso), "el aviso no contiene tokens ni datos de la cuenta"); }

console.log("compatibilidad: Métricas y backfill siguen usando listarOrdenesRango igual");
{ const todas = generar(Array(10).fill(55)); const ml = crearML(todas); const r = await listarOrdenesRango(ml.get, 1, AHORA - 10 * DIA, AHORA, { extraQuery: "&order.status=paid" });
  check(r.ordenes.every((o) => o.status === "paid") && "ventanas" in r && "repetidas" in r && "fueraDeRango" in r, "con extraQuery filtra por estado y conserva ordenes/ventanas/repetidas/fueraDeRango"); }
console.log(`\n${ok} comprobaciones OK`);

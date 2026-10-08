// Pruebas de lib/publicidad-equilibrio.ts y lib/publicidad-datos.ts (sin red, ML simulado).
// Uso:  node scripts/test-publicidad-equilibrio.mjs
// Transpila las librerías TypeScript a una carpeta temporal con el compilador del proyecto.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ts = require(path.join(PROJ, "node_modules", "typescript"));
const out = fs.mkdtempSync(path.join(os.tmpdir(), "publicidad-test-"));
for (const f of ["rentabilidad", "ml-ads", "publicidad-equilibrio", "publicidad-datos"]) { let js = ts.transpileModule(fs.readFileSync(`${PROJ}/lib/${f}.ts`, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText; js = js.replace(/require\("@\/lib\/([a-z-]+)"\)/g, 'require("./$1.js")'); fs.writeFileSync(path.join(out, f + ".js"), js); }
const P = require(path.join(out, "publicidad-equilibrio.js")); const D = require(path.join(out, "publicidad-datos.js"));
let ok = 0; const check = (c, m) => { assert.ok(c, m); ok++; console.log("  ✓", m); };
const near = (a, b, e = 0.051) => a !== null && Math.abs(a - b) <= e;
const fm = (id, o) => ({ id, titulo: id, full: false, unidades: 1, ingreso: 100000, precioProm: 11900, costo: 5950, comisionPct: 0.14, envioUnidad: 1190, envioFuente: "medido", margenPct: 26, estado: "ok", menosFiable: false, pierde: false, fueraDeAlcance: false, ...o });
const ad = (id, o) => ({ itemId: id, campaignId: 1, estado: "active", titulo: id, costo: 0, directas: 0, indirectas: 0, organicoUnidades: 0, organicoMonto: 0, ...o });
const camp = (id, o) => ({ id, nombre: "C" + id, estado: "active", estrategia: "PROFITABILITY", acosTarget: 26, presupuestoDiario: 5000, costo: 0, directas: 0, indirectas: 0, organicoMonto: 0, organicoUnidades: 0, acosMl: null, ...o });

console.log("IVA del gasto");
check(P.FACTOR_IVA_PUBLICIDAD === 1.19, "factor de IVA de la publicidad = 1,19 (verificado contra Billing)");
check(near(P.margenSiMayorNeto(fm("x")), 16.5), "margen si el Mayor fuera neto: 11.900 − 5.950×1,19 − 1.666 − 1.190 = 1.963,5 → 16,5% (contra 26,0% con Mayor bruto)");
check(P.margenSiMayorNeto(fm("x", { costo: null })) === null && P.margenSiMayorNeto(fm("x", { comisionPct: null })) === null && P.margenSiMayorNeto(fm("x", { envioUnidad: null })) === null, "sin Costo, comisión o envío: no se calcula (null), nunca se asume");

console.log("por anuncio");
const entrada = {
  campanas: [camp(1, { costo: 1000, directas: 8000, indirectas: 2000, organicoMonto: 40000, acosMl: 10 }), camp(2, { nombre: "Pausada", estado: "paused" })],
  anuncios: [
    ad("A", { costo: 600, directas: 5000, indirectas: 1000 }), ad("B", { costo: 400, directas: 3000, indirectas: 1000 }),
    ad("F", { costo: 100 }), ad("C", { organicoUnidades: 3 }), ad("D", {}), ad("E", { estado: "paused", organicoUnidades: 9 }),
  ],
  margenFilas: [fm("A", {}), fm("B", { costo: 10000, margenPct: -8, ingreso: 50000 })],
  fullPorItem: new Map([["A", true]]), ventasCuenta: 1000000, margenTotalPct: 5,
};
const r = P.analizarPublicidad(entrada); const A = r.filas.find((x) => x.id === "A"), Bf = r.filas.find((x) => x.id === "B"), F = r.filas.find((x) => x.id === "F");
check(A.gastoSinIva === 600 && near(A.gastoConIva, 714) && A.atribuidas === 6000 && A.acosMl === 10 && A.acosConIva === 11.9, "ACoS de ML = 600 / 6.000 = 10,0%; con IVA × 1,19 = 11,9%; gasto con IVA 714");
check(A.equilibrio === 26 && A.posicion === "bajo" && A.diferenciaPts === -14.1, "equilibrio = margen 26,0%: ACoS con IVA 11,9% queda 'bajo' el equilibrio (−14,1 pts)");
check(A.posicionSiMayorNeto === "bajo" && near(A.equilibrioSiMayorNeto, 16.5), "si el Mayor fuera neto el equilibrio baja a 16,5% (sigue 'bajo')");
check(near(A.tacosConIva, 0.7) && near(A.margenTrasPublicidad, 25.3) && A.full === true, "TACoS de la publicación = 714 / 100.000 = 0,7%; margen tras publicidad = 26,0 − 0,7 = 25,3 pts; Full según el mapa");
check(Bf.equilibrio === -8 && Bf.posicion === "sobre" && near(Bf.equilibrioSiMayorNeto, -24) && Bf.posicionSiMayorNeto === "sobre", "con margen −8%: ACoS 11,9% queda 'sobre' el equilibrio; si el Mayor fuera neto el margen sería −24%");
check(F.acosMl === null && F.acosConIva === null && F.equilibrio === null && F.posicion === null && /sin ventas/.test(F.motivoSinEquilibrio), "gasto sin ventas atribuidas ni ventas: ACoS y equilibrio null (sin NaN ni división por cero), con el motivo");
check(r.filas.map((x) => x.id).join() === "A,B,F", "solo anuncios con gasto, ordenados por gasto (600, 400, 100)");

console.log("por campaña y resumen");
const c1 = r.campanas.find((c) => c.id === 1), c2 = r.campanas.find((c) => c.id === 2);
check(c1.acosMl === 10 && c1.acosConIva === 11.9 && near(c1.gastoConIva, 1190) && c1.atribuidas === 10000, "campaña: ACoS de ML 10,0% (coincide con el `acos` de ML) y con IVA 11,9%");
check(near(c1.equilibrio, 12.4) && c1.coberturaEquilibrioPct === 100, "equilibrio de campaña = margen ponderado por ventas atribuidas: (26×6.000 − 8×4.000) / 10.000 = 12,4%");
check(near(c1.tacosConIva, 2.4) && c1.anunciosConGasto === 3, "TACoS de campaña = 1.190 / (10.000 atribuidas + 40.000 orgánicas) = 2,4%");
check(c2.acosMl === null && c2.acosConIva === null && c2.tacosConIva === null && c2.equilibrio === null && c2.gastoConIva === 0, "campaña sin gasto: todo null, sin NaN");
check(r.resumen.gasto.sinIva === 1000 && r.resumen.gasto.conIva === 1190 && r.resumen.acosMl === 10 && r.resumen.acosConIva === 11.9, "resumen: gasto $1.000 sin IVA / $1.190 con IVA; ACoS 10,0% → 11,9%");
check(r.resumen.tacosCuenta === 0.1 && r.resumen.margenAntes === 5 && r.resumen.margenDespues === 4.9, "TACoS de la cuenta = 1.190 / 1.000.000 = 0,1%; margen 5,0% → 4,9% (aproximado)");
check(r.resumen.sobreEquilibrio.anuncios === 1 && r.resumen.sobreEquilibrio.evaluables === 2 && near(r.resumen.sobreEquilibrio.pctGasto, 40, 0.06) && r.resumen.sobreEquilibrio.gastoConIva === 476, "sobre el equilibrio: 1 de 2 evaluables, gasto con IVA $476 = 40,0% del gasto evaluable");
check(r.resumen.anunciosActivosSinGasto.total === 2 && r.resumen.anunciosActivosSinGasto.conVentasOrganicas === 1, "anuncios activos sin gasto: 2 (los pausados no cuentan); 1 con ventas orgánicas");

console.log("cargadores (con ML simulado)");
(async () => {
  const llamadas = []; const mlGet = async (url, params) => { llamadas.push({ url, params });
    if (url.endsWith("/campaigns/search")) return { data: { results: [{ id: 7, name: "X", status: "active", strategy: "PROFITABILITY", acos_target: 20, daily_budget: 5000, metrics: { cost: 100, direct_amount: 800, indirect_amount: 200, organic_units_amount: 5000, organic_units_quantity: 4, acos: 10 } }] } };
    const off = params.offset; const n = 120; const items = Array.from({ length: Math.min(50, n - off) }, (_, i) => ({ item_id: "MLC" + (off + i), campaign_id: 7, status: "active", title: "t", metrics: { cost: off + i === 3 ? 50 : 0, direct_amount: 10, indirect_amount: 5, organic_units_quantity: 1, organic_units_amount: 99 } }));
    return { data: { paging: { total: n }, results: items } }; };
  const a = { advertiser_id: 1, site_id: "MLC" };
  const c = await D.cargarCampanasMl(mlGet, a, "2026-09-09", "2026-10-08");
  check(c.length === 1 && c[0].costo === 100 && c[0].directas === 800 && c[0].indirectas === 200 && c[0].organicoMonto === 5000 && c[0].presupuestoDiario === 5000 && c[0].acosTarget === 20, "campañas: costo, directas, indirectas, orgánicas, presupuesto y acos_target");
  check(llamadas[0].params.date_from === "2026-09-09" && llamadas[0].params.date_to === "2026-10-08" && /direct_amount/.test(llamadas[0].params.metrics), "pide la ventana y las métricas de ventas atribuidas");
  const an = await D.cargarAnunciosMl(mlGet, a, "2026-09-09", "2026-10-08");
  check(an.length === 120 && new Set(an.map((x) => x.itemId)).size === 120 && an.find((x) => x.itemId === "MLC3").costo === 50, "anuncios: pagina hasta traer los 120 (3 páginas), sin repetir, con sus métricas");
  console.log(`\n${ok} comprobaciones OK`);
})().catch((e) => { console.error("FALLÓ:", e.message); process.exit(1); });

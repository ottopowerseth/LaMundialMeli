// Pruebas de calculateAudit (C-12: la tasa usa solo cargos de ML; MP es informativo) con archivos SINTÉTICOS que reproducen la
// estructura de los reportes reales (xlsx de ML con el encabezado en la fila 8, csv de MP). Sin red ni Sheets.
// Uso:  node scripts/test-audit-calculo.mjs
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
const out = fs.mkdtempSync(path.join(os.tmpdir(), "audit-calculo-test-"));
fs.writeFileSync(path.join(out, "audit.js"), ts.transpileModule(fs.readFileSync(path.join(PROJ, "lib/audit.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);
const { parseAuditFiles, calculateAudit } = require(path.join(out, "audit.js"));
const XLSX = require("xlsx");
let ok = 0; const check = (c, m) => { assert.ok(c, m); ok++; console.log("  ✓", m); };

// ---- Archivos sintéticos (ciclo 2026-07 = 15-jun → 14-jul) ----
const ML_HEADER = ["N° de factura fiscal", "Fecha del cargo", "Numero del cargo", "Detalle", "Descontado de la operacion", "Estado del cargo", "Cargo que anula", "Valor del cargo", "Porcentaje por categoria", "Costo por categoria", "Costo fijo", "Subtotal sin descuento", "Valor del descuento", "Motivo del descuento", "Numero de venta", "Pago", "Fecha de venta", "Canal de Venta", "Cliente", "Cantidad vendida", "Precio unitario", "Precio mayorista", "Total de la venta", "Titulo de publicacion"];
const metadata = () => [["Fecha de actualizacion", "", "14-07-2026 10:00"], [], [], [], [], [], ["Informacion sobre cargos"]]; // 7 filas, como el reporte real
function filaML({ fecha, detalle, valor, venta = "", total = "", anula = "", estado = "" }) { const f = Array(ML_HEADER.length).fill(""); f[1] = fecha; f[2] = 1; f[3] = detalle; f[5] = estado; f[6] = anula; f[7] = valor; f[14] = venta; f[16] = venta ? fecha : ""; f[22] = total; f[23] = venta ? "Producto sintetico" : ""; return f; }
const ventas = [[ "15-06-2026", 10000, 1600], ["20-06-2026", 20000, 3200], ["25-06-2026", 30000, 4800], ["01-07-2026", 15000, 2400], ["10-07-2026", 25000, 4000], ["14-07-2026", 5000, 800]];
const filasML = [
  ...ventas.map(([fecha, total, cargo], i) => filaML({ fecha, detalle: "Cargo por venta", valor: cargo, venta: 2000000000001 + i, total })),
  ...[["15-06-2026", 5800], ["01-07-2026", 5800], ["14-07-2026", 4000]].map(([fecha, valor], i) => filaML({ fecha, detalle: "Cargo por envios de Mercado Libre", valor, venta: 2000000000001 + i, total: "" })),
  ...[["16-06-2026", 947], ["17-06-2026", 1394], ["18-06-2026", 915], ["19-06-2026", 1000]].map(([fecha, valor]) => filaML({ fecha, detalle: "Cargo por campana de publicidad de Product Ads", valor })),
  filaML({ fecha: "30-06-2026", detalle: "Cargo por mantenimiento de Mi pagina", valor: 3000 }),
  filaML({ fecha: "14-07-2026", detalle: "Anulacion del cargo por venta", valor: -800, venta: 2000000000006, anula: 12345 }),
  filaML({ fecha: "05-07-2026", detalle: "Cargo por devolucion", valor: 1200 }), // otro detalle: nunca se sumó
  filaML({ fecha: "10-05-2026", detalle: "Cargo por venta", valor: 9999, venta: 2000000009999, total: 77777 }), // fuera del ciclo: no cuenta
];
const xlsxBuf = (filas, header = ML_HEADER) => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([...metadata(), header, ...filas]), "Hoja1"); return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }); };
const MP_HEADER = ["N° de factura fiscal", "Fecha del cargo", "Numero del cargo", "Numero del movimiento", "Detalle", "Cobrado en la operacion", "Estado del cargo", "Cargo que anula", "Valor del cargo", "Tipo de operacion", "Operacion relacionada", "Tipo de pago", "Valor de la operacion"];
const mpRow = (fecha, detalle, valor, op, tipoPago, valorOp) => ["033-1", fecha, 1, 1, detalle, "Si", "", "", valor, "Venta", op, tipoPago, valorOp];
const filasMP = [
  mpRow("15-06-2026", "Cargo por cobrar con Mercado Pago", "2500.0", "111111111111", "Checkout", "100000.0"),
  mpRow("01-07-2026", "Cargo por cuotas", "1500.0", "222222222222", "Checkout", "60000.0"),
  mpRow("14-07-2026", "Cargo por cobrar con Mercado Pago", "1000.0", "333333333333", "PX", "40000.0"),
  mpRow("20-06-2026", "Cargo por cobrar con Mercado Pago", "9999.0", "444444444444", "CHO API TARJETAS SHOPIFY", "300000.0"), // otro canal: excluido
  mpRow("21-06-2026", "Cargo por cobrar con Mercado Pago", "777.0", "555555555555", "Link de pago", "20000.0"),                 // otro canal: excluido
];
const csv = (filas) => Buffer.from([MP_HEADER, ...filas].map((r) => r.map((c) => `"${c}"`).join(",")).join("\n"), "latin1");
const archivos = (extra = []) => [
  { name: "Reporte_Facturacion_MercadoLibre_Jul2026.xlsx", buffer: xlsxBuf(filasML) },
  { name: "Reporte_Facturacion_MercadoPago_Jul2026.csv", buffer: csv(filasMP) }, ...extra,
];

console.log("tasa = solo cargos de ML; MP informativo");
{ const r = calculateAudit("2026-07", parseAuditFiles(archivos()), undefined); const d = r.desglose_ml;
  check(!r.error_cobertura, "los archivos sintéticos cubren el ciclo (sin error de cobertura)");
  check(r.ventas_brutas === 105000, `ventas brutas = $105.000 (6 órdenes del ciclo; la de mayo, fuera del ciclo, no cuenta): ${r.ventas_brutas}`);
  check(d.cargo_por_venta === 16800 && d.envio === 15600 && d.publicidad_mantenimiento === 7256 && d.anulaciones === -800, `desglose: venta ${d.cargo_por_venta}, envío ${d.envio}, publicidad y mantenimiento ${d.publicidad_mantenimiento}, anulaciones ${d.anulaciones}`);
  check(d.otros_no_incluidos === 1200, `un cargo con otro detalle (devolución $1.200) se informa en «otros no incluidos» y NO se suma: ${d.otros_no_incluidos}`);
  check(r.comisiones_ml === 38856 && r.total_comisiones === 38856, `cargos de ML = 16.800 + 15.600 + 7.256 − 800 = $38.856 (total_comisiones = comisiones_ml): ${r.total_comisiones}`);
  check(r.comisiones_mp === 5000 && r.comisiones_mp_px === 1000, `MP se calcula como siempre (solo Checkout y PX; Shopify y Link de pago excluidos): $${r.comisiones_mp} (PX $${r.comisiones_mp_px})`);
  check(r.total_comisiones !== r.comisiones_ml + r.comisiones_mp, "…pero NO se suma al total");
  check(r.tasa_efectiva === 37.01, `tasa = 38.856 / 105.000 = ${r.tasa_efectiva} % (sin MP; con MP habría sido ${((38856 + 5000) / 105000 * 100).toFixed(2)} %)`);
  const suma = d.cargo_por_venta + d.envio + d.publicidad_mantenimiento + d.anulaciones + d.notas_credito + d.flex_credito + d.flex_debito;
  check(suma === r.comisiones_ml, `el desglose suma exactamente los cargos de ML: ${suma}`);
  check(/tasa de cargos ML 37.01%/.test(r.resumen) && /envío/.test(r.resumen) && /publicidad y mantenimiento/.test(r.resumen) && !/Com\. MP/.test(r.resumen), `el resumen etiqueta la tasa como «de cargos ML» y no menciona MP: «${r.resumen.slice(0, 120)}…»`); }

console.log("MP no mueve la tasa");
{ const sinMP = calculateAudit("2026-07", parseAuditFiles([{ name: "Reporte_Facturacion_MercadoLibre_Jul2026.xlsx", buffer: xlsxBuf(filasML) }, { name: "Reporte_Facturacion_MercadoPago_Jul2026.csv", buffer: csv([filasMP[0], filasMP[1]].map((f, i) => (i === 0 ? mpRow("15-06-2026", "Cargo por cobrar con Mercado Pago", "1.0", "1", "Checkout", "1.0") : mpRow("14-07-2026", "Cargo por cuotas", "1.0", "2", "Checkout", "1.0")))) }]), undefined);
  const gigante = calculateAudit("2026-07", parseAuditFiles([{ name: "Reporte_Facturacion_MercadoLibre_Jul2026.xlsx", buffer: xlsxBuf(filasML) }, { name: "Reporte_Facturacion_MercadoPago_Jul2026.csv", buffer: csv([mpRow("15-06-2026", "Cargo por cobrar con Mercado Pago", "5000000.0", "1", "Checkout", "9.0e7"), mpRow("14-07-2026", "Cargo por cuotas", "5000000.0", "2", "Checkout", "9.0e7")]) }]), undefined);
  check(sinMP.tasa_efectiva === 37.01 && gigante.tasa_efectiva === 37.01 && gigante.total_comisiones === 38856, `con comisiones MP de $2 o de $10.000.000 la tasa es la misma (37,01 %): ${sinMP.tasa_efectiva} / ${gigante.tasa_efectiva}`);
  check(gigante.comisiones_mp === 10_000_000, "…y MP sigue informándose ($10.000.000) en el resultado"); }

console.log("ventas de referencia de la API de ML");
{ const r = calculateAudit("2026-07", parseAuditFiles(archivos()), 210000); check(r.ventas_brutas === 210000 && r.tasa_efectiva === 18.5, `con ventas de referencia $210.000 la tasa es 38.856 / 210.000 = ${r.tasa_efectiva} %`); }

console.log("notas de crédito y Flex dentro del desglose");
{ const nc = { name: "Reporte_Notas_Credito_MercadoLibre_Jul2026.xlsx", buffer: xlsxBuf([filaML({ fecha: "20-06-2026", detalle: "Anulacion", valor: -500 })]) };
  const flexC = { name: "Reporte_Flex_Credito_Jul2026.xlsx", buffer: xlsxBuf([["", "", "", "", "", "", "", "300"]], ["a", "b", "c", "d", "e", "f", "g", "Monto"]) };
  const flexD = { name: "Reporte_Flex_Debito_Jul2026.xlsx", buffer: xlsxBuf([["", "", "", "", "", "", "", "200"]], ["a", "b", "c", "d", "e", "f", "g", "Monto"]) };
  const r = calculateAudit("2026-07", parseAuditFiles(archivos([nc, flexC, flexD])), undefined); const d = r.desglose_ml;
  check(d.notas_credito === -500 && d.flex_credito === -300 && d.flex_debito === 200, `NC ML −500, Flex crédito −300 y Flex débito +200 aparecen en el desglose: ${d.notas_credito} / ${d.flex_credito} / ${d.flex_debito}`);
  const suma = d.cargo_por_venta + d.envio + d.publicidad_mantenimiento + d.anulaciones + d.notas_credito + d.flex_credito + d.flex_debito;
  check(r.comisiones_ml === 38256 && suma === 38256 && r.total_comisiones === 38256, `cargos de ML = 38.856 − 500 − 300 + 200 = $38.256 y el desglose suma lo mismo: ${suma}`); }

console.log("piso en 0 cuando las NC superan los cargos");
{ const grande = { name: "Reporte_Notas_Credito_MercadoLibre_Jul2026.xlsx", buffer: xlsxBuf([filaML({ fecha: "20-06-2026", detalle: "Anulacion", valor: -99999999 })]) };
  const r = calculateAudit("2026-07", parseAuditFiles(archivos([grande])), undefined); const d = r.desglose_ml;
  const suma = d.cargo_por_venta + d.envio + d.publicidad_mantenimiento + d.anulaciones + d.notas_credito + d.flex_credito + d.flex_debito;
  check(r.comisiones_ml === 0 && suma === 0 && r.tasa_efectiva === 0, `cargos 0 (no negativos) y el desglose sigue cuadrando: ${r.comisiones_ml} / ${suma}`); }
console.log(`\n${ok} comprobaciones OK`);

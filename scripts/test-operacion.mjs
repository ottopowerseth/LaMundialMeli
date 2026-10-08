// Pruebas de lib/operacion.ts (sin red).
// Uso:  node scripts/test-operacion.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ts = require(path.join(PROJ, "node_modules", "typescript"));
const out = fs.mkdtempSync(path.join(os.tmpdir(), "operacion-test-"));
const js = ts.transpileModule(fs.readFileSync(`${PROJ}/lib/operacion.ts`, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText;
fs.writeFileSync(path.join(out, "o.js"), js);
const { armarDespachos, horasEntre, armarReclamo, armarPregunta, nivelReputacion } = require(path.join(out, "o.js"));
let ok = 0; const check = (c, m) => { assert.ok(c, m); ok++; console.log("  ✓", m); };

const AHORA = Date.parse("2026-10-08T20:00:00Z");
const d = (envioId, tipo, listoIso, extra = {}) => ({ envioId, ordenes: ["O" + envioId], titulos: ["T"], unidades: 1, tipoLogistico: tipo, estado: "ready_to_ship", subestado: "printed", listoIso, impresoIso: null, sla: null, ...extra });

console.log("despachos");
const cola = armarDespachos([
  d(1, "xd_drop_off", "2026-10-08T16:00:00Z"), // 4 h
  d(2, "xd_drop_off", "2026-10-06T20:00:00Z"), // 48 h
  d(3, "fulfillment", "2026-10-01T00:00:00Z", { subestado: "ready_to_pack" }), // Full: nunca accionable aunque lleve días
  d(4, "xd_drop_off", null), // sin fecha de listo → al final
  d(5, "xd_drop_off", "2026-10-07T20:00:00Z"), // 24 h
  d(6, "cross_docking", "2026-10-08T10:00:00Z"),
  d(7, "fulfillment", "2026-10-08T10:00:00Z", { subestado: "packed" }),
], AHORA);
check(cola.accionables.map((x) => x.envioId).join(",") === "2,5,1,4", "accionables = solo xd_drop_off, ordenados por horas desde listo (más espera primero), sin fecha al final");
check(cola.accionables.map((x) => x.horasDesdeListo).join(",") === "48,24,4,", "las horas salen de ahora − date_ready_to_ship");
check(cola.full.total === 2 && cola.full.porSubestado.ready_to_pack === 1 && cola.full.porSubestado.packed === 1, "Full se cuenta aparte por subestado, sin entrar a la cola");
check(cola.otros.total === 1 && cola.otros.porTipo.cross_docking === 1, "otros tipos logísticos se cuentan aparte");
check(!cola.accionables.some((x) => x.tipoLogistico !== "xd_drop_off"), "ningún Full ni otro tipo aparece como accionable");
check(armarDespachos([], AHORA).accionables.length === 0, "sin despachos → cola vacía");
check(horasEntre("2026-10-09T00:00:00Z", AHORA) === 0, "una fecha futura (desfase de reloj) no da horas negativas");
check(horasEntre("basura", AHORA) === null && horasEntre(null, AHORA) === null, "fecha ausente o inválida → null");
const conSla = armarDespachos([d(9, "xd_drop_off", "2026-10-08T16:00:00Z", { sla: { estado: "on_time", plazoEntregaComprador: "2026-10-23T16:00:00-03:00" } })], AHORA);
check(conSla.accionables[0].sla.estado === "on_time" && conSla.accionables[0].sla.plazoEntregaComprador.startsWith("2026-10-23"), "el estado SLA de ML y su expected_date pasan tal cual, como dato");

console.log("reclamos");
const r = armarReclamo({ id: 55, type: "mediations", stage: "dispute", reason_id: "PDD9946", resource: "order", resource_id: 2000018730214582, date_created: "2026-10-01T10:00:00Z", last_updated: "2026-10-02T10:00:00Z" }, "affected", "Llegó bien");
check(r.id === 55 && r.motivo === "Llegó bien" && r.afectaReputacion === "affected" && r.ordenId === "2000018730214582", "reclamo con motivo, affects_reputation y orden");
check(armarReclamo({ id: 1, resource: "shipment", resource_id: 9 }, null, null).ordenId === null, "si el recurso no es una orden no se inventa orden");
check(armarReclamo({ id: 2 }, null, null).tipo === "sin_dato" && armarReclamo({ id: 2 }, null, null).afectaReputacion === null, "campos ausentes → sin_dato / null, sin inventar");

console.log("preguntas");
const p = armarPregunta({ id: 7, item_id: "MLC1", text: "¿tienen?", date_created: "2026-06-26T12:00:00Z" }, { title: "X", status: "paused", sub_status: ["out_of_stock"] }, AHORA);
check(p.diasSinResponder === 104 && p.itemEstado === "paused" && p.itemSubestado[0] === "out_of_stock", "días sin responder y estado de la publicación como dato");
check(armarPregunta({ id: 8, item_id: "MLC2" }, null, AHORA).diasSinResponder === null && armarPregunta({ id: 8, item_id: "MLC2" }, null, AHORA).itemTitulo === null, "sin fecha ni publicación → null");

console.log("reputación");
check(nivelReputacion({ seller_reputation: { level_id: "5_green" } }) === "5_green", "devuelve level_id tal cual");
check(nivelReputacion({}) === null && nivelReputacion({ seller_reputation: null }) === null, "sin reputación → null");

console.log(`\n${ok} comprobaciones OK`);

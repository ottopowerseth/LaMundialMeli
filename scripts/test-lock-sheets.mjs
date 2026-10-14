// Pruebas de lib/lock-sheets.ts (S-08): lock tipo ticket sobre una pestaña, con una hoja EN MEMORIA y contendientes concurrentes
// simulados (retardos aleatorios deterministas entre cada paso). No llama a Sheets ni a Mercado Libre.
// Uso:  node scripts/test-lock-sheets.mjs
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
const out = fs.mkdtempSync(path.join(os.tmpdir(), "lock-sheets-"));
const compilar = (origen, destino) => {
  const src = fs.readFileSync(path.join(PROJ, origen), "utf8").replace(/from "@\/lib\/([\w-]+)"/g, 'from "./$1"');
  fs.writeFileSync(path.join(out, destino), ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);
};
for (const [o, d] of [["lib/log.ts", "log.js"], ["lib/guardas-filas.ts", "guardas-filas.js"], ["lib/lock-sheets.ts", "lock-sheets.js"], ["lib/sheets.ts", "sheets.js"]]) compilar(o, d);
// lock-sheets importa lib/sheets: para esa parte se usa el real con googleapis simulado (solo borrarFilasHoja se ejercita aquí).
fs.mkdirSync(path.join(out, "node_modules", "googleapis"), { recursive: true });
fs.writeFileSync(path.join(out, "node_modules", "googleapis", "index.js"), `exports.google = { auth: { GoogleAuth: class {} }, sheets: () => ({ spreadsheets: {
  get: async () => ({ data: { sheets: [{ properties: { title: "Locks", sheetId: 77 } }] } }),
  values: { append: async (r) => { globalThis.__appends.push(r); if (globalThis.__cuota429) throw Object.assign(new Error("Quota exceeded for quota metric 'Write requests'"), { code: 429 }); return {}; },
    get: async () => ({ data: { values: [["Clave"]] } }) },
  batchUpdate: async (r) => { globalThis.__peticiones.push(r.requestBody.requests); return {}; } } }) };`);
const L = require(path.join(out, "lock-sheets.js")); const Sh = require(path.join(out, "sheets.js"));
let ok = 0; const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); ok++; console.log("  ✓", m); };
const check = (c, m) => { assert.ok(c, m); ok++; console.log("  ✓", m); };
const silencio = async (fn) => { const e = console.error, w = console.warn; console.error = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.error = e; console.warn = w; } };

// ---- hoja Locks en memoria + deps con retardos aleatorios deterministas ----
function prng(semilla) { let s = semilla >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function nuevoMundo({ semilla = 1, retardoMax = 4, ahoraMs = Date.UTC(2026, 9, 14, 12, 0, 0) } = {}) {
  const w = { hoja: [], reloj: ahoraMs, llamadas: { agregar: 0, leer: 0, leerTokens: 0, marcar: 0, borrar: 0 }, falla: {}, antesDe: {}, n: 0 };
  const rnd = prng(semilla); const dorm = () => new Promise((r) => setTimeout(r, rnd() * retardoMax));
  const hook = async (nombre) => { if (w.antesDe[nombre]) { const f = w.antesDe[nombre]; w.antesDe[nombre] = null; await f(); } if (w.falla[nombre]) throw new Error("falla simulada en " + nombre); };
  w.deps = () => ({
    asegurarHoja: async () => { await hook("asegurar"); },
    agregar: async (fila) => { w.llamadas.agregar++; await dorm(); await hook("agregar"); w.hoja.push([...fila]); await dorm(); },
    leer: async () => { w.llamadas.leer++; await dorm(); await hook("leer"); const snap = w.hoja.map((f) => [...f]); await dorm(); return snap; },
    leerTokens: async (hasta) => { w.llamadas.leerTokens++; await dorm(); await hook("leerTokens"); const snap = w.hoja.slice(0, hasta - 1).map((f) => [f[1]]); await dorm(); return snap; },
    marcarLiberado: async (fila) => { w.llamadas.marcar++; await hook("marcar"); if (!w.hoja[fila - 2]) throw new Error("fila inexistente " + fila); w.hoja[fila - 2][3] = "x"; await dorm(); },
    borrarFilas: async (filas) => { w.llamadas.borrar++; await hook("borrar"); for (const f of [...new Set(filas)].sort((a, b) => b - a)) w.hoja.splice(f - 2, 1); },
    ahora: () => w.reloj, nuevoToken: () => `${++w.n}-${Math.floor(rnd() * 1e9)}`, timeoutMs: 2000,
  });
  return w;
}
const s = (w) => Math.floor(w.reloj / 1000);
const activos = (w, clave) => w.hoja.filter((f) => f[0] === clave && !f[3]).length;

console.log("un solo contendiente");
{ const w = nuevoMundo(); const r = await L.conLock("ml-sync", async () => "listo", w.deps());
  eq([r.ok, r.valor], [true, "listo"], "gana y devuelve el valor de la tarea");
  eq(w.hoja.map((f) => [f[0], f[3]]), [["ml-sync", "x"]], "deja su ticket liberado");
  check(w.hoja[0][1].startsWith("tk-") && w.hoja[0][2] === s(w) + 90, "el ticket es texto 'tk-…' (no se interpreta como número/fecha) y vence a los 90 s"); }

console.log("10 contendientes simultáneos: gana exactamente uno, los demás reciben 409 inmediato (200 corridas con retardos distintos)");
{ let peor = 0; let todasBien = true; let sondeos = 0;
  for (let semilla = 1; semilla <= 200; semilla++) {
    const w = nuevoMundo({ semilla }); let corriendo = 0, maxSimultaneas = 0, ejecutadas = 0;
    const tarea = async () => { corriendo++; maxSimultaneas = Math.max(maxSimultaneas, corriendo); ejecutadas++; await new Promise((r) => setTimeout(r, 30)); corriendo--; };
    const res = await Promise.all(Array.from({ length: 10 }, () => L.conLock("audit:2026-06", tarea, w.deps())));
    const gan = res.filter((r) => r.ok).length; const pierden = res.filter((r) => !r.ok);
    if (gan !== 1 || ejecutadas !== 1 || maxSimultaneas !== 1 || pierden.some((p) => p.status !== 409)) { todasBien = false; console.log("   semilla", semilla, { gan, ejecutadas, maxSimultaneas }); }
    if (activos(w, "audit:2026-06") !== 0) todasBien = false;
    peor = Math.max(peor, Math.max(...[w.llamadas.leer]));
    sondeos = Math.max(sondeos, w.llamadas.leer);
  }
  check(todasBien, "en las 200 corridas: 1 ganador, la tarea corrió 1 vez, nunca 2 a la vez, los otros 9 con 409, y no queda ningún ticket activo");
  check(sondeos <= 10 * 3 + 5, `sin sondeo: como máximo ${sondeos} lecturas de la hoja para 10 contendientes (cada perdedor lee una vez y otra para liberar)`); }

console.log("el perdedor libera su ticket al instante: tras ganar y liberar el primero, el siguiente gana sin esperar el vencimiento");
{ const w = nuevoMundo(); const gana = await L.adquirirLock("ml-sync", w.deps()); const pierde = await L.adquirirLock("ml-sync", w.deps());
  eq([gana.ok, pierde.ok, pierde.status], [true, false, 409], "el segundo recibe 409 mientras el primero sigue");
  check(/Ya hay otro proceso ejecutando «ml-sync»/.test(pierde.mensaje) && /No se ejecutó nada/.test(pierde.mensaje), "con mensaje claro: «" + pierde.mensaje + "»");
  await L.liberarTicket(gana.ticket, w.deps()); const tercero = await L.adquirirLock("ml-sync", w.deps());
  check(tercero.ok, "tras liberar el primero, el tercero gana de inmediato (el ticket del perdedor no lo bloquea)"); }

console.log("claves por concern no se bloquean entre sí");
{ const w = nuevoMundo(); const a = await L.adquirirLock("ml-sync", w.deps()); const b = await L.adquirirLock("audit:2026-06", w.deps()); const c = await L.adquirirLock("audit:2026-07", w.deps()); const d = await L.adquirirLock("rentabilidad:2026-06", w.deps());
  eq([a.ok, b.ok, c.ok, d.ok], [true, true, true, true], "ml-sync, audit:{mes} de meses distintos y rentabilidad:{mes} pueden correr a la vez");
  const e = await L.adquirirLock("audit:2026-06", w.deps()); eq([e.ok, e.status], [false, 409], "pero el mismo audit:2026-06 sí queda bloqueado"); }

console.log("falla al adquirir → falla cerrado (la tarea no corre)");
{ for (const paso of ["asegurar", "agregar", "leer"]) {
    const w = nuevoMundo(); if (paso === "leer") w.antesDe.leer = async () => { throw new Error("falla pasajera"); }; else w.falla[paso] = true; let corrio = false;
    const r = await silencio(() => L.conLock("ml-sync", async () => { corrio = true; }, w.deps()));
    eq([r.ok, r.status, corrio], [false, 503, false], `Sheets falla en «${paso}»: 503 y la tarea NO se ejecutó`);
    check(/no se ejecutó nada/.test(r.mensaje), "   mensaje: «" + r.mensaje + "»");
    if (paso !== "agregar") check(activos(w, "ml-sync") === (paso === "asegurar" ? 0 : 0), "   no deja ticket activo (falla pasajera: se libera el que alcanzó a agregarse)"); }
  { const w = nuevoMundo(); w.falla.leer = true; const r = await silencio(() => L.adquirirLock("ml-sync", w.deps()));
    eq([r.ok, r.status, activos(w, "ml-sync")], [false, 503, 1], "con Sheets caído de forma permanente el ticket agregado no se puede liberar y queda activo…");
    w.falla.leer = false; const r2 = await L.adquirirLock("ml-sync", w.deps()); eq(r2.status, 409, "…bloquea a los demás mientras no venza…"); w.reloj += 91000;
    const r3 = await L.adquirirLock("ml-sync", w.deps()); check(r3.ok, "…y deja de bloquear solo a los 91 s (límite documentado)"); }
  { const w = nuevoMundo(); w.antesDe.leer = () => new Promise(() => {}); const deps = w.deps(); deps.timeoutMs = 50; let corrio = false;
    const t0 = Date.now(); const r = await silencio(() => L.conLock("ml-sync", async () => { corrio = true; }, deps));
    eq([r.ok, r.status, corrio], [false, 503, false], "Sheets no responde: el timeout corta y falla cerrado"); check(Date.now() - t0 < 1500, "sin quedarse colgado"); }
  { const w = nuevoMundo(); let n = 0; const d = w.deps(); const leerOriginal = d.leer; d.leer = async () => { n++; const f = await leerOriginal(); return n === 1 ? f.filter((x) => !String(x[1]).startsWith("tk-")) : f; };
    const r = await silencio(() => L.adquirirLock("ml-sync", d)); eq([r.ok, r.status], [false, 503], "si al releer no aparece el ticket propio, falla cerrado (no asume que ganó)"); } }

console.log("si falla la adquisición se olvida que la pestaña estaba lista (se rehace sola si alguien la borró)");
{ const w = nuevoMundo(); let olvidos = 0; const d = w.deps(); d.olvidarHoja = () => { olvidos++; }; w.falla.agregar = true; await silencio(() => L.adquirirLock("ml-sync", d));
  const w2 = nuevoMundo(); const d2 = w2.deps(); d2.olvidarHoja = () => { olvidos++; }; const leerOriginal = d2.leer; let n = 0; d2.leer = async () => { n++; const f = await leerOriginal(); return n === 1 ? [] : f; }; await silencio(() => L.adquirirLock("ml-sync", d2));
  eq(olvidos, 2, "tanto con error de Sheets como cuando el ticket propio no aparece al releer"); }

console.log("liberación siempre, también si la tarea lanza");
{ const w = nuevoMundo(); await assert.rejects(() => L.conLock("audit:2026-06", async () => { throw new Error("boom"); }, w.deps()), /boom/); ok++; console.log("  ✓ el error de la tarea se propaga");
  eq(activos(w, "audit:2026-06"), 0, "el ticket quedó liberado"); const r = await L.conLock("audit:2026-06", async () => 1, w.deps()); check(r.ok, "y el siguiente puede adquirir"); }
{ const w = nuevoMundo(); const d = w.deps(); w.falla.marcar = true;
  const r = await silencio(() => L.conLock("ml-sync", async () => "ok", d)); eq([r.ok, r.valor], [true, "ok"], "si la liberación falla, el resultado de la tarea no se pierde");
  const r2 = await silencio(() => L.adquirirLock("ml-sync", w.deps())); eq([r2.ok, r2.status], [false, 409], "y el ticket sin liberar bloquea hasta que venza…"); w.reloj += 91000; w.falla.marcar = false;
  const r3 = await L.adquirirLock("ml-sync", w.deps()); check(r3.ok, "…y a los 91 s ya no bloquea"); }

console.log("ticket vencido");
{ const w = nuevoMundo(); w.hoja.push(["ml-sync", "tk-viejo", s(w) - 5, ""]); const r = await L.adquirirLock("ml-sync", w.deps()); check(r.ok, "un ticket vencido hace 5 s no bloquea");
  const w2 = nuevoMundo(); w2.hoja.push(["ml-sync", "tk-vivo", s(w2) + 30, ""]); const r2 = await L.adquirirLock("ml-sync", w2.deps()); eq([r2.ok, r2.status], [false, 409], "uno que vence en 30 s sí bloquea");
  check(/30 s/.test(r2.mensaje), "el 409 dice cuánto falta como máximo: «" + r2.mensaje + "»");
  const w3 = nuevoMundo(); w3.hoja.push(["ml-sync", "tk-basura", "no-es-numero", ""], ["ml-sync", "tk-lib", s(w3) + 80, "x"]); const r3 = await L.adquirirLock("ml-sync", w3.deps()); check(r3.ok, "un vencimiento ilegible y uno liberado se ignoran"); }

console.log("limpieza en lote: solo tickets de hace más de ~10 min, verificando el token");
{ const w = nuevoMundo(); const t = s(w);
  w.hoja.push(["ml-sync", "tk-lib-viejo", t - 700, "x"], ["audit:2026-05", "tk-cad-viejo", t - 900, ""], ["ml-sync", "tk-lib-reciente", t - 100, "x"], ["ml-sync", "tk-cad-reciente", t - 300, ""], ["rentabilidad:2026-06", "tk-vivo", t + 50, ""]);
  const r = await L.adquirirLock("ml-sync", w.deps()); check(r.ok, "la adquisición gana");
  eq(w.hoja.map((f) => f[1]).filter((x) => x !== r.ticket.token), ["tk-lib-reciente", "tk-cad-reciente", "tk-vivo"], "se borraron el liberado viejo y el caducado viejo; quedaron el liberado reciente, el caducado reciente y el vivo");
  eq(w.llamadas.borrar, 1, "un solo borrado en lote"); }
{ const w = nuevoMundo(); const t = s(w); w.hoja.push(["x", "tk-a", t - 1000, "x"], ["x", "tk-b", t - 1000, ""], ["x", "tk-c", t + 60, ""]);
  w.antesDe.leerTokens = async () => { w.hoja.splice(0, 1); }; // otro proceso borra una fila de arriba entre la lectura y la verificación
  const antes = w.hoja.length; const r = await L.adquirirLock("ml-sync", w.deps());
  check(r.ok, "la adquisición gana igual"); eq(w.llamadas.borrar, 0, "con la hoja corrida, el token no coincide y NO se borra nada (sin daño colateral)");
  check(w.hoja.some((f) => f[1] === "tk-c") && w.hoja.some((f) => f[1] === "tk-b"), "los tickets ajenos siguen ahí"); }
{ const w = nuevoMundo(); const t = s(w); w.hoja.push(["x", "tk-a", t - 1000, "x"]); w.falla.borrar = true;
  const r = await silencio(() => L.adquirirLock("ml-sync", w.deps())); check(r.ok, "si la limpieza falla, la adquisición NO falla"); }
{ const w = nuevoMundo(); const t = s(w); w.hoja.push(["x", "tk-a", t - 1000, "x"]); const d = w.deps(); const original = d.leerTokens; let n = 0;
  d.leerTokens = async (h) => { n++; if (n === 1) throw new Error("falla simulada"); return original(h); };
  const r = await silencio(() => L.adquirirLock("ml-sync", d)); check(r.ok, "tampoco falla si la verificación de la limpieza falla"); }

console.log("ahorro de cuota: con la posición ya conocida se libera con 1 lectura; si la pista quedó vieja, se busca por token");
{ const w = nuevoMundo(); const a = await L.adquirirLock("ml-sync", w.deps()); const antes = w.llamadas.leer + w.llamadas.leerTokens;
  await L.liberarTicket(a.ticket, w.deps()); eq([w.llamadas.leer + w.llamadas.leerTokens - antes, w.hoja[0][3]], [1, "x"], "liberar usa 1 sola lectura (verificación del token en la fila conocida)");
  const w2 = nuevoMundo(); const b = await L.adquirirLock("ml-sync", w2.deps()); w2.hoja.unshift(["z", "tk-ajeno", s(w2) + 60, ""]); // la pista quedó vieja: la hoja se corrió
  await L.liberarTicket(b.ticket, w2.deps()); eq(w2.hoja.map((f) => [f[1] === b.ticket.token ? "mio" : f[1], f[3]]), [["tk-ajeno", ""], ["mio", "x"]], "con la pista vieja no escribe en la fila equivocada: la verificación falla y lo busca por token");
  const w3 = nuevoMundo(); const res = await Promise.all(Array.from({ length: 10 }, () => L.conLock("ml-sync", async () => { await new Promise((r) => setTimeout(r, 20)); }, w3.deps())));
  check(res.filter((r) => r.ok).length === 1 && w3.llamadas.leer + w3.llamadas.leerTokens <= 10 * 2 + 1, "10 contendientes gastan como máximo 2 lecturas cada uno (" + (w3.llamadas.leer + w3.llamadas.leerTokens) + " en total)"); }

console.log("liberación por token, nunca por posición");
{ const w = nuevoMundo(); w.hoja.push(["a", "tk-1", s(w) - 2000, "x"], ["a", "tk-2", s(w) - 2000, "x"]); const a = await L.adquirirLock("ml-sync", w.deps());
  check(a.ok, "gana (la limpieza ya borró las 2 filas de arriba, así que su fila se corrió)"); eq(w.hoja.length, 1, "la hoja quedó con solo su ticket");
  w.hoja.unshift(["z", "tk-ajeno-1", s(w) + 60, ""], ["z", "tk-ajeno-2", s(w) + 60, ""]); // aparecen filas arriba: su fila vuelve a correrse
  await L.liberarTicket(a.ticket, w.deps()); eq(w.hoja.map((f) => [f[1] === a.ticket.token ? "mio" : f[1], f[3]]), [["tk-ajeno-1", ""], ["tk-ajeno-2", ""], ["mio", "x"]], "se liberó exactamente el ticket propio y los ajenos quedaron intactos"); }
{ const w = nuevoMundo(); const a = await L.adquirirLock("ml-sync", w.deps());
  w.antesDe.leerTokens = async () => { w.hoja.unshift(["z", "tk-ajeno", s(w) + 60, ""]); }; // la hoja se corre ENTRE buscar y escribir
  const lib = await L.liberarTicket(a.ticket, w.deps()); check(lib, "si la hoja se corre justo antes de escribir, la verificación lo detecta, relee y libera la fila correcta");
  eq(w.hoja.map((f) => [f[1] === a.ticket.token ? "mio" : f[1], f[3]]), [["tk-ajeno", ""], ["mio", "x"]], "sin marcar liberado el ticket ajeno"); }

console.log("vencimiento leído de una planilla es_ES: parseo tolerante");
{ const P = L.parsearVence; const x = 1760443200;
  eq([P(1760443200), P("1760443200"), P("1.760.443.200"), P("1 760 443 200"), P("1\u00a0760\u00a0443\u00a0200"), P("1\u202f760\u202f443\u202f200"), P(" 1760443200 ")], [x, x, x, x, x, x, x], "número, texto plano, miles con punto y miles con espacios (normal, nbsp y de ancho fijo) dan el mismo entero");
  eq([P("1.760.443.200,0"), P("1760443200,0")], [x, x], "con coma decimal es_ES también");
  eq([P(""), P(undefined), P(null), P("abc"), P("12.34.56")].map((n) => Number.isNaN(n)), [true, true, true, true, true], "vacío, ausente y basura dan NaN (se trata como vencido)");
  const w = nuevoMundo(); w.hoja.push(["ml-sync", "tk-miles", "1.760.443.200", ""]); w.reloj = (x - 30) * 1000;
  const r = await L.adquirirLock("ml-sync", w.deps()); eq([r.ok, r.status], [false, 409], "un ticket con el vencimiento escrito con puntos de miles sigue contando como vigente"); }

console.log("append del lock: INSERT_ROWS (appends simultáneos no se pisan); el resto de los llamadores no cambia");
{ process.env.GOOGLE_SHEET_ID = "hoja-falsa"; globalThis.__appends = []; await L.depsPorDefecto("Locks").agregar(["k", "tk-1", 1760443200, ""]);
  eq([globalThis.__appends[0].insertDataOption, globalThis.__appends[0].range, globalThis.__appends[0].valueInputOption], ["INSERT_ROWS", "Locks!A:D", "USER_ENTERED"], "el ticket se agrega con INSERT_ROWS");
  globalThis.__appends = []; await Sh.appendSheet("ShippingCache!A:D", [["a"]]); eq("insertDataOption" in globalThis.__appends[0], false, "appendSheet sin opciones sigue sin insertDataOption (comportamiento anterior)"); }

console.log("cuota de Sheets (429) al adquirir: falla cerrado con 503 y mensaje claro, sin colgarse");
{ process.env.GOOGLE_SHEET_ID = "hoja-falsa"; globalThis.__appends = []; globalThis.__cuota429 = true;
  const d = L.depsPorDefecto("Locks"); d.timeoutMs = 300; let corrio = false; const t0 = Date.now();
  const r = await silencio(() => L.conLock("ml-sync", async () => { corrio = true; }, d));
  eq([r.ok, r.status, corrio], [false, 503, false], "429 en el append (con los reintentos reales de lib/sheets en curso): 503 y la tarea NO corre");
  check(Date.now() - t0 < 3000, "responde enseguida (corta por el timeout de " + d.timeoutMs + " ms), no espera los reintentos de 10-30 s de Sheets");
  check(/No se pudo verificar el bloqueo de «ml-sync»/.test(r.mensaje) && /no se ejecutó nada/.test(r.mensaje), "mensaje: «" + r.mensaje + "»");
  globalThis.__cuota429 = false; }
{ const w = nuevoMundo(); const d = w.deps(); const leerOriginal = d.leer; d.leer = async () => { throw Object.assign(new Error("Quota exceeded for quota metric 'Read requests'"), { code: 429 }); };
  let corrio = false; const r = await silencio(() => L.conLock("ml-sync", async () => { corrio = true; }, d)); eq([r.ok, r.status, corrio], [false, 503, false], "429 en la lectura posterior al append: 503 y la tarea NO corre"); }

console.log("pestaña nueva: carrera de dos contendientes creándola a la vez");
{ let creada = false; const ensure1 = async () => { if (creada) throw new Error("ya existe una hoja con ese nombre"); creada = true; };
  let encabezados = 0; const leer = async () => []; const esc = async () => { encabezados++; };
  let intentos = 0; const ensureCarrera = async () => { intentos++; if (intentos === 1) throw new Error("A sheet with the name \"Locks\" already exists"); };
  await L.asegurarHojaLocks(ensureCarrera, leer, esc); eq([intentos, encabezados], [2, 1], "si el primer intento falla porque la otra ya la creó, reintenta una vez y sigue (escribe el encabezado)");
  await assert.rejects(() => L.asegurarHojaLocks(async () => { throw new Error("sin permisos"); }, leer, esc), /sin permisos/); ok++; console.log("  ✓ si falla dos veces, el error se propaga (falla cerrado)");
  encabezados = 0; await L.asegurarHojaLocks(ensure1, async () => [["Clave"]], esc); eq(encabezados, 0, "si A1 ya tiene encabezado no lo reescribe"); }

console.log("borrarFilasHoja (lib/sheets): filas 1-based, de abajo hacia arriba, sin repetidas, en una sola llamada");
{ process.env.GOOGLE_SHEET_ID = "hoja-falsa"; globalThis.__peticiones = [];
  await Sh.borrarFilasHoja("Locks", [3, 9, 3, 5]); const rq = globalThis.__peticiones[0];
  eq(rq.map((q) => [q.deleteDimension.range.startIndex, q.deleteDimension.range.endIndex, q.deleteDimension.range.sheetId]), [[8, 9, 77], [4, 5, 77], [2, 3, 77]], "9, 5, 3 (descendente, sin repetir) con índices 0-based y sheetId 77");
  await assert.rejects(() => Sh.borrarFilasHoja("Locks", [1]), /enteros >= 2/); ok++; console.log("  ✓ rechaza la fila 1 (encabezado)");
  await assert.rejects(() => Sh.borrarFilasHoja("Locks", [2.5]), /enteros >= 2/); ok++; console.log("  ✓ rechaza filas no enteras");
  globalThis.__peticiones = []; await Sh.borrarFilasHoja("Locks", []); eq(globalThis.__peticiones.length, 0, "lista vacía: no llama a la API"); }

console.log(`\n${ok} comprobaciones OK`);
process.exit(0); // los reintentos de cuota simulados siguen durmiendo en segundo plano

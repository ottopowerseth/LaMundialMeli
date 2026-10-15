// HERRAMIENTA DE UN SOLO USO — C-16: RESTAURACIÓN de Rentabilidad!J:K desde la pestaña «Rentabilidad RESPALDO <SUFIJO>». Solo por si la aplicación de C-16 sale mal.
// Escrita para una corrección puntual de la planilla de producción (2026-10-15); se conserva como registro. NO ejecutar sin autorización explícita de Otto.
// Los planes y registros van a la carpeta temporal (nunca al repo). Las pruebas (test-restaurar-margen-c16.mjs) usan planillas SINTÉTICAS y una API simulada.
//
// USO
//   node scripts/una-vez/restaurar-margen-c16.mjs --plan=RUTA --respaldo=SUFIJO                         ENSAYO (por defecto): SOLO LECTURA. Dice qué filas están aplicadas y qué restauraría.
//   node scripts/una-vez/restaurar-margen-c16.mjs --plan=RUTA --respaldo=SUFIJO --aplicar [--lote=20] [--pausa-ms=2500]
// El plan es el del ensayo de C-16 (sirve solo para saber QUÉ FILAS son: el valor «antes» se lee de la pestaña de respaldo, y se exige que coincida con el del plan).
// Garantías de --aplicar:
//   1. Se niega si: el plan está alterado o es de otra planilla; falta la pestaña de respaldo; el respaldo no guarda en J:K de esas filas un TEXTO igual al «antes» del plan (o sus entradas C, E–I difieren);
//      la hoja viva tiene CUALQUIER cambio (valor, texto mostrado o formato) fuera de J:K de las filas del plan; o una fila del plan no está ni «aplicada» ni «restaurada».
//   2. Se niega si hay tickets activos de rentabilidad:*, audit:* o ml-sync; cada lote corre DENTRO del lock «ml-sync».
//   3. Solo escribe J:K de las filas aplicadas, como TEXTO (stringValue, el efecto del apóstrofo de numeroComoTexto), un spreadsheets.batchUpdate atómico por lote, y solo «userEnteredValue».
//   4. Justo antes de cada lote relee cada fila: si ya no está aplicada ni restaurada, el lote NO se escribe y se detiene. Reanudable: las filas ya restauradas se saltan.
//   5. Verificación final: la hoja viva queda IDÉNTICA al respaldo en toda la hoja (valor interno, texto mostrado y formato de número de A1:Z) y la tarjeta es la del respaldo.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import Module, { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { tarjeta, leerFilas } from "./margen-c16-nucleo.mjs";
import { L, compararGrids, esTextoSinFormato, estadoFila, texto, mostrado } from "./restauracion-c16-nucleo.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RAIZ_API = process.env.C16_RAIZ ? path.resolve(process.env.C16_RAIZ) : REPO; // C16_RAIZ: solo para probar el script contra una API simulada
const requireRepo = createRequire(path.join(REPO, "package.json")); const requireApi = createRequire(path.join(RAIZ_API, "package.json"));
const log = (...a) => console.log(...a); const dormir = (ms) => new Promise((r) => setTimeout(r, ms)); const hash = (x) => crypto.createHash("sha256").update(typeof x === "string" ? x : JSON.stringify(x)).digest("hex");

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const APLICAR = args.aplicar === true; const LOTE = Math.min(50, Math.max(1, Number(args.lote ?? 20))); const PAUSA_MS = Number(args["pausa-ms"] ?? 2500);
const desconocidos = Object.keys(args).filter((k) => !["aplicar", "plan", "respaldo", "lote", "pausa-ms"].includes(k)); if (desconocidos.length) { console.error("Argumentos desconocidos: " + desconocidos.join(", ")); process.exit(2); }
if (typeof args.plan !== "string" || typeof args.respaldo !== "string") { console.error("Se necesita --plan=RUTA (el del ensayo de C-16) y --respaldo=SUFIJO (pestaña «Rentabilidad RESPALDO <SUFIJO>»). Sin --aplicar solo hace el ensayo (solo lectura). No se hizo nada."); process.exit(2); }

const ts = requireRepo("typescript"); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "restaurar-c16-"));
for (const f of ["log", "sheets", "guardas-filas", "lock-sheets"]) { const src = fs.readFileSync(path.join(REPO, "lib", f + ".ts"), "utf8").replace(/from "@\/lib\/([\w-]+)"/g, 'from "./$1"'); fs.writeFileSync(path.join(tmp, f + ".js"), ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText); }
if (!process.env.C16_RAIZ) { for (const linea of fs.readFileSync(path.join(REPO, ".env.local"), "utf-8").split("\n")) { const [k, ...r] = linea.split("="); if (k && r.length) process.env[k.trim()] = r.join("=").trim(); } }
process.env.NODE_PATH = [path.join(RAIZ_API, "node_modules"), path.join(REPO, "node_modules")].join(path.delimiter); Module._initPaths();
const { google } = requireApi("googleapis"); const spreadsheetId = process.env.GOOGLE_SHEET_ID;
const auth = new google.auth.GoogleAuth({ credentials: { client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/^"|"$/g, "") }, scopes: [APLICAR ? "https://www.googleapis.com/auth/spreadsheets" : "https://www.googleapis.com/auth/spreadsheets.readonly"] });
const sheets = google.sheets({ version: "v4", auth }); // en ENSAYO el alcance es de SOLO LECTURA: la API rechazaría cualquier escritura
const reint = async (fn) => { for (let i = 0; i < 6; i++) { try { return await fn(); } catch (e) { if ((e.code ?? e.response?.status) === 429) { await dormir(20000); continue; } throw e; } } throw new Error("cuota de Sheets agotada"); };
const CAMPOS = "effectiveValue,formattedValue,userEnteredFormat(numberFormat)";
const metaHojas = async () => { const { data } = await reint(() => sheets.spreadsheets.get({ spreadsheetId, fields: "sheets(properties(title,sheetId,gridProperties))" })); return Object.fromEntries(data.sheets.map((s) => [s.properties.title, { sheetId: s.properties.sheetId, filas: s.properties.gridProperties.rowCount, cols: s.properties.gridProperties.columnCount }])); };
const leerGrid = async (hoja, filas) => (await reint(() => sheets.spreadsheets.get({ spreadsheetId, ranges: [`${hoja}!A1:Z${filas}`], includeGridData: true, fields: `sheets(data(rowData(values(${CAMPOS}))))` }))).data.sheets[0].data[0].rowData ?? [];
const leerValores = async (range) => (await reint(() => sheets.spreadsheets.values.get({ spreadsheetId, range, valueRenderOption: "FORMATTED_VALUE" }))).data.values ?? [];
// A:K de cada fila pedida (índices 0..10 = A..K), una solicitud con varios rangos por tanda
const leerFilasGrid = async (filas) => { const salida = new Map(); for (let i = 0; i < filas.length; i += 40) { const tanda = filas.slice(i, i + 40);
  const { data } = await reint(() => sheets.spreadsheets.get({ spreadsheetId, ranges: tanda.map((f) => `Rentabilidad!A${f}:K${f}`), includeGridData: true, fields: `sheets(data(rowData(values(${CAMPOS}))))` }));
  tanda.forEach((f, k) => salida.set(f, data.sheets?.[0]?.data?.[k]?.rowData?.[0]?.values ?? [])); } return salida; };
const vista = (celda) => mostrado(celda).trim();
const entradasIguales = (fila, e) => vista(fila[2]) === e.C && vista(fila[4]) === e.E && vista(fila[5]) === e.F && vista(fila[6]) === e.G && vista(fila[7]) === e.H && vista(fila[8]) === e.I;
const NOMBRE = `Rentabilidad RESPALDO ${args.respaldo}`;

async function main() {
  const plan = JSON.parse(fs.readFileSync(args.plan, "utf8")); if (plan.version !== 1 || hash(plan.celdas) !== plan.sha256) { console.error("El plan está alterado o es de otra versión (sha256 distinto). No se hizo nada."); return 2; }
  if (plan.spreadsheetId !== hash(spreadsheetId).slice(0, 12)) { console.error("El plan es de otra planilla. No se hizo nada."); return 2; }
  log(`== ${APLICAR ? "RESTAURAR" : "ENSAYO DE RESTAURACIÓN (solo lectura)"} · Rentabilidad!J:K de ${plan.celdas.length} filas desde «${NOMBRE}» ==`);
  const meta = await metaHojas(); if (!meta.Rentabilidad) { console.error("No existe la pestaña Rentabilidad."); return 2; } if (!meta[NOMBRE]) { console.error(`Falta la pestaña de respaldo «${NOMBRE}». No se hizo nada.`); return 2; }
  if (meta.Rentabilidad.filas !== meta[NOMBRE].filas) { console.error(`La cuadrícula de la hoja (${meta.Rentabilidad.filas} filas) no coincide con la del respaldo (${meta[NOMBRE].filas}). No se hizo nada.`); return 2; }
  const G = await leerGrid("Rentabilidad", meta.Rentabilidad.filas), B = await leerGrid(NOMBRE, meta[NOMBRE].filas); const problemas = [];
  // el respaldo guarda el «antes» del plan, como TEXTO, y sus entradas
  for (const c of plan.celdas) { const b = B[c.fila - 1]?.values ?? []; const jb = b[9], kb = b[10];
    if (!esTextoSinFormato(jb) || !esTextoSinFormato(kb) || texto(jb) !== c.antes.J || texto(kb) !== c.antes.K) problemas.push(`el respaldo no guarda en J:K de la fila ${c.fila} un TEXTO igual al «antes» del plan (hay J=${JSON.stringify(jb?.effectiveValue ?? null)}, K=${JSON.stringify(kb?.effectiveValue ?? null)}; el plan dice ${c.antes.J} / ${c.antes.K})`);
    else if (!entradasIguales(b, c.entradas)) problemas.push(`el respaldo no guarda las entradas (ítem, precio, costo, comisión, envío, pérdida) del plan en la fila ${c.fila}`); }
  // nada cambió fuera de J:K de las filas del plan
  const enPlan = new Set(plan.celdas.flatMap((c) => [`J${c.fila}`, `K${c.fila}`])); const fuera = compararGrids(G, B, enPlan);
  if (fuera.totales.valor + fuera.totales.mostrado + fuera.totales.formato > 0) problemas.push(`la hoja viva tiene cambios FUERA de J:K de las filas del plan respecto del respaldo (valor interno ${fuera.totales.valor}, texto mostrado ${fuera.totales.mostrado}, formato ${fuera.totales.formato}; p. ej. ${[...fuera.valor, ...fuera.mostrado, ...fuera.formato].slice(0, 6).join(", ")}): alguien modificó la hoja después del respaldo y no se restaura automáticamente`);
  // estado de cada fila del plan
  const estados = new Map(); for (const c of plan.celdas) { const e = estadoFila(G[c.fila - 1]?.values ?? [], B[c.fila - 1]?.values ?? [], c); estados.set(c.fila, e); if (e === "otra") problemas.push(`la fila ${c.fila} no está ni aplicada (valor del plan) ni restaurada (valor del respaldo): J=${JSON.stringify(G[c.fila - 1]?.values?.[9]?.effectiveValue ?? null)}, K=${JSON.stringify(G[c.fila - 1]?.values?.[10]?.effectiveValue ?? null)}`); }
  const aplicadas = plan.celdas.filter((c) => estados.get(c.fila) === "aplicada"); const restauradas = plan.celdas.length - aplicadas.length - plan.celdas.filter((c) => estados.get(c.fila) === "otra").length;
  const tj = (v) => tarjeta(leerFilas(v)); const [vivaT, respT] = [tj(await leerValores("Rentabilidad!A2:Q20000")), tj(await leerValores(`${NOMBRE}!A2:Q20000`))];
  log(`Filas del plan: ${plan.celdas.length} · APLICADAS (hay que restaurar): ${aplicadas.length} · ya iguales al respaldo: ${restauradas}`);
  log(`Tarjeta hoy: margen total ${Math.round(vivaT.margenTotal)} · % promedio ${vivaT.pctPromedio} · negativas ${vivaT.negativas}  |  Tarjeta del respaldo: ${Math.round(respT.margenTotal)} · ${respT.pctPromedio} · ${respT.negativas}`);
  if (problemas.length) { console.error(`\nNo se puede restaurar (${problemas.length} problema(s)):`); problemas.slice(0, 10).forEach((p) => console.error("  · " + p)); console.error("No se hizo nada."); return 2; }
  if (!APLICAR) { log(`\nEl ensayo no encontró problemas: restauraría ${aplicadas.length} filas (${aplicadas.length * 2} celdas J:K) en ${Math.ceil(aplicadas.length / LOTE)} lotes. NO se escribió nada.`); log("Para restaurar (requiere autorización explícita):\n  node scripts/una-vez/restaurar-margen-c16.mjs --plan=" + args.plan + " --respaldo=" + args.respaldo + " --aplicar"); return 0; }

  // ---- aplicar ----
  const Lib = requireRepo(path.join(tmp, "lock-sheets.js")); const Sh = requireRepo(path.join(tmp, "sheets.js"));
  const tickets = await Sh.readSheet("Locks!A2:D").catch(() => []); const ahoraS = Math.floor(Date.now() / 1000);
  const activos = tickets.filter((t) => !String(t[3] ?? "").trim() && Lib.parsearVence(t[2]) > ahoraS && /^(rentabilidad:|audit:|ml-sync)/.test(String(t[0] ?? ""))).map((t) => String(t[0]));
  if (activos.length) { console.error("Hay procesos en curso (" + [...new Set(activos)].join(", ") + "). Espera a que terminen. No se hizo nada."); return 2; }
  const lotes = []; for (let i = 0; i < aplicadas.length; i += LOTE) lotes.push(aplicadas.slice(i, i + LOTE));
  const registro = { inicio: new Date().toISOString(), lotes: [], restauradas: 0, yaRestauradas: 0 }; const reg = args.plan + ".restauracion.registro.json"; const guardar = () => fs.writeFileSync(reg, JSON.stringify(registro)); let n = 0;
  for (const lote of lotes) { n++;
    let res; try { res = await Lib.conLock("ml-sync", async () => {
      const act = await leerFilasGrid(lote.map((c) => c.fila)); const aEscribir = []; let ya = 0;
      for (const c of lote) { const fila = act.get(c.fila) ?? []; const b = B[c.fila - 1].values;
        if (!entradasIguales(fila, c.entradas)) throw new Error(`La fila ${c.fila} cambió desde la comprobación (ítem, precio, costo, comisión, envío o pérdida ya no coinciden). Lote NO escrito.`);
        const e = estadoFila(fila, b, c); if (e === "restaurada") { ya++; continue; } if (e === "otra") throw new Error(`La fila ${c.fila} ya no está ni aplicada ni restaurada (alguien la modificó). Lote NO escrito.`); aEscribir.push({ c, J: texto(b[9]), K: texto(b[10]) }); }
      if (aEscribir.length) await reint(() => sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: aEscribir.map(({ c, J, K }) => ({ updateCells: { range: { sheetId: meta.Rentabilidad.sheetId, startRowIndex: c.fila - 1, endRowIndex: c.fila, startColumnIndex: 9, endColumnIndex: 11 }, rows: [{ values: [{ userEnteredValue: { stringValue: J } }, { userEnteredValue: { stringValue: K } }] }], fields: "userEnteredValue" } })) } }));
      return { escritas: aEscribir.length, ya }; }); } catch (e) { console.error(`Lote ${n}/${lotes.length}: ${e?.message ?? e}\nSe detiene. Los lotes anteriores quedan restaurados; este NO. Vuelve a correr con el mismo plan para reanudar.`); registro.error = String(e?.message ?? e); guardar(); return 1; }
    if (!res.ok) { console.error(`Lote ${n}/${lotes.length}: no se obtuvo el lock (${res.status}): ${res.mensaje}\nSe detiene. Lo ya escrito queda; vuelve a correr con el mismo plan para reanudar.`); guardar(); return 1; }
    registro.restauradas += res.valor.escritas; registro.yaRestauradas += res.valor.ya; registro.lotes.push({ n, ...res.valor }); log(`  lote ${n}/${lotes.length}: filas restauradas ${res.valor.escritas}, ya restauradas ${res.valor.ya}`); if (n < lotes.length) await dormir(PAUSA_MS); }
  // verificación final (dentro del lock): la hoja viva debe quedar IDÉNTICA al respaldo
  let rv; try { rv = await Lib.conLock("ml-sync", async () => { const G2 = await leerGrid("Rentabilidad", meta.Rentabilidad.filas); const cmp = compararGrids(G2, B); const tv = tj(await leerValores("Rentabilidad!A2:Q20000")); return { cmp, tv }; }); } catch (e) { console.error("ERROR en la verificación: " + (e?.message ?? e)); registro.error = String(e?.message ?? e); guardar(); return 1; }
  if (!rv.ok) { console.error("No se pudo verificar (lock): " + rv.mensaje); guardar(); return 1; }
  const { cmp, tv } = rv.valor; const t = cmp.totales; const tarjetaOk = JSON.stringify(tv) === JSON.stringify(respT); registro.verificacion = { totales: t, tarjetaOk }; registro.fin = new Date().toISOString(); guardar();
  log(`\nVerificación: hoja viva contra el respaldo en ${cmp.celdas} celdas (A1:Z) · valor interno distinto ${t.valor} · texto mostrado distinto ${t.mostrado} · formato distinto ${t.formato} · tarjeta igual a la del respaldo: ${tarjetaOk ? "sí" : "NO"} (${Math.round(tv.margenTotal)} / ${tv.pctPromedio} / ${tv.negativas})`);
  const ok = t.valor + t.mostrado + t.formato === 0 && tarjetaOk; log(ok ? "\n✓ Restauración verificada: Rentabilidad quedó idéntica a «" + NOMBRE + "»." : "\n✗ La verificación FALLÓ: no sigas; revisa el registro " + reg + " y compara a mano con el respaldo."); return ok ? 0 : 1;
}
const codigo = await main().catch((e) => { console.error("ERROR: " + (e?.message ?? e)); return 1; });
process.exit(codigo);

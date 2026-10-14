// ======================================================================================================================================================
// HERRAMIENTA DE UN SOLO USO — S-07: limpieza de formatos de fecha/número en 7 columnas (Rentabilidad H,J,K,O · ShippingCache E · TarifaEnvio C,F)
// Escrita para una corrección puntual de la planilla de producción; se conserva como registro y para poder auditar el cambio. Estado: preparada, aún NO aplicada
// (la fecha de aplicación se anotará en un commit posterior). NO volver a ejecutar en modo --aplicar sin una revisión nueva: el plan y las cifras de ESPERADO (2.081 celdas = 1.348 con formato de fecha + 733 planas) son las de la planilla del 2026-10-14.
// Las pruebas (test-*.mjs de esta carpeta) usan planillas SINTÉTICAS y una API simulada: no contienen datos reales de las hojas.
// Los planes, registros y diffs que generan van a la carpeta temporal (nunca al repo; ver .gitignore).
// ======================================================================================================================================================
// S-07: LIMPIEZA de las celdas numéricas de las 7 columnas afectadas (opción 2, columnas completas y uniformes), con ensayo por defecto.
//   Rentabilidad H (envío), J (margen neto), K (margen %), O (envío por unidad) · ShippingCache E (costo del despacho) · TarifaEnvio C (tarifa), F (dispersión %)
// Cada celda con un NÚMERO (guardado como número plano o como FECHA mal interpretada) se reescribe como TEXTO con el valor mostrado y sin formato de fecha. Los textos y las
// celdas vacías no se tocan. Después se restablece el formato de número de esas columnas, de la fila 2 al final.
//
// USO
//   node scripts/una-vez/limpiar-formatos-s07.mjs [--salida=RUTA]                                   ENSAYO (por defecto): SOLO LECTURA. Calcula el plan y lo guarda en RUTA (fuera del repo).
//   node scripts/una-vez/limpiar-formatos-s07.mjs --aplicar --plan=RUTA --respaldo=SUFIJO [--lote=50] [--pausa-ms=2500]
//                                                                                           APLICAR: exige --aplicar, un plan generado por el ensayo y el sufijo de las pestañas de respaldo.
// Garantías de --aplicar (todas se comprueban antes de escribir):
//   1. El plan debe estar íntegro (sha256) y sin celdas AMBIGUAS.
//   2. Deben existir las 3 pestañas «<hoja> RESPALDO <SUFIJO>» y su contenido mostrado debe ser IGUAL al de la hoja real.
//   3. No debe haber tickets activos de otros procesos que escriban esas hojas (rentabilidad:*, audit:*, ml-sync) y cada lote se ejecuta DENTRO del lock «ml-sync» (lib/lock-sheets).
//   4. Justo antes de escribir cada lote se vuelve a leer cada celda y se compara con el «antes» del plan: si alguna ya no coincide (ni está ya convertida), el lote NO se escribe y el script se detiene.
//   5. Cada lote es UN solo spreadsheets.batchUpdate (atómico: todo o nada) con updateCells (valor de texto + formato de número reseteado).
//   6. Es reanudable: las celdas ya convertidas se reconocen y se saltan.
//   7. Al final: repeatCell que restablece el formato de número de las 7 columnas (fila 2 al final) y verificación (0 fechas en columnas numéricas, mismos totales y mismos valores mostrados).
//      ANTES del repeatCell se comprueba que no quede ninguna celda numérica con formato de fecha fuera del plan (sobre una de esas, el repeatCell dejaría a la vista el número interno).
// No copia datos reales al repo: el plan y el registro se escriben solo en la ruta indicada (por defecto, la carpeta temporal).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import Module, { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RAIZ_API = process.env.S07_RAIZ ? path.resolve(process.env.S07_RAIZ) : REPO; // S07_RAIZ: solo para probar el script contra una API simulada
const requireRepo = createRequire(path.join(REPO, "package.json")); const requireApi = createRequire(path.join(RAIZ_API, "package.json"));

const COLUMNAS = { Rentabilidad: ["H", "J", "K", "O"], ShippingCache: ["E"], TarifaEnvio: ["C", "F"] };
const NCOL_LEER = { Rentabilidad: 17, ShippingCache: 9, TarifaEnvio: 12 };
const ESPERADO = { total: 2081, fecha: 1348, plano: 733 }; // revisión del 2026-10-14 (cifras de la planilla de ese momento) (solo informativo en el ensayo)
const PATRONES_CONOCIDOS = new Set(["yyyy.m", "yyyy.mm", "d.m", "d.mm", "dd.m", "dd.mm"]);
const esFecha = (t) => t === "DATE" || t === "DATE_TIME" || t === "TIME";
const L = (i) => String.fromCharCode(65 + i); const idx = (c) => c.charCodeAt(0) - 65; const pad2 = (n) => String(n).padStart(2, "0");
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (x) => crypto.createHash("sha256").update(typeof x === "string" ? x : JSON.stringify(x)).digest("hex");
const log = (...a) => console.log(...a);

// ---------- argumentos ----------
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const APLICAR = args.aplicar === true; const LOTE = Math.min(100, Math.max(1, Number(args.lote ?? 50))); const PAUSA_MS = Number(args["pausa-ms"] ?? 2500);
const SALIDA = typeof args.salida === "string" ? args.salida : path.join(os.tmpdir(), "s07_plan_limpieza.json");
const desconocidos = Object.keys(args).filter((k) => !["aplicar", "plan", "respaldo", "lote", "pausa-ms", "salida"].includes(k)); if (desconocidos.length) { console.error("Argumentos desconocidos: " + desconocidos.join(", ")); process.exit(2); }
if (!APLICAR && (args.plan || args.respaldo)) { console.error("--plan y --respaldo solo se usan con --aplicar. Sin --aplicar el script solo hace el ensayo (solo lectura)."); process.exit(2); }
if (!APLICAR && fs.existsSync(SALIDA)) { console.error("Ya existe " + SALIDA + ": el ensayo NO sobrescribe planes (podrían ser los originales). Usa otro nombre con --salida=RUTA. No se hizo nada."); process.exit(2); }

// ---------- credenciales y API ----------
if (!process.env.S07_RAIZ) { for (const linea of fs.readFileSync(path.join(REPO, ".env.local"), "utf-8").split("\n")) { const [k, ...r] = linea.split("="); if (k && r.length) process.env[k.trim()] = r.join("=").trim(); } }
process.env.NODE_PATH = [path.join(RAIZ_API, "node_modules"), path.join(REPO, "node_modules")].join(path.delimiter); Module._initPaths();
const { google } = requireApi("googleapis"); const spreadsheetId = process.env.GOOGLE_SHEET_ID;
const auth = new google.auth.GoogleAuth({ credentials: { client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/^"|"$/g, "") }, scopes: [APLICAR ? "https://www.googleapis.com/auth/spreadsheets" : "https://www.googleapis.com/auth/spreadsheets.readonly"] });
const sheets = google.sheets({ version: "v4", auth }); // en ENSAYO el alcance es de SOLO LECTURA: la API rechazaría cualquier escritura
const reint = async (fn) => { for (let i = 0; i < 6; i++) { try { return await fn(); } catch (e) { if ((e.code ?? e.response?.status) === 429) { await dormir(20000); continue; } throw e; } } throw new Error("cuota de Sheets agotada"); };
const CAMPOS_CELDA = "effectiveValue,userEnteredValue,formattedValue,userEnteredFormat(numberFormat)";
const metaHojas = async () => { const { data } = await reint(() => sheets.spreadsheets.get({ spreadsheetId, fields: "sheets(properties(title,sheetId,gridProperties))" })); return Object.fromEntries(data.sheets.map((s) => [s.properties.title, { sheetId: s.properties.sheetId, filas: s.properties.gridProperties.rowCount }])); };
const leerGrid = async (hoja) => (await reint(() => sheets.spreadsheets.get({ spreadsheetId, ranges: [`${hoja}!A1:${L(NCOL_LEER[hoja] - 1)}20000`], includeGridData: true, fields: `sheets(data(rowData(values(${CAMPOS_CELDA}))))` }))).data.sheets[0].data[0].rowData ?? [];
// Una solicitud por hoja: la API agrupa la respuesta por hoja (sheets[]), cada una con sus rangos en el orden pedido.
const leerCeldas = async (refs) => { const salida = new Array(refs.length).fill(null); const porHoja = new Map(); refs.forEach((r, i) => { if (!porHoja.has(r.hoja)) porHoja.set(r.hoja, []); porHoja.get(r.hoja).push(i); });
  for (const [hoja, indices] of porHoja) { const { data } = await reint(() => sheets.spreadsheets.get({ spreadsheetId, ranges: indices.map((i) => `${hoja}!${refs[i].col}${refs[i].fila}`), includeGridData: true, fields: `sheets(data(rowData(values(${CAMPOS_CELDA}))))` }));
    indices.forEach((i, k) => { salida[i] = data.sheets?.[0]?.data?.[k]?.rowData?.[0]?.values?.[0] ?? null; }); } return salida; };
const estadoDe = (cel) => { // resume una celda leída
  if (!cel || cel.effectiveValue === undefined) return { tipo: "vacia" }; const ev = Object.keys(cel.effectiveValue)[0]; const nf = cel.userEnteredFormat?.numberFormat;
  if (ev === "stringValue") return { tipo: "texto", texto: cel.effectiveValue.stringValue, visto: String(cel.formattedValue ?? "") };
  if (ev === "numberValue") return { tipo: esFecha(nf?.type) ? "fecha" : "numero", numero: cel.effectiveValue.numberValue, formato: nf?.type ?? "-", patron: nf?.pattern, visto: String(cel.formattedValue ?? "").trim() };
  return { tipo: "otro", ev }; };

// ---------- ENSAYO: construir el plan ----------
async function construirPlan() {
  const meta = await metaHojas(); const celdas = []; const totales = {};
  for (const [hoja, cols] of Object.entries(COLUMNAS)) {
    const filas = await leerGrid(hoja); if (!meta[hoja]) throw new Error("No existe la pestaña " + hoja);
    for (const col of cols) { const t = { conDato: 0, texto: 0, numero: 0, fecha: 0, otros: 0, sumaNumeros: 0 }; totales[`${hoja}!${col}`] = t;
      filas.slice(1).forEach((fila, i) => { const e = estadoDe(fila.values?.[idx(col)]); if (e.tipo === "vacia") return; t.conDato++;
        if (e.tipo === "texto") { t.texto++; const n = Number(e.texto); if (Number.isFinite(n)) t.sumaNumeros += n; return; }
        if (e.tipo === "otro") { t.otros++; return; }
        const motivos = []; let despues;
        if (e.tipo === "fecha") { t.fecha++; const d = new Date(Date.UTC(1899, 11, 30) + e.numero * 86400000); const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, dia = d.getUTCDate();
          if (!PATRONES_CONOCIDOS.has(e.patron)) motivos.push("patrón desconocido " + e.patron); if (!/^-?\d+(\.\d+)?$/.test(e.visto)) motivos.push("lo mostrado no es un número");
          const ym = [`${y}.${m}`, `${y}.${pad2(m)}`], dm = [`${dia}.${m}`, `${dia}.${pad2(m)}`, `${pad2(dia)}.${m}`, `${pad2(dia)}.${pad2(m)}`]; if (!((dia === 1 && ym.includes(e.visto)) || (y === 2026 && dm.includes(e.visto)))) motivos.push("el serial no reproduce lo mostrado");
          if (hoja === "ShippingCache" && col === "E" && (e.visto.split(".")[1] ?? "").length > 1) motivos.push("costo de ML con más de 1 decimal: verificar"); despues = e.visto; t.sumaNumeros += Number(e.visto); }
        else { t.numero++; despues = String(e.numero); t.sumaNumeros += e.numero; }
        celdas.push({ hoja, col, fila: i + 2, antes: e.tipo === "fecha" ? { tipo: "fecha", numero: e.numero, formato: e.formato, patron: e.patron, visto: e.visto } : { tipo: "numero", numero: e.numero, visto: e.visto }, despues, ambigua: motivos.length > 0, motivos }); }); } }
  celdas.sort((a, b) => (a.hoja + a.col).localeCompare(b.hoja + b.col) || a.fila - b.fila);
  return { version: 1, generado: new Date().toISOString(), spreadsheetId: hash(spreadsheetId).slice(0, 12), columnas: COLUMNAS, totales, celdas, filasGrid: Object.fromEntries(Object.entries(meta).filter(([h]) => COLUMNAS[h]).map(([h, m]) => [h, m.filas])) };
}
function resumenPlan(plan) { const fecha = plan.celdas.filter((c) => c.antes.tipo === "fecha").length, plano = plan.celdas.filter((c) => c.antes.tipo === "numero").length, amb = plan.celdas.filter((c) => c.ambigua).length;
  return { total: plan.celdas.length, fecha, plano, ambiguas: amb }; }
const solicitudesFormato = (plan, meta) => Object.entries(COLUMNAS).flatMap(([hoja, cols]) => cols.map((col) => ({ repeatCell: { range: { sheetId: meta[hoja].sheetId, startRowIndex: 1, endRowIndex: meta[hoja].filas, startColumnIndex: idx(col), endColumnIndex: idx(col) + 1 }, cell: { userEnteredFormat: {} }, fields: "userEnteredFormat.numberFormat" } })));

async function ensayo() {
  log("== ENSAYO (solo lectura; el alcance de la credencial es de solo lectura) ==");
  const plan = await construirPlan(); const r = resumenPlan(plan); plan.sha256 = hash(plan.celdas);
  log(`Celdas a reescribir como texto: ${r.total} (con formato de FECHA ${r.fecha} · números planos ${r.plano}) · AMBIGUAS: ${r.ambiguas}`);
  for (const [k, t] of Object.entries(plan.totales)) log(`  ${k.padEnd(18)} con dato ${String(t.conDato).padStart(5)} · texto ${String(t.texto).padStart(4)} · número ${String(t.numero).padStart(4)} · fecha ${String(t.fecha).padStart(4)}${t.otros ? ` · otros ${t.otros}` : ""}`);
  if (r.total !== ESPERADO.total || r.fecha !== ESPERADO.fecha || r.plano !== ESPERADO.plano) log(`⚠ Difiere de lo revisado el 2026-10-14 (esperado: ${ESPERADO.total} = ${ESPERADO.fecha} fecha + ${ESPERADO.plano} planos): revisa por qué antes de aplicar.`);
  if (r.ambiguas) { log("⚠ Celdas AMBIGUAS (el modo aplicar se negará mientras haya alguna):"); plan.celdas.filter((c) => c.ambigua).slice(0, 10).forEach((c) => log(`   ${c.hoja}!${c.col}${c.fila}: ${c.motivos.join("; ")}`)); }
  const meta = await metaHojas(); log("Formato propuesto (repeatCell, una sola llamada atómica al final; NO se ejecuta en el ensayo):"); log(JSON.stringify(solicitudesFormato(plan, meta)[0], null, 1) + `\n   … y ${solicitudesFormato(plan, meta).length - 1} más (una por columna, fila 2 hasta el final de la cuadrícula)`);
  fs.writeFileSync(SALIDA, JSON.stringify(plan)); log(`\nPlan guardado en ${SALIDA} (fuera del repo) · sha256 ${plan.sha256.slice(0, 16)}…`);
  log("Para aplicar (requiere TU autorización, respaldo previo y nada corriendo):\n  node scripts/una-vez/limpiar-formatos-s07.mjs --aplicar --plan=" + SALIDA + " --respaldo=<SUFIJO>");
  return 0;
}

// ---------- APLICAR ----------
async function aplicar() {
  if (typeof args.plan !== "string" || typeof args.respaldo !== "string") { console.error("--aplicar exige --plan=RUTA (generado por el ensayo) y --respaldo=SUFIJO (pestañas «<hoja> RESPALDO <SUFIJO>»). No se hizo nada."); return 2; }
  const plan = JSON.parse(fs.readFileSync(args.plan, "utf8")); if (plan.version !== 1 || hash(plan.celdas) !== plan.sha256) { console.error("El plan está alterado o es de otra versión (sha256 distinto). No se hizo nada."); return 2; }
  const r = resumenPlan(plan); if (r.ambiguas) { console.error(`El plan tiene ${r.ambiguas} celda(s) AMBIGUA(S): resuélvelas antes de aplicar. No se hizo nada.`); return 2; }
  if (plan.spreadsheetId !== hash(spreadsheetId).slice(0, 12)) { console.error("El plan es de otra planilla. No se hizo nada."); return 2; }
  log(`== APLICAR: ${r.total} celdas (lote ${LOTE}, pausa ${PAUSA_MS} ms) ==`);

  // librería del lock (se transpila de lib/*.ts, igual que las pruebas)
  const ts = requireRepo("typescript"); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "limpieza-s07-"));
  for (const f of ["log", "sheets", "guardas-filas", "lock-sheets"]) { const src = fs.readFileSync(path.join(REPO, "lib", f + ".ts"), "utf8").replace(/from "@\/lib\/([\w-]+)"/g, 'from "./$1"'); fs.writeFileSync(path.join(tmp, f + ".js"), ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText); }
  const Lib = requireRepo(path.join(tmp, "lock-sheets.js")); const Sh = requireRepo(path.join(tmp, "sheets.js"));

  // 2. respaldo
  const meta = await metaHojas();
  for (const hoja of Object.keys(COLUMNAS)) { const nombre = `${hoja} RESPALDO ${args.respaldo}`; if (!meta[nombre]) { console.error(`Falta la pestaña de respaldo «${nombre}». No se hizo nada.`); return 2; }
    const rango = (h) => `${h}!A1:${L(NCOL_LEER[hoja] - 1)}20000`; const [a, b] = [await Sh.readSheet(rango(hoja)), await Sh.readSheet(rango(nombre))];
    if (hash(a) !== hash(b)) { console.error(`El respaldo «${nombre}» NO coincide con la hoja real (valores mostrados distintos). No se hizo nada.`); return 2; } log(`  respaldo «${nombre}»: igual a la hoja real (${a.length} filas)`); }
  // 3. nada más corriendo
  const tickets = await Sh.readSheet("Locks!A2:D").catch(() => []); const ahoraS = Math.floor(Date.now() / 1000);
  const activos = tickets.filter((t) => !String(t[3] ?? "").trim() && Lib.parsearVence(t[2]) > ahoraS && /^(rentabilidad:|audit:|ml-sync)/.test(String(t[0] ?? ""))).map((t) => String(t[0]));
  if (activos.length) { console.error("Hay procesos en curso (" + [...new Set(activos)].join(", ") + "). Espera a que terminen. No se hizo nada."); return 2; }

  // 4-6. lotes dentro del lock «ml-sync»
  const lotes = []; for (let i = 0; i < plan.celdas.length; i += LOTE) lotes.push(plan.celdas.slice(i, i + LOTE));
  const registro = { inicio: new Date().toISOString(), lotes: [], convertidas: 0, yaConvertidas: 0 }; let n = 0;
  for (const lote of lotes) { n++;
    let res; try { res = await Lib.conLock("ml-sync", async () => {
      const actuales = (await leerCeldas(lote)).map(estadoDe); const aEscribir = []; let ya = 0;
      for (let i = 0; i < lote.length; i++) { const c = lote[i], e = actuales[i];
        const eraAntes = c.antes.tipo === "fecha" ? e.tipo === "fecha" && e.numero === c.antes.numero && e.visto === c.antes.visto : e.tipo === "numero" && e.numero === c.antes.numero;
        const yaListo = e.tipo === "texto" && e.texto === c.despues;
        if (eraAntes) aEscribir.push(c); else if (yaListo) ya++; else throw new Error(`La celda ${c.hoja}!${c.col}${c.fila} ya no coincide con el plan (esperaba ${JSON.stringify(c.antes)}; hay ${JSON.stringify(e)}). Lote NO escrito.`); }
      if (aEscribir.length) await reint(() => sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: aEscribir.map((c) => ({ updateCells: { range: { sheetId: meta[c.hoja].sheetId, startRowIndex: c.fila - 1, endRowIndex: c.fila, startColumnIndex: idx(c.col), endColumnIndex: idx(c.col) + 1 }, rows: [{ values: [{ userEnteredValue: { stringValue: c.despues } }] }], fields: "userEnteredValue,userEnteredFormat.numberFormat" } })) } }));
      return { escritas: aEscribir.length, ya }; }); } catch (e) { console.error(`Lote ${n}/${lotes.length}: ${e?.message ?? e}\nSe detiene. Los lotes anteriores quedan escritos; este NO. Vuelve a correr con el mismo plan para reanudar.`); registro.error = String(e?.message ?? e); fs.writeFileSync(args.plan + ".registro.json", JSON.stringify(registro)); return 1; }
    if (!res.ok) { console.error(`Lote ${n}/${lotes.length}: no se obtuvo el lock (${res.status}): ${res.mensaje}\nSe detiene. Lo ya escrito queda; vuelve a correr con el mismo plan para reanudar.`); fs.writeFileSync(args.plan + ".registro.json", JSON.stringify(registro)); return 1; }
    registro.convertidas += res.valor.escritas; registro.yaConvertidas += res.valor.ya; registro.lotes.push({ n, ...res.valor }); log(`  lote ${n}/${lotes.length}: escritas ${res.valor.escritas}, ya convertidas ${res.valor.ya}`); if (n < lotes.length) await dormir(PAUSA_MS); }

  // 7. formato de número de las 7 columnas y verificación
  let resF; try { resF = await Lib.conLock("ml-sync", async () => {
    const restantes = await fechasRestantes(); if (restantes.length) throw new Error(`Quedan ${restantes.length} celda(s) numérica(s) con formato de fecha FUERA del plan (p. ej. ${restantes.slice(0, 3).join(", ")}): el repeatCell las dejaría mostrando el número interno. NO se restableció el formato. Genera un plan nuevo con el ensayo.`);
    await reint(() => sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: solicitudesFormato(plan, meta) } })); }); } catch (e) { console.error(e?.message ?? e); registro.error = String(e?.message ?? e); fs.writeFileSync(args.plan + ".registro.json", JSON.stringify(registro)); return 1; }
  if (!resF.ok) { console.error("No se pudo restablecer el formato (lock): " + resF.mensaje + ". Reintenta con el mismo plan."); return 1; }
  log("  formato de número de las 7 columnas restablecido (fila 2 al final)");
  const ver = await verificar(plan); registro.verificacion = ver; registro.fin = new Date().toISOString(); fs.writeFileSync(args.plan + ".registro.json", JSON.stringify(registro));
  log(`\nVerificación: fechas en columnas numéricas = ${ver.fechasRestantes}; celdas del plan ya como texto = ${ver.convertidasOk}/${plan.celdas.length}; totales por columna iguales = ${ver.totalesIguales ? "sí" : "NO"}; valores mostrados iguales = ${ver.mostradosIguales ? "sí" : "NO"}; sumas iguales = ${ver.sumasIguales ? "sí" : "NO"}`);
  const ok = ver.fechasRestantes === 0 && ver.convertidasOk === plan.celdas.length && ver.totalesIguales && ver.mostradosIguales && ver.sumasIguales;
  log(ok ? "\n✓ Limpieza verificada. Si algo se ve mal: restaurar desde las pestañas de respaldo (copiar sus valores a la hoja real); el rollback de Vercel no deshace lo escrito en las hojas." : "\n✗ La verificación FALLÓ: no sigas; revisa el registro " + SALIDA + ".registro.json y restaura desde el respaldo si hace falta.");
  return ok ? 0 : 1;
}
// Celdas numéricas con formato de FECHA que quedan en las 7 columnas. El repeatCell que restablece el formato NO debe correr si queda alguna: sobre una celda de fecha sin convertir
// deja a la vista el número interno (medido en la sonda: «4989.6» pasa a verse «1128388»).
async function fechasRestantes() { const res = []; for (const [hoja, cols] of Object.entries(COLUMNAS)) { const filas = await leerGrid(hoja); for (const col of cols) filas.slice(1).forEach((fila, i) => { if (estadoDe(fila.values?.[idx(col)]).tipo === "fecha") res.push(`${hoja}!${col}${i + 2}`); }); } return res; }
async function verificar(plan) {
  let fechasRestantes = 0, totalesIguales = true, sumasIguales = true; const nuevos = {}; const estado = new Map();
  for (const [hoja, cols] of Object.entries(COLUMNAS)) { const filas = await leerGrid(hoja);
    for (const col of cols) { const t = { conDato: 0, suma: 0 }; filas.slice(1).forEach((fila, i) => { const e = estadoDe(fila.values?.[idx(col)]); if (e.tipo === "vacia") return; t.conDato++; if (e.tipo === "fecha") fechasRestantes++; const n = e.tipo === "texto" ? Number(e.texto) : e.numero; if (Number.isFinite(n)) t.suma += n; estado.set(`${hoja}!${col}${i + 2}`, e); }); nuevos[`${hoja}!${col}`] = t; } }
  for (const [k, t] of Object.entries(plan.totales)) { if (nuevos[k].conDato !== t.conDato) totalesIguales = false; if (Math.abs(nuevos[k].suma - t.sumaNumeros) > 1e-6 * Math.max(1, Math.abs(t.sumaNumeros))) sumasIguales = false; }
  let convertidasOk = 0, mostradosIguales = true; for (const c of plan.celdas) { const e = estado.get(`${c.hoja}!${c.col}${c.fila}`); if (e?.tipo === "texto" && e.texto === c.despues) { convertidasOk++; if (e.visto !== c.antes.visto && c.antes.tipo === "fecha") mostradosIguales = false; if (c.antes.tipo === "numero" && e.visto !== String(c.antes.numero)) mostradosIguales = false; } }
  return { fechasRestantes, convertidasOk, totalesIguales, sumasIguales, mostradosIguales };
}

const codigo = await (APLICAR ? aplicar() : ensayo()).catch((e) => { console.error("ERROR: " + (e?.message ?? e)); return 1; });
process.exit(codigo);

// ======================================================================================================================================================
// HERRAMIENTA DE UN SOLO USO — C-16: corrección de los márgenes de Rentabilidad (J:K) de las filas con fórmula antigua
// Escrita para una corrección puntual de la planilla de producción; se conserva como registro y para poder auditar el cambio. Estado: preparada, aún NO aplicada
// (la fecha de aplicación se anotará en un commit posterior). NO volver a ejecutar en modo --aplicar sin una revisión nueva: el plan y las cifras de ESPERADO (120 filas, margen total −15.612, promedio −14,4 %, 89 negativas, 10 cambios de signo) son las de la planilla del 2026-10-14.
// Las pruebas (test-*.mjs de esta carpeta) usan planillas SINTÉTICAS y una API simulada: no contienen datos reales de las hojas.
// Los planes, registros y diffs que generan van a la carpeta temporal (nunca al repo; ver .gitignore).
// ======================================================================================================================================================
// C-16 (fase 2, PREPARADA, NO EJECUTADA): corrige los márgenes mal guardados de Rentabilidad. Decisión de Otto: los costos manuales estaban CON IVA (brutos) → escenario «todo bruto».
//   Reescribe SOLO Rentabilidad!J:K (margen neto y margen %) de las filas V1 y V2 (fórmulas antiguas) con la fórmula actual (calcularMargen). No toca las filas V3 ni las que no tienen costo,
//   ni las columnas H, O, P, Q ni el costo (F). El costo de un ítem pausado está desactualizado frente al MAYOR y NO se cambia desde el código.
//
// USO
//   node scripts/una-vez/recalcular-margen-c16.mjs [--salida=RUTA] [--comparar-con=PLAN_ANTERIOR]     ENSAYO (por defecto): SOLO LECTURA. Calcula el plan y lo guarda en RUTA (fuera del repo).
//   node scripts/una-vez/recalcular-margen-c16.mjs --aplicar --plan=RUTA --respaldo=SUFIJO [--lote=20] [--pausa-ms=2500]
//                                                                                              APLICAR: exige --aplicar, un plan del ensayo y el sufijo de la pestaña «Rentabilidad RESPALDO <SUFIJO>».
// ORDEN ACORDADO: primero la limpieza de formatos (scripts/una-vez/limpiar-formatos-s07.mjs) y DESPUÉS este recálculo, nunca a la vez. Tras la limpieza hay que volver a correr este ENSAYO y comprobar
//   que el plan sigue igual (mismo sha256; --comparar-con=PLAN_ANTERIOR lo comprueba). Este script se niega a aplicar si J o K de alguna fila del plan aún tiene formato de fecha.
// Garantías de --aplicar (todas se comprueban antes de escribir):
//   1. Plan íntegro (sha256), de esta planilla, sin filas AMBIGUAS, y con el resumen esperado (ver ESPERADO).
//   2. Existe «Rentabilidad RESPALDO <SUFIJO>» y su contenido mostrado es IGUAL al de la hoja real.
//   3. Sin tickets activos de rentabilidad:*, audit:* o ml-sync; cada lote corre DENTRO del lock «ml-sync» (lib/lock-sheets).
//   4. Justo antes de escribir cada lote se vuelve a leer cada fila y se compara con el «antes» del plan (entradas, margen neto y margen %); si algo cambió, el lote NO se escribe y se detiene.
//   5. Cada lote es UN solo spreadsheets.batchUpdate (atómico) con updateCells sobre J:K. Los valores salen de numeroComoTexto (lib/numero-texto): la celda queda como TEXTO, que es el efecto del
//      apóstrofo (la API recibe el texto literal; no se manda el apóstrofo porque en stringValue se vería).
//   6. Reanudable: las filas ya escritas se reconocen y se saltan.
//   7. Verificación final: resumen exacto, solo cambian las celdas J:K del plan, todas quedan como texto, y repetir el ensayo no propone nada.
// No copia datos reales al repo: el plan y el registro se escriben solo en la ruta indicada (por defecto, la carpeta temporal).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import Module, { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { leerFilas, clasificarVersion, tarjeta, aplicarEscenario, resumenPorItem, signo } from "./margen-c16-nucleo.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RAIZ_API = process.env.C16_RAIZ ? path.resolve(process.env.C16_RAIZ) : REPO; // C16_RAIZ: solo para probar el script contra una API simulada
const requireRepo = createRequire(path.join(REPO, "package.json")); const requireApi = createRequire(path.join(RAIZ_API, "package.json"));
const log = (...a) => console.log(...a); const dormir = (ms) => new Promise((r) => setTimeout(r, ms)); const hash = (x) => crypto.createHash("sha256").update(typeof x === "string" ? x : JSON.stringify(x)).digest("hex");
// Resultado esperado (decisión del 2026-10-14; cifras de la planilla de ese momento, 124 filas con costo: 11 V1 + 109 V2 + 4 V3). Solo se puede cambiar para pruebas (con C16_RAIZ).
const ESPERADO = process.env.C16_RAIZ && process.env.C16_ESPERADO ? JSON.parse(process.env.C16_ESPERADO) : { filas: 120, V1: 11, V2: 109, n: 124, margenTotal: -15612, pctPromedio: -14.4, negativas: 89, cambianSigno: 10 };

// ---------- argumentos ----------
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const APLICAR = args.aplicar === true; const LOTE = Math.min(50, Math.max(1, Number(args.lote ?? 20))); const PAUSA_MS = Number(args["pausa-ms"] ?? 2500);
const SALIDA = typeof args.salida === "string" ? args.salida : path.join(os.tmpdir(), "c16_plan_margen.json");
const desconocidos = Object.keys(args).filter((k) => !["aplicar", "plan", "respaldo", "lote", "pausa-ms", "salida", "comparar-con"].includes(k)); if (desconocidos.length) { console.error("Argumentos desconocidos: " + desconocidos.join(", ")); process.exit(2); }
if (!APLICAR && (args.plan || args.respaldo)) { console.error("--plan y --respaldo solo se usan con --aplicar. Sin --aplicar el script solo hace el ensayo (solo lectura)."); process.exit(2); }
if (APLICAR && args["comparar-con"]) { console.error("--comparar-con solo se usa en el ensayo."); process.exit(2); }
if (!APLICAR && fs.existsSync(SALIDA)) { console.error("Ya existe " + SALIDA + ": el ensayo NO sobrescribe planes (podrían ser los originales). Usa otro nombre con --salida=RUTA. No se hizo nada."); process.exit(2); }

// ---------- código real: calcularMargen y numeroComoTexto, transpilados a una carpeta temporal ----------
const ts = requireRepo("typescript"); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "margen-c16-"));
for (const f of ["rentabilidad", "numero-texto", "log", "sheets", "guardas-filas", "lock-sheets"]) { const src = fs.readFileSync(path.join(REPO, "lib", f + ".ts"), "utf8").replace(/from "@\/lib\/([\w-]+)"/g, 'from "./$1"'); fs.writeFileSync(path.join(tmp, f + ".js"), ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText); }
const { calcularMargen } = requireRepo(path.join(tmp, "rentabilidad.js")); const { numeroComoTexto } = requireRepo(path.join(tmp, "numero-texto.js"));
const plano = (t) => (t.startsWith("'") ? t.slice(1) : t); // texto literal de la celda: lo que numeroComoTexto protege con el apóstrofo

// ---------- credenciales y API ----------
if (!process.env.C16_RAIZ) { for (const linea of fs.readFileSync(path.join(REPO, ".env.local"), "utf-8").split("\n")) { const [k, ...r] = linea.split("="); if (k && r.length) process.env[k.trim()] = r.join("=").trim(); } }
process.env.NODE_PATH = [path.join(RAIZ_API, "node_modules"), path.join(REPO, "node_modules")].join(path.delimiter); Module._initPaths();
const { google } = requireApi("googleapis"); const spreadsheetId = process.env.GOOGLE_SHEET_ID;
const auth = new google.auth.GoogleAuth({ credentials: { client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/^"|"$/g, "") }, scopes: [APLICAR ? "https://www.googleapis.com/auth/spreadsheets" : "https://www.googleapis.com/auth/spreadsheets.readonly"] });
const sheets = google.sheets({ version: "v4", auth }); // en ENSAYO el alcance es de SOLO LECTURA: la API rechazaría cualquier escritura
const reint = async (fn) => { for (let i = 0; i < 6; i++) { try { return await fn(); } catch (e) { if ((e.code ?? e.response?.status) === 429) { await dormir(20000); continue; } throw e; } } throw new Error("cuota de Sheets agotada"); };
const leerValores = async (range) => (await reint(() => sheets.spreadsheets.values.get({ spreadsheetId, range, valueRenderOption: "FORMATTED_VALUE" }))).data.values ?? [];
const metaHojas = async () => { const { data } = await reint(() => sheets.spreadsheets.get({ spreadsheetId, fields: "sheets(properties(title,sheetId,gridProperties))" })); return Object.fromEntries(data.sheets.map((s) => [s.properties.title, { sheetId: s.properties.sheetId, filas: s.properties.gridProperties.rowCount }])); };
const CAMPOS_CELDA = "effectiveValue,formattedValue,userEnteredFormat(numberFormat)"; const esFecha = (t) => t === "DATE" || t === "DATE_TIME" || t === "TIME";
const estadoDe = (cel) => { if (!cel || cel.effectiveValue === undefined) return { tipo: "vacia", visto: "" }; const ev = Object.keys(cel.effectiveValue)[0]; const nf = cel.userEnteredFormat?.numberFormat;
  if (ev === "stringValue") return { tipo: "texto", texto: cel.effectiveValue.stringValue, visto: String(cel.formattedValue ?? "") };
  if (ev === "numberValue") return { tipo: esFecha(nf?.type) ? "fecha" : "numero", numero: cel.effectiveValue.numberValue, visto: String(cel.formattedValue ?? "").trim() }; return { tipo: "otro", visto: String(cel.formattedValue ?? "") }; };
// Celdas C:K de cada fila pedida (índices 0=C ítem, 2=E precio, 3=F costo, 4=G comisión, 5=H envío, 6=I pérdida, 7=J margen neto, 8=K margen %). Una solicitud con varios rangos por tanda.
const leerFilasGrid = async (filas) => { const salida = new Map(); for (let i = 0; i < filas.length; i += 40) { const tanda = filas.slice(i, i + 40);
  const { data } = await reint(() => sheets.spreadsheets.get({ spreadsheetId, ranges: tanda.map((f) => `Rentabilidad!C${f}:K${f}`), includeGridData: true, fields: `sheets(data(rowData(values(${CAMPOS_CELDA}))))` }));
  tanda.forEach((f, k) => salida.set(f, (data.sheets?.[0]?.data?.[k]?.rowData?.[0]?.values ?? []).map(estadoDe))); } return salida; };
const vista = (fila, k) => String(fila[k]?.visto ?? "").trim();

// ---------- plan ----------
async function construirPlan() {
  const valores = await leerValores("Rentabilidad!A2:Q20000"); const base = leerFilas(valores).map((x) => ({ ...x, version: clasificarVersion(x) }));
  const esc = aplicarEscenario(base, () => "bruto", calcularMargen); const t = (n) => plano(numeroComoTexto(n)); const s = (r, i) => String(r[i] ?? "").trim();
  const celdas = esc.filter((x) => x.cambia).map((x) => { const r = valores[x.fila - 2]; const motivos = [];
    if (x.version !== "V1" && x.version !== "V2") motivos.push(`la fila ${x.fila} es ${x.version} y su margen guardado no coincide con la fórmula actual: no se sabe cómo se calculó`);
    if (!Number.isFinite(x.Jn) || !Number.isFinite(x.Kn)) motivos.push("el margen corregido no es un número");
    return { fila: x.fila, item: x.item, version: x.version, entradas: { C: s(r, 2), E: s(r, 4), F: s(r, 5), G: s(r, 6), H: s(r, 7), I: s(r, 8) }, antes: { J: s(r, 9), K: s(r, 10) }, despues: { J: t(x.Jn), K: t(x.Kn) }, cambiaSigno: x.cambiaSigno, ambigua: motivos.length > 0, motivos }; });
  const porFila = new Map(celdas.map((c) => [c.fila, c])); const despues = esc.map((x) => { const c = porFila.get(x.fila); return c ? { J: Number(c.despues.J), K: Number(c.despues.K) } : { J: x.J, K: x.K }; });
  const resumen = { filas: celdas.length, V1: celdas.filter((c) => c.version === "V1").length, V2: celdas.filter((c) => c.version === "V2").length, cambianSigno: celdas.filter((c) => c.cambiaSigno).length, antes: tarjeta(base), despues: tarjeta(despues) };
  const versiones = base.reduce((a, x) => { a[x.version] = (a[x.version] ?? 0) + 1; return a; }, {});
  return { version: 1, generado: new Date().toISOString(), spreadsheetId: hash(spreadsheetId).slice(0, 12), escenario: "todo bruto", versiones, sinCosto: valores.length - base.length, resumen, celdas, porItem: resumenPorItem(esc), sha256: hash(celdas) };
}
const coincideEsperado = (res) => res.filas === ESPERADO.filas && res.V1 === ESPERADO.V1 && res.V2 === ESPERADO.V2 && res.cambianSigno === ESPERADO.cambianSigno && res.despues.n === ESPERADO.n
  && Math.round(res.despues.margenTotal) === ESPERADO.margenTotal && res.despues.pctPromedio === ESPERADO.pctPromedio && res.despues.negativas === ESPERADO.negativas;
const clp = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString("es-CL") : "—"); const pc = (n) => `${n}`.replace(".", ",");

async function ensayo() {
  log("== ENSAYO C-16 · escenario «todo bruto» (solo lectura; el alcance de la credencial es de solo lectura) ==");
  const plan = await construirPlan(); const r = plan.resumen; const amb = plan.celdas.filter((c) => c.ambigua);
  log(`Filas con costo y margen guardado: ${r.antes.n} (versiones de la fórmula: ${JSON.stringify(plan.versiones)}) · sin costo (no se tocan): ${plan.sinCosto}`);
  log(`Filas a reescribir (solo Rentabilidad!J:K): ${plan.celdas.length} (V1 ${r.V1} · V2 ${r.V2}) · AMBIGUAS: ${amb.length} · las de versión V3 no se tocan`);
  log(`Tarjeta HOY:        margen total ${clp(r.antes.margenTotal)} · % promedio ${pc(r.antes.pctPromedio)} · órdenes negativas ${r.antes.negativas}`);
  log(`Tarjeta CORREGIDA:  margen total ${clp(r.despues.margenTotal)} · % promedio ${pc(r.despues.pctPromedio)} · órdenes negativas ${r.despues.negativas} · filas que cambian de signo ${r.cambianSigno}`);
  log("Por ítem: ítem · filas · versiones · margen guardado → corregido · cambian de signo"); for (const x of plan.porItem) log(`   ${x.item.padEnd(15)} ${String(x.filas).padStart(3)} · ${Object.entries(x.versiones).map(([k, v]) => `${k}:${v}`).join(" ")} · ${clp(x.guardado).padStart(9)} → ${clp(x.corregido).padStart(9)} · signo ${x.cambianSigno}`);
  if (plan.celdas.length) log("Ejemplo de escritura (NO se ejecuta): " + JSON.stringify({ range: `Rentabilidad!J${plan.celdas[0].fila}:K${plan.celdas[0].fila}`, texto: [plan.celdas[0].despues.J, plan.celdas[0].despues.K], conApostrofo: [numeroComoTexto(Number(plan.celdas[0].despues.J)), numeroComoTexto(Number(plan.celdas[0].despues.K))] }));
  if (!coincideEsperado(r)) log(`⚠ El resultado NO coincide con lo acordado (${JSON.stringify(ESPERADO)}). ${plan.celdas.length === 0 ? "Si ya se aplicó, es lo esperado: no hay nada que proponer." : "Revisa por qué antes de aplicar: el modo aplicar se negará."}`);
  if (amb.length) { log("⚠ Filas AMBIGUAS (el modo aplicar se negará mientras haya alguna):"); amb.slice(0, 10).forEach((c) => log(`   fila ${c.fila}: ${c.motivos.join("; ")}`)); }
  if (typeof args["comparar-con"] === "string") { const previo = JSON.parse(fs.readFileSync(args["comparar-con"], "utf8")); log(previo.sha256 === plan.sha256 ? `✓ El plan es IGUAL al anterior (sha256 ${plan.sha256.slice(0, 16)}…): no cambió nada desde el plan anterior.` : `✗ El plan DIFIERE del anterior (${previo.sha256.slice(0, 16)}… → ${plan.sha256.slice(0, 16)}…): no apliques; revisa qué cambió.`); }
  fs.writeFileSync(SALIDA, JSON.stringify(plan)); log(`\nPlan guardado en ${SALIDA} (fuera del repo) · sha256 ${plan.sha256.slice(0, 16)}…`);
  log("Para aplicar (requiere TU autorización explícita, la limpieza de formatos ya hecha, respaldo previo y nada corriendo):\n  node scripts/una-vez/recalcular-margen-c16.mjs --aplicar --plan=" + SALIDA + " --respaldo=<SUFIJO>"); return 0;
}

// ---------- APLICAR ----------
async function aplicar() {
  if (typeof args.plan !== "string" || typeof args.respaldo !== "string") { console.error("--aplicar exige --plan=RUTA (generado por el ensayo) y --respaldo=SUFIJO (pestaña «Rentabilidad RESPALDO <SUFIJO>»). No se hizo nada."); return 2; }
  const plan = JSON.parse(fs.readFileSync(args.plan, "utf8")); if (plan.version !== 1 || hash(plan.celdas) !== plan.sha256) { console.error("El plan está alterado o es de otra versión (sha256 distinto). No se hizo nada."); return 2; }
  if (plan.spreadsheetId !== hash(spreadsheetId).slice(0, 12)) { console.error("El plan es de otra planilla. No se hizo nada."); return 2; }
  const amb = plan.celdas.filter((c) => c.ambigua).length; if (amb) { console.error(`El plan tiene ${amb} fila(s) AMBIGUA(S): resuélvelas antes de aplicar. No se hizo nada.`); return 2; }
  if (!coincideEsperado(plan.resumen)) { console.error(`El resumen del plan no coincide con lo acordado (${JSON.stringify(ESPERADO)}). No se hizo nada.`); return 2; }
  log(`== APLICAR: ${plan.celdas.length} filas, solo Rentabilidad!J:K (lote ${LOTE}, pausa ${PAUSA_MS} ms) ==`);
  const Lib = requireRepo(path.join(tmp, "lock-sheets.js")); const Sh = requireRepo(path.join(tmp, "sheets.js"));

  // 2. respaldo
  const meta = await metaHojas(); const nombre = `Rentabilidad RESPALDO ${args.respaldo}`; if (!meta.Rentabilidad) { console.error("No existe la pestaña Rentabilidad."); return 2; } if (!meta[nombre]) { console.error(`Falta la pestaña de respaldo «${nombre}». No se hizo nada.`); return 2; }
  const [real, resp] = [await leerValores("Rentabilidad!A1:Q20000"), await leerValores(`${nombre}!A1:Q20000`)]; const realNorm = real.map((r) => [...r]); const respNorm = resp.map((r) => [...r]); // reanudación: las filas ya escritas del plan (J:K = despues) se comparan con lo que el respaldo guardó (que debe ser el «antes» del plan)
  for (const c of plan.celdas) { const i = c.fila - 1, rr = realNorm[i] ?? [], bb = respNorm[i] ?? []; const b = (k) => String(bb[k] ?? "").trim(); const distinto = b(9) !== c.antes.J || b(10) !== c.antes.K || b(2) !== c.entradas.C || b(4) !== c.entradas.E || b(5) !== c.entradas.F || b(6) !== c.entradas.G || b(7) !== c.entradas.H || b(8) !== c.entradas.I;
    if (distinto) { console.error(`El respaldo «${nombre}» NO guarda el «antes» del plan en la fila ${c.fila}: se modificó, o se duplicó antes/después del momento del ensayo. Vuelve a duplicar la pestaña Rentabilidad (con un sufijo nuevo) y REPITE EL ENSAYO antes de aplicar. No se hizo nada.`); return 2; }
    if (String(rr[9] ?? "").trim() === c.despues.J && String(rr[10] ?? "").trim() === c.despues.K) { rr[9] = bb[9] ?? ""; rr[10] = bb[10] ?? ""; } }
  const sinCola = (f) => f.map((r) => { const x = [...r]; while (x.length && x.at(-1) === "") x.pop(); return x; });
  if (hash(sinCola(realNorm)) !== hash(sinCola(respNorm))) { console.error(`El respaldo «${nombre}» NO coincide con la hoja real (valores mostrados distintos): la hoja cambió después de duplicarla o el respaldo se modificó. Vuelve a duplicar la pestaña Rentabilidad (con un sufijo nuevo) y REPITE EL ENSAYO antes de aplicar. No se hizo nada.`); return 2; } log(`  respaldo «${nombre}»: igual a la hoja real (${real.length} filas)`);
  // 3. nada más corriendo
  const tickets = await Sh.readSheet("Locks!A2:D").catch(() => []); const ahoraS = Math.floor(Date.now() / 1000);
  const activos = tickets.filter((t) => !String(t[3] ?? "").trim() && Lib.parsearVence(t[2]) > ahoraS && /^(rentabilidad:|audit:|ml-sync)/.test(String(t[0] ?? ""))).map((t) => String(t[0]));
  if (activos.length) { console.error("Hay procesos en curso (" + [...new Set(activos)].join(", ") + "). Espera a que terminen. No se hizo nada."); return 2; }
  const snapshot = real.slice(1);

  // 4-6. lotes dentro del lock «ml-sync»
  const lotes = []; for (let i = 0; i < plan.celdas.length; i += LOTE) lotes.push(plan.celdas.slice(i, i + LOTE));
  const registro = { inicio: new Date().toISOString(), lotes: [], escritas: 0, yaEscritas: 0 }; let n = 0; const guardarRegistro = () => fs.writeFileSync(args.plan + ".registro.json", JSON.stringify(registro));
  for (const lote of lotes) { n++;
    let res; try { res = await Lib.conLock("ml-sync", async () => {
      const act = await leerFilasGrid(lote.map((c) => c.fila)); const aEscribir = []; let ya = 0;
      for (const c of lote) { const f = act.get(c.fila) ?? []; const e = c.entradas;
        const entradas = vista(f, 0) === e.C && vista(f, 2) === e.E && vista(f, 3) === e.F && vista(f, 4) === e.G && vista(f, 5) === e.H && vista(f, 6) === e.I;
        const listo = f[7]?.tipo === "texto" && f[7].texto === c.despues.J && f[8]?.tipo === "texto" && f[8].texto === c.despues.K; const eraAntes = vista(f, 7) === c.antes.J && vista(f, 8) === c.antes.K;
        if (!entradas) throw new Error(`La fila ${c.fila} cambió desde el ensayo (ítem, precio, costo, comisión, envío o pérdida ya no coinciden con el plan). Lote NO escrito.`);
        if (listo) { ya++; continue; }
        if (!eraAntes) throw new Error(`El margen de la fila ${c.fila} ya no coincide con el plan (esperaba ${c.antes.J} / ${c.antes.K}; hay ${vista(f, 7)} / ${vista(f, 8)}). Lote NO escrito.`);
        if (f[7]?.tipo === "fecha" || f[8]?.tipo === "fecha") throw new Error(`J o K de la fila ${c.fila} aún tiene formato de FECHA: falta la limpieza de formatos (S-07) antes de este recálculo. Lote NO escrito.`);
        aEscribir.push(c); }
      if (aEscribir.length) await reint(() => sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: aEscribir.map((c) => ({ updateCells: { range: { sheetId: meta.Rentabilidad.sheetId, startRowIndex: c.fila - 1, endRowIndex: c.fila, startColumnIndex: 9, endColumnIndex: 11 }, rows: [{ values: [{ userEnteredValue: { stringValue: c.despues.J } }, { userEnteredValue: { stringValue: c.despues.K } }] }], fields: "userEnteredValue" } })) } }));
      return { escritas: aEscribir.length, ya }; }); } catch (e) { console.error(`Lote ${n}/${lotes.length}: ${e?.message ?? e}\nSe detiene. Los lotes anteriores quedan escritos; este NO. Vuelve a correr con el mismo plan para reanudar.`); registro.error = String(e?.message ?? e); guardarRegistro(); return 1; }
    if (!res.ok) { console.error(`Lote ${n}/${lotes.length}: no se obtuvo el lock (${res.status}): ${res.mensaje}\nSe detiene. Lo ya escrito queda; vuelve a correr con el mismo plan para reanudar.`); guardarRegistro(); return 1; }
    registro.escritas += res.valor.escritas; registro.yaEscritas += res.valor.ya; registro.lotes.push({ n, ...res.valor }); log(`  lote ${n}/${lotes.length}: filas escritas ${res.valor.escritas}, ya escritas ${res.valor.ya}`); if (n < lotes.length) await dormir(PAUSA_MS); }

  // 7. verificación final (dentro del lock, para que el sync no escriba mientras se compara)
  let rv; try { rv = await Lib.conLock("ml-sync", async () => verificar(plan, snapshot)); } catch (e) { console.error("ERROR en la verificación: " + (e?.message ?? e)); registro.error = String(e?.message ?? e); guardarRegistro(); return 1; }
  if (!rv.ok) { console.error("No se pudo verificar (lock): " + rv.mensaje); guardarRegistro(); return 1; } const v = rv.valor; registro.verificacion = v; registro.fin = new Date().toISOString(); guardarRegistro();
  log(`\nVerificación: resumen = margen total ${clp(v.tarjeta.margenTotal)} · % promedio ${pc(v.tarjeta.pctPromedio)} · negativas ${v.tarjeta.negativas} · cambian de signo ${v.cambianSigno} → ${v.resumenOk ? "IGUAL a lo acordado" : "DISTINTO de lo acordado"}`);
  log(`  resto de la hoja sin cambios (solo J:K del plan) = ${v.restoIgual ? "sí" : "NO"} · filas del plan como texto = ${v.comoTexto}/${plan.celdas.length} · un nuevo ensayo propone ${v.nuevasPropuestas} filas`);
  const ok = v.resumenOk && v.restoIgual && v.comoTexto === plan.celdas.length && v.nuevasPropuestas === 0;
  log(ok ? "\n✓ Recálculo verificado. Si algo se ve mal: restaurar J:K desde la pestaña de respaldo; el rollback de Vercel no deshace lo escrito en las hojas." : "\n✗ La verificación FALLÓ: no sigas; revisa el registro " + SALIDA + ".registro.json y restaura desde el respaldo si hace falta.");
  return ok ? 0 : 1;
}
async function verificar(plan, snapshot) {
  const valores = await leerValores("Rentabilidad!A2:Q20000"); const norm = (filas) => filas.map((r) => { const x = [...r]; while (x.length && x.at(-1) === "") x.pop(); return x; });
  const esperado = snapshot.map((r) => [...r]); for (const c of plan.celdas) { const r = esperado[c.fila - 2]; while (r.length < 11) r.push(""); r[9] = c.despues.J; r[10] = c.despues.K; }
  const restoIgual = hash(norm(valores)) === hash(norm(esperado)); const base = leerFilas(valores); const t = tarjeta(base);
  const cambianSigno = plan.celdas.filter((c) => signo(Number(c.despues.J)) !== signo(Number(c.antes.J))).length;
  const grid = await leerFilasGrid(plan.celdas.map((c) => c.fila)); const comoTexto = plan.celdas.filter((c) => { const f = grid.get(c.fila) ?? []; return f[7]?.tipo === "texto" && f[7].texto === c.despues.J && f[8]?.tipo === "texto" && f[8].texto === c.despues.K; }).length;
  const nuevo = await construirPlan(); const resumenOk = t.n === ESPERADO.n && Math.round(t.margenTotal) === ESPERADO.margenTotal && t.pctPromedio === ESPERADO.pctPromedio && t.negativas === ESPERADO.negativas && cambianSigno === ESPERADO.cambianSigno;
  return { tarjeta: t, cambianSigno, resumenOk, restoIgual, comoTexto, nuevasPropuestas: nuevo.celdas.length };
}

const codigo = await (APLICAR ? aplicar() : ensayo()).catch((e) => { console.error("ERROR: " + (e?.message ?? e)); return 1; });
process.exit(codigo);

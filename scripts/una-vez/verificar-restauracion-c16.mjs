// HERRAMIENTA DE UN SOLO USO — C-16: verificador de la restauración. SOLO LECTURA. Comprueba que Rentabilidad es IDÉNTICA a «Rentabilidad RESPALDO <SUFIJO>»
// en toda la hoja (A1:Z): valor interno, texto mostrado y formato de número de cada celda, y que la tarjeta es la del respaldo. Sale con código 0 si todo coincide, 1 si no.
// USO: node scripts/una-vez/verificar-restauracion-c16.mjs --respaldo=SUFIJO
// Las pruebas (test-restaurar-margen-c16.mjs) usan planillas SINTÉTICAS y una API simulada; no contiene datos reales.
import fs from "node:fs";
import path from "node:path";
import Module, { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { tarjeta, leerFilas } from "./margen-c16-nucleo.mjs";
import { compararGrids } from "./restauracion-c16-nucleo.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RAIZ_API = process.env.C16_RAIZ ? path.resolve(process.env.C16_RAIZ) : REPO;
const requireApi = createRequire(path.join(RAIZ_API, "package.json"));
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
if (typeof args.respaldo !== "string" || Object.keys(args).some((k) => k !== "respaldo")) { console.error("Uso: --respaldo=SUFIJO (pestaña «Rentabilidad RESPALDO <SUFIJO>»)."); process.exit(2); }
if (!process.env.C16_RAIZ) { for (const linea of fs.readFileSync(path.join(REPO, ".env.local"), "utf-8").split("\n")) { const [k, ...r] = linea.split("="); if (k && r.length) process.env[k.trim()] = r.join("=").trim(); } }
process.env.NODE_PATH = [path.join(RAIZ_API, "node_modules"), path.join(REPO, "node_modules")].join(path.delimiter); Module._initPaths();
const { google } = requireApi("googleapis"); const spreadsheetId = process.env.GOOGLE_SHEET_ID;
const auth = new google.auth.GoogleAuth({ credentials: { client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/^"|"$/g, "") }, scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
const sheets = google.sheets({ version: "v4", auth }); const NOMBRE = `Rentabilidad RESPALDO ${args.respaldo}`;
const { data: md } = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets(properties(title,gridProperties))" }); const meta = Object.fromEntries(md.sheets.map((s) => [s.properties.title, s.properties.gridProperties]));
if (!meta.Rentabilidad || !meta[NOMBRE]) { console.error(`Falta la pestaña Rentabilidad o «${NOMBRE}».`); process.exit(2); }
const grid = async (h) => (await sheets.spreadsheets.get({ spreadsheetId, ranges: [`${h}!A1:Z${meta[h].rowCount}`], includeGridData: true, fields: "sheets(data(rowData(values(effectiveValue,formattedValue,userEnteredFormat(numberFormat)))))" })).data.sheets[0].data[0].rowData ?? [];
const valores = async (h) => (await sheets.spreadsheets.values.get({ spreadsheetId, range: `${h}!A2:Q20000`, valueRenderOption: "FORMATTED_VALUE" })).data.values ?? [];
let todoOk = true; const ok = (c, t) => { if (!c) todoOk = false; console.log("   ", c ? "✓" : "✗", t); };
console.log(`== Verificación de la restauración: Rentabilidad contra «${NOMBRE}» (solo lectura)`);
ok(`${meta.Rentabilidad.rowCount}×${meta.Rentabilidad.columnCount}` === `${meta[NOMBRE].rowCount}×${meta[NOMBRE].columnCount}`, `cuadrícula igual: ${meta.Rentabilidad.rowCount}×${meta.Rentabilidad.columnCount}`);
const c = compararGrids(await grid("Rentabilidad"), await grid(NOMBRE));
ok(c.totales.valor === 0, `valor interno idéntico en ${c.celdas} celdas (A1:Z): ${c.totales.valor} diferencias${c.valor.length ? " · p. ej. " + c.valor.join(", ") : ""}`);
ok(c.totales.mostrado === 0, `texto mostrado idéntico: ${c.totales.mostrado} diferencias${c.mostrado.length ? " · p. ej. " + c.mostrado.join(", ") : ""}`);
ok(c.totales.formato === 0, `formato de número idéntico: ${c.totales.formato} diferencias${c.formato.length ? " · p. ej. " + c.formato.join(", ") : ""}`);
const tv = tarjeta(leerFilas(await valores("Rentabilidad"))), tb = tarjeta(leerFilas(await valores(NOMBRE)));
ok(JSON.stringify(tv) === JSON.stringify(tb), `tarjeta igual a la del respaldo: margen total ${Math.round(tv.margenTotal)} · % promedio ${tv.pctPromedio} · negativas ${tv.negativas} (respaldo: ${Math.round(tb.margenTotal)} · ${tb.pctPromedio} · ${tb.negativas})`);
console.log(todoOk ? "\nRESULTADO: Rentabilidad es IDÉNTICA al respaldo." : "\nRESULTADO: HAY DIFERENCIAS con el respaldo (ver ✗)."); process.exit(todoOk ? 0 : 1);

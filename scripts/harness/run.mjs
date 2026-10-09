// Arnés de respuestas grabadas: ejecuta las rutas REALES (/api/tablero y /api/metrics) con ML y Sheets
// simulados desde una grabación, para comparar el JSON completo entre dos versiones del código.
// Ver README.md. Uso (desde la raíz del repo):
//   node scripts/harness/run.mjs <record|replay> <raíz-del-código> [carpeta-de-grabaciones] [nombre-de-salida]
//
// record: lee ML y Sheets de verdad (SOLO LECTURA; scope readonly; no refresca ni escribe tokens) y graba.
// replay: reproduce lo grabado, con el reloj congelado en el instante de la grabación.
import { register, createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const [, , mode, rootArg, recArg, nombreArg] = process.argv;
if (!["record", "replay"].includes(mode) || !rootArg) {
  console.error("Uso: node scripts/harness/run.mjs <record|replay> <raíz-del-código> [carpeta-de-grabaciones] [nombre-de-salida]");
  process.exit(1);
}
const root = resolve(rootArg);
const REC = resolve(recArg ?? resolve(HERE, "grabaciones")); // carpeta ignorada por git
const dbFile = resolve(REC, "db.json");
const outDir = resolve(REC, nombreArg ?? (mode === "record" ? "out_grabacion" : "out_replay"));
mkdirSync(outDir, { recursive: true });

// Ventanas a consultar: editar según lo que se quiera comparar. El reloj queda congelado en el momento de grabar.
const SOLICITUDES = [
  { nombre: "tablero_30d", ruta: "tablero", url: "http://x/api/tablero?dias=30" },
  { nombre: "tablero_sept", ruta: "tablero", url: "http://x/api/tablero?desde=2026-09-01T00:00:00.000Z&hasta=2026-10-01T00:00:00.000Z" },
  { nombre: "metrics_sept", ruta: "metrics", url: "http://x/api/metrics?periodo=semana&desde=2026-09-01T00:00:00.000Z&hasta=2026-10-01T00:00:00.000Z" },
  { nombre: "metrics_mes", ruta: "metrics", url: "http://x/api/metrics?periodo=mes" },
];

const RealDate = Date;
const db = existsSync(dbFile) ? JSON.parse(readFileSync(dbFile, "utf-8")) : { fixed: RealDate.now(), ml: {}, sheets: {} };
const FIXED = db.fixed;
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length === 0) super(FIXED); else super(...a); }
  static now() { return FIXED; }
};
globalThis.__H = { mode, db, token: null, leerReal: null };

if (mode === "record") {
  const req = createRequire(REPO + "/package.json");
  const { google } = req("googleapis");
  const env = {};
  for (const line of readFileSync(REPO + "/.env.local", "utf-8").split("\n")) {
    const [k, ...r] = line.split("=");
    if (k && r.length) env[k.trim()] = r.join("=").trim();
  }
  // La private key viene con "\n" literales; se convierten sin escribir barras invertidas en el código.
  const BS = String.fromCharCode(92);
  const key = (env.GOOGLE_PRIVATE_KEY || "").split(BS + "n").join(String.fromCharCode(10)).replace(/^"|"$/g, "");
  const auth = new google.auth.GoogleAuth({
    credentials: { client_email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL, private_key: key },
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  globalThis.__H.leerReal = async (range) => (await sheets.spreadsheets.values.get({ spreadsheetId: env.GOOGLE_SHEET_ID, range })).data.values || [];
  // El token se lee de Config tal como está. Si tiene más de 5 h no se usa (nunca se refresca desde acá).
  const cfg = await globalThis.__H.leerReal("Config!A:B");
  const upd = cfg.find((r) => r[0] === "ML_TOKEN_UPDATED")?.[1];
  if ((RealDate.now() - RealDate.parse(upd)) / 3600000 > 5) { console.log("token viejo: abro la app, uso cualquier función de ML y reintento"); process.exit(3); }
  globalThis.__H.token = cfg.find((r) => r[0] === "ML_ACCESS_TOKEN")?.[1];
}

register(pathToFileURL(HERE + "/hooks.mjs").href, { data: { root, stubs: HERE + "/stubs" } });
const { NextRequest } = await import(pathToFileURL(HERE + "/stubs/next-server.mjs").href);

for (const s of SOLICITUDES) {
  const mod = await import(pathToFileURL(root + "/app/api/" + s.ruta + "/route.ts").href);
  const t = RealDate.now();
  const res = await mod.GET(new NextRequest(s.url));
  const ms = RealDate.now() - t;
  writeFileSync(outDir + "/" + s.nombre + ".json", JSON.stringify(res.body));
  console.log(s.nombre.padEnd(14), "status", res.status, "ok", res.body?.ok, (ms / 1000).toFixed(1) + "s");
  if (mode === "record") writeFileSync(dbFile, JSON.stringify(db));
}
if (mode === "record") { writeFileSync(dbFile, JSON.stringify(db)); console.log("grabado:", Object.keys(db.ml).length, "URLs ML,", Object.keys(db.sheets).length, "rangos de hoja →", REC); }

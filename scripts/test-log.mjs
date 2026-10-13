// Pruebas de lib/log.ts (sin ML ni Sheets: usa servidores locales y un token FALSO).  Uso:  node scripts/test-log.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import util from "node:util";
import assert from "node:assert";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ts = require(path.join(PROJ, "node_modules", "typescript"));
const axios = require(path.join(PROJ, "node_modules", "axios"));
const out = fs.mkdtempSync(path.join(os.tmpdir(), "log-test-"));
fs.writeFileSync(path.join(out, "log.js"), ts.transpileModule(fs.readFileSync(`${PROJ}/lib/log.ts`, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 } }).outputText);
const { logError, describirError } = require(path.join(out, "log.js"));
let ok = 0; const check = (c, m) => { assert.ok(c, m); ok++; console.log("  ✓", m); };

const TOKEN = "APP_USR-1234567890123456-101010-FAKEFAKEFAKEFAKEFAKEFAKEFAKE0000-987654321";
const srv = http.createServer((q, s) => { s.statusCode = q.url.startsWith("/boom") ? 500 : 401; s.end("{}"); }).listen(0);
await new Promise((r) => srv.on("listening", r));
const cliente = axios.create({ baseURL: `http://127.0.0.1:${srv.address().port}`, headers: { Authorization: `Bearer ${TOKEN}` }, timeout: 2000 });

// Captura lo que realmente se imprimiría
function capturar(fn) { const l = []; const orig = console.error; console.error = (...a) => l.push(a.map((x) => (typeof x === "string" ? x : util.inspect(x, { depth: 6 }))).join(" ")); try { fn(); } finally { console.error = orig; } return l.join("\n"); }

console.log("el comportamiento anterior SÍ filtraba el token (control)");
const eHttp = await cliente.get("/users/525315104/items/search?status=active&offset=50", { params: { seller: 525315104 } }).catch((e) => e);
const antes = capturar(() => console.error("[ml-sync] Publicaciones", eHttp));
check(antes.includes(TOKEN), "console.error(etiqueta, error) imprime el token falso (reproduce S-02)");

console.log("con logError no sale el token ni nada de config");
const despues = capturar(() => logError("ml-sync Publicaciones", eHttp));
console.log("    salida →", despues);
check(!despues.includes(TOKEN) && !despues.includes("APP_USR") && !/Bearer/i.test(despues), "la salida no contiene el token ni 'Bearer'");
check(!/authorization|headers|config|params|offset=|status=active/i.test(despues.replace(/status=401/, "")), "no imprime headers, config, params ni query");
check(!despues.includes("525315104"), "no imprime el ID de usuario/orden de la URL");
check(despues.includes("[ml-sync Publicaciones]") && despues.includes("status=401") && despues.includes("GET /users/:id/items/search"), "sí imprime contexto, status HTTP y método + ruta");
check(despues.split("\n").length === 1, "una sola línea (sin stack ni objetos)");

console.log("otros tipos de error");
const e500 = await cliente.get("/boom").catch((e) => e); check(describirError(e500).includes("status=500") && !describirError(e500).includes(TOKEN), "HTTP 500: status=500 y sin token");
const eRed = await axios.create({ baseURL: "http://127.0.0.1:9", headers: { Authorization: `Bearer ${TOKEN}` }, timeout: 1500 }).get("/x").catch((e) => e); const dRed = describirError(eRed); console.log("    salida →", dRed);
check(/code=ECONNREFUSED/.test(dRed) && !dRed.includes(TOKEN), "error de red: code=ECONNREFUSED y sin token");
const eGoogle = Object.assign(new Error("The caller does not have permission"), { name: "GaxiosError", code: 403, config: { url: "https://sheets.googleapis.com/v4/spreadsheets/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/values/Config!A:B", method: "GET", headers: { Authorization: `Bearer ${TOKEN}` } } });
const dG = describirError(eGoogle); console.log("    salida →", dG);
check(dG.includes("status=403") && !dG.includes(TOKEN) && dG.includes("GET /v4/spreadsheets/:id/values/Config!A:B") && !dG.includes("1AbCdEf"), "error tipo googleapis: status=403, ruta sin token y sin el ID del spreadsheet");
const dMsg = describirError(new Error(`falló con Authorization: Bearer ${TOKEN} y ${TOKEN}`)); check(!dMsg.includes(TOKEN) && dMsg.includes("[censurado]"), "un token dentro del mensaje se censura");
check(!describirError(new Error("x\n-----BEGIN PRIVATE KEY-----\nMIIEvQ...\n-----END PRIVATE KEY-----")).includes("MIIEvQ"), "una clave PEM dentro del mensaje se censura");
check(describirError("texto").includes("texto") && describirError(null) === "error desconocido" && describirError(42) === "42", "string, null y número no rompen");
check(describirError(new Error("a".repeat(5000))).length < 400, "los mensajes largos se recortan");
const circular = {}; circular.self = circular; check(typeof describirError(circular) === "string", "objeto circular no rompe");
srv.close(); console.log(`\n${ok} comprobaciones OK`);

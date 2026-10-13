// Pruebas de lib/ml-token.ts SIN ML real ni Sheets reales: Sheets es una hoja en memoria, el refresh de ML es un simulado
// y los reintentos ante 401 se prueban con un servidor HTTP local.  Uso:  node scripts/test-ml-token.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import util from "node:util";
import assert from "node:assert";
import Module, { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ts = require(path.join(PROJ, "node_modules", "typescript"));
process.env.NODE_PATH = path.join(PROJ, "node_modules"); Module._initPaths();
Object.assign(process.env, { GOOGLE_SHEET_ID: "hoja-falsa", GOOGLE_SERVICE_ACCOUNT_EMAIL: "a@b.c", GOOGLE_PRIVATE_KEY: "falsa", ML_CLIENT_ID: "1", ML_CLIENT_SECRET: "secreto-falso", ML_ACCESS_TOKEN: "ENV-ACCESS-VIEJO", ML_REFRESH_TOKEN: "ENV-REFRESH-VIEJO" });

const out = fs.mkdtempSync(path.join(os.tmpdir(), "ml-token-test-"));
for (const [origen, destino] of [["lib/log.ts", "log.js"], ["lib/ml-token.ts", "ml-token.js"]]) {
  const src = fs.readFileSync(path.join(PROJ, origen), "utf8").replace(/from "@\/lib\/([\w-]+)"/g, 'from "./$1"');
  fs.writeFileSync(path.join(out, destino), ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText);
}
// googleapis simulado: la pestaña Config vive en globalThis.__hoja
fs.mkdirSync(path.join(out, "node_modules", "googleapis"), { recursive: true });
fs.writeFileSync(path.join(out, "node_modules", "googleapis", "index.js"), `
const H = () => globalThis.__hoja;
const quitar = (k) => { if (H()[k] > 0) { H()[k]--; return true; } return false; };
exports.google = { auth: { GoogleAuth: class {} }, sheets: () => ({ spreadsheets: {
  get: async () => ({ data: { sheets: [{ properties: { title: "Config" } }] } }), batchUpdate: async () => ({}),
  values: {
    get: async () => { H().lecturas++; if (quitar("fallarLecturas")) throw new Error("quota exceeded"); if (H().alLeer) H().alLeer(H().lecturas); return { data: { values: H().config.map((r) => [...r]) } }; },
    batchUpdate: async (r) => { if (quitar("fallarEscrituras")) throw new Error("sheets caído"); H().escrituras++; for (const d of r.requestBody.data) { const fila = Number(d.range.match(/B(\\d+)/)[1]) - 1; H().config[fila][1] = d.values[0][0]; } return {}; },
    append: async (r) => { H().escrituras++; for (const v of r.requestBody.values) H().config.push(v); return {}; },
  } } }) };`);
const axios = require("axios"); // el mismo módulo que usará lib/ml-token
const rutaMod = path.join(out, "ml-token.js");
const cargar = () => { for (const k of Object.keys(require.cache)) if (k.startsWith(out) && !k.includes("node_modules")) delete require.cache[k]; const m = require(rutaMod); m._configuracion.esperasEscrituraMs = [0, 0]; m._configuracion.esperasReleerMs = [0, 0, 0]; return m; };

let ok = 0; const check = (c, m) => { assert.ok(c, m); ok++; console.log("  ✓", m); };
const hace = (ms) => new Date(Date.now() - ms).toISOString(); const H6 = 6 * 3600e3, H1 = 3600e3;
const nuevaHoja = (access, refresh, edadMs) => { globalThis.__hoja = { config: [["ML_ACCESS_TOKEN", access], ["ML_REFRESH_TOKEN", refresh], ["ML_TOKEN_UPDATED", hace(edadMs)]], lecturas: 0, escrituras: 0, fallarLecturas: 0, fallarEscrituras: 0, alLeer: null }; };
const cfg = (k) => globalThis.__hoja.config.find((r) => r[0] === k)?.[1];
const mlSim = { posts: 0, gets: 0, modo: "ok", n: 0 };
const resetML = () => { Object.assign(mlSim, { posts: 0, gets: 0, modo: "ok", n: 0 }); };
const err = (status, data) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data }, config: { url: "https://api.mercadolibre.com/oauth/token", method: "post", headers: { Authorization: "Bearer NO-DEBE-SALIR" } } });
axios.post = async (url, body) => { mlSim.posts++; await new Promise((r) => setTimeout(r, 15)); if (mlSim.modo === "500") throw err(500, {}); if (mlSim.modo === "invalid_grant") throw err(400, { error: "invalid_grant", message: "Error validating grant. Your authorization code or refresh token may be expired or it was already used" }); mlSim.n++; return { data: { access_token: `NUEVO-ACCESS-${mlSim.n}`, refresh_token: `NUEVO-REFRESH-${mlSim.n}`, expires_in: 21600 } }; };
axios.get = async () => { mlSim.gets++; throw new Error("NO debería llamarse: se sondeó a ML"); }; // cualquier GET directo de axios sería un sondeo
const logs = []; const origError = console.error; console.error = (...a) => logs.push(a.map((x) => (typeof x === "string" ? x : util.inspect(x, { depth: 4 }))).join(" "));
const sinLogs = () => { logs.length = 0; };

console.log("1. token vigente: ninguna llamada de sondeo ni de refresh");
{ let m = cargar(); nuevaHoja("ACCESS-VIGENTE", "REFRESH-1", H1); resetML();
  const t = await m.getValidAccessToken(); check(t === "ACCESS-VIGENTE", "devuelve el token guardado");
  check(mlSim.posts === 0 && mlSim.gets === 0, "0 llamadas a ML (ni refresh ni /users/me): antes se hacía un sondeo por cada llamada");
  check(globalThis.__hoja.escrituras === 0 && globalThis.__hoja.lecturas === 1, "0 escrituras y una sola lectura de Config"); }

console.log("2. refresh en paralelo: N llamadas simultáneas = 1 solo refresh");
{ let m = cargar(); nuevaHoja("ACCESS-VENCIDO", "REFRESH-1", H6); resetML();
  const r = await Promise.all(Array.from({ length: 25 }, () => m.getValidAccessToken()));
  check(mlSim.posts === 1, `25 llamadas simultáneas → ${mlSim.posts} refresh`); check(new Set(r).size === 1 && r[0] === "NUEVO-ACCESS-1", "las 25 reciben el mismo token nuevo");
  check(cfg("ML_ACCESS_TOKEN") === "NUEVO-ACCESS-1" && cfg("ML_REFRESH_TOKEN") === "NUEVO-REFRESH-1" && globalThis.__hoja.escrituras === 1, "el par nuevo se guardó en Config con una sola escritura");
  check((await m.getValidAccessToken()) === "NUEVO-ACCESS-1" && mlSim.posts === 1, "la llamada siguiente usa el token guardado sin otro refresh"); }
{ let m = cargar(); nuevaHoja("ACCESS-VENCIDO", "REFRESH-1", H6); resetML(); globalThis.__hoja.alLeer = null;
  const primera = m.getValidAccessToken(); await new Promise((r) => setTimeout(r, 5)); const tardia = m.getValidAccessToken(); const [a, b] = await Promise.all([primera, tardia]);
  check(a === b && mlSim.posts === 1, "una llamada que llega mientras otra renueva se une a esa renovación"); }

console.log("3. refresh fallido (HTTP 500)");
{ let m = cargar(); nuevaHoja("ACCESS-VENCIDO", "REFRESH-1", H6); resetML(); mlSim.modo = "500"; sinLogs();
  const e = await m.getValidAccessToken().then(() => null, (x) => x);
  check(e && /No se pudo renovar el token.*HTTP 500/.test(e.message) && !/NO-DEBE-SALIR|REFRESH-1/.test(e.message), `lanza un error claro sin tokens: «${e?.message}»`);
  check(globalThis.__hoja.escrituras === 0 && cfg("ML_REFRESH_TOKEN") === "REFRESH-1", "no escribe nada en Config: el refresh token sigue intacto");
  mlSim.modo = "ok"; check((await m.getValidAccessToken()) === "NUEVO-ACCESS-1", "un error transitorio no queda pegado: la llamada siguiente renueva bien");
  check(logs.every((l) => !/NO-DEBE-SALIR|REFRESH-1|Bearer/.test(l)), "los logs no contienen tokens ni headers"); }

console.log("4. dos instancias a la vez (invalid_grant porque la otra ya renovó)");
{ let m = cargar(); nuevaHoja("ACCESS-VENCIDO", "REFRESH-1", H6); resetML(); mlSim.modo = "invalid_grant";
  globalThis.__hoja.alLeer = (n) => { if (n === 3) { globalThis.__hoja.config = [["ML_ACCESS_TOKEN", "DE-LA-OTRA-INSTANCIA"], ["ML_REFRESH_TOKEN", "REFRESH-OTRA"], ["ML_TOKEN_UPDATED", hace(1000)]]; } };
  const t = await m.getValidAccessToken();
  check(t === "DE-LA-OTRA-INSTANCIA", "tras invalid_grant relee Config y usa el par que la otra instancia guardó");
  check(mlSim.posts === 1 && globalThis.__hoja.escrituras === 0, "no reintenta el refresh ni pisa lo que escribió la otra instancia"); }
{ let m = cargar(); nuevaHoja("ACCESS-VENCIDO", "REFRESH-1", H6); resetML(); mlSim.modo = "invalid_grant"; sinLogs();
  const e = await m.getValidAccessToken().then(() => null, (x) => x);
  check(e?.name === "ErrorReautorizar" && /\/api\/auth\/login/.test(e.message), `nadie renovó → ErrorReautorizar: «${e?.message}»`);
  const posts = mlSim.posts; const e2 = await m.getValidAccessToken().then(() => null, (x) => x);
  check(e2?.name === "ErrorReautorizar" && mlSim.posts === posts, "el fallo no se repite contra ML durante un minuto (no se martilla con un refresh token ya gastado)");
  globalThis.__hoja.config = [["ML_ACCESS_TOKEN", "TOKEN-RE-AUTORIZADO"], ["ML_REFRESH_TOKEN", "RT-RE"], ["ML_TOKEN_UPDATED", hace(1000)]];
  check((await m.getValidAccessToken()) === "TOKEN-RE-AUTORIZADO", "tras re-autorizar por /api/auth/login (Config nueva) se recupera sin esperar");
  check(logs.every((l) => !/NO-DEBE-SALIR|REFRESH-1|Bearer/.test(l)), "los logs no contienen tokens ni headers"); }

console.log("5. refresh exitoso en ML pero la escritura en Sheets falla");
{ let m = cargar(); nuevaHoja("ACCESS-VENCIDO", "REFRESH-1", H6); resetML(); globalThis.__hoja.fallarEscrituras = 1; sinLogs();
  const t = await m.getValidAccessToken(); check(t === "NUEVO-ACCESS-1" && cfg("ML_ACCESS_TOKEN") === "NUEVO-ACCESS-1", "falla el 1er intento de escritura, el 2º lo guarda: sin pérdida y sin alarma");
  check(!logs.some((l) => /ATENCIÓN/.test(l)), "…y sin mensaje de alerta"); }
{ let m = cargar(); nuevaHoja("ACCESS-VENCIDO", "REFRESH-1", H6); resetML(); globalThis.__hoja.fallarEscrituras = 99; sinLogs();
  const t = await m.getValidAccessToken();
  check(t === "NUEVO-ACCESS-1", "los 3 intentos fallan: igual se devuelve el token nuevo, así la llamada en curso no se pierde");
  check(cfg("ML_REFRESH_TOKEN") === "REFRESH-1", "(Config sigue con el refresh token viejo, que ML ya consumió)");
  check(logs.some((l) => /ATENCIÓN.*NO se pudo guardar.*\/api\/auth\/login/.test(l)) && logs.every((l) => !/NUEVO-ACCESS|NUEVO-REFRESH|REFRESH-1/.test(l)), "queda un aviso claro en el log, sin ningún token");
  const t2 = await m.getValidAccessToken(); check(t2 === "NUEVO-ACCESS-1" && mlSim.posts === 1, "mientras la instancia vive, usa el par en memoria: no pide otro refresh (que fallaría)");
  globalThis.__hoja.fallarEscrituras = 0; await m.getValidAccessToken(); await new Promise((r) => setTimeout(r, 30));
  check(cfg("ML_ACCESS_TOKEN") === "NUEVO-ACCESS-1" && cfg("ML_REFRESH_TOKEN") === "NUEVO-REFRESH-1", "cuando Sheets vuelve, la siguiente llamada guarda el par pendiente");
  // último recurso: la instancia se recicla antes de poder guardar
  nuevaHoja("ACCESS-VENCIDO", "REFRESH-1", H6); resetML(); globalThis.__hoja.fallarEscrituras = 99; let m1 = cargar(); await m1.getValidAccessToken();
  globalThis.__hoja.fallarEscrituras = 0; mlSim.modo = "invalid_grant"; const m2 = cargar(); // instancia nueva: sin memoria del par renovado
  const e = await m2.getValidAccessToken().then(() => null, (x) => x);
  check(e?.name === "ErrorReautorizar" && /Re-autoriza la app en \/api\/auth\/login/.test(e.message), `si la instancia se recicla antes de guardar → mensaje claro de re-autorizar: «${e?.message}»`); }
console.log("6. Sheets caído al leer Config");
{ let m = cargar(); nuevaHoja("ACCESS-VENCIDO", "REFRESH-1", H6); resetML(); globalThis.__hoja.fallarLecturas = 1;
  const e = await m.getValidAccessToken().then(() => null, (x) => x);
  check(e && /No se pudo leer la configuración de tokens/.test(e.message) && mlSim.posts === 0, "no cae a los tokens de las variables de entorno (ya vencidos): error claro y 0 refresh"); }

console.log("7. reintento único ante 401 (cliente axios real contra un servidor local)");
const visto = []; let validos = new Set(["NUEVO-ACCESS-1"]);
const srv = http.createServer((q, s) => { visto.push(q.headers.authorization.replace("Bearer ", "")); s.statusCode = validos.has(q.headers.authorization.replace("Bearer ", "")) ? 200 : 401; s.setHeader("content-type", "application/json"); setTimeout(() => s.end("{}"), 10); }).listen(0);
await new Promise((r) => srv.on("listening", r)); const base = `http://127.0.0.1:${srv.address().port}`;
const cliente = (m, token) => { const c = axios.create({ baseURL: base, headers: { Authorization: `Bearer ${token}` } }); m.instalarReintento401(c, token); return c; };
{ let m = cargar(); nuevaHoja("TOKEN-VIEJO", "REFRESH-1", H1); resetML(); visto.length = 0; validos = new Set(["NUEVO-ACCESS-1"]);
  const c = cliente(m, "TOKEN-VIEJO"); const r = await c.get("/x");
  check(r.status === 200 && mlSim.posts === 1 && visto.join(",") === "TOKEN-VIEJO,NUEVO-ACCESS-1", `401 → 1 refresh → reintento con el token nuevo → 200 (el servidor vio: ${visto.join(" → ")})`);
  visto.length = 0; await c.get("/y"); check(visto.join(",") === "NUEVO-ACCESS-1" && mlSim.posts === 1, "las llamadas siguientes del cliente ya usan el token nuevo (sin otro 401 ni refresh)"); }
{ let m = cargar(); nuevaHoja("TOKEN-VIEJO", "REFRESH-1", H1); resetML(); visto.length = 0; validos = new Set(["NUEVO-ACCESS-1"]);
  const c = cliente(m, "TOKEN-VIEJO"); const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => c.get("/p" + i)));
  check(rs.every((x) => x.status === 200) && mlSim.posts === 1, `12 llamadas simultáneas con 401 → ${mlSim.posts} solo refresh y las 12 terminan en 200`); }
{ let m = cargar(); nuevaHoja("TOKEN-VIEJO", "REFRESH-1", H1); resetML(); visto.length = 0; validos = new Set();
  const c = cliente(m, "TOKEN-VIEJO"); const e = await c.get("/x").then(() => null, (x) => x);
  check(e?.response?.status === 401 && visto.length === 2 && mlSim.posts === 1, `si el token nuevo también da 401, se rinde: ${visto.length} peticiones, ${mlSim.posts} refresh, sin bucle`); }
{ let m = cargar(); nuevaHoja("TOKEN-VIEJO", "REFRESH-1", H1); resetML(); visto.length = 0; validos = new Set(["OTRO-YA-RENOVO"]);
  globalThis.__hoja.config = [["ML_ACCESS_TOKEN", "OTRO-YA-RENOVO"], ["ML_REFRESH_TOKEN", "RT-OTRO"], ["ML_TOKEN_UPDATED", hace(500)]];
  const c = cliente(m, "TOKEN-VIEJO"); const r = await c.get("/x"); check(r.status === 200 && mlSim.posts === 0, "si otra instancia ya renovó (Config tiene otro token), reintenta con ese SIN gastar otro refresh"); }
{ let m = cargar(); nuevaHoja("TOKEN-VIEJO", "REFRESH-1", H1); resetML(); mlSim.modo = "invalid_grant"; visto.length = 0; validos = new Set();
  const c = cliente(m, "TOKEN-VIEJO"); const e = await c.get("/x").then(() => null, (x) => x);
  check(e?.response?.status === 401 && /\/api\/auth\/login/.test(e.message), `renovación imposible → conserva el 401 y el mensaje dice cómo re-autorizar: «${e?.message}»`); }
console.log("8. el reintento ante 401 NO se aplica al refresh (OAuth) y un 401 del refresh no dispara otro refresh");
{ check(axios.interceptors.response.handlers.length === 0 && axios.interceptors.request.handlers.length === 0, "axios global sin interceptores: el refresh usa axios.post global, no un cliente con instalarReintento401");
  const m = cargar(); const c0 = axios.create({ baseURL: base }); m.instalarReintento401(c0, "X");
  check(axios.interceptors.response.handlers.length === 0 && c0.interceptors.response.handlers.length === 1, "instalarReintento401 solo toca el cliente que recibe; no contamina axios global ni otros clientes");
  nuevaHoja("TOKEN-VIEJO", "REFRESH-1", H1); resetML(); visto.length = 0; validos = new Set();
  const posts401 = axios.post; let llamadas = 0; axios.post = async () => { llamadas++; throw err(401, { message: "unauthorized", error: "unauthorized" }); };
  const c = cliente(m, "TOKEN-VIEJO"); const e = await c.get("/x").then(() => null, (x) => x);
  check(e?.response?.status === 401 && llamadas === 1 && visto.length === 1, `llamada a ML con 401 → el refresh recibe otro 401 → se rinde: ${llamadas} refresh (no recursivo), ${visto.length} sola petición, sin reintento`);
  const antes = llamadas; const m2 = cargar(); nuevaHoja("VENCIDO", "REFRESH-1", H6); llamadas = 0; const e2 = await m2.getValidAccessToken().then(() => null, (x) => x);
  check(e2 && llamadas === 1 && /HTTP 401/.test(e2.message), `getValidAccessToken con el refresh devolviendo 401 → error claro tras ${llamadas} solo refresh: «${e2?.message}»`);
  axios.post = posts401; }
srv.close();
check(logs.every((l) => !/NO-DEBE-SALIR|Bearer/.test(l)), "ningún log de toda la corrida contiene headers ni tokens");
console.error = origError; console.log(`\n${ok} comprobaciones OK`);

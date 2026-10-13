// Pruebas del flujo OAuth (login → callback) y del middleware, SIN red: axios, saveTokens y ML están simulados.  Uso:  node scripts/test-oauth-state.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import util from "node:util";
import assert from "node:assert";
import Module, { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ts = require(path.join(PROJ, "node_modules", "typescript"));
process.env.NODE_PATH = path.join(PROJ, "node_modules"); Module._initPaths(); // para resolver next/server desde el directorio temporal

process.env.ADMIN_PASSWORD = "clave-de-prueba"; process.env.ML_CLIENT_ID = "111"; process.env.ML_CLIENT_SECRET = "secreto-falso"; process.env.ML_REDIRECT_URI = "https://app.test/api/auth/callback";
const TOKEN_FALSO = "APP_USR-9999-FAKETOKEN-0000-1234";

// Transpila lo necesario a un directorio plano (reescribiendo "@/lib/x" → "./x") y simula axios y lib/ml-token.
const out = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-test-"));
const compilar = (origen, destino) => {
  const src = fs.readFileSync(path.join(PROJ, origen), "utf8").replace(/from "@\/lib\/([\w-]+)"/g, 'from "./$1"');
  fs.writeFileSync(path.join(out, destino), ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);
};
compilar("lib/auth.ts", "auth.js"); compilar("lib/oauth-state.ts", "oauth-state.js"); compilar("lib/log.ts", "log.js");
compilar("app/api/auth/login/route.ts", "login.js"); compilar("app/api/auth/callback/route.ts", "callback.js"); compilar("middleware.ts", "middleware.js");
fs.writeFileSync(path.join(out, "ml-token.js"), `exports.guardados = []; exports.fallar = false; exports.saveTokens = async (a, r) => { if (exports.fallar) throw new Error("sheets caído"); exports.guardados.push([a, r]); };`);
fs.mkdirSync(path.join(out, "node_modules", "axios"), { recursive: true });
fs.writeFileSync(path.join(out, "node_modules", "axios", "index.js"), `const api = { llamadas: [], modo: "ok",
  post: async (url, body) => { api.llamadas.push({ url, code: body.get("code") }); if (api.modo === "error") { throw Object.assign(new Error("Request failed with status code 400"), { response: { status: 400, data: { message: "invalid_grant", detalle_interno: "SECRETO-DE-ML" } }, config: { url, method: "post", headers: { Authorization: "Bearer ${TOKEN_FALSO}" } } }); } return { data: { access_token: "AT-NUEVO", refresh_token: "RT-NUEVO" } }; } };
module.exports = { __esModule: true, default: api, ...api, api };`);
const axiosStub = require(path.join(out, "node_modules", "axios"));
const mlToken = require(path.join(out, "ml-token.js"));
const { NextRequest } = require("next/server");
const { createSessionToken } = require(path.join(out, "auth.js"));
const estado = require(path.join(out, "oauth-state.js"));
const login = require(path.join(out, "login.js")); const callback = require(path.join(out, "callback.js")); const { middleware } = require(path.join(out, "middleware.js"));

let ok = 0; const check = (c, m) => { assert.ok(c, m); ok++; console.log("  ✓", m); };
const URLB = "https://app.test";
const req = (ruta, cookies = {}) => new NextRequest(URLB + ruta, { headers: { cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ") } });
const setCookie = (res, nombre) => (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith(nombre + "="));
const valorCookie = (sc) => sc.split(";")[0].split("=").slice(1).join("=");
const sesion = await createSessionToken();
const esLogin = (res) => res.status >= 300 && res.status < 400 && new URL(res.headers.get("location")).pathname === "/login";
const reset = () => { mlToken.guardados.length = 0; axiosStub.api.llamadas.length = 0; axiosStub.api.modo = "ok"; mlToken.fallar = false; };
function capturarLog(fn) { const l = []; const orig = console.error; console.error = (...a) => l.push(a.map((x) => (typeof x === "string" ? x : util.inspect(x, { depth: 5 }))).join(" ")); return fn().then((r) => { console.error = orig; return { r, log: l.join("\n") }; }, (e) => { console.error = orig; throw e; }); }

console.log("middleware");
check(esLogin(await middleware(req("/api/auth/login"))), "/api/auth/login SIN sesión → redirige a /login (ya no es pública)");
check((await middleware(req("/api/auth/login", { ml_session: sesion }))).headers.get("x-middleware-next") === "1", "/api/auth/login CON sesión → pasa");
check(esLogin(await middleware(req("/api/auth/callback?code=x&state=y"))), "/api/auth/callback SIN cookie de estado → redirige a /login (ya no es pública)");
check(esLogin(await middleware(req("/api/auth/callback?code=x&state=y", { ml_session: sesion }))), "/api/auth/callback con sesión pero sin cookie de estado → redirige a /login");
const { nonce, cookie } = await estado.crearEstadoOauth();
check((await middleware(req("/api/auth/callback", { ml_oauth_state: cookie }))).headers.get("x-middleware-next") === "1", "/api/auth/callback con cookie de estado válida → pasa");
const [n, e, f] = cookie.split(".");
check(esLogin(await middleware(req("/api/auth/callback", { ml_oauth_state: `${n}.${e}.${f.slice(0, -2)}AA` }))), "cookie con la firma alterada → /login");
check(esLogin(await middleware(req("/api/auth/callback", { ml_oauth_state: `OTRO.${e}.${f}` }))), "cookie con el nonce cambiado → /login");
check(esLogin(await middleware(req("/api/auth/callback", { ml_oauth_state: `${n}.${Number(e) + 60000}.${f}` }))), "cookie con la expiración alargada a mano → /login");
check(esLogin(await middleware(req("/api/auth/callback", { ml_oauth_state: sesion }))), "un token de SESIÓN no vale como cookie de estado → /login");
const vencida = await (async () => { const real = Date.now; Date.now = () => real() - 11 * 60 * 1000; try { return (await estado.crearEstadoOauth()).cookie; } finally { Date.now = real; } })();
check(esLogin(await middleware(req("/api/auth/callback", { ml_oauth_state: vencida }))), "cookie vencida (más de 10 min) → /login");
check((await middleware(req("/api/version"))).headers.get("x-middleware-next") === "1" && (await middleware(req("/api/ml-notifications"))).headers.get("x-middleware-next") === "1", "rutas públicas restantes (/api/version, webhook) siguen igual");

console.log("login: emite el state");
const rl = await login.GET(); const sc = setCookie(rl, "ml_oauth_state"); const urlML = new URL(rl.headers.get("location"));
check(rl.status === 307 && urlML.origin === "https://auth.mercadolibre.cl" && urlML.searchParams.get("response_type") === "code" && urlML.searchParams.get("client_id") === "111", "redirige a ML con response_type, client_id y redirect_uri");
check(!!urlML.searchParams.get("state") && urlML.searchParams.get("state").length >= 30, `manda un state aleatorio (${urlML.searchParams.get("state").length} caracteres)`);
check(/HttpOnly/i.test(sc) && /SameSite=lax/i.test(sc) && /Max-Age=600/i.test(sc) && /Path=\/api\/auth\/callback/i.test(sc), `cookie: ${sc.replace(/=[^;]+/, "=<valor>")}`);
check((await estado.leerEstadoOauth(valorCookie(sc))) === urlML.searchParams.get("state"), "la cookie firmada contiene exactamente el mismo nonce que viajó en el state");
const rl2 = await login.GET(); check(urlML.searchParams.get("state") !== new URL(rl2.headers.get("location")).searchParams.get("state"), "cada llamada genera un state distinto");
process.env.NODE_ENV = "production"; check(/;\s*Secure/i.test(setCookie(await login.GET(), "ml_oauth_state")), "en producción la cookie lleva Secure"); process.env.NODE_ENV = "test";

console.log("callback (ML simulado)");
const cbOk = (state, ck) => callback.GET(req(`/api/auth/callback?code=CODIGO-123${state === null ? "" : "&state=" + state}`, ck ? { ml_oauth_state: ck } : {}));
reset(); let r = await cbOk(nonce, null);
check(r.status === 400 && axiosStub.api.llamadas.length === 0 && mlToken.guardados.length === 0, "sin cookie de estado → 400, no llama a ML ni guarda tokens");
reset(); r = await cbOk(null, cookie);
check(r.status === 400 && axiosStub.api.llamadas.length === 0 && mlToken.guardados.length === 0, "state ausente → 400, no llama a ML ni guarda tokens");
check(/Max-Age=0/i.test(setCookie(r, "ml_oauth_state")), "…y la cookie de estado se borra");
reset(); r = await cbOk("estado-incorrecto-" + "x".repeat(20), cookie);
check(r.status === 400 && axiosStub.api.llamadas.length === 0 && mlToken.guardados.length === 0, "state incorrecto → 400, no llama a ML ni guarda tokens");
reset(); r = await cbOk(nonce.slice(0, -1) + (nonce.endsWith("A") ? "B" : "A"), cookie); check(r.status === 400 && axiosStub.api.llamadas.length === 0, "state que difiere en 1 solo carácter → 400");
reset(); r = await callback.GET(req(`/api/auth/callback?state=${nonce}`, { ml_oauth_state: cookie }));
check(r.status === 400 && axiosStub.api.llamadas.length === 0, "state correcto pero sin code → 400, no llama a ML");
reset(); r = await cbOk(nonce, cookie); let cuerpo = await r.json();
check(r.status === 200 && cuerpo.ok === true && axiosStub.api.llamadas.length === 1 && axiosStub.api.llamadas[0].code === "CODIGO-123", "state correcto → 200 y un solo intercambio de code con ML");
check(mlToken.guardados.length === 1 && mlToken.guardados[0][0] === "AT-NUEVO" && mlToken.guardados[0][1] === "RT-NUEVO", "los tokens nuevos se guardan una sola vez");
check(/Max-Age=0/i.test(setCookie(r, "ml_oauth_state")) && /Path=\/api\/auth\/callback/i.test(setCookie(r, "ml_oauth_state")), "la cookie de estado se borra tras el éxito (un solo uso)");
// Reutilización: el navegador ya no tiene la cookie (la borró), así que el segundo intento llega SIN cookie y el middleware lo frena.
reset(); const reuso = await middleware(req(`/api/auth/callback?code=CODIGO-123&state=${nonce}`));
check(esLogin(reuso) && axiosStub.api.llamadas.length === 0, "state reutilizado (el navegador ya borró la cookie) → el middleware lo manda a /login; no llega a ML");
reset(); axiosStub.api.modo = "error";
const { r: rErr, log } = await capturarLog(() => cbOk(nonce, cookie)); const txt = await rErr.text();
check(rErr.status === 500 && !/invalid_grant|SECRETO-DE-ML|detalle_interno/.test(txt), `error de ML → 500 con mensaje genérico, sin el cuerpo de ML: ${txt.slice(0, 90)}…`);
check(log.split("\n").length === 1 && log.includes("[auth/callback]") && log.includes("status=400") && !log.includes(TOKEN_FALSO) && !/Bearer|SECRETO-DE-ML/.test(log), `el detalle queda en UNA línea de log sin token: ${log}`);
check(mlToken.guardados.length === 0 && /Max-Age=0/i.test(setCookie(rErr, "ml_oauth_state")), "con error no se guarda nada y la cookie igual se borra");
reset(); mlToken.fallar = true; const { r: rS } = await capturarLog(() => cbOk(nonce, cookie)); check(rS.status === 500 && !(await rS.text()).includes("sheets caído"), "si falla saveTokens (Sheets) → 500 genérico, sin el mensaje interno");
console.log(`\n${ok} comprobaciones OK`);

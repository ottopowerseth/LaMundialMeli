import axios, { AxiosInstance } from "axios";
import { google } from "googleapis";
import { logError } from "@/lib/log";

const SHEET_ID = process.env.GOOGLE_SHEET_ID!;
const CONFIG_TAB = "Config";

// ── Vida del token ──────────────────────────────────────────────────────────────────────────────────────────────
// ML entrega access tokens de 6 h (expires_in = 21600). La hoja guarda ML_TOKEN_UPDATED (cuándo se guardó el par) y
// con eso se decide si renovar, SIN llamar a ML para probarlo. Se renueva con 30 min de margen; si el token resultara
// inválido igual (revocado, reloj), el cliente recibe un 401 y reintenta UNA vez con un token nuevo
// (ver instalarReintento401).
const VIDA_TOKEN_MS = 6 * 60 * 60 * 1000;
const MARGEN_MS = 30 * 60 * 1000;

// Ajustable solo por las pruebas (sin esperas reales).
export const _configuracion = {
  esperasEscrituraMs: [500, 1500],       // entre intentos de guardar el par nuevo en Config (3 intentos en total)
  esperasReleerMs: [0, 1000, 2000, 3000], // al recibir invalid_grant: cuándo releer Config por si otra instancia renovó
  falloSticky: 60_000,                   // tras un fallo de renovación irrecuperable, no volver a intentarlo durante este tiempo
};

export class ErrorReautorizar extends Error {
  constructor() {
    super("La conexión con Mercado Libre venció y no se pudo renovar. Re-autoriza la app en /api/auth/login.");
    this.name = "ErrorReautorizar";
  }
}

type Par = { accessToken: string; refreshToken: string; actualizadoMs: number };

// Estado de ESTA instancia serverless (no se comparte entre instancias).
let refrescoEnCurso: Promise<string> | null = null; // single-flight: todas las llamadas simultáneas comparten una renovación
let parSinGuardar: Par | null = null;               // renovación exitosa en ML cuya escritura en Config no se pudo completar
let falloReciente: { ms: number; error: Error } | null = null;

const esperar = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

// ── Acceso a Config (Sheets) ────────────────────────────────────────────────────────────────────────────────────
function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/^"|"$/g, ""),
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

async function ensureConfigTab() {
  const sheets = getSheetsClient();
  const { data } = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const exists = data.sheets?.some((s) => s.properties?.title === CONFIG_TAB);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: CONFIG_TAB } } }] },
    });
  }
}

// Devuelve la config, o {} solo si la pestaña todavía no existe. Cualquier otro error de lectura SE PROPAGA: antes se
// devolvía {} y se seguía con los tokens de las variables de entorno, que ya están vencidos/consumidos.
async function readConfig(): Promise<Record<string, string>> {
  const sheets = getSheetsClient();
  try {
    const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${CONFIG_TAB}!A:B` });
    const config: Record<string, string> = {};
    for (const row of data.values ?? []) {
      if (row[0] && row[1]) config[row[0]] = row[1];
    }
    return config;
  } catch (err) {
    if (/Unable to parse range|not found/i.test(String((err as Error)?.message))) return {}; // pestaña inexistente
    throw err;
  }
}

function parDesdeConfig(config: Record<string, string>): Par {
  const fecha = Date.parse(config["ML_TOKEN_UPDATED"] ?? "");
  if (config["ML_ACCESS_TOKEN"]) {
    return { accessToken: config["ML_ACCESS_TOKEN"], refreshToken: config["ML_REFRESH_TOKEN"] ?? "", actualizadoMs: Number.isNaN(fecha) ? 0 : fecha };
  }
  // Config todavía sin tokens (primera vez): arrancar con los de las variables de entorno, tratados como vencidos.
  return { accessToken: process.env.ML_ACCESS_TOKEN ?? "", refreshToken: process.env.ML_REFRESH_TOKEN ?? "", actualizadoMs: 0 };
}

export async function saveTokens(accessToken: string, refreshToken: string) {
  await ensureConfigTab();
  const sheets = getSheetsClient();

  // Leer config actual para saber en qué filas están las claves
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${CONFIG_TAB}!A:B` });
  const rows = data.values ?? [];
  const keyRow: Record<string, number> = {};
  rows.forEach((r, i) => { if (r[0]) keyRow[r[0]] = i + 1; });

  const updates: { key: string; value: string }[] = [
    { key: "ML_ACCESS_TOKEN", value: accessToken },
    { key: "ML_REFRESH_TOKEN", value: refreshToken },
    { key: "ML_TOKEN_UPDATED", value: new Date().toISOString() },
  ];

  const batchData: { range: string; values: string[][] }[] = [];
  const appends: string[][] = [];

  for (const { key, value } of updates) {
    if (keyRow[key]) {
      batchData.push({ range: `${CONFIG_TAB}!B${keyRow[key]}`, values: [[value]] });
    } else {
      appends.push([key, value]);
    }
  }

  // Una sola llamada para actualizar claves existentes
  if (batchData.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { valueInputOption: "RAW", data: batchData },
    });
  }

  // Una sola llamada para agregar claves nuevas (si las hay)
  if (appends.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${CONFIG_TAB}!A:B`,
      valueInputOption: "RAW",
      requestBody: { values: appends },
    });
  }
}

// ── Renovación ──────────────────────────────────────────────────────────────────────────────────────────────────
function esInvalidGrant(err: unknown): boolean {
  const e = err as { response?: { status?: number; data?: { error?: string; message?: string } } };
  const d = e?.response?.data;
  return e?.response?.status === 400 && (d?.error === "invalid_grant" || /refresh token|already used|invalid_grant/i.test(d?.message ?? ""));
}

async function pedirRefresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
  const { data } = await axios.post(
    "https://api.mercadolibre.com/oauth/token",
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: process.env.ML_CLIENT_ID!,
      client_secret: process.env.ML_CLIENT_SECRET!,
      refresh_token: refreshToken,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 10000 }
  );
  if (!data?.access_token || !data?.refresh_token) throw new Error("Respuesta de renovación sin tokens");
  return { accessToken: data.access_token, refreshToken: data.refresh_token };
}

// El par más reciente que conoce esta instancia: el de Config, o el que quedó en memoria si su escritura falló.
async function parActual(): Promise<Par> {
  let par: Par | null = null;
  try {
    par = parDesdeConfig(await readConfig());
  } catch (err) {
    if (!parSinGuardar) {
      logError("ml-token leer Config", err);
      throw new Error("No se pudo leer la configuración de tokens desde Sheets. Intenta de nuevo en unos segundos.");
    }
  }
  if (parSinGuardar && (!par || parSinGuardar.actualizadoMs >= par.actualizadoMs)) return parSinGuardar;
  return par!;
}

// Guarda el par nuevo con reintentos. NUNCA lanza: si no se logra, el par queda en memoria de esta instancia (el refresh
// token anterior ya fue consumido en ML y este es el único que sirve) y se reintenta en las próximas llamadas.
async function guardarConReintentos(par: Par): Promise<void> {
  const esperas = [0, ..._configuracion.esperasEscrituraMs];
  let ultimoError: unknown;
  for (const espera of esperas) {
    await esperar(espera);
    try {
      // Si otra instancia ya guardó un par más nuevo, no pisarlo con uno anterior.
      const enConfig = parDesdeConfig(await readConfig());
      if (enConfig.actualizadoMs > par.actualizadoMs) { parSinGuardar = null; return; }
      await saveTokens(par.accessToken, par.refreshToken);
      parSinGuardar = null;
      return;
    } catch (err) {
      ultimoError = err;
    }
  }
  parSinGuardar = par;
  logError("ml-token guardar en Config", ultimoError);
  console.error(`[ml-token] ATENCIÓN: se renovó el token en Mercado Libre pero NO se pudo guardar en Config tras ${esperas.length} intentos. ` +
    "Se conserva en la memoria de esta instancia y se reintentará; si la instancia se recicla antes, habrá que re-autorizar en /api/auth/login.");
}

// Tras invalid_grant: otra instancia pudo renovar a la vez (el refresh token es de un solo uso, a ella le tocó primero).
// Se relee Config esperando a que su escritura termine; si aparece un par distinto, se usa ese.
async function buscarParDeOtraInstancia(base: Par): Promise<Par | null> {
  for (const espera of _configuracion.esperasReleerMs) {
    await esperar(espera);
    if (parSinGuardar && parSinGuardar.accessToken !== base.accessToken) return parSinGuardar;
    try {
      const par = parDesdeConfig(await readConfig());
      if (par.accessToken && par.accessToken !== base.accessToken) return par;
    } catch { /* se reintenta en la siguiente espera */ }
  }
  return null;
}

async function ejecutarRenovacion(base: Par): Promise<string> {
  if (falloReciente && Date.now() - falloReciente.ms < _configuracion.falloSticky) throw falloReciente.error;
  if (!base.refreshToken) throw (falloReciente = { ms: Date.now(), error: new ErrorReautorizar() }).error;

  let nuevo: { accessToken: string; refreshToken: string };
  try {
    nuevo = await pedirRefresh(base.refreshToken);
  } catch (err) {
    if (esInvalidGrant(err)) {
      const deOtra = await buscarParDeOtraInstancia(base);
      if (deOtra) return deOtra.accessToken;
      logError("ml-token renovar (invalid_grant)", err);
      throw (falloReciente = { ms: Date.now(), error: new ErrorReautorizar() }).error;
    }
    logError("ml-token renovar", err);
    const status = (err as { response?: { status?: number } })?.response?.status;
    throw new Error(`No se pudo renovar el token de Mercado Libre${status ? ` (HTTP ${status})` : ""}. Intenta de nuevo.`);
  }

  falloReciente = null;
  await guardarConReintentos({ ...nuevo, actualizadoMs: Date.now() });
  return nuevo.accessToken;
}

// Single-flight dentro de la instancia: mientras hay una renovación en curso, todas las demás llamadas esperan ESA.
function unSoloVuelo(fn: () => Promise<string>): Promise<string> {
  if (!refrescoEnCurso) {
    refrescoEnCurso = fn().finally(() => { refrescoEnCurso = null; });
  }
  return refrescoEnCurso;
}

// Token para usar ya. Sin llamadas a ML: decide por la fecha guardada y renueva solo si está por vencer.
const estaVigente = (par: Par) => !!par.accessToken && Date.now() - par.actualizadoMs < VIDA_TOKEN_MS - MARGEN_MS;

export async function getValidAccessToken(): Promise<string> {
  if (refrescoEnCurso) return refrescoEnCurso;
  const par = await parActual();
  if (estaVigente(par)) {
    // Si quedó un par renovado sin guardar, reintentar guardarlo en segundo plano (sin bloquear esta llamada).
    if (parSinGuardar && par === parSinGuardar) void unSoloVuelo(async () => { await guardarConReintentos(par); return par.accessToken; }).catch(() => {});
    return par.accessToken;
  }
  return unSoloVuelo(async () => {
    // Releer dentro del vuelo: otra llamada (o instancia) pudo renovar mientras esta esperaba, y no hay que gastar otro refresh token.
    const fresco = await parActual();
    return estaVigente(fresco) ? fresco.accessToken : ejecutarRenovacion(fresco);
  });
}

// Tras un 401: renueva salvo que ya haya otro token distinto del rechazado (otra llamada o instancia ya renovó).
export function renovarTrasRechazo(tokenRechazado: string): Promise<string> {
  return unSoloVuelo(async () => {
    const par = await parActual();
    if (par.accessToken && par.accessToken !== tokenRechazado) return par.accessToken;
    return ejecutarRenovacion(par);
  });
}

// Instala en un cliente axios el reintento ÚNICO ante 401: renueva (compartiendo la renovación con las demás llamadas
// simultáneas), actualiza el header Authorization del cliente y repite la llamada una sola vez.
type ConfigReintento = { _reintento401?: boolean; headers?: { get?: (n: string) => unknown; set?: (n: string, v: string) => unknown } };
export function instalarReintento401(client: AxiosInstance, tokenInicial: string): void {
  client.interceptors.response.use(undefined, async (error) => {
    const cfg = error?.config as ConfigReintento | undefined;
    if (error?.response?.status !== 401 || !cfg || cfg._reintento401) throw error;
    cfg._reintento401 = true;
    const enviado = String(cfg.headers?.get?.("Authorization") ?? `Bearer ${tokenInicial}`).replace(/^Bearer\s+/i, "");
    let nuevo: string;
    try {
      nuevo = await renovarTrasRechazo(enviado);
    } catch (errRenovar) {
      if (errRenovar instanceof ErrorReautorizar) error.message = errRenovar.message; // conserva response.status = 401
      throw error;
    }
    (client.defaults.headers as unknown as Record<string, unknown>)["Authorization"] = `Bearer ${nuevo}`;
    cfg.headers?.set?.("Authorization", `Bearer ${nuevo}`);
    return client.request(cfg as never);
  });
}

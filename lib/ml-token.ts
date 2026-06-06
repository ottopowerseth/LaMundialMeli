import axios from "axios";
import { google } from "googleapis";

const SHEET_ID = process.env.GOOGLE_SHEET_ID!;
const CONFIG_TAB = "Config";

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

async function readConfig(): Promise<Record<string, string>> {
  const sheets = getSheetsClient();
  try {
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${CONFIG_TAB}!A:B`,
    });
    const config: Record<string, string> = {};
    for (const row of data.values ?? []) {
      if (row[0] && row[1]) config[row[0]] = row[1];
    }
    return config;
  } catch {
    return {};
  }
}

export async function saveTokens(accessToken: string, refreshToken: string) {
  await ensureConfigTab();
  const sheets = getSheetsClient();

  // Leer config actual para saber en qué filas están las claves
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${CONFIG_TAB}!A:B`,
  });
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

export async function getValidAccessToken(): Promise<string> {
  // 1. Intentar leer desde Sheets
  const config = await readConfig();
  let accessToken = config["ML_ACCESS_TOKEN"] || process.env.ML_ACCESS_TOKEN!;
  const refreshToken = config["ML_REFRESH_TOKEN"] || process.env.ML_REFRESH_TOKEN!;

  // 2. Verificar si el token funciona
  try {
    await axios.get("https://api.mercadolibre.com/users/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return accessToken;
  } catch (err: unknown) {
    const error = err as { response?: { status?: number } };
    if (error.response?.status !== 401) throw err;
  }

  // 3. Token expirado — refrescar
  const { data } = await axios.post(
    "https://api.mercadolibre.com/oauth/token",
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: process.env.ML_CLIENT_ID!,
      client_secret: process.env.ML_CLIENT_SECRET!,
      refresh_token: refreshToken,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  accessToken = data.access_token;
  await saveTokens(accessToken, data.refresh_token);
  return accessToken;
}

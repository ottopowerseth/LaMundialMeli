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

async function writeConfig(key: string, value: string) {
  const sheets = getSheetsClient();
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${CONFIG_TAB}!A:A`,
  });
  const rows = data.values ?? [];
  const rowIndex = rows.findIndex((r) => r[0] === key);

  if (rowIndex >= 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${CONFIG_TAB}!B${rowIndex + 1}`,
      valueInputOption: "RAW",
      requestBody: { values: [[value]] },
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${CONFIG_TAB}!A:B`,
      valueInputOption: "RAW",
      requestBody: { values: [[key, value]] },
    });
  }
}

export async function saveTokens(accessToken: string, refreshToken: string) {
  await ensureConfigTab();
  await writeConfig("ML_ACCESS_TOKEN", accessToken);
  await writeConfig("ML_REFRESH_TOKEN", refreshToken);
  await writeConfig("ML_TOKEN_UPDATED", new Date().toISOString());
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

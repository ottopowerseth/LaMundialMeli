import { google } from "googleapis";
import { readFileSync } from "fs";

const envContent = readFileSync(".env.local", "utf-8");
for (const line of envContent.split("\n")) {
  const [key, ...rest] = line.split("=");
  if (key && rest.length) process.env[key.trim()] = rest.join("=").trim();
}

const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/^"|"$/g, ""),
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });
const spreadsheetId = process.env.GOOGLE_SHEET_ID;

// Crear pestaña Config si no existe
const { data } = await sheets.spreadsheets.get({ spreadsheetId });
const exists = data.sheets?.some(s => s.properties.title === "Config");
if (!exists) {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: "Config" } } }] },
  });
  console.log("Pestaña Config creada");
}

// Escribir tokens
await sheets.spreadsheets.values.update({
  spreadsheetId,
  range: "Config!A1:B4",
  valueInputOption: "RAW",
  requestBody: {
    values: [
      ["ML_ACCESS_TOKEN",  process.env.ML_ACCESS_TOKEN],
      ["ML_REFRESH_TOKEN", process.env.ML_REFRESH_TOKEN],
      ["ML_TOKEN_UPDATED", new Date().toISOString()],
    ],
  },
});

console.log("✓ Tokens guardados en Sheets Config");
console.log("  Access Token:", process.env.ML_ACCESS_TOKEN?.slice(0, 30) + "...");
console.log("  Refresh Token:", process.env.ML_REFRESH_TOKEN);

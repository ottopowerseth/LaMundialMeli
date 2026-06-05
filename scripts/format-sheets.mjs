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

const { data } = await sheets.spreadsheets.get({ spreadsheetId });
const pubSheet = data.sheets.find(s => s.properties.title === "Publicaciones");
const sheetId = pubSheet.properties.sheetId;

const ALERTA_COL = 17;  // R
const GANANCIA_COL = 14; // O
const MARGEN_COL = 15;  // P

function alertaRule(texto, red, green, blue, index) {
  return {
    addConditionalFormatRule: {
      index,
      rule: {
        ranges: [{ sheetId, startRowIndex: 1, startColumnIndex: ALERTA_COL, endColumnIndex: ALERTA_COL + 1 }],
        booleanRule: {
          condition: { type: "TEXT_EQ", values: [{ userEnteredValue: texto }] },
          format: {
            backgroundColor: { red, green, blue },
            textFormat: { bold: true },
          },
        },
      },
    },
  };
}

// Lote 1: colores de alerta + ganancia negativa + fila completa SIN STOCK
console.log("Aplicando colores de alerta...");
await sheets.spreadsheets.batchUpdate({
  spreadsheetId,
  requestBody: {
    requests: [
      alertaRule("SIN STOCK", 0.93, 0.26, 0.26, 0),
      alertaRule("REPONER",   0.98, 0.74, 0.02, 1),
      alertaRule("PAUSADA",   0.75, 0.75, 0.75, 2),
      alertaRule("CERRADA",   0.60, 0.60, 0.60, 3),
      alertaRule("OK",        0.20, 0.66, 0.33, 4),
      // Ganancia negativa → rojo
      {
        addConditionalFormatRule: {
          index: 5,
          rule: {
            ranges: [{ sheetId, startRowIndex: 1, startColumnIndex: GANANCIA_COL, endColumnIndex: GANANCIA_COL + 1 }],
            booleanRule: {
              condition: { type: "NUMBER_LESS", values: [{ userEnteredValue: "0" }] },
              format: { backgroundColor: { red: 0.93, green: 0.26, blue: 0.26 }, textFormat: { bold: true } },
            },
          },
        },
      },
      // Fila entera fondo rosado si SIN STOCK
      {
        addConditionalFormatRule: {
          index: 6,
          rule: {
            ranges: [{ sheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: 20 }],
            booleanRule: {
              condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: `=$R2="SIN STOCK"` }] },
              format: { backgroundColor: { red: 0.99, green: 0.90, blue: 0.90 } },
            },
          },
        },
      },
    ],
  },
});
console.log("✓ Colores de alerta aplicados");

// Lote 2: formato % en columnas Margen y Comisión
console.log("Aplicando formato porcentaje...");
await sheets.spreadsheets.batchUpdate({
  spreadsheetId,
  requestBody: {
    requests: [
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 1, startColumnIndex: MARGEN_COL, endColumnIndex: MARGEN_COL + 1 },
          cell: { userEnteredFormat: { numberFormat: { type: "PERCENT", pattern: "0.0%" } } },
          fields: "userEnteredFormat.numberFormat",
        },
      },
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 1, startColumnIndex: 11, endColumnIndex: 12 },
          cell: { userEnteredFormat: { numberFormat: { type: "PERCENT", pattern: "0.0%" } } },
          fields: "userEnteredFormat.numberFormat",
        },
      },
    ],
  },
});
console.log("✓ Formato porcentaje aplicado");

console.log("\n✓ Formato condicional aplicado");

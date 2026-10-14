// Chequeo de SOLO LECTURA de la hoja ShippingCache. No llama a ML y no escribe nada.
// Uso:  node scripts/chequeo-shipping-duplicados.mjs
// Cuenta los ID de orden (columna A) que aparecen más de una vez. Referencia 2026-10-14 (antes de S-08): 68 IDs repetidos.
// Correrlo tras el deploy y después del primer análisis de Rentabilidad: no deben aparecer IDs repetidos nuevos (el número no debe subir de 68).
// Excepción esperada: el reintento de envío con «forzarReintentos» (billing → costs) agrega una fila a propósito para esa orden.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { google } = require("googleapis");
const env = {};
for (const line of readFileSync(".env.local", "utf-8").split("\n")) { const [k, ...r] = line.split("="); if (k && r.length) env[k.trim()] = r.join("=").trim(); }
const auth = new google.auth.GoogleAuth({
  credentials: { client_email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL, private_key: env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/^"|"$/g, "") },
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"], // solo lectura
});
const { data } = await google.sheets({ version: "v4", auth }).spreadsheets.values.get({ spreadsheetId: env.GOOGLE_SHEET_ID, range: "ShippingCache!A2:A100000" });
const ids = (data.values ?? []).map((r) => String(r[0] ?? "").replace(/^'/, "").trim()).filter(Boolean);
const veces = new Map();
for (const id of ids) veces.set(id, (veces.get(id) ?? 0) + 1);
const repetidos = [...veces.entries()].filter(([, n]) => n > 1);
console.log("Filas con ID de orden:          ", ids.length);
console.log("IDs distintos:                  ", veces.size);
console.log("IDs repetidos:                  ", repetidos.length, "(referencia antes de S-08: 68)");
console.log("Filas de más por repetición:    ", repetidos.reduce((s, [, n]) => s + n - 1, 0));
console.log("Máximo de veces un mismo ID:    ", repetidos.reduce((m, [, n]) => Math.max(m, n), 1));

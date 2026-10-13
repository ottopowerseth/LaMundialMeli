// Chequeo de SOLO LECTURA de la hoja Ventas (la que escribe /api/ml-sync). No llama a ML y no escribe nada.
// Uso:  node scripts/chequeo-ventas.mjs
// Sirve para comparar antes y después del cambio C-01 (historial de Ventas por ventanas de un día):
//   antes (2026-10-13): 2.050 órdenes distintas, de 09-sep a 09-oct (31 días; se quedaba en el tope de 2.050).
//   después de un sync: más órdenes y fecha mínima ≈ hoy − 35 días.
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
const { data } = await google.sheets({ version: "v4", auth }).spreadsheets.values.get({ spreadsheetId: env.GOOGLE_SHEET_ID, range: "Ventas!A2:K100000" });
const filas = (data.values ?? []).filter((r) => r[0]);
const id = (r) => String(r[0]).replace(/^'/, "");
const distintas = new Set(filas.map(id));
const fecha = (r) => { const p = String(r[1] ?? "").split(/[-/]/); return p.length >= 3 ? new Date(Date.UTC(+p[2], +p[1] - 1, +p[0])) : null; };
const fechas = filas.map(fecha).filter(Boolean).sort((a, b) => a - b);
const iso = (d) => d.toISOString().slice(0, 10);
const porDia = {}; for (const r of filas) porDia[r[1]] = (porDia[r[1]] ?? 0) + 1;
const hoy = new Date(); const dias = fechas.length ? Math.round((fechas.at(-1) - fechas[0]) / 86400000) + 1 : 0;
console.log("Filas en la hoja Ventas:        ", filas.length);
console.log("Órdenes distintas:              ", distintas.size, distintas.size === filas.length ? "(sin repetidas)" : `(¡${filas.length - distintas.size} repetidas!)`);
console.log("Fecha mínima:                   ", fechas.length ? iso(fechas[0]) : "-");
console.log("Fecha máxima:                   ", fechas.length ? iso(fechas.at(-1)) : "-");
console.log("Días cubiertos (mín → máx):     ", dias, "(el sync pide 35)");
console.log("Días distintos con ventas:      ", Object.keys(porDia).length);
console.log("Máximo de órdenes en un día:    ", Math.max(0, ...Object.values(porDia)));
const estados = {}; for (const r of filas) estados[r[8] ?? "(vacío)"] = (estados[r[8] ?? "(vacío)"] ?? 0) + 1;
console.log("Órdenes por Estado (col I):     ", JSON.stringify(estados), " ← antes: paid 1931, cancelled 117, partially_refunded 2 (el sync trae TODOS los estados)");
console.log("Antigüedad de la fecha mínima:  ", fechas.length ? ((hoy - fechas[0]) / 86400000).toFixed(1) + " días respecto de hoy" : "-");
console.log(filas.length === 2050 ? "\n⚠ Sigue en exactamente 2.050 filas: el sync de Ventas no corrió con el cambio nuevo, o aún topa en 2.050." : "\n(Antes del cambio la hoja tenía 2.050 filas y llegaba hasta ~31 días atrás.)");

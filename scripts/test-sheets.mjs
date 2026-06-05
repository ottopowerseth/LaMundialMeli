import { google } from "googleapis";
import { readFileSync } from "fs";

// Cargar .env.local manualmente
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

try {
  const res = await sheets.spreadsheets.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
  });
  console.log("✓ Conexión exitosa");
  console.log("  Sheet:", res.data.properties.title);
  console.log("  Hojas:", res.data.sheets.map(s => s.properties.title).join(", "));
} catch (err) {
  console.error("✗ Error:", err.message);
}

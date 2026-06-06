import axios from "axios";
import { readFileSync } from "fs";

const envContent = readFileSync(".env.local", "utf-8");
for (const line of envContent.split("\n")) {
  const [key, ...rest] = line.split("=");
  if (key && rest.length) process.env[key.trim()] = rest.join("=").trim();
}

console.log("1. Probando access token actual...");
try {
  const { data } = await axios.get("https://api.mercadolibre.com/users/me", {
    headers: { Authorization: `Bearer ${process.env.ML_ACCESS_TOKEN}` },
  });
  console.log("✓ Access token válido:", data.nickname);
  process.exit(0);
} catch (err) {
  console.log("✗ Access token expirado:", err.response?.status);
}

console.log("\n2. Intentando refresh con refresh_token...");
try {
  const { data } = await axios.post(
    "https://api.mercadolibre.com/oauth/token",
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: process.env.ML_CLIENT_ID,
      client_secret: process.env.ML_CLIENT_SECRET,
      refresh_token: process.env.ML_REFRESH_TOKEN,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  console.log("✓ Nuevo access_token:", data.access_token);
  console.log("  Nuevo refresh_token:", data.refresh_token);
  console.log("  Expira en:", data.expires_in, "segundos");
  console.log("\n→ Copia estos valores y actualiza .env.local y Vercel");
} catch (err) {
  console.error("✗ Error en refresh:", err.response?.data ?? err.message);
}

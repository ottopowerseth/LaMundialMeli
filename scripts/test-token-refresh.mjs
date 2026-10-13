import axios from "axios";
import { readFileSync } from "fs";

const envContent = readFileSync(".env.local", "utf-8");
for (const line of envContent.split("\n")) {
  const [key, ...rest] = line.split("=");
  if (key && rest.length) process.env[key.trim()] = rest.join("=").trim();
}

// Nunca se imprime un token completo: solo los últimos 4 caracteres.
const ult4 = (t) => (t ? `…${String(t).slice(-4)}` : "(vacío)");

// Solo PRUEBA el access token. No refresca ni escribe nada: el refresh de ML es de un solo uso y esa lógica vive
// únicamente en la app (lib/ml-token.ts); un segundo refresh manual podría invalidar la cadena de tokens.
console.log("Probando access token actual (" + ult4(process.env.ML_ACCESS_TOKEN) + ")...");
try {
  const { data } = await axios.get("https://api.mercadolibre.com/users/me", {
    headers: { Authorization: `Bearer ${process.env.ML_ACCESS_TOKEN}` },
  });
  console.log("✓ Access token válido:", data.nickname);
} catch (err) {
  // Solo estado HTTP y mensaje: nunca el objeto de error completo (arrastra el header Authorization).
  const status = err.response?.status;
  if (status === 401) {
    console.log("✗ Access token vencido (401). Hay que re-autorizar la app en /api/auth/login.");
  } else {
    console.error("✗ No se pudo probar el token:", status ?? "", err.response?.data?.message ?? err.message);
  }
  process.exit(1);
}

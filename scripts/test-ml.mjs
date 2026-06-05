import axios from "axios";
import { readFileSync } from "fs";

const envContent = readFileSync(".env.local", "utf-8");
for (const line of envContent.split("\n")) {
  const [key, ...rest] = line.split("=");
  if (key && rest.length) process.env[key.trim()] = rest.join("=").trim();
}

const client = axios.create({
  baseURL: "https://api.mercadolibre.com",
  headers: { Authorization: `Bearer ${process.env.ML_ACCESS_TOKEN}` },
});

try {
  const { data: user } = await client.get("/users/me");
  console.log("✓ Conexión exitosa");
  console.log("  Usuario:", user.nickname);
  console.log("  ID:", user.id);
  console.log("  País:", user.country_id);

  const { data: listings } = await client.get(`/users/${user.id}/items/search?limit=5`);
  console.log("  Publicaciones totales:", listings.paging?.total ?? 0);
} catch (err) {
  console.error("✗ Error:", err.response?.data ?? err.message);
}

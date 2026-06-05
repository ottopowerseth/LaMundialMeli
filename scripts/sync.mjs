import axios from "axios";
import { google } from "googleapis";
import { readFileSync } from "fs";

// Cargar .env.local
const envContent = readFileSync(".env.local", "utf-8");
for (const line of envContent.split("\n")) {
  const [key, ...rest] = line.split("=");
  if (key && rest.length) process.env[key.trim()] = rest.join("=").trim();
}

const mlClient = axios.create({
  baseURL: "https://api.mercadolibre.com",
  headers: { Authorization: `Bearer ${process.env.ML_ACCESS_TOKEN}` },
});

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

async function ensureSheets(names) {
  const sheets = getSheetsClient();
  const { data } = await sheets.spreadsheets.get({ spreadsheetId: process.env.GOOGLE_SHEET_ID });
  const existing = new Set(data.sheets.map(s => s.properties.title));
  const toCreate = names.filter(n => !existing.has(n));
  if (toCreate.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      requestBody: {
        requests: toCreate.map(title => ({ addSheet: { properties: { title } } })),
      },
    });
    console.log("  Pestañas creadas:", toCreate.join(", "));
  }
}

async function writeSheet(range, values) {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });
}

// --- MAIN ---
console.log("Iniciando sync ML → Google Sheets...\n");

// 1. Crear pestañas
process.stdout.write("1. Creando pestañas... ");
await ensureSheets(["Publicaciones", "Ventas"]);
console.log("✓");

// 2. Obtener usuario
process.stdout.write("2. Obteniendo usuario ML... ");
const { data: user } = await mlClient.get("/users/me");
const userId = user.id;
console.log(`✓ (${user.nickname})`);

// 3. Obtener todos los IDs de publicaciones
process.stdout.write("3. Obteniendo IDs de publicaciones... ");
const allIds = [];
let offset = 0;
while (true) {
  const { data } = await mlClient.get(`/users/${userId}/items/search?limit=100&offset=${offset}`);
  allIds.push(...data.results);
  if (allIds.length >= data.paging.total || data.results.length === 0) break;
  offset += 100;
}
console.log(`✓ (${allIds.length} publicaciones)`);

// 4. Obtener detalles en batches de 20
process.stdout.write("4. Obteniendo detalles... ");
const items = [];
for (let i = 0; i < allIds.length; i += 20) {
  const chunk = allIds.slice(i, i + 20);
  const { data } = await mlClient.get(`/items?ids=${chunk.join(",")}`);
  items.push(...data.filter(r => r.code === 200).map(r => r.body));
  process.stdout.write(`\r4. Obteniendo detalles... ${items.length}/${allIds.length}`);
}
console.log(" ✓");

// 5. Escribir publicaciones en Sheets
process.stdout.write("5. Escribiendo publicaciones en Sheets... ");

function getComisionPct(listingType) {
  const rates = {
    gold_pro: 0.17,
    gold_special: 0.1375,
    gold_premium: 0.1375,
    gold: 0.12,
    silver: 0.08,
    bronze: 0.06,
    free: 0,
  };
  return rates[listingType] ?? 0.13;
}

function getDiasStock(item) {
  if (!item.sold_quantity || item.sold_quantity === 0) return "N/A";
  const inicio = new Date(item.start_time);
  const diasActivo = Math.max(1, (Date.now() - inicio.getTime()) / 86400000);
  const ventasDiarias = item.sold_quantity / diasActivo;
  return ventasDiarias > 0 ? Math.round(item.available_quantity / ventasDiarias) : "N/A";
}

function getAlerta(item) {
  if (item.status === "closed") return "CERRADA";
  if (item.status === "paused") return "PAUSADA";
  if (item.available_quantity === 0) return "SIN STOCK";
  if (item.available_quantity <= 3) return "REPONER";
  return "OK";
}

const headers = [
  "ID", "Título", "Categoría", "Precio de Venta", "Moneda",
  "Stock", "Vendidos", "Estado ML", "Condición", "Tipo Publicación",
  "Costo", "Comisión %", "Comisión $", "Envío",
  "Ganancia", "Margen %", "Días de Stock", "Alerta", "URL", "Actualizado"
];

const rows = items.map((item, i) => {
  const row = i + 2; // fila en sheet (1 = header)
  const comPct = getComisionPct(item.listing_type_id);
  return [
    String(item.id),
    item.title,
    item.category_id,
    item.price,
    item.currency_id,
    item.available_quantity,
    item.sold_quantity,
    item.status,
    item.condition,
    item.listing_type_id,
    "",                                         // Costo (manual)
    comPct,                                     // Comisión %
    `=D${row}*L${row}`,                        // Comisión $
    "",                                         // Envío (manual)
    `=D${row}-K${row}-M${row}-N${row}`,        // Ganancia
    `=IF(D${row}>0,O${row}/D${row},"")`,       // Margen %
    getDiasStock(item),
    getAlerta(item),
    item.permalink,
    new Date().toLocaleDateString("es-CL"),
  ];
});

await writeSheet("Publicaciones!A1", [headers, ...rows]);
console.log("✓");

// 6. Obtener órdenes
process.stdout.write("6. Obteniendo ventas... ");
const orders = [];
let ordOffset = 0;
while (ordOffset <= 500) {
  const { data } = await mlClient.get(`/orders/search?seller=${userId}&sort=date_desc&limit=50&offset=${ordOffset}`);
  orders.push(...data.results);
  if (orders.length >= data.paging.total || data.results.length === 0) break;
  ordOffset += 50;
}
console.log(`✓ (${orders.length} órdenes)`);

// 7. Escribir ventas en Sheets
process.stdout.write("7. Escribiendo ventas en Sheets... ");
const ordHeaders = ["ID Orden", "Fecha", "Producto", "SKU", "Cantidad", "Precio Unit.", "Total", "Comprador", "Estado"];
const ordRows = orders.map(order => {
  const item = order.order_items?.[0];
  return [
    String(order.id),
    new Date(order.date_created).toLocaleDateString("es-CL"),
    item?.item?.title ?? "",
    item?.item?.seller_sku ?? "",
    item?.quantity ?? "",
    item?.unit_price ?? "",
    order.total_amount,
    order.buyer?.nickname ?? "",
    order.status,
  ];
});
await writeSheet("Ventas!A1", [ordHeaders, ...ordRows]);
console.log("✓");

console.log(`\n✓ Sync completo: ${items.length} publicaciones, ${orders.length} ventas`);

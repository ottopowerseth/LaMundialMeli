import { NextResponse } from "next/server";
import axios from "axios";
import { ensureSheets, readSheet, writeSheet } from "@/lib/sheets";
import { getValidAccessToken } from "@/lib/ml-token";

function getComisionPct(listingType: string) {
  const rates: Record<string, number> = {
    gold_pro: 0.17, gold_special: 0.1375, gold_premium: 0.1375,
    gold: 0.12, silver: 0.08, bronze: 0.06, free: 0,
  };
  return rates[listingType] ?? 0.13;
}

function getDiasStock(item: Record<string, unknown>) {
  const soldQty = item.sold_quantity as number;
  const availQty = item.available_quantity as number;
  if (!soldQty) return "N/A";
  const inicio = new Date(item.start_time as string);
  const diasActivo = Math.max(1, (Date.now() - inicio.getTime()) / 86400000);
  const ventasDiarias = soldQty / diasActivo;
  return ventasDiarias > 0 ? Math.round(availQty / ventasDiarias) : "N/A";
}

function getAlerta(item: Record<string, unknown>) {
  if (item.status === "closed") return "CERRADA";
  if (item.status === "paused") return "PAUSADA";
  if ((item.available_quantity as number) === 0) return "SIN STOCK";
  if ((item.available_quantity as number) <= 3) return "REPONER";
  return "OK";
}

export async function POST() {
  try {
    await ensureSheets(["Publicaciones", "Ventas"]);

    const token = await getValidAccessToken();
    const mlClient = axios.create({
      baseURL: "https://api.mercadolibre.com",
      headers: { Authorization: `Bearer ${token}` },
    });

    const { data: user } = await mlClient.get("/users/me");
    const userId = user.id;

    // Publicaciones — paginado
    const allIds: string[] = [];
    let offset = 0;
    while (true) {
      const { data } = await mlClient.get(`/users/${userId}/items/search?limit=100&offset=${offset}`);
      allIds.push(...data.results);
      if (allIds.length >= data.paging.total || data.results.length === 0) break;
      offset += 100;
    }

    // Detalles en batches de 20
    const items: Record<string, unknown>[] = [];
    for (let i = 0; i < allIds.length; i += 20) {
      const chunk = allIds.slice(i, i + 20);
      const { data } = await mlClient.get(`/items?ids=${chunk.join(",")}`);
      items.push(
        ...data
          .filter((r: { code: number }) => r.code === 200)
          .map((r: { body: Record<string, unknown> }) => r.body)
      );
    }

    const headers = [
      "ID", "Título", "Categoría", "Precio de Venta", "Moneda",
      "Stock", "Vendidos", "Estado ML", "Condición", "Tipo Publicación",
      "Costo", "Comisión %", "Comisión $", "Envío",
      "Ganancia", "Margen %", "Días de Stock", "Alerta", "URL", "Actualizado",
    ];

    const rows = items.map((item, i) => {
      const row = i + 2;
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
        "",
        getComisionPct(item.listing_type_id as string),
        `=D${row}*L${row}`,
        "",
        `=D${row}-K${row}-M${row}-N${row}`,
        `=IF(D${row}>0,O${row}/D${row},"")`,
        getDiasStock(item),
        getAlerta(item),
        item.permalink,
        new Date().toLocaleDateString("es-CL"),
      ];
    });

    // Leer stock anterior antes de escribir
    const stockAnterior: Record<string, { titulo: string; stock: number; precio: number }> = {};
    try {
      const prevRows = await readSheet("Publicaciones!A2:F1000");
      for (const r of prevRows) {
        if (r[0]) stockAnterior[r[0]] = { titulo: r[1] ?? "", stock: Number(r[5]) || 0, precio: Number(r[3]) || 0 };
      }
    } catch { /* primera vez */ }

    await writeSheet("Publicaciones!A1", [headers, ...rows]);

    // Detectar cambios de stock
    const cambiosStock: { titulo: string; antes: number; despues: number; diferencia: number }[] = [];
    for (const item of items) {
      const id = String(item.id);
      const stockNuevo = item.available_quantity as number;
      const anterior = stockAnterior[id];
      if (anterior && anterior.stock !== stockNuevo) {
        cambiosStock.push({
          titulo: item.title as string,
          antes: anterior.stock,
          despues: stockNuevo,
          diferencia: stockNuevo - anterior.stock,
        });
      }
    }

    // Ventas — paginado
    const orders: Record<string, unknown>[] = [];
    let ordOffset = 0;
    while (ordOffset <= 500) {
      const { data } = await mlClient.get(
        `/orders/search?seller=${userId}&sort=date_desc&limit=50&offset=${ordOffset}`
      );
      orders.push(...data.results);
      if (orders.length >= data.paging.total || data.results.length === 0) break;
      ordOffset += 50;
    }

    const ordHeaders = ["ID Orden", "Fecha", "Producto", "SKU", "Cantidad", "Precio Unit.", "Total", "Comprador", "Estado"];
    const ordRows = orders.map((order) => {
      const item = (order.order_items as Record<string, unknown>[])?.[0];
      return [
        String(order.id),
        new Date(order.date_created as string).toLocaleDateString("es-CL"),
        (item?.item as Record<string, unknown>)?.title ?? "",
        (item?.item as Record<string, unknown>)?.seller_sku ?? "",
        item?.quantity ?? "",
        item?.unit_price ?? "",
        order.total_amount,
        (order.buyer as Record<string, unknown>)?.nickname ?? "",
        order.status,
      ];
    });

    await writeSheet("Ventas!A1", [ordHeaders, ...ordRows]);

    // Ventas nuevas (últimas 24h)
    const hace24h = new Date(Date.now() - 86400000);
    const ventasNuevas = orders
      .filter(o => new Date(o.date_created as string) > hace24h)
      .map(o => {
        const it = (o.order_items as Record<string, unknown>[])?.[0];
        return {
          titulo: (it?.item as Record<string, unknown>)?.title ?? "",
          cantidad: it?.quantity ?? 0,
          total: o.total_amount,
          comprador: (o.buyer as Record<string, unknown>)?.nickname ?? "",
          fecha: new Date(o.date_created as string).toLocaleDateString("es-CL"),
        };
      });

    return NextResponse.json({
      ok: true,
      publicaciones: items.length,
      ventas: orders.length,
      cambiosStock,
      ventasNuevas,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[ml-sync]", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

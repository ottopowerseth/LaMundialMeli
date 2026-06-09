import { NextResponse } from "next/server";
import axios from "axios";
import { ensureSheets, clearSheet, readSheet, writeSheet } from "@/lib/sheets";
import { getValidAccessToken } from "@/lib/ml-token";

function getComisionPct(listingType: string, catalogListing: boolean) {
  // Fuente: API MercadoLibre /sites/MLC/listing_types (junio 2026)
  // Catálogo reduce Premium de 17% → 15%
  if (listingType === "gold_pro") return catalogListing ? 0.15 : 0.17;
  if (listingType === "gold_special") return 0.14;
  if (listingType === "free") return 0;
  if (["gold_premium", "gold", "silver", "bronze"].includes(listingType)) return 0;
  return 0.14;
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
  if (item.status === "under_review") return "EN REVISIÓN";
  if (item.status === "not_yet_active") return "ACTIVANDO";
  if (item.status === "inactive") return "INACTIVA";
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

    // Publicaciones — buscar en todos los estados para incluir productos nuevos
    // "active" y "paused" son los que trae el endpoint sin filtro, pero
    // productos recién creados pueden estar en "under_review" o "not_yet_active"
    const allIds: string[] = [];
    const idSet = new Set<string>();
    const statusesToFetch = ["active", "paused", "under_review", "not_yet_active", "inactive"];
    for (const status of statusesToFetch) {
      let offset = 0;
      while (true) {
        const { data } = await mlClient.get(
          `/users/${userId}/items/search?status=${status}&limit=100&offset=${offset}`
        );
        for (const id of data.results as string[]) {
          if (!idSet.has(id)) { idSet.add(id); allIds.push(id); }
        }
        if (data.results.length === 0 || offset + data.results.length >= data.paging.total) break;
        offset += 100;
      }
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

    // Columnas en el orden actual de la planilla:
    // A:ID  B:Categoría  C:Título  D:Stock  E:Vendidos  F:Costo  G:Precio de Venta
    // H:Comisión$  I:Envío  J:Comisión%  K:Estado ML  L:Tipo Publicación
    // M:Ganancia  N:Margen%  O:Días de Stock  P:Alerta  Q:URL  R:Actualizado
    const headers = [
      "ID", "Categoría", "Título", "Stock", "Vendidos",
      "Costo", "Precio de Venta", "Comisión $", "Envío", "Comisión %",
      "Estado ML", "Tipo Publicación",
      "Ganancia", "Margen %", "Días de Stock", "Alerta", "URL", "Actualizado",
    ];

    // Leer hoja anterior ANTES de limpiar para preservar datos manuales y detectar cambios de stock
    // A=0,B=1,C=2,D=3,E=4,F=5(Costo),G=6(Precio),H=7,I=8(Envío)
    const stockAnterior: Record<string, { titulo: string; stock: number; precio: number }> = {};
    const datosManual: Record<string, { costo: string; envio: string }> = {};
    try {
      const prevRows = await readSheet("Publicaciones!A2:I1000");
      for (const r of prevRows) {
        if (!r[0]) continue;
        stockAnterior[r[0]] = { titulo: r[2] ?? "", stock: Number(r[3]) || 0, precio: Number(r[6]) || 0 };
        datosManual[r[0]] = { costo: r[5] ?? "", envio: r[8] ?? "" };
      }
    } catch { /* primera vez */ }

    const rows = items.map((item, i) => {
      const row = i + 2;
      const manual = datosManual[String(item.id)] ?? { costo: "", envio: "" };
      return [
        String(item.id),                                      // A: ID
        item.category_id,                                     // B: Categoría
        item.title,                                           // C: Título
        item.available_quantity,                              // D: Stock
        item.sold_quantity,                                   // E: Vendidos
        manual.costo,                                         // F: Costo (se preserva entre syncs)
        item.price,                                           // G: Precio de Venta
        `=G${row}*J${row}`,                                   // H: Comisión $ = Precio × Comisión%
        manual.envio,                                         // I: Envío (se preserva entre syncs)
        getComisionPct(item.listing_type_id as string, !!(item.catalog_listing)), // J: Comisión %
        item.status,                                          // K: Estado ML
        item.listing_type_id,                                 // L: Tipo Publicación
        `=G${row}-F${row}-H${row}-I${row}`,                   // M: Ganancia = Precio - Costo - Com$ - Envío
        `=IF(G${row}>0;M${row}/G${row};"")`,                   // N: Margen % — usa ; por locale es_CL
        getDiasStock(item),                                   // O: Días de Stock
        getAlerta(item),                                      // P: Alerta
        item.permalink,                                       // Q: URL
        new Date().toLocaleDateString("es-CL"),               // R: Actualizado
      ];
    });

    // Limpiar hoja antes de escribir para que no queden filas viejas
    await clearSheet("Publicaciones");
    await writeSheet("Publicaciones!A1", [headers, ...rows]);

    // Detectar productos nuevos (IDs que no estaban en la hoja anterior)
    const productosNuevos = items
      .filter((item) => !datosManual[String(item.id)])
      .map((item) => ({
        id: String(item.id),
        titulo: item.title as string,
        precio: item.price as number,
        estado: item.status as string,
      }));

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

    await clearSheet("Ventas");
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
      productosNuevos,
      cambiosStock,
      ventasNuevas,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[ml-sync]", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

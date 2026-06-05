import { NextResponse } from "next/server";
import { getMyListings, getItemDetails, getMyOrders } from "@/lib/mercadolibre";
import { writeSheet } from "@/lib/sheets";

export async function POST() {
  try {
    const [listingsData, ordersData] = await Promise.all([
      getMyListings(),
      getMyOrders(),
    ]);

    // Sync publicaciones
    const itemIds: string[] = listingsData.results ?? [];
    const items = await Promise.all(itemIds.map(getItemDetails));

    const listingRows = items.map((item) => [
      item.id,
      item.title,
      item.price,
      item.available_quantity,
      item.status,
      item.permalink,
      new Date().toISOString(),
    ]);

    await writeSheet("Publicaciones!A2", [
      ["ID", "Título", "Precio", "Stock", "Estado", "URL", "Actualizado"],
      ...listingRows,
    ]);

    // Sync órdenes
    const orderRows = (ordersData.results ?? []).map((order: Record<string, unknown>) => {
      const item = (order.order_items as Record<string, unknown>[])?.[0];
      return [
        order.id,
        order.date_created,
        (item?.item as Record<string, unknown>)?.title ?? "",
        item?.quantity ?? "",
        item?.unit_price ?? "",
        order.total_amount,
        (order.buyer as Record<string, unknown>)?.nickname ?? "",
        order.status,
      ];
    });

    await writeSheet("Ventas!A2", [
      ["ID Orden", "Fecha", "Producto", "Cantidad", "Precio Unit.", "Total", "Comprador", "Estado"],
      ...orderRows,
    ]);

    return NextResponse.json({
      ok: true,
      listings: listingRows.length,
      orders: orderRows.length,
    });
  } catch (error) {
    console.error("[ml-sync]", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

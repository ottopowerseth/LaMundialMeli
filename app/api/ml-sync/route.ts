import { NextResponse } from "next/server";
import axios from "axios";
import { ensureSheets, clearSheet, readSheet, writeSheet } from "@/lib/sheets";
import { getValidAccessToken } from "@/lib/ml-token";
import { createSyncBudget, withMlRetry } from "@/lib/http-retry";

// Máximo permitido en el plan de Vercel (Hobby): 60s.
export const maxDuration = 60;

function getComisionPct(listingType: string, catalogListing: boolean) {
  // Fuente: API MercadoLibre /sites/MLC/listing_types (junio 2026)
  // Catálogo reduce Premium de 17% → 15%
  if (listingType === "gold_pro") return catalogListing ? 0.15 : 0.17;
  if (listingType === "gold_special") return 0.14;
  if (listingType === "free") return 0;
  if (["gold_premium", "gold", "silver", "bronze"].includes(listingType)) return 0;
  return 0.14;
}

// Stock: usa available_quantity de raíz si es válido; si no, suma las
// variaciones (algunos items llevan el stock ahí en vez de en la raíz).
// Devuelve null si ninguna fuente tiene un valor numérico utilizable.
function resolveStock(item: Record<string, unknown>): number | null {
  const raiz = item.available_quantity;
  if (typeof raiz === "number" && !Number.isNaN(raiz)) return raiz;

  const variations = item.variations as Record<string, unknown>[] | undefined;
  if (Array.isArray(variations) && variations.length > 0) {
    let suma = 0;
    let algunaValida = false;
    for (const v of variations) {
      const q = v.available_quantity;
      if (typeof q === "number" && !Number.isNaN(q)) {
        suma += q;
        algunaValida = true;
      }
    }
    if (algunaValida) return suma;
  }

  return null;
}

function resolveNumeric(value: unknown): number | null {
  return typeof value === "number" && !Number.isNaN(value) ? value : null;
}

function getDiasStock(item: Record<string, unknown>, stock: number | null) {
  const soldQty = resolveNumeric(item.sold_quantity);
  if (!soldQty || stock === null) return "N/A";
  const inicio = new Date(item.start_time as string);
  if (Number.isNaN(inicio.getTime())) return "N/A";
  const diasActivo = Math.max(1, (Date.now() - inicio.getTime()) / 86400000);
  const ventasDiarias = soldQty / diasActivo;
  return ventasDiarias > 0 ? Math.round(stock / ventasDiarias) : "N/A";
}

function getAlerta(item: Record<string, unknown>, stock: number | null) {
  if (item.status === "closed") return "CERRADA";
  if (item.status === "paused") return "PAUSADA";
  if (item.status === "under_review") return "EN REVISIÓN";
  if (item.status === "not_yet_active") return "ACTIVANDO";
  if (item.status === "inactive") return "INACTIVA";
  if (stock === null) return "DATO INCOMPLETO";
  if (stock === 0) return "SIN STOCK";
  if (stock <= 3) return "REPONER";
  return "OK";
}

export async function POST() {
  const erroresValidacion: string[] = [];
  const erroresSync: string[] = [];

  try {
    await ensureSheets(["Publicaciones", "Ventas"]);

    const token = await getValidAccessToken();
    const mlClient = axios.create({
      baseURL: "https://api.mercadolibre.com",
      headers: { Authorization: `Bearer ${token}` },
      timeout: 8000,
    });
    const budget = createSyncBudget();
    const mlGet = <T = unknown>(url: string) =>
      withMlRetry(() => mlClient.get<T>(url), { budget });

    const { data: user } = await mlGet<{ id: string }>("/users/me");
    const userId = user.id;

    let items: Record<string, unknown>[] = [];
    let publicacionesOk = false;
    let productosNuevos: { id: string; titulo: string; precio: number; estado: string }[] = [];
    let cambiosStock: { titulo: string; antes: number; despues: number; diferencia: number }[] = [];

    try {
      // Publicaciones — buscar en todos los estados para incluir productos nuevos
      // "active" y "paused" son los que trae el endpoint sin filtro, pero
      // productos recién creados pueden estar en "under_review" o "not_yet_active"
      const allIds: string[] = [];
      const idSet = new Set<string>();
      const statusesToFetch = ["active", "paused", "under_review", "not_yet_active", "inactive"];
      for (const status of statusesToFetch) {
        let offset = 0;
        while (true) {
          const { data } = await mlGet<{ results: string[]; paging: { total: number } }>(
            `/users/${userId}/items/search?status=${status}&limit=100&offset=${offset}`
          );
          for (const id of data.results) {
            if (!idSet.has(id)) { idSet.add(id); allIds.push(id); }
          }
          if (data.results.length === 0 || offset + data.results.length >= data.paging.total) break;
          offset += 100;
        }
      }

      // Detalles en batches de 20
      for (let i = 0; i < allIds.length; i += 20) {
        const chunk = allIds.slice(i, i + 20);
        const { data } = await mlGet<{ code: number; body: Record<string, unknown> }[]>(
          `/items?ids=${chunk.join(",")}`
        );
        items.push(
          ...data
            .filter((r) => r.code === 200)
            .map((r) => r.body)
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
        const stock = resolveStock(item);
        const precio = resolveNumeric(item.price);

        if (stock === null) {
          erroresValidacion.push(`${item.id} (${item.title ?? "sin título"}): stock ausente o inválido`);
        }
        if (precio === null) {
          erroresValidacion.push(`${item.id} (${item.title ?? "sin título"}): precio ausente o inválido`);
        }

        return [
          String(item.id),                                      // A: ID
          item.category_id,                                     // B: Categoría
          item.title,                                           // C: Título
          stock ?? "",                                          // D: Stock
          resolveNumeric(item.sold_quantity) ?? 0,              // E: Vendidos
          manual.costo,                                         // F: Costo (se preserva entre syncs)
          precio ?? "",                                         // G: Precio de Venta
          `=G${row}*J${row}`,                                   // H: Comisión $ = Precio × Comisión%
          manual.envio,                                         // I: Envío (se preserva entre syncs)
          getComisionPct(item.listing_type_id as string, !!(item.catalog_listing)), // J: Comisión %
          item.status,                                          // K: Estado ML
          item.listing_type_id,                                 // L: Tipo Publicación
          `=G${row}-F${row}-H${row}-I${row}`,                   // M: Ganancia = Precio - Costo - Com$ - Envío
          `=IF(G${row}>0;M${row}/G${row};"")`,                   // N: Margen % — usa ; por locale es_CL
          getDiasStock(item, stock),                            // O: Días de Stock
          getAlerta(item, stock),                                // P: Alerta
          item.permalink,                                       // Q: URL
          new Date().toLocaleDateString("es-CL"),               // R: Actualizado
        ];
      });

      // Limpiar hoja antes de escribir para que no queden filas viejas
      await clearSheet("Publicaciones");
      await writeSheet("Publicaciones!A1", [headers, ...rows]);
      publicacionesOk = true;

      // Detectar productos nuevos (IDs que no estaban en la hoja anterior)
      productosNuevos = items
        .filter((item) => !datosManual[String(item.id)])
        .map((item) => ({
          id: String(item.id),
          titulo: item.title as string,
          precio: item.price as number,
          estado: item.status as string,
        }));

      // Detectar cambios de stock
      for (const item of items) {
        const id = String(item.id);
        const stockNuevo = resolveStock(item);
        const anterior = stockAnterior[id];
        if (anterior && stockNuevo !== null && anterior.stock !== stockNuevo) {
          cambiosStock.push({
            titulo: item.title as string,
            antes: anterior.stock,
            despues: stockNuevo,
            diferencia: stockNuevo - anterior.stock,
          });
        }
      }
    } catch (err) {
      console.error("[ml-sync] Publicaciones", err);
      erroresSync.push(`Publicaciones: ${String(err)}`);
    }

    let orders: Record<string, unknown>[] = [];
    let ventasOk = false;
    let ventasNuevas: { titulo: unknown; cantidad: unknown; total: unknown; comprador: unknown; fecha: string }[] = [];

    try {
      // Ventas — paginado
      let ordOffset = 0;
      while (ordOffset <= 500) {
        const { data } = await mlGet<{ results: Record<string, unknown>[]; paging: { total: number } }>(
          `/orders/search?seller=${userId}&sort=date_desc&limit=50&offset=${ordOffset}`
        );
        orders.push(...data.results);
        if (orders.length >= data.paging.total || data.results.length === 0) break;
        ordOffset += 50;
      }

      // Columna J (ID Item) se agrega al final, no en medio, para no correr
      // los índices que ya leen esta hoja por posición (page.tsx, forecast/route.ts).
      const ordHeaders = ["ID Orden", "Fecha", "Producto", "SKU", "Cantidad", "Precio Unit.", "Total", "Comprador", "Estado", "ID Item"];
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
          (item?.item as Record<string, unknown>)?.id ?? "",
        ];
      });

      await clearSheet("Ventas");
      await writeSheet("Ventas!A1", [ordHeaders, ...ordRows]);
      ventasOk = true;

      // Ventas nuevas (últimas 24h para el contador, pero devolvemos 7 días para no perder ventas)
      const hace7d = new Date(Date.now() - 7 * 86400000);
      ventasNuevas = orders
        .filter(o => new Date(o.date_created as string) > hace7d)
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
    } catch (err) {
      console.error("[ml-sync] Ventas", err);
      erroresSync.push(`Ventas: ${String(err)}`);
    }

    return NextResponse.json({
      ok: publicacionesOk || ventasOk,
      publicaciones: publicacionesOk ? items.length : null,
      ventas: ventasOk ? orders.length : null,
      productosNuevos,
      cambiosStock,
      ventasNuevas,
      erroresValidacion,
      erroresSync,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[ml-sync]", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

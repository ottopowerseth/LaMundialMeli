import { NextResponse } from "next/server";
import axios from "axios";
import { readSheet, batchWriteSheet } from "@/lib/sheets";
import { getValidAccessToken } from "@/lib/ml-token";
import { createSyncBudget, withMlRetry, SyncRetryBudgetExceededError } from "@/lib/http-retry";
import { detectarMixto, mediana, deserializarItemsDespacho } from "@/lib/envio-real";

// Pasada FINAL de marcas (columna Q, Mixto) — se corre una sola vez,
// después de que el modo "completar" dejó TODO el histórico en fuente
// "costs". No recalcula envío ni margen — solo asigna Q, en 3 fases
// (mismo criterio que el fix de rentabilidad/recalcular-envio: resolver
// todo, armar tarifasConocidas con TODO, recién ahí marcar) para que
// ninguna fila dependa del orden de recorrido.
//
// Reconstrucción de despachos compartidos (decisión de Otto 2026-10-02):
// NO se infiere solo agrupando Rentabilidad por shippingId, porque las
// órdenes hermanas de un despacho pueden estar canceladas o fuera del
// rango ya guardado en la hoja — agrupar solo lo que está en Rentabilidad
// subestimaría itemsDelDespacho para esos casos. En vez de eso: se usa la
// composición ya persistida en ShippingCache columna I (Items Despacho,
// JSON) cuando existe; si falta (filas viejas, de antes de que
// recalcular-envio empezara a escribirla), se resuelve vía
// /shipments/{id} con caché por shippingId — los despachos de una sola
// orden y un solo ítem (unidadesDespacho === unidadesEstaOrden, sin
// composición guardada) NO necesitan esa llamada: su único ítem ya se
// conoce por la propia fila de Rentabilidad.
export const maxDuration = 60;
const TIEMPO_MAXIMO_MS = 45000;

type FilaCache = {
  shippingId: string; logisticType: string;
  costoTotalDespacho: number | null; unidadesDespacho: number | null;
  unidadesEstaOrden: number | null; fuente: "costs" | "billing" | null;
  itemsDespachoJson: string;
};

export async function POST(request: Request) {
  try {
    const inicio = Date.now();
    const token = await getValidAccessToken();
    const client = axios.create({
      baseURL: "https://api.mercadolibre.com",
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    });
    const budget = createSyncBudget();
    const mlGet = <T = unknown>(url: string) =>
      withMlRetry(() => client.get<T>(url, { headers: { "Api-Version": "1", "Content-Type": "application/json" } }), { budget });

    const filasRent = await readSheet("Rentabilidad!A2:Q100000");
    const cacheRows = await readSheet("ShippingCache!A2:I100000");
    const cachePorOrden = new Map<string, FilaCache>();
    // filaShippingCachePorOrden: número de fila REAL en la hoja
    // ShippingCache (1-indexado con header) para cada ordenId — necesario
    // para poder escribir la columna I de esa fila existente cuando se
    // resuelve itemsDelDespacho vía /shipments/{id} (ver más abajo).
    const filaShippingCachePorOrden = new Map<string, number>();
    for (let i = 0; i < cacheRows.length; i++) {
      const r = cacheRows[i];
      if (!r[0]) continue;
      const ordenId = String(r[0]).replace(/^'/, "");
      const fuente: "costs" | "billing" | null = r[7] === "costs" || r[7] === "billing" ? r[7] : null;
      const existente = cachePorOrden.get(ordenId);
      if (existente?.fuente && !fuente) continue;
      cachePorOrden.set(ordenId, {
        shippingId: r[1] ?? "",
        logisticType: r[2] ?? "",
        costoTotalDespacho: r[4] !== undefined && r[4] !== "" ? Number(r[4]) : null,
        unidadesDespacho: r[5] !== undefined && r[5] !== "" ? Number(r[5]) : null,
        unidadesEstaOrden: r[6] !== undefined && r[6] !== "" ? Number(r[6]) : null,
        fuente,
        itemsDespachoJson: r[8] ?? "",
      });
      filaShippingCachePorOrden.set(ordenId, i + 2);
    }

    // Solo filas ya resueltas con fuente "costs" entran a esta pasada —
    // billing_sin_costs no tiene costoTotalDespacho real, no se puede
    // evaluar mixto para esas.
    const candidatas = filasRent
      .map((r, i) => ({ r, idx: i }))
      .filter(({ r }) => (r[15] ?? "") === "costs");

    // ===== FASE 1: resolver itemsDelDespacho para cada fila candidata =====
    const shipmentCache = new Map<string, Map<string, number> | null>();
    // shippingIdsResueltosAhora: composición recién resuelta vía
    // /shipments/{id} en ESTA corrida — se persiste en ShippingCache
    // columna I al final (una sola vez por shippingId, no por fila de
    // Rentabilidad), para que una segunda corrida de marcar-mixto no
    // repita estas llamadas.
    const shippingIdsResueltosAhora = new Map<string, Map<string, number>>();
    let llamadasHechas = 0;
    let cortadoPorTiempo = false;
    const resueltas: { idx: number; itemId: string; costoTotalDespacho: number; logisticType: string; itemsDelDespacho: Map<string, number> }[] = [];
    const sinItemsDelDespacho: number[] = [];

    for (const { r, idx } of candidatas) {
      if (Date.now() - inicio > TIEMPO_MAXIMO_MS) { cortadoPorTiempo = true; break; }

      const ordenId = String(r[0]).replace(/^'/, "");
      const itemId = r[2];
      const cache = cachePorOrden.get(ordenId);
      if (!cache || cache.costoTotalDespacho === null) { sinItemsDelDespacho.push(idx); continue; }

      let itemsDelDespacho: Map<string, number> | null = null;

      // Despacho de 1 sola orden/1 solo ítem: no hace falta composición
      // persistida ni llamada — el único ítem es el de esta misma fila.
      if (cache.unidadesDespacho === cache.unidadesEstaOrden && !cache.itemsDespachoJson) {
        itemsDelDespacho = new Map([[itemId, cache.unidadesDespacho ?? 1]]);
      } else if (cache.itemsDespachoJson) {
        itemsDelDespacho = deserializarItemsDespacho(cache.itemsDespachoJson);
      } else if (cache.shippingId) {
        // Despacho compartido sin composición guardada (fila vieja, de
        // antes del fix) — resolver vía /shipments/{id}, con caché por
        // shippingId para no repetir la llamada entre hermanas.
        if (shipmentCache.has(cache.shippingId)) {
          itemsDelDespacho = shipmentCache.get(cache.shippingId)!;
        } else {
          try {
            const { data: shipment } = await mlGet<{ shipping_items?: { id?: string; quantity?: number }[] }>(`/shipments/${cache.shippingId}`);
            llamadasHechas++;
            const items = new Map<string, number>();
            for (const it of shipment.shipping_items ?? []) {
              if (it.id) items.set(it.id, (items.get(it.id) ?? 0) + (it.quantity ?? 0));
            }
            itemsDelDespacho = items.size > 0 ? items : null;
            shipmentCache.set(cache.shippingId, itemsDelDespacho);
            if (itemsDelDespacho) shippingIdsResueltosAhora.set(cache.shippingId, itemsDelDespacho);
          } catch {
            shipmentCache.set(cache.shippingId, null);
          }
        }
      }

      if (!itemsDelDespacho) { sinItemsDelDespacho.push(idx); continue; }
      resueltas.push({ idx, itemId, costoTotalDespacho: cache.costoTotalDespacho, logisticType: cache.logisticType, itemsDelDespacho });
    }

    // ===== FASE 2: tarifasConocidas con TODO lo resuelto =====
    const muestrasPorItem = new Map<string, number[]>();
    for (const res of resueltas) {
      if (res.itemsDelDespacho.size === 1) {
        const unidades = [...res.itemsDelDespacho.values()][0];
        muestrasPorItem.get(res.itemId)?.push(res.costoTotalDespacho / unidades) ??
          muestrasPorItem.set(res.itemId, [res.costoTotalDespacho / unidades]);
      }
    }
    const tarifasConocidas = new Map<string, number>();
    for (const [itemId, muestras] of muestrasPorItem) {
      tarifasConocidas.set(itemId, mediana(muestras));
    }

    // ===== FASE 3: asignar Q a todas las filas resueltas =====
    const conteoMixto = new Map<string, Map<string, number>>();
    const updates: { range: string; values: unknown[][] }[] = [];
    for (const res of resueltas) {
      const mixto = detectarMixto(res.costoTotalDespacho, res.itemsDelDespacho, tarifasConocidas, res.logisticType);
      if (mixto) {
        if (!conteoMixto.has(mixto)) conteoMixto.set(mixto, new Map());
        const porItem = conteoMixto.get(mixto)!;
        porItem.set(res.itemId, (porItem.get(res.itemId) ?? 0) + 1);
      }
      updates.push({ range: `Rentabilidad!Q${res.idx + 2}:Q${res.idx + 2}`, values: [[mixto ?? ""]] });
    }

    // Persistir en ShippingCache columna I la composición recién resuelta
    // vía /shipments/{id} — una escritura por ORDEN (fila real existente
    // de ShippingCache), no por shippingId, porque varias órdenes
    // hermanas comparten el mismo shippingId pero cada una tiene su
    // propia fila en ShippingCache.
    let filasShippingCacheActualizadas = 0;
    for (const [shippingId, items] of shippingIdsResueltosAhora) {
      const json = JSON.stringify(Object.fromEntries(items));
      for (const [ordenId, cache] of cachePorOrden) {
        if (cache.shippingId !== shippingId) continue;
        const filaReal = filaShippingCachePorOrden.get(ordenId);
        if (!filaReal) continue;
        updates.push({ range: `ShippingCache!I${filaReal}:I${filaReal}`, values: [[json]] });
        filasShippingCacheActualizadas++;
      }
    }

    await batchWriteSheet(updates);

    const mixtoResumen: Record<string, Record<string, number>> = {};
    for (const [tipo, porItem] of conteoMixto) {
      mixtoResumen[tipo] = Object.fromEntries(porItem);
    }

    return NextResponse.json({
      ok: true,
      completo: !cortadoPorTiempo,
      candidatas: candidatas.length,
      marcadas: resueltas.length,
      sinItemsDelDespacho: sinItemsDelDespacho.length,
      filasShippingCacheActualizadas,
      llamadasHechas,
      mixto: mixtoResumen,
    });
  } catch (error) {
    if (error instanceof SyncRetryBudgetExceededError) {
      return NextResponse.json({ ok: false, error: "Budget agotado, reintentar" }, { status: 503 });
    }
    console.error("[rentabilidad/marcar-mixto]", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

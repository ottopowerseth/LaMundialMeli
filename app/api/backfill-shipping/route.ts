import { NextResponse } from "next/server";
import axios from "axios";
import { ensureSheets, readSheet, appendSheet } from "@/lib/sheets";
import { getValidAccessToken } from "@/lib/ml-token";
import { createSyncBudget, withMlRetry, SyncRetryBudgetExceededError } from "@/lib/http-retry";

// Backfill del histórico de ShippingCache: completa logistic_type de órdenes
// que ml-sync no llegó a cubrir (tope de 150 nuevas/sync). Idempotente — cada
// invocación relee ShippingCache y salta lo ya resuelto, así que se puede
// llamar repetidas veces sin duplicar ni reprocesar. Sin cursor de estado
// entre llamadas: el propio ShippingCache es el cursor real de progreso.

// Máximo permitido en el plan de Vercel (Hobby): 60s.
export const maxDuration = 60;

const SHIPMENT_BATCH_SIZE = 8;

// Corte proactivo por tiempo, independiente de createSyncBudget: ese budget
// solo chequea tiempo dentro de recordExhausted(), que solo se dispara si una
// llamada falla y agota reintentos. En un escenario "todo exitoso" ese chequeo
// nunca corre, así que sin este corte el loop podría acercarse al límite duro
// de maxDuration=60 y que Vercel mate la función antes de poder responder.
const TIEMPO_MAXIMO_MS = 45000;

export async function POST() {
  try {
    await ensureSheets(["ShippingCache"]);

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

    const cacheLogisticoPorOrden = new Map<string, string>();
    try {
      const cacheRows = await readSheet("ShippingCache!A2:D100000");
      for (const r of cacheRows) {
        if (r[0] && r[2]) cacheLogisticoPorOrden.set(String(r[0]), r[2]);
      }
    } catch { /* primera vez, hoja recién creada */ }

    const erroresValidacion: string[] = [];
    let procesadas = 0;
    let nuevasEnCache = 0;
    // false por default: solo pasa a true si la paginación llega al final
    // natural de la ventana de 35 días sin que el budget la haya cortado.
    let completo = false;

    const inicioBackfill = Date.now();
    let tiempoAgotado = false;

    try {
      // Misma ventana que ml-sync (35 días). Paginado por fecha, no por
      // offset fijo, con el mismo tope de offset<=2000 como salvaguarda
      // contra un loop indefinido si el corte por fecha fallara.
      const ventanaHistorial = new Date(Date.now() - 35 * 86400000);
      let ordOffset = 0;
      while (ordOffset <= 2000) {
        if (Date.now() - inicioBackfill > TIEMPO_MAXIMO_MS) { tiempoAgotado = true; break; }

        const { data } = await mlGet<{ results: Record<string, unknown>[]; paging: { total: number } }>(
          `/orders/search?seller=${userId}&sort=date_desc&limit=50&offset=${ordOffset}`
        );
        if (data.results.length === 0) { completo = true; break; }

        const ordenesSinCache = data.results.filter((o) => !cacheLogisticoPorOrden.has(String(o.id)));

        for (let i = 0; i < ordenesSinCache.length; i += SHIPMENT_BATCH_SIZE) {
          if (Date.now() - inicioBackfill > TIEMPO_MAXIMO_MS) { tiempoAgotado = true; break; }

          const lote = ordenesSinCache.slice(i, i + SHIPMENT_BATCH_SIZE);
          const resultados = await Promise.all(
            lote.map(async (order) => {
              const shippingId = (order.shipping as Record<string, unknown>)?.id;
              if (!shippingId) return { orderId: String(order.id), logisticType: null };
              try {
                const { data } = await mlGet<{ logistic_type?: string }>(`/shipments/${shippingId}`);
                return { orderId: String(order.id), shippingId, logisticType: data.logistic_type ?? "" };
              } catch (err) {
                if (err instanceof SyncRetryBudgetExceededError) throw err;
                erroresValidacion.push(`Orden ${order.id}: no se pudo obtener el tipo de envío (${String(err)})`);
                return { orderId: String(order.id), shippingId, logisticType: null };
              }
            })
          );

          // Se guarda al final de cada batch, no al final de todo: si el
          // budget corta la ejecución a mitad de camino, lo ya resuelto
          // queda persistido y no se pierde ni se vuelve a pedir.
          const nuevasEntradasBatch: string[][] = [];
          for (const r of resultados) {
            procesadas++;
            if (r.logisticType !== null) {
              cacheLogisticoPorOrden.set(r.orderId, r.logisticType);
              nuevasEntradasBatch.push([`'${r.orderId}`, `'${String(r.shippingId ?? "")}`, r.logisticType, new Date().toISOString()]);
            }
          }
          if (nuevasEntradasBatch.length > 0) {
            await appendSheet("ShippingCache!A:D", nuevasEntradasBatch);
            nuevasEnCache += nuevasEntradasBatch.length;
          }
        }
        if (tiempoAgotado) break;

        const ultimaOrdenPagina = data.results[data.results.length - 1];
        const fechaUltima = new Date(ultimaOrdenPagina.date_created as string);
        if (fechaUltima < ventanaHistorial) { completo = true; break; }
        ordOffset += 50;
        if (ordOffset > 2000) break; // tope de seguridad tocado: no completo
      }
    } catch (err) {
      if (!(err instanceof SyncRetryBudgetExceededError)) throw err;
      // Budget agotado: se corta acá, completo queda false a propósito
      // para que el frontend sepa que tiene que volver a llamar.
    }

    return NextResponse.json({
      ok: true,
      completo,
      procesadas,
      nuevasEnCache,
      erroresValidacion,
    });
  } catch (error) {
    console.error("[backfill-shipping]", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

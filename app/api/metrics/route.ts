import { NextRequest, NextResponse } from "next/server";
import axios from "axios";
import { getValidAccessToken } from "@/lib/ml-token";
import { createSyncBudget, withMlRetry } from "@/lib/http-retry";

// Endpoint separado de ml-sync (no reutiliza su maxDuration ni su budget):
// mismo criterio que backfill-shipping, para no arriesgar timeouts en rutas
// que ya funcionan al sumar más llamadas a ML.
export const maxDuration = 60;

type Periodo = "dia" | "semana" | "mes";

type VentasMetrics = {
  ok: boolean;
  totalVendido?: number;
  unidades?: number;
  cantidadOrdenes?: number;
  ticketPromedio?: number;
  ventasPorItem?: Record<string, { titulo: string; unidades: number; monto: number }>;
  error?: string;
};

type ReputacionMetrics = {
  ok: boolean;
  levelId?: string;
  powerSellerStatus?: string;
  ventasCompletadas?: number;
  ventasCanceladas?: number;
  claims?: { rate: number; value: number; period: string };
  cancellations?: { rate: number; value: number; period: string };
  delayedHandlingTime?: { rate: number; value: number; period: string };
  error?: string;
};

type VisitaPorPublicacion = { id: string; titulo: string; visitas: number; ventas: number; conversion: number | null };
type VisitasMetrics = {
  ok: boolean;
  totalVisitas?: number;
  porPublicacion?: VisitaPorPublicacion[];
  error?: string;
};

// Mismo criterio que fetchReferenciaML en audit/analyze/route.ts: límites de
// período construidos con Date.UTC, no new Date(...) en hora local — para un
// mes ya cerrado, una construcción en hora local corre el borde del día 1 y
// no cierra el último día del mes, desalineando el número contra Auditoría.
function rangoFechas(periodo: Periodo): { desde: Date; hasta: Date } {
  const ahora = new Date();
  if (periodo === "dia") {
    const desde = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), ahora.getUTCDate()));
    const hasta = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), ahora.getUTCDate() + 1));
    return { desde, hasta };
  }
  if (periodo === "semana") {
    const hoyUTC = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), ahora.getUTCDate() + 1));
    const desde = new Date(hoyUTC.getTime() - 7 * 86400000);
    return { desde, hasta: hoyUTC };
  }
  // mes calendario actual — mismo criterio que ya usa Auditoría
  const desde = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), 1));
  const hasta = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth() + 1, 1));
  return { desde, hasta };
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const periodoParam = searchParams.get("periodo");
  const periodo: Periodo = periodoParam === "dia" || periodoParam === "semana" ? periodoParam : "mes";

  try {
    const token = await getValidAccessToken();
    const mlClient = axios.create({
      baseURL: "https://api.mercadolibre.com",
      headers: { Authorization: `Bearer ${token}` },
      timeout: 8000,
    });
    const budget = createSyncBudget();
    const mlGet = <T = unknown>(url: string, params?: Record<string, unknown>) =>
      withMlRetry(() => mlClient.get<T>(url, { params }), { budget });

    const { data: user } = await mlGet<{ id: string; seller_reputation?: Record<string, unknown> }>("/users/me");
    const userId = user.id;
    const { desde, hasta } = rangoFechas(periodo);

    // Ventas primero (no en paralelo con Visitas): el top de publicaciones
    // por ventas del período define qué items consultar en Visitas.
    const ventas = await calcularVentas(mlGet, userId, desde, hasta);
    const [reputacion, visitas] = await Promise.all([
      Promise.resolve(calcularReputacion(user)),
      calcularVisitas(mlGet, userId, desde, hasta, ventas),
    ]);

    return NextResponse.json({
      ok: true,
      periodo,
      desde: desde.toISOString(),
      hasta: hasta.toISOString(),
      ventas,
      reputacion,
      visitas,
    });
  } catch (error) {
    console.error("[metrics]", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

// ── Ventas ───────────────────────────────────────────────────────────────
// Consulta en vivo a /orders/search (mismo patrón que audit/analyze/route.ts
// fetchReferenciaML), no la hoja Ventas de Sheets: la hoja solo cubre 35 días
// y no filtra por status, así que para que el número cuadre con Auditoría
// hace falta la misma fuente que usa Auditoría.
async function calcularVentas(
  mlGet: <T = unknown>(url: string, params?: Record<string, unknown>) => Promise<{ data: T }>,
  userId: string,
  desde: Date,
  hasta: Date
): Promise<VentasMetrics> {
  try {
    let totalVendido = 0;
    let unidades = 0;
    let cantidadOrdenes = 0;
    const ventasPorItem: Record<string, { titulo: string; unidades: number; monto: number }> = {};
    let offset = 0;
    while (offset <= 1000) {
      const { data } = await mlGet<{ results: Record<string, unknown>[]; paging: { total: number } }>(
        "/orders/search",
        {
          seller: userId,
          "order.status": "paid",
          "order.date_created.from": desde.toISOString(),
          "order.date_created.to": hasta.toISOString(),
          sort: "date_desc",
          limit: 50,
          offset,
        }
      );
      for (const order of data.results ?? []) {
        totalVendido += Number(order.total_amount) || 0;
        cantidadOrdenes++;
        const items = (order.order_items as Record<string, unknown>[]) ?? [];
        for (const it of items) {
          const qty = Number(it.quantity) || 0;
          unidades += qty;
          const itemInfo = it.item as Record<string, unknown> | undefined;
          const itemId = itemInfo?.id as string | undefined;
          if (!itemId) continue;
          const precio = Number(it.unit_price) || 0;
          if (!ventasPorItem[itemId]) {
            ventasPorItem[itemId] = { titulo: (itemInfo?.title as string) ?? itemId, unidades: 0, monto: 0 };
          }
          ventasPorItem[itemId].unidades += qty;
          ventasPorItem[itemId].monto += qty * precio;
        }
      }
      if (data.results.length === 0 || offset + data.results.length >= data.paging.total) break;
      offset += 50;
    }
    return {
      ok: true,
      totalVendido,
      unidades,
      cantidadOrdenes,
      ticketPromedio: cantidadOrdenes > 0 ? Math.round(totalVendido / cantidadOrdenes) : 0,
      ventasPorItem,
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ── Reputación ───────────────────────────────────────────────────────────
// Ya viene en /users/me, sin llamada adicional a ML.
function calcularReputacion(user: { seller_reputation?: Record<string, unknown> }): ReputacionMetrics {
  const rep = user.seller_reputation;
  if (!rep) return { ok: false, error: "seller_reputation no vino en /users/me" };
  const transactions = rep.transactions as Record<string, unknown> | undefined;
  const metrics = rep.metrics as Record<string, Record<string, unknown>> | undefined;
  return {
    ok: true,
    levelId: rep.level_id as string | undefined,
    powerSellerStatus: rep.power_seller_status as string | undefined,
    ventasCompletadas: transactions?.completed as number | undefined,
    ventasCanceladas: transactions?.canceled as number | undefined,
    claims: metrics?.claims as ReputacionMetrics["claims"],
    cancellations: metrics?.cancellations as ReputacionMetrics["cancellations"],
    delayedHandlingTime: metrics?.delayed_handling_time as ReputacionMetrics["delayedHandlingTime"],
  };
}

// Tope de publicaciones a consultar individualmente en /items/{id}/visits
// (solo acepta 1 id por llamada) — evita decenas de requests extra por sync.
const TOP_PUBLICACIONES_VISITAS = 10;

// ── Visitas y conversión ─────────────────────────────────────────────────
// Total agregado: /users/{id}/items_visits. Por publicación: /items/{id}/visits
// (confirmado empíricamente que solo acepta un ID por llamada), limitado al
// top de publicaciones por ventas del período para no disparar decenas de
// requests — no tiene sentido pedir visitas de publicaciones sin ventas acá.
async function calcularVisitas(
  mlGet: <T = unknown>(url: string, params?: Record<string, unknown>) => Promise<{ data: T }>,
  userId: string,
  desde: Date,
  hasta: Date,
  ventas: VentasMetrics
): Promise<VisitasMetrics> {
  try {
    // Cap SOLO acá, no en rangoFechas ni en calcularVentas: para el período
    // "mes" en curso, `hasta` es el primer día del mes SIGUIENTE en UTC (una
    // fecha futura real), y /orders/search lo tolera sin problema — pero la
    // API de Visits devuelve 400 si date_to cae en el futuro. No cambiar el
    // `hasta` real (usado por Ventas/Auditoría, ya verificado que cuadra);
    // solo achicar la fecha que efectivamente viaja en esta llamada puntual.
    const hastaVisitas = hasta.getTime() > Date.now() ? new Date() : hasta;
    const dateFrom = desde.toISOString().slice(0, 10);
    const dateTo = hastaVisitas.toISOString().slice(0, 10);

    const { data: totalData } = await mlGet<{ total_visits: number }>(
      `/users/${userId}/items_visits`,
      { date_from: dateFrom, date_to: dateTo }
    );

    const porPublicacion: VisitaPorPublicacion[] = [];
    if (ventas.ok && ventas.ventasPorItem) {
      const topItems = Object.entries(ventas.ventasPorItem)
        .sort((a, b) => b[1].unidades - a[1].unidades)
        .slice(0, TOP_PUBLICACIONES_VISITAS);

      for (const [itemId, info] of topItems) {
        try {
          const { data } = await mlGet<{ total_visits: number }>(
            `/items/${itemId}/visits`,
            { date_from: dateFrom, date_to: dateTo }
          );
          const visitasItem = data.total_visits ?? 0;
          porPublicacion.push({
            id: itemId,
            titulo: info.titulo,
            visitas: visitasItem,
            ventas: info.unidades,
            conversion: visitasItem > 0 ? Math.round((info.unidades / visitasItem) * 10000) / 100 : null,
          });
        } catch {
          // Si una publicación individual falla, se omite — no aborta el resto.
          porPublicacion.push({ id: itemId, titulo: info.titulo, visitas: 0, ventas: info.unidades, conversion: null });
        }
      }
    }

    return {
      ok: true,
      totalVisitas: totalData.total_visits ?? 0,
      porPublicacion,
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

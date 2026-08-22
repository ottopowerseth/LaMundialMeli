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
  ranking?: ProductoRanking[];
  comparacion?: ComparacionPeriodo | null;
  error?: string;
};

type ProductoRanking = { id: string; titulo: string; monto: number; unidades: number };

// Variación % genérica entre un valor actual y uno del período anterior —
// null cuando el anterior es 0 (división por cero no tiene una variación
// % con sentido; el cliente debe mostrar "sin datos previos", no "+Infinity%").
type VariacionPct = { actual: number; anterior: number; variacionPct: number | null };

// Reutilizable por cualquier sección futura que quiera comparar contra el
// período anterior (hoy solo Ventas la usa) — de ahí que viva a nivel de
// módulo y no anidada dentro de VentasMetrics.
type ComparacionPeriodo = {
  totalVendido: VariacionPct;
  unidades: VariacionPct;
  ticketPromedio: VariacionPct;
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

type PreguntasMetrics = {
  ok: boolean;
  total?: number;
  sinResponder?: number;
  tiempoRespuestaPromedioHoras?: number | null;
  error?: string;
};

type ReclamosMetrics = {
  ok: boolean;
  total?: number;
  porStatus?: Record<string, number>;
  porTipo?: Record<string, number>;
  error?: string;
};

type CampanaRoas = {
  id: number;
  nombre: string;
  estado: string;
  presupuesto: number;
  clics: number;
  impresiones: number;
  ctr: number;
  costo: number;
  roas: number;
  acos: number;
};
type RoasMetrics = {
  ok: boolean;
  inversionTotal?: number;
  ventasAtribuidasTotal?: number;
  roasAgregado?: number | null;
  campanas?: CampanaRoas[];
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

// Rango inmediatamente anterior de igual duración — reutilizable por
// cualquier sección de Métricas que quiera comparar contra el período previo
// (hoy solo la usa Ventas, ver calcularComparacionVentas). Para "mes" no se
// resta la duración en ms (un mes anterior puede tener 28-31 días, distinto
// al actual) — se calcula el mes calendario anterior explícitamente. Para
// "dia"/"semana", restar la duración exacta ya da el período correcto.
function rangoAnterior(periodo: Periodo, desde: Date, hasta: Date): { desde: Date; hasta: Date } {
  if (periodo === "mes") {
    const anteriorDesde = new Date(Date.UTC(desde.getUTCFullYear(), desde.getUTCMonth() - 1, 1));
    const anteriorHasta = new Date(Date.UTC(desde.getUTCFullYear(), desde.getUTCMonth(), 1));
    return { desde: anteriorDesde, hasta: anteriorHasta };
  }
  const duracionMs = hasta.getTime() - desde.getTime();
  return { desde: new Date(desde.getTime() - duracionMs), hasta: desde };
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
    const mlGet = <T = unknown>(url: string, params?: Record<string, unknown>, headers?: Record<string, string>) =>
      withMlRetry(() => mlClient.get<T>(url, { params, headers }), { budget });

    const { data: user } = await mlGet<{ id: string; seller_reputation?: Record<string, unknown> }>("/users/me");
    const userId = user.id;
    const { desde, hasta } = rangoFechas(periodo);

    // Ventas primero (no en paralelo con Visitas): el top de publicaciones
    // por ventas del período define qué items consultar en Visitas.
    const ventas = await calcularVentas(mlGet, userId, desde, hasta);
    const { desde: desdeAnterior, hasta: hastaAnterior } = rangoAnterior(periodo, desde, hasta);
    const [reputacion, visitas, preguntas, reclamos, roas, ventasAnterior] = await Promise.all([
      Promise.resolve(calcularReputacion(user)),
      calcularVisitas(mlGet, userId, desde, hasta, ventas),
      calcularPreguntas(mlGet, userId, desde, hasta),
      calcularReclamos(mlGet, userId, desde, hasta),
      calcularRoas(mlGet, desde, hasta),
      calcularVentas(mlGet, userId, desdeAnterior, hastaAnterior),
    ]);

    if (ventas.ok) {
      ventas.ranking = armarRanking(ventas.ventasPorItem);
      ventas.comparacion = ventasAnterior.ok
        ? {
            totalVendido: calcularVariacionPct(ventas.totalVendido ?? 0, ventasAnterior.totalVendido ?? 0),
            unidades: calcularVariacionPct(ventas.unidades ?? 0, ventasAnterior.unidades ?? 0),
            ticketPromedio: calcularVariacionPct(ventas.ticketPromedio ?? 0, ventasAnterior.ticketPromedio ?? 0),
          }
        : null;
    }

    return NextResponse.json({
      ok: true,
      periodo,
      desde: desde.toISOString(),
      hasta: hasta.toISOString(),
      ventas,
      reputacion,
      visitas,
      preguntas,
      reclamos,
      roas,
    });
  } catch (error) {
    console.error("[metrics]", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

const TOP_RANKING_PRODUCTOS = 10;

// Top N productos por monto vendido — deriva de ventasPorItem, que ya se
// calcula en calcularVentas para alimentar el top de Visitas. No hace falta
// ninguna llamada nueva a ML ni cambio de sync: el detalle por item ya
// viene desagregado en /orders/search (order_items).
function armarRanking(
  ventasPorItem: Record<string, { titulo: string; unidades: number; monto: number }> | undefined
): ProductoRanking[] {
  if (!ventasPorItem) return [];
  return Object.entries(ventasPorItem)
    .map(([id, info]) => ({ id, titulo: info.titulo, monto: info.monto, unidades: info.unidades }))
    .sort((a, b) => b.monto - a.monto)
    .slice(0, TOP_RANKING_PRODUCTOS);
}

// Variación % genérica actual vs. anterior — reutilizable por cualquier
// sección que agregue comparación de período más adelante (ver
// ComparacionPeriodo). null cuando el valor anterior es 0: no hay una
// variación % con sentido para mostrar (evita "+Infinity%" o división por 0).
function calcularVariacionPct(actual: number, anterior: number): VariacionPct {
  const variacionPct = anterior > 0
    ? Math.round(((actual - anterior) / anterior) * 1000) / 10
    : null;
  return { actual, anterior, variacionPct };
}

// ── Ventas ───────────────────────────────────────────────────────────────
// Consulta en vivo a /orders/search (mismo patrón que audit/analyze/route.ts
// fetchReferenciaML), no la hoja Ventas de Sheets: la hoja solo cubre 35 días
// y no filtra por status, así que para que el número cuadre con Auditoría
// hace falta la misma fuente que usa Auditoría.
async function calcularVentas(
  mlGet: <T = unknown>(url: string, params?: Record<string, unknown>, headers?: Record<string, string>) => Promise<{ data: T }>,
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
  mlGet: <T = unknown>(url: string, params?: Record<string, unknown>, headers?: Record<string, string>) => Promise<{ data: T }>,
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

// ── Preguntas ────────────────────────────────────────────────────────────
// /questions/search no tiene filtro de fecha en available_filters (confirmado
// empíricamente) — se trae por status y se filtra por date_created acá. La
// API sí filtra por status=UNANSWERED, así que "sin responder" no necesita
// el filtro de fecha del período: es el estado actual, no algo del período.
async function calcularPreguntas(
  mlGet: <T = unknown>(url: string, params?: Record<string, unknown>, headers?: Record<string, string>) => Promise<{ data: T }>,
  userId: string,
  desde: Date,
  hasta: Date
): Promise<PreguntasMetrics> {
  try {
    const { data: sinResponderData } = await mlGet<{ total: number }>("/questions/search", {
      seller_id: userId,
      status: "UNANSWERED",
      limit: 1,
    });

    // date_created de /questions/search viene en hora Chile (-04:00), no UTC
    // — hay que normalizar antes de comparar contra desde/hasta (que sí son UTC).
    let total = 0;
    let sumaHoras = 0;
    let respondidas = 0;
    let offset = 0;
    while (offset <= 1000) {
      const { data } = await mlGet<{
        total: number;
        questions: { date_created: string; answer: { date_created: string } | null }[];
      }>("/questions/search", {
        seller_id: userId,
        limit: 50,
        offset,
        sort_fields: "date_created",
        sort_types: "DESC",
      });
      for (const q of data.questions ?? []) {
        const fechaPregunta = new Date(q.date_created);
        if (fechaPregunta < desde || fechaPregunta >= hasta) continue;
        total++;
        if (q.answer) {
          const horas = (new Date(q.answer.date_created).getTime() - fechaPregunta.getTime()) / 3600000;
          sumaHoras += horas;
          respondidas++;
        }
      }
      // Como viene ordenado DESC por date_created, en cuanto la más vieja de
      // la página ya quedó antes de `desde` no hay más preguntas del período
      // más atrás — se puede cortar sin recorrer el resto del histórico.
      const masVieja = data.questions?.[data.questions.length - 1];
      if (!masVieja || new Date(masVieja.date_created) < desde) break;
      if (offset + (data.questions?.length ?? 0) >= data.total) break;
      offset += 50;
    }

    return {
      ok: true,
      total,
      sinResponder: sinResponderData.total ?? 0,
      tiempoRespuestaPromedioHoras: respondidas > 0 ? Math.round((sumaHoras / respondidas) * 10) / 10 : null,
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ── Reclamos (post-purchase) ────────────────────────────────────────────
// /post-purchase/v1/claims/search ignora silenciosamente cualquier parámetro
// de fecha probado (date_created.from/to, date_from/to) — confirmado
// empíricamente: paging.total no cambia con o sin esos params. Por eso se
// trae todo paginado y se filtra por date_created en el código, igual que
// Preguntas. Hoy son 234 registros históricos (liviano); si el histórico
// crece mucho, esto puede volverse la parte más lenta del endpoint — en ese
// caso conviene cachear el resultado (ej. en Sheets, como ya se hace con
// logistic_type en ml-sync) en vez de traer todo en cada request.
async function calcularReclamos(
  mlGet: <T = unknown>(url: string, params?: Record<string, unknown>, headers?: Record<string, string>) => Promise<{ data: T }>,
  userId: string,
  desde: Date,
  hasta: Date
): Promise<ReclamosMetrics> {
  try {
    const porStatus: Record<string, number> = {};
    const porTipo: Record<string, number> = {};
    let total = 0;
    let offset = 0;
    while (offset <= 1000) {
      const { data } = await mlGet<{
        paging: { total: number };
        data: { status: string; type: string; date_created: string }[];
      }>("/post-purchase/v1/claims/search", {
        player_role: "respondent",
        player_user_id: userId,
        limit: 50,
        offset,
      });
      for (const claim of data.data ?? []) {
        const fecha = new Date(claim.date_created); // hora Chile (-04:00), Date la normaliza a UTC internamente
        if (fecha < desde || fecha >= hasta) continue;
        total++;
        porStatus[claim.status] = (porStatus[claim.status] ?? 0) + 1;
        porTipo[claim.type] = (porTipo[claim.type] ?? 0) + 1;
      }
      if (!data.data || data.data.length === 0 || offset + data.data.length >= data.paging.total) break;
      offset += 50;
    }

    return { ok: true, total, porStatus, porTipo };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ── ROAS / Publicidad (Product Ads) ─────────────────────────────────────
// Path confirmado empíricamente: la doc pública apuntaba a
// /advertising/advertisers/{id}/product_ads/campaigns (sin /marketplace ni
// /search), que devuelve 404 vacío — ML migró el endpoint. El correcto es
// /marketplace/advertising/{site}/advertisers/{id}/product_ads/campaigns/search.
// advertiser_id no se hardcodea: se resuelve en runtime vía
// /advertising/advertisers, mismo criterio que userId con /users/me — es un
// ID de cuenta, no algo que deba fijarse en el código.
//
// A diferencia de Visits, este endpoint SÍ tolera date_to en el futuro
// (confirmado empíricamente) — no hace falta el cap que usa calcularVisitas.
//
// roas/acos por campaña vienen calculados por ML (no recalcular, evita
// divergencias si ML cambia su fórmula). El roasAgregado del período sí es
// un cálculo propio (total_amount / cost sumado entre campañas) porque no
// existe un endpoint de resumen agregado a nivel cuenta — no confundir con
// los roas por campaña, que son valores directos de ML.
const ROAS_METRICS_FIELDS = "clicks,prints,ctr,cost,cpc,acos,roas,organic_units_quantity,organic_units_amount,direct_amount,indirect_amount,total_amount";

async function calcularRoas(
  mlGet: <T = unknown>(url: string, params?: Record<string, unknown>, headers?: Record<string, string>) => Promise<{ data: T }>,
  desde: Date,
  hasta: Date
): Promise<RoasMetrics> {
  try {
    const { data: advertisersData } = await mlGet<{ advertisers: { advertiser_id: number; site_id: string }[] }>(
      "/advertising/advertisers",
      { product_id: "PADS" },
      { "Api-Version": "1" }
    );
    const advertiser = advertisersData.advertisers?.[0];
    if (!advertiser) return { ok: false, error: "No hay advertiser de Product Ads asociado a esta cuenta" };

    const dateFrom = desde.toISOString().slice(0, 10);
    const dateTo = hasta.toISOString().slice(0, 10);

    const { data } = await mlGet<{
      results: {
        id: number;
        name: string;
        status: string;
        budget: number;
        metrics?: {
          clicks: number;
          prints: number;
          ctr: number;
          cost: number;
          acos: number;
          roas: number;
          total_amount: number;
        };
      }[];
    }>(
      `/marketplace/advertising/${advertiser.site_id}/advertisers/${advertiser.advertiser_id}/product_ads/campaigns/search`,
      { date_from: dateFrom, date_to: dateTo, metrics: ROAS_METRICS_FIELDS },
      { "Api-Version": "1", "Content-Type": "application/json" }
    );

    const campanas: CampanaRoas[] = (data.results ?? []).map((c) => ({
      id: c.id,
      nombre: c.name,
      estado: c.status,
      presupuesto: c.budget,
      clics: c.metrics?.clicks ?? 0,
      impresiones: c.metrics?.prints ?? 0,
      ctr: c.metrics?.ctr ?? 0,
      costo: c.metrics?.cost ?? 0,
      roas: c.metrics?.roas ?? 0,
      acos: c.metrics?.acos ?? 0,
    }));

    const inversionTotal = campanas.reduce((sum, c) => sum + c.costo, 0);
    const ventasAtribuidasTotal = (data.results ?? []).reduce((sum, c) => sum + (c.metrics?.total_amount ?? 0), 0);

    return {
      ok: true,
      inversionTotal,
      ventasAtribuidasTotal,
      roasAgregado: inversionTotal > 0 ? Math.round((ventasAtribuidasTotal / inversionTotal) * 100) / 100 : null,
      campanas,
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

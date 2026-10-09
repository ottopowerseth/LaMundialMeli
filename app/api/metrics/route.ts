import { NextRequest, NextResponse } from "next/server";
import axios from "axios";
import { getValidAccessToken } from "@/lib/ml-token";
import { createSyncBudget, withMlRetry } from "@/lib/http-retry";
import { listarOrdenesRango } from "@/lib/backfill-shipping";
import { readSheet } from "@/lib/sheets";
import { calcularMargen, IVA } from "@/lib/rentabilidad";
import { obtenerAdsPorItem, ROAS_METRICS_FIELDS } from "@/lib/ml-ads";
import { armarContextoEnvio, parsearTarifasEnvio, resolverEnvio } from "@/lib/envio-medido";
import { acumularComision, pctComisionListingPrices, resolverComision } from "@/lib/comision-real";
import type { AcumuladoComision, ComisionResuelta } from "@/lib/comision-real";

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
  // Ingreso y comisión (sale_fee × cantidad) de las líneas del período que
  // traen sale_fee, por publicación — ver lib/comision-real.ts.
  comisionPorItem?: Record<string, AcumuladoComision>;
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
  estrategia: string;
  acosTarget: number;
  presupuestoDiario: number;
  presupuesto: number;
  clics: number;
  impresiones: number;
  ctr: number;
  cpc: number;
  costo: number;
  roas: number;
  acos: number;
  montoDirecto: number;
  montoIndirecto: number;
  unidadesOrganicas: number;
  montoOrganico: number;
  usoPresupuesto: number | null;
};
type RoasMetrics = {
  ok: boolean;
  inversionTotal?: number;
  ventasAtribuidasTotal?: number;
  roasAgregado?: number | null;
  campanas?: CampanaRoas[];
  error?: string;
};

type EtiquetaProducto = "Candidato" | "Revisar" | "Stock bajo";

type FilaTablaProducto = {
  id: string;
  titulo: string;
  ventasMonto: number;
  ventasUnidades: number;
  visitas: number | null;
  conversion: number | null;
  stock: number | null;
  full: boolean;
  precio: number | null;
  costo: number | null;
  margenPct: number | null;
  costoMax: number | null;
  // Origen del envío usado en Costo máx./Precio equilibrio/Pierde/Margen %:
  // "medido" = tarifa real de /shipments/{id}/costs (hoja TarifaEnvio);
  // "estimado" = respaldo (SKU gemelo, tramo de precio, o fila marcada
  // estimada). null = sin dato: esas celdas quedan vacías, no se inventan.
  costoMaxFuenteEnvio: "medido" | "estimado" | null;
  // Comisión real como % del precio bruto y su origen: "orden" = sale_fee
  // cobrado en las ventas del período; "calculada" = calculadora oficial de
  // ML (publicación sin ventas en el período).
  comisionPct: number | null;
  comisionFuente: "orden" | "calculada" | null;
  envioPorUnidad: number | null; // bruto
  precioEquilibrio: number | null;
  pierde: boolean;
  campana: string | null;
  campanaId: number | null;
  statusAnuncio: string | null;
  clics: number;
  impresiones: number;
  ctr: number;
  cpc: number;
  costoAds: number;
  acos: number;
  roas: number;
  etiquetas: EtiquetaProducto[];
};
type TablaProductosMetrics = {
  ok: boolean;
  filas?: FilaTablaProducto[];
  error?: string;
};

// La API de Visits (/users/{id}/items_visits y /items/{id}/visits) rechaza
// con 400 cualquier date_to en el futuro ("date_to must not be after the
// current date", confirmado empíricamente) — a diferencia de /orders/search
// y de /product_ads/.../search, que sí toleran fechas futuras. Para el
// período "mes" en curso, `hasta` es el primer día del mes SIGUIENTE en UTC
// (una fecha futura real), así que toda llamada a Visits necesita este cap.
// Única fuente de verdad: no capear `hasta` en rangoFechas ni en el `hasta`
// real usado por Ventas/Auditoría/Ads — solo la fecha que efectivamente
// viaja en la llamada puntual a Visits.
function hastaEfectivo(hasta: Date): Date {
  return hasta.getTime() > Date.now() ? new Date() : hasta;
}

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
    let { desde, hasta } = rangoFechas(periodo);
    // Opcional (verificación y rangos largos): desde/hasta ISO fijan la ventana exacta, igual que /api/tablero.
    const desdeQ = Date.parse(searchParams.get("desde") ?? ""), hastaQ = Date.parse(searchParams.get("hasta") ?? "");
    if (!Number.isNaN(desdeQ) && !Number.isNaN(hastaQ) && hastaQ > desdeQ) { desde = new Date(desdeQ); hasta = new Date(hastaQ); }

    // Ventas primero (no en paralelo con Visitas): el top de publicaciones
    // por ventas del período define qué items consultar en Visitas.
    const ventas = await calcularVentas(mlGet, userId, desde, hasta);
    const { desde: desdeAnterior, hasta: hastaAnterior } = rangoAnterior(periodo, desde, hasta);
    const [reputacion, visitas, preguntas, reclamos, roasResultado, ventasAnterior] = await Promise.all([
      Promise.resolve(calcularReputacion(user)),
      calcularVisitas(mlGet, userId, desde, hasta, ventas),
      calcularPreguntas(mlGet, userId, desde, hasta),
      calcularReclamos(mlGet, userId, desde, hasta),
      calcularRoas(mlGet, desde, hasta),
      calcularVentas(mlGet, userId, desdeAnterior, hastaAnterior),
    ]);
    const roas = roasResultado.metrics;

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

    // Después de Ventas y ROAS (no en el Promise.all de arriba): necesita
    // ventasPorItem para el top de ventas y roas.campanas para acos_target
    // por campaña — ambos ya resueltos acá.
    const tablaProductos = await calcularTablaProductos(mlGet, desde, hasta, ventas, roas, roasResultado.advertiser);

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
      tablaProductos,
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
    const comisionAcc = new Map<string, AcumuladoComision>();
    // Ventanas de un día (lib/backfill-shipping.ts, la misma lógica del backfill)
    // en vez de paginar por offset: antes se cortaba en offset <= 1000 (~1.100
    // órdenes), que un período largo (un mes con más de ~1.100 ventas) supera.
    // ML se pasa hasta ~1 h en el borde "to" de cada ventana: se descartan las órdenes fuera
    // del rango por su fecha real y las repetidas (así queda igual que el Tablero).
    const { ordenes } = await listarOrdenesRango<Record<string, unknown> & { id: number | string; date_created?: unknown }>(
      (u) => mlGet(u), userId, desde.getTime(), hastaEfectivo(hasta).getTime(), { extraQuery: "&order.status=paid" }
    );
    for (const order of ordenes) {
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
        // sale_fee es POR UNIDAD (comisión real cobrada, bruta).
        acumularComision(comisionAcc, itemId, qty, precio, it.sale_fee);
      }
    }
    return {
      ok: true,
      totalVendido,
      unidades,
      cantidadOrdenes,
      ticketPromedio: cantidadOrdenes > 0 ? Math.round(totalVendido / cantidadOrdenes) : 0,
      ventasPorItem,
      comisionPorItem: Object.fromEntries(comisionAcc),
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
    const dateFrom = desde.toISOString().slice(0, 10);
    const dateTo = hastaEfectivo(hasta).toISOString().slice(0, 10);

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
//
// usoPresupuesto también es cálculo propio: ML no expone un % de uso del
// presupuesto por período, solo daily_budget (presupuesto diario fijo). Se
// compara el costo real del período contra daily_budget × cantidad de días
// del período — una aproximación, no lo que ML usaría internamente para
// pausar la campaña por presupuesto agotado (esa lógica es diaria, no de
// período completo). ROAS_METRICS_FIELDS vive en lib/ml-ads.ts (importado
// arriba) — mismo parámetro metrics= usado acá y en obtenerAdsPorItem.

// Se exporta junto al resultado de negocio (RoasMetrics) para que
// calcularTablaProductos no tenga que resolver el advertiser de nuevo — es
// el mismo dato, pedirlo dos veces solo gastaría una llamada más sin razón.
type RoasResultado = { metrics: RoasMetrics; advertiser: { advertiser_id: number; site_id: string } | null };

async function calcularRoas(
  mlGet: <T = unknown>(url: string, params?: Record<string, unknown>, headers?: Record<string, string>) => Promise<{ data: T }>,
  desde: Date,
  hasta: Date
): Promise<RoasResultado> {
  try {
    const { data: advertisersData } = await mlGet<{ advertisers: { advertiser_id: number; site_id: string }[] }>(
      "/advertising/advertisers",
      { product_id: "PADS" },
      { "Api-Version": "1" }
    );
    const advertiser = advertisersData.advertisers?.[0];
    if (!advertiser) return { metrics: { ok: false, error: "No hay advertiser de Product Ads asociado a esta cuenta" }, advertiser: null };

    const dateFrom = desde.toISOString().slice(0, 10);
    const dateTo = hasta.toISOString().slice(0, 10);

    const { data } = await mlGet<{
      results: {
        id: number;
        name: string;
        status: string;
        strategy: string;
        acos_target: number;
        budget: number;
        daily_budget: number;
        metrics?: {
          clicks: number;
          prints: number;
          ctr: number;
          cost: number;
          cpc: number;
          acos: number;
          roas: number;
          direct_amount: number;
          indirect_amount: number;
          total_amount: number;
          organic_units_quantity: number;
          organic_units_amount: number;
        };
      }[];
    }>(
      `/marketplace/advertising/${advertiser.site_id}/advertisers/${advertiser.advertiser_id}/product_ads/campaigns/search`,
      { date_from: dateFrom, date_to: dateTo, metrics: ROAS_METRICS_FIELDS },
      { "Api-Version": "1", "Content-Type": "application/json" }
    );

    // Días TRANSCURRIDOS del período para "uso de presupuesto" — no días del
    // período completo: para "mes" en curso, hasta es el 1º del mes siguiente
    // (fin de mes, incluye días futuros que todavía no gastaron presupuesto).
    // Usar hastaEfectivo acá es el mismo gotcha/fix que Visits pero por una
    // razón distinta: no es que la API lo rechace, es que dividir el costo
    // real (acumulado hasta HOY) entre un presupuesto de días que no
    // pasaron todavía subestima el % de uso real.
    const diasPeriodo = Math.max(1, Math.round((hastaEfectivo(hasta).getTime() - desde.getTime()) / 86400000));

    const campanas: CampanaRoas[] = (data.results ?? []).map((c) => {
      const costo = c.metrics?.cost ?? 0;
      const presupuestoTotalPeriodo = c.daily_budget * diasPeriodo;
      return {
        id: c.id,
        nombre: c.name,
        estado: c.status,
        estrategia: c.strategy,
        acosTarget: c.acos_target,
        presupuestoDiario: c.daily_budget,
        presupuesto: c.budget,
        clics: c.metrics?.clicks ?? 0,
        impresiones: c.metrics?.prints ?? 0,
        ctr: c.metrics?.ctr ?? 0,
        cpc: c.metrics?.cpc ?? 0,
        costo,
        roas: c.metrics?.roas ?? 0,
        acos: c.metrics?.acos ?? 0,
        montoDirecto: c.metrics?.direct_amount ?? 0,
        montoIndirecto: c.metrics?.indirect_amount ?? 0,
        unidadesOrganicas: c.metrics?.organic_units_quantity ?? 0,
        montoOrganico: c.metrics?.organic_units_amount ?? 0,
        usoPresupuesto: presupuestoTotalPeriodo > 0
          ? Math.round((costo / presupuestoTotalPeriodo) * 1000) / 10
          : null,
      };
    });

    const inversionTotal = campanas.reduce((sum, c) => sum + c.costo, 0);
    const ventasAtribuidasTotal = (data.results ?? []).reduce((sum, c) => sum + (c.metrics?.total_amount ?? 0), 0);

    return {
      metrics: {
        ok: true,
        inversionTotal,
        ventasAtribuidasTotal,
        roasAgregado: inversionTotal > 0 ? Math.round((ventasAtribuidasTotal / inversionTotal) * 100) / 100 : null,
        campanas,
      },
      advertiser,
    };
  } catch (err) {
    return { metrics: { ok: false, error: String(err) }, advertiser: null };
  }
}

// ── Tabla por producto (para decidir candidatos a campaña) ──────────────
// Filas: unión de (a) top N por ventas del período y (b) todo ítem con
// costo de ads > 0 en el período — así no se pierde ningún producto que ya
// tiene inversión activa aunque no esté en el top de ventas (ej. recién
// lanzado a campaña, todavía sin volumen). Umbrales como constantes acá,
// no hardcodeados en el cuerpo de la función, para que sean fáciles de
// ajustar sin tener que releer la lógica completa.
const TABLA_PRODUCTOS_TOP_VENTAS = 50;

// "Stock bajo" para un ítem en campaña activa: menos de este número de días
// de cobertura al ritmo de ventas del período consultado (unidades del
// período / días del período). Con ventas 0 en el período no se puede
// estimar velocidad — esas filas no se etiquetan "Stock bajo" (ver
// calcularEtiquetas), no porque no puedan tener poco stock, sino porque no
// hay dato para distinguir "bajo" de "sin rotación".
const STOCK_BAJO_DIAS_COBERTURA = 7;

// "Revisar" cuando el ACOS de la campaña del ítem supera su acos_target en
// más de este margen relativo — un ítem apenas por encima del target no es
// una alarma, ML tolera variación día a día; 20% por encima sí es señal de
// que la campaña se está saliendo del objetivo que Otto configuró.
const ACOS_REVISAR_MARGEN_RELATIVO = 1.2;

function resolveStockTabla(item: Record<string, unknown>): number | null {
  const raiz = item.available_quantity;
  if (typeof raiz === "number" && !Number.isNaN(raiz)) return raiz;
  const variations = item.variations as Record<string, unknown>[] | undefined;
  if (Array.isArray(variations) && variations.length > 0) {
    let suma = 0;
    let algunaValida = false;
    for (const v of variations) {
      const q = v.available_quantity;
      if (typeof q === "number" && !Number.isNaN(q)) { suma += q; algunaValida = true; }
    }
    if (algunaValida) return suma;
  }
  return null;
}

function mediana(valores: number[]): number | null {
  if (valores.length === 0) return null;
  const ordenados = [...valores].sort((a, b) => a - b);
  const mitad = Math.floor(ordenados.length / 2);
  return ordenados.length % 2 !== 0
    ? ordenados[mitad]
    : (ordenados[mitad - 1] + ordenados[mitad]) / 2;
}

async function calcularTablaProductos(
  mlGet: <T = unknown>(url: string, params?: Record<string, unknown>, headers?: Record<string, string>) => Promise<{ data: T }>,
  desde: Date,
  hasta: Date,
  ventas: VentasMetrics,
  roas: RoasMetrics,
  advertiser: { advertiser_id: number; site_id: string } | null
): Promise<TablaProductosMetrics> {
  try {
    if (!ventas.ok || !ventas.ventasPorItem) {
      return { ok: false, error: "Ventas no disponible, no se puede armar la tabla por producto" };
    }

    const dateFrom = desde.toISOString().slice(0, 10);
    // dateTo SIN cap — para /ads/search (igual que /product_ads/.../campaigns
    // en calcularRoas, confirmado que tolera fechas futuras). Ver dateToVisitas
    // más abajo para la llamada a /items/{id}/visits, que sí necesita el cap.
    const dateTo = hasta.toISOString().slice(0, 10);

    // Ads por ítem — ver lib/ml-ads.ts para el gotcha de campaign_id
    // ignorado en la query (filtrado client-side ahí adentro).
    const adsPorItem = advertiser
      ? await obtenerAdsPorItem(mlGet, advertiser, dateFrom, dateTo)
      : new Map();

    const nombrePorCampana = new Map<number, string>();
    const acosTargetPorCampana = new Map<number, number>();
    for (const c of roas.campanas ?? []) {
      nombrePorCampana.set(c.id, c.nombre);
      acosTargetPorCampana.set(c.id, c.acosTarget);
    }

    // Unión: top N por ventas del período + todo ítem con costo de ads > 0,
    // aunque no esté en el top (ver comentario de TABLA_PRODUCTOS_TOP_VENTAS).
    const topVentas = Object.entries(ventas.ventasPorItem)
      .sort((a, b) => b[1].monto - a[1].monto)
      .slice(0, TABLA_PRODUCTOS_TOP_VENTAS)
      .map(([id]) => id);
    const idsConCostoAds = [...adsPorItem.entries()].filter(([, ad]) => ad.cost > 0).map(([id]) => id);
    const idsFilas = [...new Set([...topVentas, ...idsConCostoAds])];

    if (idsFilas.length === 0) return { ok: true, filas: [] };

    // Visitas — 1 llamada por ítem (confirmado empíricamente que /items/visits
    // no acepta batch de ids), en paralelo con concurrencia acotada, mismo
    // criterio que SHIPMENT_BATCH_SIZE en ml-sync para no disparar decenas de
    // requests simultáneas contra ML. dateToVisitas usa hastaEfectivo, no el
    // dateTo de arriba: Visits rechaza date_to futuro (ver hastaEfectivo).
    const dateToVisitas = hastaEfectivo(hasta).toISOString().slice(0, 10);
    const CONCURRENCIA_VISITAS = 8;
    const visitasPorItem = new Map<string, number>();
    for (let i = 0; i < idsFilas.length; i += CONCURRENCIA_VISITAS) {
      const lote = idsFilas.slice(i, i + CONCURRENCIA_VISITAS);
      const resultados = await Promise.all(
        lote.map(async (id) => {
          try {
            const { data } = await mlGet<{ total_visits: number }>(`/items/${id}/visits`, { date_from: dateFrom, date_to: dateToVisitas });
            return { id, visitas: data.total_visits ?? 0 };
          } catch {
            return { id, visitas: null };
          }
        })
      );
      for (const r of resultados) if (r.visitas !== null) visitasPorItem.set(r.id, r.visitas);
    }

    // Stock + Full + tipo de publicación + categoría + SKU — batch de 20 ids
    // por llamada (mismo endpoint y tope que ya usa ml-sync). listing_type_id/
    // category_id sirven solo para la comisión calculada de las publicaciones
    // sin ventas en el período (ver lib/comision-real.ts); SELLER_SKU para el
    // respaldo de envío por SKU gemelo (ver lib/envio-medido.ts).
    const stockPorItem = new Map<string, { stock: number | null; full: boolean; listingTypeId: string; categoryId: string; sku: string | null }>();
    for (let i = 0; i < idsFilas.length; i += 20) {
      const chunk = idsFilas.slice(i, i + 20);
      const { data } = await mlGet<{ code: number; body: Record<string, unknown> }[]>(
        "/items",
        { ids: chunk.join(","), attributes: "id,available_quantity,variations,shipping,listing_type_id,category_id,attributes,seller_custom_field" }
      );
      for (const r of data) {
        if (r.code !== 200) continue;
        const id = String(r.body.id);
        const shipping = r.body.shipping as Record<string, unknown> | undefined;
        const attrs = (r.body.attributes as { id: string; value_name: string | null }[] | undefined) ?? [];
        const sku = attrs.find((a) => a.id === "SELLER_SKU")?.value_name ?? (r.body.seller_custom_field as string | null) ?? null;
        stockPorItem.set(id, {
          stock: resolveStockTabla(r.body),
          full: shipping?.logistic_type === "fulfillment",
          listingTypeId: String(r.body.listing_type_id ?? ""),
          categoryId: String(r.body.category_id ?? ""),
          sku,
        });
      }
    }

    // Costo/Precio manual — desde Sheets (Publicaciones!A:G), no desde ML:
    // Costo nunca viene de la API, es dato cargado a mano (ver Fase F).
    const costoPrecioPorItem = new Map<string, { costo: number | null; precio: number | null }>();
    const filasPublicaciones = await readSheet("Publicaciones!A2:G100000");
    for (const fila of filasPublicaciones) {
      if (!fila[0]) continue;
      const costo = fila[5] !== undefined && fila[5] !== "" ? Number(fila[5]) : null;
      const precio = fila[6] !== undefined && fila[6] !== "" ? Number(fila[6]) : null;
      costoPrecioPorItem.set(String(fila[0]), {
        costo: costo !== null && !Number.isNaN(costo) ? costo : null,
        precio: precio !== null && !Number.isNaN(precio) ? precio : null,
      });
    }

    // Envío por unidad: tarifa MEDIDA de la hoja TarifaEnvio (ver
    // lib/envio-medido.ts y lib/tarifa-envio.ts), con respaldo marcado como
    // "estimado". Ya no sale de la hoja Rentabilidad: esa estimación erraba
    // ~300% (mediana): con el Costo cargado habría marcado "Pierde" en 36 de
    // los 49 productos top evaluables, contra 9 con la tarifa y la comisión
    // reales (medido 2026-10-07). Si la hoja aún no existe, todo queda como
    // estimado/sin dato (nunca se rompe la tabla).
    const precioPorItem = new Map<string, number>();
    for (const [id, cp] of costoPrecioPorItem) if (cp.precio !== null && cp.precio > 0) precioPorItem.set(id, cp.precio);
    const skuPorItemEnvio = new Map<string, string>();
    const logisticoPorItemEnvio = new Map<string, string>();
    for (const [id, info] of stockPorItem) {
      if (info.sku) skuPorItemEnvio.set(id, info.sku);
      logisticoPorItemEnvio.set(id, info.full ? "fulfillment" : "otro");
    }
    const filasTarifaEnvio = await readSheet("TarifaEnvio!A2:L5000").catch(() => [] as string[][]);
    const ctxEnvio = armarContextoEnvio(parsearTarifasEnvio(filasTarifaEnvio), precioPorItem, skuPorItemEnvio, logisticoPorItemEnvio);

    // Comisión real por ítem: sale_fee de las órdenes del período; si no
    // hubo ventas, la calculadora oficial de ML (marcada "calculada"). Nunca
    // getComisionPct (aproxima por tipo de publicación y yerra ~2 puntos).
    const comisionAcc = new Map(Object.entries(ventas.comisionPorItem ?? {}));
    const comisionPorItem = new Map<string, ComisionResuelta>();
    await Promise.all(idsFilas.map(async (id) => {
      const info = stockPorItem.get(id);
      const precio = costoPrecioPorItem.get(id)?.precio ?? null;
      comisionPorItem.set(id, await resolverComision(id, comisionAcc, () =>
        info && precio ? pctComisionListingPrices(mlGet, { precio, listingTypeId: info.listingTypeId, categoryId: info.categoryId }) : Promise.resolve(null)
      ));
    }));

    const filasBase: Omit<FilaTablaProducto, "etiquetas">[] = idsFilas.map((id) => {
      const venta = ventas.ventasPorItem![id];
      const ad = adsPorItem.get(id);
      const visitas = visitasPorItem.get(id) ?? null;
      const stockInfo = stockPorItem.get(id);
      const cp = costoPrecioPorItem.get(id);
      const precio = cp?.precio ?? null;
      const costo = cp?.costo ?? null;
      // Precio (Publicaciones!G) y Costo (Publicaciones!F) son AMBOS brutos
      // (con IVA) — Costo pasó a ser MAYOR de Lista Defontana × Unidades,
      // decisión de Otto (2026-09-30). Se llevan ambos a neto antes de
      // comparar, mismo criterio que calcularFilaOrden en lib/rentabilidad.ts.
      const precioNeto = precio !== null ? precio / (1 + IVA) : null;
      const costoNeto = costo !== null ? costo / (1 + IVA) : null;

      // Costo máx. = costo neto máximo que se puede pagar por el producto
      // sin perder plata AL PRECIO ACTUAL de venta — despejando margen=0 de
      // la misma fórmula que usa calcularFilaOrden en lib/rentabilidad.ts:
      //   margenNeto = precioNeto - costoNeto - comisionNeta - envioNeto = 0
      //   => costoMax = precioNeto × (1 − comisión%) − envioNeto
      // Comisión y envío reales (ver arriba). Si falta cualquiera de los dos
      // NO se calcula nada (celdas vacías), en vez de asumir un valor.
      let costoMax: number | null = null;
      let costoMaxFuenteEnvio: "medido" | "estimado" | null = null;
      let precioEquilibrio: number | null = null;
      let pierde = false;
      let margenPct: number | null = null;
      const comision = comisionPorItem.get(id) ?? { pct: null, fuente: null };
      let envioPorUnidad: number | null = null;
      if (precio !== null && precioNeto !== null && stockInfo) {
        const envio = resolverEnvio(id, precio, stockInfo.full, stockInfo.sku, ctxEnvio);
        envioPorUnidad = envio.envio;
        if (comision.pct !== null && envio.envio !== null) {
          const envioNeto = envio.envio / (1 + IVA);
          costoMax = Math.round((precioNeto * (1 - comision.pct) - envioNeto) * 10) / 10;
          costoMaxFuenteEnvio = envio.fuente;
          // Precio de equilibrio y margen: solo con Costo cargado —
          //   precioNeto = (costoNeto + envioNeto) / (1 − comisión%)
          if (costoNeto !== null) {
            precioEquilibrio = Math.round(((costoNeto + envioNeto) / (1 - comision.pct)) * (1 + IVA));
            pierde = costoNeto > costoMax;
            // Margen de contribución antes de publicidad, % del precio neto.
            // Antes era (precio − costo)/precio, que ignoraba comisión y envío
            // e inflaba el margen (Plaisance: 25% contra 3,8% real).
            margenPct = calcularMargen(precio, costo, precio * comision.pct, envio.envio, 0).margenPct;
          }
        }
      }

      return {
        id,
        titulo: venta?.titulo ?? id,
        ventasMonto: venta?.monto ?? 0,
        ventasUnidades: venta?.unidades ?? 0,
        visitas,
        conversion: visitas !== null && visitas > 0 ? Math.round(((venta?.unidades ?? 0) / visitas) * 10000) / 100 : null,
        stock: stockInfo?.stock ?? null,
        full: stockInfo?.full ?? false,
        precio,
        costo,
        margenPct,
        costoMax,
        costoMaxFuenteEnvio,
        comisionPct: comision.pct !== null ? Math.round(comision.pct * 1000) / 1000 : null,
        comisionFuente: comision.fuente,
        envioPorUnidad,
        precioEquilibrio,
        pierde,
        campana: ad ? nombrePorCampana.get(ad.campaignId) ?? `Campaña ${ad.campaignId}` : null,
        campanaId: ad?.campaignId ?? null,
        statusAnuncio: ad?.status ?? null,
        clics: ad?.clicks ?? 0,
        impresiones: ad?.prints ?? 0,
        ctr: ad?.ctr ?? 0,
        cpc: ad?.cpc ?? 0,
        costoAds: ad?.cost ?? 0,
        acos: ad?.acos ?? 0,
        roas: ad?.roas ?? 0,
      };
    });

    // Mediana de conversión sobre filas CON visitas (>0) — una fila sin
    // visitas no tiene conversión calculable (ver arriba), incluirla como 0
    // sesgaría la mediana hacia abajo con un dato que no es "conversión
    // baja" sino "sin datos".
    const conversionesValidas = filasBase.map((f) => f.conversion).filter((c): c is number => c !== null);
    const medianaConversion = mediana(conversionesValidas);

    const dias = Math.max(1, Math.round((hasta.getTime() - desde.getTime()) / 86400000));

    const filas: FilaTablaProducto[] = filasBase.map((f) => {
      const etiquetas: EtiquetaProducto[] = [];
      const enCampanaActiva = f.statusAnuncio === "active";

      // Candidato: top ventas, no en campaña activa, stock Full suficiente,
      // conversión igual o por encima de la mediana de la tabla.
      if (
        topVentas.includes(f.id) &&
        !enCampanaActiva &&
        f.full &&
        (f.stock ?? 0) > 0 &&
        medianaConversion !== null &&
        f.conversion !== null &&
        f.conversion >= medianaConversion
      ) {
        etiquetas.push("Candidato");
      }

      // Revisar: en campaña con ACOS por encima de su target (con margen),
      // o con costo de ads > 0 y cero ventas atribuidas (plata gastada sin
      // retorno visible, más allá del ACOS calculado).
      const acosTarget = f.campanaId !== null ? acosTargetPorCampana.get(f.campanaId) : undefined;
      const acosExcedeTarget = acosTarget !== undefined && acosTarget > 0 && f.acos > acosTarget * ACOS_REVISAR_MARGEN_RELATIVO;
      const gastoSinVentas = f.costoAds > 0 && f.roas === 0;
      if (acosExcedeTarget || gastoSinVentas) {
        etiquetas.push("Revisar");
      }

      // Stock bajo: en campaña activa, con menos de STOCK_BAJO_DIAS_COBERTURA
      // días de cobertura al ritmo de ventas del período. Sin ventas en el
      // período no se puede estimar velocidad — no se etiqueta (ver comentario
      // de la constante).
      if (enCampanaActiva && f.stock !== null && f.ventasUnidades > 0) {
        const velocidadDiaria = f.ventasUnidades / dias;
        const diasCobertura = velocidadDiaria > 0 ? f.stock / velocidadDiaria : Infinity;
        if (diasCobertura < STOCK_BAJO_DIAS_COBERTURA) {
          etiquetas.push("Stock bajo");
        }
      }

      return { ...f, etiquetas };
    });

    return { ok: true, filas };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

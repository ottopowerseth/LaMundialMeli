import { NextRequest, NextResponse } from "next/server";
import axios from "axios";
import { readSheet } from "@/lib/sheets";
import { getValidAccessToken } from "@/lib/ml-token";
import { withMlRetry } from "@/lib/http-retry";
import { parsearTarifasEnvio } from "@/lib/envio-medido";
import { costoPorItemDesdeHoja, margenDesdeDatos } from "@/lib/tablero-margen-datos";
import { calcularPareto, calcularSerie } from "@/lib/tablero-series";
import { cargarItemsStock, cargarVentas, cargarVisitas, ventanaPorDias } from "@/lib/tablero-datos";
import { analizarStock, candidatosVisitas } from "@/lib/tablero-stock";
import type { ItemStock } from "@/lib/tablero-stock";
import { calcularConfianza, resumirVentas, variacion } from "@/lib/tablero-resumen";

// Tablero "desde arriba": un solo endpoint, calculado en vivo y sin hojas
// nuevas. Todas las secciones comparten los mismos datos — 120 días de órdenes
// (~6 s), un lote de atributos y 4 lecturas de hojas — así que no hace falta
// caché ni lotes (cabe holgado en los 60 s de Vercel).
//
// Query (todo opcional): dias (ventana principal, 1-120, default 30);
// desde/hasta (ISO) fijan la ventana exacta — sirve para verificar los totales
// contra Métricas con la misma ventana.
export const maxDuration = 60;

const DIAS_DEFAULT = 30;
const HISTORIA_DIAS = 120;
const DIA_MS = 86400000;

export async function GET(req: NextRequest) {
  try {
    const q = new URL(req.url).searchParams;
    const diasParam = Number(q.get("dias"));
    const dias = Number.isInteger(diasParam) && diasParam >= 1 && diasParam <= HISTORIA_DIAS ? diasParam : DIAS_DEFAULT;
    const ahora = new Date();

    let { desdeMs, hastaMs } = ventanaPorDias(dias, ahora);
    const d = Date.parse(q.get("desde") ?? ""), h = Date.parse(q.get("hasta") ?? "");
    if (!Number.isNaN(d) && !Number.isNaN(h) && h > d) { desdeMs = d; hastaMs = h; }
    const duracion = hastaMs - desdeMs;
    const anterior = { desdeMs: desdeMs - duracion, hastaMs: desdeMs };

    const token = await getValidAccessToken();
    const client = axios.create({ baseURL: "https://api.mercadolibre.com", headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });
    // Sin budget a propósito (ver revision-publicaciones): 3 intentos cubren 429.
    const mlGet = <T = unknown>(url: string) => withMlRetry(() => client.get<T>(url), { maxAttempts: 3 });

    // Desde hace 120 días (o desde donde empiece el período anterior, si es más
    // atrás) hasta el fin de la ventana.
    const historiaDesde = Math.min(anterior.desdeMs, hastaMs - HISTORIA_DIAS * DIA_MS);

    // Fase 1 (en paralelo): ventas, hojas y estado vigente de las publicaciones.
    const filasPub = await readSheet("Publicaciones!A2:S3000");
    const idsPublicaciones = filasPub.filter((r) => r[0] && ["active", "paused"].includes(r[10])).map((r) => String(r[0]));
    const yoP = mlGet<{ id: number }>("/users/me").then((r) => r.data);
    const [ventas, filasTarifa, filasOrigen, itemsMl] = await Promise.all([
      yoP.then((user) => cargarVentas(mlGet, user.id, historiaDesde, hastaMs)),
      readSheet("TarifaEnvio!A2:L5000").catch(() => [] as string[][]),
      readSheet("CostoOrigen!A2:J5000").catch(() => [] as string[][]),
      cargarItemsStock(mlGet, idsPublicaciones),
    ]);

    const costoPorItem = costoPorItemDesdeHoja(filasPub);
    const origenPorItem = new Map<string, string>();
    for (const r of filasOrigen) if (r[0]) origenPorItem.set(String(r[0]), r[2] ?? "");
    const tarifas = parsearTarifasEnvio(filasTarifa);

    // Publicaciones que vendieron en la ventana y no están entre las activas o
    // pausadas de la hoja (cerradas, inactivas o ya fuera de la hoja): se
    // consulta su estado real (1-2 llamadas) para no contarlas como "falta
    // Costo" cuando ya no se pueden completar ni vender.
    const vendidasEnVentana = new Set(ventas.lineas.filter((l) => l.ms >= desdeMs && l.ms < hastaMs).map((l) => l.item));
    const sinEstado = [...vendidasEnVentana].filter((id) => !itemsMl.has(id));
    const fueraDeAlcance = new Set<string>();
    for (const it of (await cargarItemsStock(mlGet, sinEstado)).values()) {
      if (it.estado === "closed" || it.estado === "inactive") fueraDeAlcance.add(it.id);
    }
    // Las de la hoja que no son activas/pausadas (p. ej. inactive) y ya traen su estado en la hoja.
    for (const r of filasPub) if (r[0] && ["closed", "inactive"].includes(r[10])) fueraDeAlcance.add(String(r[0]));

    const actual = resumirVentas(ventas.ordenes, ventas.lineas, desdeMs, hastaMs);
    const previo = resumirVentas(ventas.ordenes, ventas.lineas, anterior.desdeMs, anterior.hastaMs);
    const confianza = calcularConfianza({
      lineas: ventas.lineas.filter((l) => l.ms >= desdeMs && l.ms < hastaMs),
      costoPorItem, origenPorItem, tarifas, fueraDeAlcance,
    });

    // ---- Margen de contribución (ver lib/tablero-margen.ts) ----
    const fullPorItem = new Map<string, boolean>();
    for (const it of itemsMl.values()) fullPorItem.set(it.id, it.full);
    const margen = margenDesdeDatos({
      filasPub, fullPorItem, tarifas, costoPorItem, fueraDeAlcance,
      lineas: ventas.lineas.filter((l) => l.ms >= desdeMs && l.ms < hastaMs),
    });

    // ---- Pareto y series (ver lib/tablero-series.ts) ----
    // Las series terminan hoy aunque la ventana pedida llegue más allá (p. ej.
    // un mes calendario completo): los días futuros no son datos, y contarlos
    // daría semanas en cero con variación -100%.
    const finSeriesMs = Math.min(hastaMs, ventanaPorDias(1, ahora).hastaMs);
    const tendencias = {
      pareto: {
        ventana: calcularPareto(ventas.lineas, desdeMs, hastaMs),
        noventa: calcularPareto(ventas.lineas, hastaMs - 90 * DIA_MS, hastaMs),
      },
      semanas: calcularSerie(ventas.ordenes, ventas.lineas, "semana", 12, historiaDesde, finSeriesMs),
      meses: calcularSerie(ventas.ordenes, ventas.lineas, "mes", 5, historiaDesde, finSeriesMs),
      datosDesde: new Date(historiaDesde).toISOString(),
    };

    // ---- Stock y alerta de pausadas (ver lib/tablero-stock.ts) ----
    const ahoraMs = ahora.getTime();
    const itemsStock: ItemStock[] = [...itemsMl.values()].map((it) => ({
      id: it.id, titulo: it.titulo, estado: it.estado, subEstado: it.subEstado, stock: it.stock,
      full: it.full, costo: costoPorItem.get(it.id) ?? null, precio: it.precio,
    }));
    // Fase 2: visitas diarias (60 días: la ventana de 30 d y los 30 previos, para
    // la tasa de venta antes de una pausa) de las publicaciones relevantes.
    const candidatas = candidatosVisitas(itemsStock, ventas.lineas, desdeMs, hastaMs);
    const visitas = await cargarVisitas(mlGet, candidatas, 60);
    const stock = analizarStock({
      items: itemsStock, lineas: ventas.lineas.filter((l) => l.ms < hastaMs),
      desdeMs, hastaMs, ahoraMs: Math.min(ahoraMs, hastaMs), visitas,
    });

    return NextResponse.json({
      ok: true,
      generadoEn: new Date().toISOString(),
      ventana: { desde: new Date(desdeMs).toISOString(), hasta: new Date(hastaMs).toISOString(), dias: Math.round(duracion / DIA_MS) },
      resumen: {
        actual, anterior: previo,
        variaciones: {
          ingresos: variacion(actual.ingresos, previo.ingresos),
          unidades: variacion(actual.unidades, previo.unidades),
          ordenes: variacion(actual.ordenes, previo.ordenes),
          ticket: variacion(actual.ticket, previo.ticket),
        },
      },
      confianza,
      margen: { resumen: margen.resumen, filas: margen.filas },
      tendencias,
      stock: {
        resumen: stock.resumen,
        alerta: stock.alerta.map((a) => ({ ...a, tasaDiaria: Math.round(a.tasaDiaria), diasSinVender: Math.round(a.diasSinVender * 10) / 10, ingresoPerdido: Math.round(a.ingresoPerdido), ingreso30: Math.round(a.ingreso30) })),
        filas: stock.filas.map((f) => ({
          ...f, velocidad: Math.round(f.velocidad * 100) / 100, velocidadIngenua: Math.round(f.velocidadIngenua * 100) / 100,
          cobertura: f.cobertura === null ? null : Math.round(f.cobertura), coberturaIngenua: f.coberturaIngenua === null ? null : Math.round(f.coberturaIngenua),
          ingreso30: Math.round(f.ingreso30), ingreso90: Math.round(f.ingreso90),
        })),
        llamadas: { visitas: candidatas.length },
      },
    });
  } catch (error) {
    console.error("[tablero]", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

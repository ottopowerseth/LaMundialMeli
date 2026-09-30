import { NextResponse } from "next/server";
import axios from "axios";
import { ensureSheets, readSheet, appendSheet, writeSheet } from "@/lib/sheets";
import { getValidAccessToken } from "@/lib/ml-token";
import { createSyncBudget, withMlRetry, SyncRetryBudgetExceededError } from "@/lib/http-retry";
import { agruparPorOrdenReal, calcularFilaOrden, sumarAlmacenamiento, IVA, BillingDetailRow } from "@/lib/rentabilidad";
import { resolverEnvioReal, detectarMixto } from "@/lib/envio-real";

// Máximo permitido en el plan de Vercel (Hobby): 60s.
export const maxDuration = 60;

// La Billing API tiene rate limit de 5 requests/minuto (mucho más
// restrictivo que el resto de la API de ML, confirmado en la investigación
// de Auditoría) — con 13s de espera entre páginas, en una invocación de 45s
// alcanzan ~3 páginas (150 filas de cargo). Un mes completo (ej. 2489 filas
// en agosto) necesita múltiples invocaciones — mismo patrón idempotente que
// ya usa backfill-shipping: cada llamada retoma desde donde quedó y devuelve
// completo:false hasta terminar, para que el frontend la llame en loop.
const TIEMPO_MAXIMO_MS = 45000;
const ESPERA_ENTRE_PAGINAS_MS = 13000;
// Unidades y Envío por Unidad se agregan AL FINAL (N, O), no en medio, para
// no correr los índices de columnas que ya leen esta hoja por posición
// (ver metrics/route.ts, calcularTablaProductos) — mismo criterio que ya
// usa ml-sync para Publicaciones.
// Fuente Envío / Mixto (P, Q) se agregan AL FINAL — mismo criterio que
// Unidades/Envío por Unidad (N, O): no correr los índices de columnas que
// ya leen esta hoja por posición. Ver lib/envio-real.ts y
// docs/estado-metricas-y-pendientes.md, sección "Envío Full/xd_drop_off".
const HEADERS_RENTABILIDAD = [
  "ID Orden", "Fecha", "ID Item", "Producto", "Precio de Venta", "COGS Total",
  "Comisión", "Envío", "Pérdida/Devolución", "Margen Neto", "Margen %",
  "Multi-item", "Analizado", "Unidades", "Envío por Unidad",
  "Fuente Envío", "Mixto",
];

// Hoja de control de progreso — necesaria porque Almacenamiento (CFWA) es
// agregado y no tiene order_id para deduplicar como sí se hace con las
// órdenes (ver idsYaGuardados): sin persistir el offset alcanzado, cada
// invocación reprocesaría las páginas ya vistas y duplicaría el conteo de
// Almacenamiento. Una fila por mes, mismo patrón upsert que Auditoría.
const HEADERS_PROGRESO = ["Mes", "Offset", "Almacenamiento Acumulado", "Completo"];

async function leerProgreso(mes: string): Promise<{ offset: number; almacenamiento: number; fila: number | null }> {
  const rows = await readSheet("RentabilidadProgreso!A:D");
  const idx = rows.findIndex(r => r[0] === mes);
  if (idx < 0) return { offset: 0, almacenamiento: 0, fila: null };
  return { offset: Number(rows[idx][1]) || 0, almacenamiento: Number(rows[idx][2]) || 0, fila: idx + 1 };
}

async function guardarProgreso(mes: string, offset: number, almacenamiento: number, completo: boolean, filaExistente: number | null) {
  const fila = [mes, String(offset), String(almacenamiento), completo ? "Sí" : ""];
  if (filaExistente !== null) {
    await writeSheet(`RentabilidadProgreso!A${filaExistente}:D${filaExistente}`, [fila]);
  } else {
    const existingHeaders = await readSheet("RentabilidadProgreso!A1:A1");
    if (!existingHeaders.length || !existingHeaders[0]?.length) {
      await appendSheet("RentabilidadProgreso!A1", [HEADERS_PROGRESO]);
    }
    await appendSheet("RentabilidadProgreso!A:D", [fila]);
  }
}

export async function POST(request: Request) {
  try {
    const { mes } = await request.json();
    if (!mes || typeof mes !== "string") {
      return NextResponse.json({ ok: false, error: "Falta el parámetro mes (YYYY-MM)" }, { status: 400 });
    }

    await ensureSheets(["Rentabilidad", "RentabilidadProgreso", "ShippingCache"]);

    const token = await getValidAccessToken();
    const client = axios.create({
      baseURL: "https://api.mercadolibre.com",
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    });
    const budget = createSyncBudget();
    const mlGet = <T = unknown>(url: string, params?: Record<string, unknown>) =>
      withMlRetry(() => client.get<T>(url, { params, headers: { "Api-Version": "1", "Content-Type": "application/json" } }), { budget });
    // resolverEnvioReal espera un mlGet sin params (siempre rutas completas)
    // — mismo cliente, firma más simple porque acá no hay query params.
    const mlGetSimple = <T = unknown>(url: string) => mlGet<T>(url);

    // Órdenes ya guardadas — para no re-consultar Billing por lo ya calculado.
    const existentes = await readSheet("Rentabilidad!A2:A100000");
    const idsYaGuardados = new Set(existentes.map(r => String(r[0]).replace(/^'/, "")).filter(Boolean));

    // ShippingCache ampliado (ver lib/envio-real.ts): columnas E-H nuevas
    // (Costo Total Despacho, Unidades Despacho, Unidades Esta Orden, Fuente
    // Envío) — A-D (Orden/Shipping ID/Logistic Type/Fecha) ya existían.
    // Sirve para (1) no volver a resolver el envío de una orden ya
    // cacheada por ml-sync/backfill-shipping, y (2) construir
    // tarifasConocidas para la alarma de despacho mixto.
    const cacheRows = await readSheet("ShippingCache!A2:H100000");
    const envioCachePorOrden = new Map<string, {
      shippingId: string; logisticType: string;
      costoTotalDespacho: number | null; unidadesDespacho: number | null;
      unidadesEstaOrden: number | null; fuente: "costs" | "billing" | null;
    }>();
    for (const r of cacheRows) {
      if (!r[0]) continue;
      envioCachePorOrden.set(String(r[0]).replace(/^'/, ""), {
        shippingId: r[1] ?? "",
        logisticType: r[2] ?? "",
        costoTotalDespacho: r[4] !== undefined && r[4] !== "" ? Number(r[4]) : null,
        unidadesDespacho: r[5] !== undefined && r[5] !== "" ? Number(r[5]) : null,
        unidadesEstaOrden: r[6] !== undefined && r[6] !== "" ? Number(r[6]) : null,
        fuente: r[7] === "costs" || r[7] === "billing" ? r[7] : null,
      });
    }
    // Tarifa por unidad conocida de un ítem = envío por unidad de un
    // despacho donde ESE ítem fue el único (unidadesDespacho ===
    // unidadesEstaOrden, sin mezcla con otra orden) — la fuente más
    // confiable para comparar contra despachos compartidos. Y shippingId ->
    // Map<itemId, unidades> de todas las órdenes ya vistas, para poder
    // detectar mixto sin una llamada extra cuando el shipment resuelto en
    // esta corrida ya fue visto por otra orden — una sola lectura de
    // Rentabilidad alimenta ambos mapas.
    const tarifasConocidas = new Map<string, number>();
    const itemsPorShipping = new Map<string, Map<string, number>>();
    {
      const filasRentExistentes = await readSheet("Rentabilidad!A2:O100000");
      for (const r of filasRentExistentes) {
        const ordenId = String(r[0]).replace(/^'/, "");
        const itemId = r[2];
        const unidades = Number(r[13]) || 1;
        const cache = envioCachePorOrden.get(ordenId);
        if (cache?.shippingId) {
          if (!itemsPorShipping.has(cache.shippingId)) itemsPorShipping.set(cache.shippingId, new Map());
          itemsPorShipping.get(cache.shippingId)!.set(itemId, unidades);
        }
        if (cache?.fuente === "costs" && cache.unidadesDespacho === cache.unidadesEstaOrden && cache.costoTotalDespacho !== null && cache.unidadesDespacho) {
          tarifasConocidas.set(itemId, cache.costoTotalDespacho / cache.unidadesDespacho);
        }
      }
    }
    const nuevasEntradasCache: string[][] = [];

    // COGS: Publicaciones!A (ID) → Publicaciones!F (Costo). Solo se agrega
    // al mapa si la celda de Costo tiene un valor real — una publicación que
    // existe en la hoja pero con Costo vacío NO debe tratarse como costo $0
    // (eso infla el margen falsamente), sino como "sin dato" — mismo caso
    // que un item_id que no aparece en Publicaciones en absoluto.
    const pubRows = await readSheet("Publicaciones!A2:F5000");
    const costoPorItemId = new Map<string, number>();
    for (const r of pubRows) {
      if (r[0] && r[5] !== undefined && r[5] !== null && r[5] !== "") {
        costoPorItemId.set(String(r[0]), Number(r[5]) || 0);
      }
    }

    const progreso = await leerProgreso(mes);
    const key = `${mes}-01`;
    const inicio = Date.now();
    let offset = progreso.offset;
    let almacenamientoAcumulado = progreso.almacenamiento;
    let completo = false;
    let filasProcesadas = 0;
    let ordenesNuevas = 0;
    let multiItemDetectadas = 0;
    const filasParaEscribir: string[][] = [];

    try {
      while (true) {
        if (Date.now() - inicio > TIEMPO_MAXIMO_MS) break;

        const { data } = await mlGet<{ results: BillingDetailRow[]; total: number }>(
          `/billing/integration/periods/key/${key}/group/ML/details`,
          { document_type: "BILL", limit: 50, offset }
        );
        filasProcesadas += data.results?.length ?? 0;
        almacenamientoAcumulado += sumarAlmacenamiento(data.results ?? []);

        const porOrden = agruparPorOrdenReal(data.results ?? []);
        for (const [ordenId, filas] of porOrden) {
          if (idsYaGuardados.has(ordenId)) continue;
          const fila = calcularFilaOrden(ordenId, filas, costoPorItemId);
          if (fila.multiItem) multiItemDetectadas++;
          idsYaGuardados.add(ordenId); // evita reprocesar la misma orden si aparece en más de una página
          ordenesNuevas++;

          // Envío real (ver lib/envio-real.ts): reemplaza el envío de
          // Billing (envio/envioPorUnidad de calcularFilaOrden) cuando
          // /shipments/{id}/costs responde. Si la orden ya está en
          // ShippingCache con fuente "costs", se reusa sin llamada nueva.
          let fuenteEnvio: "costs" | "billing" = "billing";
          let mixto: "mixto" | "mixto_sin_tarifa" | null = null;
          let shippingIdDeEstaOrden: string | null = null;
          if (!fila.multiItem) {
            const cacheado = envioCachePorOrden.get(ordenId);
            let costoTotalDespacho: number | null = null;
            let unidadesDespacho: number | null = null;
            let unidadesEstaOrden = fila.unidades;

            if (cacheado?.fuente === "costs" && cacheado.costoTotalDespacho !== null && cacheado.unidadesDespacho !== null) {
              costoTotalDespacho = cacheado.costoTotalDespacho;
              unidadesDespacho = cacheado.unidadesDespacho;
              unidadesEstaOrden = cacheado.unidadesEstaOrden ?? fila.unidades;
              shippingIdDeEstaOrden = cacheado.shippingId;
              fuenteEnvio = "costs";
            } else if (!cacheado) {
              const resultado = await resolverEnvioReal(ordenId, mlGetSimple);
              shippingIdDeEstaOrden = resultado.shippingId;
              nuevasEntradasCache.push([
                `'${ordenId}`, `'${resultado.shippingId ?? ""}`, resultado.logisticType,
                new Date().toISOString(),
                resultado.costoTotalDespacho === null ? "" : String(resultado.costoTotalDespacho),
                resultado.unidadesDespacho === null ? "" : String(resultado.unidadesDespacho),
                String(resultado.unidadesEstaOrden),
                resultado.fuente,
              ]);
              if (resultado.fuente === "costs") {
                costoTotalDespacho = resultado.costoTotalDespacho;
                unidadesDespacho = resultado.unidadesDespacho;
                unidadesEstaOrden = resultado.unidadesEstaOrden;
                fuenteEnvio = "costs";
              }
            }
            // cacheado?.fuente === "billing": ya se intentó antes y falló
            // /shipments/{id}/costs — no reintentar, queda en "billing".

            if (fuenteEnvio === "costs" && costoTotalDespacho !== null && unidadesDespacho !== null) {
              fila.envio = Math.round(costoTotalDespacho * (unidadesEstaOrden / unidadesDespacho) * 10) / 10;
              fila.envioPorUnidad = Math.round((costoTotalDespacho / unidadesDespacho) * 10) / 10;
              if (fila.cogs !== null) {
                const precioVentaNeto = fila.precioVenta / (1 + IVA);
                fila.margenNeto = Math.round((precioVentaNeto - fila.cogs / (1 + IVA) - fila.comision / (1 + IVA) - fila.envio / (1 + IVA) - fila.perdida / (1 + IVA)) * 10) / 10;
                fila.margenPct = precioVentaNeto > 0 ? Math.round((fila.margenNeto / precioVentaNeto) * 1000) / 10 : null;
              }

              if (shippingIdDeEstaOrden) {
                if (!itemsPorShipping.has(shippingIdDeEstaOrden)) itemsPorShipping.set(shippingIdDeEstaOrden, new Map());
                itemsPorShipping.get(shippingIdDeEstaOrden)!.set(fila.idItem, unidadesEstaOrden);
                const itemsDelDespacho = itemsPorShipping.get(shippingIdDeEstaOrden)!;
                mixto = detectarMixto(costoTotalDespacho, itemsDelDespacho, tarifasConocidas);
                // Si el despacho tiene un solo ítem (sin pack compartido),
                // esta es una muestra confiable de su tarifa — alimenta
                // tarifasConocidas para detectar mixto en órdenes futuras
                // de ESTA MISMA corrida (no solo de corridas anteriores).
                if (unidadesDespacho === unidadesEstaOrden && itemsDelDespacho.size === 1) {
                  tarifasConocidas.set(fila.idItem, costoTotalDespacho / unidadesDespacho);
                }
              }
            }
          }

          filasParaEscribir.push([
            `'${fila.idOrden}`,
            fila.fecha,
            fila.idItem,
            fila.producto,
            String(fila.precioVenta),
            fila.cogs === null ? "" : String(fila.cogs),
            String(fila.comision),
            String(fila.envio),
            String(fila.perdida),
            fila.margenNeto === null ? "" : String(fila.margenNeto),
            fila.margenPct === null ? "" : String(fila.margenPct),
            fila.multiItem ? "Sí" : "",
            new Date().toLocaleString("es-CL"),
            String(fila.unidades),
            String(fila.envioPorUnidad),
            fuenteEnvio,
            mixto ?? "",
          ]);
        }

        offset += data.results?.length ?? 0;
        if (!data.results?.length || offset >= data.total) { completo = true; break; }
        if (Date.now() - inicio + ESPERA_ENTRE_PAGINAS_MS > TIEMPO_MAXIMO_MS) break; // no esperar si ya no alcanza para otra página
        await new Promise(r => setTimeout(r, ESPERA_ENTRE_PAGINAS_MS));
      }
    } catch (err) {
      if (!(err instanceof SyncRetryBudgetExceededError)) throw err;
      // Budget agotado: se corta acá, completo queda false para que el
      // frontend reintente — mismo patrón que backfill-shipping.
    }

    if (filasParaEscribir.length > 0) {
      const existingHeaders = await readSheet("Rentabilidad!A1:A1");
      if (!existingHeaders.length || !existingHeaders[0]?.length) {
        await appendSheet("Rentabilidad!A1", [HEADERS_RENTABILIDAD]);
      }
      await appendSheet("Rentabilidad!A:Q", filasParaEscribir);
    }

    if (nuevasEntradasCache.length > 0) {
      const existingCacheHeaders = await readSheet("ShippingCache!A1:A1");
      if (!existingCacheHeaders.length || !existingCacheHeaders[0]?.length) {
        await appendSheet("ShippingCache!A1", [[
          "ID Orden", "Shipping ID", "Logistic Type", "Fecha Consulta",
          "Costo Total Despacho", "Unidades Despacho", "Unidades Esta Orden", "Fuente",
        ]]);
      }
      await appendSheet("ShippingCache!A:H", nuevasEntradasCache);
    }

    await guardarProgreso(mes, offset, almacenamientoAcumulado, completo, progreso.fila);

    // Almacenamiento se escribe en Auditoría solo al completar el mes — un
    // valor parcial (mientras el mes sigue en progreso entre invocaciones)
    // sería engañoso si alguien lo mira a mitad de un backfill.
    if (completo) {
      const auditoriaRows = await readSheet("Auditoría!A:A");
      const filaAuditoria = auditoriaRows.findIndex(r => r[0] === mes);
      if (filaAuditoria >= 0) {
        const numeroFila = filaAuditoria + 1;
        await writeSheet(`Auditoría!Q${numeroFila}:Q${numeroFila}`, [[String(almacenamientoAcumulado)]]);
      }
      // Si no hay fila de Auditoría para este mes todavía, no se crea una
      // solo por Almacenamiento — Auditoría se genera desde su propio
      // endpoint (archivos subidos), no desde acá.
    }

    return NextResponse.json({
      ok: true,
      mes,
      completo,
      filasProcesadas,
      ordenesNuevas,
      multiItemDetectadas,
      almacenamientoAcumulado,
    });
  } catch (error) {
    console.error("[rentabilidad/analyze]", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

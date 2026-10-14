import { NextResponse } from "next/server";
import axios from "axios";
import { ensureSheets, readSheet, appendSheet, writeSheet } from "@/lib/sheets";
import { getValidAccessToken, instalarReintento401 } from "@/lib/ml-token";
import { createSyncBudget, withMlRetry, SyncRetryBudgetExceededError } from "@/lib/http-retry";
import { agruparPorOrdenReal, calcularFilaOrden, calcularMargen, sumarAlmacenamiento, BillingDetailRow } from "@/lib/rentabilidad";
import { resolverEnvioReal, detectarMixto } from "@/lib/envio-real";
import { agregarSinDuplicar } from "@/lib/backfill-shipping";
import { conLock } from "@/lib/lock-sheets";
import { logError } from "@/lib/log";

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
// Mes a analizar: AAAA-MM con mes 01-12 (la misma regla que audit/analyze). Forma la clave del lock («rentabilidad:AAAA-MM»).
const MES_VALIDO = /^\d{4}-(0[1-9]|1[0-2])$/;
// Reserva para liberar el lock al final de la invocación (~1 s, estimado); adquirirlo (~2,5 s medidos) se descuenta del tiempo disponible.
const RESERVA_LIBERAR_LOCK_MS = 1000;

// Lo que ve el usuario cuando el lock no se obtuvo (el cliente muestra `error` tal cual y corta el bucle de invocaciones). Lo ya
// procesado de este mes está guardado (el progreso se persiste por invocación), así que reintentar retoma desde donde quedó.
function mensajeLockRentabilidad(status: 409 | 503, mes: string): string {
  return status === 409
    ? `Ya hay otro análisis de Rentabilidad del mes ${mes} en curso (otra pestaña o un reintento). No se procesó ni se guardó nada en este intento; espera a que termine e inténtalo de nuevo.`
    : `No se pudo proteger la escritura de Rentabilidad del mes ${mes} (no se pudo verificar el bloqueo en la hoja Locks), así que no se procesó ni se guardó nada en este intento. Reintenta en un momento: lo ya procesado de este mes se conserva.`;
}
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

// Una invocación de análisis de un mes ya validado; corre dentro del lock «rentabilidad:{mes}».
async function analizarMes(mes: string, inicioRuta: number): Promise<NextResponse> {
  // Primera línea de la tarea: lo gastado hasta aquí es adquirir el lock. El lock (adquirir + liberar) consume tiempo de maxDuration: se
  // descuenta del presupuesto de reintentos y del tiempo de la invocación, para que el margen de escritura frente a los 60 s quede como
  // antes del lock (lo gastado en ensureSheets y el token NO se descuenta: ya estaba antes).
  const gastadoLockMs = Date.now() - inicioRuta + RESERVA_LIBERAR_LOCK_MS;
  await ensureSheets(["Rentabilidad", "RentabilidadProgreso", "ShippingCache"]);

  const token = await getValidAccessToken();
  const client = axios.create({
    baseURL: "https://api.mercadolibre.com",
    headers: { Authorization: `Bearer ${token}` },
    timeout: 15000,
  });
  instalarReintento401(client, token);
  const budget = createSyncBudget(2, Math.max(1000, 45000 - gastadoLockMs));
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
    const ordenId = String(r[0]).replace(/^'/, "");
    const fuente: "costs" | "billing" | null = r[7] === "costs" || r[7] === "billing" ? r[7] : null;
    const existente = envioCachePorOrden.get(ordenId);
    // Preferir la fila con fuente no vacía — ver mismo comentario en
    // rentabilidad/recalcular-envio/route.ts: ml-sync/backfill-shipping
    // pueden escribir una fila de 4 columnas DESPUÉS de una de 8 ya
    // resuelta; sin esto, la vieja/vacía pisaría a la buena.
    if (existente?.fuente && !fuente) continue;
    envioCachePorOrden.set(ordenId, {
      shippingId: r[1] ?? "",
      logisticType: r[2] ?? "",
      costoTotalDespacho: r[4] !== undefined && r[4] !== "" ? Number(r[4]) : null,
      unidadesDespacho: r[5] !== undefined && r[5] !== "" ? Number(r[5]) : null,
      unidadesEstaOrden: r[6] !== undefined && r[6] !== "" ? Number(r[6]) : null,
      fuente,
    });
  }
  // Tarifa por unidad conocida de un ítem = envío por unidad de un
  // despacho donde ESE ítem fue el único (unidadesDespacho ===
  // unidadesEstaOrden, sin mezcla con otra orden) — la fuente más
  // confiable para comparar contra despachos compartidos. Ver Commit 2
  // (rentabilidad/recalcular-envio o similar) para la pasada previa
  // dedicada que arma esto sobre TODO el histórico antes de marcar nada
  // — acá solo se arma con lo que ya hay en Rentabilidad al momento de
  // esta invocación, suficiente para órdenes nuevas de analyze.
  const tarifasConocidas = new Map<string, number>();
  {
    const filasRentExistentes = await readSheet("Rentabilidad!A2:O100000");
    for (const r of filasRentExistentes) {
      const ordenId = String(r[0]).replace(/^'/, "");
      const itemId = r[2];
      const cache = envioCachePorOrden.get(ordenId);
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
  const inicio = Date.now() - gastadoLockMs;
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
        let mixto: "mixto" | "mixto_tarifas" | "mixto_sin_tarifa" | null = null;
        if (!fila.multiItem) {
          const cacheado = envioCachePorOrden.get(ordenId);
          let costoTotalDespacho: number | null = null;
          let unidadesDespacho: number | null = null;
          let unidadesEstaOrden = fila.unidades;
          let logisticTypeDeEstaOrden = "";
          // itemsDelDespacho viene SIEMPRE de shipping_items[] de
          // /shipments/{id} (ver lib/envio-real.ts) — nunca de un
          // acumulador armado orden por orden, así que el resultado no
          // depende de qué orden hermana se procese primero.
          let itemsDelDespacho: Map<string, number> | null = null;

          if (cacheado?.fuente === "costs" && cacheado.costoTotalDespacho !== null && cacheado.unidadesDespacho !== null) {
            costoTotalDespacho = cacheado.costoTotalDespacho;
            unidadesDespacho = cacheado.unidadesDespacho;
            unidadesEstaOrden = cacheado.unidadesEstaOrden ?? fila.unidades;
            logisticTypeDeEstaOrden = cacheado.logisticType;
            fuenteEnvio = "costs";
            // El cache no persiste shipping_items completo — solo se
            // pide de nuevo (llamada liviana, sin /costs) si hay indicio
            // de pack compartido (unidadesDespacho > unidadesEstaOrden),
            // para no gastar una llamada extra en el caso común de 1
            // sola orden por despacho.
            if (cacheado.shippingId && unidadesDespacho > unidadesEstaOrden) {
              try {
                const { data: shipment } = await mlGetSimple<{ shipping_items?: { id?: string; quantity?: number }[] }>(`/shipments/${cacheado.shippingId}`);
                itemsDelDespacho = new Map();
                for (const it of shipment.shipping_items ?? []) {
                  if (it.id) itemsDelDespacho.set(it.id, (itemsDelDespacho.get(it.id) ?? 0) + (it.quantity ?? 0));
                }
              } catch { /* sin datos de items, mixto queda sin evaluar para esta fila */ }
            }
          } else if (!cacheado) {
            const resultado = await resolverEnvioReal(ordenId, mlGetSimple);
            logisticTypeDeEstaOrden = resultado.logisticType;
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
              itemsDelDespacho = resultado.itemsDelDespacho;
              fuenteEnvio = "costs";
            }
          }
          // cacheado?.fuente === "billing": ya se intentó antes y falló
          // /shipments/{id}/costs — no reintentar, queda en "billing".

          if (fuenteEnvio === "costs" && costoTotalDespacho !== null && unidadesDespacho !== null) {
            fila.envio = Math.round(costoTotalDespacho * (unidadesEstaOrden / unidadesDespacho) * 10) / 10;
            fila.envioPorUnidad = Math.round((costoTotalDespacho / unidadesDespacho) * 10) / 10;
            const { margenNeto, margenPct } = calcularMargen(fila.precioVenta, fila.cogs, fila.comision, fila.envio, fila.perdida);
            fila.margenNeto = margenNeto;
            fila.margenPct = margenPct;

            if (itemsDelDespacho) {
              mixto = detectarMixto(costoTotalDespacho, itemsDelDespacho, tarifasConocidas, logisticTypeDeEstaOrden);
            }
            // Despacho de un solo ítem (sin pack compartido) = muestra
            // confiable de su tarifa — alimenta tarifasConocidas para
            // detectar mixto en órdenes futuras de ESTA MISMA corrida.
            if (unidadesDespacho === unidadesEstaOrden) {
              tarifasConocidas.set(fila.idItem, costoTotalDespacho / unidadesDespacho);
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
      await appendSheet("Rentabilidad!A1", [HEADERS_RENTABILIDAD], { modo: "OVERWRITE" });
    }
    await appendSheet("Rentabilidad!A:Q", filasParaEscribir, { modo: "OVERWRITE" }); // Rentabilidad tiene formatos mixtos: modo anterior (C-14)
  }

  if (nuevasEntradasCache.length > 0) {
    const existingCacheHeaders = await readSheet("ShippingCache!A1:A1");
    if (!existingCacheHeaders.length || !existingCacheHeaders[0]?.length) {
      await appendSheet("ShippingCache!A1", [[
        "ID Orden", "Shipping ID", "Logistic Type", "Fecha Consulta",
        "Costo Total Despacho", "Unidades Despacho", "Unidades Esta Orden", "Fuente",
      ]], { modo: "OVERWRITE" });
    }
    // S-08: relee la columna A justo antes de agregar; solo escribe las órdenes que todavía no están (otra corrida pudo agregarlas).
    await agregarSinDuplicar((r) => readSheet(r), (filas) => appendSheet("ShippingCache!A:H", filas, { modo: "OVERWRITE" }), nuevasEntradasCache);
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
}

export async function POST(request: Request) {
  try {
    const { mes } = (await request.json().catch(() => ({}))) as { mes?: unknown };
    if (typeof mes !== "string" || !MES_VALIDO.test(mes)) {
      return NextResponse.json({ ok: false, error: "Mes inválido: debe tener el formato AAAA-MM (por ejemplo 2026-09). No se procesó ni se guardó nada." }, { status: 400 });
    }

    // Un análisis por mes a la vez (S-08): dos invocaciones del mismo mes agregarían las mismas órdenes y sumarían dos veces el
    // Almacenamiento. El lock es cooperativo; vence a los 90 s (maxDuration de esta ruta es 60 s). Meses distintos no se bloquean.
    const inicioRuta = Date.now();
    const r = await conLock(`rentabilidad:${mes}`, () => analizarMes(mes, inicioRuta));
    if (!r.ok) return NextResponse.json({ ok: false, error: mensajeLockRentabilidad(r.status, mes) }, { status: r.status });
    return r.valor;
  } catch (error) {
    logError("rentabilidad/analyze", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

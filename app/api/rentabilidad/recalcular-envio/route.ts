import { NextResponse } from "next/server";
import axios from "axios";
import { readSheet, batchWriteSheet, appendSheet } from "@/lib/sheets";
import { getValidAccessToken } from "@/lib/ml-token";
import { createSyncBudget, withMlRetry, SyncRetryBudgetExceededError } from "@/lib/http-retry";
import { calcularMargen } from "@/lib/rentabilidad";
import { detectarMixto } from "@/lib/envio-real";

// Recálculo del envío de las filas YA EXISTENTES de Rentabilidad con el fix
// de despacho compartido (ver lib/envio-real.ts y docs/estado-metricas-y-
// pendientes.md, sección "Envío Full/xd_drop_off", puntos g/h). No vuelve a
// pasar por la Billing API — usa /orders/{id} → /shipments/{id} →
// /shipments/{id}/costs directo, igual que rentabilidad/analyze para
// órdenes nuevas.
//
// Checkpoint por la propia columna "Fuente Envío" (P, índice 15) de
// Rentabilidad — no hace falta una hoja de progreso aparte: cada fila de
// Rentabilidad es la unidad de trabajo y su propio estado dice si ya se
// recalculó.
//   "" o "billing" (valor de antes de este fix): pendiente, se reprocesa.
//   "costs": ya tiene el envío real, se salta.
//   "billing_sin_costs": /shipments/{id}/costs falló en un intento
//     anterior — no se reintenta en bucle; solo con forzarReintentos:true.
export const maxDuration = 60;
const TIEMPO_MAXIMO_MS = 40000;

type FilaCache = {
  shippingId: string; logisticType: string;
  costoTotalDespacho: number | null; unidadesDespacho: number | null;
  unidadesEstaOrden: number | null; fuente: "costs" | "billing" | null;
};

type ResultadoFila = {
  fila: number; // número de fila real en Sheets (1-indexado, con header)
  envio: string;
  margenNeto: string;
  margenPct: string;
  envioPorUnidad: string;
  fuente: string;
  mixto: string;
};

function mediana(valores: number[]): number {
  const o = [...valores].sort((a, b) => a - b);
  const m = Math.floor(o.length / 2);
  return o.length % 2 !== 0 ? o[m] : (o[m - 1] + o[m]) / 2;
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const forzarReintentos = body?.forzarReintentos === true;
    const dryRun = body?.dryRun === true;

    const token = await getValidAccessToken();
    const client = axios.create({
      baseURL: "https://api.mercadolibre.com",
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    });
    const budget = createSyncBudget();
    const mlGet = <T = unknown>(url: string) =>
      withMlRetry(() => client.get<T>(url, { headers: { "Api-Version": "1", "Content-Type": "application/json" } }), { budget });

    const inicio = Date.now();

    // Rentabilidad completa, procesada de la fila más reciente (por fecha)
    // hacia atrás — prioriza el histórico reciente, el más usado hoy en
    // Métricas/Comparador.
    const filasRent = await readSheet("Rentabilidad!A2:Q100000");
    let indicesOrdenados = filasRent
      .map((_, i) => i)
      .sort((a, b) => new Date(filasRent[b][1]).getTime() - new Date(filasRent[a][1]).getTime());

    // dryRun: máximo 20 filas, SIN escribir nada — forzando las órdenes de
    // prueba pedidas explícitamente (3 hermanas de un pack + item_amount=2
    // + una billing_sin_costs) al frente de la selección si existen en la
    // hoja, para que el antes/después las incluya siempre.
    if (dryRun) {
      const idsForzados = new Set(["2000017565265218", "2000017565272130", "2000017565265220", "2000017999196484"]);
      const indicesForzados = indicesOrdenados.filter(i => idsForzados.has(String(filasRent[i][0]).replace(/^'/, "")));
      const resto = indicesOrdenados.filter(i => !idsForzados.has(String(filasRent[i][0]).replace(/^'/, "")));
      indicesOrdenados = [...indicesForzados, ...resto].slice(0, 20);
    }

    // ShippingCache: Map<ordenId, FilaCache>. appendSheet SIEMPRE agrega,
    // nunca actualiza una fila existente — confirmado 2026-10-01: cuando
    // ml-sync/backfill-shipping ya escribieron una fila de 4 columnas para
    // una orden y este endpoint agrega otra de 8, quedan 2 filas para el
    // mismo ID Orden. Como readSheet devuelve las filas en orden de
    // inserción y acá se itera con Map.set(), la fila más reciente (y más
    // completa) sobreescribe a la vieja sin deduplicar explícito.
    const cacheRows = await readSheet("ShippingCache!A2:H100000");
    const cachePorOrden = new Map<string, FilaCache>();
    for (const r of cacheRows) {
      if (!r[0]) continue;
      const ordenId = String(r[0]).replace(/^'/, "");
      const fuente: "costs" | "billing" | null = r[7] === "costs" || r[7] === "billing" ? r[7] : null;
      const existente = cachePorOrden.get(ordenId);
      // Preferir la fila con fuente no vacía — NO la última en orden de
      // inserción. ml-sync/backfill-shipping escriben filas de solo 4
      // columnas (sin fuente) que pueden llegar DESPUÉS de una fila de 8
      // columnas ya resuelta por este endpoint o por analyze; sin esta
      // preferencia, la fila vieja/vacía pisaría a la buena.
      if (existente?.fuente && !fuente) continue;
      cachePorOrden.set(ordenId, {
        shippingId: r[1] ?? "",
        logisticType: r[2] ?? "",
        costoTotalDespacho: r[4] !== undefined && r[4] !== "" ? Number(r[4]) : null,
        unidadesDespacho: r[5] !== undefined && r[5] !== "" ? Number(r[5]) : null,
        unidadesEstaOrden: r[6] !== undefined && r[6] !== "" ? Number(r[6]) : null,
        fuente,
      });
    }

    // Pasada previa de tarifasConocidas — SOLO despachos de un único ítem
    // (sin pack compartido), mediana por ítem si hay más de una muestra.
    // Se arma ANTES de procesar ninguna fila para que la alarma de mixto
    // no dependa del orden de recorrido (decisión de Otto 2026-10-01).
    const muestrasPorItem = new Map<string, number[]>();
    for (const r of filasRent) {
      const ordenId = String(r[0]).replace(/^'/, "");
      const itemId = r[2];
      const cache = cachePorOrden.get(ordenId);
      if (cache?.fuente === "costs" && cache.unidadesDespacho !== null && cache.unidadesEstaOrden === cache.unidadesDespacho && cache.costoTotalDespacho !== null) {
        if (!muestrasPorItem.has(itemId)) muestrasPorItem.set(itemId, []);
        muestrasPorItem.get(itemId)!.push(cache.costoTotalDespacho / cache.unidadesDespacho);
      }
    }
    const tarifasConocidas = new Map<string, number>();
    for (const [itemId, muestras] of muestrasPorItem) {
      tarifasConocidas.set(itemId, mediana(muestras));
    }

    // Cache EN MEMORIA para esta invocación — las órdenes hermanas de un
    // mismo despacho comparten shippingId; si ya se pidió /shipments/{id}
    // (o /costs) para ese shippingId en esta misma corrida, no se repite.
    const shipmentCache = new Map<string, { itemsDelDespacho: Map<string, number>; logisticType: string }>();
    const costsCache = new Map<string, number | null>();

    let recalculadas = 0;
    let billingSinCosts = 0;
    let saltadas = 0;
    const conteoMixto = new Map<string, Map<string, number>>(); // tipo -> itemId -> cantidad
    const nuevasEntradasCache: string[][] = [];
    const resultados: ResultadoFila[] = [];
    const antesDespues: { ordenId: string; antes: ResultadoFila; despues: ResultadoFila }[] = [];
    let cortadoPorTiempo = false;

    for (const idx of indicesOrdenados) {
      if (Date.now() - inicio > TIEMPO_MAXIMO_MS) { cortadoPorTiempo = true; break; }

      const r = filasRent[idx];
      const ordenId = String(r[0]).replace(/^'/, "");
      const itemId = r[2];
      const fuenteActual = r[15] ?? ""; // columna P (índice 15)
      const antes: ResultadoFila = {
        fila: idx + 2, envio: r[7] ?? "", margenNeto: r[9] ?? "", margenPct: r[10] ?? "",
        envioPorUnidad: r[14] ?? "", fuente: fuenteActual, mixto: r[16] ?? "",
      };

      // En dryRun se ignora el checkpoint para poder mostrar el
      // antes/después real de una fila ya recalculada (ej. para re-probar
      // sobre datos ya corregidos) — nunca se escribe nada en dryRun de
      // todas formas, así que no hay riesgo de reprocesar en producción.
      if (!dryRun) {
        if (fuenteActual === "costs") { saltadas++; continue; }
        if (fuenteActual === "billing_sin_costs" && !forzarReintentos) { saltadas++; continue; }
      }

      const cacheado = cachePorOrden.get(ordenId);
      let costoTotalDespacho: number | null = null;
      let unidadesDespacho: number | null = null;
      let unidadesEstaOrden = Number(r[13]) || 1;
      let logisticType = "";
      let itemsDelDespacho: Map<string, number> | null = null;
      let shippingId: string | null = null;

      if (cacheado?.fuente === "costs" && cacheado.costoTotalDespacho !== null && cacheado.unidadesDespacho !== null) {
        costoTotalDespacho = cacheado.costoTotalDespacho;
        unidadesDespacho = cacheado.unidadesDespacho;
        unidadesEstaOrden = cacheado.unidadesEstaOrden ?? unidadesEstaOrden;
        logisticType = cacheado.logisticType;
        shippingId = cacheado.shippingId || null;
      } else if (cacheado?.fuente === "billing" && !forzarReintentos) {
        // ya se intentó en analyze/corridas previas y falló /costs —
        // tratar igual que billing_sin_costs, no reintentar en bucle.
        billingSinCosts++;
        const despues: ResultadoFila = { fila: idx + 2, envio: "", margenNeto: "", margenPct: "", envioPorUnidad: "", fuente: "billing_sin_costs", mixto: "" };
        resultados.push(despues);
        if (dryRun) antesDespues.push({ ordenId, antes, despues });
        continue;
      } else {
        try {
          const { data: orden } = await mlGet<{ shipping?: { id?: number }; order_items?: { quantity?: number }[] }>(`/orders/${ordenId}`);
          shippingId = orden.shipping?.id ? String(orden.shipping.id) : null;
          unidadesEstaOrden = orden.order_items?.[0]?.quantity ?? unidadesEstaOrden;

          if (shippingId) {
            if (shipmentCache.has(shippingId)) {
              const cached = shipmentCache.get(shippingId)!;
              itemsDelDespacho = cached.itemsDelDespacho;
              logisticType = cached.logisticType;
            } else {
              const { data: shipment } = await mlGet<{ logistic_type?: string; shipping_items?: { id?: string; quantity?: number }[] }>(`/shipments/${shippingId}`);
              logisticType = shipment.logistic_type ?? "";
              itemsDelDespacho = new Map();
              for (const it of shipment.shipping_items ?? []) {
                if (it.id) itemsDelDespacho.set(it.id, (itemsDelDespacho.get(it.id) ?? 0) + (it.quantity ?? 0));
              }
              shipmentCache.set(shippingId, { itemsDelDespacho, logisticType });
            }
            unidadesDespacho = [...itemsDelDespacho.values()].reduce((s, q) => s + q, 0) || unidadesEstaOrden;

            if (costsCache.has(shippingId)) {
              costoTotalDespacho = costsCache.get(shippingId)!;
            } else {
              const { data: costs } = await mlGet<{ senders?: { cost?: number }[] }>(`/shipments/${shippingId}/costs`);
              const cost = costs.senders?.[0]?.cost;
              // $0 se trata como "no resuelto", no como envío gratis real
              // — decisión de Otto 2026-10-01, consistente con el hallazgo
              // ya documentado de que un $0 suele ser dato incompleto de
              // la API, no un envío realmente gratuito (ver docs, sección
              // "Envío Full/xd_drop_off", punto h).
              costoTotalDespacho = cost !== undefined && cost > 0 ? cost : null;
              costsCache.set(shippingId, costoTotalDespacho);
            }
          }
        } catch {
          // error de red/API — queda sin resolver, se marca billing_sin_costs abajo.
        }

        nuevasEntradasCache.push([
          `'${ordenId}`, `'${shippingId ?? ""}`, logisticType,
          new Date().toISOString(),
          costoTotalDespacho === null ? "" : String(costoTotalDespacho),
          unidadesDespacho === null ? "" : String(unidadesDespacho),
          String(unidadesEstaOrden),
          costoTotalDespacho !== null ? "costs" : "billing",
        ]);
      }

      // costoTotalDespacho === 0 no debería llegar acá (ya se descarta
      // arriba al leer /costs), pero se re-chequea por si vino de
      // ShippingCache con un $0 persistido de ANTES de esta decisión.
      if (costoTotalDespacho === null || costoTotalDespacho === 0 || unidadesDespacho === null) {
        billingSinCosts++;
        const despues: ResultadoFila = { fila: idx + 2, envio: "", margenNeto: "", margenPct: "", envioPorUnidad: "", fuente: "billing_sin_costs", mixto: "" };
        resultados.push(despues);
        if (dryRun) antesDespues.push({ ordenId, antes, despues });
        continue;
      }

      const envioOrden = Math.round(costoTotalDespacho * (unidadesEstaOrden / unidadesDespacho) * 10) / 10;
      const envioPorUnidad = Math.round((costoTotalDespacho / unidadesDespacho) * 10) / 10;

      const cogs = r[5] !== "" ? Number(r[5]) : null;
      const comision = Number(r[6]) || 0;
      const perdida = Number(r[8]) || 0;
      const precioVenta = Number(r[4]) || 0;
      const { margenNeto, margenPct } = calcularMargen(precioVenta, cogs, comision, envioOrden, perdida);

      let mixto: "mixto" | "mixto_tarifas" | "mixto_sin_tarifa" | null = null;
      if (itemsDelDespacho) {
        mixto = detectarMixto(costoTotalDespacho, itemsDelDespacho, tarifasConocidas, logisticType);
      }
      if (unidadesDespacho === unidadesEstaOrden) {
        tarifasConocidas.set(itemId, costoTotalDespacho / unidadesDespacho);
      }
      if (mixto) {
        if (!conteoMixto.has(mixto)) conteoMixto.set(mixto, new Map());
        const porItem = conteoMixto.get(mixto)!;
        porItem.set(itemId, (porItem.get(itemId) ?? 0) + 1);
      }

      const despues: ResultadoFila = {
        fila: idx + 2,
        envio: String(envioOrden),
        margenNeto: margenNeto === null ? "" : String(margenNeto),
        margenPct: margenPct === null ? "" : String(margenPct),
        envioPorUnidad: String(envioPorUnidad),
        fuente: "costs",
        mixto: mixto ?? "",
      };
      resultados.push(despues);
      if (dryRun) antesDespues.push({ ordenId, antes, despues });
      recalculadas++;
    }

    if (!dryRun) {
      if (nuevasEntradasCache.length > 0) {
        await appendSheet("ShippingCache!A:H", nuevasEntradasCache);
      }

      // Una sola llamada batchUpdate para todas las filas afectadas — cada
      // fila escribe hasta 3 rangos no contiguos (H envío; J:K margen;
      // O:Q envío por unidad/fuente/mixto), pero sigue siendo 1 llamada
      // HTTP para todo el lote, no 3 por fila.
      const updates = resultados.flatMap(({ fila, envio, margenNeto, margenPct, envioPorUnidad, fuente, mixto }) => {
        if (fuente === "billing_sin_costs") {
          return [{ range: `Rentabilidad!P${fila}:Q${fila}`, values: [[fuente, mixto]] }];
        }
        return [
          { range: `Rentabilidad!H${fila}:H${fila}`, values: [[envio]] },
          { range: `Rentabilidad!J${fila}:K${fila}`, values: [[margenNeto, margenPct]] },
          { range: `Rentabilidad!O${fila}:Q${fila}`, values: [[envioPorUnidad, fuente, mixto]] },
        ];
      });
      await batchWriteSheet(updates);
    }

    const mixtoResumen: Record<string, Record<string, number>> = {};
    for (const [tipo, porItem] of conteoMixto) {
      mixtoResumen[tipo] = Object.fromEntries(porItem);
    }

    return NextResponse.json({
      ok: true,
      dryRun,
      completo: !cortadoPorTiempo,
      recalculadas,
      billingSinCosts,
      antesDespues: dryRun ? antesDespues : undefined,
      saltadas,
      pendientes: indicesOrdenados.length - recalculadas - billingSinCosts - saltadas,
      mixto: mixtoResumen,
    });
  } catch (error) {
    if (error instanceof SyncRetryBudgetExceededError) {
      return NextResponse.json({ ok: false, error: "Budget agotado, reintentar" }, { status: 503 });
    }
    console.error("[rentabilidad/recalcular-envio]", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

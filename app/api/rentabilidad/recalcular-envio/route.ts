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
//
// DOS FASES separadas (rediseño 2026-10-01, ver docs): antes, la marca de
// "mixto" se asignaba en la misma pasada que resolvía el envío, así que
// tarifasConocidas se iba completando a medida que avanzaba el recorrido
// — dos filas del MISMO ítem podían recibir marcas distintas según cuál
// se procesara primero (la primera veía tarifasConocidas incompleto, la
// segunda ya con su propio ítem adentro). Ahora: (1) se resuelven TODOS
// los despachos de la selección sin marcar nada, (2) se arma
// tarifasConocidas con lo resuelto en esta corrida + ShippingCache ya
// existente, (3) recién ahí se asignan las marcas a todas las filas —
// mismo ítem, misma marca, salvo que su despacho sea realmente mixto.
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

type Resuelta = {
  idx: number;
  ordenId: string;
  itemId: string;
  costoTotalDespacho: number;
  unidadesDespacho: number;
  unidadesEstaOrden: number;
  logisticType: string;
  itemsDelDespacho: Map<string, number> | null;
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
    const dryRunLimite = Number.isInteger(body?.dryRunLimite) && body.dryRunLimite > 0 ? body.dryRunLimite : 20;
    // omitirMarca: no escribe la columna Q (Mixto) en esta tanda — decisión
    // de Otto 2026-10-02: las marcas dependen de tarifasConocidas, que
    // recién queda completo cuando TODO el histórico está resuelto (ver
    // punto 2, pasada final de marcas); escribirlas tanda por tanda daría
    // marcas distintas entre tandas para el mismo despacho.
    const omitirMarca = body?.omitirMarca === true;
    // limite: tope de filas PENDIENTES a procesar en la corrida real (no
    // dryRun) — igual que dryRunLimite pero para la escritura real.
    const limite = Number.isInteger(body?.limite) && body.limite > 0 ? body.limite : null;

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

    // dryRun: máximo dryRunLimite filas (default 20), SIN escribir nada —
    // forzando las órdenes de prueba pedidas explícitamente (3 hermanas de
    // un pack + item_amount=2 + una billing_sin_costs) al frente de la
    // selección si existen en la hoja, para que el antes/después las
    // incluya siempre.
    if (dryRun) {
      const idsForzados = new Set(["2000017565265218", "2000017565272130", "2000017565265220", "2000017999196484"]);
      const indicesForzados = indicesOrdenados.filter(i => idsForzados.has(String(filasRent[i][0]).replace(/^'/, "")));
      const resto = indicesOrdenados.filter(i => !idsForzados.has(String(filasRent[i][0]).replace(/^'/, "")));
      indicesOrdenados = [...indicesForzados, ...resto].slice(0, dryRunLimite);
    } else if (limite !== null) {
      // Tope de filas a procesar en esta corrida real — igual criterio que
      // el checkpoint normal (se filtran las ya resueltas), pero cortando
      // la selección antes de entrar al loop en vez de confiar solo en
      // TIEMPO_MAXIMO_MS, para tandas deliberadamente chicas (ej. primera
      // tanda de 100 filas, revisar resultado antes de seguir).
      const pendientes = indicesOrdenados.filter(i => {
        const fuenteActual = filasRent[i][15] ?? "";
        if (fuenteActual === "costs") return false;
        if (fuenteActual === "billing_sin_costs" && !forzarReintentos) return false;
        return true;
      });
      indicesOrdenados = pendientes.slice(0, limite);
    }

    // ShippingCache: Map<ordenId, FilaCache>. appendSheet SIEMPRE agrega,
    // nunca actualiza una fila existente — confirmado 2026-10-01: cuando
    // ml-sync/backfill-shipping ya escribieron una fila de 4 columnas para
    // una orden y este endpoint agrega otra de 8, quedan 2 filas para el
    // mismo ID Orden. Se prefiere la fila con columna Fuente no vacía, no
    // la última en orden de inserción — una fila de 4 columnas (sin
    // fuente) que llega después de una de 8 ya resuelta no debe pisarla.
    const cacheRows = await readSheet("ShippingCache!A2:H100000");
    const cachePorOrden = new Map<string, FilaCache>();
    for (const r of cacheRows) {
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
      });
    }

    // Cache EN MEMORIA para esta invocación — las órdenes hermanas de un
    // mismo despacho comparten shippingId; si ya se pidió /shipments/{id}
    // (o /costs) para ese shippingId en esta misma corrida, no se repite.
    const shipmentCache = new Map<string, { itemsDelDespacho: Map<string, number>; logisticType: string }>();
    const costsCache = new Map<string, number | null>();

    // ===== FASE 1: resolver TODOS los despachos de la selección, sin marcar nada =====
    let billingSinCosts = 0;
    let saltadas = 0;
    const nuevasEntradasCache: string[][] = [];
    const resueltas: Resuelta[] = [];
    const sinResolver: { idx: number; fila: number }[] = [];
    let cortadoPorTiempo = false;

    for (const idx of indicesOrdenados) {
      if (Date.now() - inicio > TIEMPO_MAXIMO_MS) { cortadoPorTiempo = true; break; }

      const r = filasRent[idx];
      const ordenId = String(r[0]).replace(/^'/, "");
      const itemId = r[2];
      const fuenteActual = r[15] ?? ""; // columna P (índice 15)

      // En dryRun se ignora el checkpoint para poder mostrar el
      // antes/después real de una fila ya recalculada — nunca se escribe
      // nada en dryRun de todas formas.
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
        sinResolver.push({ idx, fila: idx + 2 });
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
              // $0 se trata como "no resuelto", no como envío gratis real.
              costoTotalDespacho = cost !== undefined && cost > 0 ? cost : null;
              costsCache.set(shippingId, costoTotalDespacho);
            }
          }
        } catch {
          // error de red/API — queda sin resolver.
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

      if (costoTotalDespacho === null || costoTotalDespacho === 0 || unidadesDespacho === null) {
        billingSinCosts++;
        sinResolver.push({ idx, fila: idx + 2 });
        continue;
      }

      resueltas.push({ idx, ordenId, itemId, costoTotalDespacho, unidadesDespacho, unidadesEstaOrden, logisticType, itemsDelDespacho });
    }

    // ===== FASE 2: armar tarifasConocidas con TODO lo resuelto (esta corrida + ShippingCache) =====
    const muestrasPorItem = new Map<string, number[]>();
    for (const res of resueltas) {
      if (res.unidadesDespacho === res.unidadesEstaOrden) {
        if (!muestrasPorItem.has(res.itemId)) muestrasPorItem.set(res.itemId, []);
        muestrasPorItem.get(res.itemId)!.push(res.costoTotalDespacho / res.unidadesDespacho);
      }
    }
    // ShippingCache ya existente (órdenes fuera de esta selección, de
    // corridas anteriores de este endpoint o de analyze) — misma fuente
    // que antes, ahora sumada ANTES de marcar en vez de ir alimentándose
    // fila por fila dentro del propio loop de marcado.
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

    // ===== FASE 3: asignar marcas y calcular margen con tarifasConocidas ya completo =====
    let recalculadas = 0;
    const conteoMixto = new Map<string, Map<string, number>>(); // tipo -> itemId -> cantidad
    const resultados: ResultadoFila[] = [];
    const antesDespues: { ordenId: string; antes: ResultadoFila; despues: ResultadoFila }[] = [];

    const antesDeFila = (idx: number): ResultadoFila => {
      const r = filasRent[idx];
      return {
        fila: idx + 2, envio: r[7] ?? "", margenNeto: r[9] ?? "", margenPct: r[10] ?? "",
        envioPorUnidad: r[14] ?? "", fuente: r[15] ?? "", mixto: r[16] ?? "",
      };
    };

    for (const { idx, fila } of sinResolver) {
      const despues: ResultadoFila = { fila, envio: "", margenNeto: "", margenPct: "", envioPorUnidad: "", fuente: "billing_sin_costs", mixto: "" };
      resultados.push(despues);
      antesDespues.push({ ordenId: String(filasRent[idx][0]).replace(/^'/, ""), antes: antesDeFila(idx), despues });
    }

    for (const res of resueltas) {
      const r = filasRent[res.idx];
      const envioOrden = Math.round(res.costoTotalDespacho * (res.unidadesEstaOrden / res.unidadesDespacho) * 10) / 10;
      const envioPorUnidad = Math.round((res.costoTotalDespacho / res.unidadesDespacho) * 10) / 10;

      const cogs = r[5] !== "" ? Number(r[5]) : null;
      const comision = Number(r[6]) || 0;
      const perdida = Number(r[8]) || 0;
      const precioVenta = Number(r[4]) || 0;
      const { margenNeto, margenPct } = calcularMargen(precioVenta, cogs, comision, envioOrden, perdida);

      let mixto: "mixto" | "mixto_tarifas" | "mixto_sin_tarifa" | null = null;
      if (res.itemsDelDespacho) {
        mixto = detectarMixto(res.costoTotalDespacho, res.itemsDelDespacho, tarifasConocidas, res.logisticType);
      }
      if (mixto) {
        if (!conteoMixto.has(mixto)) conteoMixto.set(mixto, new Map());
        const porItem = conteoMixto.get(mixto)!;
        porItem.set(res.itemId, (porItem.get(res.itemId) ?? 0) + 1);
      }

      const despues: ResultadoFila = {
        fila: res.idx + 2,
        envio: String(envioOrden),
        margenNeto: margenNeto === null ? "" : String(margenNeto),
        margenPct: margenPct === null ? "" : String(margenPct),
        envioPorUnidad: String(envioPorUnidad),
        fuente: "costs",
        mixto: mixto ?? "",
      };
      resultados.push(despues);
      antesDespues.push({ ordenId: res.ordenId, antes: antesDeFila(res.idx), despues });
      recalculadas++;
    }

    if (!dryRun) {
      if (nuevasEntradasCache.length > 0) {
        await appendSheet("ShippingCache!A:H", nuevasEntradasCache);
      }

      // Una sola llamada batchUpdate para todas las filas afectadas. Si
      // omitirMarca, Q (Mixto) no se toca en absoluto — ni se limpia ni
      // se escribe — se deja para la pasada final dedicada (ver punto 2,
      // diseño pendiente) que arma tarifasConocidas sobre el histórico ya
      // completo, no tanda por tanda.
      const updates = resultados.flatMap(({ fila, envio, margenNeto, margenPct, envioPorUnidad, fuente, mixto }) => {
        if (fuente === "billing_sin_costs") {
          return omitirMarca
            ? [{ range: `Rentabilidad!P${fila}:P${fila}`, values: [[fuente]] }]
            : [{ range: `Rentabilidad!P${fila}:Q${fila}`, values: [[fuente, mixto]] }];
        }
        const base = [
          { range: `Rentabilidad!H${fila}:H${fila}`, values: [[envio]] },
          { range: `Rentabilidad!J${fila}:K${fila}`, values: [[margenNeto, margenPct]] },
        ];
        return omitirMarca
          ? [...base, { range: `Rentabilidad!O${fila}:P${fila}`, values: [[envioPorUnidad, fuente]] }]
          : [...base, { range: `Rentabilidad!O${fila}:Q${fila}`, values: [[envioPorUnidad, fuente, mixto]] }];
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
      antesDespues: dryRun ? antesDespues : antesDespues.slice(0, 5),
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

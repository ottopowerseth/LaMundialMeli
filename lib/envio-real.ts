// Envío real por orden vía /shipments/{id}/costs — reemplaza la
// dependencia de Billing API para el monto de envío. Ver
// docs/estado-metricas-y-pendientes.md, sección "Envío Full/xd_drop_off",
// puntos (g)/(h): Billing reporta el costo TOTAL del despacho, y cuando
// varias órdenes comparten pack_id/despacho, cada una se llevaba el total
// por separado (sobre-contabilización de Nx). Acá se reparte
// proporcional a unidades: envioDeEstaOrden = costoTotal × (unidades de
// esta orden / unidades totales del despacho).

export type MlGet = <T = unknown>(url: string) => Promise<{ data: T }>;

type Order = {
  shipping?: { id?: number };
  order_items?: { quantity?: number }[];
};
// shipping_items[].id es el item_id (ej. "MLC2019973333"), NO
// shipping_items[].item_id — confirmado contra la API real 2026-09-30.
// order_id existe en el tipo pero no se usa: no está presente en la
// práctica (verificado, siempre undefined en los shipments de despacho
// compartido probados).
type ShipmentItem = { id?: string; order_id?: number; quantity?: number };
type Shipment = { logistic_type?: string; shipping_items?: ShipmentItem[] };
type ShipmentCosts = { senders?: { cost?: number }[] };

export type EnvioRealResultado = {
  logisticType: string;
  shippingId: string | null;
  costoTotalDespacho: number | null;
  unidadesDespacho: number | null;
  unidadesEstaOrden: number;
  envioOrden: number | null; // costoTotalDespacho × unidadesEstaOrden / unidadesDespacho
  envioPorUnidad: number | null; // costoTotalDespacho / unidadesDespacho
  fuente: "costs" | "billing"; // "billing": /shipments/{id}/costs falló, el caller debe usar el envío de Billing como respaldo
  // Ítems y unidades REALES del despacho completo, tal como los devuelve
  // /shipments/{id} — fuente para detectarMixto (ver comentario ahí:
  // shipping_items[] no trae order_id en la práctica, así que esto es
  // independiente del orden en que se procesen las órdenes hermanas; no
  // depende de un acumulador que se arma orden por orden).
  itemsDelDespacho: Map<string, number> | null;
};

// Resuelve el envío real de UNA orden. No usa cache propio — el caller
// (rentabilidad/analyze) decide si ya tiene el dato en ShippingCache antes
// de llamar esto, igual que ya hacen ml-sync/backfill-shipping con
// logistic_type.
export async function resolverEnvioReal(ordenId: string, mlGet: MlGet): Promise<EnvioRealResultado> {
  try {
    const { data: orden } = await mlGet<Order>(`/orders/${ordenId}`);
    const shippingId = orden.shipping?.id;
    const unidadesEstaOrden = orden.order_items?.[0]?.quantity ?? 1;
    if (!shippingId) {
      return {
        logisticType: "", shippingId: null, costoTotalDespacho: null, unidadesDespacho: null,
        unidadesEstaOrden, envioOrden: null, envioPorUnidad: null, fuente: "billing", itemsDelDespacho: null,
      };
    }

    const { data: shipment } = await mlGet<Shipment>(`/shipments/${shippingId}`);
    const logisticType = shipment.logistic_type ?? "";
    // Ítems y unidades reales del despacho completo — shipping_items[].id
    // es el item_id (NO .item_id), confirmado contra la API real. No
    // depende de order_id (que no está presente en la práctica) ni del
    // orden en que se procesen las órdenes hermanas de un mismo pack.
    const itemsDelDespacho = new Map<string, number>();
    for (const it of shipment.shipping_items ?? []) {
      if (it.id) itemsDelDespacho.set(it.id, (itemsDelDespacho.get(it.id) ?? 0) + (it.quantity ?? 0));
    }
    const unidadesDespacho = [...itemsDelDespacho.values()].reduce((s, q) => s + q, 0) || unidadesEstaOrden;

    const { data: costs } = await mlGet<ShipmentCosts>(`/shipments/${shippingId}/costs`);
    const costoTotalDespacho = costs.senders?.[0]?.cost;
    if (costoTotalDespacho === undefined) {
      return {
        logisticType, shippingId: String(shippingId), costoTotalDespacho: null, unidadesDespacho,
        unidadesEstaOrden, envioOrden: null, envioPorUnidad: null, fuente: "billing", itemsDelDespacho,
      };
    }

    const envioPorUnidad = Math.round((costoTotalDespacho / unidadesDespacho) * 10) / 10;
    const envioOrden = Math.round(envioPorUnidad * unidadesEstaOrden * 10) / 10;

    return {
      logisticType, shippingId: String(shippingId), costoTotalDespacho, unidadesDespacho,
      unidadesEstaOrden, envioOrden, envioPorUnidad, fuente: "costs", itemsDelDespacho,
    };
  } catch {
    return {
      logisticType: "", shippingId: null, costoTotalDespacho: null, unidadesDespacho: null,
      unidadesEstaOrden: 1, envioOrden: null, envioPorUnidad: null, fuente: "billing", itemsDelDespacho: null,
    };
  }
}

// Alarma de despacho mixto (tarifas distintas por unidad entre los ítems
// de un mismo despacho) — ver decisión de Otto 2026-09-30: reparto
// proporcional a unidades, CON alarma para detectar cuándo esa
// simplificación no aplica. Verificado sobre 44 despachos compartidos
// reales (últimos 60 días): 0 mezclaban tarifas distintas — pero la
// alarma queda para detectar el caso si aparece.
//
// Solo se evalúa para despachos Full (logisticType === "fulfillment") —
// decisión de Otto 2026-09-30: en xd_drop_off el envío no tiene una
// tarifa fija por ítem (confirmado en investigaciones previas: varía por
// región/distancia real del despacho), así que comparar contra
// tarifasConocidas ahí no tendría sentido — daría falsos "mixto" todo el
// tiempo. Para xd_drop_off el caller no debe llamar esta función; se deja
// explícito acá para que un caller que sí la llame para xd_drop_off por
// error reciba null en vez de un falso positivo.
//
// tarifasConocidas: Map<itemId, tarifaPorUnidad> — mediana de despachos
// de ESE ítem solo (sin pack compartido), ya vista en ShippingCache.
// itemsDelDespacho: Map<itemId, unidadesDeEseItem> — todos los ítems
// distintos del despacho con sus unidades.
export function detectarMixto(
  costoTotalDespacho: number,
  itemsDelDespacho: Map<string, number>,
  tarifasConocidas: Map<string, number>,
  logisticType: string
): "mixto" | "mixto_tarifas" | "mixto_sin_tarifa" | null {
  if (logisticType !== "fulfillment") return null;

  const tarifasDelDespacho: number[] = [];
  let sumaEsperada = 0;
  for (const [itemId, unidades] of itemsDelDespacho) {
    const tarifa = tarifasConocidas.get(itemId);
    if (tarifa === undefined) return "mixto_sin_tarifa";
    tarifasDelDespacho.push(tarifa);
    sumaEsperada += tarifa * unidades;
  }

  // Tarifas distintas conocidas entre los ítems del despacho — se marca
  // AUNQUE el costo total cuadre con la suma (el reparto proporcional a
  // unidades seguiría siendo incorrecto para ítems de tarifa distinta,
  // aunque la suma total dé bien por coincidencia aritmética). Misma
  // tolerancia de $5 que el chequeo de suma — no precisión de $0,1, que
  // marcaría "mixto_tarifas" por simple ruido de redondeo entre dos
  // muestras del mismo ítem.
  const tarifaMin = Math.min(...tarifasDelDespacho);
  const tarifaMax = Math.max(...tarifasDelDespacho);
  if (tarifaMax - tarifaMin > 5) return "mixto_tarifas";

  // Tolerancia de $5 por redondeos de IVA/descuentos ya vistos en la API.
  if (Math.abs(costoTotalDespacho - sumaEsperada) > 5) return "mixto";
  return null;
}

export function mediana(valores: number[]): number {
  const o = [...valores].sort((a, b) => a - b);
  const m = Math.floor(o.length / 2);
  return o.length % 2 !== 0 ? o[m] : (o[m - 1] + o[m]) / 2;
}

// Serializa/deserializa la composición de un despacho (item -> unidades)
// para persistir en ShippingCache columna I ("Items Despacho") — solo se
// escribe cuando el despacho es compartido (más de 1 unidad total o más
// de 1 ítem distinto); un despacho de 1 sola orden con 1 solo ítem no la
// necesita, su composición ya se deduce de unidadesDespacho=unidadesEstaOrden.
export function serializarItemsDespacho(itemsDelDespacho: Map<string, number>): string {
  return JSON.stringify(Object.fromEntries(itemsDelDespacho));
}
export function deserializarItemsDespacho(json: string): Map<string, number> | null {
  if (!json) return null;
  try {
    const obj = JSON.parse(json);
    return new Map(Object.entries(obj).map(([k, v]) => [k, Number(v)]));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// procesarTanda — lógica central compartida entre rentabilidad/
// recalcular-envio (invocación manual, tanda por tanda) y rentabilidad/
// completar (orquestador que la llama en loop con condiciones de parada).
// Extraída 2026-10-02 para que ambos endpoints corran en el MISMO
// proceso — nunca vía fetch HTTP interno a sí mismo (sin precedente en
// este proyecto, y duplicaría cold starts/maxDuration sin necesidad).
// ---------------------------------------------------------------------

type FilaCacheTanda = {
  shippingId: string; logisticType: string;
  costoTotalDespacho: number | null; unidadesDespacho: number | null;
  unidadesEstaOrden: number | null; fuente: "costs" | "billing" | null;
  itemsDespachoJson: string;
};

export type ResultadoFilaTanda = {
  fila: number;
  envio: string; margenNeto: string; margenPct: string; envioPorUnidad: string;
  fuente: string; mixto: string;
};

export type ResultadoTanda = {
  completo: boolean;
  recalculadas: number;
  billingSinCosts: number;
  saltadas: number;
  pendientes: number;
  mixto: Record<string, Record<string, number>>;
  antesDespues: { ordenId: string; antes: ResultadoFilaTanda; despues: ResultadoFilaTanda }[];
  envioSubio: { ordenId: string; itemId: string; envioViejo: number; envioNuevo: number }[];
};

export type OpcionesTanda = {
  mlGet: MlGet;
  readSheet: (range: string) => Promise<string[][]>;
  appendSheet: (range: string, values: unknown[][]) => Promise<void>;
  batchWriteSheet: (updates: { range: string; values: unknown[][] }[]) => Promise<void>;
  calcularMargen: (precioVenta: number, cogs: number | null, comision: number, envio: number, perdida: number) => { margenNeto: number | null; margenPct: number | null };
  forzarReintentos: boolean;
  dryRun: boolean;
  dryRunLimite: number;
  omitirMarca: boolean;
  limite: number | null;
  tiempoMaximoMs: number;
};

export async function procesarTanda(opciones: OpcionesTanda): Promise<ResultadoTanda> {
  const { mlGet, readSheet, appendSheet, batchWriteSheet, calcularMargen, forzarReintentos, dryRun, dryRunLimite, omitirMarca, limite, tiempoMaximoMs } = opciones;
  const inicio = Date.now();

  const filasRent = await readSheet("Rentabilidad!A2:Q100000");
  let indicesOrdenados = filasRent
    .map((_, i) => i)
    .sort((a, b) => new Date(filasRent[b][1]).getTime() - new Date(filasRent[a][1]).getTime());

  if (dryRun) {
    const idsForzados = new Set(["2000017565265218", "2000017565272130", "2000017565265220", "2000017999196484"]);
    const indicesForzados = indicesOrdenados.filter(i => idsForzados.has(String(filasRent[i][0]).replace(/^'/, "")));
    const resto = indicesOrdenados.filter(i => !idsForzados.has(String(filasRent[i][0]).replace(/^'/, "")));
    indicesOrdenados = [...indicesForzados, ...resto].slice(0, dryRunLimite);
  } else if (limite !== null) {
    const pendientes = indicesOrdenados.filter(i => {
      const fuenteActual = filasRent[i][15] ?? "";
      if (fuenteActual === "costs") return false;
      if (fuenteActual === "billing_sin_costs" && !forzarReintentos) return false;
      return true;
    });
    indicesOrdenados = pendientes.slice(0, limite);
  }

  const cacheRows = await readSheet("ShippingCache!A2:I100000");
  const cachePorOrden = new Map<string, FilaCacheTanda>();
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
      itemsDespachoJson: r[8] ?? "",
    });
  }

  const shipmentCache = new Map<string, { itemsDelDespacho: Map<string, number>; logisticType: string }>();
  const costsCache = new Map<string, number | null>();

  let billingSinCosts = 0;
  let saltadas = 0;
  const nuevasEntradasCache: string[][] = [];
  type Resuelta = {
    idx: number; ordenId: string; itemId: string; costoTotalDespacho: number;
    unidadesDespacho: number; unidadesEstaOrden: number; logisticType: string;
    itemsDelDespacho: Map<string, number> | null;
  };
  const resueltas: Resuelta[] = [];
  const sinResolver: { idx: number; fila: number }[] = [];
  let cortadoPorTiempo = false;

  for (const idx of indicesOrdenados) {
    if (Date.now() - inicio > tiempoMaximoMs) { cortadoPorTiempo = true; break; }

    const r = filasRent[idx];
    const ordenId = String(r[0]).replace(/^'/, "");
    const itemId = r[2];
    const fuenteActual = r[15] ?? "";

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
            costoTotalDespacho = cost !== undefined && cost > 0 ? cost : null;
            costsCache.set(shippingId, costoTotalDespacho);
          }
        }
      } catch {
        // error de red/API — queda sin resolver.
      }

      const esDespachoCompartido = itemsDelDespacho !== null && (itemsDelDespacho.size > 1 || unidadesDespacho !== unidadesEstaOrden);
      nuevasEntradasCache.push([
        `'${ordenId}`, `'${shippingId ?? ""}`, logisticType,
        new Date().toISOString(),
        costoTotalDespacho === null ? "" : String(costoTotalDespacho),
        unidadesDespacho === null ? "" : String(unidadesDespacho),
        String(unidadesEstaOrden),
        costoTotalDespacho !== null ? "costs" : "billing",
        esDespachoCompartido && itemsDelDespacho ? serializarItemsDespacho(itemsDelDespacho) : "",
      ]);
    }

    if (costoTotalDespacho === null || costoTotalDespacho === 0 || unidadesDespacho === null) {
      billingSinCosts++;
      sinResolver.push({ idx, fila: idx + 2 });
      continue;
    }

    resueltas.push({ idx, ordenId, itemId, costoTotalDespacho, unidadesDespacho, unidadesEstaOrden, logisticType, itemsDelDespacho });
  }

  const muestrasPorItem = new Map<string, number[]>();
  for (const res of resueltas) {
    if (res.unidadesDespacho === res.unidadesEstaOrden) {
      if (!muestrasPorItem.has(res.itemId)) muestrasPorItem.set(res.itemId, []);
      muestrasPorItem.get(res.itemId)!.push(res.costoTotalDespacho / res.unidadesDespacho);
    }
  }
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

  let recalculadas = 0;
  const conteoMixto = new Map<string, Map<string, number>>();
  const resultados: ResultadoFilaTanda[] = [];
  const antesDespues: { ordenId: string; antes: ResultadoFilaTanda; despues: ResultadoFilaTanda }[] = [];
  const envioSubio: { ordenId: string; itemId: string; envioViejo: number; envioNuevo: number }[] = [];

  const antesDeFila = (idx: number): ResultadoFilaTanda => {
    const r = filasRent[idx];
    return {
      fila: idx + 2, envio: r[7] ?? "", margenNeto: r[9] ?? "", margenPct: r[10] ?? "",
      envioPorUnidad: r[14] ?? "", fuente: r[15] ?? "", mixto: r[16] ?? "",
    };
  };

  for (const { idx, fila } of sinResolver) {
    const despues: ResultadoFilaTanda = { fila, envio: "", margenNeto: "", margenPct: "", envioPorUnidad: "", fuente: "billing_sin_costs", mixto: "" };
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

    const despues: ResultadoFilaTanda = {
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

    const envioViejo = Number(r[7]);
    if (!Number.isNaN(envioViejo) && envioOrden > envioViejo) {
      envioSubio.push({ ordenId: res.ordenId, itemId: res.itemId, envioViejo, envioNuevo: envioOrden });
    }
  }

  if (!dryRun) {
    if (nuevasEntradasCache.length > 0) {
      await appendSheet("ShippingCache!A:I", nuevasEntradasCache);
    }

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

  return {
    completo: !cortadoPorTiempo,
    recalculadas,
    billingSinCosts,
    saltadas,
    pendientes: indicesOrdenados.length - recalculadas - billingSinCosts - saltadas,
    mixto: mixtoResumen,
    antesDespues,
    envioSubio,
  };
}

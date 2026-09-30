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
type ShipmentItem = { order_id?: number; quantity?: number };
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
        unidadesEstaOrden, envioOrden: null, envioPorUnidad: null, fuente: "billing",
      };
    }

    const { data: shipment } = await mlGet<Shipment>(`/shipments/${shippingId}`);
    const logisticType = shipment.logistic_type ?? "";
    // Unidades TOTALES del despacho — shipping_items[] no siempre trae
    // order_id (confirmado 2026-09-30, cayó siempre al fallback en la
    // prueba manual), así que unidadesEstaOrden viene de order_items, no
    // de buscar por order_id acá.
    const unidadesDespacho = (shipment.shipping_items ?? []).reduce((s, it) => s + (it.quantity ?? 0), 0) || unidadesEstaOrden;

    const { data: costs } = await mlGet<ShipmentCosts>(`/shipments/${shippingId}/costs`);
    const costoTotalDespacho = costs.senders?.[0]?.cost;
    if (costoTotalDespacho === undefined) {
      return {
        logisticType, shippingId: String(shippingId), costoTotalDespacho: null, unidadesDespacho,
        unidadesEstaOrden, envioOrden: null, envioPorUnidad: null, fuente: "billing",
      };
    }

    const envioPorUnidad = Math.round((costoTotalDespacho / unidadesDespacho) * 10) / 10;
    const envioOrden = Math.round(envioPorUnidad * unidadesEstaOrden * 10) / 10;

    return {
      logisticType, shippingId: String(shippingId), costoTotalDespacho, unidadesDespacho,
      unidadesEstaOrden, envioOrden, envioPorUnidad, fuente: "costs",
    };
  } catch {
    return {
      logisticType: "", shippingId: null, costoTotalDespacho: null, unidadesDespacho: null,
      unidadesEstaOrden: 1, envioOrden: null, envioPorUnidad: null, fuente: "billing",
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
// tarifasConocidas: Map<itemId, tarifaPorUnidad> — mediana de despachos
// de ESE ítem solo (sin pack compartido), ya vista en ShippingCache.
// itemsDelDespacho: Map<itemId, unidadesDeEseItem> — todos los ítems
// distintos del despacho con sus unidades.
export function detectarMixto(
  costoTotalDespacho: number,
  itemsDelDespacho: Map<string, number>,
  tarifasConocidas: Map<string, number>
): "mixto" | "mixto_sin_tarifa" | null {
  let sumaEsperada = 0;
  for (const [itemId, unidades] of itemsDelDespacho) {
    const tarifa = tarifasConocidas.get(itemId);
    if (tarifa === undefined) return "mixto_sin_tarifa";
    sumaEsperada += tarifa * unidades;
  }
  // Tolerancia de $5 por redondeos de IVA/descuentos ya vistos en la API.
  if (Math.abs(costoTotalDespacho - sumaEsperada) > 5) return "mixto";
  return null;
}

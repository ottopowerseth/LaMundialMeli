// Fase 1 de Rentabilidad por orden — ver docs/estado-metricas-y-pendientes.md,
// sección "Diseño de Rentabilidad por orden (Fase 1 y 2)".
//
// Bloque duro: Comisión + Envío efectivo + Pérdidas/devoluciones, vía la
// Billing API (group=ML, ya validada en Auditoría) + COGS cruzado contra
// Publicaciones!F. Ads atribuido queda para Fase 2 (no implementado acá).

export type FilaRentabilidad = {
  idOrden: string;
  fecha: string;
  idItem: string;
  producto: string;
  precioVenta: number;
  cogs: number | null; // null = sin match en Publicaciones
  comision: number;
  envio: number;
  perdida: number;
  margenNeto: number | null; // null si cogs es null (no se puede calcular)
  margenPct: number | null;
  multiItem: boolean; // ver detectarOrdenesPorItem — true = fila no calculada, solo detectada
};

type ChargeInfo = {
  detail_sub_type?: string;
  detail_amount?: number;
};
type SalesInfo = { order_id?: number; sale_date_time?: string; transaction_amount?: number };
type ItemInfo = { item_id?: string; item_title?: string; order_id?: number };
export type BillingDetailRow = {
  charge_info?: ChargeInfo;
  sales_info?: SalesInfo[];
  items_info?: ItemInfo[];
};

// Agrupa filas de la Billing API por orden REAL — usando el order_id propio
// de cada items_info[], no sales_info[0].order_id. Confirmado con datos
// reales (ver docs, hallazgo del 2026-08-24): un cargo CXD/CFF (envío) puede
// traer items_info[] con order_id de MÚLTIPLES órdenes distintas que
// comparten el mismo pack_id/envío (compras separadas agrupadas por ML en
// un despacho conjunto) — agrupar por sales_info[0].order_id da un falso
// positivo de "multi-item" (18.35% en la muestra real, cuando el volumen
// real confirmado es 0%).
export function agruparPorOrdenReal(rows: BillingDetailRow[]): Map<string, BillingDetailRow[]> {
  const porOrden = new Map<string, BillingDetailRow[]>();
  for (const row of rows) {
    const itemsInfo = row.items_info ?? [];
    if (itemsInfo.length === 0) continue; // sin items_info (ej. CFWA almacenamiento) — no va al detalle por orden
    // Agrupar la fila bajo CADA order_id distinto que aparezca en items_info,
    // no solo bajo sales_info[0].order_id — así un cargo de envío compartido
    // entre 2 órdenes reales queda visible en ambas, en vez de perderse o
    // mezclarse bajo un solo order_id incorrecto.
    const ordenIds = new Set(itemsInfo.map(it => it.order_id).filter((id): id is number => id !== undefined));
    for (const ordenId of ordenIds) {
      const key = String(ordenId);
      if (!porOrden.has(key)) porOrden.set(key, []);
      porOrden.get(key)!.push(row);
    }
  }
  return porOrden;
}

// Confirmado con datos reales (0 de 267 órdenes, ver docs): La Mundial no
// tiene volumen de órdenes multi-item hoy. Esta función detecta el caso de
// todas formas — si alguna vez aparece, no calcula un margen incorrecto
// tomando solo el primer producto: marca la fila y la excluye del cálculo.
function itemIdsDeLaOrden(filas: BillingDetailRow[], ordenId: string): Set<string> {
  const ids = new Set<string>();
  for (const fila of filas) {
    for (const it of fila.items_info ?? []) {
      if (String(it.order_id) === ordenId && it.item_id) ids.add(it.item_id);
    }
  }
  return ids;
}

function parseCLP(val: unknown): number {
  if (typeof val === "number") return Math.round(val);
  return 0;
}

// Calcula la fila de Rentabilidad para una orden a partir de sus filas de
// cargo ya agrupadas (ver agruparPorOrdenReal) y el mapa de COGS ya leído de
// Publicaciones. No hace ninguna llamada — es cálculo puro, testeable.
export function calcularFilaOrden(
  ordenId: string,
  filas: BillingDetailRow[],
  costoPorItemId: Map<string, number>
): FilaRentabilidad {
  const itemIds = itemIdsDeLaOrden(filas, ordenId);
  const multiItem = itemIds.size > 1;

  // sales_info y items_info correspondientes a ESTA orden específicamente
  // (una fila de cargo compartida por pack puede traer sales_info/items_info
  // de otra orden mezclados — filtrar por order_id, no tomar [0] a ciegas).
  let itemId = "";
  let producto = "";
  let precioVenta = 0;
  let fecha = "";
  for (const fila of filas) {
    const itemDeEstaOrden = (fila.items_info ?? []).find(it => String(it.order_id) === ordenId);
    if (itemDeEstaOrden && !itemId) {
      itemId = itemDeEstaOrden.item_id ?? "";
      producto = itemDeEstaOrden.item_title ?? "";
    }
    const saleDeEstaOrden = (fila.sales_info ?? []).find(s => String(s.order_id) === ordenId);
    if (saleDeEstaOrden && !precioVenta) {
      precioVenta = parseCLP(saleDeEstaOrden.transaction_amount);
      fecha = saleDeEstaOrden.sale_date_time ?? "";
    }
  }

  if (multiItem) {
    // No se calcula margen: mismo criterio que "COGS sin match" — mejor no
    // mostrar un número que "casi ninguna orden real hoy" en vez de un
    // número calculado sobre una asunción no verificada (items_info[0]).
    return {
      idOrden: ordenId, fecha, idItem: itemId, producto, precioVenta,
      cogs: null, comision: 0, envio: 0, perdida: 0,
      margenNeto: null, margenPct: null, multiItem: true,
    };
  }

  let comision = 0, envio = 0, perdida = 0;
  for (const fila of filas) {
    const sub = fila.charge_info?.detail_sub_type;
    const monto = Math.abs(fila.charge_info?.detail_amount ?? 0);
    if (sub === "CV") comision += monto;
    else if (sub === "CXD" || sub === "CFF") envio += monto;
    else if (sub === "CDSD") perdida += monto;
  }

  const cogs = costoPorItemId.has(itemId) ? costoPorItemId.get(itemId)! : null;
  // Redondeado a 1 decimal: sin esto, el arrastre de punto flotante (ej.
  // 8490-6350-1274-2449.3 = -1583.3000000000002) escribe un string largo que
  // Sheets, con USER_ENTERED, reinterpreta como un número gigante corrupto.
  const margenNeto = cogs !== null
    ? Math.round((precioVenta - cogs - comision - envio - perdida) * 10) / 10
    : null;
  const margenPct = margenNeto !== null && precioVenta > 0
    ? Math.round((margenNeto / precioVenta) * 1000) / 10
    : null;

  return {
    idOrden: ordenId, fecha, idItem: itemId, producto, precioVenta,
    cogs, comision, envio, perdida, margenNeto, margenPct, multiItem: false,
  };
}

// Suma de cargos CFWA (Almacenamiento Full) del período — agregado, sin
// order_id (ver diagnóstico del bloque blando). Se calcula aparte de las
// filas por orden porque no tiene sales_info/items_info para asociar.
export function sumarAlmacenamiento(rows: BillingDetailRow[]): number {
  let total = 0;
  for (const row of rows) {
    if (row.charge_info?.detail_sub_type === "CFWA") {
      total += Math.abs(row.charge_info.detail_amount ?? 0);
    }
  }
  return total;
}

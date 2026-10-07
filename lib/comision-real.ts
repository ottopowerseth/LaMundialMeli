// Comisión REAL de ML por publicación, como porcentaje del precio bruto.
//
// Reemplaza a getComisionPct (lib/rentabilidad.ts) en las pantallas de
// margen. Esa función aproxima la comisión SOLO por tipo de publicación (14%
// para gold_special), pero la comisión real también depende de la categoría:
// medido 2026-10-07 sobre 225 publicaciones con venta, difiere más de 1 punto
// en 218 y la mediana de (real − aproximada) es −2 puntos.
//
// Fuente 1 (la que manda): sale_fee de cada order_item de /orders/search,
// que es POR UNIDAD (la comisión de la línea es sale_fee × cantidad). Es la
// comisión efectivamente cobrada; coincide con el CV de la Billing API en el
// 98,3% de 1.020 órdenes y está en la misma base que el precio (bruto).
//
// Fuente 2 (solo si la publicación no tuvo ventas en el período): la
// calculadora oficial de ML, /sites/MLC/listing_prices (sale_fee_amount para
// precio × tipo de publicación × categoría). Reproduce el sale_fee de la
// orden en 33 de 40 casos; los 7 restantes eran órdenes anteriores a un
// cambio de tipo de publicación (cobradas 15-17%, hoy 11-13%), o sea que la
// calculadora refleja la tarifa VIGENTE. Es un número real de ML, pero no
// "cobrado": quien lo muestre debe marcarlo como "calculada".
export type AcumuladoComision = { ingreso: number; comision: number };

export function acumularComision(
  acc: Map<string, AcumuladoComision>,
  itemId: string,
  cantidad: number,
  precioUnitario: number,
  saleFee: unknown
): void {
  // sale_fee ausente no es comisión 0: la línea no aporta al cálculo.
  if (typeof saleFee !== "number" || !(precioUnitario > 0) || !(cantidad > 0)) return;
  const a = acc.get(itemId) ?? { ingreso: 0, comision: 0 };
  a.ingreso += cantidad * precioUnitario;
  a.comision += cantidad * saleFee;
  acc.set(itemId, a);
}

export function pctComisionDesdeVentas(a: AcumuladoComision | undefined): number | null {
  return a && a.ingreso > 0 ? a.comision / a.ingreso : null;
}

type MlGet = <T = unknown>(url: string) => Promise<{ data: T }>;

export async function pctComisionListingPrices(
  mlGet: MlGet,
  p: { precio: number; listingTypeId: string; categoryId: string }
): Promise<number | null> {
  if (!(p.precio > 0) || !p.listingTypeId || !p.categoryId) return null;
  try {
    const { data } = await mlGet<{ sale_fee_amount?: number } | { sale_fee_amount?: number }[]>(
      `/sites/MLC/listing_prices?price=${p.precio}&listing_type_id=${p.listingTypeId}&category_id=${p.categoryId}`
    );
    const fee = (Array.isArray(data) ? data[0] : data)?.sale_fee_amount;
    return typeof fee === "number" ? fee / p.precio : null;
  } catch {
    return null;
  }
}

export type ComisionResuelta = { pct: number | null; fuente: "orden" | "calculada" | null };

// Orden de prioridad: lo cobrado en las órdenes del período; si no hubo
// ventas, la calculadora oficial; si tampoco, sin dato (null) — nunca una
// tasa inventada.
export async function resolverComision(
  itemId: string,
  acumulado: Map<string, AcumuladoComision>,
  respaldo: () => Promise<number | null>
): Promise<ComisionResuelta> {
  const real = pctComisionDesdeVentas(acumulado.get(itemId));
  if (real !== null) return { pct: real, fuente: "orden" };
  const calculada = await respaldo();
  return calculada !== null ? { pct: calculada, fuente: "calculada" } : { pct: null, fuente: null };
}

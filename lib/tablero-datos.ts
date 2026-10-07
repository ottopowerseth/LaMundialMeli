// Carga de ventas para el Tablero. Una sola lectura de /orders/search sirve a
// todas las secciones (resumen, margen, Pareto y tendencias, stock): 120 días
// ≈ 5.000 órdenes en ~100 llamadas / ~6 s (medido 2026-10-07).
//
// Mismo criterio que Métricas para que los totales coincidan donde se
// solapan: filtro del servidor order.status=paid, ingresos = suma de
// total_amount por orden, unidades = suma de quantity de cada order_item.
// Los días son días UTC (igual que rangoFechas de metrics/route.ts).
//
// OJO con los bordes: el parámetro order.date_created.to de ML tiene
// granularidad de HORA (medido 2026-10-07: con to=00:00Z devuelve órdenes
// hasta las 00:57Z), así que una ventana pedida a la API arrastra hasta una
// hora del período siguiente. Por eso aquí se pide con holgura y SIEMPRE se
// filtra por el instante exacto (intervalos [desde, hasta)); la ventana
// "anterior" de Métricas, en cambio, cuenta esa hora en dos períodos.
import type { MlGet } from "@/lib/envio-real";

export type LineaVenta = {
  orden: string;
  ms: number; // date_created en ms
  item: string;
  titulo: string;
  cantidad: number;
  precio: number; // unit_price bruto
  fee: number | null; // sale_fee POR UNIDAD (null si la línea no lo trae)
};
export type OrdenVenta = { id: string; ms: number; total: number };
export type VentasCargadas = { lineas: LineaVenta[]; ordenes: OrdenVenta[]; desdeMs: number; hastaMs: number };

const DIA_MS = 86400000;

// Ventana de N días alineada a días UTC que INCLUYE hoy: termina a las 00:00
// UTC de mañana (igual que "semana" en Métricas).
export function ventanaPorDias(dias: number, ahora: Date = new Date()): { desdeMs: number; hastaMs: number } {
  const hastaMs = Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), ahora.getUTCDate() + 1);
  return { desdeMs: hastaMs - dias * DIA_MS, hastaMs };
}

type OrdenApi = {
  id: number;
  date_created: string;
  total_amount?: number;
  order_items?: { item: { id: string; title?: string }; quantity: number; unit_price: number; sale_fee?: number }[];
};

export async function cargarVentas(mlGet: MlGet, userId: string | number, desdeMs: number, hastaMs: number): Promise<VentasCargadas> {
  const url = (offset: number) =>
    `/orders/search?seller=${userId}&order.status=paid&order.date_created.from=${new Date(desdeMs).toISOString()}` +
    `&order.date_created.to=${new Date(hastaMs).toISOString()}&sort=date_desc&limit=50&offset=${offset}`;

  const primera = await mlGet<{ paging: { total: number }; results: OrdenApi[] }>(url(0));
  // La API rechaza offset >= 10.000.
  const total = Math.min(primera.data.paging.total, 9950);
  const offsets = Array.from({ length: Math.ceil(total / 50) }, (_, i) => i * 50);
  const crudas: OrdenApi[] = [...primera.data.results];
  let siguiente = 1;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (siguiente < offsets.length) {
      const off = offsets[siguiente++];
      const r = await mlGet<{ results: OrdenApi[] }>(url(off));
      crudas.push(...r.data.results);
    }
  }));

  // Deduplicar por id: con paginación por offset, una venta nueva que entra
  // mientras se descarga corre las páginas y repite una orden en el borde
  // (medido 2026-10-07: 4.742 filas, 4.741 únicas).
  const unicas = new Map<number, OrdenApi>();
  for (const o of crudas) unicas.set(o.id, o);

  const lineas: LineaVenta[] = [];
  const ordenes: OrdenVenta[] = [];
  for (const o of unicas.values()) {
    const ms = new Date(o.date_created).getTime();
    ordenes.push({ id: String(o.id), ms, total: Number(o.total_amount) || 0 });
    for (const it of o.order_items ?? []) {
      lineas.push({
        orden: String(o.id), ms, item: it.item.id, titulo: it.item.title ?? it.item.id,
        cantidad: Number(it.quantity) || 0, precio: Number(it.unit_price) || 0,
        fee: typeof it.sale_fee === "number" ? it.sale_fee : null,
      });
    }
  }
  return { lineas, ordenes, desdeMs, hastaMs };
}

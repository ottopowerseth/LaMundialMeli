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
  // logistic_type REAL de la orden (ShippingCache, ver lib/logistica.ts), crudo.
  // null = sin entrada; undefined = no se cargó. Solo lo lee el margen.
  logistic?: string | null;
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

// ---------------------------------------------------------------------
// Cargas para la sección de stock (ver lib/tablero-stock.ts).
// ---------------------------------------------------------------------
export type ItemMl = {
  id: string; titulo: string; estado: string; subEstado: string[];
  stock: number | null; full: boolean; inventoryId: string | null; precio: number;
};

async function enParalelo<T>(lista: T[], limite: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limite, lista.length) }, async () => {
    while (i < lista.length) await fn(lista[i++]);
  }));
}

// Estado vigente de las publicaciones: lotes de 20 con concurrencia 4 (~31
// llamadas para ~620 publicaciones). Stock = available_quantity o, si no
// viene, la suma de las variaciones (mismo criterio que ml-sync).
export async function cargarItemsStock(mlGet: MlGet, ids: string[]): Promise<Map<string, ItemMl>> {
  const out = new Map<string, ItemMl>();
  const lotes: string[][] = [];
  for (let i = 0; i < ids.length; i += 20) lotes.push(ids.slice(i, i + 20));
  await enParalelo(lotes, 4, async (lote) => {
    const { data } = await mlGet<{ code: number; body: Record<string, unknown> }[]>(
      `/items?ids=${lote.join(",")}&attributes=id,title,status,sub_status,available_quantity,variations,shipping,inventory_id,price`
    );
    for (const r of data) {
      if (r.code !== 200) continue;
      const b = r.body;
      let stock: number | null = typeof b.available_quantity === "number" ? b.available_quantity : null;
      if (stock === null && Array.isArray(b.variations) && b.variations.length > 0) {
        const qs = (b.variations as { available_quantity?: number }[]).map((v) => v.available_quantity).filter((q): q is number => typeof q === "number");
        if (qs.length > 0) stock = qs.reduce((s, q) => s + q, 0);
      }
      const shipping = b.shipping as { logistic_type?: string } | undefined;
      out.set(String(b.id), {
        id: String(b.id), titulo: String(b.title ?? b.id), estado: String(b.status ?? ""),
        subEstado: Array.isArray(b.sub_status) ? (b.sub_status as string[]) : [],
        stock, full: shipping?.logistic_type === "fulfillment",
        inventoryId: typeof b.inventory_id === "string" ? b.inventory_id : null, precio: Number(b.price) || 0,
      });
    }
  });
  return out;
}

// Visitas diarias de los últimos N días: los días con 0 visitas NO vienen en
// la serie (por eso "ausente" = 0). Concurrencia 6; ML limita las ráfagas
// (429), withMlRetry reintenta.
export async function cargarVisitas(mlGet: MlGet, ids: string[], dias: number): Promise<Map<string, Record<string, number>>> {
  const out = new Map<string, Record<string, number>>();
  await enParalelo(ids, 6, async (id) => {
    try {
      const { data } = await mlGet<{ results?: { date: string; total: number }[] }>(`/items/${id}/visits/time_window?last=${dias}&unit=day`);
      const m: Record<string, number> = {};
      for (const x of data.results ?? []) m[x.date.slice(0, 10)] = x.total;
      out.set(id, m);
    } catch { /* sin serie: esa publicación queda sin detección por visitas */ }
  });
  return out;
}

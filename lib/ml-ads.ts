// Ads por ítem (Product Ads) — extraído de metrics/route.ts para
// reutilizar entre la Tabla por producto y el Comparador vs Mayor, sin
// duplicar la paginación ni el filtrado client-side de campaign_id.

export const ROAS_METRICS_FIELDS = "clicks,prints,ctr,cost,cpc,acos,roas,organic_units_quantity,organic_units_amount,direct_amount,indirect_amount,total_amount";

export type AdPorItem = {
  campaignId: number;
  status: string;
  clicks: number;
  prints: number;
  ctr: number;
  cpc: number;
  cost: number;
  acos: number;
  roas: number;
};

export type Advertiser = { advertiser_id: number; site_id: string };

// Resuelve el advertiser de Product Ads de la cuenta — mismo criterio que
// userId con /users/me (ver metrics/route.ts): es un ID de cuenta, no se
// hardcodea. product_id=PADS es obligatorio en la query (sin él, 400
// explícito "product_id param not found in request", confirmado empíricamente).
export async function resolverAdvertiser(
  mlGet: <T = unknown>(url: string, params?: Record<string, unknown>, headers?: Record<string, string>) => Promise<{ data: T }>
): Promise<Advertiser | null> {
  const { data } = await mlGet<{ advertisers: Advertiser[] }>(
    "/advertising/advertisers",
    { product_id: "PADS" },
    { "Api-Version": "1" }
  );
  return data.advertisers?.[0] ?? null;
}

// Paginado completo, filtrando campaign_id client-side: confirmado
// empíricamente (2026-09-26) que el parámetro campaign_id en la query se
// ignora silenciosamente (mismo patrón que el filtro de fecha roto de
// Claims), así que no tiene sentido pedir por campaña — se trae todo una
// vez y se filtra en memoria por quien consuma el resultado.
export async function obtenerAdsPorItem(
  mlGet: <T = unknown>(url: string, params?: Record<string, unknown>, headers?: Record<string, string>) => Promise<{ data: T }>,
  advertiser: { advertiser_id: number; site_id: string },
  dateFrom: string,
  dateTo: string
): Promise<Map<string, AdPorItem>> {
  const adsPorItem = new Map<string, AdPorItem>();
  let offset = 0;
  while (offset <= 1000) {
    const { data } = await mlGet<{
      paging: { total: number };
      results: {
        item_id: string; campaign_id: number; status: string;
        metrics: { clicks: number; prints: number; ctr: number; cpc: number; cost: number; acos: number; roas: number };
      }[];
    }>(
      `/marketplace/advertising/${advertiser.site_id}/advertisers/${advertiser.advertiser_id}/product_ads/ads/search`,
      { date_from: dateFrom, date_to: dateTo, metrics: ROAS_METRICS_FIELDS, limit: 50, offset },
      { "Api-Version": "1" }
    );
    for (const ad of data.results ?? []) {
      adsPorItem.set(ad.item_id, {
        campaignId: ad.campaign_id,
        status: ad.status,
        clicks: ad.metrics?.clicks ?? 0,
        prints: ad.metrics?.prints ?? 0,
        ctr: ad.metrics?.ctr ?? 0,
        cpc: ad.metrics?.cpc ?? 0,
        cost: ad.metrics?.cost ?? 0,
        acos: ad.metrics?.acos ?? 0,
        roas: ad.metrics?.roas ?? 0,
      });
    }
    if (!data.results || data.results.length === 0 || offset + data.results.length >= data.paging.total) break;
    offset += 50;
  }
  return adsPorItem;
}

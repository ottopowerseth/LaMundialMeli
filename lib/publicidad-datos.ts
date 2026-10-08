// Carga de campañas y anuncios de Product Ads con las métricas de una ventana.
// Solo lectura. Se pide `direct_amount`/`indirect_amount` y las orgánicas por
// anuncio y por campaña (lib/ml-ads.ts las pide pero descarta las de cada ítem).
// Ver lib/publicidad-equilibrio.ts para la base de IVA del gasto.
import { ROAS_METRICS_FIELDS } from "@/lib/ml-ads";
import type { Advertiser } from "@/lib/ml-ads";
import type { AnuncioMl, CampanaMl } from "@/lib/publicidad-equilibrio";

export type MlGetParams = <T = unknown>(url: string, params?: Record<string, unknown>, headers?: Record<string, string>) => Promise<{ data: T }>;

const H = { "Api-Version": "1" };
type Metricas = {
  cost?: number; acos?: number; direct_amount?: number; indirect_amount?: number;
  organic_units_quantity?: number; organic_units_amount?: number;
};
const base = (a: Advertiser) => `/marketplace/advertising/${a.site_id}/advertisers/${a.advertiser_id}/product_ads`;

// dateFrom/dateTo: AAAA-MM-DD, ambos días incluidos.
export async function cargarCampanasMl(mlGet: MlGetParams, a: Advertiser, dateFrom: string, dateTo: string): Promise<CampanaMl[]> {
  const { data } = await mlGet<{
    results: { id: number; name: string; status: string; strategy: string; acos_target?: number; daily_budget?: number; budget?: number; metrics?: Metricas }[];
  }>(`${base(a)}/campaigns/search`, { date_from: dateFrom, date_to: dateTo, metrics: ROAS_METRICS_FIELDS }, { ...H, "Content-Type": "application/json" });
  return (data.results ?? []).map((c) => ({
    id: c.id, nombre: c.name, estado: c.status, estrategia: c.strategy, acosTarget: c.acos_target ?? null, presupuestoDiario: c.daily_budget ?? c.budget ?? null,
    costo: c.metrics?.cost ?? 0, directas: c.metrics?.direct_amount ?? 0, indirectas: c.metrics?.indirect_amount ?? 0,
    organicoMonto: c.metrics?.organic_units_amount ?? 0, organicoUnidades: c.metrics?.organic_units_quantity ?? 0, acosMl: c.metrics?.acos ?? null,
  }));
}

// Todos los anuncios de la cuenta (el filtro por campaña de la API se ignora:
// ver lib/ml-ads.ts). Primera página para saber el total; el resto de a 4.
export async function cargarAnunciosMl(mlGet: MlGetParams, a: Advertiser, dateFrom: string, dateTo: string): Promise<AnuncioMl[]> {
  type Pagina = { paging: { total: number }; results: { item_id: string; campaign_id: number; status: string; title?: string; metrics?: Metricas }[] };
  const pagina = (offset: number) => mlGet<Pagina>(`${base(a)}/ads/search`, { date_from: dateFrom, date_to: dateTo, metrics: ROAS_METRICS_FIELDS, limit: 50, offset }, H);
  const primera = (await pagina(0)).data;
  const resultados = [...(primera.results ?? [])];
  const offsets: number[] = [];
  for (let o = 50; o < Math.min(primera.paging?.total ?? 0, 1050); o += 50) offsets.push(o);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(4, offsets.length) }, async () => {
    while (i < offsets.length) resultados.push(...((await pagina(offsets[i++])).data.results ?? []));
  }));
  return resultados.map((x) => ({
    itemId: x.item_id, campaignId: x.campaign_id, estado: x.status, titulo: x.title ?? x.item_id,
    costo: x.metrics?.cost ?? 0, directas: x.metrics?.direct_amount ?? 0, indirectas: x.metrics?.indirect_amount ?? 0,
    organicoUnidades: x.metrics?.organic_units_quantity ?? 0, organicoMonto: x.metrics?.organic_units_amount ?? 0,
  }));
}

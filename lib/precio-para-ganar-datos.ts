// Carga de price_to_win (ML) y del tipo de publicación (catálogo o propia).
// Solo lectura. `/items/{id}/price_to_win` solo responde con datos útiles en
// publicaciones de catálogo activas; en el resto devuelve status "not_listed" con
// reason "item_not_opted_in". Medido 2026-10-08: ~210 consultas con 5 en paralelo
// tardan ~10 s, sin 429.
import type { MlGet } from "@/lib/envio-real";
import type { EstadoCatalogo, FactorMl, PriceToWinMl } from "@/lib/precio-para-ganar";

type Boost = { id?: string; description?: string; status?: string };
type RespuestaPtw = {
  item_id?: string; status?: string; current_price?: number | null; price_to_win?: number | null; visit_share?: string | null;
  competitors_sharing_first_place?: number | null; reason?: string[]; boosts?: Boost[] | null;
  winner?: { item_id?: string; price?: number; boosts?: Boost[] | null } | null;
};

const ESTADOS: EstadoCatalogo[] = ["competing", "winning", "sharing_first_place", "not_listed"];
const factores = (b: Boost[] | null | undefined): FactorMl[] =>
  (b ?? []).filter((x) => x.id).map((x) => ({ id: x.id as string, descripcion: x.description ?? (x.id as string), estado: x.status ?? "" }));

export function parsearPriceToWin(id: string, d: RespuestaPtw): PriceToWinMl {
  const status = ESTADOS.includes(d.status as EstadoCatalogo) ? (d.status as EstadoCatalogo) : "sin_dato";
  const w = d.winner;
  return {
    itemId: d.item_id ?? id, status, precioActual: typeof d.current_price === "number" ? d.current_price : null,
    precioParaGanar: typeof d.price_to_win === "number" ? d.price_to_win : null,
    visitShare: d.visit_share ?? null, competidoresCompartiendo: d.competitors_sharing_first_place ?? null, razones: d.reason ?? [],
    factores: factores(d.boosts),
    ganador: w && typeof w.price === "number" ? { itemId: w.item_id ?? "", precio: w.price, factores: factores(w.boosts) } : null,
  };
}

// Una consulta por publicación (no hay multiget). null = la consulta falló.
export async function cargarPriceToWin(mlGet: MlGet, ids: string[], concurrencia = 5): Promise<Map<string, PriceToWinMl | null>> {
  const out = new Map<string, PriceToWinMl | null>();
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(concurrencia, ids.length) }, async () => {
    while (i < ids.length) {
      const id = ids[i++];
      try {
        const { data } = await mlGet<RespuestaPtw>(`/items/${id}/price_to_win?siteId=MLC&version=v2`);
        out.set(id, parsearPriceToWin(id, data));
      } catch {
        out.set(id, null);
      }
    }
  }));
  return out;
}

// true = publicación de catálogo, false = propia. Multiget de 20.
export async function cargarEsCatalogo(mlGet: MlGet, ids: string[]): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  for (let k = 0; k < ids.length; k += 20) {
    const lote = ids.slice(k, k + 20);
    try {
      const { data } = await mlGet<{ code: number; body: { id: string; catalog_listing?: boolean } }[]>(`/items?ids=${lote.join(",")}&attributes=id,catalog_listing`);
      for (const r of data) if (r.code === 200) out.set(r.body.id, !!r.body.catalog_listing);
    } catch { /* sin dato: la publicación se cuenta sin tipo */ }
  }
  return out;
}

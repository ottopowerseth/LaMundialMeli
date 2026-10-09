// Carga de datos para "reclamos por tipo logístico" (ver lib/reclamos-tipo.ts).
// A pedido: lista las órdenes de la ventana SIN filtro de estado (el denominador
// incluye canceladas y parcialmente reembolsadas), pagina /claims/search completo
// (no admite filtro de fecha) y cruza con ShippingCache. Medido 2026-10-09 con 120
// días: ~184 llamadas, ~12 s.
import { listarOrdenesRango } from "@/lib/backfill-shipping";
import type { GetFn } from "@/lib/backfill-shipping";
import { calcularReclamosPorTipo, mapasShippingCache, ordenesParaReclamos } from "@/lib/reclamos-tipo";
import type { ReclamoApi, ResultadoReclamos } from "@/lib/reclamos-tipo";

const MAX_OFFSET = 1000; // mismo corte que calcularReclamos de Métricas

export async function cargarReclamosPorTipo(args: {
  get: GetFn;
  userId: string | number;
  desdeMs: number;
  hastaMs: number;
  leerShippingCache: () => Promise<unknown[][]>;
}): Promise<ResultadoReclamos & { llamadas: { reclamos: number; ordenes: number }; reclamosListados: number }> {
  const { get, userId, desdeMs } = args;
  const hastaMs = Math.min(args.hastaMs, Date.now() + 1);

  let llamadasReclamos = 0;
  const reclamos: ReclamoApi[] = [];
  let completo = false;
  let totalEsperado = 0;
  for (let offset = 0; offset <= MAX_OFFSET; offset += 50) {
    const { data } = await get<{ paging: { total: number }; data?: ReclamoApi[] }>(
      `/post-purchase/v1/claims/search?player_role=respondent&player_user_id=${userId}&limit=50&offset=${offset}`
    );
    llamadasReclamos++;
    totalEsperado = data.paging.total;
    reclamos.push(...(data.data ?? []));
    if (!data.data || data.data.length === 0 || offset + data.data.length >= data.paging.total) { completo = true; break; }
  }

  // ML a veces repite ids entre páginas y entonces se salta otros: si los ids únicos son menos que el
  // total que informa paging, el listado está incompleto (las tasas pasan a ser un mínimo).
  if (new Set(reclamos.map((c) => String(c.id))).size < totalEsperado) completo = false;

  let llamadasOrdenes = 0;
  const contar: GetFn = (url) => { llamadasOrdenes++; return get(url); };
  const [{ ordenes }, filasCache] = await Promise.all([
    listarOrdenesRango(contar, userId, desdeMs, hastaMs, { concurrencia: 4 }),
    args.leerShippingCache(),
  ]);
  const { tipoPorOrden, ordenPorEnvio } = mapasShippingCache(filasCache);

  const r = calcularReclamosPorTipo({
    reclamos, ordenes: ordenesParaReclamos(ordenes as Parameters<typeof ordenesParaReclamos>[0]),
    tipoPorOrden, ordenPorEnvio, desdeMs, hastaMs, listadoCompleto: completo,
  });
  return { ...r, llamadas: { reclamos: llamadasReclamos, ordenes: llamadasOrdenes }, reclamosListados: reclamos.length };
}

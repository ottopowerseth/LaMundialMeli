// Carga de la cola de operación (H) desde ML. SOLO LECTURA (GET). Se llama a pedido
// desde /api/operacion; nada de esto corre al abrir el Tablero. Cada bloque es
// independiente: si uno falla, la ruta informa el error de ese bloque y muestra el resto.
import type { MlGet } from "@/lib/envio-real";
import { armarPregunta, armarReclamo, nivelReputacion } from "@/lib/operacion";
import type { DespachoCrudo, Pregunta, Reclamo } from "@/lib/operacion";

async function enParalelo<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

type OrdenListaApi = { id: number; shipping?: { id?: number }; order_items?: { item?: { title?: string }; quantity?: number }[] };
type EnvioApi = {
  id: number; logistic_type?: string; status?: string; substatus?: string | null; date_first_printed?: string | null;
  status_history?: { date_ready_to_ship?: string | null };
};
type SlaApi = { status?: string; expected_date?: string };

// Órdenes pagadas con envío en ready_to_ship → un envío por registro (una orden de
// carrito o varias del mismo paquete comparten envío), con 1 consulta por envío a
// /shipments/{id} y, solo para xd_drop_off, 1 a /sla. Full no responde /sla (404/403).
const TOPE_PAGINAS = 20;
export async function cargarDespachosListos(mlGet: MlGet, userId: number | string): Promise<DespachoCrudo[]> {
  const porEnvio = new Map<number, { ordenes: string[]; titulos: string[]; unidades: number }>();
  for (let pag = 0; pag < TOPE_PAGINAS; pag++) {
    const { data } = await mlGet<{ results: OrdenListaApi[]; paging: { total: number } }>(
      `/orders/search?seller=${userId}&order.status=paid&shipping.status=ready_to_ship&sort=date_desc&limit=50&offset=${pag * 50}`);
    for (const o of data.results) {
      const envio = o.shipping?.id;
      if (!envio) continue;
      const e = porEnvio.get(envio) ?? { ordenes: [], titulos: [], unidades: 0 };
      e.ordenes.push(String(o.id));
      for (const li of o.order_items ?? []) { if (li.item?.title) e.titulos.push(li.item.title); e.unidades += li.quantity ?? 0; }
      porEnvio.set(envio, e);
    }
    if (data.results.length === 0 || (pag + 1) * 50 >= data.paging.total) break;
  }
  const out: DespachoCrudo[] = [];
  await enParalelo([...porEnvio.entries()], 5, async ([envioId, base]) => {
    const { data: s } = await mlGet<EnvioApi>(`/shipments/${envioId}`);
    const tipo = s.logistic_type ?? "";
    let sla: DespachoCrudo["sla"] = null;
    if (tipo === "xd_drop_off") {
      sla = await mlGet<SlaApi>(`/shipments/${envioId}/sla`)
        .then((r) => ({ estado: r.data.status ?? null, plazoEntregaComprador: r.data.expected_date ?? null }))
        .catch(() => null);
    }
    out.push({
      envioId, ...base, tipoLogistico: tipo, estado: s.status ?? "sin_dato", subestado: s.substatus ?? null,
      listoIso: s.status_history?.date_ready_to_ship ?? null, impresoIso: s.date_first_printed ?? null, sla,
    });
  });
  return out;
}

type ReclamoLista = Parameters<typeof armarReclamo>[0];
export async function cargarReclamosAbiertos(mlGet: MlGet): Promise<Reclamo[]> {
  const crudos: ReclamoLista[] = [];
  for (let pag = 0; pag < TOPE_PAGINAS; pag++) {
    const { data } = await mlGet<{ data?: ReclamoLista[]; paging?: { total?: number } }>(
      `/post-purchase/v1/claims/search?status=opened&limit=50&offset=${pag * 50}`);
    const lista = data.data ?? [];
    crudos.push(...lista);
    if (lista.length === 0 || (pag + 1) * 50 >= (data.paging?.total ?? 0)) break;
  }
  const motivos = new Map<string, string | null>();
  for (const id of new Set(crudos.map((c) => c.reason_id).filter((x): x is string => !!x))) motivos.set(id, null);
  await enParalelo([...motivos.keys()], 4, async (id) => {
    const d = await mlGet<{ detail?: string }>(`/post-purchase/v1/claims/reasons/${id}`).then((r) => r.data.detail ?? null).catch(() => null);
    motivos.set(id, d);
  });
  const out: Reclamo[] = [];
  await enParalelo(crudos, 4, async (c) => {
    const afecta = await mlGet<{ affects_reputation?: string }>(`/post-purchase/v1/claims/${c.id}/affects-reputation`)
      .then((r) => r.data.affects_reputation ?? null).catch(() => null);
    out.push(armarReclamo(c, afecta, c.reason_id ? motivos.get(c.reason_id) ?? null : null));
  });
  return out.sort((a, b) => (a.creadoIso ?? "").localeCompare(b.creadoIso ?? "") || a.id - b.id);
}

export async function cargarPreguntasSinResponder(mlGet: MlGet, userId: number | string, ahoraMs: number): Promise<Pregunta[]> {
  const crudas: Parameters<typeof armarPregunta>[0][] = [];
  for (let pag = 0; pag < TOPE_PAGINAS; pag++) {
    const { data } = await mlGet<{ questions?: Parameters<typeof armarPregunta>[0][]; total?: number }>(
      `/questions/search?seller_id=${userId}&status=UNANSWERED&limit=50&offset=${pag * 50}&sort_fields=date_created&sort_types=ASC`);
    const lista = data.questions ?? [];
    crudas.push(...lista);
    if (lista.length === 0 || (pag + 1) * 50 >= (data.total ?? 0)) break;
  }
  const items = new Map<string, { title?: string; status?: string; sub_status?: string[] }>();
  const ids = [...new Set(crudas.map((q) => q.item_id))];
  for (let i = 0; i < ids.length; i += 20) {
    const lote = ids.slice(i, i + 20);
    const { data } = await mlGet<{ code: number; body: { id: string; title?: string; status?: string; sub_status?: string[] } }[]>(
      `/items?ids=${lote.join(",")}&attributes=id,title,status,sub_status`).catch(() => ({ data: [] }));
    for (const r of data) if (r.code === 200) items.set(r.body.id, r.body);
  }
  return crudas.map((q) => armarPregunta(q, items.get(q.item_id) ?? null, ahoraMs));
}

export async function cargarNivelReputacion(mlGet: MlGet, userId: number | string): Promise<string | null> {
  const { data } = await mlGet<{ seller_reputation?: { level_id?: string | null } | null }>(`/users/${userId}`);
  return nivelReputacion(data);
}

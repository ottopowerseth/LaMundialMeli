// Reclamos por tipo logístico — núcleo puro (sin red, sin Sheets). Todavía NO está
// integrado en el Tablero ni en Métricas.
//
// Definiciones:
//  - Dos series que NO se suman: cancelaciones (type "cancel_purchase") y
//    mediaciones (cualquier otro type: "mediations", "returns", ...).
//  - Tasa = eventos de la serie ÷ órdenes del mismo tipo creadas en la ventana × 100
//    ("por 100 órdenes"). El denominador son las órdenes pagadas, canceladas y
//    parcialmente reembolsadas, listadas SIN filtro de estado y clasificadas acá.
//  - Un evento es un reclamo (id único) con date_created dentro de la ventana,
//    parseada con el offset real del propio string.
//  - Cruce reclamo → orden: resource "order" (resource_id = id de orden), "shipment"
//    (resource_id = id de envío → orden) o "payment" (resource_id = id de pago → orden).
//    Sin cruce → "sin tipo": NO se reparte entre tipos.
//  - Cota inferior: mientras haya eventos sin tipo (o el listado de reclamos esté
//    incompleto), la tasa de cada tipo es un MÍNIMO.
//  - Mínimo de eventos: con menos de `minEventos` (20) en un tipo/serie no se da
//    tasa, solo el conteo. Este módulo no compara tipos ni produce textos de conclusión.

export type TipoReclamo = "full" | "otro";
export type SerieReclamo = "cancelaciones" | "mediaciones";

export const MIN_EVENTOS = 20;
export const ESTADOS_DENOMINADOR = ["paid", "cancelled", "partially_refunded"] as const;

export type ReclamoApi = {
  id: number | string;
  type?: string;
  resource?: string; // "order" | "shipment" | "payment"
  resource_id?: number | string;
  date_created?: string;
};

export type OrdenReclamos = {
  id: number | string;
  status?: string;
  date_created?: string;
  shippingId?: number | string | null;
  pagos?: (number | string)[];
};

export type EntradaReclamos = {
  reclamos: ReclamoApi[];
  ordenes: OrdenReclamos[]; // creadas en la ventana, sin filtro de estado
  tipoPorOrden: Map<string, string>; // ShippingCache: id de orden → logistic_type crudo
  ordenPorEnvio?: Map<string, string>; // ShippingCache: id de envío → id de orden
  desdeMs: number;
  hastaMs: number;
  listadoCompleto?: boolean; // false = el listado de reclamos se cortó (cota inferior)
  minEventos?: number;
};

export type CeldaTasa = {
  eventos: number;
  ordenes: number; // denominador del tipo
  tasaPor100: number | null; // null = menos de minEventos eventos: no se muestra tasa
};

export type ResultadoReclamos = {
  ventana: { desdeMs: number; hastaMs: number };
  minEventos: number;
  denominador: {
    full: number;
    otro: number;
    sinTipo: number; // órdenes del denominador sin entrada en ShippingCache
    total: number;
    excluidasPorEstado: number; // órdenes en otros estados (fuera del denominador)
    porEstado: Record<string, number>;
  };
  eventos: {
    enVentana: number;
    conTipo: number;
    sinTipo: number; // sin cruce con una orden, o con orden sin tipo
    fechaInvalida: number; // date_created ausente o sin offset
    duplicados: number; // mismo id de reclamo repetido en el listado
    porRecurso: Record<string, { total: number; conTipo: number }>;
    coberturaPct: number; // eventos con tipo ÷ eventos en ventana
  };
  series: Record<SerieReclamo, { full: CeldaTasa; otro: CeldaTasa; sinTipo: number; total: number }>;
  cotaInferior: boolean; // true = las tasas son un mínimo
  motivosCota: string[];
};

const aId = (v: unknown) => String(v ?? "").replace(/^'/, "").trim();

// Fecha con offset explícito ("...-04:00" o "Z"). Sin offset es ambigua: NaN.
export function parsearFechaReclamo(s: unknown): number {
  const t = String(s ?? "").trim();
  if (!/(Z|[+-]\d\d:?\d\d)$/.test(t)) return NaN;
  return Date.parse(t);
}

export function tipoDeLogistico(raw: string | null | undefined): TipoReclamo | null {
  const v = String(raw ?? "").trim();
  if (v === "") return null;
  return v === "fulfillment" ? "full" : "otro";
}

export function serieDe(type: string | undefined): SerieReclamo {
  return String(type ?? "").trim() === "cancel_purchase" ? "cancelaciones" : "mediaciones";
}

export function calcularReclamosPorTipo(e: EntradaReclamos): ResultadoReclamos {
  const minEventos = e.minEventos ?? MIN_EVENTOS;

  // Denominador: órdenes creadas en la ventana, por estado y tipo.
  const den = { full: 0, otro: 0, sinTipo: 0, total: 0, excluidasPorEstado: 0, porEstado: {} as Record<string, number> };
  const ordenPorPago = new Map<string, string>();
  const ordenPorEnvio = new Map<string, string>(e.ordenPorEnvio ?? []);
  const ordenesVistas = new Set<string>();
  for (const o of e.ordenes) {
    const id = aId(o.id);
    if (ordenesVistas.has(id)) continue; // ML a veces repite una orden en el borde
    ordenesVistas.add(id);
    const ms = Date.parse(String(o.date_created ?? ""));
    if (!Number.isNaN(ms) && (ms < e.desdeMs || ms >= e.hastaMs)) continue;
    // Los mapas de cruce usan todas las órdenes listadas, cualquiera sea su estado.
    if (o.shippingId) ordenPorEnvio.set(aId(o.shippingId), id);
    for (const p of o.pagos ?? []) ordenPorPago.set(aId(p), id);
    const estado = String(o.status ?? "sin_estado");
    den.porEstado[estado] = (den.porEstado[estado] ?? 0) + 1;
    if (!(ESTADOS_DENOMINADOR as readonly string[]).includes(estado)) { den.excluidasPorEstado++; continue; }
    const t = tipoDeLogistico(e.tipoPorOrden.get(id));
    den.total++;
    if (t === "full") den.full++; else if (t === "otro") den.otro++; else den.sinTipo++;
  }

  const ev = { enVentana: 0, conTipo: 0, sinTipo: 0, fechaInvalida: 0, duplicados: 0, porRecurso: {} as Record<string, { total: number; conTipo: number }> };
  const cuenta: Record<SerieReclamo, { full: number; otro: number; sinTipo: number }> = {
    cancelaciones: { full: 0, otro: 0, sinTipo: 0 },
    mediaciones: { full: 0, otro: 0, sinTipo: 0 },
  };
  const vistos = new Set<string>();
  for (const r of e.reclamos) {
    const id = aId(r.id);
    if (vistos.has(id)) { ev.duplicados++; continue; }
    vistos.add(id);
    const ms = parsearFechaReclamo(r.date_created);
    if (Number.isNaN(ms)) { ev.fechaInvalida++; continue; }
    if (ms < e.desdeMs || ms >= e.hastaMs) continue;
    ev.enVentana++;
    const recurso = String(r.resource ?? "desconocido");
    const rid = aId(r.resource_id);
    let orden: string | undefined;
    if (recurso === "order") orden = rid || undefined;
    else if (recurso === "shipment") orden = ordenPorEnvio.get(rid);
    else if (recurso === "payment") orden = ordenPorPago.get(rid);
    const tipo = orden ? tipoDeLogistico(e.tipoPorOrden.get(orden)) : null;
    const porRec = (ev.porRecurso[recurso] ??= { total: 0, conTipo: 0 });
    porRec.total++;
    const serie = serieDe(r.type);
    if (tipo) { ev.conTipo++; porRec.conTipo++; cuenta[serie][tipo]++; }
    else { ev.sinTipo++; cuenta[serie].sinTipo++; }
  }

  const celda = (n: number, ordenes: number): CeldaTasa => ({
    eventos: n,
    ordenes,
    tasaPor100: n >= minEventos && ordenes > 0 ? Math.round((n / ordenes) * 10000) / 100 : null,
  });
  const serie = (s: SerieReclamo) => ({
    full: celda(cuenta[s].full, den.full),
    otro: celda(cuenta[s].otro, den.otro),
    sinTipo: cuenta[s].sinTipo,
    total: cuenta[s].full + cuenta[s].otro + cuenta[s].sinTipo,
  });

  const motivosCota: string[] = [];
  if (ev.sinTipo > 0) motivosCota.push(`${ev.sinTipo} reclamos sin tipo logístico (sin cruce con una orden clasificada)`);
  if (e.listadoCompleto === false) motivosCota.push("listado de reclamos incompleto");
  if (ev.fechaInvalida > 0) motivosCota.push(`${ev.fechaInvalida} reclamos con fecha sin offset, excluidos`);

  return {
    ventana: { desdeMs: e.desdeMs, hastaMs: e.hastaMs },
    minEventos,
    denominador: den,
    eventos: { ...ev, coberturaPct: ev.enVentana > 0 ? Math.round((ev.conTipo / ev.enVentana) * 1000) / 10 : 0 },
    series: { cancelaciones: serie("cancelaciones"), mediaciones: serie("mediaciones") },
    cotaInferior: motivosCota.length > 0,
    motivosCota,
  };
}

// Conteo simple de reclamos del período para Métricas (total, por status y por type).
// ML repite reclamos entre páginas contiguas de /claims/search (medido 2026-10-09:
// 329 filas, 321 ids únicos), así que se cuenta cada id una sola vez.
export function resumirReclamosPeriodo(
  reclamos: (ReclamoApi & { status?: string })[], desdeMs: number, hastaMs: number
): { total: number; porStatus: Record<string, number>; porTipo: Record<string, number>; duplicados: number; fechaInvalida: number } {
  const porStatus: Record<string, number> = {};
  const porTipo: Record<string, number> = {};
  const vistos = new Set<string>();
  let total = 0, duplicados = 0, fechaInvalida = 0;
  for (const c of reclamos) {
    const id = aId(c.id);
    if (vistos.has(id)) { duplicados++; continue; }
    vistos.add(id);
    const ms = parsearFechaReclamo(c.date_created);
    if (Number.isNaN(ms)) { fechaInvalida++; continue; }
    if (ms < desdeMs || ms >= hastaMs) continue;
    total++;
    const st = String(c.status ?? "sin_estado"), tp = String(c.type ?? "sin_tipo");
    porStatus[st] = (porStatus[st] ?? 0) + 1;
    porTipo[tp] = (porTipo[tp] ?? 0) + 1;
  }
  return { total, porStatus, porTipo, duplicados, fechaInvalida };
}

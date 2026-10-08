// Cola de operación (H): despachos listos para enviar, reclamos abiertos, preguntas
// sin responder y nivel de reputación. SOLO LECTURA y sin sugerir acciones: ordena
// y rotula, no decide. Funciones puras (sin red); la carga está en operacion-datos.ts.
//
// Definiciones medidas con despachos reales (2026-10-08):
//  - "Horas desde listo" = ahora − status_history.date_ready_to_ship del envío. Es el
//    único reloj que mide cuánto lleva esperando el paquete, y es el que ordena.
//  - expected_date de /shipments/{id}/sla NO es el plazo de despacho: es el plazo de
//    entrega al comprador (≈ pay_before + horas de entrega; en los xd medidos caía
//    ~2 semanas después de crearse el envío mientras el despacho real ocurre ~42 h
//    después de quedar listo). Se muestra rotulado como lo que es y NO ordena.
//  - El estado SLA de ML (on_time, etc.) se muestra tal cual lo informa ML.
//  - Solo xd_drop_off (retiro/entrega en punto de despacho) lo despacha el vendedor.
//    fulfillment (Full) lo prepara y envía ML: se cuenta aparte, sin ordenar ni
//    marcar urgencia, y /sla no responde para esos envíos.

export type DespachoCrudo = {
  envioId: number;
  ordenes: string[];
  titulos: string[];
  unidades: number;
  tipoLogistico: string;
  estado: string;
  subestado: string | null;
  listoIso: string | null;
  impresoIso: string | null;
  sla: { estado: string | null; plazoEntregaComprador: string | null } | null;
};

export type DespachoAccionable = DespachoCrudo & { horasDesdeListo: number | null };

export type ColaDespachos = {
  accionables: DespachoAccionable[];
  full: { total: number; porSubestado: Record<string, number> };
  otros: { total: number; porTipo: Record<string, number> };
};

export function horasEntre(desdeIso: string | null, ahoraMs: number): number | null {
  if (!desdeIso) return null;
  const ms = Date.parse(desdeIso);
  return Number.isFinite(ms) ? Math.max(0, (ahoraMs - ms) / 3_600_000) : null;
}

const contar = (claves: string[]) => claves.reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});

export function armarDespachos(crudos: DespachoCrudo[], ahoraMs: number): ColaDespachos {
  const accionables: DespachoAccionable[] = crudos
    .filter((d) => d.tipoLogistico === "xd_drop_off")
    .map((d) => ({ ...d, horasDesdeListo: horasEntre(d.listoIso, ahoraMs) }))
    // Más horas esperando primero; los que no tienen fecha de listo, al final.
    .sort((a, b) => (b.horasDesdeListo ?? -1) - (a.horasDesdeListo ?? -1) || a.envioId - b.envioId);
  const full = crudos.filter((d) => d.tipoLogistico === "fulfillment");
  const otros = crudos.filter((d) => d.tipoLogistico !== "xd_drop_off" && d.tipoLogistico !== "fulfillment");
  return {
    accionables,
    full: { total: full.length, porSubestado: contar(full.map((d) => d.subestado ?? "sin_dato")) },
    otros: { total: otros.length, porTipo: contar(otros.map((d) => d.tipoLogistico || "sin_dato")) },
  };
}

// ---- Reclamos ----
export type Reclamo = {
  id: number; tipo: string; etapa: string; motivoId: string; motivo: string | null;
  afectaReputacion: string | null; ordenId: string | null; creadoIso: string | null; actualizadoIso: string | null;
};
type ReclamoApi = { id: number; type?: string; stage?: string; reason_id?: string; resource?: string; resource_id?: number | string; date_created?: string; last_updated?: string };

// affects_reputation tal cual lo informa ML ("affected" / "not_affected" / otro).
export function armarReclamo(c: ReclamoApi, afectaReputacion: string | null, motivo: string | null): Reclamo {
  return {
    id: c.id, tipo: c.type ?? "sin_dato", etapa: c.stage ?? "sin_dato", motivoId: c.reason_id ?? "sin_dato", motivo,
    afectaReputacion, ordenId: c.resource === "order" && c.resource_id != null ? String(c.resource_id) : null,
    creadoIso: c.date_created ?? null, actualizadoIso: c.last_updated ?? null,
  };
}

// ---- Preguntas ----
export type Pregunta = {
  id: number; itemId: string; texto: string; creadaIso: string | null; diasSinResponder: number | null;
  itemTitulo: string | null; itemEstado: string | null; itemSubestado: string[];
};
type PreguntaApi = { id: number; item_id: string; text?: string; date_created?: string };
type ItemBreve = { title?: string; status?: string; sub_status?: string[] };

export function armarPregunta(q: PreguntaApi, item: ItemBreve | null, ahoraMs: number): Pregunta {
  const h = horasEntre(q.date_created ?? null, ahoraMs);
  return {
    id: q.id, itemId: q.item_id, texto: q.text ?? "", creadaIso: q.date_created ?? null,
    diasSinResponder: h === null ? null : Math.floor(h / 24),
    itemTitulo: item?.title ?? null, itemEstado: item?.status ?? null, itemSubestado: item?.sub_status ?? [],
  };
}

// ---- Reputación: solo level_id, sin umbrales ni interpretación ----
export function nivelReputacion(usuario: { seller_reputation?: { level_id?: string | null } | null }): string | null {
  return usuario.seller_reputation?.level_id ?? null;
}

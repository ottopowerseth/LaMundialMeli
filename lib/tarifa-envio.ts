// Tarifa de envío por publicación (por UNIDAD), cacheada en la hoja
// "TarifaEnvio". Insumo del margen de contribución por SKU (tablero): el
// envío NO viene en /orders/search, y resolverlo por orden costaría 2-3
// llamadas por orden (miles por mes). Como el costo de envío es una tarifa
// constante por publicación (confirmado 2026-09-30: mín = mediana = máx en
// 15 de 15 ítems; y de nuevo 2026-10-07 en Plaisance y Fijador, 8 de 8
// despachos con el mismo valor aunque el comprador pagara montos distintos),
// basta 1-2 muestras limpias por publicación y refrescarlas cada tanto.
//
// Base: la tarifa se guarda BRUTA (con IVA), tal como la devuelve
// /shipments/{id}/costs (senders[0].cost) — misma base que el CXD/CFF de la
// Billing API (verificado 2026-10-07: idéntico en 36 de 36 despachos sin
// compartir). Quien la use para margen debe llevarla a neto (÷ 1 + IVA),
// igual que calcularMargen en lib/rentabilidad.ts.
//
// Despachos compartidos: shipping_items[] de /shipments/{id} dice qué ítems
// y cuántas unidades lleva el despacho. Si lleva SOLO esta publicación (aunque
// sean varias órdenes hermanas), el costo se reparte por unidades:
// costo total / unidades totales del despacho. Si lleva otros ítems, no hay
// forma de repartir sin conocer sus tarifas, así que esa muestra se descarta
// (no se adivina) y se cuenta como "mixta".
import type { MlGet } from "@/lib/envio-real";
import { mediana } from "@/lib/envio-real";
import { armarMuestrasEnvio, calcularEnvioEstimadoPorUnidad } from "@/lib/envio-estimado";

export const HOJA_TARIFA_ENVIO = "TarifaEnvio";
export const HEADERS_TARIFA_ENVIO = [
  "ID Item", "SKU", "Tarifa por Unidad (bruto)", "Tipo Logístico", "Muestras",
  "Dispersión %", "Despacho Muestra", "Unidades Despacho", "Estado", "Actualizado",
  "Fuente Estimación", "Motivo",
];

// Muestras limpias que se buscan por publicación, y cuántos despachos se
// revisan como máximo para encontrarlas. 2 alcanza para detectar una
// tarifa que cambió; más muestras multiplican las llamadas sin aportar.
export const MUESTRAS_POR_ITEM = 2;
export const MAX_CANDIDATOS_POR_ITEM = 6;
// Dispersión entre muestras (máx - mín sobre la mediana) a partir de la cual
// se marca "dispersa" — la tarifa se guarda igual, pero hay que mirarla.
export const DISPERSION_ALERTA_PCT = 5;
// Vigencia: una tarifa "ok" se refresca a los 30 días; cualquier otro estado
// (sin muestra, mixtos, sin costo, dispersa) se reintenta a los 3 días.
export const TTL_DIAS_OK = 30;
export const TTL_DIAS_REINTENTO = 3;

// "estimado": no hubo ninguna muestra limpia propia y la tarifa sale del
// respaldo de lib/envio-estimado.ts (ver estimarFaltantes) — el tablero debe
// mostrarla distinta de una tarifa medida. "Motivo" conserva por qué no hubo
// muestra propia (solo_despachos_mixtos, sin_costo...).
export type EstadoTarifa = "ok" | "dispersa" | "estimado" | "sin_muestra" | "solo_despachos_mixtos" | "sin_costo" | "error";

export type DespachoCandidato = { shippingId: number; fecha: string };
// precio: último unit_price visto (bruto), para ubicar el tramo del estimado.
// comision / ingresoConComision: comisión real cobrada (sale_fee × cantidad) y
// el ingreso de las líneas que traen sale_fee — ver lib/comision-real.ts.
export type VentaItem = { ingreso: number; precio: number; comision: number; ingresoConComision: number; despachos: DespachoCandidato[] }; // despachos: más reciente primero, sin repetir

type Shipment = { logistic_type?: string; shipping_items?: { id?: string; quantity?: number }[] };
type ShipmentCosts = { senders?: { cost?: number }[] };

export type ResultadoTarifa = {
  tarifaPorUnidad: number | null;
  tipoLogistico: string;
  muestras: number;
  dispersionPct: number | null;
  despachoMuestra: string;
  unidadesDespacho: number | null;
  estado: EstadoTarifa;
  fuenteEstimacion?: string; // solo estado "estimado": "sku" o "tramo <rango> <logística> (n=…)"
  motivo?: EstadoTarifa; // solo estado "estimado": por qué no hubo muestra propia
};

const redondear1 = (n: number) => Math.round(n * 10) / 10;

// Calcula la tarifa por unidad de UNA publicación a partir de sus despachos
// más recientes. Nunca lanza: cualquier fallo de una muestra se cuenta y se
// sigue con la siguiente.
export async function calcularTarifaItem(
  itemId: string,
  despachos: DespachoCandidato[],
  mlGet: MlGet,
  muestrasObjetivo = MUESTRAS_POR_ITEM,
  maxCandidatos = MAX_CANDIDATOS_POR_ITEM
): Promise<ResultadoTarifa> {
  const limpias: { tarifa: number; unidades: number; shippingId: number }[] = [];
  let logistico = "";
  let mixtas = 0;
  let sinCosto = 0;
  let errores = 0;
  let revisados = 0;

  for (const d of despachos) {
    if (limpias.length >= muestrasObjetivo || revisados >= maxCandidatos) break;
    revisados++;
    try {
      const { data: envio } = await mlGet<Shipment>(`/shipments/${d.shippingId}`);
      const items = new Map<string, number>();
      for (const it of envio.shipping_items ?? []) {
        if (it.id) items.set(it.id, (items.get(it.id) ?? 0) + (it.quantity ?? 0));
      }
      const unidades = items.get(itemId);
      if (!unidades) { errores++; continue; } // el despacho no menciona esta publicación: dato inconsistente
      if (items.size > 1) { mixtas++; continue; }

      // Una publicación puede haber pasado de envío normal a Full (o al
      // revés): como los despachos vienen del más reciente al más antiguo,
      // la primera muestra limpia fija el tipo vigente y se ignoran las
      // de otro tipo logístico.
      const tipo = envio.logistic_type ?? "";
      if (limpias.length > 0 && tipo !== logistico) continue;

      const { data: costos } = await mlGet<ShipmentCosts>(`/shipments/${d.shippingId}/costs`);
      const costo = costos.senders?.[0]?.cost;
      // $0 se trata como dato faltante, no como envío gratis — mismo
      // criterio que procesarTanda en lib/envio-real.ts (un $0 suele ser
      // dato incompleto de la API, no gratuidad real).
      if (costo === undefined || costo <= 0) { sinCosto++; continue; }

      if (limpias.length === 0) logistico = tipo;
      limpias.push({ tarifa: costo / unidades, unidades, shippingId: d.shippingId });
    } catch {
      errores++;
    }
  }

  if (limpias.length === 0) {
    const estado: EstadoTarifa =
      revisados === 0 ? "sin_muestra"
      : sinCosto > 0 ? "sin_costo"
      : mixtas > 0 ? "solo_despachos_mixtos"
      : errores > 0 ? "error"
      : "sin_muestra";
    return { tarifaPorUnidad: null, tipoLogistico: "", muestras: 0, dispersionPct: null, despachoMuestra: "", unidadesDespacho: null, estado };
  }

  const tarifas = limpias.map((l) => l.tarifa);
  const med = mediana(tarifas);
  const dispersion = limpias.length > 1 && med > 0 ? ((Math.max(...tarifas) - Math.min(...tarifas)) / med) * 100 : 0;
  const ref = limpias[0];
  return {
    tarifaPorUnidad: redondear1(med),
    tipoLogistico: logistico,
    muestras: limpias.length,
    dispersionPct: redondear1(dispersion),
    despachoMuestra: String(ref.shippingId),
    unidadesDespacho: ref.unidades,
    estado: dispersion > DISPERSION_ALERTA_PCT ? "dispersa" : "ok",
  };
}

// Ventas por publicación en una ventana de días, con los despachos de cada
// una (insumo de calcularTarifaItem) y su ingreso (para procesar primero lo
// que más vende). /orders/search trae el id de despacho en cada orden;
// 120 días = ~5.000 órdenes en ~100 llamadas (~6 s, medido 2026-10-07).
export async function obtenerVentasPorItem(
  mlGet: MlGet,
  userId: string | number,
  dias: number,
  ahora: Date = new Date()
): Promise<Map<string, VentaItem>> {
  const desde = new Date(ahora.getTime() - dias * 86400000).toISOString();
  const hasta = ahora.toISOString();
  const url = (offset: number) =>
    `/orders/search?seller=${userId}&order.date_created.from=${desde}&order.date_created.to=${hasta}&sort=date_desc&limit=50&offset=${offset}`;

  type OrdenApi = { id: number; date_created: string; status: string; shipping?: { id?: number }; order_items?: { item: { id: string }; quantity: number; unit_price: number; sale_fee?: number }[] };
  const primera = await mlGet<{ paging: { total: number }; results: OrdenApi[] }>(url(0));
  const total = Math.min(primera.data.paging.total, 9950); // la API rechaza offset >= 10.000
  const offsets = Array.from({ length: Math.ceil(total / 50) }, (_, i) => i * 50);

  const ordenes: OrdenApi[] = [];
  let siguiente = 1;
  ordenes.push(...primera.data.results);
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (siguiente < offsets.length) {
      const off = offsets[siguiente++];
      const r = await mlGet<{ results: OrdenApi[] }>(url(off));
      ordenes.push(...r.data.results);
    }
  }));

  ordenes.sort((a, b) => (a.date_created < b.date_created ? 1 : -1)); // más reciente primero
  const out = new Map<string, VentaItem>();
  for (const o of ordenes) {
    if (o.status !== "paid") continue;
    for (const it of o.order_items ?? []) {
      const v = out.get(it.item.id) ?? { ingreso: 0, precio: it.unit_price, comision: 0, ingresoConComision: 0, despachos: [] }; // órdenes de más reciente a más antigua: la primera fija el precio
      v.ingreso += it.quantity * it.unit_price;
      // sale_fee ausente no es comisión 0: esa línea no entra al cálculo.
      if (typeof it.sale_fee === "number") {
        v.comision += it.quantity * it.sale_fee;
        v.ingresoConComision += it.quantity * it.unit_price;
      }
      const sh = o.shipping?.id;
      if (sh && !v.despachos.some((d) => d.shippingId === sh)) v.despachos.push({ shippingId: sh, fecha: o.date_created });
      out.set(it.item.id, v);
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// Orquestación sobre la hoja de caché. Sin estado entre invocaciones: la
// propia hoja es el checkpoint (cada fila tiene su fecha de actualización),
// así que se puede llamar repetidas veces hasta que no queden pendientes —
// mismo patrón que backfill-shipping y rentabilidad/completar.
// ---------------------------------------------------------------------
export type OpcionesTarifas = {
  mlGet: MlGet;
  readSheet: (range: string) => Promise<string[][]>;
  writeSheet: (range: string, values: unknown[][]) => Promise<void>;
  appendSheet: (range: string, values: unknown[][]) => Promise<void>;
  batchWriteSheet: (updates: { range: string; values: unknown[][] }[]) => Promise<void>;
  ventas: Map<string, VentaItem>;
  skuPorItem: Map<string, string>;
  logisticoPorItem?: Map<string, string>; // logistic_type vigente de cada publicación (para el tramo del estimado)
  ahora: Date;
  dryRun: boolean;
  forzar: boolean;
  limite: number | null;
  tiempoMaximoMs: number;
  concurrencia?: number;
};

export type FilaTarifa = { itemId: string; sku: string; r: ResultadoTarifa; actualizado: string };

export type ResultadoTarifas = {
  dryRun: boolean;
  publicacionesConVenta: number;
  vigentes: number;
  pendientesAntes: number;
  procesadas: number;
  pendientesDespues: number;
  porEstado: Record<string, number>;
  escritas: { nuevas: number; actualizadas: number };
  filas: FilaTarifa[];
};

function filaDeSheet(f: FilaTarifa): string[] {
  const r = f.r;
  // Números como string con punto: misma convención que el resto de las
  // hojas (la hoja tiene locale es_CL y USER_ENTERED los guarda como texto,
  // que los lectores parsean con Number()).
  return [
    f.itemId, f.sku,
    r.tarifaPorUnidad === null ? "" : String(r.tarifaPorUnidad),
    r.tipoLogistico, String(r.muestras),
    r.dispersionPct === null ? "" : String(r.dispersionPct),
    r.despachoMuestra, r.unidadesDespacho === null ? "" : String(r.unidadesDespacho),
    r.estado, f.actualizado,
    r.fuenteEstimacion ?? "", r.motivo ?? "",
  ];
}

// Respaldo para las publicaciones sin muestra limpia propia: mediana de
// lib/envio-estimado.ts (otra publicación con el mismo SELLER_SKU, o el tramo
// de precio × tipo logístico). La fuente de las muestras es la propia caché
// de tarifas medidas (las "ok"), NO la hoja Rentabilidad que usan hoy el
// Comparador y Métricas: medido 2026-10-07 con "dejar uno afuera" sobre 205
// tarifas reales, alimentado con Rentabilidad el nivel tramo erra ~300%
// (mediana), alimentado con esta caché erra 0% (mediana; 95% dentro de ±15%
// en envío estándar). En Full es peor (mediana 49%): el tipo logístico
// importa y la tarifa Full no sigue el precio.
export function estimarFaltantes(
  hechas: FilaTarifa[],
  muestrasOk: { itemId: string; sku: string; precio: number; tarifa: number }[],
  ventas: Map<string, VentaItem>,
  logisticoPorItem: Map<string, string>
): void {
  const filasMuestra = muestrasOk.map((m) => {
    const f: string[] = [];
    f[2] = m.itemId; f[4] = String(m.precio); f[14] = String(m.tarifa);
    return f;
  });
  const skuPorItem = new Map(muestrasOk.map((m) => [m.itemId, m.sku]));
  for (const h of hechas) if (h.sku) skuPorItem.set(h.itemId, h.sku);
  const muestras = armarMuestrasEnvio(filasMuestra, skuPorItem, logisticoPorItem);

  for (const h of hechas) {
    if (h.r.tarifaPorUnidad !== null) continue;
    const precio = ventas.get(h.itemId)?.precio;
    if (!precio) continue;
    const esFull = logisticoPorItem.get(h.itemId) === "fulfillment";
    const e = calcularEnvioEstimadoPorUnidad(h.itemId, precio, esFull, muestras, h.sku || null);
    if (e.muestras === 0 || e.envio <= 0) continue; // sin referencia: se deja el estado original, nunca 0
    h.r = {
      ...h.r,
      tarifaPorUnidad: redondear1(e.envio),
      tipoLogistico: esFull ? "fulfillment" : (logisticoPorItem.get(h.itemId) ?? ""),
      estado: "estimado",
      motivo: h.r.estado,
      fuenteEstimacion: e.fuente === "sku" ? `sku (n=${e.muestras})` : `tramo ${esFull ? "Full" : "estándar"} (n=${e.muestras})`,
    };
  }
}

export async function procesarTarifas(op: OpcionesTarifas): Promise<ResultadoTarifas> {
  const inicio = Date.now();
  const hoja = HOJA_TARIFA_ENVIO;

  const existentes = new Map<string, { fila: number; estado: string; actualizado: number; sku: string; tarifa: number; tipo: string }>();
  try {
    const rows = await op.readSheet(`${hoja}!A2:L20000`);
    rows.forEach((r, i) => {
      if (!r[0]) return;
      existentes.set(String(r[0]), { fila: i + 2, estado: r[8] ?? "", actualizado: r[9] ? new Date(r[9]).getTime() : 0, sku: r[1] ?? "", tarifa: Number(r[2]), tipo: r[3] ?? "" });
    });
  } catch { /* hoja nueva o vacía */ }

  const vigente = (id: string) => {
    const e = existentes.get(id);
    if (!e) return false;
    const ttlDias = e.estado === "ok" ? TTL_DIAS_OK : TTL_DIAS_REINTENTO;
    return op.ahora.getTime() - e.actualizado < ttlDias * 86400000;
  };

  const porIngreso = [...op.ventas.entries()].sort((a, b) => b[1].ingreso - a[1].ingreso).map(([id]) => id);
  const pendientes = op.forzar ? porIngreso : porIngreso.filter((id) => !vigente(id));
  const lote = op.limite !== null ? pendientes.slice(0, op.limite) : pendientes;

  const hechas: FilaTarifa[] = [];
  let siguiente = 0;
  const conc = op.concurrencia ?? 6;
  await Promise.all(Array.from({ length: Math.min(conc, lote.length) }, async () => {
    while (siguiente < lote.length) {
      if (Date.now() - inicio > op.tiempoMaximoMs) return;
      const id = lote[siguiente++];
      const r = await calcularTarifaItem(id, op.ventas.get(id)!.despachos, op.mlGet);
      hechas.push({ itemId: id, sku: op.skuPorItem.get(id) ?? "", r, actualizado: op.ahora.toISOString() });
    }
  }));

  // Respaldo estimado para lo que quedó sin muestra limpia. Las muestras son
  // las tarifas "ok": las ya guardadas en la hoja (vigentes) más las medidas en
  // esta corrida. Cada publicación entra con el precio de su última venta.
  const muestrasOk: { itemId: string; sku: string; precio: number; tarifa: number }[] = [];
  const idsEnCorrida = new Set(hechas.map((h) => h.itemId));
  for (const [id, e] of existentes) {
    const precio = op.ventas.get(id)?.precio;
    if (e.estado === "ok" && Number.isFinite(e.tarifa) && e.tarifa > 0 && precio && !idsEnCorrida.has(id)) muestrasOk.push({ itemId: id, sku: e.sku, precio, tarifa: e.tarifa });
  }
  for (const h of hechas) {
    const precio = op.ventas.get(h.itemId)?.precio;
    if (h.r.estado === "ok" && h.r.tarifaPorUnidad !== null && precio) muestrasOk.push({ itemId: h.itemId, sku: h.sku, precio, tarifa: h.r.tarifaPorUnidad });
  }
  // Tipo logístico: el vigente según ML si se pasó; si no, el de la muestra.
  const logistico = new Map(op.logisticoPorItem ?? []);
  for (const m of muestrasOk) if (!logistico.has(m.itemId)) logistico.set(m.itemId, existentes.get(m.itemId)?.tipo ?? hechas.find((h) => h.itemId === m.itemId)?.r.tipoLogistico ?? "");
  estimarFaltantes(hechas, muestrasOk, op.ventas, logistico);

  const porEstado: Record<string, number> = {};
  for (const h of hechas) porEstado[h.r.estado] = (porEstado[h.r.estado] ?? 0) + 1;

  let nuevas = 0;
  let actualizadas = 0;
  if (!op.dryRun && hechas.length > 0) {
    // Encabezado: se crea si falta y se amplía si la hoja es de una versión
    // anterior con menos columnas (la 1ª versión tenía 10: sin Fuente
    // Estimación ni Motivo).
    const encabezado = await op.readSheet(`${hoja}!A1:L1`).catch(() => [] as string[][]);
    if (!encabezado.length || (encabezado[0]?.length ?? 0) < HEADERS_TARIFA_ENVIO.length) await op.writeSheet(`${hoja}!A1`, [HEADERS_TARIFA_ENVIO]);

    const updates: { range: string; values: unknown[][] }[] = [];
    const filasNuevas: string[][] = [];
    for (const h of hechas) {
      const e = existentes.get(h.itemId);
      if (e) { updates.push({ range: `${hoja}!A${e.fila}:L${e.fila}`, values: [filaDeSheet(h)] }); actualizadas++; }
      else { filasNuevas.push(filaDeSheet(h)); nuevas++; }
    }
    // Se escribe lo ya resuelto aunque la corrida se haya cortado por
    // tiempo: nada de lo calculado se pierde ni se vuelve a pedir.
    if (updates.length > 0) await op.batchWriteSheet(updates);
    if (filasNuevas.length > 0) await op.appendSheet(`${hoja}!A:L`, filasNuevas);
  }

  return {
    dryRun: op.dryRun,
    publicacionesConVenta: porIngreso.length,
    vigentes: porIngreso.length - pendientes.length,
    pendientesAntes: pendientes.length,
    procesadas: hechas.length,
    pendientesDespues: pendientes.length - hechas.length,
    porEstado,
    escritas: { nuevas, actualizadas },
    filas: hechas,
  };
}

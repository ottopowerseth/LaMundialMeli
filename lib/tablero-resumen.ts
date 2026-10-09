// Resumen de ventas del Tablero y barra de confianza (cobertura de datos).
import type { LineaVenta, OrdenVenta } from "@/lib/tablero-datos";
import { resolverEnvio } from "@/lib/envio-medido";
import type { ContextoEnvio } from "@/lib/envio-medido";
import { grupoLogistico } from "@/lib/logistica";

export type ResumenVentas = { ingresos: number; unidades: number; ordenes: number; ticket: number };
export type Variacion = { actual: number; anterior: number; pct: number | null };

// Ingresos = suma de total_amount por orden y unidades = suma de quantity,
// igual que calcularVentas de Métricas (ver lib/tablero-datos.ts).
export function resumirVentas(
  ordenes: OrdenVenta[],
  lineas: LineaVenta[],
  desdeMs: number,
  hastaMs: number
): ResumenVentas {
  const dentro = ordenes.filter((o) => o.ms >= desdeMs && o.ms < hastaMs);
  const ingresos = dentro.reduce((s, o) => s + o.total, 0);
  const unidades = lineas.filter((l) => l.ms >= desdeMs && l.ms < hastaMs).reduce((s, l) => s + l.cantidad, 0);
  return { ingresos, unidades, ordenes: dentro.length, ticket: dentro.length > 0 ? Math.round(ingresos / dentro.length) : 0 };
}

// null cuando el período anterior es 0 (no hay % con sentido).
export function variacion(actual: number, anterior: number): Variacion {
  return { actual, anterior, pct: anterior > 0 ? Math.round(((actual - anterior) / anterior) * 1000) / 10 : null };
}

export type Confianza = {
  ingresoVentana: number;
  // % del ingreso de la ventana cuyas publicaciones tienen cada dato.
  costo: { pct: number; conCosto: number; auto: number; manual: number; enRevision: number; sinCosto: number };
  // Por línea de venta (publicación y tipo logístico de esa venta), con la misma jerarquía de resolverEnvio:
  // tarifa medida del tipo correcto (pct), estimada del tipo correcto en la hoja (estimado), respaldo por SKU
  // gemelo o tramo porque no hay fila del tipo (estimador), tarifa del otro tipo porque tampoco hay estimador
  // (otroTipo), o ninguna referencia (sinDato).
  envioMedido: { pct: number; estimado: number; estimador: number; otroTipo: number; sinDato: number };
  comisionReal: { pct: number };
  publicacionesConVenta: number;
  // Cerradas o inactivas SIN Costo: no se pueden completar ni vender, así que
  // no cuentan en la cobertura (ni en el total ni en lo que falta).
  excluidas: { publicaciones: number; ingreso: number };
};

export type EntradaConfianza = {
  lineas: LineaVenta[]; // solo las de la ventana
  costoPorItem: Map<string, number | null>; // Publicaciones!F (null = vacío)
  origenPorItem: Map<string, string>; // CostoOrigen: auto | manual | revisar
  ctxEnvio: ContextoEnvio; // tarifas de la hoja + muestras del estimador (ver lib/envio-medido.ts)
  skuPorItem: Map<string, string>;
  fullPorItem?: Map<string, boolean>; // tipo ACTUAL de cada publicación: respaldo para las líneas sin tipo real
  fueraDeAlcance?: Set<string>; // publicaciones closed/inactive (ver route del Tablero)
};

// Cobertura ponderada por ingreso: un dato faltante en un SKU que casi no
// vende pesa poco; en uno que vende mucho, pesa. Es lo que hay que mirar
// antes de creer un margen.
export function calcularConfianza(e: EntradaConfianza): Confianza {
  // porTipo: ingreso de la publicación repartido entre Full (true) y no Full (false) según el tipo de
  // cada venta (real si la línea lo trae; si no, el tipo ACTUAL de la publicación).
  const ingresoPorItem = new Map<string, { ing: number; unidades: number; conFee: number; porTipo: Map<boolean, number> }>();
  for (const l of e.lineas) {
    const a = ingresoPorItem.get(l.item) ?? { ing: 0, unidades: 0, conFee: 0, porTipo: new Map<boolean, number>() };
    const monto = l.cantidad * l.precio;
    a.ing += monto;
    a.unidades += l.cantidad;
    if (l.fee !== null) a.conFee += monto;
    const esFull = l.logistic ? grupoLogistico(l.logistic) === "Full" : (e.fullPorItem?.get(l.item) ?? false);
    a.porTipo.set(esFull, (a.porTipo.get(esFull) ?? 0) + monto);
    ingresoPorItem.set(l.item, a);
  }
  let total = 0, conCosto = 0, auto = 0, manual = 0, enRevision = 0, medido = 0, estimado = 0, estimador = 0, otroTipo = 0, sinEnvio = 0, comReal = 0;
  let excluidas = 0, ingresoExcluido = 0;
  for (const [id, a] of ingresoPorItem) {
    // Una cerrada/inactiva que ya tiene Costo sí cuenta: solo se excluye lo que no tiene arreglo.
    if (e.fueraDeAlcance?.has(id) && !((e.costoPorItem.get(id) ?? 0) > 0)) { excluidas++; ingresoExcluido += a.ing; continue; }
    total += a.ing;
    comReal += a.conFee;
    const costo = e.costoPorItem.get(id) ?? null;
    if (costo !== null && costo > 0) {
      conCosto += a.ing;
      if (e.origenPorItem.get(id) === "auto") auto += a.ing; else manual += a.ing;
    } else if (e.origenPorItem.get(id) === "revisar") {
      enRevision += a.ing;
    }
    // Envío por tipo de la venta: se resuelve igual que el margen (mismo precio promedio y mismo orden de búsqueda).
    const precioProm = a.unidades > 0 ? a.ing / a.unidades : 0;
    for (const [esFull, monto] of a.porTipo) {
      const r = resolverEnvio(id, precioProm, esFull, e.skuPorItem.get(id) ?? null, e.ctxEnvio);
      if (r.fuente === "medido") medido += monto;
      else if (r.origen === "hoja") estimado += monto;
      else if (r.origen === "estimador") estimador += monto;
      else if (r.origen === "otro_tipo") otroTipo += monto;
      else sinEnvio += monto; // ninguna referencia: el margen queda "sin envío"
    }
  }
  const pct = (x: number) => (total > 0 ? Math.round((x / total) * 1000) / 10 : 0);
  return {
    ingresoVentana: total,
    costo: { pct: pct(conCosto), conCosto: pct(conCosto), auto: pct(auto), manual: pct(manual), enRevision: pct(enRevision), sinCosto: pct(total - conCosto) },
    envioMedido: { pct: pct(medido), estimado: pct(estimado), estimador: pct(estimador), otroTipo: pct(otroTipo), sinDato: pct(sinEnvio) },
    comisionReal: { pct: pct(comReal) },
    publicacionesConVenta: ingresoPorItem.size - excluidas,
    excluidas: { publicaciones: excluidas, ingreso: Math.round(ingresoExcluido) },
  };
}

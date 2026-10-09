// Resumen de ventas del Tablero y barra de confianza (cobertura de datos).
import type { LineaVenta, OrdenVenta } from "@/lib/tablero-datos";
import { esTarifaMedida, tarifaDe, tarifaOtroTipo } from "@/lib/envio-medido";
import type { TarifasEnvio } from "@/lib/envio-medido";
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
  // Por línea de venta (publicación y tipo logístico de esa venta): tarifa medida del tipo correcto,
  // estimada del tipo correcto, solo del OTRO tipo, o sin fila (respaldo por tramo).
  envioMedido: { pct: number; estimado: number; otroTipo: number; sinDato: number };
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
  tarifas: TarifasEnvio;
  fullPorItem?: Map<string, boolean>; // tipo ACTUAL de cada publicación: respaldo para las líneas sin tipo real
  fueraDeAlcance?: Set<string>; // publicaciones closed/inactive (ver route del Tablero)
};

// Cobertura ponderada por ingreso: un dato faltante en un SKU que casi no
// vende pesa poco; en uno que vende mucho, pesa. Es lo que hay que mirar
// antes de creer un margen.
export function calcularConfianza(e: EntradaConfianza): Confianza {
  // porTipo: ingreso de la publicación repartido entre Full (true) y no Full (false) según el tipo de
  // cada venta (real si la línea lo trae; si no, el tipo ACTUAL de la publicación).
  const ingresoPorItem = new Map<string, { ing: number; conFee: number; porTipo: Map<boolean, number> }>();
  for (const l of e.lineas) {
    const a = ingresoPorItem.get(l.item) ?? { ing: 0, conFee: 0, porTipo: new Map<boolean, number>() };
    const monto = l.cantidad * l.precio;
    a.ing += monto;
    if (l.fee !== null) a.conFee += monto;
    const esFull = l.logistic ? grupoLogistico(l.logistic) === "Full" : (e.fullPorItem?.get(l.item) ?? false);
    a.porTipo.set(esFull, (a.porTipo.get(esFull) ?? 0) + monto);
    ingresoPorItem.set(l.item, a);
  }
  let total = 0, conCosto = 0, auto = 0, manual = 0, enRevision = 0, medido = 0, estimado = 0, otroTipo = 0, sinEnvio = 0, comReal = 0;
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
    // Envío por tipo de la venta: misma jerarquía que resolverEnvio (lib/envio-medido.ts) hasta el respaldo.
    for (const [esFull, monto] of a.porTipo) {
      const propia = tarifaDe(e.tarifas, id, esFull);
      const otra = tarifaOtroTipo(e.tarifas, id, esFull);
      if (esTarifaMedida(propia)) medido += monto;
      else if (propia?.estado === "estimado") estimado += monto;
      else if (otra && (esTarifaMedida(otra) || otra.estado === "estimado")) otroTipo += monto;
      else sinEnvio += monto; // sin fila en la caché: se estimaría por tramo (ver envio-medido)
    }
  }
  const pct = (x: number) => (total > 0 ? Math.round((x / total) * 1000) / 10 : 0);
  return {
    ingresoVentana: total,
    costo: { pct: pct(conCosto), conCosto: pct(conCosto), auto: pct(auto), manual: pct(manual), enRevision: pct(enRevision), sinCosto: pct(total - conCosto) },
    envioMedido: { pct: pct(medido), estimado: pct(estimado), otroTipo: pct(otroTipo), sinDato: pct(sinEnvio) },
    comisionReal: { pct: pct(comReal) },
    publicacionesConVenta: ingresoPorItem.size - excluidas,
    excluidas: { publicaciones: excluidas, ingreso: Math.round(ingresoExcluido) },
  };
}

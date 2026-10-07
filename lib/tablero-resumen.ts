// Resumen de ventas del Tablero y barra de confianza (cobertura de datos).
import type { LineaVenta, OrdenVenta } from "@/lib/tablero-datos";
import type { TarifaEnvioFila } from "@/lib/envio-medido";

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
  envioMedido: { pct: number; estimado: number; sinDato: number };
  comisionReal: { pct: number };
  publicacionesConVenta: number;
};

export type EntradaConfianza = {
  lineas: LineaVenta[]; // solo las de la ventana
  costoPorItem: Map<string, number | null>; // Publicaciones!F (null = vacío)
  origenPorItem: Map<string, string>; // CostoOrigen: auto | manual | revisar
  tarifas: Map<string, TarifaEnvioFila>;
};

// Cobertura ponderada por ingreso: un dato faltante en un SKU que casi no
// vende pesa poco; en uno que vende mucho, pesa. Es lo que hay que mirar
// antes de creer un margen.
export function calcularConfianza(e: EntradaConfianza): Confianza {
  const ingresoPorItem = new Map<string, { ing: number; conFee: number }>();
  for (const l of e.lineas) {
    const a = ingresoPorItem.get(l.item) ?? { ing: 0, conFee: 0 };
    const monto = l.cantidad * l.precio;
    a.ing += monto;
    if (l.fee !== null) a.conFee += monto;
    ingresoPorItem.set(l.item, a);
  }
  let total = 0, conCosto = 0, auto = 0, manual = 0, enRevision = 0, medido = 0, estimado = 0, sinEnvio = 0, comReal = 0;
  for (const [id, a] of ingresoPorItem) {
    total += a.ing;
    comReal += a.conFee;
    const costo = e.costoPorItem.get(id) ?? null;
    if (costo !== null && costo > 0) {
      conCosto += a.ing;
      if (e.origenPorItem.get(id) === "auto") auto += a.ing; else manual += a.ing;
    } else if (e.origenPorItem.get(id) === "revisar") {
      enRevision += a.ing;
    }
    const t = e.tarifas.get(id);
    if (t && (t.estado === "ok" || t.estado === "dispersa")) medido += a.ing;
    else if (t && t.estado === "estimado") estimado += a.ing;
    else sinEnvio += a.ing; // sin fila en la caché: se estimaría por tramo (ver envio-medido)
  }
  const pct = (x: number) => (total > 0 ? Math.round((x / total) * 1000) / 10 : 0);
  return {
    ingresoVentana: total,
    costo: { pct: pct(conCosto), conCosto: pct(conCosto), auto: pct(auto), manual: pct(manual), enRevision: pct(enRevision), sinCosto: pct(total - conCosto) },
    envioMedido: { pct: pct(medido), estimado: pct(estimado), sinDato: pct(sinEnvio) },
    comisionReal: { pct: pct(comReal) },
    publicacionesConVenta: ingresoPorItem.size,
  };
}

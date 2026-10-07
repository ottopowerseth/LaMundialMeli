// Pareto de ingresos y series semanal / mensual del Tablero. Lógica pura.
//
// Días UTC, igual que el resto del Tablero. Semanas de lunes a domingo (UTC);
// meses calendario. Ingresos = Σ total_amount por orden y unidades = Σ quantity
// (mismo criterio que Métricas, ver lib/tablero-resumen.ts); el Pareto usa el
// ingreso por línea (cantidad × precio unitario), el mismo de la clase ABC.
import type { LineaVenta, OrdenVenta } from "@/lib/tablero-datos";
import { resumirVentas } from "@/lib/tablero-resumen";
import type { ResumenVentas } from "@/lib/tablero-resumen";

const DIA_MS = 86400000;

// ---------- Pareto ----------
export type Pareto = {
  desde: string; hasta: string;
  ingreso: number; publicaciones: number; // publicaciones con ventas
  // cuántas publicaciones hacen falta para llegar a cada % del ingreso
  para50: number; para80: number; para95: number;
  top10Pct: number; // % del ingreso de las 10 mayores
};

export function calcularPareto(lineas: LineaVenta[], desdeMs: number, hastaMs: number): Pareto {
  const porItem = new Map<string, number>();
  for (const l of lineas) if (l.ms >= desdeMs && l.ms < hastaMs) porItem.set(l.item, (porItem.get(l.item) ?? 0) + l.cantidad * l.precio);
  const orden = [...porItem.values()].filter((v) => v > 0).sort((a, b) => b - a);
  const total = orden.reduce((s, v) => s + v, 0);
  // Menor n tal que las n mayores suman >= corte del total.
  const paraCorte = (corte: number) => {
    let acum = 0;
    for (let i = 0; i < orden.length; i++) { acum += orden[i]; if (acum >= total * corte - 1e-9) return i + 1; }
    return orden.length;
  };
  return {
    desde: new Date(desdeMs).toISOString(), hasta: new Date(hastaMs).toISOString(),
    ingreso: Math.round(total), publicaciones: orden.length,
    para50: paraCorte(0.5), para80: paraCorte(0.8), para95: paraCorte(0.95),
    top10Pct: total > 0 ? Math.round((orden.slice(0, 10).reduce((s, v) => s + v, 0) / total) * 1000) / 10 : 0,
  };
}

// ---------- Series ----------
export type TipoSerie = "semana" | "mes";
export type PuntoSerie = ResumenVentas & {
  desde: string; hasta: string; // [desde, hasta) del período completo
  hastaDatos: string; // hasta dónde hay datos (< hasta si el período está en curso)
  parcial: boolean; // período en curso
  incompleto: boolean; // empieza antes de donde hay datos cargados: no sirve para comparar
  // Variación contra el período anterior; si el actual es parcial, contra el
  // MISMO tramo (mismos días transcurridos) del anterior. null = sin base.
  variacion: { ingresos: number | null; unidades: number | null; ordenes: number | null; ticket: number | null };
  comparadoCon: { desde: string; hasta: string } | null;
};

export function inicioPeriodo(ms: number, tipo: TipoSerie): number {
  const d = new Date(ms);
  if (tipo === "mes") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // lunes
}
export function siguientePeriodo(inicio: number, tipo: TipoSerie): number {
  if (tipo === "semana") return inicio + 7 * DIA_MS;
  const d = new Date(inicio);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}
function anteriorPeriodo(inicio: number, tipo: TipoSerie): number {
  if (tipo === "semana") return inicio - 7 * DIA_MS;
  const d = new Date(inicio);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1);
}
const pctVar = (a: number, b: number) => (b > 0 ? Math.round(((a - b) / b) * 1000) / 10 : null);
const iso = (ms: number) => new Date(ms).toISOString();

// finDatosMs: fin de lo observado (el hasta de la ventana, = mañana 00:00 UTC);
// inicioDatosMs: desde dónde se cargaron órdenes. cantidad: períodos a devolver
// (el más reciente al final).
export function calcularSerie(
  ordenes: OrdenVenta[], lineas: LineaVenta[],
  tipo: TipoSerie, cantidad: number, inicioDatosMs: number, finDatosMs: number
): PuntoSerie[] {
  const ultimoInicio = inicioPeriodo(finDatosMs - 1, tipo); // el período que contiene el último instante observado
  const inicios: number[] = [];
  for (let t = ultimoInicio, i = 0; i < cantidad; i++, t = anteriorPeriodo(t, tipo)) inicios.unshift(t);

  const resumen = (d: number, h: number) => resumirVentas(ordenes, lineas, d, h);
  const puntos: PuntoSerie[] = inicios.map((ini) => {
    const fin = siguientePeriodo(ini, tipo);
    const hastaDatos = Math.min(fin, finDatosMs);
    const parcial = fin > finDatosMs;
    const incompleto = ini < inicioDatosMs;
    const r = resumen(ini, hastaDatos);
    // Base de comparación: el período anterior, recortado al mismo tramo si el actual es parcial.
    const iniPrev = anteriorPeriodo(ini, tipo);
    const finPrevCompleto = ini;
    const finPrev = parcial ? Math.min(iniPrev + (hastaDatos - ini), finPrevCompleto) : finPrevCompleto;
    const baseIncompleta = iniPrev < inicioDatosMs;
    const base = baseIncompleta || incompleto ? null : resumen(iniPrev, finPrev);
    return {
      ...r, desde: iso(ini), hasta: iso(fin), hastaDatos: iso(hastaDatos), parcial, incompleto,
      variacion: base
        ? { ingresos: pctVar(r.ingresos, base.ingresos), unidades: pctVar(r.unidades, base.unidades), ordenes: pctVar(r.ordenes, base.ordenes), ticket: pctVar(r.ticket, base.ticket) }
        : { ingresos: null, unidades: null, ordenes: null, ticket: null },
      comparadoCon: base ? { desde: iso(iniPrev), hasta: iso(finPrev) } : null,
    };
  });
  return puntos;
}

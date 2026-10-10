// Comparativo Full vs Normal por período + lista corta de candidatos Normal → Full. Lógica pura (sin
// llamadas): el endpoint del Tablero pasa las ventas con su tipo logístico real y la función de margen.
//
// Definiciones:
//  - Canal de una VENTA (no de la publicación): Full si su orden es fulfillment (ShippingCache); Normal si es
//    cualquier otro tipo. Las ventas sin tipo real usan el tipo ACTUAL de la publicación (mismo criterio que el
//    margen del Tablero) y se cuentan aparte como "respaldo" (% del ingreso).
//  - Solo órdenes pagadas (el Tablero pide order.status=paid: excluye canceladas y parcialmente reembolsadas).
//  - Margen por canal: neto (sin IVA), antes de publicidad, el MISMO que el Tablero (resumen.porTipo de
//    analizarMargen sobre todas las ventas del período): los totales por canal coinciden con los de esa sección.
//    NO incluye costos propios de Full (sin tarifas cargadas todavía).
//  - Publicaciones sin Costo: quedan fuera del margen (se listan con su ingreso).
//  - Candidatos Normal → Full: solo rotación y margen actual. No evalúa tamaño/peso/categoría, reputación,
//    reposición, campañas ni costo de Full. Umbrales: constantes de este archivo (editables en la pantalla).
import type { LineaVenta } from "@/lib/tablero-datos";
import type { DetalleTipoMargen, FilaMargen, LadoTipoMargen, ResumenMargen } from "@/lib/tablero-margen";

export const PERIODOS_DIAS = [30, 90, 120];
export const CANDIDATO_U90_MIN = 20; // unidades Normal en 90 días
export const CANDIDATO_SEMANAS_MIN = 6; // semanas con ventas, de las últimas 13
export const MAX_PRODUCTOS_POR_PERIODO = 200; // la tabla por producto trae solo los de mayor venta (el resto se cuenta)
export const FULL_VENTAS_BAJAS_U90_MAX = 5; // unidades (todos los canales) en 90 días
const DIA_MS = 86400000;
const SEMANA_MS = 7 * DIA_MS;

export type Canal = "full" | "normal";
export type Analizar = (lineas: LineaVenta[]) => { filas: FilaMargen[]; resumen: ResumenMargen; detalle: Map<string, DetalleTipoMargen> };

export type CanalPeriodo = {
  unidades: number; ingreso: number; ordenes: number; ticket: number;
  pctIngreso: number; pctUnidades: number;
  margenPesos: number | null; margenPct: number | null; // sobre las publicaciones con margen calculable
  ingresoConMargenPct: number; // % del ingreso del canal cuyo margen se pudo calcular
  ingresoSinMargen: number; // CLP brutos del canal que quedan fuera del margen (sin Costo, sin envío o sin comisión)
  menosFiablePct: number; // % del ingreso con margen que depende de un envío estimado
  sinCosto: { publicaciones: number; ingreso: number; lista: { id: string; titulo: string; ingreso: number }[] };
};
export type LadoProducto = { unidades: number; ingreso: number; margenPesos: number | null; margenPct: number | null; estado: string; menosFiable: boolean };
export type ProductoFvN = { id: string; titulo: string; full: LadoProducto | null; normal: LadoProducto | null; ingresoTotal: number };
export type PeriodoFvN = {
  dias: number;
  canales: Record<Canal, CanalPeriodo>;
  respaldoPct: number; // % del ingreso del período sin tipo real (usa el tipo actual de la publicación)
  productos: ProductoFvN[]; // los MAX_PRODUCTOS_POR_PERIODO de mayor venta
  productosTotal: number; // cuántas publicaciones vendieron en el período (productosTotal − productos.length quedaron fuera)
};

export type Candidato = {
  id: string; titulo: string;
  u30: number; u60: number; u90: number; semanasConVenta: number;
  margenUnitario: number | null; margenPct: number | null; menosFiable: boolean;
  margenMes: number | null; // margen neto estimado por 30 días al ritmo de 90 días (sin costos de Full)
  stock: number | null;
};
export type FullVentasBajas = { id: string; titulo: string; stock: number; u30: number; u90: number; capital: number | null };

export type ResultadoFvN = {
  periodos: PeriodoFvN[];
  candidatos: Candidato[]; // Normal puro (sin ventas Full en 120 d), activas, hoy no Full, con ≥ 5 u en 90 d
  fullVentasBajas: FullVentasBajas[];
  umbrales: { u90Min: number; semanasMin: number; fullVentasBajasU90Max: number };
  noEvaluado: string[];
};

const r1 = (x: number) => Math.round(x * 10) / 10;

export function armarFullVsNormal(e: {
  lineas: LineaVenta[];
  ahoraMs: number;
  esFull: (l: LineaVenta) => boolean;
  esReal: (l: LineaVenta) => boolean;
  analizar: Analizar;
  items: Map<string, { titulo: string; estado: string; stock: number | null; full: boolean }>;
  costoPorItem?: Map<string, number | null>;
  periodos?: number[];
}): ResultadoFvN {
  const dias = (l: LineaVenta) => (e.ahoraMs - l.ms) / DIA_MS;
  const validas = e.lineas.filter((l) => dias(l) >= 0 && dias(l) <= 120);

  const margenNormalCompleto = new Map<number, Map<string, LadoProducto>>(); // por período, de TODAS las publicaciones
  const periodos: PeriodoFvN[] = (e.periodos ?? PERIODOS_DIAS).map((p) => {
    const lp = validas.filter((l) => dias(l) <= p);
    const totalIng = lp.reduce((s, l) => s + l.cantidad * l.precio, 0);
    const totalU = lp.reduce((s, l) => s + l.cantidad, 0);
    const ingReal = lp.filter(e.esReal).reduce((s, l) => s + l.cantidad * l.precio, 0);
    const { filas, resumen, detalle } = e.analizar(lp);
    const fuera = new Set(filas.filter((f) => f.fueraDeAlcance).map((f) => f.id));
    const canales = {} as Record<Canal, CanalPeriodo>;
    for (const c of ["full", "normal"] as Canal[]) {
      const lc = lp.filter((l) => e.esFull(l) === (c === "full"));
      const ing = lc.reduce((s, l) => s + l.cantidad * l.precio, 0);
      const u = lc.reduce((s, l) => s + l.cantidad, 0);
      const ord = new Set(lc.map((l) => l.orden)).size;
      const k = c === "full" ? "full" : "estandar";
      const st = resumen.porTipo[k];
      const lados = [...detalle].map(([id, d]) => ({ id, lado: d[k] })).filter((x): x is { id: string; lado: LadoTipoMargen } => !!x.lado);
      const conMargen = lados.filter((x) => x.lado.margenPesos !== null);
      const ingConMargen = conMargen.reduce((s, x) => s + x.lado.ingreso, 0);
      const ingMenosFiable = conMargen.filter((x) => x.lado.menosFiable).reduce((s, x) => s + x.lado.ingreso, 0);
      const sinCosto = lados.filter((x) => x.lado.estado === "sin_costo" && !fuera.has(x.id));
      canales[c] = {
        unidades: u, ingreso: Math.round(ing), ordenes: ord, ticket: ord > 0 ? Math.round(ing / ord) : 0,
        pctIngreso: totalIng > 0 ? r1((ing / totalIng) * 100) : 0, pctUnidades: totalU > 0 ? r1((u / totalU) * 100) : 0,
        margenPesos: st.margenPct === null ? null : st.margenPesos, margenPct: st.margenPct,
        ingresoConMargenPct: ing > 0 ? r1((st.ingreso / ing) * 100) : 0,
        ingresoSinMargen: Math.max(0, Math.round(ing - st.ingreso)),
        menosFiablePct: ingConMargen > 0 ? r1((ingMenosFiable / ingConMargen) * 100) : 0,
        sinCosto: {
          publicaciones: sinCosto.length, ingreso: Math.round(sinCosto.reduce((s, x) => s + x.lado.ingreso, 0)),
          lista: sinCosto.sort((x, y) => y.lado.ingreso - x.lado.ingreso).slice(0, 10).map((x) => ({ id: x.id, titulo: filas.find((f) => f.id === x.id)?.titulo ?? x.id, ingreso: Math.round(x.lado.ingreso) })),
        },
      };
    }
    const lado = (l: LadoTipoMargen | undefined): LadoProducto | null => l ? { unidades: l.unidades, ingreso: Math.round(l.ingreso), margenPesos: l.margenPesos === null ? null : Math.round(l.margenPesos), margenPct: l.margenPct, estado: l.estado, menosFiable: l.menosFiable } : null;
    const titulos = new Map(filas.map((f) => [f.id, f.titulo]));
    const productos: ProductoFvN[] = [...detalle].map(([id, d]) => ({
      id, titulo: titulos.get(id) ?? id, full: lado(d.full), normal: lado(d.estandar), ingresoTotal: Math.round((d.full?.ingreso ?? 0) + (d.estandar?.ingreso ?? 0)),
    })).sort((x, y) => y.ingresoTotal - x.ingresoTotal);
    margenNormalCompleto.set(p, new Map(productos.filter((x) => x.normal).map((x) => [x.id, x.normal!])));
    return { dias: p, canales, respaldoPct: totalIng > 0 ? r1(((totalIng - ingReal) / totalIng) * 100) : 0, productos: productos.slice(0, MAX_PRODUCTOS_POR_PERIODO), productosTotal: productos.length };
  });

  // ---- Candidatos Normal → Full: rotación y margen actual (sin costo de Full) ----
  const margenNormal = margenNormalCompleto.get(90) ?? margenNormalCompleto.get(periodos[0].dias) ?? new Map<string, LadoProducto>();
  const ventasFull120 = new Set(validas.filter((l) => e.esFull(l)).map((l) => l.item));
  const porItem = new Map<string, { u30: number; u60: number; u90: number; semanas: Set<number>; fullUnidades: number }>();
  const ultimaSemana = Math.floor(e.ahoraMs / SEMANA_MS);
  for (const l of validas) {
    const x = porItem.get(l.item) ?? { u30: 0, u60: 0, u90: 0, semanas: new Set<number>(), fullUnidades: 0 };
    const d = dias(l);
    if (d <= 30) x.u30 += l.cantidad; if (d <= 60) x.u60 += l.cantidad; if (d <= 90) x.u90 += l.cantidad;
    const sem = ultimaSemana - Math.floor(l.ms / SEMANA_MS);
    if (sem >= 0 && sem < 13) x.semanas.add(sem);
    porItem.set(l.item, x);
  }
  const candidatos: Candidato[] = [];
  for (const [id, x] of porItem) {
    const it = e.items.get(id);
    if (!it || it.estado !== "active" || it.full || ventasFull120.has(id) || x.u90 < 5) continue;
    const m = margenNormal.get(id);
    const mu = m && m.estado === "ok" && m.margenPesos !== null && m.unidades > 0 ? Math.round(m.margenPesos / m.unidades) : null;
    candidatos.push({
      id, titulo: it.titulo, u30: x.u30, u60: x.u60, u90: x.u90, semanasConVenta: x.semanas.size,
      margenUnitario: mu, margenPct: m?.margenPct ?? null, menosFiable: m?.menosFiable ?? false,
      margenMes: mu === null ? null : Math.round((x.u90 / 3) * mu), stock: it.stock,
    });
  }
  candidatos.sort((a, b) => (b.margenMes ?? -1e12) - (a.margenMes ?? -1e12) || b.u90 - a.u90);

  // ---- En Full con ventas bajas (stock inmovilizado) ----
  const fullVentasBajas: FullVentasBajas[] = [];
  for (const [id, it] of e.items) {
    if (!it.full || it.estado !== "active" || (it.stock ?? 0) <= 0) continue;
    const x = porItem.get(id);
    const u90 = x?.u90 ?? 0;
    if (u90 > FULL_VENTAS_BAJAS_U90_MAX) continue;
    const costo = e.costoPorItem?.get(id) ?? null;
    fullVentasBajas.push({ id, titulo: it.titulo, stock: it.stock as number, u30: x?.u30 ?? 0, u90, capital: costo !== null && costo > 0 ? Math.round(costo * (it.stock as number)) : null });
  }
  fullVentasBajas.sort((a, b) => (b.capital ?? -1) - (a.capital ?? -1) || b.stock - a.stock);

  return {
    periodos, candidatos, fullVentasBajas,
    umbrales: { u90Min: CANDIDATO_U90_MIN, semanasMin: CANDIDATO_SEMANAS_MIN, fullVentasBajasU90Max: FULL_VENTAS_BAJAS_U90_MAX },
    noEvaluado: [
      "Costos de Full (almacenamiento, envío, ingreso): faltan las tarifas de Chile",
      "Elegibilidad física (tamaño, peso, categoría): sin endpoint probado",
      "Reputación y reclamos por producto",
      "Capacidad de reposición (stock propio)",
      "Campañas activas y ROAS por publicación",
    ],
  };
}

// Qué criterios cumple un candidato con los umbrales vigentes (los edita el usuario en pantalla).
export function evaluarCandidato(c: Candidato, u90Min: number, semanasMin: number): { rotacion: boolean; estable: boolean; margen: boolean; califica: boolean } {
  const rotacion = c.u90 >= u90Min, estable = c.semanasConVenta >= semanasMin, margen = c.margenUnitario !== null && c.margenUnitario > 0;
  return { rotacion, estable, margen, califica: rotacion && estable && margen };
}

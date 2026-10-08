// ACoS real, ACoS de equilibrio y TACoS de Product Ads. Lógica pura (sin llamadas).
//
// DEFINICIONES (todas con las ventas de la MISMA ventana):
//  - ACoS de ML = costo / (ventas atribuidas directas + indirectas). Es el mismo
//    número que reporta ML en `acos` (verificado 2026-10-08: 9,58% en la campaña
//    Top Ventas, 30 días).
//  - ACoS con IVA = ACoS de ML × 1,19 (ver "BASE DE IVA" abajo). Es el que se
//    puede comparar con el margen.
//  - ACoS de equilibrio = margen de contribución ANTES de publicidad de la
//    publicación (lib/tablero-margen.ts, % del precio). Con un ACoS por encima
//    de ese margen, las ventas atribuidas a la campaña no cubren su gasto.
//    En una campaña es el margen ponderado por las ventas atribuidas de cada
//    publicación (solo las que tienen Costo).
//  - TACoS = gasto con IVA / ventas TOTALES. Por publicación: sus ventas totales
//    de la ventana (órdenes). Por campaña: ventas atribuidas + orgánicas que
//    informa ML (organic_units_amount). De la cuenta: ventas totales (Tablero).
//
// BASE DE IVA — verificado contra Billing el 2026-10-08:
//  El costo que devuelve la API de Product Ads viene SIN IVA, mientras que lo que
//  cobra Billing (CHARGE / PADS) lleva IVA, y las ventas atribuidas (como todos
//  los montos de ML) vienen CON IVA. Pruebas:
//   * Cargos diarios de Billing = presupuesto diario × 1,19: $1.785 = $1.500 ×
//     1,19; $3.572 ≈ $3.001 × 1,19; $6.252 = $5.254 × 1,19, y cada uno coincide
//     con el costo diario de la API × 1,19.
//   * Total 15-sep → 8-oct: 24 cargos de Billing = $62.876; costo de la API del
//     14-sep al 7-oct = $52.843 → × 1,19 = $62.883.
//  Por eso el gasto se muestra sin IVA (como lo reporta ML) y con IVA (lo que se
//  paga), y el ACoS se compara con el margen "con IVA" (× 1,19). Si ML cambiara
//  esa base, esta es la única constante que hay que tocar.
//
// EL EQUILIBRIO ES ESTIMADO: depende de la base de IVA del Mayor (Costo) y del
// Costo de Katteyes, ambos pendientes de confirmar; por eso se calcula también
// "si el Mayor fuera neto" (sensibilidad informativa). Compara SOLO ventas
// atribuidas a la campaña: no incluye el efecto de la publicidad sobre las
// ventas orgánicas ni sobre el ranking.
import { IVA } from "@/lib/rentabilidad";
import type { FilaMargen } from "@/lib/tablero-margen";

export const FACTOR_IVA_PUBLICIDAD = 1 + IVA; // 1,19

export type CampanaMl = {
  id: number; nombre: string; estado: string; estrategia: string; acosTarget: number | null; presupuestoDiario: number | null;
  costo: number; directas: number; indirectas: number; organicoMonto: number; organicoUnidades: number; acosMl: number | null;
};
export type AnuncioMl = {
  itemId: string; campaignId: number; estado: string; titulo: string;
  costo: number; directas: number; indirectas: number; organicoUnidades: number; organicoMonto: number;
};

export type Posicion = "sobre" | "bajo";
export type FilaPublicidad = {
  id: string; titulo: string; full: boolean | null; estadoAd: string; campaignId: number; campana: string;
  gastoSinIva: number; gastoConIva: number; atribuidas: number;
  acosMl: number | null; acosConIva: number | null;
  equilibrio: number | null; diferenciaPts: number | null; posicion: Posicion | null;
  equilibrioSiMayorNeto: number | null; posicionSiMayorNeto: Posicion | null;
  ventasTotales: number; tacosConIva: number | null; margenTrasPublicidad: number | null;
  envioEstimado: boolean; motivoSinEquilibrio: string | null;
};
export type FilaCampana = {
  id: number; nombre: string; estado: string; estrategia: string; acosTarget: number | null; presupuestoDiario: number | null;
  gastoSinIva: number; gastoConIva: number; atribuidas: number; organicas: number;
  acosMl: number | null; acosConIva: number | null;
  equilibrio: number | null; equilibrioSiMayorNeto: number | null; coberturaEquilibrioPct: number;
  tacosConIva: number | null; anunciosConGasto: number;
};
export type ResumenPublicidad = {
  gasto: { sinIva: number; conIva: number };
  atribuidas: number;
  acosMl: number | null; acosConIva: number | null;
  equilibrio: number | null; equilibrioSiMayorNeto: number | null; coberturaEquilibrioPct: number;
  tacosCuenta: number | null; ventasCuenta: number;
  margenAntes: number | null; margenDespues: number | null; // aproximado: ver comentario en analizarPublicidad
  sobreEquilibrio: { anuncios: number; gastoConIva: number; pctGasto: number | null; evaluables: number };
  sobreEquilibrioSiMayorNeto: { anuncios: number; gastoConIva: number; pctGasto: number | null; evaluables: number };
  anunciosActivosSinGasto: { total: number; conVentasOrganicas: number };
};

const redondear1 = (x: number) => Math.round(x * 10) / 10;
const pct = (num: number, den: number): number | null => (den > 0 ? redondear1((num / den) * 100) : null);
const posicion = (acos: number | null, eq: number | null): Posicion | null => (acos === null || eq === null ? null : acos > eq ? "sobre" : "bajo");

// Margen de contribución (% del precio) si el Mayor fuera NETO: el Costo bruto
// sería Costo × 1,19. Misma fórmula que calcularMargen (todo ÷ 1,19), sin redondear el neto.
export function margenSiMayorNeto(f: Pick<FilaMargen, "precioProm" | "costo" | "comisionPct" | "envioUnidad">): number | null {
  if (!(f.precioProm > 0) || f.costo === null || f.comisionPct === null || f.envioUnidad === null) return null;
  const comision = f.precioProm * f.comisionPct;
  return redondear1(((f.precioProm - f.costo * FACTOR_IVA_PUBLICIDAD - comision - f.envioUnidad) / f.precioProm) * 100);
}

export type EntradaPublicidad = {
  campanas: CampanaMl[];
  anuncios: AnuncioMl[]; // todos los anuncios de la cuenta con sus métricas de la ventana
  margenFilas: FilaMargen[]; // publicaciones con ventas en la ventana (lib/tablero-margen.ts)
  fullPorItem: Map<string, boolean>;
  ventasCuenta: number; // ventas totales de la cuenta en la ventana (misma base que el Tablero)
  margenTotalPct: number | null; // margen de contribución total del Tablero (antes de publicidad)
};

export function analizarPublicidad(e: EntradaPublicidad): { resumen: ResumenPublicidad; campanas: FilaCampana[]; filas: FilaPublicidad[] } {
  const margenPor = new Map(e.margenFilas.map((f) => [f.id, f]));
  const nombreCampana = new Map(e.campanas.map((c) => [c.id, c.nombre]));

  const conGasto = e.anuncios.filter((a) => a.costo > 0);
  const filas: FilaPublicidad[] = conGasto.map((a) => {
    const m = margenPor.get(a.itemId) ?? null;
    const atribuidas = a.directas + a.indirectas;
    const gastoConIva = a.costo * FACTOR_IVA_PUBLICIDAD;
    const acosMl = pct(a.costo, atribuidas);
    const acosConIva = pct(gastoConIva, atribuidas);
    const equilibrio = m && m.margenPct !== null ? m.margenPct : null;
    const siNeto = m ? margenSiMayorNeto(m) : null;
    const ventasTotales = m?.ingreso ?? 0;
    const tacos = pct(gastoConIva, ventasTotales);
    let motivo: string | null = null;
    if (equilibrio === null) motivo = !m ? "sin ventas en la ventana (no hay comisión ni envío medidos)" : m.estado === "sin_costo" ? "sin Costo" : m.estado === "sin_comision" ? "sin comisión" : "sin envío";
    return {
      id: a.itemId, titulo: a.titulo, full: e.fullPorItem.get(a.itemId) ?? null, estadoAd: a.estado, campaignId: a.campaignId, campana: nombreCampana.get(a.campaignId) ?? `Campaña ${a.campaignId}`,
      gastoSinIva: a.costo, gastoConIva, atribuidas, acosMl, acosConIva,
      equilibrio, diferenciaPts: acosConIva !== null && equilibrio !== null ? redondear1(acosConIva - equilibrio) : null, posicion: posicion(acosConIva, equilibrio),
      equilibrioSiMayorNeto: siNeto, posicionSiMayorNeto: posicion(acosConIva, siNeto),
      ventasTotales, tacosConIva: tacos, margenTrasPublicidad: equilibrio !== null && tacos !== null ? redondear1(equilibrio - tacos) : null,
      envioEstimado: m?.menosFiable ?? false, motivoSinEquilibrio: motivo,
    };
  }).sort((a, b) => b.gastoConIva - a.gastoConIva);

  // Equilibrio ponderado por las ventas atribuidas (solo publicaciones con margen y con ventas atribuidas).
  const ponderado = (sel: FilaPublicidad[], campo: "equilibrio" | "equilibrioSiMayorNeto") => {
    const con = sel.filter((f) => f[campo] !== null && f.atribuidas > 0);
    const peso = con.reduce((s, f) => s + f.atribuidas, 0);
    const total = sel.reduce((s, f) => s + f.atribuidas, 0);
    return {
      valor: peso > 0 ? redondear1(con.reduce((s, f) => s + (f[campo] as number) * f.atribuidas, 0) / peso) : null,
      cobertura: total > 0 ? Math.round((peso / total) * 1000) / 10 : 0,
    };
  };

  const campanas: FilaCampana[] = e.campanas.map((c) => {
    const propias = filas.filter((f) => f.campaignId === c.id);
    const atribuidas = c.directas + c.indirectas;
    const gastoConIva = c.costo * FACTOR_IVA_PUBLICIDAD;
    const eq = ponderado(propias, "equilibrio");
    return {
      id: c.id, nombre: c.nombre, estado: c.estado, estrategia: c.estrategia, acosTarget: c.acosTarget, presupuestoDiario: c.presupuestoDiario,
      gastoSinIva: c.costo, gastoConIva, atribuidas, organicas: c.organicoMonto,
      acosMl: pct(c.costo, atribuidas), acosConIva: pct(gastoConIva, atribuidas),
      equilibrio: eq.valor, equilibrioSiMayorNeto: ponderado(propias, "equilibrioSiMayorNeto").valor, coberturaEquilibrioPct: eq.cobertura,
      tacosConIva: pct(gastoConIva, atribuidas + c.organicoMonto), anunciosConGasto: propias.length,
    };
  }).sort((a, b) => b.gastoConIva - a.gastoConIva);

  // Totales: de las campañas (lo que reporta ML), no de la suma de anuncios.
  const gastoSinIva = e.campanas.reduce((s, c) => s + c.costo, 0);
  const gastoConIva = gastoSinIva * FACTOR_IVA_PUBLICIDAD;
  const atribuidas = e.campanas.reduce((s, c) => s + c.directas + c.indirectas, 0);
  const eqTotal = ponderado(filas, "equilibrio");
  const tacosCuenta = pct(gastoConIva, e.ventasCuenta);
  const sobre = (campo: "posicion" | "posicionSiMayorNeto") => {
    const evaluables = filas.filter((f) => f[campo] !== null);
    const sob = evaluables.filter((f) => f[campo] === "sobre");
    const g = sob.reduce((s, f) => s + f.gastoConIva, 0);
    return { anuncios: sob.length, gastoConIva: Math.round(g), pctGasto: pct(g, evaluables.reduce((s, f) => s + f.gastoConIva, 0)), evaluables: evaluables.length };
  };
  const activosSinGasto = e.anuncios.filter((a) => a.estado === "active" && a.costo === 0);

  return {
    campanas, filas,
    resumen: {
      gasto: { sinIva: Math.round(gastoSinIva), conIva: Math.round(gastoConIva) },
      atribuidas: Math.round(atribuidas),
      acosMl: pct(gastoSinIva, atribuidas), acosConIva: pct(gastoConIva, atribuidas),
      equilibrio: eqTotal.valor, equilibrioSiMayorNeto: ponderado(filas, "equilibrioSiMayorNeto").valor, coberturaEquilibrioPct: eqTotal.cobertura,
      tacosCuenta, ventasCuenta: Math.round(e.ventasCuenta),
      // Aproximado: el margen total del Tablero es % de las ventas CON margen y el TACoS
      // es % de las ventas totales (la diferencia es la cobertura de Costo, ~6%).
      margenAntes: e.margenTotalPct, margenDespues: e.margenTotalPct !== null && tacosCuenta !== null ? redondear1(e.margenTotalPct - tacosCuenta) : null,
      sobreEquilibrio: sobre("posicion"), sobreEquilibrioSiMayorNeto: sobre("posicionSiMayorNeto"),
      anunciosActivosSinGasto: { total: activosSinGasto.length, conVentasOrganicas: activosSinGasto.filter((a) => a.organicoUnidades > 0).length },
    },
  };
}

// Precio para ganar (price_to_win de ML) frente al precio actual y al precio de
// equilibrio. Lógica pura (sin llamadas). SOLO LECTURA y sin sugerir acciones:
// calcula y rotula, nada más.
//
// DEFINICIONES
//  - Precio de equilibrio = precio al que el margen de contribución es 0 (antes de
//    publicidad): (Costo + envío) / (1 − comisión%). Todo bruto (con IVA), igual que
//    el resto de los montos de ML, con el Costo como Mayor con IVA (pendiente de
//    confirmar) — ver lib/tablero-margen.ts.
//  - Precio para ganar = el precio que ML calcula como necesario para ganar el
//    catálogo. NO es el precio del ganador actual: medido 2026-10-08, en 41 de 133
//    publicaciones en competencia el ganador cobra MÁS que nosotros.
//
// POR QUÉ EL EQUILIBRIO A OTRO PRECIO ES "ESTIMADO" (medido 2026-10-08):
//  - La COMISIÓN no cambia con el precio: `listing_prices` da el mismo
//    percentage_fee y fixed_fee = 0 en el precio actual y en el precio para ganar
//    en 133 de 133 publicaciones (y de $990 a $39.990 en 3 categorías). Se usa la
//    comisión real cobrada, fija.
//  - El ENVÍO sí cambia por tramo de precio y por tamaño (estándar: ~$799 hasta
//    ~$9.700, ~$1.000 entre $10.000 y $15.000, ~$1.020 hasta $20.000; Full: $260,
//    $410, $799 o $1.020 según tamaño). A un precio distinto del actual el envío
//    real no se conoce, por eso hay tres versiones:
//      A) envío actual (el del ítem, medido o estimado) → equilibrio principal;
//      B) envío típico del tramo del precio para ganar (estimado);
//      C) envío 0, cota inferior imposible (solo para el resumen).
//    Resultado (133 en competencia): precio para ganar bajo el equilibrio en 131
//    (A), 125 (B) y 79 (C).
//  - "Si el Mayor fuera neto": Costo × 1,19 (sensibilidad informativa).
import { IVA } from "@/lib/rentabilidad";
import type { FilaMargen } from "@/lib/tablero-margen";

export const FACTOR_MAYOR_NETO = 1 + IVA;

export type EstadoCatalogo = "competing" | "winning" | "sharing_first_place" | "not_listed" | "sin_dato";
export type FactorMl = { id: string; descripcion: string; estado: string }; // estado: boosted | opportunity
export type PriceToWinMl = {
  itemId: string; status: EstadoCatalogo; precioActual: number | null; precioParaGanar: number | null;
  visitShare: string | null; competidoresCompartiendo: number | null; razones: string[];
  factores: FactorMl[];
  ganador: { itemId: string; precio: number; factores: FactorMl[] } | null;
};

export type Posicion = "bajo" | "sobre";
const redondear1 = (x: number) => Math.round(x * 10) / 10;

export function precioEquilibrio(costo: number | null, comisionPct: number | null, envio: number | null): number | null {
  if (costo === null || comisionPct === null || envio === null || !(comisionPct < 1)) return null;
  return (costo + envio) / (1 - comisionPct);
}
// Margen de contribución (% del precio) a un precio dado; null si falta algún dato.
export function margenAlPrecio(precio: number, costo: number | null, comisionPct: number | null, envio: number | null): number | null {
  if (!(precio > 0) || costo === null || comisionPct === null || envio === null) return null;
  return redondear1(((precio - costo - precio * comisionPct - envio) / precio) * 100);
}
// El precio para ganar queda BAJO el equilibrio si es menor; igual o mayor = SOBRE.
const posicion = (paraGanar: number | null, eq: number | null): Posicion | null => (paraGanar === null || eq === null ? null : paraGanar < eq ? "bajo" : "sobre");

export type FilaPrecio = {
  id: string; titulo: string; full: boolean; estado: Exclude<EstadoCatalogo, "not_listed" | "sin_dato">;
  visitShare: string | null; competidoresCompartiendo: number | null;
  precioActual: number; precioParaGanar: number; precioGanador: number | null; ganadorCobra: "mas" | "menos" | "igual" | null;
  ingreso30: number; unidades30: number;
  costo: number | null; comisionPct: number | null; envioActual: number | null; envioFuente: "medido" | "estimado" | null; envioEstimado: boolean;
  // Equilibrio principal (A: envío actual) y sensibilidades.
  equilibrio: number | null; brechaPct: number | null; posicion: Posicion | null;
  equilibrioEnvioTramo: number | null; envioTramo: number | null; posicionEnvioTramo: Posicion | null;
  equilibrioMayorNeto: number | null; posicionMayorNeto: Posicion | null;
  margenHoyPct: number | null; margenAlPrecioParaGanarPct: number | null; margenAlPrecioParaGanarTramoPct: number | null;
  factores: FactorMl[]; factoresGanador: FactorMl[]; factoresGanadorQueNoTenemos: string[];
};

type Monto = { n: number; ingreso: number };
export type ResumenPrecio = {
  enTabla: Record<"competing" | "winning" | "sharing_first_place", Monto>;
  noParticipan: { total: Monto; propias: Monto; catalogo: Monto; sinDato: Monto };
  pausadasOtras: { pausadas: Monto; otras: Monto };
  competencia: {
    n: number; evaluables: number;
    bajo: { envioActual: number; envioTramo: number; sinEnvio: number; mayorNeto: number }; ingresoBajoEnvioActual: number;
    brechaMedianaPct: number | null;
    ganadorCobraMas: number; ganadorCobraMenos: number; ganadorCobraIgual: number;
    ganadorMasCaroConFactorQueNoTenemos: number; conFactorDelGanadorQueNoTenemos: number;
    relacionParaGanarSobreGanadorMediana: number | null;
  };
};

export type EntradaPrecio = {
  margenFilas: FilaMargen[]; // publicaciones con ventas en la ventana
  estadoPorItem: Map<string, string>; // estado en ML (active, paused...)
  ptw: Map<string, PriceToWinMl | null>; // solo de las activas consultadas
  esCatalogo: Map<string, boolean>; // de las "not_listed" activas (propia o catálogo)
  // Envío típico del tramo de precio (mediana de lo medido) para un precio distinto del actual; null si no hay muestras.
  envioTipicoTramo: (precio: number, full: boolean) => number | null;
};

const mediana = (v: number[]): number | null => {
  if (v.length === 0) return null;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const sumar = (m: Monto, ingreso: number) => { m.n++; m.ingreso += ingreso; };

export function analizarPrecioParaGanar(e: EntradaPrecio): { filas: FilaPrecio[]; resumen: ResumenPrecio } {
  const vacio = (): Monto => ({ n: 0, ingreso: 0 });
  const resumen: ResumenPrecio = {
    enTabla: { competing: vacio(), winning: vacio(), sharing_first_place: vacio() },
    noParticipan: { total: vacio(), propias: vacio(), catalogo: vacio(), sinDato: vacio() },
    pausadasOtras: { pausadas: vacio(), otras: vacio() },
    competencia: {
      n: 0, evaluables: 0, bajo: { envioActual: 0, envioTramo: 0, sinEnvio: 0, mayorNeto: 0 }, ingresoBajoEnvioActual: 0, brechaMedianaPct: null,
      ganadorCobraMas: 0, ganadorCobraMenos: 0, ganadorCobraIgual: 0, ganadorMasCaroConFactorQueNoTenemos: 0, conFactorDelGanadorQueNoTenemos: 0,
      relacionParaGanarSobreGanadorMediana: null,
    },
  };
  const filas: FilaPrecio[] = [];

  for (const m of e.margenFilas) {
    const estadoMl = e.estadoPorItem.get(m.id) ?? "desconocido";
    if (estadoMl !== "active") { sumar(estadoMl === "paused" ? resumen.pausadasOtras.pausadas : resumen.pausadasOtras.otras, m.ingreso); continue; }
    const p = e.ptw.get(m.id) ?? null;
    if (!p || p.status === "sin_dato" || p.status === "not_listed" || p.precioParaGanar === null || p.precioActual === null) {
      sumar(resumen.noParticipan.total, m.ingreso);
      if (!p || p.status === "sin_dato") sumar(resumen.noParticipan.sinDato, m.ingreso);
      else {
        // Sin el dato de tipo (la consulta falló) no se adivina: queda "sin dato".
        const cat = e.esCatalogo.get(m.id);
        sumar(cat === true ? resumen.noParticipan.catalogo : cat === false ? resumen.noParticipan.propias : resumen.noParticipan.sinDato, m.ingreso);
      }
      continue;
    }
    sumar(resumen.enTabla[p.status as "competing" | "winning" | "sharing_first_place"], m.ingreso);

    const precioParaGanar = p.precioParaGanar;
    const envioTramoTipico = e.envioTipicoTramo(precioParaGanar, m.full);
    // B: si no hay muestras del tramo, se mantiene el envío actual (nunca se inventa).
    const envioTramo = envioTramoTipico !== null && envioTramoTipico > 0 ? envioTramoTipico : m.envioUnidad;
    const eqA = precioEquilibrio(m.costo, m.comisionPct, m.envioUnidad);
    const eqB = precioEquilibrio(m.costo, m.comisionPct, envioTramo);
    const eqC = precioEquilibrio(m.costo, m.comisionPct, 0);
    const eqNeto = precioEquilibrio(m.costo === null ? null : m.costo * FACTOR_MAYOR_NETO, m.comisionPct, m.envioUnidad);

    const ganador = p.ganador;
    const ganadorCobra = ganador ? (ganador.precio > p.precioActual ? "mas" : ganador.precio < p.precioActual ? "menos" : "igual") : null;
    const boosted = (l: FactorMl[]) => new Set(l.filter((f) => f.estado === "boosted").map((f) => f.id));
    const nuestros = boosted(p.factores);
    const queNoTenemos = ganador ? [...boosted(ganador.factores)].filter((id) => !nuestros.has(id)) : [];

    filas.push({
      id: m.id, titulo: m.titulo, full: m.full, estado: p.status as FilaPrecio["estado"], visitShare: p.visitShare, competidoresCompartiendo: p.competidoresCompartiendo,
      precioActual: p.precioActual, precioParaGanar, precioGanador: ganador?.precio ?? null, ganadorCobra,
      ingreso30: m.ingreso, unidades30: m.unidades,
      costo: m.costo, comisionPct: m.comisionPct, envioActual: m.envioUnidad, envioFuente: m.envioFuente === "estimado_otro_tipo" ? "estimado" : m.envioFuente, envioEstimado: m.menosFiable,
      equilibrio: eqA, brechaPct: eqA !== null ? redondear1(((eqA - precioParaGanar) / eqA) * 100) : null, posicion: posicion(precioParaGanar, eqA),
      equilibrioEnvioTramo: eqB, envioTramo, posicionEnvioTramo: posicion(precioParaGanar, eqB),
      equilibrioMayorNeto: eqNeto, posicionMayorNeto: posicion(precioParaGanar, eqNeto),
      margenHoyPct: m.margenPct, margenAlPrecioParaGanarPct: margenAlPrecio(precioParaGanar, m.costo, m.comisionPct, m.envioUnidad),
      margenAlPrecioParaGanarTramoPct: margenAlPrecio(precioParaGanar, m.costo, m.comisionPct, envioTramo),
      factores: p.factores, factoresGanador: ganador?.factores ?? [], factoresGanadorQueNoTenemos: queNoTenemos,
    });

    if (p.status === "competing") {
      const c = resumen.competencia;
      c.n++;
      if (ganadorCobra === "mas") { c.ganadorCobraMas++; if (queNoTenemos.length > 0) c.ganadorMasCaroConFactorQueNoTenemos++; }
      else if (ganadorCobra === "menos") c.ganadorCobraMenos++;
      else if (ganadorCobra === "igual") c.ganadorCobraIgual++;
      if (queNoTenemos.length > 0) c.conFactorDelGanadorQueNoTenemos++;
      if (eqA !== null && eqB !== null && eqC !== null && eqNeto !== null) {
        c.evaluables++;
        if (precioParaGanar < eqA) { c.bajo.envioActual++; c.ingresoBajoEnvioActual += m.ingreso; }
        if (precioParaGanar < eqB) c.bajo.envioTramo++;
        if (precioParaGanar < eqC) c.bajo.sinEnvio++;
        if (precioParaGanar < eqNeto) c.bajo.mayorNeto++;
      }
    }
  }

  const comp = filas.filter((f) => f.estado === "competing");
  const brechas = comp.map((f) => f.brechaPct).filter((x): x is number => x !== null);
  resumen.competencia.brechaMedianaPct = mediana(brechas);
  const rel = comp.filter((f) => f.precioGanador !== null && f.precioGanador > 0).map((f) => f.precioParaGanar / (f.precioGanador as number));
  const relM = mediana(rel);
  resumen.competencia.relacionParaGanarSobreGanadorMediana = relM === null ? null : Math.round(relM * 100) / 100;
  resumen.competencia.ingresoBajoEnvioActual = Math.round(resumen.competencia.ingresoBajoEnvioActual);
  return { filas, resumen };
}

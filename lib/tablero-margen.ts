// Margen de contribución del Tablero, por publicación y total, EN PORCENTAJE.
// (El margen en pesos queda fuera hasta confirmar la base de IVA del Mayor.)
//
// Misma fórmula e insumos que la tabla por producto de Métricas, para que los
// números cuadren:
//  - base: precio, comisión y envío son BRUTOS (con IVA); se llevan a neto con
//    calcularMargen (÷1,19), igual que el Costo (Mayor tratado como bruto).
//  - comisión: la REAL cobrada (sale_fee × cantidad de las órdenes de la
//    ventana). Si una publicación vendió sin sale_fee en alguna línea, esa
//    línea no entra al % de comisión; sin ninguna línea con sale_fee, queda
//    "sin comisión" (no se inventa una tasa).
//  - envío: tarifa MEDIDA de TarifaEnvio (resolverEnvio); si es estimada o
//    viene del respaldo por tramo, la fila queda marcada "menos fiable". En
//    Full la estimación es la menos fiable (error mediano 49% medido
//    2026-10-07, ver lib/envio-medido.ts).
//  - precio: promedio realmente vendido en la ventana (Métricas usa el precio
//    vigente de la hoja; coinciden cuando no hubo cambios de precio).
// Sin Costo (o sin envío / comisión) la fila NO tiene margen: no se asume 0.
import { calcularMargen, IVA } from "@/lib/rentabilidad";
import { resolverEnvio } from "@/lib/envio-medido";
import type { ContextoEnvio } from "@/lib/envio-medido";
import type { LineaVenta } from "@/lib/tablero-datos";

export const MARGEN_BAJO_PCT = 10;

export type EstadoMargen = "ok" | "sin_costo" | "sin_envio" | "sin_comision";
export type FilaMargen = {
  id: string; titulo: string; full: boolean;
  unidades: number; ingreso: number; precioProm: number;
  costo: number | null; comisionPct: number | null;
  envioUnidad: number | null; envioFuente: "medido" | "estimado" | null;
  margenPct: number | null;
  estado: EstadoMargen;
  menosFiable: boolean; // envío estimado (más aún si es Full)
  pierde: boolean;
  fueraDeAlcance: boolean; // cerrada/inactiva sin Costo: no entra a los totales ni a "sin Costo"
};
export type SubtotalMargen = {
  ingreso: number; // ingreso de las filas con margen
  margenPct: number | null;
  publicaciones: number;
};
export type ResumenMargen = {
  total: SubtotalMargen & { coberturaPct: number; ingresoVentana: number };
  porTipo: { full: SubtotalMargen; estandar: SubtotalMargen };
  menosFiable: { pctIngreso: number; fullEstimado: number }; // % del ingreso con margen que depende de envío estimado
  pierden: { publicaciones: number; pctIngreso: number };
  margenBajo: { publicaciones: number }; // 0 <= margen < MARGEN_BAJO_PCT
  sinCosto: { publicaciones: number; pctIngreso: number };
};

export type EntradaMargen = {
  lineas: LineaVenta[]; // solo las de la ventana
  costoPorItem: Map<string, number | null>;
  fullPorItem: Map<string, boolean>;
  skuPorItem: Map<string, string>;
  ctxEnvio: ContextoEnvio;
  fueraDeAlcance?: Set<string>; // closed/inactive: sin Costo no cuentan como faltante ni en la cobertura
};

const redondear1 = (x: number) => Math.round(x * 10) / 10;

export function analizarMargen(e: EntradaMargen): { filas: FilaMargen[]; resumen: ResumenMargen } {
  const acc = new Map<string, { titulo: string; u: number; ing: number; ingFee: number; fee: number }>();
  for (const l of e.lineas) {
    const a = acc.get(l.item) ?? { titulo: l.titulo, u: 0, ing: 0, ingFee: 0, fee: 0 };
    a.u += l.cantidad;
    a.ing += l.cantidad * l.precio;
    if (l.fee !== null) { a.ingFee += l.cantidad * l.precio; a.fee += l.cantidad * l.fee; }
    acc.set(l.item, a);
  }

  // margenNeto total (pesos, solo interno para ponderar: NO sale en la API).
  const interno = new Map<string, { margenNeto: number; ingresoNeto: number }>();
  const filas: FilaMargen[] = [];
  for (const [id, a] of acc) {
    const precioProm = a.u > 0 ? a.ing / a.u : 0;
    const full = e.fullPorItem.get(id) ?? false;
    const costoRaw = e.costoPorItem.get(id) ?? null;
    const costo = costoRaw !== null && costoRaw > 0 ? costoRaw : null;
    const comisionPct = a.ingFee > 0 ? a.fee / a.ingFee : null;
    const envio = resolverEnvio(id, precioProm, full, e.skuPorItem.get(id) ?? null, e.ctxEnvio);
    let estado: EstadoMargen = "ok";
    if (costo === null) estado = "sin_costo";
    else if (comisionPct === null) estado = "sin_comision";
    else if (envio.envio === null) estado = "sin_envio";
    let margenPct: number | null = null;
    if (estado === "ok" && costo !== null && comisionPct !== null && envio.envio !== null) {
      const m = calcularMargen(precioProm, costo, precioProm * comisionPct, envio.envio, 0);
      margenPct = m.margenPct;
      if (m.margenNeto !== null) interno.set(id, { margenNeto: m.margenNeto * a.u, ingresoNeto: (precioProm / (1 + IVA)) * a.u });
    }
    filas.push({
      id, titulo: a.titulo, full, unidades: a.u, ingreso: a.ing, precioProm: Math.round(precioProm),
      costo, comisionPct: comisionPct !== null ? Math.round(comisionPct * 1000) / 1000 : null,
      envioUnidad: envio.envio, envioFuente: envio.fuente, margenPct, estado,
      menosFiable: envio.fuente === "estimado", pierde: margenPct !== null && margenPct < 0,
      fueraDeAlcance: estado === "sin_costo" && (e.fueraDeAlcance?.has(id) ?? false),
    });
  }
  filas.sort((x, y) => y.ingreso - x.ingreso);

  const sub = (f: (x: FilaMargen) => boolean): SubtotalMargen => {
    const sel = filas.filter((x) => x.margenPct !== null && f(x));
    const mn = sel.reduce((s, x) => s + (interno.get(x.id)?.margenNeto ?? 0), 0);
    const ing = sel.reduce((s, x) => s + (interno.get(x.id)?.ingresoNeto ?? 0), 0);
    return { ingreso: Math.round(sel.reduce((s, x) => s + x.ingreso, 0)), margenPct: ing > 0 ? redondear1((mn / ing) * 100) : null, publicaciones: sel.length };
  };
  const enAlcance = filas.filter((x) => !x.fueraDeAlcance);
  const ingresoVentana = enAlcance.reduce((s, x) => s + x.ingreso, 0);
  const conMargen = sub(() => true);
  const pct = (x: number, base: number) => (base > 0 ? Math.round((x / base) * 1000) / 10 : 0);
  const sinCosto = enAlcance.filter((x) => x.estado === "sin_costo");
  const pierden = filas.filter((x) => x.pierde);
  return {
    filas,
    resumen: {
      total: { ...conMargen, coberturaPct: pct(conMargen.ingreso, ingresoVentana), ingresoVentana: Math.round(ingresoVentana) },
      porTipo: { full: sub((x) => x.full), estandar: sub((x) => !x.full) },
      menosFiable: {
        pctIngreso: pct(sub((x) => x.menosFiable).ingreso, conMargen.ingreso),
        fullEstimado: filas.filter((x) => x.margenPct !== null && x.menosFiable && x.full).length,
      },
      pierden: { publicaciones: pierden.length, pctIngreso: pct(pierden.reduce((s, x) => s + x.ingreso, 0), ingresoVentana) },
      margenBajo: { publicaciones: filas.filter((x) => x.margenPct !== null && x.margenPct >= 0 && x.margenPct < MARGEN_BAJO_PCT).length },
      sinCosto: { publicaciones: sinCosto.length, pctIngreso: pct(sinCosto.reduce((s, x) => s + x.ingreso, 0), ingresoVentana) },
    },
  };
}

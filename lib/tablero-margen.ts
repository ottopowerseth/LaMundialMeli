// Margen de contribución del Tablero, por publicación y total, en porcentaje y en pesos.
// Base de IVA del Mayor: SUPUESTO, pendiente de confirmar con una factura de compra real.
// Se asume que el Mayor de la Lista Defontana TRAE IVA (es bruto), así que el Costo se
// trata como bruto y se lleva a neto con el resto. Si el Mayor fuera neto, el margen (en %
// y en pesos) estaría sobreestimado. Margen en pesos = margen NETO (sin IVA, antes de
// publicidad) de las unidades vendidas en la ventana; siempre es una ESTIMACIÓN (comisión
// real, pero envío medido o estimado, y Mayor ≠ costo de reposición).
//
// Misma fórmula e insumos que la tabla por producto de Métricas, para que los
// números cuadren:
//  - base: precio, comisión y envío son BRUTOS (con IVA); se llevan a neto con
//    calcularMargen (÷1,19), igual que el Costo (Mayor tratado como bruto).
//  - comisión: la REAL cobrada (sale_fee × cantidad de las órdenes de la
//    ventana). Si una publicación vendió sin sale_fee en alguna línea, esa
//    línea no entra al % de comisión; sin ninguna línea con sale_fee, queda
//    "sin comisión" (no se inventa una tasa).
//  - envío: tarifa MEDIDA de TarifaEnvio del tipo logístico de la venta
//    (resolverEnvio); si es estimada, es la del OTRO tipo o viene del respaldo
//    por tramo, la fila queda marcada "menos fiable". En
//    Full la estimación es la menos fiable (error mediano 49% medido
//    2026-10-07, ver lib/envio-medido.ts).
//  - precio: promedio realmente vendido en la ventana (Métricas usa el precio
//    vigente de la hoja; coinciden cuando no hubo cambios de precio).
// Sin Costo (o sin envío / comisión) la fila NO tiene margen: no se asume 0.
//
// Full vs estándar: cada línea de venta usa el tipo logístico REAL de su orden
// (LineaVenta.logistic, de ShippingCache); si la orden no tiene entrada, el tipo
// ACTUAL de la publicación (fullPorItem) como respaldo. Una publicación que
// vendió en los dos tipos dentro de la ventana calcula su envío por tipo (cada
// tipo con su tarifa) y su margen es la suma; su fila muestra el tipo
// predominante y el envío promedio ponderado por unidades. Con un solo tipo, y
// siendo el mismo que el actual, el resultado es idéntico al criterio anterior.
import { calcularMargen, IVA } from "@/lib/rentabilidad";
import { resolverEnvio } from "@/lib/envio-medido";
import type { ContextoEnvio, FuenteEnvio } from "@/lib/envio-medido";
import type { LineaVenta } from "@/lib/tablero-datos";
import { grupoLogistico } from "@/lib/logistica";

export const MARGEN_BAJO_PCT = 10;

export type EstadoMargen = "ok" | "sin_costo" | "sin_envio" | "sin_comision";
export type FilaMargen = {
  id: string; titulo: string; full: boolean;
  unidades: number; ingreso: number; precioProm: number;
  costo: number | null; comisionPct: number | null;
  envioUnidad: number | null; envioFuente: FuenteEnvio | null;
  margenPct: number | null;
  margenPesos: number | null; // margen neto estimado de las unidades vendidas en la ventana (CLP, sin IVA, antes de publicidad)
  estado: EstadoMargen;
  menosFiable: boolean; // envío estimado, incluido el de otro tipo logístico (más aún si es Full)
  pierde: boolean;
  fueraDeAlcance: boolean; // cerrada/inactiva sin Costo: no entra a los totales ni a "sin Costo"
};
export type SubtotalMargen = {
  ingreso: number; // ingreso de las filas con margen
  margenPct: number | null;
  margenPesos: number; // suma del margen neto estimado de esas filas (CLP, sin IVA, antes de publicidad)
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
  type PorTipo = { u: number; ing: number };
  const acc = new Map<string, { titulo: string; u: number; ing: number; ingFee: number; fee: number; tipos: Map<boolean, PorTipo> }>();
  for (const l of e.lineas) {
    const a = acc.get(l.item) ?? { titulo: l.titulo, u: 0, ing: 0, ingFee: 0, fee: 0, tipos: new Map<boolean, PorTipo>() };
    a.u += l.cantidad;
    a.ing += l.cantidad * l.precio;
    if (l.fee !== null) { a.ingFee += l.cantidad * l.precio; a.fee += l.cantidad * l.fee; }
    const esFullLinea = l.logistic ? grupoLogistico(l.logistic) === "Full" : (e.fullPorItem.get(l.item) ?? false);
    const t = a.tipos.get(esFullLinea) ?? { u: 0, ing: 0 };
    t.u += l.cantidad; t.ing += l.cantidad * l.precio;
    a.tipos.set(esFullLinea, t);
    acc.set(l.item, a);
  }

  // margenNeto total en pesos (neto, de todas las unidades de la ventana): pondera el % y sale como margenPesos.
  // porTipo guarda lo mismo repartido entre Full (true) y estándar (false), con el ingreso bruto de cada tipo.
  const interno = new Map<string, { margenNeto: number; ingresoNeto: number; ingresoMenosFiable: number; porTipo: Map<boolean, { margenNeto: number; ingresoNeto: number; ingreso: number }> }>();
  const filas: FilaMargen[] = [];
  for (const [id, a] of acc) {
    const precioProm = a.u > 0 ? a.ing / a.u : 0;
    // Tipo predominante (por ingreso) de la publicación en la ventana: lo que muestra la fila.
    let full = false, mayorIng = -1;
    for (const [esF, t] of a.tipos) if (t.ing > mayorIng) { full = esF; mayorIng = t.ing; }
    const costoRaw = e.costoPorItem.get(id) ?? null;
    const costo = costoRaw !== null && costoRaw > 0 ? costoRaw : null;
    const comisionPct = a.ingFee > 0 ? a.fee / a.ingFee : null;
    // Envío por tipo logístico; la fila muestra el promedio ponderado por unidades.
    const envioPorTipo = new Map<boolean, ReturnType<typeof resolverEnvio>>();
    for (const esF of a.tipos.keys()) envioPorTipo.set(esF, resolverEnvio(id, precioProm, esF, e.skuPorItem.get(id) ?? null, e.ctxEnvio));
    const envios = [...envioPorTipo.values()];
    const envio: ReturnType<typeof resolverEnvio> = envios.some((x) => x.envio === null)
      ? { envio: null, fuente: null }
      : envios.length === 1
        ? envios[0]
        : {
            // Promedio ponderado por unidades; si todos los tipos tienen la misma tarifa, esa misma (sin ruido de coma flotante).
            envio: envios.every((x) => x.envio === envios[0].envio)
              ? envios[0].envio
              : Math.round(([...a.tipos].reduce((s, [esF, t]) => s + (envioPorTipo.get(esF)!.envio as number) * t.u, 0) / a.u) * 100) / 100,
            fuente: envios.some((x) => x.fuente === "estimado_otro_tipo") ? "estimado_otro_tipo"
              : envios.some((x) => x.fuente === "estimado") ? "estimado" : "medido",
          };
    let estado: EstadoMargen = "ok";
    if (costo === null) estado = "sin_costo";
    else if (comisionPct === null) estado = "sin_comision";
    else if (envio.envio === null) estado = "sin_envio";
    let margenPct: number | null = null;
    if (estado === "ok" && costo !== null && comisionPct !== null && envio.envio !== null) {
      const porTipoMargen = new Map<boolean, { margenNeto: number; ingresoNeto: number; ingreso: number }>();
      let mNetoTotal = 0, completo = true;
      for (const [esF, t] of a.tipos) {
        const mt = calcularMargen(precioProm, costo, precioProm * comisionPct, envioPorTipo.get(esF)!.envio as number, 0);
        if (mt.margenNeto === null) { completo = false; continue; }
        porTipoMargen.set(esF, { margenNeto: mt.margenNeto * t.u, ingresoNeto: (precioProm / (1 + IVA)) * t.u, ingreso: t.ing });
        mNetoTotal += mt.margenNeto * t.u;
      }
      const ingNetoTotal = (precioProm / (1 + IVA)) * a.u;
      if (a.tipos.size === 1) {
        margenPct = calcularMargen(precioProm, costo, precioProm * comisionPct, envio.envio, 0).margenPct;
      } else if (completo && ingNetoTotal > 0) {
        margenPct = Math.round((mNetoTotal / ingNetoTotal) * 1000) / 10;
      }
      // Ingreso (bruto) de las ventas cuyo envío no es medido: se cuenta por tipo de venta, no por fila, para que una
      // publicación mixta no marque como estimado todo su ingreso.
      const ingresoMenosFiable = [...a.tipos].reduce((acc, [esF, t]) => acc + (envioPorTipo.get(esF)!.fuente !== "medido" ? t.ing : 0), 0);
      if (completo) interno.set(id, { margenNeto: mNetoTotal, ingresoNeto: ingNetoTotal, ingresoMenosFiable, porTipo: porTipoMargen });
    }
    filas.push({
      id, titulo: a.titulo, full, unidades: a.u, ingreso: a.ing, precioProm: Math.round(precioProm),
      costo, comisionPct: comisionPct !== null ? Math.round(comisionPct * 1000) / 1000 : null,
      envioUnidad: envio.envio, envioFuente: envio.fuente, margenPct,
      margenPesos: interno.has(id) ? Math.round(interno.get(id)!.margenNeto) : null, estado,
      menosFiable: envio.fuente !== null && envio.fuente !== "medido", pierde: margenPct !== null && margenPct < 0,
      fueraDeAlcance: estado === "sin_costo" && (e.fueraDeAlcance?.has(id) ?? false),
    });
  }
  filas.sort((x, y) => y.ingreso - x.ingreso);

  const sub = (f: (x: FilaMargen) => boolean): SubtotalMargen => {
    const sel = filas.filter((x) => x.margenPct !== null && f(x));
    const mn = sel.reduce((s, x) => s + (interno.get(x.id)?.margenNeto ?? 0), 0);
    const ing = sel.reduce((s, x) => s + (interno.get(x.id)?.ingresoNeto ?? 0), 0);
    return { ingreso: Math.round(sel.reduce((s, x) => s + x.ingreso, 0)), margenPct: ing > 0 ? redondear1((mn / ing) * 100) : null, margenPesos: Math.round(mn), publicaciones: sel.length };
  };
  // Subtotal por tipo logístico de la VENTA (no de la publicación): una publicación que vendió en los
  // dos tipos aporta a ambos; "publicaciones" la cuenta en cada uno.
  const subTipo = (esFull: boolean): SubtotalMargen => {
    let mn = 0, ing = 0, ingBruto = 0, n = 0;
    for (const x of filas) {
      const t = x.margenPct !== null ? interno.get(x.id)?.porTipo.get(esFull) : undefined;
      if (!t) continue;
      mn += t.margenNeto; ing += t.ingresoNeto; ingBruto += t.ingreso; n++;
    }
    return { ingreso: Math.round(ingBruto), margenPct: ing > 0 ? redondear1((mn / ing) * 100) : null, margenPesos: Math.round(mn), publicaciones: n };
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
      porTipo: { full: subTipo(true), estandar: subTipo(false) },
      menosFiable: {
        pctIngreso: pct(filas.filter((x) => x.margenPct !== null).reduce((acc, x) => acc + (interno.get(x.id)?.ingresoMenosFiable ?? 0), 0), conMargen.ingreso),
        fullEstimado: filas.filter((x) => x.margenPct !== null && x.menosFiable && x.full).length,
      },
      pierden: { publicaciones: pierden.length, pctIngreso: pct(pierden.reduce((s, x) => s + x.ingreso, 0), ingresoVentana) },
      margenBajo: { publicaciones: filas.filter((x) => x.margenPct !== null && x.margenPct >= 0 && x.margenPct < MARGEN_BAJO_PCT).length },
      sinCosto: { publicaciones: sinCosto.length, pctIngreso: pct(sinCosto.reduce((s, x) => s + x.ingreso, 0), ingresoVentana) },
    },
  };
}

// Tipo logístico REAL de cada orden (hoja ShippingCache, `logistic_type` de
// /shipments/{id}) y su agrupación para las vistas. El valor crudo se guarda tal
// cual en LineaVenta.logistic; se agrupa solo al mostrar.
//
// Las órdenes sin entrada en ShippingCache usan el tipo ACTUAL de la publicación
// (respaldo): se cuentan aparte para que se vea cuánto del ingreso es real y
// cuánto es respaldo.
import type { LineaVenta } from "@/lib/tablero-datos";

export type GrupoLogistico = "Full" | "Despacho/punto" | "Flex" | "Otro" | "Sin clasificar";
export const GRUPOS_LOGISTICOS: GrupoLogistico[] = ["Full", "Despacho/punto", "Flex", "Otro", "Sin clasificar"];

export function grupoLogistico(raw: string | null | undefined): GrupoLogistico {
  const v = String(raw ?? "").trim();
  if (v === "") return "Sin clasificar";
  if (v === "fulfillment") return "Full";
  if (v === "xd_drop_off" || v === "cross_docking" || v === "drop_off") return "Despacho/punto";
  if (v === "self_service") return "Flex";
  return "Otro";
}

// ShippingCache!A2:C → id de orden → logistic_type crudo. Si una orden tiene
// varias filas (68 duplicadas, sin conflictos de tipo) gana la última con tipo.
export function parsearLogisticoPorOrden(filas: unknown[][]): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of filas) {
    const id = String(f[0] ?? "").replace(/^'/, "").trim();
    const tipo = String(f[2] ?? "").trim();
    if (id && tipo) out.set(id, tipo);
  }
  return out;
}

// Pega el tipo crudo a cada línea (null = sin entrada). Muta las líneas: son un
// campo extra que ninguna otra sección lee.
export function asignarLogistico(lineas: LineaVenta[], porOrden: Map<string, string>): void {
  for (const l of lineas) l.logistic = porOrden.get(l.orden) ?? null;
}

export type TipoRespaldo = "fulfillment" | "otro" | null; // tipo actual de la publicación (null = sin dato)

export type CoberturaLogistica = {
  ingresoVentana: number;
  real: { ingreso: number; pct: number };       // con entrada en ShippingCache
  respaldo: { ingreso: number; pct: number };   // sin entrada: tipo actual de la publicación
  sinDato: { ingreso: number; pct: number };    // sin entrada ni tipo actual
  // Desglose por grupo de lo REAL, y del respaldo (solo se sabe Full / no Full).
  porGrupo: Record<GrupoLogistico, { ingreso: number; pct: number; ordenes: number }>;
  respaldoPorTipo: { full: number; noFull: number };
};

// Cobertura del tipo real sobre las líneas de la ventana. `fullActual` da el
// tipo actual de cada publicación (true = fulfillment); ausente = sin dato.
export function coberturaLogistica(lineas: LineaVenta[], fullActual: Map<string, boolean>): CoberturaLogistica {
  const ing = (l: LineaVenta) => l.cantidad * l.precio;
  const porGrupo = Object.fromEntries(GRUPOS_LOGISTICOS.map((g) => [g, { ingreso: 0, pct: 0, ordenes: new Set<string>() }])) as
    Record<GrupoLogistico, { ingreso: number; pct: number; ordenes: Set<string> }>;
  let total = 0, real = 0, respaldo = 0, sinDato = 0, rFull = 0, rNoFull = 0;
  for (const l of lineas) {
    const m = ing(l);
    total += m;
    if (l.logistic) {
      real += m;
      const g = porGrupo[grupoLogistico(l.logistic)];
      g.ingreso += m; g.ordenes.add(l.orden);
    } else if (fullActual.has(l.item)) {
      respaldo += m;
      if (fullActual.get(l.item)) rFull += m; else rNoFull += m;
    } else {
      sinDato += m;
    }
  }
  const pct = (x: number) => (total > 0 ? Math.round((x / total) * 1000) / 10 : 0);
  return {
    ingresoVentana: Math.round(total),
    real: { ingreso: Math.round(real), pct: pct(real) },
    respaldo: { ingreso: Math.round(respaldo), pct: pct(respaldo) },
    sinDato: { ingreso: Math.round(sinDato), pct: pct(sinDato) },
    porGrupo: Object.fromEntries(GRUPOS_LOGISTICOS.map((g) => [g, { ingreso: Math.round(porGrupo[g].ingreso), pct: pct(porGrupo[g].ingreso), ordenes: porGrupo[g].ordenes.size }])) as CoberturaLogistica["porGrupo"],
    respaldoPorTipo: { full: Math.round(rFull), noFull: Math.round(rNoFull) },
  };
}

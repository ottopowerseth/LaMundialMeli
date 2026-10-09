// Panel de reposición de Full — lógica pura (sin llamadas). El endpoint del Tablero
// junta los datos que YA carga (estado y stock de /items, ventas con tipo logístico real,
// velocidad corregida del Tablero y margen unitario) y esto arma las filas.
//
// Dos grupos:
//  - "pausada": publicación pausada por out_of_stock que vendió por Full en los últimos 120 días.
//  - "por_agotarse": activa, hoy en Full, con velocidad >= VELOCIDAD_MIN y cobertura
//    (disponible ÷ velocidad) <= UMBRAL_POR_AGOTARSE_DIAS.
//
// Definiciones (todas configurables, ver las constantes):
//  - velocidad: la del Tablero (unidades/día de su ventana de 30 días, corregida por los días
//    sin stock), con piso en las unidades Full de 90 días ÷ 90. Es de la PUBLICACIÓN (suma de canales): si vendió mucho por Normal antes de pasar
//    a Full, puede sobrestimar el ritmo de Full. Las columnas f30/f60/f90 son solo unidades Full.
//  - margen unitario: margen neto (sin IVA, antes de publicidad) por unidad de los últimos 120
//    días. MEZCLA lo vendido por Full y por Normal. No incluye costos propios de Full (sin tarifas).
//  - margen perdido por día = velocidad × margen unitario (solo si el margen unitario es > 0).
//  - sugerido = ceil(velocidad × cobertura objetivo − disponible), mínimo 0. No se sugiere cuando
//    el margen unitario es <= 0 o no hay Costo: la fila queda "revisar".
import type { LineaVenta } from "@/lib/tablero-datos";

export const COBERTURA_OBJETIVO_DIAS = 30;
export const UMBRAL_POR_AGOTARSE_DIAS = 21; // igual que COBERTURA_REPONER_DIAS del Tablero
export const VELOCIDAD_MIN_POR_AGOTARSE = 0.3; // unidades/día
const DIA_MS = 86400000;

export type ItemReposicion = { id: string; titulo: string; estado: string; subEstado: string[]; stock: number | null; full: boolean };
export type VelocidadItem = { velocidad: number; diasSinStock: number; velocidadConfiable: boolean };
export type MotivoRevisar = "margen_negativo" | "sin_costo";

export type FilaReposicion = {
  id: string; titulo: string;
  tipo: "pausada" | "por_agotarse";
  disponible: number | null;
  f30: number; f60: number; f90: number; f120: number; // unidades vendidas por Full
  n90: number; // unidades por otro canal en 90 días (si > 0, el margen y la velocidad mezclan canales)
  velocidad: number; velocidadConfiable: boolean;
  margenUnitario: number | null; // CLP netos por unidad, mezcla de canales
  cobertura: number | null; // días = disponible ÷ velocidad
  margenPerdidoDia: number | null; // CLP netos por día
  sugerido: number | null; // con COBERTURA_OBJETIVO_DIAS; el cliente puede recalcular con sugeridoPara
  revisar: MotivoRevisar | null;
};

export type ResultadoReposicion = {
  filas: FilaReposicion[];
  resumen: { pausadas: number; porAgotarse: number; revisar: number; margenPerdidoDiaTotal: number; sugeridoTotal: number };
  supuestos: { coberturaObjetivoDias: number; umbralPorAgotarseDias: number; velocidadMinPorAgotarse: number };
};

export function sugeridoPara(velocidad: number, disponible: number | null, coberturaObjetivoDias: number): number {
  return Math.max(0, Math.ceil(velocidad * coberturaObjetivoDias - (disponible ?? 0)));
}

export function armarReposicion(e: {
  items: ItemReposicion[];
  velocidades: Map<string, VelocidadItem>;
  lineas: Pick<LineaVenta, "item" | "cantidad" | "ms" | "logistic">[];
  ahoraMs: number;
  margenUnitario: Map<string, number | null>;
  coberturaObjetivoDias?: number;
}): ResultadoReposicion {
  const objetivo = e.coberturaObjetivoDias ?? COBERTURA_OBJETIVO_DIAS;
  const u = new Map<string, { f: [number, number, number, number]; n90: number }>();
  for (const l of e.lineas) {
    const dias = (e.ahoraMs - l.ms) / DIA_MS;
    if (dias < 0 || dias > 120) continue;
    const x = u.get(l.item) ?? { f: [0, 0, 0, 0] as [number, number, number, number], n90: 0 };
    if (l.logistic === "fulfillment") [30, 60, 90, 120].forEach((d, i) => { if (dias <= d) x.f[i] += l.cantidad; });
    else if (l.logistic && dias <= 90) x.n90 += l.cantidad;
    u.set(l.item, x);
  }

  const filas: FilaReposicion[] = [];
  for (const it of e.items) {
    const x = u.get(it.id);
    const pausada = it.estado === "paused" && it.subEstado.includes("out_of_stock") && !!x && x.f[3] > 0;
    const vel = e.velocidades.get(it.id);
    // Piso: el promedio Full de 90 días. Una publicación que dejó de vender hace más de 30 días (pausada por
    // falta de stock) tiene velocidad 0 en la ventana de 30 días del Tablero y no se vería.
    const velocidad = Math.max(vel?.velocidad ?? 0, x ? x.f[2] / 90 : 0);
    const cobertura = it.stock !== null && velocidad > 0 ? Math.round((it.stock / velocidad) * 10) / 10 : null;
    const porAgotarse = it.estado === "active" && it.full && velocidad >= VELOCIDAD_MIN_POR_AGOTARSE && cobertura !== null && cobertura <= UMBRAL_POR_AGOTARSE_DIAS;
    if (!pausada && !porAgotarse) continue;

    const mu = e.margenUnitario.get(it.id) ?? null;
    const revisar: MotivoRevisar | null = mu === null ? "sin_costo" : mu <= 0 ? "margen_negativo" : null;
    filas.push({
      id: it.id, titulo: it.titulo, tipo: pausada ? "pausada" : "por_agotarse", disponible: it.stock,
      f30: x?.f[0] ?? 0, f60: x?.f[1] ?? 0, f90: x?.f[2] ?? 0, f120: x?.f[3] ?? 0, n90: x?.n90 ?? 0,
      velocidad: Math.round(velocidad * 100) / 100, velocidadConfiable: vel?.velocidadConfiable ?? false,
      margenUnitario: mu === null ? null : Math.round(mu),
      cobertura: pausada ? 0 : cobertura,
      margenPerdidoDia: mu !== null && mu > 0 ? Math.round(velocidad * mu) : null,
      sugerido: revisar ? null : sugeridoPara(velocidad, it.stock, objetivo),
      revisar,
    });
  }
  filas.sort((a, b) => (b.margenPerdidoDia ?? -1) - (a.margenPerdidoDia ?? -1) || b.f90 - a.f90);
  return {
    filas,
    resumen: {
      pausadas: filas.filter((f) => f.tipo === "pausada").length,
      porAgotarse: filas.filter((f) => f.tipo === "por_agotarse").length,
      revisar: filas.filter((f) => f.revisar).length,
      margenPerdidoDiaTotal: filas.reduce((s, f) => s + (f.margenPerdidoDia ?? 0), 0),
      sugeridoTotal: filas.reduce((s, f) => s + (f.sugerido ?? 0), 0),
    },
    supuestos: { coberturaObjetivoDias: objetivo, umbralPorAgotarseDias: UMBRAL_POR_AGOTARSE_DIAS, velocidadMinPorAgotarse: VELOCIDAD_MIN_POR_AGOTARSE },
  };
}

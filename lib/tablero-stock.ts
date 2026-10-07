// Stock del Tablero: días sin stock, velocidad de venta corregida, clase ABC,
// estados de cobertura y la alerta "pausado por falta de stock con ventas".
//
// Todo es lógica pura (sin llamadas): el endpoint junta los datos y esto los
// analiza. Los días son días UTC, igual que el resto del Tablero.
//
// POR QUÉ la velocidad corrige los días sin stock: dividir las unidades de 30
// días por 30 subestima la venta real de un SKU que estuvo agotado parte del
// mes (medido 2026-10-07: 23 de los 52 Full tuvieron días sin stock en 30
// días; el Fijador de Maquillaje 22 de 30 — vendió 131 unidades en 8 días
// disponibles, 16/día, no 4,4/día). Eso a su vez subestima cuánto stock hay
// que reponer y cuánto ingreso se pierde.
//
// CÓMO se detectan los días sin stock (ML no guarda historial de stock en la
// publicación). Señal principal, para TODAS las publicaciones relevantes:
//  1. Visitas diarias (/items/{id}/visits/time_window): una publicación
//     agotada se pausa y deja de recibir visitas (Plaisance bajó de 92 a 1
//     visita/día; los días con 0 visitas no aparecen en la serie). Regla:
//     ≥3 días SEGUIDOS con 0 visitas, solo en publicaciones con tráfico
//     mediano ≥3 visitas/día. Un día con ventas nunca cuenta como sin stock.
//  2. Pausada por falta de stock → los días posteriores a su última venta.
// CALIBRACIÓN (2026-10-07): Full sí expone el historial exacto de inventario
// (/stock/fulfillment/operations/search, stock resultante en cada operación),
// y contra esa verdad (52 Full, 30 días) la regla de 1 día daba precisión 61%
// y la de ≥3 días seguidos 91% (recall 63%; con ≥4 días, 95%/60%). Ese
// endpoint NO se usa en vivo: su cuota es ~3 llamadas por ~15 s (las 52
// consultas tardarían 4-5 minutos) y el rango máximo es de 60 días. Con las
// visitas, sobre los 47 Full evaluados, se recupera ~60% de los días sin stock
// y el estado de cobertura de ninguna publicación cambia respecto de la
// verdad exacta.
// Es una estimación: donde el recall es parcial la velocidad queda algo
// subestimada (la regla no la sobreestima).
import type { LineaVenta } from "@/lib/tablero-datos";

export const DIA_MS = 86400000;
// Decisiones de Otto (2026-10-07): SKU A alerta con cobertura <= lead time
// (15 d) + colchón = 21 días; sobrestock (>90 d) solo para B/C; muerto = 0
// ventas en 90 días. ABC sobre ingreso de 90 días (A hasta 80%, B hasta 95%).
export const COBERTURA_REPONER_DIAS = 21;
export const COBERTURA_SOBRESTOCK_DIAS = 90;
export const CORTE_ABC_A = 0.8;
export const CORTE_ABC_B = 0.95;
export const RACHA_MIN_SIN_VISITAS = 3;
export const TRAFICO_MEDIANO_MIN = 3;
export const MIN_DIAS_DISPONIBLES_CONFIABLE = 7;
export const TOPE_DIAS_PERDIDOS = 30;

export const diaKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export function diasEntre(desdeMs: number, hastaMs: number): string[] {
  const out: string[] = [];
  for (let t = desdeMs; t < hastaMs; t += DIA_MS) out.push(diaKey(t));
  return out;
}

// ---------- Días sin stock ----------
export function diasSinStockVisitas(
  visitasPorDia: Record<string, number>,
  diasConVenta: Set<string>,
  desdeMs: number,
  hastaMs: number,
  ahoraMs: number
): Set<string> {
  const out = new Set<string>();
  const presentes = Object.values(visitasPorDia).sort((a, b) => a - b);
  const mediana = presentes.length ? presentes[Math.floor(presentes.length / 2)] : 0;
  if (mediana < TRAFICO_MEDIANO_MIN) return out; // poco tráfico: 0 visitas es normal, no es señal
  const hoy = diaKey(ahoraMs); // el día en curso es parcial: no entra a las rachas
  const dias = diasEntre(desdeMs, hastaMs).filter((d) => d !== hoy);
  let i = 0;
  while (i < dias.length) {
    const sinVisitas = (d: string) => (visitasPorDia[d] ?? 0) === 0 && !diasConVenta.has(d);
    if (!sinVisitas(dias[i])) { i++; continue; }
    let j = i;
    while (j < dias.length && sinVisitas(dias[j])) j++;
    if (j - i >= RACHA_MIN_SIN_VISITAS) for (let k = i; k < j; k++) out.add(dias[k]);
    i = j;
  }
  return out;
}

// Pausada por falta de stock: sin stock desde el día siguiente a su última venta.
export function diasSinStockPorUltimaVenta(ultimaVentaMs: number | null, hastaMs: number): Set<string> {
  const out = new Set<string>();
  if (ultimaVentaMs === null) return out;
  const inicio = Date.UTC(new Date(ultimaVentaMs).getUTCFullYear(), new Date(ultimaVentaMs).getUTCMonth(), new Date(ultimaVentaMs).getUTCDate() + 1);
  for (const d of diasEntre(inicio, hastaMs)) out.add(d);
  return out;
}

// ---------- Velocidad ----------
export type Velocidad = { ingenua: number; ajustada: number; diasDisponibles: number; confiable: boolean };
export function calcularVelocidad(unidades: number, diasVentana: number, diasSinStock: number): Velocidad {
  const diasDisponibles = Math.max(0, diasVentana - diasSinStock);
  return {
    ingenua: unidades / diasVentana,
    ajustada: unidades / Math.max(diasDisponibles, 1),
    diasDisponibles,
    confiable: diasDisponibles >= MIN_DIAS_DISPONIBLES_CONFIABLE,
  };
}

// ---------- ABC ----------
export type ClaseAbc = "A" | "B" | "C" | "S"; // S = sin ventas en 90 días
export function clasificarAbc(ingreso90PorItem: Map<string, number>): Map<string, ClaseAbc> {
  const orden = [...ingreso90PorItem.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const total = orden.reduce((s, [, v]) => s + v, 0);
  const out = new Map<string, ClaseAbc>();
  let acumulado = 0;
  for (const [id, v] of orden) {
    // La publicación que cruza el corte pertenece a la clase superior.
    const antes = total > 0 ? acumulado / total : 0;
    out.set(id, antes < CORTE_ABC_A ? "A" : antes < CORTE_ABC_B ? "B" : "C");
    acumulado += v;
  }
  return out;
}

// ---------- Estado de cobertura ----------
export type EstadoStock = "sin_stock" | "reponer" | "sobrestock" | "muerto" | "ok";
export function estadoStock(abc: ClaseAbc, stock: number | null, cobertura: number | null): EstadoStock {
  if (stock === null || stock <= 0) return "sin_stock";
  if (abc === "S") return "muerto";
  if (abc === "A" && cobertura !== null && cobertura <= COBERTURA_REPONER_DIAS) return "reponer";
  if ((abc === "B" || abc === "C") && cobertura !== null && cobertura > COBERTURA_SOBRESTOCK_DIAS) return "sobrestock";
  return "ok";
}

export function accionStock(estado: EstadoStock, full: boolean): string {
  if (estado === "reponer") return full ? "Enviar stock a la bodega (Full)" : "Reponer";
  if (estado === "sobrestock") return "Revisar: sobrestock (>90 días)";
  if (estado === "muerto") return "Revisar: sin ventas en 90 días";
  if (estado === "sin_stock") return full ? "Enviar stock a la bodega (Full) y reactivar" : "Reponer y reactivar";
  return "";
}

// ---------- Análisis completo ----------
export type ItemStock = {
  id: string; titulo: string; estado: string; subEstado: string[];
  stock: number | null; full: boolean; costo: number | null; precio: number;
};
export type EntradaStock = {
  items: ItemStock[];
  lineas: LineaVenta[]; // ≥ 90 días hasta hastaMs
  desdeMs: number; hastaMs: number; // ventana de velocidad (30 d)
  ahoraMs: number;
  visitas: Map<string, Record<string, number>>; // serie diaria de visitas (60 d) por publicación
};
export type FilaStock = {
  id: string; titulo: string; estado: string; abc: ClaseAbc; full: boolean; stock: number | null;
  unidades30: number; ingreso30: number; ingreso90: number;
  velocidadIngenua: number; velocidad: number; velocidadConfiable: boolean;
  diasSinStock: number; diasDisponibles: number; fuenteDisponibilidad: "visitas" | "última venta" | "sin dato";
  cobertura: number | null; coberturaIngenua: number | null;
  estadoStock: EstadoStock; estadoStockIngenuo: EstadoStock; accion: string;
  costo: number | null; capital: number | null;
};
export type FilaAlerta = {
  id: string; titulo: string; full: boolean; ingreso30: number; tasaDiaria: number;
  diasSinVender: number; ingresoPerdido: number; accion: string;
};
export type ResumenStock = {
  activas: number; pausadas: number; pausadasSinStockConVentas: number;
  abc: Record<ClaseAbc, number>;
  porEstado: Record<EstadoStock, number>;
  capital: { inmovilizado: number; pctConCosto: number };
  perdido: { total: number; publicaciones: number };
  deteccion: {
    conDiasSinStock: number;
    porFuente: Record<string, number>;
    cambianEstado: number;
    ejemplosCambio: { id: string; titulo: string; de: EstadoStock; a: EstadoStock; velocidadIngenua: number; velocidad: number }[];
  };
};

const sumar = <T,>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);

export function analizarStock(e: EntradaStock): { filas: FilaStock[]; alerta: FilaAlerta[]; resumen: ResumenStock } {
  const dias30 = Math.round((e.hastaMs - e.desdeMs) / DIA_MS);
  const desde90 = e.hastaMs - 90 * DIA_MS;
  const desdeAmplio = e.hastaMs - 60 * DIA_MS; // para la tasa previa a la pausa

  const ingreso90 = new Map<string, number>();
  const unidades30 = new Map<string, number>();
  const ingreso30 = new Map<string, number>();
  const ultimaVenta = new Map<string, number>();
  const diasConVenta = new Map<string, Set<string>>();
  for (const l of e.lineas) {
    if (l.ms >= desde90 && l.ms < e.hastaMs) ingreso90.set(l.item, (ingreso90.get(l.item) ?? 0) + l.cantidad * l.precio);
    if (l.ms >= e.desdeMs && l.ms < e.hastaMs) {
      unidades30.set(l.item, (unidades30.get(l.item) ?? 0) + l.cantidad);
      ingreso30.set(l.item, (ingreso30.get(l.item) ?? 0) + l.cantidad * l.precio);
    }
    if (l.ms < e.hastaMs) {
      ultimaVenta.set(l.item, Math.max(ultimaVenta.get(l.item) ?? 0, l.ms));
      const s = diasConVenta.get(l.item) ?? new Set<string>();
      s.add(diaKey(l.ms));
      diasConVenta.set(l.item, s);
    }
  }
  const abc = clasificarAbc(ingreso90);

  // Días sin stock por publicación en la ventana amplia (60 d), según la mejor señal.
  const sinStock = new Map<string, { dias: Set<string>; fuente: FilaStock["fuenteDisponibilidad"] }>();
  for (const it of e.items) {
    const ult = ultimaVenta.get(it.id) ?? null;
    const pausadaSinStock = it.estado === "paused" && it.subEstado.includes("out_of_stock");
    let dias = new Set<string>();
    let fuente: FilaStock["fuenteDisponibilidad"] = "sin dato";
    const vis = e.visitas.get(it.id);
    if (vis) {
      dias = diasSinStockVisitas(vis, diasConVenta.get(it.id) ?? new Set(), desdeAmplio, e.hastaMs, e.ahoraMs);
      fuente = "visitas";
    }
    if (pausadaSinStock && ult !== null) {
      const antes = dias.size;
      for (const d of diasSinStockPorUltimaVenta(ult, e.hastaMs)) dias.add(d);
      if (dias.size > antes && fuente === "sin dato") fuente = "última venta";
    }
    // Un día con ventas nunca estuvo sin stock.
    const conVenta = diasConVenta.get(it.id);
    if (conVenta) for (const d of conVenta) dias.delete(d);
    sinStock.set(it.id, { dias, fuente });
  }

  const ventana30 = new Set(diasEntre(e.desdeMs, e.hastaMs));
  const filas: FilaStock[] = e.items.map((it) => {
    const ss = sinStock.get(it.id)!;
    const dSin30 = [...ss.dias].filter((d) => ventana30.has(d)).length;
    const u30 = unidades30.get(it.id) ?? 0;
    const vel = calcularVelocidad(u30, dias30, dSin30);
    const stock = it.stock;
    const clase: ClaseAbc = abc.get(it.id) ?? "S";
    const cobertura = stock !== null && stock > 0 && vel.ajustada > 0 ? stock / vel.ajustada : null;
    const coberturaIng = stock !== null && stock > 0 && vel.ingenua > 0 ? stock / vel.ingenua : null;
    const estado = estadoStock(clase, stock, cobertura);
    const capital = it.costo !== null && stock !== null && stock > 0 ? it.costo * stock : null;
    return {
      id: it.id, titulo: it.titulo, estado: it.estado, abc: clase, full: it.full, stock,
      unidades30: u30, ingreso30: ingreso30.get(it.id) ?? 0, ingreso90: ingreso90.get(it.id) ?? 0,
      velocidadIngenua: vel.ingenua, velocidad: vel.ajustada, velocidadConfiable: vel.confiable,
      diasSinStock: dSin30, diasDisponibles: vel.diasDisponibles, fuenteDisponibilidad: ss.fuente,
      cobertura, coberturaIngenua: coberturaIng,
      estadoStock: estado, estadoStockIngenuo: estadoStock(clase, stock, coberturaIng),
      accion: accionStock(estado, it.full), costo: it.costo, capital,
    };
  });

  // Alerta: pausada por falta de stock con ventas en los últimos 30 días.
  const alerta: FilaAlerta[] = [];
  for (const it of e.items) {
    if (!(it.estado === "paused" && it.subEstado.includes("out_of_stock"))) continue;
    if ((unidades30.get(it.id) ?? 0) <= 0) continue;
    const ult = ultimaVenta.get(it.id);
    if (!ult) continue;
    // Tasa: ingreso de los 30 días que terminan en la última venta, dividido
    // por los días en que SÍ había stock en ese período (excluye los agotados).
    const iniPrevio = ult - 30 * DIA_MS;
    const ingPrevio = sumar(e.lineas.filter((l) => l.item === it.id && l.ms > iniPrevio && l.ms <= ult), (l) => l.cantidad * l.precio);
    const diasPrevio = diasEntre(Math.max(iniPrevio, desdeAmplio), ult + DIA_MS);
    const ss = sinStock.get(it.id)!;
    const sinPrevio = diasPrevio.filter((d) => ss.dias.has(d)).length;
    const tasa = ingPrevio / Math.max(1, 30 - sinPrevio);
    const diasSinVender = (e.ahoraMs - ult) / DIA_MS;
    alerta.push({
      id: it.id, titulo: it.titulo, full: it.full, ingreso30: ingreso30.get(it.id) ?? 0, tasaDiaria: tasa,
      diasSinVender, ingresoPerdido: tasa * Math.min(diasSinVender, TOPE_DIAS_PERDIDOS), accion: accionStock("sin_stock", it.full),
    });
  }
  alerta.sort((a, b) => b.ingresoPerdido - a.ingresoPerdido);

  const abcCont: Record<ClaseAbc, number> = { A: 0, B: 0, C: 0, S: 0 };
  const porEstado: Record<EstadoStock, number> = { sin_stock: 0, reponer: 0, sobrestock: 0, muerto: 0, ok: 0 };
  const activas = filas.filter((f) => f.estado === "active");
  for (const f of activas) { abcCont[f.abc]++; porEstado[f.estadoStock]++; }
  const inmovilizables = filas.filter((f) => (f.estadoStock === "sobrestock" || f.estadoStock === "muerto") && f.stock !== null && f.stock > 0);
  const conCosto = inmovilizables.filter((f) => f.capital !== null);
  const cambian = filas.filter((f) => f.estadoStock !== f.estadoStockIngenuo);
  const porFuente: Record<string, number> = {};
  for (const f of filas) if (f.diasSinStock > 0) porFuente[f.fuenteDisponibilidad] = (porFuente[f.fuenteDisponibilidad] ?? 0) + 1;
  return {
    filas, alerta,
    resumen: {
      activas: activas.length, pausadas: filas.filter((f) => f.estado === "paused").length, pausadasSinStockConVentas: alerta.length,
      abc: abcCont, porEstado,
      capital: { inmovilizado: sumar(conCosto, (f) => f.capital ?? 0), pctConCosto: inmovilizables.length ? Math.round((conCosto.length / inmovilizables.length) * 1000) / 10 : 100 },
      perdido: { total: sumar(alerta, (a) => a.ingresoPerdido), publicaciones: alerta.length },
      deteccion: {
        conDiasSinStock: filas.filter((f) => f.diasSinStock > 0).length, porFuente, cambianEstado: cambian.length,
        ejemplosCambio: cambian.slice(0, 8).map((f) => ({ id: f.id, titulo: f.titulo, de: f.estadoStockIngenuo, a: f.estadoStock, velocidadIngenua: f.velocidadIngenua, velocidad: f.velocidad })),
      },
    },
  };
}

// Publicaciones cuya serie de visitas hace falta para detectar días sin stock:
// las clases A y B (las que mueven el negocio, Full o no) y las pausadas por
// falta de stock con ventas en la ventana (para la tasa de la alerta). Mantiene
// acotadas las llamadas (hoy ~180 de ~620) — ML limita las ráfagas de visitas.
export function candidatosVisitas(items: ItemStock[], lineas: LineaVenta[], desdeMs: number, hastaMs: number): string[] {
  const desde90 = hastaMs - 90 * DIA_MS;
  const ing90 = new Map<string, number>();
  const u30 = new Map<string, number>();
  for (const l of lineas) {
    if (l.ms >= desde90 && l.ms < hastaMs) ing90.set(l.item, (ing90.get(l.item) ?? 0) + l.cantidad * l.precio);
    if (l.ms >= desdeMs && l.ms < hastaMs) u30.set(l.item, (u30.get(l.item) ?? 0) + l.cantidad);
  }
  const abc = clasificarAbc(ing90);
  return items
    .filter((it) => ["active", "paused"].includes(it.estado))
    .filter((it) => {
      const c = abc.get(it.id);
      const pausadaOos = it.estado === "paused" && it.subEstado.includes("out_of_stock") && (u30.get(it.id) ?? 0) > 0;
      return c === "A" || c === "B" || pausadaOos;
    })
    .map((it) => it.id);
}

// Envío por unidad estimado — compartido entre metrics/route.ts (Costo
// máx.) y comparador-mayor/route.ts (Neto ML), para no duplicar la lógica
// ni divergir entre los dos endpoints que la usan.
//
// Fuente primaria: hoja Rentabilidad (columna "Envío por Unidad", ya
// calculada por rentabilidad/analyze — ver envioPorUnidad en
// lib/rentabilidad.ts) — SIEMPRE por unidad, nunca envío total de la
// orden (gotcha ya corregido: mezclar órdenes de 1 y de varias unidades
// del mismo ítem infla el número).
//
// MEDIANA, no promedio simple (decisión de Otto, 2026-09-30): el envío
// real por unidad de un mismo ítem varía mucho entre órdenes (confirmado
// con datos reales — Aer Limón tiene muestras de $0 a $7.888 por unidad,
// probablemente por región/promociones puntuales, no por el ítem en sí).
// Un promedio simple se deja arrastrar por esos extremos; la mediana da
// el envío "típico" real.

const TRAMOS_PRECIO_ENVIO: { hasta: number; nombre: string }[] = [
  { hasta: 10000, nombre: "<$10k" },
  { hasta: 20000, nombre: "$10-20k" },
  { hasta: 30000, nombre: "$20-30k" },
  { hasta: Infinity, nombre: ">$30k" },
];

export function mediana(valores: number[]): number {
  const ordenados = [...valores].sort((a, b) => a - b);
  const mitad = Math.floor(ordenados.length / 2);
  return ordenados.length % 2 !== 0
    ? ordenados[mitad]
    : (ordenados[mitad - 1] + ordenados[mitad]) / 2;
}

export type MuestrasEnvio = {
  porItem: Map<string, number[]>;
  // Por tramo de precio + logistic_type ("fulfillment" | otro) — separado
  // para que el fallback pueda preferir el envío típico de Full cuando el
  // ítem sin dato propio es Full (Full es sistemáticamente más barato,
  // confirmado: ~55% menos que envío estándar en la investigación de
  // costo de envío del 2026-09-29).
  porTramoYLogistico: Map<string, number[]>;
};

// Lee Rentabilidad!A2:O100000 una sola vez y arma ambos índices. El caller
// pasa las filas ya leídas (no hace la llamada a Sheets acá) para que quien
// ya tenga otro uso de esas filas no repita la lectura.
//
// logisticoPorItem es opcional: cuando no se pasa (o un ítem no aparece en
// el mapa), las muestras de ese ítem se agrupan bajo "otro" — el caller que
// no necesita discriminar por Full/estándar simplemente no obtendrá el
// beneficio de esa preferencia, pero el tramo simple sigue funcionando.
export function armarMuestrasEnvio(
  filasRentabilidad: string[][],
  logisticoPorItem?: Map<string, string>
): MuestrasEnvio {
  const porItem = new Map<string, number[]>();
  const porTramoYLogistico = new Map<string, number[]>();
  for (const fila of filasRentabilidad) {
    const itemId = fila[2];
    const precioVentaBruto = Number(fila[4]);
    const envioPorUnidadBruto = Number(fila[14]);
    if (!itemId || Number.isNaN(precioVentaBruto) || Number.isNaN(envioPorUnidadBruto)) continue;

    if (!porItem.has(itemId)) porItem.set(itemId, []);
    porItem.get(itemId)!.push(envioPorUnidadBruto);

    const tramo = TRAMOS_PRECIO_ENVIO.find((t) => precioVentaBruto < t.hasta)!.nombre;
    // El logistic_type de ESTE ítem al momento de leer Publicaciones — no
    // hay forma de saber el logistic_type histórico de cada orden vieja,
    // así que se agrupa por el logistic_type ACTUAL del ítem que generó
    // la venta. Aproximación razonable: la mayoría de los ítems no cambian
    // de Full a estándar seguido.
    const logistico = logisticoPorItem?.get(itemId) === "fulfillment" ? "fulfillment" : "otro";
    const clave = `${tramo}|${logistico}`;
    if (!porTramoYLogistico.has(clave)) porTramoYLogistico.set(clave, []);
    porTramoYLogistico.get(clave)!.push(envioPorUnidadBruto);
  }
  return { porItem, porTramoYLogistico };
}

export type EnvioEstimadoResultado = { envio: number; fuente: "item" | "tramo"; muestras: number };

// Envío por unidad estimado (bruto) para un ítem: mediana real del ítem si
// Rentabilidad ya tiene datos de él; si no, mediana del tramo de precio ×
// logistic_type del ítem (Full si el ítem es Full, si no el tramo general).
// Nunca 0 quirúrgico como "sin dato" — 0 subestima el costo real y sobre-
// infla el margen mostrado (bug corregido 2026-09-30); si ni el ítem ni el
// tramo tienen muestras, se devuelve fuente "tramo" con 0 muestras y el
// caller decide cómo mostrarlo (ver envioFuente "sin_dato" en el Comparador).
export function calcularEnvioEstimadoPorUnidad(
  itemId: string,
  precioVentaBruto: number,
  esFull: boolean,
  muestras: MuestrasEnvio
): EnvioEstimadoResultado {
  const enviosItem = muestras.porItem.get(itemId);
  if (enviosItem && enviosItem.length > 0) {
    return { envio: mediana(enviosItem), fuente: "item", muestras: enviosItem.length };
  }
  const tramo = TRAMOS_PRECIO_ENVIO.find((t) => precioVentaBruto < t.hasta)!.nombre;
  const claveFull = `${tramo}|fulfillment`;
  const claveOtro = `${tramo}|otro`;
  // Preferir la muestra del mismo logistic_type del ítem; si no hay
  // muestras para ese logistic_type específico, usar la del otro grupo
  // dentro del mismo tramo antes que devolver 0.
  const clavePreferida = esFull ? claveFull : claveOtro;
  const claveAlterna = esFull ? claveOtro : claveFull;
  const muestrasPreferidas = muestras.porTramoYLogistico.get(clavePreferida);
  if (muestrasPreferidas && muestrasPreferidas.length > 0) {
    return { envio: mediana(muestrasPreferidas), fuente: "tramo", muestras: muestrasPreferidas.length };
  }
  const muestrasAlternas = muestras.porTramoYLogistico.get(claveAlterna);
  if (muestrasAlternas && muestrasAlternas.length > 0) {
    return { envio: mediana(muestrasAlternas), fuente: "tramo", muestras: muestrasAlternas.length };
  }
  return { envio: 0, fuente: "tramo", muestras: 0 };
}

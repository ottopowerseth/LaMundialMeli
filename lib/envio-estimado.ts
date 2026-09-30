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
  // Otras publicaciones con el mismo SELLER_SKU — cuando La Mundial tiene
  // más de una publicación activa para el mismo producto físico (mismo
  // proveedor/código), el envío real de la publicación "hermana" es una
  // mejor referencia que el tramo genérico: mismo producto, mismo peso,
  // mismo costo de despacho — solo cambia el listing de ML. Confirmado con
  // el caso real de Serum Dream Liso (MLC1684430515 y MLC3086531836, mismo
  // producto, dos publicaciones): el envío por unidad de la que sí tiene
  // datos (mediana ~$810-1.866, 3 muestras) es una referencia mucho más
  // cercana a la realidad que la mediana genérica del tramo <$10k
  // ($2.430, 358 muestras, mezcla de decenas de productos sin relación).
  porSku: Map<string, number[]>;
  // Por tramo de precio + logistic_type ("fulfillment" | otro) — separado
  // para que el fallback pueda preferir el envío típico de Full cuando el
  // ítem sin dato propio es Full. Gotcha confirmado con datos reales
  // (2026-09-30, investigación de la "tarifa $799,4" de los Aer): esa
  // tarifa NO es "envío por unidad del pack" — es la tarifa fija de Full
  // (logistic_type=fulfillment, confirmado vía /shipments/{id} en 3 de 3
  // casos), sistemáticamente mucho más barata y estable que xd_drop_off
  // (envío estándar, que varía $1.598-$6.789 por distancia/región real del
  // despacho, sin relación con la cantidad de unidades de la orden).
  porTramoYLogistico: Map<string, number[]>;
};

// Lee Rentabilidad!A2:O100000 una sola vez y arma los tres índices. El
// caller pasa las filas ya leídas (no hace la llamada a Sheets acá) para
// que quien ya tenga otro uso de esas filas no repita la lectura.
//
// skuPorItem y logisticoPorItem son opcionales: cuando no se pasan (o un
// ítem no aparece en el mapa), ese nivel del fallback simplemente no tiene
// muestras propias y se salta al siguiente nivel.
export function armarMuestrasEnvio(
  filasRentabilidad: string[][],
  skuPorItem?: Map<string, string>,
  logisticoPorItem?: Map<string, string>
): MuestrasEnvio {
  const porItem = new Map<string, number[]>();
  const porSku = new Map<string, number[]>();
  const porTramoYLogistico = new Map<string, number[]>();
  for (const fila of filasRentabilidad) {
    const itemId = fila[2];
    const precioVentaBruto = Number(fila[4]);
    const envioPorUnidadBruto = Number(fila[14]);
    if (!itemId || Number.isNaN(precioVentaBruto) || Number.isNaN(envioPorUnidadBruto)) continue;

    if (!porItem.has(itemId)) porItem.set(itemId, []);
    porItem.get(itemId)!.push(envioPorUnidadBruto);

    const sku = skuPorItem?.get(itemId);
    if (sku) {
      if (!porSku.has(sku)) porSku.set(sku, []);
      porSku.get(sku)!.push(envioPorUnidadBruto);
    }

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
  return { porItem, porSku, porTramoYLogistico };
}

export type EnvioEstimadoResultado = { envio: number; fuente: "item" | "sku" | "tramo"; muestras: number };

// Envío por unidad estimado (bruto) para un ítem — orden de prioridad
// (decisión de Otto, 2026-09-30):
//   1. Mediana real de ESTE ítem en Rentabilidad.
//   2. Mediana de OTRA publicación con el mismo SELLER_SKU (mismo producto
//      físico, otro listing de ML) — si `sku` no se pasa o no hay otra
//      publicación con datos, se salta este nivel.
//   3. Mediana del tramo de precio × logistic_type del ítem (Full si el
//      ítem es Full, si no estándar) — mismo tramo/logístico primero,
//      el otro logístico dentro del mismo tramo como último recurso antes
//      de rendirse.
// Nunca 0 quirúrgico como "sin dato" — 0 subestima el costo real y sobre-
// infla el margen mostrado (bug corregido 2026-09-30); si ningún nivel
// tiene muestras, se devuelve fuente "tramo" con 0 muestras y el caller
// decide cómo mostrarlo (ver envioFuente "sin_dato" en el Comparador).
export function calcularEnvioEstimadoPorUnidad(
  itemId: string,
  precioVentaBruto: number,
  esFull: boolean,
  muestras: MuestrasEnvio,
  sku?: string | null
): EnvioEstimadoResultado {
  const enviosItem = muestras.porItem.get(itemId);
  if (enviosItem && enviosItem.length > 0) {
    return { envio: mediana(enviosItem), fuente: "item", muestras: enviosItem.length };
  }

  if (sku) {
    const enviosSku = muestras.porSku.get(sku);
    if (enviosSku && enviosSku.length > 0) {
      return { envio: mediana(enviosSku), fuente: "sku", muestras: enviosSku.length };
    }
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

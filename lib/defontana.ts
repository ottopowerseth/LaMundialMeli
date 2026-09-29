// Lista de precios de proveedor (Defontana) — referencia de Costo cuando no
// hay costo de compra real. Ver docs/estado-metricas-y-pendientes.md,
// sección "Lista Defontana / Comparador vs Mayor" para el diseño completo.
//
// Se usa el precio MAYOR (columna MAYOR del Excel), que viene CON IVA, por
// unidad — decisión de Otto (2026-09-30), no hay costo de compra real
// disponible. La lista se sube manualmente y mensualmente vía
// /api/lista-defontana/importar, reemplazando la hoja completa.

export type FilaDefontana = {
  proveedor: string;
  marca: string;
  familia: string;
  cod: string;
  barras: string;
  articulo: string;
  mayor: number;
};

// Columnas de la hoja "Lista Defontana" en Sheets — mismo orden que
// HEADERS_LISTA_DEFONTANA en el endpoint de importación.
export const HEADERS_LISTA_DEFONTANA = [
  "Proveedor", "Marca", "Familia", "Cod", "Barras", "Articulo", "Mayor", "Cargado",
];

// Normalización del cero para códigos Aer: confirmado empíricamente
// (2026-09-29) que ML tiene el código sin un cero extra que sí trae
// Defontana para los packs de caja x6 — ej. ML usa "COS022117" y Defontana
// "COS0022117" para el mismo producto (PACK AER CAJA 6 UN LEMON). Sin esta
// normalización, los 4 Aer (top-venta real, ~289 unidades/mes) no cruzan.
// Patrón: prefijo "COS" seguido de dígitos — se prueba también la variante
// con un "0" insertado justo después del prefijo, en ambos sentidos (por si
// el código de ML alguna vez trae el cero de más en vez de Defontana).
function variantesCodigoAer(cod: string): string[] {
  const variantes = [cod];
  const m = cod.match(/^(COS)0*(\d+)$/);
  if (m) {
    variantes.push(`COS0${m[2]}`);
    if (m[2].startsWith("0")) variantes.push(`COS${m[2].slice(1)}`);
  }
  return [...new Set(variantes)];
}

// Cruza un ítem de Publicaciones (por SELLER_SKU, con fallback a GTIN/EAN)
// contra el mapa de la Lista Defontana ya cargado. No hace ninguna llamada
// — cálculo puro, testeable, reutilizable desde cualquier endpoint que
// necesite el cruce (Publicaciones, Comparador).
export function cruzarConDefontana(
  sellerSku: string | null,
  gtin: string | null,
  porCod: Map<string, FilaDefontana>,
  porBarras: Map<string, FilaDefontana>
): FilaDefontana | null {
  if (sellerSku) {
    const codNormalizado = sellerSku.trim().toUpperCase();
    for (const variante of variantesCodigoAer(codNormalizado)) {
      const match = porCod.get(variante);
      if (match) return match;
    }
  }
  if (gtin) {
    const match = porBarras.get(gtin.trim());
    if (match) return match;
  }
  return null;
}

// Arma los mapas de cruce (por cod y por barras) a partir de las filas
// crudas leídas de la hoja Lista Defontana — separado de cruzarConDefontana
// para que el caller lea la hoja una sola vez y reutilice los mapas para
// todas las publicaciones, en vez de reconstruirlos por cada cruce.
export function armarMapasDefontana(filas: FilaDefontana[]): {
  porCod: Map<string, FilaDefontana>;
  porBarras: Map<string, FilaDefontana>;
} {
  const porCod = new Map<string, FilaDefontana>();
  const porBarras = new Map<string, FilaDefontana>();
  for (const fila of filas) {
    if (fila.cod) porCod.set(fila.cod.trim().toUpperCase(), fila);
    if (fila.barras) porBarras.set(fila.barras.trim(), fila);
  }
  return { porCod, porBarras };
}

// Tabla de equivalencias manual — para publicaciones cuyo código de
// Defontana es un "(WEB)" (precio al público, no mayorista real — ver
// docs) o cualquier otro caso donde el MAYOR directo del cruce no sirve
// de referencia. Se guarda como componentes + cantidad (cod de un artículo
// SUELTO de Defontana × cantidad), NO como un monto fijo — así el precio de
// referencia se recalcula solo cuando la lista cambia, sin tener que
// re-cargar la equivalencia a mano cada mes. Una publicación puede tener
// más de una fila (combos de varios componentes distintos, ej. shampoo +
// acondicionador) — el precio de referencia es la SUMA de todos sus
// componentes × su cantidad.
export type FilaEquivalencia = {
  publicacionId: string;
  componenteCod: string;
  cantidad: number;
};

export const HEADERS_EQUIVALENCIAS = ["Publicacion ID", "Componente Cod", "Cantidad"];

// Precio de referencia de una publicación con equivalencia manual: suma del
// MAYOR de cada componente × su cantidad. Si algún componente no está en la
// lista Defontana actual (código descontinuado, etc.), esa publicación
// queda sin precio de referencia calculable — null, no un número parcial
// que subestime el costo real.
export function precioReferenciaEquivalencia(
  equivalencias: FilaEquivalencia[],
  porCod: Map<string, FilaDefontana>
): number | null {
  let total = 0;
  for (const eq of equivalencias) {
    const componente = porCod.get(eq.componenteCod.trim().toUpperCase());
    if (!componente) return null;
    total += componente.mayor * eq.cantidad;
  }
  return total;
}

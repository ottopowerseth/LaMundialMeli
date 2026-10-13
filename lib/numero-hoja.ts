// Número leído de una celda de la planilla vía /api/sheets-data.
//
// La planilla tiene la configuración regional es_ES y la API devuelve el valor FORMATEADO: un número con decimales guardado
// como número llega como "14,5" (coma decimal), pero uno guardado como texto llega como "14.5" (punto). Number("14,5") es NaN
// y el historial de Auditoría mostraba «Tasa 0.00 %». Esta función entiende ambos y también "1.234,5" (punto de miles + coma).
//
// CASO AMBIGUO (intencional): un texto SIN coma y con punto, como "1.234", se interpreta como 1,234 (punto decimal), que es lo que
// hacía Number() hasta ahora y lo que hay en la planilla (decimales guardados como texto, p. ej. «14.5» o «1280.5»). Esto es correcto
// SOLO mientras las columnas numéricas no lleguen formateadas con separador de miles: "1.234" como «mil doscientos treinta y cuatro»
// se leería mal (1,234), y "1.234.567" daría NaN. Hoy ninguna celda numérica de Ventas, Auditoría ni Rentabilidad llega con miles
// (revisado con los datos reales). Si alguna columna pasara a formatearse con miles, hay que cambiar este criterio.
//
// Compatibilidad: un texto sin coma se interpreta EXACTAMENTE como antes (Number(texto)): "14.5" sigue siendo 14,5 y "" sigue
// siendo 0. Solo cambia el caso con coma. Devuelve NaN si no es un número (los llamadores ya usan «|| 0» o comparan con "").

export function leerNumeroHoja(valor: unknown): number {
  if (typeof valor !== "string") return Number(valor); // number, undefined, null…: igual que antes
  const texto = valor.trim();
  if (!texto.includes(",")) return Number(texto); // sin coma: comportamiento anterior
  // Con coma: decimal con coma, con o sin puntos de miles ("14,5", "-25,6", "1.234,5", "1.234.567,89")
  if (!/^-?(\d+|\d{1,3}(\.\d{3})+),\d+$/.test(texto)) return NaN;
  return Number(texto.replace(/\./g, "").replace(",", "."));
}

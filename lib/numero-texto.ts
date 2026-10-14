// Números que se guardan COMO TEXTO en las hojas Rentabilidad, ShippingCache y TarifaEnvio (S-07).
//
// Con valueInputOption USER_ENTERED, Google Sheets interpreta lo que se escribe como si lo tipeara una persona: un texto como «4989.6»
// (año.mes) o «10.2» (día.mes) se guarda como una FECHA con un patrón que muestra «4989.6», y no como el número. La hoja los muestra bien, y
// por eso los lectores (que leen el valor mostrado) no fallan, pero el valor guardado es una fecha: 1.348 celdas de esas tres hojas estaban así
// (sonda y revisión del 2026-10-15). Un apóstrofo delante fuerza TEXTO: Sheets lo consume y guarda «4989.6» como cadena, sin formato de fecha,
// incluso sobre una celda que ya tenía formato de fecha. Los lectores siguen leyendo lo mismo (Number("4989.6") y leerNumeroHoja).
//
// Se aplica a TODOS los valores numéricos de esas columnas (no solo a los decimales) para que queden uniformes: enteros, negativos, decimales.
// No se usa en columnas de fecha, de identificadores ni de texto libre.
//
// Idempotente: un valor vacío (null, undefined, "" o solo espacios) devuelve "" (la celda queda vacía, sin apóstrofo suelto) y un valor que
// ya empieza con apóstrofo no se prefija otra vez.
export function numeroComoTexto(valor: string | number | null | undefined): string {
  if (valor === null || valor === undefined) return "";
  const texto = String(valor);
  if (texto.trim() === "") return "";
  return texto.startsWith("'") ? texto : `'${texto}`;
}

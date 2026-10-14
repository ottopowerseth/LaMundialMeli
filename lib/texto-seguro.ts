// Protección de textos EXTERNOS contra fórmulas en las hojas (S-07).
//
// Con valueInputOption USER_ENTERED, Sheets trata lo que se escribe como si lo tipeara una persona: un texto que empieza con «=» o «+» se
// guarda como FÓRMULA y se ejecuta (medido en la sonda del 2026-10-15: «=1+1» y «+1» quedaron como fórmula; «-A1» y «@x» quedaron como
// texto). Los textos que vienen de fuera (títulos y SKU de ML, apodos de compradores, el título del producto de la Billing API, los artículos
// del Excel del proveedor) los controla un tercero: un título como «=IMPORTXML(...)» se ejecutaría en la hoja. Hoy hay 0 casos en las 7 hojas
// revisadas; esto es preventivo. Un apóstrofo delante fuerza TEXTO: Sheets lo consume, así que lo que se lee de vuelta es el texto original.
//
// Prefija «=», «+», «-» y «@» iniciales (también tras espacios, tabuladores o saltos de línea). NO altera:
//   - un texto normal (incluido el vacío, null y undefined → ""),
//   - un NÚMERO con signo, sea número JS o texto como «-5», «+5», «-2537,9»: no es una fórmula ejecutable, y esta función no debe cambiar los
//     negativos numéricos,
//   - un texto que ya empieza con apóstrofo (idempotente: aplicarla dos veces da lo mismo).
//
// Solo para campos de TEXTO externo. Nunca para columnas numéricas (esas usan lib/numero-texto.ts) ni para IDs o enumeraciones de ML.
const INICIO_PELIGROSO = /^[\s]*[=+\-@]/;
const NUMERO_CON_SIGNO = /^[+-]?(\d+([.,]\d+)?|[.,]\d+)$/;

export function textoExternoSeguro(valor: unknown): string {
  if (valor === null || valor === undefined) return "";
  const texto = typeof valor === "string" ? valor : String(valor);
  if (!INICIO_PELIGROSO.test(texto)) return texto;
  if (NUMERO_CON_SIGNO.test(texto.trim())) return texto;
  return `'${texto}`;
}

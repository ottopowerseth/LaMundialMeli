// Verificación ESTÁTICA (S-07): ningún escritor de las columnas numéricas de Rentabilidad, ShippingCache y TarifaEnvio puede escribir sin
// lib/numero-texto.ts (numeroComoTexto). Solo lee archivos fuente: sin red, sin Sheets, sin TypeScript. Falla (exit 1) si se rompe la regla.
// Se ejecuta en «prebuild» (npm run build y el build de Vercel) y también a mano:  node scripts/verificar-escritores-texto.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const PROJ = process.env.S07_RAIZ ? path.resolve(process.env.S07_RAIZ) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); // S07_RAIZ: solo para probar el verificador sobre una copia alterada
const leer = (rel) => fs.readFileSync(path.join(PROJ, rel), "utf8").replace(/\r\n/g, "\n");
const errores = [];
const falla = (m) => errores.push(m);

// Parte un literal de arreglo en sus elementos de nivel superior (ignora comentarios de línea, respeta paréntesis, corchetes, llaves y textos).
function elementos(cuerpo) {
  const limpio = cuerpo.split("\n").map((l) => (l.trim().startsWith("//") ? "" : l)).join("\n");
  const out = []; let prof = 0, comilla = null, acc = "";
  for (let i = 0; i < limpio.length; i++) {
    const c = limpio[i];
    if (comilla) { acc += c; if (c === "\\") { acc += limpio[++i] ?? ""; continue; } if (c === comilla) comilla = null; continue; }
    if (c === '"' || c === "'" || c === "`") { comilla = c; acc += c; continue; }
    if ("([{".includes(c)) prof++; if (")]}".includes(c)) prof--;
    if (c === "," && prof === 0) { out.push(acc.trim()); acc = ""; continue; }
    acc += c;
  }
  if (acc.trim() !== "") out.push(acc.trim());
  return out;
}
// Texto del arreglo que sigue a `ancla` (que termina en «[») hasta su «]» de cierre.
function arregloTras(src, ancla, desde = 0) {
  const i = src.indexOf(ancla, desde); if (i < 0) return null;
  let j = i + ancla.length, prof = 1, comilla = null;
  for (; j < src.length && prof > 0; j++) { const c = src[j]; if (comilla) { if (c === "\\") j++; else if (c === comilla) comilla = null; continue; } if (c === '"' || c === "'" || c === "`") { comilla = c; continue; } if (c === "[") prof++; if (c === "]") prof--; }
  return src.slice(i + ancla.length, j - 1);
}
// Comprueba un arreglo de columnas: los índices numéricos DEBEN usar numeroComoTexto; el resto NO.
function revisarFila(etiqueta, rel, ancla, numericos, total, desde = 0) {
  const src = leer(rel); const cuerpo = arregloTras(src, ancla, desde);
  if (cuerpo === null) return falla(`${etiqueta}: no se encontró «${ancla}» en ${rel} (¿se reescribió el escritor? actualiza scripts/verificar-escritores-texto.mjs)`);
  const el = elementos(cuerpo);
  if (el.length < total) return falla(`${etiqueta}: se esperaban al menos ${total} columnas y hay ${el.length} (${rel})`);
  el.forEach((e, i) => {
    const usa = e.includes("numeroComoTexto(");
    if (numericos.includes(i) && !usa) falla(`${etiqueta}: la columna #${i} (${String.fromCharCode(65 + i)}) es numérica y se escribe SIN numeroComoTexto: ${e.slice(0, 90)}  (${rel})`);
    if (!numericos.includes(i) && usa) falla(`${etiqueta}: la columna #${i} (${String.fromCharCode(65 + i)}) NO es numérica y usa numeroComoTexto: ${e.slice(0, 90)}  (${rel})`);
    if (numericos.includes(i) && /\bString\(/.test(e)) falla(`${etiqueta}: la columna #${i} usa String(...) además del ayudante: ${e.slice(0, 90)}  (${rel})`);
  });
}

// 1) Rentabilidad (A:Q): E precio, F cogs, G comisión, H envío, I pérdida, J margen neto, K margen %, N unidades, O envío por unidad
revisarFila("rentabilidad/analyze · fila de Rentabilidad", "app/api/rentabilidad/analyze/route.ts", "filasParaEscribir.push([", [4, 5, 6, 7, 8, 9, 10, 13, 14], 17);
// 2) ShippingCache (A:I): E costo total, F unidades del despacho, G unidades de esta orden
revisarFila("rentabilidad/analyze · entrada de ShippingCache", "app/api/rentabilidad/analyze/route.ts", "nuevasEntradasCache.push([", [4, 5, 6], 8);
revisarFila("envio-real · entrada de ShippingCache", "lib/envio-real.ts", "nuevasEntradasCache.push([", [4, 5, 6], 9);
// 3) TarifaEnvio (A:L): C tarifa, E muestras, F dispersión %, H unidades del despacho
{ const src = leer("lib/tarifa-envio.ts"); const i = src.indexOf("function filaDeSheet"); if (i < 0) falla("tarifa-envio: no se encontró filaDeSheet"); else revisarFila("tarifa-envio · filaDeSheet (appends y actualizaciones)", "lib/tarifa-envio.ts", "return [", [2, 4, 5, 7], 12, i); }
// 4) envio-real: ACTUALIZACIONES de filas existentes de Rentabilidad (H; J:K; O)
{ const src = leer("lib/envio-real.ts"); const reglas = [
    [/Rentabilidad!H\$\{fila\}:H\$\{fila\}`, values: \[\[(.*?)\]\] \}/s, ["numeroComoTexto(envio)"], "H (envío)"],
    [/Rentabilidad!J\$\{fila\}:K\$\{fila\}`, values: \[\[(.*?)\]\] \}/s, ["numeroComoTexto(margenNeto)", "numeroComoTexto(margenPct)"], "J:K (margen neto y %)"],
  ];
  for (const [re, esperado, nombre] of reglas) { const m = src.match(re); if (!m) { falla(`envio-real: no se encontró la actualización de ${nombre}`); continue; } const el = elementos(m[1]); if (el.length !== esperado.length || !esperado.every((x, i) => el[i] === x)) falla(`envio-real: la actualización de ${nombre} debe escribir [${esperado.join(", ")}] y escribe [${el.join(", ")}]`); }
  const reO = /Rentabilidad!O\$\{fila\}:[PQ]\$\{fila\}`, values: \[\[(.*?)\]\] \}/gs; const os = [...src.matchAll(reO)]; if (os.length !== 2) falla(`envio-real: se esperaban 2 actualizaciones de O (con y sin Mixto) y hay ${os.length}`);
  for (const m of os) { const el = elementos(m[1]); if (el[0] !== "numeroComoTexto(envioPorUnidad)") falla(`envio-real: la actualización de O (envío por unidad) debe empezar con numeroComoTexto(envioPorUnidad) y empieza con ${el[0]}`); if (el.slice(1).some((e) => e.includes("numeroComoTexto("))) falla("envio-real: las columnas P y Q (fuente y mixto) son texto y no deben usar numeroComoTexto"); } }

// 5) Escritores NO registrados: un archivo que escriba en esas hojas y no esté en la lista debe revisarse a mano.
const REGISTRADOS = new Set([
  "app/api/rentabilidad/analyze/route.ts", "lib/envio-real.ts", "lib/tarifa-envio.ts", // escriben columnas numéricas: revisados arriba
  "app/api/ml-sync/route.ts", "app/api/backfill-shipping/route.ts",                    // ShippingCache A:D (id, id de envío, tipo, fecha): sin columnas numéricas
  "app/api/rentabilidad/marcar-mixto/route.ts",                                        // Rentabilidad Q (texto) y ShippingCache I (JSON de texto)
  "app/api/rentabilidad/completar/route.ts", "app/api/tarifa-envio/route.ts",         // solo inyectan un appendSheet (modo OVERWRITE) a procesarTanda / procesarTarifas, revisados arriba
]);
function archivos(dir) { const out = []; for (const e of fs.readdirSync(path.join(PROJ, dir), { withFileTypes: true })) { const rel = `${dir}/${e.name}`; if (e.isDirectory()) out.push(...archivos(rel)); else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel); } return out; }
for (const rel of [...archivos("app"), ...archivos("lib")]) {
  if (rel === "lib/sheets.ts" || rel === "lib/numero-texto.ts") continue; const src = leer(rel);
  const escribe = /\b(appendSheet|batchWriteSheet|writeSheet)\(/.test(src); const hojas = /\b(ShippingCache|Rentabilidad|TarifaEnvio)!/.test(src) || /HOJA_TARIFA_ENVIO/.test(src) || /ShippingCache!|Rentabilidad!/.test(src);
  if (escribe && hojas && !REGISTRADOS.has(rel)) falla(`${rel}: escribe en Rentabilidad, ShippingCache o TarifaEnvio y no está registrado. Revisa si toca columnas numéricas (deben usar numeroComoTexto) y agrégalo a REGISTRADOS en scripts/verificar-escritores-texto.mjs.`);
}

if (errores.length) { console.error("✗ verificar-escritores-texto: " + errores.length + " problema(s) (S-07)\n  - " + errores.join("\n  - ")); process.exit(1); }
console.log("✓ verificar-escritores-texto: los escritores de las columnas numéricas de Rentabilidad, ShippingCache y TarifaEnvio usan numeroComoTexto");

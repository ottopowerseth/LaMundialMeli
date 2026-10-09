// Envío por unidad de una publicación para las pantallas de margen: usa la
// caché de tarifas MEDIDAS (hoja "TarifaEnvio", ver lib/tarifa-envio.ts) y
// distingue explícitamente "medido" de "estimado".
//
// Reemplaza la estimación que sale de la hoja Rentabilidad
// (armarMuestrasEnvio sobre Rentabilidad): medido 2026-10-07 con "dejar uno
// afuera", alimentada con Rentabilidad la estimación por tramo erra ~300%
// (mediana; sobreestima en 42 de los 50 productos top) porque esa hoja guarda
// envíos de Billing de despachos compartidos y de épocas previas al cambio a
// Full. Alimentada con las tarifas medidas erra 0% (mediana) en envío
// estándar; en Full es impreciso (mediana 49%), por eso toda estimación se
// devuelve marcada y quien la use debe mostrarla como "estimado".
//
// Base: la tarifa es BRUTA (con IVA), igual que el resto de los montos de ML.
//
// TARIFA POR TIPO LOGÍSTICO. El costo de envío depende del tipo: medido
// 2026-10-09 en 18 publicaciones que vendieron en Full y por despacho, el
// despacho cuesta una mediana de +$400 por unidad (14 de 18 más caro, 3 igual,
// 1 más barato). La hoja puede tener una fila por (publicación, tipo): la
// columna D ("Tipo Logístico") ya distingue "fulfillment" de los demás tipos.
// Se agrupan en dos, igual que el `esFull` del resto del código: Full y "no
// Full" (hoy solo existe xd_drop_off). Las filas viejas, una por publicación,
// siguen siendo válidas: son la fila de su tipo.
import { armarMuestrasEnvio, calcularEnvioEstimadoPorUnidad } from "@/lib/envio-estimado";
import type { MuestrasEnvio } from "@/lib/envio-estimado";

export type TarifaEnvioFila = { tarifa: number; estado: string; sku: string; tipo: string; actualizado: number };
// Filas de una publicación por grupo de tipo logístico. `sinTipo`: fila sin
// Tipo Logístico (hoja de una versión anterior): vale para cualquiera de los dos.
export type TarifasItem = { sku: string; full?: TarifaEnvioFila; noFull?: TarifaEnvioFila; sinTipo?: TarifaEnvioFila };
export type TarifasEnvio = Map<string, TarifasItem>;
// "estimado_otro_tipo": solo hay tarifa del OTRO tipo logístico; se usa tal cual
// (sin factor de corrección) y se marca como estimación.
export type FuenteEnvio = "medido" | "estimado" | "estimado_otro_tipo";
export type EnvioResuelto = { envio: number | null; fuente: FuenteEnvio | null };

export const esTarifaMedida = (f: TarifaEnvioFila | undefined): boolean => !!f && (f.estado === "ok" || f.estado === "dispersa");
const esTarifaUsable = (f: TarifaEnvioFila | undefined): boolean => esTarifaMedida(f) || f?.estado === "estimado";

// Dos filas para el mismo (publicación, grupo): gana la medida sobre la
// estimada, luego la más reciente, luego la que viene después en la hoja.
function mejorFila(a: TarifaEnvioFila | undefined, b: TarifaEnvioFila): TarifaEnvioFila {
  if (!a) return b;
  if (esTarifaMedida(a) !== esTarifaMedida(b)) return esTarifaMedida(b) ? b : a;
  return b.actualizado >= a.actualizado ? b : a;
}

// Filas de TarifaEnvio!A2:L → ID(0) SKU(1) Tarifa(2) Tipo(3) ... Estado(8) Actualizado(9).
export function parsearTarifasEnvio(filas: string[][]): TarifasEnvio {
  const out: TarifasEnvio = new Map();
  for (const r of filas) {
    if (!r[0]) continue;
    const tarifa = Number(r[2]);
    if (!Number.isFinite(tarifa) || tarifa <= 0) continue;
    const id = String(r[0]);
    const tipo = r[3] ?? "";
    const actualizado = r[9] ? Date.parse(r[9]) || 0 : 0;
    const fila: TarifaEnvioFila = { tarifa, estado: r[8] ?? "", sku: r[1] ?? "", tipo, actualizado };
    const item = out.get(id) ?? { sku: "" };
    if (!item.sku && fila.sku) item.sku = fila.sku;
    const campo = tipo === "fulfillment" ? "full" : tipo === "" ? "sinTipo" : "noFull";
    item[campo] = mejorFila(item[campo], fila);
    out.set(id, item);
  }
  return out;
}

// Fila del tipo pedido (o la sin tipo, de una hoja anterior). undefined si no hay.
export function tarifaDe(tarifas: TarifasEnvio, itemId: string, esFull: boolean): TarifaEnvioFila | undefined {
  const i = tarifas.get(itemId);
  if (!i) return undefined;
  return (esFull ? i.full : i.noFull) ?? i.sinTipo;
}
// Fila del OTRO tipo (nunca la sin tipo: esa ya cuenta como del tipo pedido).
export function tarifaOtroTipo(tarifas: TarifasEnvio, itemId: string, esFull: boolean): TarifaEnvioFila | undefined {
  const i = tarifas.get(itemId);
  if (!i) return undefined;
  return esFull ? i.noFull : i.full;
}

export type ContextoEnvio = { tarifas: TarifasEnvio; muestras: MuestrasEnvio };

// precioPorItem: precio bruto de cada publicación (Publicaciones!G), para
// ubicar las tarifas medidas en su tramo de precio al armar el respaldo.
// Cada tarifa medida (publicación, tipo) es UNA muestra del estimador, con su
// propio tipo: así el tramo × tipo se arma con el costo que de verdad tuvo ese
// tipo. Las muestras llevan una clave propia ("id|F" / "id|N") para que el
// nivel "esta publicación" del estimador no devuelva la tarifa del otro tipo.
export function armarContextoEnvio(
  tarifas: TarifasEnvio,
  precioPorItem: Map<string, number>,
  skuPorItem: Map<string, string>,
  logisticoPorItem: Map<string, string>
): ContextoEnvio {
  const filas: string[][] = [];
  const sku = new Map<string, string>();
  const logistico = new Map<string, string>();
  for (const [id, item] of tarifas) {
    const precio = precioPorItem.get(id);
    if (!precio) continue;
    const skuItem = skuPorItem.get(id) ?? item.sku;
    for (const [grupo, t] of [["F", item.full], ["N", item.noFull], ["S", item.sinTipo]] as const) {
      if (!t || t.estado !== "ok") continue; // solo tarifas medidas alimentan al estimador
      const sid = `${id}|${grupo}`;
      const f: string[] = [];
      f[2] = sid; f[4] = String(precio); f[14] = String(t.tarifa);
      filas.push(f);
      if (skuItem) sku.set(sid, skuItem);
      // Tipo de la muestra: el de su fila; si la fila no lo trae, el vigente de la publicación.
      const tipo = grupo === "F" ? "fulfillment" : grupo === "N" ? "otro" : (logisticoPorItem.get(id) ?? t.tipo);
      logistico.set(sid, tipo);
    }
  }
  return { tarifas, muestras: armarMuestrasEnvio(filas, sku, logistico) };
}

// Orden de búsqueda para la venta de `itemId` con tipo `esFull`:
//   1. tarifa MEDIDA del mismo tipo                     → "medido"
//   2. tarifa ESTIMADA del mismo tipo (hoja)             → "estimado"
//   3. tarifa del OTRO tipo (medida o estimada), tal cual → "estimado_otro_tipo"
//   4. respaldo por SKU gemelo o tramo × tipo            → "estimado"
// Nunca 0. Sin ninguna referencia devuelve { envio: null }.
// Nota: el backtest 2026-10-09 (18 publicaciones comparables) mostró que el paso
// 4 erra menos que el 3 (mediana de error 0% y -2% contra +98% y -49%); se deja
// el 3 antes porque es el orden acordado y conserva los números de antes. Cambiar
// el orden exige excluir la propia publicación de las muestras del estimador.
export function resolverEnvio(
  itemId: string,
  precio: number,
  esFull: boolean,
  sku: string | null,
  ctx: ContextoEnvio
): EnvioResuelto {
  const propia = tarifaDe(ctx.tarifas, itemId, esFull);
  if (esTarifaMedida(propia)) return { envio: propia!.tarifa, fuente: "medido" };
  if (propia?.estado === "estimado") return { envio: propia.tarifa, fuente: "estimado" };
  const otra = tarifaOtroTipo(ctx.tarifas, itemId, esFull);
  if (otra && esTarifaUsable(otra)) return { envio: otra.tarifa, fuente: "estimado_otro_tipo" };
  // Sin fila en la caché (p. ej. publicación sin ventas recientes): respaldo
  // por SKU gemelo o tramo, marcado como estimado. Nunca 0.
  const e = calcularEnvioEstimadoPorUnidad(itemId, precio, esFull, ctx.muestras, sku);
  if (e.muestras === 0 || e.envio <= 0) return { envio: null, fuente: null };
  return { envio: e.envio, fuente: "estimado" };
}

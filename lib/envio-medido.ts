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
// origen: de dónde sale la cifra (útil para el indicador de cobertura): "hoja" = fila de TarifaEnvio del
// tipo de la venta; "estimador" = respaldo por SKU gemelo o tramo; "otro_tipo" = fila del otro tipo.
export type OrigenEnvio = "hoja" | "estimador" | "otro_tipo";
export type EnvioResuelto = { envio: number | null; fuente: FuenteEnvio | null; origen?: OrigenEnvio };

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

// Una tarifa medida usada como muestra del estimador. `tipo` es el del grupo de la fila.
export type MuestraEnvio = { item: string; sid: string; sku: string; precio: number; tarifa: number; tipo: "fulfillment" | "otro" };
// `crudas` guarda cada muestra con su publicación para poder rearmar los índices del estimador sin la propia
// publicación (ver resolverEnvio); `muestras` son los índices con todas.
export type ContextoEnvio = { tarifas: TarifasEnvio; muestras: MuestrasEnvio; crudas: MuestraEnvio[] };

function indicesDe(crudas: MuestraEnvio[]): MuestrasEnvio {
  const filas: string[][] = [];
  const sku = new Map<string, string>();
  const logistico = new Map<string, string>();
  for (const m of crudas) {
    const f: string[] = [];
    f[2] = m.sid; f[4] = String(m.precio); f[14] = String(m.tarifa);
    filas.push(f);
    if (m.sku) sku.set(m.sid, m.sku);
    logistico.set(m.sid, m.tipo);
  }
  return armarMuestrasEnvio(filas, sku, logistico);
}

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
  const crudas: MuestraEnvio[] = [];
  for (const [id, item] of tarifas) {
    const precio = precioPorItem.get(id);
    if (!precio) continue;
    const skuItem = skuPorItem.get(id) ?? item.sku;
    for (const [grupo, t] of [["F", item.full], ["N", item.noFull], ["S", item.sinTipo]] as const) {
      if (!t || t.estado !== "ok") continue; // solo tarifas medidas alimentan al estimador
      // Tipo de la muestra: el de su fila; si la fila no lo trae, el vigente de la publicación.
      const tipoFila = grupo === "F" ? "fulfillment" : grupo === "N" ? "otro" : (logisticoPorItem.get(id) ?? t.tipo);
      crudas.push({ item: id, sid: `${id}|${grupo}`, sku: skuItem ?? "", precio, tarifa: t.tarifa, tipo: tipoFila === "fulfillment" ? "fulfillment" : "otro" });
    }
  }
  return { tarifas, muestras: indicesDe(crudas), crudas };
}

// Índices del estimador SIN las muestras de `itemId`: si la publicación ya aporta una tarifa medida (p. ej. la
// del otro tipo), el SKU gemelo o el tramo no pueden incluirla, porque entonces "estimar" sería devolver esa
// misma tarifa. Si no aporta nada, se usan los índices ya armados.
function muestrasSinItem(ctx: ContextoEnvio, itemId: string): MuestrasEnvio {
  if (!ctx.crudas.some((m) => m.item === itemId)) return ctx.muestras;
  return indicesDe(ctx.crudas.filter((m) => m.item !== itemId));
}

// Orden de búsqueda para la venta de `itemId` con tipo `esFull`:
//   1. tarifa MEDIDA del mismo tipo                                  → "medido"
//   2. tarifa ESTIMADA del mismo tipo (hoja)                          → "estimado"
//   3. estimador por SKU gemelo o tramo × tipo, SIN la propia
//      publicación entre las muestras                                 → "estimado"
//   4. tarifa del OTRO tipo (medida o estimada), solo si no hay
//      estimador, tal cual                                            → "estimado_otro_tipo"
// Nunca 0. Sin ninguna referencia devuelve { envio: null }.
// El estimador va antes que el otro tipo por el backtest del 2026-10-09 (18 publicaciones que vendieron en
// ambos tipos, error contra la tarifa medida del mismo tipo): en ventas Full, otro tipo +98% (mediana) contra
// 0% del estimador; en ventas por despacho, -49% contra -2%.
export function resolverEnvio(
  itemId: string,
  precio: number,
  esFull: boolean,
  sku: string | null,
  ctx: ContextoEnvio
): EnvioResuelto {
  const propia = tarifaDe(ctx.tarifas, itemId, esFull);
  if (esTarifaMedida(propia)) return { envio: propia!.tarifa, fuente: "medido", origen: "hoja" };
  if (propia?.estado === "estimado") return { envio: propia.tarifa, fuente: "estimado", origen: "hoja" };
  // Sin fila del tipo (p. ej. publicación sin ventas recientes de este tipo): respaldo por SKU gemelo o
  // tramo, marcado como estimado. Nunca 0.
  const e = calcularEnvioEstimadoPorUnidad(itemId, precio, esFull, muestrasSinItem(ctx, itemId), sku);
  if (e.muestras > 0 && e.envio > 0) return { envio: e.envio, fuente: "estimado", origen: "estimador" };
  const otra = tarifaOtroTipo(ctx.tarifas, itemId, esFull);
  if (otra && esTarifaUsable(otra)) return { envio: otra.tarifa, fuente: "estimado_otro_tipo", origen: "otro_tipo" };
  return { envio: null, fuente: null };
}

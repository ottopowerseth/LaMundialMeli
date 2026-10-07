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
import { armarMuestrasEnvio, calcularEnvioEstimadoPorUnidad } from "@/lib/envio-estimado";
import type { MuestrasEnvio } from "@/lib/envio-estimado";

export type TarifaEnvioFila = { tarifa: number; estado: string; sku: string; tipo: string };
export type EnvioResuelto = { envio: number | null; fuente: "medido" | "estimado" | null };

// Filas de TarifaEnvio!A2:L → ID(0) SKU(1) Tarifa(2) Tipo(3) ... Estado(8).
export function parsearTarifasEnvio(filas: string[][]): Map<string, TarifaEnvioFila> {
  const out = new Map<string, TarifaEnvioFila>();
  for (const r of filas) {
    if (!r[0]) continue;
    const tarifa = Number(r[2]);
    if (!Number.isFinite(tarifa) || tarifa <= 0) continue;
    out.set(String(r[0]), { tarifa, estado: r[8] ?? "", sku: r[1] ?? "", tipo: r[3] ?? "" });
  }
  return out;
}

export type ContextoEnvio = { tarifas: Map<string, TarifaEnvioFila>; muestras: MuestrasEnvio };

// precioPorItem: precio bruto de cada publicación (Publicaciones!G), para
// ubicar las tarifas medidas en su tramo de precio al armar el respaldo.
export function armarContextoEnvio(
  tarifas: Map<string, TarifaEnvioFila>,
  precioPorItem: Map<string, number>,
  skuPorItem: Map<string, string>,
  logisticoPorItem: Map<string, string>
): ContextoEnvio {
  const filas: string[][] = [];
  const sku = new Map(skuPorItem);
  const logistico = new Map(logisticoPorItem);
  for (const [id, t] of tarifas) {
    if (t.estado !== "ok") continue; // solo tarifas medidas alimentan al estimador
    const precio = precioPorItem.get(id);
    if (!precio) continue;
    const f: string[] = [];
    f[2] = id; f[4] = String(precio); f[14] = String(t.tarifa);
    filas.push(f);
    if (!sku.has(id) && t.sku) sku.set(id, t.sku);
    if (!logistico.has(id) && t.tipo) logistico.set(id, t.tipo);
  }
  return { tarifas, muestras: armarMuestrasEnvio(filas, sku, logistico) };
}

export function resolverEnvio(
  itemId: string,
  precio: number,
  esFull: boolean,
  sku: string | null,
  ctx: ContextoEnvio
): EnvioResuelto {
  const t = ctx.tarifas.get(itemId);
  if (t && (t.estado === "ok" || t.estado === "dispersa")) return { envio: t.tarifa, fuente: "medido" };
  if (t && t.estado === "estimado") return { envio: t.tarifa, fuente: "estimado" };
  // Sin fila en la caché (p. ej. publicación sin ventas recientes): respaldo
  // por SKU gemelo o tramo, marcado como estimado. Nunca 0.
  const e = calcularEnvioEstimadoPorUnidad(itemId, precio, esFull, ctx.muestras, sku);
  if (e.muestras === 0 || e.envio <= 0) return { envio: null, fuente: null };
  return { envio: e.envio, fuente: "estimado" };
}

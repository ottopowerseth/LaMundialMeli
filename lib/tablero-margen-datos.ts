// Preparación de los insumos del margen de contribución a partir de las hojas
// y de las ventas ya cargadas. La comparten /api/tablero y /api/publicidad
// para que ambos calculen el margen exactamente igual (ver lib/tablero-margen.ts).
import { armarContextoEnvio } from "@/lib/envio-medido";
import type { TarifaEnvioFila } from "@/lib/envio-medido";
import { analizarMargen } from "@/lib/tablero-margen";
import type { LineaVenta } from "@/lib/tablero-datos";

// Costo de Publicaciones!F por publicación (null = vacío o no numérico o <= 0).
export function costoPorItemDesdeHoja(filasPub: string[][]): Map<string, number | null> {
  const costoPorItem = new Map<string, number | null>();
  for (const r of filasPub) {
    if (!r[0]) continue;
    const c = Number(String(r[5] ?? "").trim());
    costoPorItem.set(String(r[0]), String(r[5] ?? "").trim() !== "" && Number.isFinite(c) && c > 0 ? c : null);
  }
  return costoPorItem;
}

export type EntradaMargenDatos = {
  filasPub: string[][]; // Publicaciones!A2:S: precio vigente en G (índice 6)
  fullPorItem: Map<string, boolean>; // true = Full (fulfillment)
  tarifas: Map<string, TarifaEnvioFila>; // hoja TarifaEnvio ya parseada
  lineas: LineaVenta[]; // solo las de la ventana
  costoPorItem: Map<string, number | null>;
  fueraDeAlcance?: Set<string>; // closed/inactive (ver lib/tablero-margen.ts)
};

export function margenDesdeDatos(e: EntradaMargenDatos) {
  const precioPorItem = new Map<string, number>();
  for (const r of e.filasPub) {
    const p = Number(String(r[6] ?? "").trim());
    if (r[0] && Number.isFinite(p) && p > 0) precioPorItem.set(String(r[0]), p);
  }
  const logisticoPorItem = new Map<string, string>();
  for (const [id, esFull] of e.fullPorItem) logisticoPorItem.set(id, esFull ? "fulfillment" : "otro");
  const skuPorItem = new Map<string, string>();
  for (const [id, t] of e.tarifas) if (t.sku) skuPorItem.set(id, t.sku);
  const ctxEnvio = armarContextoEnvio(e.tarifas, precioPorItem, skuPorItem, logisticoPorItem);
  return analizarMargen({
    lineas: e.lineas,
    costoPorItem: e.costoPorItem,
    fullPorItem: e.fullPorItem,
    skuPorItem,
    ctxEnvio,
    fueraDeAlcance: e.fueraDeAlcance,
  });
}

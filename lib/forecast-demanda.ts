// Demanda del Forecast: unidades por publicación (ID Item) en la ventana, a partir de las filas de la hoja Ventas
// (A:ID Orden, B:Fecha dd-mm-aaaa, E:Cantidad, I:Estado, J:ID Item).
//
// Las órdenes CANCELADAS no son ventas: se excluyen (medido 2026-10-14: 161 de 2.820 unidades de 30 días, 5,7 %).
// partially_refunded SÍ se cuenta (6 unidades en 30 días y la hoja no dice cuántas se reembolsaron).

export const ESTADOS_EXCLUIDOS_DEMANDA = ["cancelled"];

export function parseFechaCL(s: string): Date | null {
  if (!s) return null;
  const parts = s.split(/[-\/]/);
  if (parts.length < 3) return null;
  const d = Number(parts[0]);
  const m = Number(parts[1]) - 1;
  const y = Number(parts[2]);
  if (Number.isNaN(d) || Number.isNaN(m) || Number.isNaN(y)) return null;
  return new Date(y, m, d);
}

// Match por ID Item (columna J), no por título: el título en Ventas es el de la variación vendida, no el del producto
// padre en Publicaciones. Filas sin ID Item se ignoran.
export function unidadesPorItem(ventaRows: unknown[][], desde: Date): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of ventaRows) {
    const fecha = parseFechaCL(String(r[1] ?? ""));
    if (!fecha || fecha < desde) continue;
    if (ESTADOS_EXCLUIDOS_DEMANDA.includes(String(r[8] ?? "").trim())) continue;
    const idItem = String(r[9] ?? "");
    const cantidad = Number(r[4]) || 0;
    if (!idItem || cantidad <= 0) continue;
    out.set(idItem, (out.get(idItem) ?? 0) + cantidad);
  }
  return out;
}

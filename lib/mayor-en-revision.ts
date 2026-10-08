// "Mayor en revisión": publicaciones cuyo Mayor (Lista Defontana × Unidades) quedó
// marcado como dudoso al calcular el Costo automático (hoja CostoOrigen, origen
// "revisar"; ver lib/costo-auto.ts). Los motivos son, por ejemplo, costo igual al
// precio, costo/precio muy bajo o muy alto, o una cantidad del título distinta de
// la de Defontana. El Comparador usa el MISMO Mayor que costo-auto (mismo cruce por
// SKU/GTIN y mismas equivalencias), así que si el Mayor es dudoso para el Costo
// también lo es para el Comparador: se marca "Mayor en revisión" y NO se le da
// semáforo (rojo / amarillo / verde), porque ese color saldría de un número dudoso.
//
// CostoOrigen!A2:J → ID Item(0) SKU(1) Origen(2) Costo(3) Costo Calculado(4)
// Fuente(5) Cod Defontana(6) Artículo Defontana(7) Motivo Revisión(8) Actualizado(9).
export function mayoresEnRevision(filasOrigen: string[][]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of filasOrigen) {
    const id = String(r[0] ?? "").trim();
    if (!id || String(r[2] ?? "").trim() !== "revisar") continue;
    out.set(id, String(r[8] ?? "").trim() || "sin motivo registrado");
  }
  return out;
}

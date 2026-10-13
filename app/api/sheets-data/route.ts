import { NextRequest, NextResponse } from "next/server";
import { readSheet } from "@/lib/sheets";
import { logError } from "@/lib/log";

const ALLOWED_TABS = ["Publicaciones", "Ventas", "Auditoría", "Rentabilidad"] as const;

// Rentabilidad crece con cada mes analizado (una fila por orden): se lee hasta la columna Q y con un tope alto.
// Si se llega al tope se avisa con truncado: true para que la pantalla no muestre un recorte en silencio.
const TOPE_FILAS_RENTABILIDAD = 20000;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const tab = searchParams.get("tab") ?? "Publicaciones";

  if (!ALLOWED_TABS.includes(tab as typeof ALLOWED_TABS[number])) {
    return NextResponse.json({ error: "Pestaña no permitida" }, { status: 400 });
  }

  try {
    const range = tab === "Rentabilidad" ? `Rentabilidad!A1:Q${TOPE_FILAS_RENTABILIDAD}` : `${tab}!A1:Z1000`;
    const rows = await readSheet(range);
    if (rows.length === 0) return NextResponse.json({ headers: [], rows: [] });
    const [headers, ...data] = rows;
    const truncado = tab === "Rentabilidad" && rows.length >= TOPE_FILAS_RENTABILIDAD;
    return NextResponse.json(truncado ? { headers, rows: data, truncado: true } : { headers, rows: data });
  } catch (error) {
    logError("sheets-data", error);
    return NextResponse.json({ error: "Error al leer datos" }, { status: 500 });
  }
}

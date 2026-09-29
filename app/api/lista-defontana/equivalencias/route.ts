import { NextResponse } from "next/server";
import { ensureSheets, clearSheet, writeSheet } from "@/lib/sheets";
import { HEADERS_EQUIVALENCIAS, FilaEquivalencia } from "@/lib/defontana";

// Reemplaza la tabla de equivalencias completa — mismo criterio que la
// importación de Lista Defontana (no upsert, reemplazo total). Se llama a
// mano cuando Otto confirma equivalencias nuevas o corrige una existente,
// no automáticamente en cada sync.
export async function POST(request: Request) {
  try {
    const { equivalencias } = (await request.json()) as { equivalencias: FilaEquivalencia[] };
    if (!Array.isArray(equivalencias) || equivalencias.length === 0) {
      return NextResponse.json({ ok: false, error: "Falta el array de equivalencias" }, { status: 400 });
    }

    await ensureSheets(["Equivalencias Defontana"]);
    await clearSheet("Equivalencias Defontana");

    const rows = equivalencias.map((e) => [e.publicacionId, e.componenteCod, String(e.cantidad)]);
    await writeSheet("Equivalencias Defontana!A1", [HEADERS_EQUIVALENCIAS, ...rows]);

    return NextResponse.json({ ok: true, filasGuardadas: equivalencias.length });
  } catch (error) {
    console.error("[lista-defontana/equivalencias]", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

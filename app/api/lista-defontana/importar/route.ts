import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { ensureSheets, clearSheet, writeSheet } from "@/lib/sheets";
import { HEADERS_LISTA_DEFONTANA, FilaDefontana } from "@/lib/defontana";

// Importación manual y mensual de la lista de precios del proveedor
// (Defontana) — reemplaza la hoja completa, no hace upsert. Se sube el
// mismo Excel que Otto recibe del proveedor, hoja "PRECIOS", columnas
// PROVEEDOR/MARCA/FAMILIA/cod/barras/articulo/MAYOR (el resto de columnas
// del Excel, REGION/DETALLE/ESPECIAL/fecha, no se usan hoy).
export const maxDuration = 60;

function parsePrecios(buffer: Buffer): FilaDefontana[] {
  const wb = XLSX.read(buffer, { type: "buffer", cellText: true });
  const sheet = wb.Sheets["PRECIOS"];
  if (!sheet) {
    throw new Error('El archivo no tiene una hoja llamada "PRECIOS"');
  }
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null });
  return rows
    .filter((r) => r.cod) // sin cod no hay forma de cruzar, se descarta
    .map((r) => ({
      proveedor: String(r.PROVEEDOR ?? ""),
      marca: String(r.MARCA ?? ""),
      familia: String(r.FAMILIA ?? ""),
      cod: String(r.cod ?? "").trim(),
      barras: r.barras !== null && r.barras !== undefined ? String(r.barras).trim() : "",
      articulo: String(r.articulo ?? ""),
      mayor: typeof r.MAYOR === "number" ? r.MAYOR : Number(r.MAYOR) || 0,
    }));
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("archivo");
    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, error: "No se recibió el archivo" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const filas = parsePrecios(buffer);
    if (filas.length === 0) {
      return NextResponse.json({ ok: false, error: "La hoja PRECIOS no tiene filas con cod" }, { status: 400 });
    }

    await ensureSheets(["Lista Defontana"]);
    await clearSheet("Lista Defontana");

    const cargado = new Date().toLocaleString("es-CL");
    const rows = filas.map((f) => [f.proveedor, f.marca, f.familia, f.cod, f.barras, f.articulo, String(f.mayor), cargado]);
    await writeSheet("Lista Defontana!A1", [HEADERS_LISTA_DEFONTANA, ...rows]);

    return NextResponse.json({ ok: true, filasImportadas: filas.length, cargado });
  } catch (error) {
    console.error("[lista-defontana/importar]", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

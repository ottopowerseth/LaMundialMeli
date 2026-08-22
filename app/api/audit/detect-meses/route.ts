import { NextResponse } from "next/server";
import { parseAuditFiles, detectarMesesEnArchivo } from "@/lib/audit";

// Detecta los meses reales (por contenido de "Fecha del cargo", no por
// nombre de archivo) presentes en Facturación ML y Facturación MP — se
// llama antes de correr el análisis completo, para que la UI pueda ofrecer
// el mes correcto en vez de que el usuario adivine a partir del nombre del
// archivo (Fase 1 detectó que el nombre puede no coincidir con el contenido).
export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const files: { name: string; buffer: Buffer }[] = [];
    for (const [, value] of formData.entries()) {
      if (value instanceof File) {
        const arrayBuffer = await value.arrayBuffer();
        files.push({ name: value.name, buffer: Buffer.from(arrayBuffer) });
      }
    }

    if (files.length === 0) {
      return NextResponse.json({ ok: false, error: "No se recibieron archivos" }, { status: 400 });
    }

    const data = parseAuditFiles(files);
    const mesesML = detectarMesesEnArchivo(data.facturacionML);
    const mesesMP = detectarMesesEnArchivo(data.facturacionMP);

    return NextResponse.json({ ok: true, mesesML, mesesMP });
  } catch (error) {
    console.error("[audit/detect-meses]", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

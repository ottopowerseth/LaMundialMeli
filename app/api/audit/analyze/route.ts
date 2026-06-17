import { NextResponse } from "next/server";
import { parseAuditFiles, calculateAudit } from "@/lib/audit";
import { ensureSheets, appendSheet, readSheet } from "@/lib/sheets";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const mes = (formData.get("mes") as string) ?? "Sin especificar";

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

    const auditData = parseAuditFiles(files);
    const result = calculateAudit(mes, auditData);

    await ensureSheets(["Auditoría"]);

    const headers = [
      "Mes", "Ventas Brutas", "Ventas Netas", "Comisiones ML", "Comisiones MP",
      "Total Comisiones", "Recuperable", "Tasa Efectiva %", "Errores", "Resumen", "Analizado",
    ];

    try {
      const existing = await readSheet("Auditoría!A1:A1");
      if (!existing.length || !existing[0]?.length) {
        await appendSheet("Auditoría!A1", [headers]);
      }
    } catch { /* continue */ }

    await appendSheet("Auditoría!A1", [[
      mes,
      result.ventas_brutas,
      result.ventas_netas,
      result.comisiones_ml,
      result.comisiones_mp,
      result.total_comisiones,
      result.recuperable,
      result.tasa_efectiva,
      result.errores,
      result.resumen,
      new Date().toLocaleString("es-CL"),
    ]]);

    return NextResponse.json({ ok: true, mes, result });
  } catch (error) {
    console.error("[audit/analyze]", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

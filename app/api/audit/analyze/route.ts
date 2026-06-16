import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import { join } from "path";
import { parseAuditFiles, buildAuditMessage } from "@/lib/audit";
import { ensureSheets, appendSheet } from "@/lib/sheets";

type AuditResult = {
  ventas_brutas: number;
  ventas_netas: number;
  comisiones_ml: number;
  comisiones_mp: number;
  total_comisiones: number;
  recuperable: number;
  tasa_efectiva: number;
  errores: number;
  detalle_errores: string[];
  resumen: string;
};

function getSystemPrompt(): string {
  try {
    return readFileSync(join(process.cwd(), "CONTEXT.md"), "utf-8");
  } catch {
    return "Eres un asistente financiero. Analiza los datos de Mercado Libre y Mercado Pago y responde con un JSON estructurado.";
  }
}

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
    const userMessage = buildAuditMessage(mes, auditData);

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      system: getSystemPrompt(),
      messages: [{ role: "user", content: userMessage }],
    });

    const rawText = (message.content[0] as { type: string; text: string }).text.trim();
    const jsonText = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const result: AuditResult = JSON.parse(jsonText);

    // Guardar en Google Sheets hoja "Auditoría"
    await ensureSheets(["Auditoría"]);

    const headers = [
      "Mes", "Ventas Brutas", "Ventas Netas", "Comisiones ML", "Comisiones MP",
      "Total Comisiones", "Recuperable", "Tasa Efectiva %", "Errores", "Resumen", "Analizado",
    ];

    // Intentar agregar header si la hoja está vacía (appendSheet lo maneja)
    try {
      const { readSheet } = await import("@/lib/sheets");
      const existing = await readSheet("Auditoría!A1:A1");
      if (!existing.length || !existing[0]?.length) {
        await appendSheet("Auditoría!A1", [headers]);
      }
    } catch { /* si falla, continuar igual */ }

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

import { NextResponse } from "next/server";
import axios from "axios";
import { parseAuditFiles, calculateAudit } from "@/lib/audit";
import { ensureSheets, appendSheet, readSheet } from "@/lib/sheets";
import { getValidAccessToken } from "@/lib/ml-token";

async function fetchReferenciaML(mes: string) {
  const [yearStr, monthStr] = mes.split("-");
  const year = parseInt(yearStr);
  const month = parseInt(monthStr);
  if (!year || !month) return null;

  const desde = new Date(Date.UTC(year, month - 1, 1));
  const hasta = new Date(Date.UTC(year, month, 1));

  try {
    const token = await getValidAccessToken();
    const mlClient = axios.create({
      baseURL: "https://api.mercadolibre.com",
      headers: { Authorization: `Bearer ${token}` },
    });
    const { data: user } = await mlClient.get("/users/me");
    const userId = user.id;

    let ventasBrutas = 0;
    let cantidadVentas = 0;
    let offset = 0;
    while (offset <= 1000) {
      const { data } = await mlClient.get(`/orders/search`, {
        params: {
          seller: userId,
          "order.status": "paid",
          "order.date_created.from": desde.toISOString(),
          "order.date_created.to": hasta.toISOString(),
          sort: "date_desc",
          limit: 50,
          offset,
        },
      });
      for (const order of data.results ?? []) {
        ventasBrutas += Number(order.total_amount) || 0;
        cantidadVentas++;
      }
      if (data.results.length === 0 || offset + data.results.length >= data.paging.total) break;
      offset += 50;
    }

    return { ventasBrutas, cantidadVentas };
  } catch (error) {
    console.error("[audit/analyze] referencia ML", error);
    return null;
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
    const referenciaML = await fetchReferenciaML(mes);
    const result = calculateAudit(mes, auditData, referenciaML?.ventasBrutas);

    await ensureSheets(["Auditoría"]);

    const headers = [
      "Mes", "Ventas Brutas", "Ventas Netas", "Comisiones ML", "Comisiones MP",
      "Total Comisiones", "Recuperable", "Neto Recibido MP", "Tasa Efectiva %",
      "Flex Crédito", "Flex Débito", "Errores", "Resumen", "Analizado",
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
      result.neto_recibido_mp,
      result.tasa_efectiva,
      result.flex_credito,
      result.flex_debito,
      result.errores_count,
      result.resumen,
      new Date().toLocaleString("es-CL"),
    ]]);

    return NextResponse.json({ ok: true, mes, result, referenciaML });
  } catch (error) {
    console.error("[audit/analyze]", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

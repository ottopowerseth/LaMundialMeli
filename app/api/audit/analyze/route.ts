import { NextResponse } from "next/server";
import axios from "axios";
import { parseAuditFiles, calculateAudit, detectarMesesEnArchivo, cicloEsperado } from "@/lib/audit";
import { ensureSheets, appendSheet, readSheet, writeSheet } from "@/lib/sheets";
import { getValidAccessToken } from "@/lib/ml-token";

async function fetchReferenciaML(mes: string) {
  const [yearStr, monthStr] = mes.split("-");
  const year = parseInt(yearStr);
  const month = parseInt(monthStr);
  if (!year || !month) return null;

  // Ciclo real de facturación (15→14, ver cicloEsperado en lib/audit.ts), no
  // el mes calendario — para que ventas_brutas quede en el mismo rango de
  // fechas que las comisiones calculadas desde los archivos de Facturación.
  const { desde, hasta: cicloHasta } = cicloEsperado(mes);
  const hasta = new Date(cicloHasta.getTime() + 86400000); // +1 día: /orders/search usa "hasta" exclusivo

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
    const mesesML = detectarMesesEnArchivo(auditData.facturacionML);
    const mesesMP = detectarMesesEnArchivo(auditData.facturacionMP);
    const referenciaML = await fetchReferenciaML(mes);
    const result = calculateAudit(mes, auditData, referenciaML?.ventasBrutas);

    // Si hay mismatch de cobertura, el análisis no corrió el cálculo (ver
    // calculateAudit) — no se guarda una fila vacía/engañosa en Sheets.
    if (result.error_cobertura) {
      return NextResponse.json({ ok: true, mes, result, referenciaML, mesesML, mesesMP });
    }

    await ensureSheets(["Auditoría"]);

    const headers = [
      "Mes", "Ventas Brutas", "Ventas Netas", "Comisiones ML", "Comisiones MP",
      "Comisiones MP (PX, no verificado)", "Total Comisiones", "Notas Crédito ML",
      "Recuperable", "Neto Recibido MP", "Tasa Efectiva %", "Flex Crédito",
      "Flex Débito", "Errores", "Resumen", "Analizado",
    ];

    const fila = [
      mes,
      result.ventas_brutas,
      result.ventas_netas,
      result.comisiones_ml,
      result.comisiones_mp,
      result.comisiones_mp_px,
      result.total_comisiones,
      result.notas_credito_ml,
      result.recuperable,
      result.neto_recibido_mp,
      result.tasa_efectiva,
      result.flex_credito,
      result.flex_debito,
      result.errores_count,
      result.resumen,
      new Date().toLocaleString("es-CL"),
    ];

    // Cada mes es una fila única (a diferencia del patrón de snapshots
    // append-only de Métricas/Competencia): si ya existe una fila para este
    // mes, se sobreescribe en el mismo lugar en vez de duplicarla — permite
    // re-analizar un mes (ej. tras corregir un archivo) sin acumular
    // versiones viejas en el histórico.
    const existing = await readSheet("Auditoría!A:A");
    if (!existing.length || !existing[0]?.length) {
      await appendSheet("Auditoría!A1", [headers]);
    }
    const filaExistente = existing.findIndex((r) => r[0] === mes);
    if (filaExistente >= 0) {
      const numeroFila = filaExistente + 1; // 1-indexed para el rango de Sheets
      await writeSheet(`Auditoría!A${numeroFila}:P${numeroFila}`, [fila]);
    } else {
      await appendSheet("Auditoría!A1", [fila]);
    }

    return NextResponse.json({ ok: true, mes, result, referenciaML, mesesML, mesesMP });
  } catch (error) {
    console.error("[audit/analyze]", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

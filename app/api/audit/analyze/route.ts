import { NextResponse } from "next/server";
import axios from "axios";
import { parseAuditFiles, calculateAudit, detectarMesesEnArchivo, cicloEsperado } from "@/lib/audit";
import { ensureSheets, appendSheet, readSheet, writeSheet } from "@/lib/sheets";
import { getValidAccessToken, instalarReintento401 } from "@/lib/ml-token";
import { logError } from "@/lib/log";
import { withMlRetry } from "@/lib/http-retry";
import { calcularReferenciaVentas, ventasBrutasParaAuditoria, type ReferenciaVentas } from "@/lib/audit-referencia";
import { evaluarTasaEfectiva, fuenteVentasBrutas, HEADER_FUENTE } from "@/lib/audit-guardado";

// La referencia de ML recorre ~30 ventanas de un día (decenas de llamadas): hay que dar margen de tiempo a la función.
export const maxDuration = 60;

// Lock a nivel de aplicación para el upsert por mes (ver "Bug conocido:
// condición de carrera en upsert por mes" en docs/estado-metricas-y-pendientes.md).
// La API de Sheets no tiene compare-and-swap ni ETag para values.update, y un
// lock en memoria de proceso no sirve en Vercel (serverless, sin garantía de
// misma instancia entre requests) — se persiste en una hoja de control chica,
// igual que RentabilidadProgreso. Cubre el caso real (doble click/reintento
// del mismo usuario), no concurrencia masiva.
const LOCK_TTL_MS = 60000;

async function intentarAdquirirLock(mes: string): Promise<{ ok: true; fila: number | null } | { ok: false }> {
  const rows = await readSheet("AuditoriaLocks!A:B");
  const idx = rows.findIndex(r => r[0] === mes);
  const ahora = Date.now();
  if (idx >= 0) {
    const timestamp = Number(rows[idx][1]) || 0;
    if (ahora - timestamp < LOCK_TTL_MS) return { ok: false };
  }
  const fila = idx >= 0 ? idx + 1 : null;
  if (fila !== null) {
    await writeSheet(`AuditoriaLocks!A${fila}:B${fila}`, [[mes, String(ahora)]]);
  } else {
    await appendSheet("AuditoriaLocks!A:B", [[mes, String(ahora)]]);
  }
  return { ok: true, fila };
}

async function liberarLock(mes: string) {
  const rows = await readSheet("AuditoriaLocks!A:B");
  const idx = rows.findIndex(r => r[0] === mes);
  if (idx >= 0) {
    await writeSheet(`AuditoriaLocks!A${idx + 1}:B${idx + 1}`, [["", ""]]);
  }
}

async function fetchReferenciaML(mes: string): Promise<ReferenciaVentas | null> {
  const [yearStr, monthStr] = mes.split("-");
  const year = parseInt(yearStr);
  const month = parseInt(monthStr);
  if (!year || !month) return null;

  // Ciclo real de facturación (15→14, ver cicloEsperado en lib/audit.ts), no
  // el mes calendario — para que ventas_brutas quede en el mismo rango de
  // fechas que las comisiones calculadas desde los archivos de Facturación.
  const { desde, hasta: cicloHasta } = cicloEsperado(mes);
  const hasta = new Date(cicloHasta.getTime() + 86400000); // +1 día: el rango de calcularReferenciaVentas es exclusivo en "hasta"

  try {
    const token = await getValidAccessToken();
    const mlClient = axios.create({
      baseURL: "https://api.mercadolibre.com",
      headers: { Authorization: `Bearer ${token}` },
    });
    instalarReintento401(mlClient, token);
    const { data: user } = await mlClient.get("/users/me");
    // Por ventanas de un día (sin el tope de ~1.050 órdenes del offset). Con reintento ante 429/5xx transitorios.
    return await calcularReferenciaVentas((u) => withMlRetry(() => mlClient.get(u)), user.id, desde.getTime(), hasta.getTime());
  } catch (error) {
    logError("audit/analyze referencia ML", error);
    return null;
  }
}

export async function POST(request: Request) {
  let mesLockeado: string | null = null;
  try {
    const formData = await request.formData();
    const mes = (formData.get("mes") as string) ?? "Sin especificar";

    await ensureSheets(["Auditoría", "AuditoriaLocks"]);

    const lock = await intentarAdquirirLock(mes);
    if (!lock.ok) {
      return NextResponse.json(
        { ok: false, error: `Ya hay un análisis en curso para ${mes} — esperá unos segundos e intentá de nuevo.` },
        { status: 409 }
      );
    }
    mesLockeado = mes;

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
    // Solo una referencia COMPLETA pisa ventas_brutas; null (ML falló) o incompleta: se queda lo calculado desde el archivo de ML.
    const result = calculateAudit(mes, auditData, ventasBrutasParaAuditoria(referenciaML));
    const avisos: string[] = [];
    if (referenciaML?.aviso) {
      console.warn(`[audit/analyze] ${referenciaML.aviso}`);
      avisos.push(referenciaML.aviso);
    }

    // Si hay mismatch de cobertura, el análisis no corrió el cálculo (ver
    // calculateAudit) — no se guarda una fila vacía/engañosa en Sheets.
    if (result.error_cobertura) {
      return NextResponse.json({ ok: true, mes, result, referenciaML, avisos, mesesML, mesesMP });
    }

    // Una tasa efectiva mayor al 100 % es imposible (comisiones > ventas): no se guarda, con cualquier fuente de ventas_brutas
    // (también en el camino sin referencia de ML). Fuera del rango habitual solo se avisa.
    const evaluacion = evaluarTasaEfectiva(result.total_comisiones, result.ventas_brutas);
    if (evaluacion.rechazo) {
      console.warn(`[audit/analyze] ${mes}: análisis rechazado, tasa efectiva fuera de lo posible (no se guardó nada)`);
      return NextResponse.json({ ok: false, error: evaluacion.rechazo, tasaRechazada: true, mes, avisos }, { status: 422 });
    }
    if (evaluacion.aviso) avisos.push(evaluacion.aviso);
    const fuente = fuenteVentasBrutas(referenciaML);

    const headers = [
      "Mes", "Ventas Brutas", "Ventas Netas", "Comisiones ML", "Comisiones MP",
      "Comisiones MP (PX, no verificado)", "Total Comisiones", "Notas Crédito ML",
      "Recuperable", "Neto Recibido MP", "Tasa Efectiva %", "Flex Crédito",
      "Flex Débito", "Errores", "Resumen", "Analizado",
      // Préstamo intencional de esquema para Rentabilidad (ver
      // docs/estado-metricas-y-pendientes.md, sección "Diseño de
      // Rentabilidad por orden"): este dato conceptualmente pertenece a
      // Rentabilidad, no a Auditoría — se reutiliza esta hoja porque ya
      // tiene la forma correcta ("una fila por mes"). Se llena desde
      // /api/rentabilidad/analyze, no desde este endpoint — acá solo se
      // reserva la columna en el header para que quede vacía por defecto.
      "Almacenamiento_Full_Rentabilidad",
      // Columna R: de dónde salió ventas_brutas (referencia ML / referencia incompleta / archivo ML (sin referencia)).
      HEADER_FUENTE,
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
      // La fuente va aparte (R): la columna Q la escribe Rentabilidad y acá no se debe pisar.
      await writeSheet(`Auditoría!R${numeroFila}:R${numeroFila}`, [[fuente]]);
    } else {
      await appendSheet("Auditoría!A1", [[...fila, "", fuente]]); // "" = columna Q (Almacenamiento), que llena Rentabilidad
    }
    // El encabezado de la hoja se escribió con el esquema de cuando se creó (11 columnas): se agrega el de R si falta.
    const encabezadoR = await readSheet("Auditoría!R1:R1");
    if (!encabezadoR.length || !encabezadoR[0]?.length) await writeSheet("Auditoría!R1", [[HEADER_FUENTE]]);

    return NextResponse.json({ ok: true, mes, result, referenciaML, avisos, mesesML, mesesMP });
  } catch (error) {
    logError("audit/analyze", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  } finally {
    // Libera el lock en cualquier salida (éxito, error de cobertura,
    // archivos faltantes, o excepción) — nunca solo en el camino feliz,
    // para no dejar un mes bloqueado 60s por un error a mitad de camino.
    if (mesLockeado) await liberarLock(mesLockeado);
  }
}

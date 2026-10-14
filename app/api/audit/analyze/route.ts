import { NextResponse } from "next/server";
import axios from "axios";
import { parseAuditFiles, calculateAudit, detectarMesesEnArchivo, cicloEsperado } from "@/lib/audit";
import { ensureSheets, appendSheet, readSheet, writeSheet } from "@/lib/sheets";
import { conLock } from "@/lib/lock-sheets";
import { getValidAccessToken, instalarReintento401 } from "@/lib/ml-token";
import { logError } from "@/lib/log";
import { withMlRetry } from "@/lib/http-retry";
import { calcularReferenciaVentas, ventasBrutasParaAuditoria, type ReferenciaVentas } from "@/lib/audit-referencia";
import { evaluarTasaEfectiva, fuenteVentasBrutas, HEADER_FUENTE } from "@/lib/audit-guardado";

// La referencia de ML recorre ~30 ventanas de un día (decenas de llamadas): hay que dar margen de tiempo a la función.
export const maxDuration = 60;

// Mes a auditar: AAAA-MM con mes 01-12. Se valida ANTES de cualquier lectura/escritura (S-06) porque también forma la clave del lock
// («audit:AAAA-MM»): un mes ausente o raro ya no se analiza como «Sin especificar».
const MES_VALIDO = /^\d{4}-(0[1-9]|1[0-2])$/;

// Lo que ve el usuario cuando el lock no se obtuvo (el cliente muestra `error` tal cual). En ninguno de los dos casos se guardó nada.
function mensajeLockAuditoria(status: 409 | 503, mes: string): string {
  return status === 409
    ? `Ya hay otro análisis del mes ${mes} en curso (otra pestaña o un reintento). No se guardó nada de este intento; espera a que termine e inténtalo de nuevo.`
    : `No se pudo proteger la escritura del mes ${mes} (no se pudo verificar el bloqueo en la hoja Locks), así que no se analizó ni se guardó nada. Reintenta en un momento.`;
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

// Análisis de un mes ya validado; corre dentro del lock «audit:{mes}». Devuelve la respuesta HTTP (las excepciones salen por POST).
async function analizarMes(formData: FormData, mes: string): Promise<NextResponse> {
  await ensureSheets(["Auditoría"]);

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

  // Una tasa de cargos ML mayor al 100 % es imposible (cargos > ventas): no se guarda, con cualquier fuente de ventas_brutas
  // (también en el camino sin referencia de ML).
  const evaluacion = evaluarTasaEfectiva(result.total_comisiones, result.ventas_brutas);
  if (evaluacion.rechazo) {
    console.warn(`[audit/analyze] ${mes}: análisis rechazado, tasa de cargos ML fuera de lo posible (no se guardó nada)`);
    return NextResponse.json({ ok: false, error: evaluacion.rechazo, tasaRechazada: true, mes, avisos }, { status: 422 });
  }
  const fuente = fuenteVentasBrutas(referenciaML);

  const headers = [
    // C-12: la tasa usa solo cargos de ML. Las columnas de MP (E, F y J) se conservan para no correr los índices que leen
    // el historial y Rentabilidad, pero quedan VACÍAS: las comisiones de MP son solo informativas en el resultado.
    "Mes", "Ventas Brutas", "Ventas Netas", "Cargos ML (venta+envío+publicidad)", "(MP: no se guarda)",
    "(MP PX: no se guarda)", "Total Cargos ML", "Notas Crédito ML",
    "Recuperable", "(Neto MP: no se guarda)", "Tasa Cargos ML %", "Flex Crédito",
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
    "", // comisiones MP: informativas, no se persisten
    "", // comisiones MP PX: informativas, no se persisten
    result.total_comisiones,
    result.notas_credito_ml,
    result.recuperable,
    "", // neto recibido MP: informativo, no se persiste
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
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const mes = formData.get("mes");
    if (typeof mes !== "string" || !MES_VALIDO.test(mes)) {
      return NextResponse.json({ ok: false, error: "Mes inválido: debe tener el formato AAAA-MM (por ejemplo 2026-09). No se analizó ni se guardó nada." }, { status: 400 });
    }

    // Un análisis por mes a la vez (S-08, resuelve C-10: ya no se usa AuditoriaLocks, que dejaba filas en blanco). Si el lock no se
    // obtiene, o Sheets falla al pedirlo, no se escribe nada (falla cerrado).
    const r = await conLock(`audit:${mes}`, () => analizarMes(formData, mes));
    if (!r.ok) return NextResponse.json({ ok: false, error: mensajeLockAuditoria(r.status, mes) }, { status: r.status });
    return r.valor;
  } catch (error) {
    logError("audit/analyze", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

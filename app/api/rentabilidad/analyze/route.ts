import { NextResponse } from "next/server";
import axios from "axios";
import { ensureSheets, readSheet, appendSheet, writeSheet } from "@/lib/sheets";
import { getValidAccessToken } from "@/lib/ml-token";
import { createSyncBudget, withMlRetry, SyncRetryBudgetExceededError } from "@/lib/http-retry";
import { agruparPorOrdenReal, calcularFilaOrden, sumarAlmacenamiento, BillingDetailRow } from "@/lib/rentabilidad";

// Máximo permitido en el plan de Vercel (Hobby): 60s.
export const maxDuration = 60;

// La Billing API tiene rate limit de 5 requests/minuto (mucho más
// restrictivo que el resto de la API de ML, confirmado en la investigación
// de Auditoría) — con 13s de espera entre páginas, en una invocación de 45s
// alcanzan ~3 páginas (150 filas de cargo). Un mes completo (ej. 2489 filas
// en agosto) necesita múltiples invocaciones — mismo patrón idempotente que
// ya usa backfill-shipping: cada llamada retoma desde donde quedó y devuelve
// completo:false hasta terminar, para que el frontend la llame en loop.
const TIEMPO_MAXIMO_MS = 45000;
const ESPERA_ENTRE_PAGINAS_MS = 13000;
const HEADERS_RENTABILIDAD = [
  "ID Orden", "Fecha", "ID Item", "Producto", "Precio de Venta", "COGS",
  "Comisión", "Envío", "Pérdida/Devolución", "Margen Neto", "Margen %",
  "Multi-item", "Analizado",
];

// Hoja de control de progreso — necesaria porque Almacenamiento (CFWA) es
// agregado y no tiene order_id para deduplicar como sí se hace con las
// órdenes (ver idsYaGuardados): sin persistir el offset alcanzado, cada
// invocación reprocesaría las páginas ya vistas y duplicaría el conteo de
// Almacenamiento. Una fila por mes, mismo patrón upsert que Auditoría.
const HEADERS_PROGRESO = ["Mes", "Offset", "Almacenamiento Acumulado", "Completo"];

async function leerProgreso(mes: string): Promise<{ offset: number; almacenamiento: number; fila: number | null }> {
  const rows = await readSheet("RentabilidadProgreso!A:D");
  const idx = rows.findIndex(r => r[0] === mes);
  if (idx < 0) return { offset: 0, almacenamiento: 0, fila: null };
  return { offset: Number(rows[idx][1]) || 0, almacenamiento: Number(rows[idx][2]) || 0, fila: idx + 1 };
}

async function guardarProgreso(mes: string, offset: number, almacenamiento: number, completo: boolean, filaExistente: number | null) {
  const fila = [mes, String(offset), String(almacenamiento), completo ? "Sí" : ""];
  if (filaExistente !== null) {
    await writeSheet(`RentabilidadProgreso!A${filaExistente}:D${filaExistente}`, [fila]);
  } else {
    const existingHeaders = await readSheet("RentabilidadProgreso!A1:A1");
    if (!existingHeaders.length || !existingHeaders[0]?.length) {
      await appendSheet("RentabilidadProgreso!A1", [HEADERS_PROGRESO]);
    }
    await appendSheet("RentabilidadProgreso!A:D", [fila]);
  }
}

export async function POST(request: Request) {
  try {
    const { mes } = await request.json();
    if (!mes || typeof mes !== "string") {
      return NextResponse.json({ ok: false, error: "Falta el parámetro mes (YYYY-MM)" }, { status: 400 });
    }

    await ensureSheets(["Rentabilidad", "RentabilidadProgreso"]);

    const token = await getValidAccessToken();
    const client = axios.create({
      baseURL: "https://api.mercadolibre.com",
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    });
    const budget = createSyncBudget();
    const mlGet = <T = unknown>(url: string, params?: Record<string, unknown>) =>
      withMlRetry(() => client.get<T>(url, { params, headers: { "Api-Version": "1", "Content-Type": "application/json" } }), { budget });

    // Órdenes ya guardadas — para no re-consultar Billing por lo ya calculado.
    const existentes = await readSheet("Rentabilidad!A2:A100000");
    const idsYaGuardados = new Set(existentes.map(r => String(r[0]).replace(/^'/, "")).filter(Boolean));

    // COGS: Publicaciones!A (ID) → Publicaciones!F (Costo). Solo se agrega
    // al mapa si la celda de Costo tiene un valor real — una publicación que
    // existe en la hoja pero con Costo vacío NO debe tratarse como costo $0
    // (eso infla el margen falsamente), sino como "sin dato" — mismo caso
    // que un item_id que no aparece en Publicaciones en absoluto.
    const pubRows = await readSheet("Publicaciones!A2:F5000");
    const costoPorItemId = new Map<string, number>();
    for (const r of pubRows) {
      if (r[0] && r[5] !== undefined && r[5] !== null && r[5] !== "") {
        costoPorItemId.set(String(r[0]), Number(r[5]) || 0);
      }
    }

    const progreso = await leerProgreso(mes);
    const key = `${mes}-01`;
    const inicio = Date.now();
    let offset = progreso.offset;
    let almacenamientoAcumulado = progreso.almacenamiento;
    let completo = false;
    let filasProcesadas = 0;
    let ordenesNuevas = 0;
    let multiItemDetectadas = 0;
    const filasParaEscribir: string[][] = [];

    try {
      while (true) {
        if (Date.now() - inicio > TIEMPO_MAXIMO_MS) break;

        const { data } = await mlGet<{ results: BillingDetailRow[]; total: number }>(
          `/billing/integration/periods/key/${key}/group/ML/details`,
          { document_type: "BILL", limit: 50, offset }
        );
        filasProcesadas += data.results?.length ?? 0;
        almacenamientoAcumulado += sumarAlmacenamiento(data.results ?? []);

        const porOrden = agruparPorOrdenReal(data.results ?? []);
        for (const [ordenId, filas] of porOrden) {
          if (idsYaGuardados.has(ordenId)) continue;
          const fila = calcularFilaOrden(ordenId, filas, costoPorItemId);
          if (fila.multiItem) multiItemDetectadas++;
          idsYaGuardados.add(ordenId); // evita reprocesar la misma orden si aparece en más de una página
          ordenesNuevas++;
          filasParaEscribir.push([
            `'${fila.idOrden}`,
            fila.fecha,
            fila.idItem,
            fila.producto,
            String(fila.precioVenta),
            fila.cogs === null ? "" : String(fila.cogs),
            String(fila.comision),
            String(fila.envio),
            String(fila.perdida),
            fila.margenNeto === null ? "" : String(fila.margenNeto),
            fila.margenPct === null ? "" : String(fila.margenPct),
            fila.multiItem ? "Sí" : "",
            new Date().toLocaleString("es-CL"),
          ]);
        }

        offset += data.results?.length ?? 0;
        if (!data.results?.length || offset >= data.total) { completo = true; break; }
        if (Date.now() - inicio + ESPERA_ENTRE_PAGINAS_MS > TIEMPO_MAXIMO_MS) break; // no esperar si ya no alcanza para otra página
        await new Promise(r => setTimeout(r, ESPERA_ENTRE_PAGINAS_MS));
      }
    } catch (err) {
      if (!(err instanceof SyncRetryBudgetExceededError)) throw err;
      // Budget agotado: se corta acá, completo queda false para que el
      // frontend reintente — mismo patrón que backfill-shipping.
    }

    if (filasParaEscribir.length > 0) {
      const existingHeaders = await readSheet("Rentabilidad!A1:A1");
      if (!existingHeaders.length || !existingHeaders[0]?.length) {
        await appendSheet("Rentabilidad!A1", [HEADERS_RENTABILIDAD]);
      }
      await appendSheet("Rentabilidad!A:M", filasParaEscribir);
    }

    await guardarProgreso(mes, offset, almacenamientoAcumulado, completo, progreso.fila);

    // Almacenamiento se escribe en Auditoría solo al completar el mes — un
    // valor parcial (mientras el mes sigue en progreso entre invocaciones)
    // sería engañoso si alguien lo mira a mitad de un backfill.
    if (completo) {
      const auditoriaRows = await readSheet("Auditoría!A:A");
      const filaAuditoria = auditoriaRows.findIndex(r => r[0] === mes);
      if (filaAuditoria >= 0) {
        const numeroFila = filaAuditoria + 1;
        await writeSheet(`Auditoría!Q${numeroFila}:Q${numeroFila}`, [[String(almacenamientoAcumulado)]]);
      }
      // Si no hay fila de Auditoría para este mes todavía, no se crea una
      // solo por Almacenamiento — Auditoría se genera desde su propio
      // endpoint (archivos subidos), no desde acá.
    }

    return NextResponse.json({
      ok: true,
      mes,
      completo,
      filasProcesadas,
      ordenesNuevas,
      multiItemDetectadas,
      almacenamientoAcumulado,
    });
  } catch (error) {
    console.error("[rentabilidad/analyze]", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

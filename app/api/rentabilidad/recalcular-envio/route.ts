import { NextResponse } from "next/server";
import axios from "axios";
import { readSheet, batchWriteSheet, appendSheet } from "@/lib/sheets";
import { getValidAccessToken } from "@/lib/ml-token";
import { createSyncBudget, withMlRetry, SyncRetryBudgetExceededError } from "@/lib/http-retry";
import { calcularMargen } from "@/lib/rentabilidad";
import { procesarTanda } from "@/lib/envio-real";

// Recálculo del envío de las filas YA EXISTENTES de Rentabilidad con el fix
// de despacho compartido (ver lib/envio-real.ts y docs/estado-metricas-y-
// pendientes.md, sección "Envío Full/xd_drop_off", puntos g/h). No vuelve a
// pasar por la Billing API — usa /orders/{id} → /shipments/{id} →
// /shipments/{id}/costs directo, igual que rentabilidad/analyze para
// órdenes nuevas.
//
// Checkpoint por la propia columna "Fuente Envío" (P, índice 15) de
// Rentabilidad — no hace falta una hoja de progreso aparte: cada fila de
// Rentabilidad es la unidad de trabajo y su propio estado dice si ya se
// recalculó.
//   "" o "billing" (valor de antes de este fix): pendiente, se reprocesa.
//   "costs": ya tiene el envío real, se salta.
//   "billing_sin_costs": /shipments/{id}/costs falló en un intento
//     anterior — no se reintenta en bucle; solo con forzarReintentos:true.
//
// La lógica de una tanda vive en lib/envio-real.ts (procesarTanda) —
// compartida con rentabilidad/completar, que la invoca en loop con
// condiciones de parada. Ver ese endpoint para el modo automático.
//
// Escritura: sin body (o sin confirmar:true) corre en modo simulación y no
// toca el Sheet; solo escribe con { "confirmar": true }.
export const maxDuration = 60;
const TIEMPO_MAXIMO_MS = 40000;

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const forzarReintentos = body?.forzarReintentos === true;
    // Por defecto SIMULA (no escribe en Sheets), igual que rentabilidad/
    // completar — decisión de Otto 2026-10-05: solo escribe con
    // confirmar:true explícito en el body. dryRun:true se sigue respetando
    // (aunque venga con confirmar:true, gana la simulación).
    const confirmar = body?.confirmar === true;
    const dryRun = !confirmar || body?.dryRun === true;
    const dryRunLimite = Number.isInteger(body?.dryRunLimite) && body.dryRunLimite > 0 ? body.dryRunLimite : 20;
    const omitirMarca = body?.omitirMarca === true;
    const limite = Number.isInteger(body?.limite) && body.limite > 0 ? body.limite : null;

    const token = await getValidAccessToken();
    const client = axios.create({
      baseURL: "https://api.mercadolibre.com",
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    });
    const budget = createSyncBudget();
    const mlGet = <T = unknown>(url: string) =>
      withMlRetry(() => client.get<T>(url, { headers: { "Api-Version": "1", "Content-Type": "application/json" } }), { budget });

    const resultado = await procesarTanda({
      mlGet, readSheet, appendSheet, batchWriteSheet, calcularMargen,
      forzarReintentos, dryRun, dryRunLimite, omitirMarca, limite,
      tiempoMaximoMs: TIEMPO_MAXIMO_MS,
    });

    return NextResponse.json({
      ok: true,
      dryRun,
      completo: resultado.completo,
      envioSubio: resultado.envioSubio,
      recalculadas: resultado.recalculadas,
      billingSinCosts: resultado.billingSinCosts,
      antesDespues: dryRun ? resultado.antesDespues : resultado.antesDespues.slice(0, 5),
      saltadas: resultado.saltadas,
      pendientes: resultado.pendientes,
      mixto: resultado.mixto,
    });
  } catch (error) {
    if (error instanceof SyncRetryBudgetExceededError) {
      return NextResponse.json({ ok: false, error: "Budget agotado, reintentar" }, { status: 503 });
    }
    console.error("[rentabilidad/recalcular-envio]", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

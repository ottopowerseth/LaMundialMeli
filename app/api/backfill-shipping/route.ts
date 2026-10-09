import { NextRequest, NextResponse } from "next/server";
import axios from "axios";
import { ensureSheets, readSheet, appendSheet } from "@/lib/sheets";
import { getValidAccessToken } from "@/lib/ml-token";
import { ejecutarBackfill } from "@/lib/backfill-shipping";

// Backfill del histórico de ShippingCache: completa logistic_type de las
// órdenes que ml-sync no cubre (tope de 150 nuevas por sync, ventana de 35
// días). La lógica está en lib/backfill-shipping.ts: ventanas de un día
// (sin depender del tope de offset), canceladas excluidas, escrituras
// agrupadas, columna A releída antes de escribir y corte a los 40 s.
//
// Body JSON (todo opcional): { dias (1-180, default 120), seco (true = no
// consulta /shipments ni escribe), cursorHastaMs (lo devuelve la corrida
// anterior), incluirCanceladas + idsEsperados (pase opt-in: resuelve solo las
// canceladas con envío sin tipo; escribe únicamente si coinciden exactamente
// con idsEsperados) }. Idempotente: ShippingCache es el cursor real de progreso.

// Máximo permitido en el plan de Vercel (Hobby): 60s.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const seco = body?.seco === true;

    if (!seco) await ensureSheets(["ShippingCache"]);

    const token = await getValidAccessToken();
    const mlClient = axios.create({
      baseURL: "https://api.mercadolibre.com",
      headers: { Authorization: `Bearer ${token}` },
      timeout: 8000,
    });
    const { data: user } = await mlClient.get<{ id: string }>("/users/me");

    const resultado = await ejecutarBackfill(
      {
        get: <T,>(url: string) => mlClient.get<T>(url),
        userId: user.id,
        leerHoja: async (rango) => {
          try { return await readSheet(rango); } catch { return []; } // primera vez, hoja recién creada
        },
        agregarFilas: (filas) => appendSheet("ShippingCache!A:D", filas),
      },
      {
        dias: body?.dias,
        seco,
        cursorHastaMs: typeof body?.cursorHastaMs === "number" ? body.cursorHastaMs : null,
        incluirCanceladas: body?.incluirCanceladas === true,
        idsEsperados: Array.isArray(body?.idsEsperados) ? body.idsEsperados.map(String) : undefined,
      }
    );

    return NextResponse.json({ ok: true, ...resultado });
  } catch (error) {
    console.error("[backfill-shipping]", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

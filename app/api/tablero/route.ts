import { NextRequest, NextResponse } from "next/server";
import axios from "axios";
import { readSheet } from "@/lib/sheets";
import { getValidAccessToken } from "@/lib/ml-token";
import { withMlRetry } from "@/lib/http-retry";
import { parsearTarifasEnvio } from "@/lib/envio-medido";
import { cargarVentas, ventanaPorDias } from "@/lib/tablero-datos";
import { calcularConfianza, resumirVentas, variacion } from "@/lib/tablero-resumen";

// Tablero "desde arriba": un solo endpoint, calculado en vivo y sin hojas
// nuevas. Todas las secciones comparten los mismos datos — 120 días de órdenes
// (~6 s), un lote de atributos y 4 lecturas de hojas — así que no hace falta
// caché ni lotes (cabe holgado en los 60 s de Vercel).
//
// Query (todo opcional): dias (ventana principal, 1-120, default 30);
// desde/hasta (ISO) fijan la ventana exacta — sirve para verificar los totales
// contra Métricas con la misma ventana.
export const maxDuration = 60;

const DIAS_DEFAULT = 30;
const HISTORIA_DIAS = 120;
const DIA_MS = 86400000;

export async function GET(req: NextRequest) {
  try {
    const q = new URL(req.url).searchParams;
    const diasParam = Number(q.get("dias"));
    const dias = Number.isInteger(diasParam) && diasParam >= 1 && diasParam <= HISTORIA_DIAS ? diasParam : DIAS_DEFAULT;
    const ahora = new Date();

    let { desdeMs, hastaMs } = ventanaPorDias(dias, ahora);
    const d = Date.parse(q.get("desde") ?? ""), h = Date.parse(q.get("hasta") ?? "");
    if (!Number.isNaN(d) && !Number.isNaN(h) && h > d) { desdeMs = d; hastaMs = h; }
    const duracion = hastaMs - desdeMs;
    const anterior = { desdeMs: desdeMs - duracion, hastaMs: desdeMs };

    const token = await getValidAccessToken();
    const client = axios.create({ baseURL: "https://api.mercadolibre.com", headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });
    // Sin budget a propósito (ver revision-publicaciones): 3 intentos cubren 429.
    const mlGet = <T = unknown>(url: string) => withMlRetry(() => client.get<T>(url), { maxAttempts: 3 });

    // Desde hace 120 días (o desde donde empiece el período anterior, si es más
    // atrás) hasta el fin de la ventana.
    const historiaDesde = Math.min(anterior.desdeMs, hastaMs - HISTORIA_DIAS * DIA_MS);

    const [ventas, filasPub, filasTarifa, filasOrigen] = await Promise.all([
      (async () => {
        const { data: user } = await mlGet<{ id: number }>("/users/me");
        return cargarVentas(mlGet, user.id, historiaDesde, hastaMs);
      })(),
      readSheet("Publicaciones!A2:S3000"),
      readSheet("TarifaEnvio!A2:L5000").catch(() => [] as string[][]),
      readSheet("CostoOrigen!A2:J5000").catch(() => [] as string[][]),
    ]);

    const costoPorItem = new Map<string, number | null>();
    for (const r of filasPub) {
      if (!r[0]) continue;
      const c = Number(String(r[5] ?? "").trim());
      costoPorItem.set(String(r[0]), String(r[5] ?? "").trim() !== "" && Number.isFinite(c) && c > 0 ? c : null);
    }
    const origenPorItem = new Map<string, string>();
    for (const r of filasOrigen) if (r[0]) origenPorItem.set(String(r[0]), r[2] ?? "");
    const tarifas = parsearTarifasEnvio(filasTarifa);

    const actual = resumirVentas(ventas.ordenes, ventas.lineas, desdeMs, hastaMs);
    const previo = resumirVentas(ventas.ordenes, ventas.lineas, anterior.desdeMs, anterior.hastaMs);
    const confianza = calcularConfianza({
      lineas: ventas.lineas.filter((l) => l.ms >= desdeMs && l.ms < hastaMs),
      costoPorItem, origenPorItem, tarifas,
    });

    return NextResponse.json({
      ok: true,
      generadoEn: new Date().toISOString(),
      ventana: { desde: new Date(desdeMs).toISOString(), hasta: new Date(hastaMs).toISOString(), dias: Math.round(duracion / DIA_MS) },
      resumen: {
        actual, anterior: previo,
        variaciones: {
          ingresos: variacion(actual.ingresos, previo.ingresos),
          unidades: variacion(actual.unidades, previo.unidades),
          ordenes: variacion(actual.ordenes, previo.ordenes),
          ticket: variacion(actual.ticket, previo.ticket),
        },
      },
      confianza,
    });
  } catch (error) {
    console.error("[tablero]", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import axios from "axios";
import { readSheet } from "@/lib/sheets";
import { getValidAccessToken } from "@/lib/ml-token";
import { withMlRetry } from "@/lib/http-retry";
import { ventanaPorDias } from "@/lib/tablero-datos";
import { cargarReclamosPorTipo } from "@/lib/reclamos-datos";

// Reclamos por tipo logístico, A PEDIDO (no corre con /api/tablero ni /api/metrics).
// Query: dias (1-180, default 120; ventana alineada a días UTC) o desde/hasta (ISO);
// refrescar=1 ignora el caché. Caché en memoria de ~10 min por ventana (por instancia).
// Solo lectura: no escribe en Sheets.
export const maxDuration = 60;

const VIGENCIA_MS = 10 * 60 * 1000;
const DIAS_DEFAULT = 120;
const DIAS_MAX = 180;
const cache = new Map<string, { ts: number; data: unknown }>();

export async function GET(req: NextRequest) {
  try {
    const q = new URL(req.url).searchParams;
    const diasParam = Number(q.get("dias"));
    const dias = Number.isInteger(diasParam) && diasParam >= 1 && diasParam <= DIAS_MAX ? diasParam : DIAS_DEFAULT;
    let { desdeMs, hastaMs } = ventanaPorDias(dias, new Date());
    const d = Date.parse(q.get("desde") ?? ""), h = Date.parse(q.get("hasta") ?? "");
    if (!Number.isNaN(d) && !Number.isNaN(h) && h > d) { desdeMs = d; hastaMs = h; }

    const clave = `${desdeMs}|${hastaMs}`;
    const previo = cache.get(clave);
    if (q.get("refrescar") !== "1" && previo && Date.now() - previo.ts < VIGENCIA_MS) {
      return NextResponse.json({ ok: true, ...(previo.data as object), desdeCache: true, antiguedadSeg: Math.round((Date.now() - previo.ts) / 1000) });
    }

    const t0 = Date.now();
    const token = await getValidAccessToken();
    const client = axios.create({ baseURL: "https://api.mercadolibre.com", headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });
    const get = <T = unknown>(url: string) => withMlRetry(() => client.get<T>(url), { maxAttempts: 3 });
    const { data: user } = await get<{ id: number }>("/users/me");

    const r = await cargarReclamosPorTipo({
      get, userId: user.id, desdeMs, hastaMs,
      leerShippingCache: () => readSheet("ShippingCache!A2:C100000").catch(() => [] as string[][]),
    });
    const data = { generadoEn: new Date().toISOString(), duracionMs: Date.now() - t0, desde: new Date(desdeMs).toISOString(), hasta: new Date(hastaMs).toISOString(), ...r };
    cache.set(clave, { ts: Date.now(), data });
    return NextResponse.json({ ok: true, ...data, desdeCache: false });
  } catch (error) {
    console.error("[reclamos-tipo]", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

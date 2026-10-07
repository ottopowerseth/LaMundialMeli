import { NextResponse } from "next/server";
import axios from "axios";
import { ensureSheets, readSheet, writeSheet, appendSheet, batchWriteSheet } from "@/lib/sheets";
import { getValidAccessToken } from "@/lib/ml-token";
import { withMlRetry } from "@/lib/http-retry";
import { HOJA_TARIFA_ENVIO, obtenerVentasPorItem, procesarTarifas } from "@/lib/tarifa-envio";

// Cachea en la hoja "TarifaEnvio" la tarifa de envío por unidad de cada
// publicación con ventas recientes (ver lib/tarifa-envio.ts para el método,
// la base de IVA, el manejo de despachos compartidos y el respaldo "estimado"
// para publicaciones sin muestra propia). Es insumo del margen de
// contribución por SKU del tablero.
//
// Por defecto SIMULA (calcula y devuelve, sin escribir en Sheets), igual que
// rentabilidad/completar: solo escribe con { "confirmar": true }. Sin estado
// entre invocaciones — la hoja es el checkpoint, así que se llama repetido
// hasta que "pendientesDespues" llegue a 0.
//
// Body (todo opcional): { confirmar, dias (ventana de ventas, 1-120, default
// 45), limite (máx. publicaciones por invocación), forzar (ignora la
// vigencia de la caché) }.
export const maxDuration = 60;

// Tiempo para el cálculo de tarifas, descontado lo que tardan la lectura de
// órdenes (~3 s) y de atributos (~3 s) y dejando margen para escribir.
const TIEMPO_PROCESO_MS = 35000;
const DIAS_DEFAULT = 45;

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const confirmar = body?.confirmar === true;
    const dias = Number.isInteger(body?.dias) && body.dias >= 1 && body.dias <= 120 ? body.dias : DIAS_DEFAULT;
    const limite = Number.isInteger(body?.limite) && body.limite > 0 ? body.limite : null;
    const forzar = body?.forzar === true;

    const token = await getValidAccessToken();
    const client = axios.create({
      baseURL: "https://api.mercadolibre.com",
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    });
    // Sin budget a propósito (ver revision-publicaciones): un 404 puntual de
    // un despacho viejo no debe cortar la corrida. 3 intentos cubren 429.
    const mlGet = <T = unknown>(url: string) => withMlRetry(() => client.get<T>(url), { maxAttempts: 3 });

    const { data: user } = await mlGet<{ id: number }>("/users/me");
    const ventas = await obtenerVentasPorItem(mlGet, user.id, dias);

    // SELLER_SKU (legible en la hoja; la clave de la caché es el id de
    // publicación) y tipo logístico vigente (para el respaldo estimado).
    const ids = [...ventas.keys()];
    const skuPorItem = new Map<string, string>();
    const logisticoPorItem = new Map<string, string>();
    for (let i = 0; i < ids.length; i += 20) {
      const { data } = await mlGet<{ code: number; body: { id: string; attributes?: { id: string; value_name?: string | null }[]; shipping?: { logistic_type?: string } } }[]>(
        `/items?ids=${ids.slice(i, i + 20).join(",")}&attributes=id,attributes,shipping`
      );
      for (const r of data) {
        if (r.code !== 200) continue;
        const sku = r.body.attributes?.find((a) => a.id === "SELLER_SKU")?.value_name?.trim();
        if (sku) skuPorItem.set(r.body.id, sku);
        if (r.body.shipping?.logistic_type) logisticoPorItem.set(r.body.id, r.body.shipping.logistic_type);
      }
    }

    if (confirmar) await ensureSheets([HOJA_TARIFA_ENVIO]);

    const resultado = await procesarTarifas({
      mlGet, readSheet, writeSheet, appendSheet, batchWriteSheet,
      ventas, skuPorItem, logisticoPorItem, ahora: new Date(),
      dryRun: !confirmar, forzar, limite, tiempoMaximoMs: TIEMPO_PROCESO_MS,
    });

    return NextResponse.json({
      ok: true,
      ...resultado,
      // En simulación se devuelve el detalle para revisarlo; en escritura,
      // solo una muestra (el detalle ya quedó en la hoja).
      filas: resultado.filas.slice(0, confirmar ? 5 : 40).map((f) => ({ itemId: f.itemId, sku: f.sku, ...f.r })),
    });
  } catch (error) {
    console.error("[tarifa-envio]", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

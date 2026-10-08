import { NextRequest, NextResponse } from "next/server";
import axios from "axios";
import { readSheet } from "@/lib/sheets";
import { getValidAccessToken } from "@/lib/ml-token";
import { withMlRetry } from "@/lib/http-retry";
import { parsearTarifasEnvio } from "@/lib/envio-medido";
import { calcularEnvioEstimadoPorUnidad } from "@/lib/envio-estimado";
import { cargarItemsStock, cargarVentas, ventanaPorDias } from "@/lib/tablero-datos";
import { contextoEnvioDesdeDatos, costoPorItemDesdeHoja, margenDesdeDatos } from "@/lib/tablero-margen-datos";
import { cargarEsCatalogo, cargarPriceToWin } from "@/lib/precio-para-ganar-datos";
import { analizarPrecioParaGanar } from "@/lib/precio-para-ganar";

// Precio para ganar (price_to_win de ML) frente al precio actual y al precio de
// equilibrio. SOLO LECTURA: no escribe en ML ni en Sheets y no sugiere acciones. A
// pedido (la pantalla lo llama con un botón); ventana FIJA de 30 días (price_to_win
// es un estado actual; la ventana solo da el contexto de ventas, comisión real y
// margen). ~20 s: órdenes de 30 días (~25 llamadas), estado de las publicaciones
// vendidas (~15), una consulta de price_to_win por publicación activa (~240, de a 5)
// y 2 hojas. Ver lib/precio-para-ganar.ts para las definiciones y el porqué de cada
// escenario de envío.
export const maxDuration = 60;

const DIAS = 30;

export async function GET(_req: NextRequest) {
  try {
    const ahora = new Date();
    const { desdeMs, hastaMs } = ventanaPorDias(DIAS, ahora);

    const token = await getValidAccessToken();
    const client = axios.create({ baseURL: "https://api.mercadolibre.com", headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });
    const mlGet = <T = unknown>(url: string) => withMlRetry(() => client.get<T>(url), { maxAttempts: 3 });

    const yoP = mlGet<{ id: number }>("/users/me").then((r) => r.data);
    const [ventas, filasPub, filasTarifa] = await Promise.all([
      yoP.then((u) => cargarVentas(mlGet, u.id, desdeMs, hastaMs)),
      readSheet("Publicaciones!A2:S3000"),
      readSheet("TarifaEnvio!A2:L5000").catch(() => [] as string[][]),
    ]);

    // Margen de contribución con el mismo módulo que el Tablero (lib/tablero-margen-datos.ts).
    const lineas = ventas.lineas.filter((l) => l.ms >= desdeMs && l.ms < hastaMs);
    const idsVendidos = [...new Set(lineas.map((l) => l.item))];
    const itemsMl = await cargarItemsStock(mlGet, idsVendidos);
    const estadoPorItem = new Map<string, string>();
    const fullPorItem = new Map<string, boolean>();
    for (const it of itemsMl.values()) {
      estadoPorItem.set(it.id, it.estado);
      fullPorItem.set(it.id, it.full);
    }
    const tarifas = parsearTarifasEnvio(filasTarifa);
    const margen = margenDesdeDatos({ filasPub, fullPorItem, tarifas, costoPorItem: costoPorItemDesdeHoja(filasPub), lineas });

    // price_to_win solo de las publicaciones ACTIVAS (las pausadas no participan).
    const activos = idsVendidos.filter((id) => estadoPorItem.get(id) === "active");
    const ptw = await cargarPriceToWin(mlGet, activos);
    const noParticipan = activos.filter((id) => ptw.get(id)?.status === "not_listed");
    const esCatalogo = await cargarEsCatalogo(mlGet, noParticipan);

    // Envío típico del tramo de precio (mediana de las tarifas medidas) para el precio para ganar.
    const { ctxEnvio } = contextoEnvioDesdeDatos({ filasPub, fullPorItem, tarifas });
    const envioTipicoTramo = (precio: number, full: boolean) => {
      const e = calcularEnvioEstimadoPorUnidad("__tramo__", precio, full, ctxEnvio.muestras, null);
      return e.muestras > 0 && e.envio > 0 ? e.envio : null;
    };

    const analisis = analizarPrecioParaGanar({ margenFilas: margen.filas, estadoPorItem, ptw, esCatalogo, envioTipicoTramo });

    return NextResponse.json({
      ok: true,
      generadoEn: new Date().toISOString(),
      ventana: { dias: DIAS, desde: new Date(desdeMs).toISOString(), hasta: new Date(hastaMs).toISOString() },
      // Calidad del equilibrio: cuánto del margen usa Costo y cuánto envío estimado.
      calidadMargen: { coberturaCostoPct: margen.resumen.total.coberturaPct, envioEstimadoPctIngreso: margen.resumen.menosFiable.pctIngreso },
      resumen: analisis.resumen,
      filas: analisis.filas,
    });
  } catch (error) {
    console.error("[precio-para-ganar]", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

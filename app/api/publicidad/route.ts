import { NextRequest, NextResponse } from "next/server";
import axios from "axios";
import { readSheet } from "@/lib/sheets";
import { getValidAccessToken } from "@/lib/ml-token";
import { withMlRetry } from "@/lib/http-retry";
import { resolverAdvertiser } from "@/lib/ml-ads";
import { parsearTarifasEnvio } from "@/lib/envio-medido";
import { cargarItemsStock, cargarVentas, ventanaPorDias } from "@/lib/tablero-datos";
import { costoPorItemDesdeHoja, margenDesdeDatos } from "@/lib/tablero-margen-datos";
import { resumirVentas } from "@/lib/tablero-resumen";
import { cargarAnunciosMl, cargarCampanasMl } from "@/lib/publicidad-datos";
import { analizarPublicidad } from "@/lib/publicidad-equilibrio";

// ACoS real, ACoS de equilibrio y TACoS de Product Ads. SOLO LECTURA: no escribe
// en ML ni en Sheets y no sugiere acciones. A pedido (la pantalla lo llama con un
// botón); ~10 s: campañas y anuncios (~15 llamadas), órdenes de la ventana (~25),
// estado de las publicaciones vendidas (~15) y 2 hojas.
//
// Query: dias = 7 | 30 | 90 (default 30). La ventana es la del Tablero (días UTC
// que incluyen hoy), y las fechas de Ads son los mismos días (ambos extremos
// incluidos). Ver lib/publicidad-equilibrio.ts: el gasto de Ads viene SIN IVA
// (verificado contra Billing) y por eso se informa sin y con IVA.
export const maxDuration = 60;

const DIAS_PERMITIDOS = [7, 30, 90];
const DIA_MS = 86400000;

export async function GET(req: NextRequest) {
  try {
    const diasParam = Number(new URL(req.url).searchParams.get("dias"));
    const dias = DIAS_PERMITIDOS.includes(diasParam) ? diasParam : 30;
    const ahora = new Date();
    const { desdeMs, hastaMs } = ventanaPorDias(dias, ahora);
    const dateFrom = new Date(desdeMs).toISOString().slice(0, 10);
    const dateTo = new Date(hastaMs - DIA_MS).toISOString().slice(0, 10);

    const token = await getValidAccessToken();
    const client = axios.create({ baseURL: "https://api.mercadolibre.com", headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });
    const mlGet = <T = unknown>(url: string) => withMlRetry(() => client.get<T>(url), { maxAttempts: 3 });
    const mlGetParams = <T = unknown>(url: string, params?: Record<string, unknown>, headers?: Record<string, string>) =>
      withMlRetry(() => client.get<T>(url, { params, headers }), { maxAttempts: 3 });

    const advertiser = await resolverAdvertiser(mlGetParams);
    if (!advertiser) return NextResponse.json({ ok: false, error: "No hay advertiser de Product Ads asociado a esta cuenta" }, { status: 404 });

    const yoP = mlGet<{ id: number }>("/users/me").then((r) => r.data);
    const [ventas, filasPub, filasTarifa, campanas, anuncios] = await Promise.all([
      yoP.then((u) => cargarVentas(mlGet, u.id, desdeMs, hastaMs)),
      readSheet("Publicaciones!A2:S3000"),
      readSheet("TarifaEnvio!A2:L5000").catch(() => [] as string[][]),
      cargarCampanasMl(mlGetParams, advertiser, dateFrom, dateTo),
      cargarAnunciosMl(mlGetParams, advertiser, dateFrom, dateTo),
    ]);

    // Margen de contribución con el mismo módulo que el Tablero (lib/tablero-margen-datos.ts).
    const lineas = ventas.lineas.filter((l) => l.ms >= desdeMs && l.ms < hastaMs);
    const idsVendidos = [...new Set(lineas.map((l) => l.item))];
    const itemsMl = await cargarItemsStock(mlGet, idsVendidos);
    const fullPorItem = new Map<string, boolean>();
    for (const it of itemsMl.values()) fullPorItem.set(it.id, it.full);
    for (const a of anuncios) if (a.costo > 0 && !fullPorItem.has(a.itemId)) fullPorItem.set(a.itemId, false);
    const margen = margenDesdeDatos({
      filasPub, fullPorItem, tarifas: parsearTarifasEnvio(filasTarifa), costoPorItem: costoPorItemDesdeHoja(filasPub), lineas,
    });

    const ventasCuenta = resumirVentas(ventas.ordenes, ventas.lineas, desdeMs, hastaMs).ingresos;
    const analisis = analizarPublicidad({
      campanas, anuncios, margenFilas: margen.filas, fullPorItem, ventasCuenta, margenTotalPct: margen.resumen.total.margenPct,
    });

    return NextResponse.json({
      ok: true,
      generadoEn: new Date().toISOString(),
      ventana: { dias, desde: new Date(desdeMs).toISOString(), hasta: new Date(hastaMs).toISOString(), dateFrom, dateTo },
      // Calidad del equilibrio: cuánto del margen usa Costo y cuánto envío estimado.
      calidadMargen: { coberturaCostoPct: margen.resumen.total.coberturaPct, envioEstimadoPctIngreso: margen.resumen.menosFiable.pctIngreso, margenTotalPct: margen.resumen.total.margenPct },
      resumen: analisis.resumen,
      campanas: analisis.campanas,
      filas: analisis.filas,
    });
  } catch (error) {
    console.error("[publicidad]", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

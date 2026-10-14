import { NextRequest, NextResponse } from "next/server";
import { readSheet } from "@/lib/sheets";
import { logError } from "@/lib/log";
import { parsearLogisticoPorOrden } from "@/lib/logistica";
import {
  armarFilasForecast, armarResumen, demandaPorItem, ultimaVentaClasificada,
  NOTAS_DIFERENCIA_TABLERO, type ParametrosForecast,
} from "@/lib/forecast";

// Tope de filas que se leen de Publicaciones y de Ventas (antes 2.000 y 5.000).
const TOPE_FILAS_FORECAST = 20000;

// Plazo en días de un parámetro de la URL: debe ser un número finito >= minimo; si no viene o no sirve, el valor por defecto.
function plazo(sp: URLSearchParams, clave: string, porDefecto: number, minimo: number): number {
  const crudo = sp.get(clave);
  if (crudo === null || crudo.trim() === "") return porDefecto;
  const v = Number(crudo);
  return Number.isFinite(v) && v >= minimo ? v : porDefecto;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  // leadTimeDays / safetyDays (los de siempre) valen para los dos modos; leadTimeFull / safetyFull / leadTimeNormal / safetyNormal los afinan por modo.
  const lead = plazo(searchParams, "leadTimeDays", 15, 1);
  const safety = plazo(searchParams, "safetyDays", 7, 0);
  const parametros: ParametrosForecast = {
    full: { lead: plazo(searchParams, "leadTimeFull", lead, 1), safety: plazo(searchParams, "safetyFull", safety, 0) },
    normal: { lead: plazo(searchParams, "leadTimeNormal", lead, 1), safety: plazo(searchParams, "safetyNormal", safety, 0) },
  };

  try {
    const [pubRows, ventaRows, cacheRows, costoRows] = await Promise.all([
      readSheet(`Publicaciones!A2:T${TOPE_FILAS_FORECAST}`),
      readSheet(`Ventas!A2:K${TOPE_FILAS_FORECAST}`),
      readSheet("ShippingCache!A2:C100000"),
      readSheet("CostoOrigen!A2:G5000").catch(() => null), // solo para «SKU en ambos modos»; si falta la pestaña, el resto sigue
    ]);

    // Filas cortas: Publicaciones escrita por un sync anterior a la columna T trae 19 columnas (r[19] undefined → tipo vacío).
    const publicaciones = pubRows
      .filter((r) => r[0] && r[10] !== "closed")
      .map((r) => ({
        id: String(r[0]),
        titulo: r[2] ?? "",
        stock: Number(r[3]) || 0,
        estadoML: r[10] ?? "",
        tipoT: String(r[19] ?? ""),
      }));

    const tipoPorOrden = parsearLogisticoPorOrden(cacheRows);
    const hace30d = new Date(Date.now() - 30 * 86400000);
    const demanda = demandaPorItem(ventaRows, hace30d, tipoPorOrden);
    const ultimaVenta = ultimaVentaClasificada(ventaRows, tipoPorOrden);
    const rows = armarFilasForecast({ publicaciones, demanda, ultimaVenta, parametros, hoy: new Date() });

    // SKU de cada publicación: Cod Defontana (G) o, si falta, SKU (B) de CostoOrigen.
    const skuPorItem = new Map<string, string>();
    for (const r of costoRows ?? []) {
      const sku = String(r[6] || r[1] || "").trim();
      if (r[0] && sku) skuPorItem.set(String(r[0]), sku);
    }
    const resumen = armarResumen(rows, skuPorItem);

    // Aviso en pantalla si alguna de las hojas se acerca al tope de lectura (80 %): así un recorte no pasa en silencio.
    const filasMax = Math.max(pubRows.length, ventaRows.length);
    const avisos: string[] = [];
    if (filasMax >= TOPE_FILAS_FORECAST * 0.8) avisos.push(`Una de las hojas (Publicaciones o Ventas) tiene ${filasMax} filas y se acerca al tope de lectura de ${TOPE_FILAS_FORECAST}.`);
    if (costoRows === null) avisos.push("No se pudo leer CostoOrigen: el resumen no puede listar los SKU que están en Full y en Normal.");
    const avisoTope = avisos.length > 0 ? avisos.join(" ") : undefined;

    return NextResponse.json({
      ok: true, leadTimeDays: lead, safetyDays: safety, parametros, rows, resumen, notasDiferenciaTablero: NOTAS_DIFERENCIA_TABLERO,
      ...(avisoTope ? { avisoTope } : {}), timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logError("forecast", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

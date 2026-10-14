import { NextRequest, NextResponse } from "next/server";
import { readSheet } from "@/lib/sheets";
import { logError } from "@/lib/log";
import { unidadesPorItem } from "@/lib/forecast-demanda";

// Tope de filas que se leen de Publicaciones y de Ventas (antes 2.000 y 5.000).
const TOPE_FILAS_FORECAST = 20000;

type Prioridad = "SIN_STOCK" | "URGENTE" | "PRONTO" | "OK" | "SIN_DATOS";

type ForecastRow = {
  id: string;
  titulo: string;
  stockActual: number;
  ventas30d: number;
  velocidadDiaria: number;
  diasRestantes: number | null;
  fechaQuiebre: string | null;
  cantidadSugerida: number;
  prioridad: Prioridad;
  estadoML: string;
};

function formatFechaCL(d: Date): string {
  return d.toLocaleDateString("es-CL");
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const leadTimeDays = Number(searchParams.get("leadTimeDays")) || 15;
  const safetyDays = Number(searchParams.get("safetyDays")) || 7;

  try {
    const [pubRows, ventaRows] = await Promise.all([
      readSheet(`Publicaciones!A2:R${TOPE_FILAS_FORECAST}`),
      readSheet(`Ventas!A2:J${TOPE_FILAS_FORECAST}`),
    ]);

    const publicaciones = pubRows
      .filter((r) => r[0] && r[10] !== "closed")
      .map((r) => ({
        id: String(r[0]),
        titulo: r[2] ?? "",
        stock: Number(r[3]) || 0,
        estadoML: r[10] ?? "",
      }));

    // Demanda de los últimos 30 días por ID Item, sin órdenes canceladas (lib/forecast-demanda.ts).
    const ventasPorId = unidadesPorItem(ventaRows, new Date(Date.now() - 30 * 86400000));

    const hoy = new Date();
    const rows: ForecastRow[] = publicaciones.map((p) => {
      const ventas30d = ventasPorId.get(p.id) ?? 0;
      const velocidadDiaria = ventas30d / 30;

      let diasRestantes: number | null = null;
      let fechaQuiebre: string | null = null;
      let cantidadSugerida = 0;
      let prioridad: Prioridad;

      if (p.stock === 0) {
        prioridad = "SIN_STOCK";
        cantidadSugerida = Math.ceil(velocidadDiaria * (leadTimeDays + safetyDays));
      } else if (velocidadDiaria === 0) {
        prioridad = "SIN_DATOS";
      } else {
        diasRestantes = Math.round(p.stock / velocidadDiaria);
        const fq = new Date(hoy.getTime() + diasRestantes * 86400000);
        fechaQuiebre = formatFechaCL(fq);

        const objetivoCobertura = velocidadDiaria * (leadTimeDays + safetyDays);
        cantidadSugerida = Math.max(0, Math.ceil(objetivoCobertura - p.stock));

        if (diasRestantes <= leadTimeDays) prioridad = "URGENTE";
        else if (diasRestantes <= leadTimeDays + safetyDays) prioridad = "PRONTO";
        else prioridad = "OK";
      }

      return {
        id: p.id,
        titulo: p.titulo,
        stockActual: p.stock,
        ventas30d,
        velocidadDiaria: Math.round(velocidadDiaria * 100) / 100,
        diasRestantes,
        fechaQuiebre,
        cantidadSugerida,
        prioridad,
        estadoML: p.estadoML,
      };
    });

    const ordenPrioridad: Record<Prioridad, number> = {
      SIN_STOCK: 0, URGENTE: 1, PRONTO: 2, SIN_DATOS: 3, OK: 4,
    };
    rows.sort((a, b) => {
      const diff = ordenPrioridad[a.prioridad] - ordenPrioridad[b.prioridad];
      if (diff !== 0) return diff;
      return (a.diasRestantes ?? Infinity) - (b.diasRestantes ?? Infinity);
    });

    // Aviso en pantalla si alguna de las dos hojas se acerca al tope de lectura (80 %): así un recorte no pasa en silencio.
    const filasMax = Math.max(pubRows.length, ventaRows.length);
    const avisoTope = filasMax >= TOPE_FILAS_FORECAST * 0.8
      ? `Una de las hojas (Publicaciones o Ventas) tiene ${filasMax} filas y se acerca al tope de lectura de ${TOPE_FILAS_FORECAST}.`
      : undefined;

    return NextResponse.json({
      ok: true, leadTimeDays, safetyDays, rows, ...(avisoTope ? { avisoTope } : {}), timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logError("forecast", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

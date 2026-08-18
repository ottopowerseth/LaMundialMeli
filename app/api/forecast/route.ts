import { NextRequest, NextResponse } from "next/server";
import { readSheet } from "@/lib/sheets";

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

function parseFechaCL(s: string): Date | null {
  if (!s) return null;
  const parts = s.split(/[-\/]/);
  if (parts.length < 3) return null;
  const d = Number(parts[0]);
  const m = Number(parts[1]) - 1;
  const y = Number(parts[2]);
  if (Number.isNaN(d) || Number.isNaN(m) || Number.isNaN(y)) return null;
  return new Date(y, m, d);
}

function formatFechaCL(d: Date): string {
  return d.toLocaleDateString("es-CL");
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const leadTimeDays = Number(searchParams.get("leadTimeDays")) || 15;
  const safetyDays = Number(searchParams.get("safetyDays")) || 7;

  try {
    const [pubRows, ventaRows] = await Promise.all([
      readSheet("Publicaciones!A2:R2000"),
      readSheet("Ventas!A2:J5000"),
    ]);

    const publicaciones = pubRows
      .filter((r) => r[0] && r[10] !== "closed")
      .map((r) => ({
        id: String(r[0]),
        titulo: r[2] ?? "",
        stock: Number(r[3]) || 0,
        estadoML: r[10] ?? "",
      }));

    // Match por ID Item (columna J), no por título: el título en Ventas es el
    // de la variación específica vendida, no el del producto padre en
    // Publicaciones, así que matchear por texto genera falsos negativos.
    // Filas sin ID Item (sync anterior al agregado de esta columna) se
    // ignoran sin intentar un fallback por título — se resuelven solas en
    // el próximo sync, que reescribe toda la hoja Ventas desde cero.
    const hace30d = new Date(Date.now() - 30 * 86400000);
    const ventasPorId = new Map<string, number>();
    for (const r of ventaRows) {
      const fecha = parseFechaCL(r[1] ?? "");
      if (!fecha || fecha < hace30d) continue;
      const idItem = r[9] ?? "";
      const cantidad = Number(r[4]) || 0;
      if (!idItem || cantidad <= 0) continue;
      ventasPorId.set(idItem, (ventasPorId.get(idItem) ?? 0) + cantidad);
    }

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

    return NextResponse.json({
      ok: true, leadTimeDays, safetyDays, rows, timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[forecast]", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

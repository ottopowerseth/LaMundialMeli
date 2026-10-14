import { NextResponse } from "next/server";
import axios from "axios";
import { readSheet, batchWriteSheet } from "@/lib/sheets";
import { getValidAccessToken, instalarReintento401 } from "@/lib/ml-token";
import { withMlRetry } from "@/lib/http-retry";
import { logError } from "@/lib/log";
import { discrepanciasDeProductos } from "@/lib/guardas-filas";

export async function POST() {
  try {
    const token = await getValidAccessToken();
    const mlClient = axios.create({
      baseURL: "https://api.mercadolibre.com",
      headers: { Authorization: `Bearer ${token}` },
      timeout: 8000,
    });
    instalarReintento401(mlClient, token);

    const { data: user } = await withMlRetry(() => mlClient.get("/users/me"));
    const userId = user.id;

    const mlIds = new Set<string>();
    let offset = 0;
    while (true) {
      const { data } = await withMlRetry(() =>
        mlClient.get(`/users/${userId}/items/search?limit=100&offset=${offset}`)
      );
      data.results.forEach((id: string) => mlIds.add(id));
      if (mlIds.size >= data.paging.total || data.results.length === 0) break;
      offset += 100;
    }

    // Leer sheet con ID (A) y Título (C)
    const sheetRows = await readSheet("Publicaciones!A2:C1000");
    if (sheetRows.length === 0) {
      return NextResponse.json({ ok: true, eliminados: 0, productos: [] });
    }

    const eliminados: { id: string; titulo: string; fila: number }[] = [];
    sheetRows.forEach((row, i) => {
      const id = row[0];
      if (id && !mlIds.has(id)) {
        eliminados.push({ id, titulo: row[2] ?? "Sin título", fila: i + 2 });
      }
    });

    // Marcar como ELIMINADA en columna Alerta (P) — una sola llamada batch. Anti-carrera: ml-sync puede haber reescrito Publicaciones
    // desde la lectura de arriba; solo se marcan las filas que SIGUEN conteniendo ese ID (patrón de lib/costo-auto.ts).
    let marcadas = eliminados;
    let omitidas = 0;
    if (eliminados.length > 0) {
      const idsActuales = await readSheet(`Publicaciones!A2:A${Math.max(...eliminados.map((e) => e.fila)) + 1}`);
      const malas = new Set(discrepanciasDeProductos(idsActuales, eliminados).map((m) => m.fila));
      marcadas = eliminados.filter((e) => !malas.has(e.fila));
      omitidas = eliminados.length - marcadas.length;
      if (marcadas.length > 0) {
        await batchWriteSheet(
          marcadas.map(({ fila }) => ({
            range: `Publicaciones!P${fila}`,
            values: [["ELIMINADA"]],
          }))
        );
      }
    }

    return NextResponse.json({
      ok: true, eliminados: eliminados.length, productos: eliminados,
      ...(omitidas > 0 ? { aviso: `${omitidas} fila(s) no se marcaron porque la hoja cambió durante la detección (¿hay un sync en curso?). Vuelve a detectar.` } : {}),
    });
  } catch (error) {
    logError("detect-deleted", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

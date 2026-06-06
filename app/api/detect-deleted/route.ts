import { NextResponse } from "next/server";
import axios from "axios";
import { readSheet, writeSheet } from "@/lib/sheets";
import { getValidAccessToken } from "@/lib/ml-token";

export async function POST() {
  try {
    const token = await getValidAccessToken();
    const mlClient = axios.create({
      baseURL: "https://api.mercadolibre.com",
      headers: { Authorization: `Bearer ${token}` },
    });

    const { data: user } = await mlClient.get("/users/me");
    const userId = user.id;

    const mlIds = new Set<string>();
    let offset = 0;
    while (true) {
      const { data } = await mlClient.get(`/users/${userId}/items/search?limit=100&offset=${offset}`);
      data.results.forEach((id: string) => mlIds.add(id));
      if (mlIds.size >= data.paging.total || data.results.length === 0) break;
      offset += 100;
    }

    // Leer sheet con ID (A) y Título (B)
    const sheetRows = await readSheet("Publicaciones!A2:B1000");
    if (sheetRows.length === 0) {
      return NextResponse.json({ ok: true, eliminados: 0, productos: [] });
    }

    const eliminados: { id: string; titulo: string; fila: number }[] = [];
    sheetRows.forEach((row, i) => {
      const id = row[0];
      if (id && !mlIds.has(id)) {
        eliminados.push({ id, titulo: row[1] ?? "Sin título", fila: i + 2 });
      }
    });

    // Marcar como ELIMINADA en columna Alerta (R)
    for (const { fila } of eliminados) {
      await writeSheet(`Publicaciones!R${fila}`, [["ELIMINADA"]]);
    }

    return NextResponse.json({ ok: true, eliminados: eliminados.length, productos: eliminados });
  } catch (error) {
    console.error("[detect-deleted]", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

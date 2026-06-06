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

    // IDs actuales en ML
    const mlIds = new Set<string>();
    let offset = 0;
    while (true) {
      const { data } = await mlClient.get(
        `/users/${userId}/items/search?limit=100&offset=${offset}`
      );
      data.results.forEach((id: string) => mlIds.add(id));
      if (mlIds.size >= data.paging.total || data.results.length === 0) break;
      offset += 100;
    }

    // IDs en el Sheet
    const sheetRows = await readSheet("Publicaciones!A2:R1000");
    if (sheetRows.length === 0) {
      return NextResponse.json({ ok: true, eliminados: 0, message: "Sheet vacío" });
    }

    // Comparar y marcar eliminados
    const updates: { row: number; id: string }[] = [];
    sheetRows.forEach((row, i) => {
      const id = row[0];
      if (id && !mlIds.has(id)) {
        updates.push({ row: i + 2, id });
      }
    });

    for (const { row } of updates) {
      await writeSheet(`Publicaciones!R${row}`, [["ELIMINADA"]]);
    }

    return NextResponse.json({
      ok: true,
      eliminados: updates.length,
      ids: updates.map((u) => u.id),
    });
  } catch (error) {
    console.error("[detect-deleted]", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

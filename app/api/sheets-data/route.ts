import { NextRequest, NextResponse } from "next/server";
import { readSheet } from "@/lib/sheets";

const ALLOWED_TABS = ["Publicaciones", "Ventas", "Config"] as const;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const tab = searchParams.get("tab") ?? "Publicaciones";

  if (!ALLOWED_TABS.includes(tab as typeof ALLOWED_TABS[number])) {
    return NextResponse.json({ error: "Pestaña no permitida" }, { status: 400 });
  }

  try {
    const range = `${tab}!A1:Z1000`;
    const rows = await readSheet(range);
    if (rows.length === 0) return NextResponse.json({ headers: [], rows: [] });
    const [headers, ...data] = rows;
    return NextResponse.json({ headers, rows: data });
  } catch (error) {
    console.error("[sheets-data]", error);
    return NextResponse.json({ error: "Error al leer datos" }, { status: 500 });
  }
}

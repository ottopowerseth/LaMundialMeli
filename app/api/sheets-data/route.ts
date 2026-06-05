import { NextRequest, NextResponse } from "next/server";
import { readSheet } from "@/lib/sheets";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const tab = searchParams.get("tab") ?? "Publicaciones";

  try {
    const range = `${tab}!A1:Z1000`;
    const rows = await readSheet(range);

    if (rows.length === 0) {
      return NextResponse.json({ headers: [], rows: [] });
    }

    const [headers, ...data] = rows;
    return NextResponse.json({ headers, rows: data });
  } catch (error) {
    console.error("[sheets-data]", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

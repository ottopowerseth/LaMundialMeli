import { NextResponse } from "next/server";
import axios from "axios";

export async function GET() {
  try {
    const { data } = await axios.get("https://api.mercadolibre.com/users/me", {
      headers: { Authorization: `Bearer ${process.env.ML_ACCESS_TOKEN}` },
    });
    return NextResponse.json({
      ok: true,
      nickname: data.nickname,
      id: data.id,
      country: data.country_id,
    });
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import axios from "axios";
import { getValidAccessToken } from "@/lib/ml-token";

export async function GET() {
  try {
    const token = await getValidAccessToken();
    const { data } = await axios.get("https://api.mercadolibre.com/users/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    return NextResponse.json({ ok: true, nickname: data.nickname, id: data.id });
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}

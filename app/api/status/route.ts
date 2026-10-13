import { NextResponse } from "next/server";
import axios from "axios";
import { getValidAccessToken, instalarReintento401 } from "@/lib/ml-token";

export async function GET() {
  try {
    const token = await getValidAccessToken();
    const client = axios.create({ baseURL: "https://api.mercadolibre.com", headers: { Authorization: `Bearer ${token}` } });
    instalarReintento401(client, token);
    const { data } = await client.get("/users/me");
    return NextResponse.json({ ok: true, nickname: data.nickname, id: data.id });
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}

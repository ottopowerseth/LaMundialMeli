import { NextRequest, NextResponse } from "next/server";
import axios from "axios";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");

  if (!code) {
    return NextResponse.json({ error: "No se recibió código de autorización" }, { status: 400 });
  }

  try {
    const { data } = await axios.post(
      "https://api.mercadolibre.com/oauth/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: process.env.ML_CLIENT_ID!,
        client_secret: process.env.ML_CLIENT_SECRET!,
        code,
        redirect_uri: process.env.ML_REDIRECT_URI!,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    return NextResponse.json({
      ok: true,
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
      instruccion: "Copia el access_token y agrégalo como ML_ACCESS_TOKEN en Vercel y en .env.local",
    });
  } catch (err: unknown) {
    const error = err as { response?: { data?: unknown }; message?: string };
    return NextResponse.json(
      { error: error.response?.data ?? error.message },
      { status: 500 }
    );
  }
}

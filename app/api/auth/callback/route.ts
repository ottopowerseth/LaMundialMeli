import { NextRequest, NextResponse } from "next/server";
import axios from "axios";
import { saveTokens } from "@/lib/ml-token";

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

    await saveTokens(data.access_token, data.refresh_token);

    return NextResponse.json({ ok: true, mensaje: "Conectado correctamente. Puedes cerrar esta ventana." });
  } catch (err: unknown) {
    const error = err as { response?: { data?: unknown }; message?: string };
    return NextResponse.json({ error: error.response?.data ?? error.message }, { status: 500 });
  }
}

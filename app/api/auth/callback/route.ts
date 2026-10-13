import { NextRequest, NextResponse } from "next/server";
import axios from "axios";
import { saveTokens } from "@/lib/ml-token";
import { logError } from "@/lib/log";
import { leerEstadoOauth, mismoTexto, OAUTH_STATE_COOKIE, opcionesCookieOauth } from "@/lib/oauth-state";

// Vuelta de Mercado Libre. El middleware ya exigió la cookie de estado firmada (solo /api/auth/login, con sesión, la
// emite); acá además el `state` de la URL debe coincidir con su nonce. La cookie se borra en TODA respuesta (un solo uso).
function respuesta(cuerpo: Record<string, unknown>, status: number) {
  const res = NextResponse.json(cuerpo, { status });
  res.cookies.set(OAUTH_STATE_COOKIE, "", opcionesCookieOauth(0));
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export async function GET(req: NextRequest) {
  const nonce = await leerEstadoOauth(req.cookies.get(OAUTH_STATE_COOKIE)?.value);
  const state = req.nextUrl.searchParams.get("state");
  if (!nonce || !state || !mismoTexto(state, nonce)) {
    return respuesta({ error: "Solicitud de autorización inválida o vencida. Inicia de nuevo desde /api/auth/login." }, 400);
  }

  const code = req.nextUrl.searchParams.get("code");
  if (!code) {
    return respuesta({ error: "No se recibió código de autorización" }, 400);
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

    return respuesta({ ok: true, mensaje: "Conectado correctamente. Puedes cerrar esta ventana." }, 200);
  } catch (err: unknown) {
    // El detalle (estado HTTP y mensaje, sin cuerpo ni headers) queda solo en el log; al cliente, un mensaje genérico.
    logError("auth/callback", err);
    return respuesta({ error: "No se pudo completar la conexión con Mercado Libre. Intenta de nuevo desde /api/auth/login." }, 500);
  }
}

import { NextResponse } from "next/server";
import { crearEstadoOauth, OAUTH_STATE_COOKIE, OAUTH_STATE_TTL_MS, opcionesCookieOauth } from "@/lib/oauth-state";

// Inicia la conexión con Mercado Libre. Exige sesión (ya no es pública, ver middleware.ts): genera un `state`
// aleatorio, lo manda a ML y lo guarda firmado en una cookie de 10 minutos que solo valida /api/auth/callback.
export async function GET() {
  const { nonce, cookie } = await crearEstadoOauth();

  const url = new URL("https://auth.mercadolibre.cl/authorization");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", process.env.ML_CLIENT_ID!);
  url.searchParams.set("redirect_uri", process.env.ML_REDIRECT_URI!);
  url.searchParams.set("state", nonce);

  const res = NextResponse.redirect(url.toString());
  res.cookies.set(OAUTH_STATE_COOKIE, cookie, opcionesCookieOauth(OAUTH_STATE_TTL_MS / 1000));
  res.headers.set("Cache-Control", "no-store");
  return res;
}

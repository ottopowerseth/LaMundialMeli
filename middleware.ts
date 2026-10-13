import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken } from "@/lib/auth";
import { leerEstadoOauth, OAUTH_STATE_COOKIE } from "@/lib/oauth-state";

// Rutas que no requieren sesión
const PUBLIC = [
  "/login",
  "/api/auth/signin",
  "/api/ml-notifications", // Webhook ML (verificado por firma)
  "/api/version",          // Chequeo de versión desplegada
];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Vuelta de ML (OAuth). ml_session es SameSite=Strict y en una redirección cruzada desde ML algunos navegadores no la
  // envían, así que acá se exige en su lugar la cookie de estado OAuth: firmada, de 10 min, con path solo para esta ruta
  // y que únicamente /api/auth/login (que sí exige sesión) puede emitir. Sin ella, no se entra.
  if (pathname === "/api/auth/callback") {
    const estado = await leerEstadoOauth(req.cookies.get(OAUTH_STATE_COOKIE)?.value);
    return estado ? NextResponse.next() : NextResponse.redirect(new URL("/login", req.url));
  }

  const token = req.cookies.get("ml_session")?.value;
  if (!token || !(await verifySessionToken(token))) {
    const loginUrl = new URL("/login", req.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|logo\\.png).*)"],
};

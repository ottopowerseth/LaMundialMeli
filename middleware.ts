import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken } from "@/lib/auth";

// Rutas que no requieren sesión
const PUBLIC = [
  "/login",
  "/api/auth/signin",
  "/api/auth/login",       // OAuth ML: redirect
  "/api/auth/callback",    // OAuth ML: recibe code
  "/api/ml-notifications", // Webhook ML (verificado por firma)
];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
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

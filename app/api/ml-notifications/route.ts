import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);

  console.log("[ml-notifications]", JSON.stringify(body));

  // ML espera un 200 inmediato, procesamos después
  return NextResponse.json({ ok: true });
}

// ML también hace GET para validar el endpoint
export async function GET() {
  return NextResponse.json({ ok: true });
}

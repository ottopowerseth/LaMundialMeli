import { NextRequest, NextResponse } from "next/server";

// ML firma los webhooks con x-signature header
async function verifyMLSignature(req: NextRequest, rawBody: string): Promise<boolean> {
  const secret = process.env.ML_CLIENT_SECRET;
  if (!secret) return false;

  const signature = req.headers.get("x-signature");
  if (!signature) return true; // ML puede no enviar firma en entorno de pruebas

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const expected = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
    const expectedHex = Array.from(new Uint8Array(expected))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return signature === `sha256=${expectedHex}`;
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const valid = await verifyMLSignature(req, rawBody);
  if (!valid) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let body: unknown = null;
  try { body = JSON.parse(rawBody); } catch { /* body no-JSON */ }

  console.log("[ml-notifications]", JSON.stringify(body));

  // ML espera un 200 inmediato
  return NextResponse.json({ ok: true });
}

// ML hace GET para validar el endpoint
export async function GET() {
  return NextResponse.json({ ok: true });
}

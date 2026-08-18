import { NextRequest, NextResponse } from "next/server";

// Mercado Libre (marketplace) NO firma sus notificaciones con HMAC/x-signature
// — ese mecanismo es de Mercado Pago, un producto distinto. El body de esta
// notificación es solo un aviso ("algo cambió en `resource`") y no debe
// tratarse como dato de confianza.
//
// IMPORTANTE: si en el futuro este endpoint dispara alguna acción (ej. un
// re-sync automático), la acción SIEMPRE debe basarse en un GET a `resource`
// hecho con nuestro propio access token — nunca en los campos del POST.
//
// Lo único que sí controlamos acá es que la notificación sea para nuestra
// propia app (comparando application_id), para no procesar avisos ajenos.

export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  let body: { topic?: unknown; resource?: unknown; application_id?: unknown } | null = null;
  try {
    body = JSON.parse(rawBody);
  } catch {
    /* body no-JSON */
  }

  const expectedAppId = process.env.ML_CLIENT_ID; // el client_id ES el application_id en ML
  const appId = body?.application_id != null ? String(body.application_id) : null;

  if (!body || !expectedAppId || appId !== expectedAppId) {
    console.log("[ml-notifications] notificación ignorada");
    return NextResponse.json({ ok: true });
  }

  console.log("[ml-notifications]", JSON.stringify({
    topic: body.topic,
    resource: body.resource,
    application_id: body.application_id,
  }));

  // ML espera un 200 inmediato
  return NextResponse.json({ ok: true });
}

// ML hace GET para validar el endpoint
export async function GET() {
  return NextResponse.json({ ok: true });
}

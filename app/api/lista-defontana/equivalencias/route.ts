import { NextResponse } from "next/server";
import { ensureSheets, reemplazarHoja } from "@/lib/sheets";
import { HEADERS_EQUIVALENCIAS, validarEquivalencias } from "@/lib/defontana";
import { logError } from "@/lib/log";

// Reemplaza la tabla de equivalencias completa — mismo criterio que la
// importación de Lista Defontana (no upsert, reemplazo total). Se llama a
// mano cuando Otto confirma equivalencias nuevas o corrige una existente,
// no automáticamente en cada sync.
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { equivalencias?: unknown };
    // Se valida TODO antes de tocar la hoja: un elemento mal formado ya no deja la tabla a medio reemplazar.
    const validacion = validarEquivalencias(body.equivalencias);
    if (!validacion.ok) return NextResponse.json({ ok: false, error: validacion.error }, { status: 400 });

    await ensureSheets(["Equivalencias Defontana"]);
    // Escribir primero y limpiar el sobrante después (S-08): si algo falla, la tabla anterior sigue ahí.
    const rows = validacion.filas.map((e) => [e.publicacionId, e.componenteCod, String(e.cantidad)]);
    const reemplazo = await reemplazarHoja("Equivalencias Defontana", [HEADERS_EQUIVALENCIAS, ...rows]);

    return NextResponse.json({
      ok: true, filasGuardadas: validacion.filas.length,
      ...(reemplazo.sobranteLimpio ? {} : { aviso: `La tabla nueva se escribió pero no se pudieron limpiar las filas sobrantes (${reemplazo.errorSobrante}). Vuelve a guardar para limpiarlas.` }),
    });
  } catch (error) {
    logError("lista-defontana/equivalencias", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

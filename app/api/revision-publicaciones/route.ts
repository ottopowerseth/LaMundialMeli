import { NextRequest, NextResponse } from "next/server";
import axios from "axios";
import { getValidAccessToken } from "@/lib/ml-token";
import { withMlRetry } from "@/lib/http-retry";
import {
  listarIdsPublicaciones,
  MAX_IDS_REVISION,
  revisarPublicaciones,
  UMBRAL_DESCRIPCION_CHARS,
} from "@/lib/revision-publicaciones";

// Revisión de faltantes por publicación: descripción e ISP. La lógica vive en
// lib/revision-publicaciones.ts (la comparte /api/completitud). Dos acciones,
// ambas sin estado y de solo lectura (no escribe en ML ni en Sheets):
//   - "listar":  devuelve todos los IDs de la cuenta (scan).
//   - "revisar": recibe un lote de IDs y devuelve una fila por ID.
// El frontend lista una vez y luego manda lotes en loop (mismo patrón que
// backfill-shipping), así no hay cursor que se desalinee entre invocaciones.

// Máximo permitido en el plan de Vercel (Hobby): 60s.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { accion?: string; ids?: unknown };

    const token = await getValidAccessToken();
    const mlClient = axios.create({
      baseURL: "https://api.mercadolibre.com",
      headers: { Authorization: `Bearer ${token}` },
      timeout: 8000,
    });
    // Sin budget a propósito: createSyncBudget cuenta como "fallida" toda
    // llamada no reintentable, incluido el 404 de /description, que acá es el
    // resultado esperado de una publicación sin descripción (75 en la cuenta).
    const mlGet = <T = unknown>(url: string) => withMlRetry(() => mlClient.get<T>(url));

    if (body.accion === "listar") {
      const { ids, porEstado } = await listarIdsPublicaciones(mlGet);
      return NextResponse.json({ ok: true, ids, porEstado });
    }

    if (body.accion === "revisar") {
      if (
        !Array.isArray(body.ids) ||
        body.ids.length === 0 ||
        body.ids.length > MAX_IDS_REVISION ||
        !body.ids.every((x) => typeof x === "string" && /^MLC\d+$/.test(x))
      ) {
        return NextResponse.json(
          { ok: false, error: `ids debe ser un arreglo de 1 a ${MAX_IDS_REVISION} IDs MLC` },
          { status: 400 }
        );
      }
      const { filas, pendientes, tiempoMs } = await revisarPublicaciones(mlGet, body.ids as string[]);
      return NextResponse.json({
        ok: true,
        filas,
        pendientes,
        umbralDescripcion: UMBRAL_DESCRIPCION_CHARS,
        tiempoMs,
      });
    }

    return NextResponse.json({ ok: false, error: 'accion debe ser "listar" o "revisar"' }, { status: 400 });
  } catch (error) {
    console.error("[revision-publicaciones]", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

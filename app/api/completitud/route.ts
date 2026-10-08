import { NextRequest, NextResponse } from "next/server";
import axios from "axios";
import { getValidAccessToken } from "@/lib/ml-token";
import { withMlRetry } from "@/lib/http-retry";
import { evaluarCompletitud, rutaCategorias } from "@/lib/completitud";
import { listarIdsPublicaciones, MAX_IDS_REVISION, revisarPublicaciones } from "@/lib/revision-publicaciones";
import { cargarVentas, ventanaPorDias } from "@/lib/tablero-datos";
import { clasificarAbc } from "@/lib/tablero-stock";

// Checklist de completitud por publicación (ISP, descripción, fotos, GTIN).
// A PEDIDO: no se llama al abrir el Tablero. Solo lectura (no escribe en ML ni
// en Sheets). Tres acciones sin estado; el frontend las encadena (mismo patrón
// que /api/revision-publicaciones) para que cada llamada quepa en los 60 s:
//   - "listar":  IDs de la cuenta (scan).
//   - "ventas":  ingreso, unidades y clase ABC de 90 días por publicación
//                (mismo método y misma ventana que el Tablero).
//   - "revisar": lote de IDs → una fila evaluada por ID (descripción e ISP
//                con la revisión existente, más fotos, GTIN y categoría).
// Medido 2026-10-08: 619 publicaciones = ~40 s en total (listar ~7 s, ventas
// de 90 días ~6 s, revisar ~28 s en 4 lotes de 200: 9, 8, 8 y 2 s).
export const maxDuration = 60;

const DIAS_VENTAS = 90;

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { accion?: string; ids?: unknown };
    const token = await getValidAccessToken();
    const crearMlGet = (timeout: number) => {
      const cliente = axios.create({ baseURL: "https://api.mercadolibre.com", headers: { Authorization: `Bearer ${token}` }, timeout });
      // Sin budget a propósito: el 404 de /description es un resultado esperado
      // (publicación sin descripción), no una falla.
      return <T = unknown>(url: string) => withMlRetry(() => cliente.get<T>(url));
    };

    if (body.accion === "listar") {
      const { ids, porEstado } = await listarIdsPublicaciones(crearMlGet(8000));
      return NextResponse.json({ ok: true, ids, porEstado });
    }

    if (body.accion === "ventas") {
      const inicio = Date.now();
      const mlGet = crearMlGet(15000);
      const { data: user } = await mlGet<{ id: number }>("/users/me");
      const { hastaMs } = ventanaPorDias(1, new Date());
      const desdeMs = hastaMs - DIAS_VENTAS * 86400000;
      const ventas = await cargarVentas(mlGet, user.id, desdeMs, hastaMs);
      const ingreso = new Map<string, number>();
      const unidades = new Map<string, number>();
      for (const l of ventas.lineas) {
        if (l.ms < desdeMs || l.ms >= hastaMs) continue;
        ingreso.set(l.item, (ingreso.get(l.item) ?? 0) + l.cantidad * l.precio);
        unidades.set(l.item, (unidades.get(l.item) ?? 0) + l.cantidad);
      }
      const clase = clasificarAbc(ingreso);
      // id → [ingreso 90 d, unidades 90 d, clase A|B|C]; sin entrada = sin ventas.
      const items: Record<string, [number, number, string]> = {};
      for (const [id, v] of ingreso) items[id] = [Math.round(v), unidades.get(id) ?? 0, clase.get(id) ?? "C"];
      const ingresoTotal = [...ingreso.values()].reduce((s, v) => s + v, 0);
      return NextResponse.json({
        ok: true,
        desde: new Date(desdeMs).toISOString(),
        hasta: new Date(hastaMs).toISOString(),
        ingresoTotal90: Math.round(ingresoTotal),
        items,
        tiempoMs: Date.now() - inicio,
      });
    }

    if (body.accion === "revisar") {
      if (
        !Array.isArray(body.ids) ||
        body.ids.length === 0 ||
        body.ids.length > MAX_IDS_REVISION ||
        !body.ids.every((x) => typeof x === "string" && /^MLC\d+$/.test(x))
      ) {
        return NextResponse.json({ ok: false, error: `ids debe ser un arreglo de 1 a ${MAX_IDS_REVISION} IDs MLC` }, { status: 400 });
      }
      const mlGet = crearMlGet(8000);
      const { filas, pendientes, tiempoMs } = await revisarPublicaciones(mlGet, body.ids as string[], { extras: true });
      const categorias = await rutaCategorias(mlGet, filas.map((f) => f.categoriaId).filter((c): c is string => !!c));
      return NextResponse.json({
        ok: true,
        filas: filas.map((f) => evaluarCompletitud(f, f.categoriaId ? categorias.get(f.categoriaId) ?? null : null)),
        pendientes,
        tiempoMs,
      });
    }

    return NextResponse.json({ ok: false, error: 'accion debe ser "listar", "ventas" o "revisar"' }, { status: 400 });
  } catch (error) {
    console.error("[completitud]", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

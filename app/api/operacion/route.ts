import { NextRequest, NextResponse } from "next/server";
import axios from "axios";
import { getValidAccessToken } from "@/lib/ml-token";
import { withMlRetry } from "@/lib/http-retry";
import { armarDespachos } from "@/lib/operacion";
import { cargarDespachosListos, cargarNivelReputacion, cargarPreguntasSinResponder, cargarReclamosAbiertos } from "@/lib/operacion-datos";

// Cola de operación (H): despachos listos para enviar, reclamos abiertos, preguntas
// sin responder y nivel de reputación. SOLO LECTURA (solo GET a ML; no usa Sheets) y
// A PEDIDO: la pantalla lo llama con un botón, nunca al abrir el Tablero. No sugiere
// acciones. Cada bloque es independiente: si uno falla, devuelve su error y los demás
// se muestran. Definiciones y mediciones en lib/operacion.ts.
export const maxDuration = 60;

const mensaje = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function GET(_req: NextRequest) {
  try {
    const inicio = Date.now();
    const token = await getValidAccessToken();
    const client = axios.create({ baseURL: "https://api.mercadolibre.com", headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });
    const mlGet = <T = unknown>(url: string) => withMlRetry(() => client.get<T>(url), { maxAttempts: 3 });

    const yo = (await mlGet<{ id: number }>("/users/me")).data.id;
    const ahoraMs = Date.now();
    const [desp, recl, preg, rep] = await Promise.allSettled([
      cargarDespachosListos(mlGet, yo), cargarReclamosAbiertos(mlGet), cargarPreguntasSinResponder(mlGet, yo, ahoraMs), cargarNivelReputacion(mlGet, yo),
    ]);
    const bloque = <T,>(r: PromiseSettledResult<T>) => (r.status === "fulfilled" ? { ok: true as const, datos: r.value } : { ok: false as const, error: mensaje(r.reason) });
    const d = bloque(desp);
    return NextResponse.json({
      ok: true,
      generadoEn: new Date(ahoraMs).toISOString(),
      segundos: Math.round((Date.now() - inicio) / 100) / 10,
      despachos: d.ok ? { ok: true, ...armarDespachos(d.datos, ahoraMs) } : d,
      reclamos: bloque(recl),
      preguntas: bloque(preg),
      reputacion: bloque(rep),
    });
  } catch (error) {
    console.error("[operacion]", error);
    return NextResponse.json({ ok: false, error: mensaje(error) }, { status: 500 });
  }
}

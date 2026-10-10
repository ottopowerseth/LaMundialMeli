"use client";

import { useState } from "react";

// Reclamos por tipo logístico (Full / otro), A PEDIDO (~12 s). Solo muestra los
// conteos y, con 20 o más eventos, la tasa por 100 órdenes creadas del mismo tipo.
// No compara tipos ni saca conclusiones. Definiciones en lib/reclamos-tipo.ts.
// Se usa en el Tablero (ventana elegible) y en Métricas (ventana del período).

type Celda = { eventos: number; ordenes: number; tasaPor100: number | null };
type Serie = { full: Celda; otro: Celda; sinTipo: number; total: number };
type Datos = {
  ok: boolean; error?: string; generadoEn: string; duracionMs: number; desdeCache: boolean; antiguedadSeg?: number;
  desde: string; hasta: string; minEventos: number; cotaInferior: boolean; motivosCota: string[];
  denominador: { full: number; otro: number; sinTipo: number; total: number };
  eventos: { enVentana: number; conTipo: number; sinTipo: number; pagosSinOrden: number; coberturaPct: number; duplicados: number };
  series: { cancelaciones: Serie; mediaciones: Serie };
};

const num = (n: number) => n.toLocaleString("es-CL");
const dec = (n: number) => n.toFixed(2).replace(".", ",");

function Fila({ titulo, serie, min, cota }: { titulo: string; serie: Serie; min: number; cota: boolean }) {
  const celda = (c: Celda) => (
    <td className="py-2 pr-3 text-right">
      <span className="font-semibold text-gray-900">{c.tasaPor100 === null ? "—" : `${cota ? "≥ " : ""}${dec(c.tasaPor100)}`}</span>
      <span className="block text-xs text-gray-500">
        {c.tasaPor100 === null ? `${num(c.eventos)} eventos (menos de ${min}: sin tasa)` : `${num(c.eventos)} eventos`} · {num(c.ordenes)} órdenes
      </span>
    </td>
  );
  return (
    <tr className="border-t border-gray-100 align-top">
      <td className="py-2 pr-3 font-medium text-gray-700">{titulo}</td>
      {celda(serie.full)}
      {celda(serie.otro)}
      <td className="py-2 pr-3 text-right text-gray-600">{num(serie.sinTipo)}</td>
    </tr>
  );
}

export default function ReclamosPorTipo({ desde, hasta, titulo = "Reclamos por tipo logístico" }: { desde?: string; hasta?: string; titulo?: string }) {
  const [dias, setDias] = useState(120);
  const [datos, setDatos] = useState<Datos | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const porPeriodo = !!(desde && hasta);

  async function calcular(refrescar = false) {
    setCargando(true);
    setError(null);
    try {
      const q = porPeriodo ? `desde=${encodeURIComponent(desde!)}&hasta=${encodeURIComponent(hasta!)}` : `dias=${dias}`;
      const r = await fetch(`/api/reclamos-tipo?${q}${refrescar ? "&refrescar=1" : ""}`);
      const d = (await r.json()) as Datos;
      if (!d.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      setDatos(d);
    } catch (e) {
      setError(String(e));
    } finally {
      setCargando(false);
    }
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-bold text-gray-900 text-lg">{titulo}</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Cancelaciones y mediaciones por separado, por 100 órdenes creadas del mismo tipo en la ventana. A pedido (~12 s).
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!porPeriodo && (
            <select value={dias} onChange={(e) => setDias(Number(e.target.value))} className="border border-gray-200 rounded-lg text-sm py-1.5 px-2">
              <option value={30}>30 días</option>
              <option value={90}>90 días</option>
              <option value={120}>120 días</option>
            </select>
          )}
          <button onClick={() => calcular(!!datos)} disabled={cargando}
            className="bg-gray-900 hover:bg-black disabled:opacity-40 text-white font-semibold text-sm py-2 px-4 rounded-xl">
            {cargando ? "Calculando..." : datos ? "Actualizar" : "Calcular"}
          </button>
        </div>
      </div>

      {error && <p className="text-red-600 text-sm">✗ {error}</p>}

      {datos && (
        <div className="space-y-3">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500">
                  <th className="text-left font-medium pb-1 pr-3">Serie</th>
                  <th className="text-right font-medium pb-1 pr-3">Full (por 100 órdenes)</th>
                  <th className="text-right font-medium pb-1 pr-3">Otro (por 100 órdenes)</th>
                  <th className="text-right font-medium pb-1 pr-3">Sin tipo (eventos)</th>
                </tr>
              </thead>
              <tbody>
                <Fila titulo="Cancelaciones" serie={datos.series.cancelaciones} min={datos.minEventos} cota={datos.cotaInferior} />
                <Fila titulo="Mediaciones" serie={datos.series.mediaciones} min={datos.minEventos} cota={datos.cotaInferior} />
              </tbody>
            </table>
          </div>

          <p className="text-xs text-gray-500">
            Ventana {new Date(datos.desde).toLocaleDateString("es-CL")} – {new Date(datos.hasta).toLocaleDateString("es-CL")} ·
            órdenes: Full {num(datos.denominador.full)}, otro {num(datos.denominador.otro)}, sin tipo {num(datos.denominador.sinTipo)} ·
            reclamos en la ventana: {num(datos.eventos.enVentana)}, con tipo {num(datos.eventos.conTipo)} ({datos.eventos.coberturaPct.toString().replace(".", ",")}%), sin tipo {num(datos.eventos.sinTipo)}.
            {datos.eventos.pagosSinOrden > 0 && <> Pagos sin orden de ML: {num(datos.eventos.pagosSinOrden)} reclamos sobre un pago que no coincide con ninguna orden de la ventana (aparte, no entran en las celdas ni en la cota).</>}
          </p>
          {datos.cotaInferior && (
            <p className="text-xs text-amber-800 bg-amber-50 rounded-lg px-3 py-2">
              Las tasas son un mínimo (≥): {datos.motivosCota.join("; ")}.
            </p>
          )}
          <p className="text-xs text-gray-400">
            Cada reclamo se cuenta una vez y se asigna a su orden por orden, envío o pago. Con menos de {datos.minEventos} eventos en una celda solo se muestra el conteo.
            Cancelaciones: reclamos de tipo cancel_purchase; mediaciones: los demás tipos. Datos de {new Date(datos.generadoEn).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })}
            {datos.desdeCache ? " (caché de ~10 min)" : ` · ${(datos.duracionMs / 1000).toFixed(1)} s`}.
          </p>
        </div>
      )}
    </div>
  );
}

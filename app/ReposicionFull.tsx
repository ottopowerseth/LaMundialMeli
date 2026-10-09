"use client";

import { useMemo, useState } from "react";
import { sugeridoPara } from "@/lib/reposicion-full";
import type { ResultadoReposicion } from "@/lib/reposicion-full";

// Panel de reposición de Full: publicaciones pausadas por falta de stock que vendían en Full y
// activas por agotarse, ordenadas por el margen que se pierde (o se arriesga) por día.
// Sin llamadas propias: usa lo que ya trajo el Tablero (estado y stock de /items, ventas con tipo
// logístico real, velocidad y margen). Definiciones en lib/reposicion-full.ts.

const clp = (n: number) => "$" + Math.round(n).toLocaleString("es-CL");
const clpSigno = (n: number) => (n < 0 ? "-" : "") + clp(Math.abs(n));
const num = (n: number) => Math.round(n).toLocaleString("es-CL");
const dec = (n: number) => n.toFixed(2).replace(".", ",");
const link = (id: string) => `https://articulo.mercadolibre.cl/${id.replace("MLC", "MLC-")}`;
const MOTIVO = { margen_negativo: "revisar precio/Costo antes de reponer", sin_costo: "revisar: falta el Costo" } as const;

export default function ReposicionFull({ reposicion, generadoEn }: { reposicion: ResultadoReposicion; generadoEn?: string }) {
  const [objetivo, setObjetivo] = useState<number>(reposicion.supuestos.coberturaObjetivoDias);
  const [tipo, setTipo] = useState<"todas" | "pausada" | "por_agotarse">("todas");
  const [visibles, setVisibles] = useState(30);
  const dias = Number.isFinite(objetivo) && objetivo > 0 ? Math.min(objetivo, 180) : reposicion.supuestos.coberturaObjetivoDias;

  const filas = useMemo(
    () => reposicion.filas
      .filter((f) => tipo === "todas" || f.tipo === tipo)
      .map((f) => ({ ...f, sugeridoUi: f.revisar ? null : sugeridoPara(f.velocidad, f.disponible, dias) })),
    [reposicion, tipo, dias]
  );
  const r = reposicion.resumen;
  const sugeridoTotal = filas.reduce((s, f) => s + (f.sugeridoUi ?? 0), 0);
  const hora = generadoEn ? new Date(generadoEn).toLocaleString("es-CL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : null;

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-4">
      <div>
        <h2 className="font-bold text-gray-900 text-lg">Reposición de Full</h2>
        <p className="text-sm text-gray-500 mt-0.5">
          Pausadas por falta de stock que vendían en Full y activas por agotarse, ordenadas por margen perdido (o en riesgo) por día.
          {hora && ` Estado y stock de las publicaciones al ${hora}.`}
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-gray-50 rounded-xl p-3"><p className="text-xs text-gray-500">Pausadas sin stock</p><p className="text-xl font-bold text-gray-900">{r.pausadas}</p></div>
        <div className="bg-gray-50 rounded-xl p-3"><p className="text-xs text-gray-500">Por agotarse (≤ {reposicion.supuestos.umbralPorAgotarseDias} días)</p><p className="text-xl font-bold text-gray-900">{r.porAgotarse}</p></div>
        <div className="bg-gray-50 rounded-xl p-3"><p className="text-xs text-gray-500">Margen perdido o en riesgo por día</p><p className="text-xl font-bold text-gray-900">{clp(r.margenPerdidoDiaTotal)}</p></div>
        <div className="bg-gray-50 rounded-xl p-3"><p className="text-xs text-gray-500">Unidades sugeridas ({dias} días)</p><p className="text-xl font-bold text-gray-900">{num(sugeridoTotal)}</p></div>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2 text-gray-600">
          Cobertura objetivo (días)
          <input type="number" min={1} max={180} value={objetivo} onChange={(e) => setObjetivo(Number(e.target.value))}
            className="w-20 border border-gray-200 rounded-lg py-1 px-2 text-gray-900" />
        </label>
        <select value={tipo} onChange={(e) => { setTipo(e.target.value as typeof tipo); setVisibles(30); }} className="border border-gray-200 rounded-lg py-1.5 px-2">
          <option value="todas">Todas</option>
          <option value="pausada">Pausadas sin stock</option>
          <option value="por_agotarse">Por agotarse</option>
        </select>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-500 text-left">
              <th className="font-medium pb-1 pr-3">Publicación</th>
              <th className="font-medium pb-1 pr-3">Estado</th>
              <th className="font-medium pb-1 pr-3 text-right">Disp.</th>
              <th className="font-medium pb-1 pr-3 text-right" title="Unidades vendidas por Full en 30 / 60 / 90 días">Full 30/60/90 d</th>
              <th className="font-medium pb-1 pr-3 text-right" title="Unidades por día de la publicación (ventana de 30 días del Tablero, corregida por días sin stock, con piso en el promedio Full de 90 días)">Vel. u/día</th>
              <th className="font-medium pb-1 pr-3 text-right" title="Margen neto por unidad de los últimos 120 días. Mezcla ventas por Full y por Normal y no incluye costos de Full.">Margen/u*</th>
              <th className="font-medium pb-1 pr-3 text-right" title="Disponible ÷ velocidad">Cobertura</th>
              <th className="font-medium pb-1 pr-3 text-right" title="Velocidad × margen unitario">Margen perdido/día</th>
              <th className="font-medium pb-1 text-right" title={`velocidad × ${dias} días − disponible`}>Sugerido</th>
            </tr>
          </thead>
          <tbody>
            {filas.slice(0, visibles).map((f) => (
              <tr key={f.id} className="border-t border-gray-100 align-top">
                <td className="py-1.5 pr-3 max-w-[260px]">
                  <a href={link(f.id)} target="_blank" rel="noopener noreferrer" className="text-gray-800 hover:underline block truncate" title={f.titulo}>{f.titulo}</a>
                  <span className="font-mono text-gray-400">{f.id}</span>
                  {f.n90 > 0 && <span className="ml-2 text-gray-400" title="Unidades vendidas por otro canal en 90 días: la velocidad y el margen incluyen canales mezclados">+{f.n90} u por otro canal</span>}
                </td>
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <span className={`rounded px-1.5 py-0.5 ${f.tipo === "pausada" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-800"}`}>{f.tipo === "pausada" ? "pausada" : "por agotarse"}</span>
                </td>
                <td className="py-1.5 pr-3 text-right">{f.disponible ?? "—"}</td>
                <td className="py-1.5 pr-3 text-right whitespace-nowrap">{f.f30} / {f.f60} / {f.f90}</td>
                <td className="py-1.5 pr-3 text-right">{dec(f.velocidad)}{f.velocidadConfiable ? "" : "*"}</td>
                <td className="py-1.5 pr-3 text-right">{f.margenUnitario === null ? "—" : clpSigno(f.margenUnitario)}</td>
                <td className="py-1.5 pr-3 text-right">{f.tipo === "pausada" ? "agotada" : f.cobertura === null ? "—" : `${dec(f.cobertura)} d`}</td>
                <td className="py-1.5 pr-3 text-right font-semibold">{f.margenPerdidoDia === null ? "—" : clp(f.margenPerdidoDia)}</td>
                <td className="py-1.5 text-right">
                  {f.revisar ? <span className="text-amber-700">{MOTIVO[f.revisar]}</span> : <span className="font-semibold">{num(f.sugeridoUi ?? 0)}</span>}
                </td>
              </tr>
            ))}
            {filas.length === 0 && <tr><td colSpan={9} className="py-3 text-gray-500">Sin publicaciones en este grupo.</td></tr>}
          </tbody>
        </table>
      </div>
      {filas.length > visibles && (
        <button onClick={() => setVisibles((v) => v + 30)} className="text-sm text-blue-700 hover:underline">Ver más ({filas.length - visibles})</button>
      )}

      <div className="text-xs text-gray-500 space-y-1">
        <p><b>Supuesto del sugerido:</b> velocidad × {dias} días de cobertura − disponible, redondeado hacia arriba. No se sugiere en las de margen unitario negativo o sin Costo: quedan marcadas para revisar antes de reponer.</p>
        <p>* El margen unitario mezcla lo vendido por Full y por Normal en los últimos 120 días (neto, sin IVA, antes de publicidad) y no incluye costos propios de Full. La velocidad es de la publicación completa; si vendió por otro canal antes de pasar a Full, puede sobrestimar el ritmo de Full.</p>
        <p>Una velocidad con asterisco tiene pocos días con stock en la ventana y es menos confiable. El stock disponible viene de las publicaciones (/items), no del inventario Full por publicación.</p>
      </div>
    </div>
  );
}

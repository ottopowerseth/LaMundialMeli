"use client";

import { useMemo, useState } from "react";
import { aplicarTope, FACTOR_PICO_RECIENTE, sugeridoPara } from "@/lib/reposicion-full";
import type { ResultadoReposicion } from "@/lib/reposicion-full";
import { Dato, Datos, ListaTarjetas, TarjetaFila } from "./TarjetaFila";

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
  const [tope, setTope] = useState<string>(""); // vacío = sin tope
  const topeNum = tope.trim() === "" ? null : Number(tope);
  const dias = Number.isFinite(objetivo) && objetivo > 0 ? Math.min(objetivo, 180) : reposicion.supuestos.coberturaObjetivoDias;

  const filas = useMemo(
    () => reposicion.filas
      .filter((f) => tipo === "todas" || f.tipo === tipo)
      .map((f) => {
        const base = f.revisar ? null : sugeridoPara(f.velocidad, f.disponible, dias);
        const conTope = base === null ? null : aplicarTope(base, topeNum);
        return { ...f, sugeridoBase: base, sugeridoUi: conTope, limitado: base !== null && conTope !== null && conTope < base };
      }),
    [reposicion, tipo, dias, topeNum]
  );
  const r = reposicion.resumen;
  const sugeridoTotal = filas.reduce((s, f) => s + (f.sugeridoUi ?? 0), 0);
  const hora = generadoEn ? new Date(generadoEn).toLocaleString("es-CL", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : null;
  const antiguedadMin = generadoEn ? Math.max(0, Math.round((Date.now() - Date.parse(generadoEn)) / 60000)) : null;
  const limitadas = filas.filter((f) => f.limitado).length;
  const picos = filas.filter((f) => f.picoReciente).length;

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-6 space-y-4">
      <div>
        <h2 className="font-bold text-gray-900 text-lg">Reposición de Full</h2>
        <p className="text-sm text-gray-500 mt-0.5">
          Pausadas por falta de stock que vendían en Full y activas por agotarse, ordenadas por margen perdido (o en riesgo) por día.
        </p>
        {hora && (
          <p className="text-sm text-gray-700 mt-1">
            <b>Último refresco:</b> {hora}{antiguedadMin !== null ? ` (hace ${antiguedadMin} min)` : ""} — estado y stock de las publicaciones al cargar el Tablero; para refrescar usa «Actualizar» arriba.
          </p>
        )}
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
        <label className="flex items-center gap-2 text-gray-600" title="Opcional: limita el sugerido de cada publicación a este máximo. Vacío = sin tope.">
          Tope por publicación (u)
          <input type="number" min={1} placeholder="sin tope" value={tope} onChange={(e) => setTope(e.target.value)}
            className="w-24 border border-gray-200 rounded-lg py-1 px-2 text-gray-900" />
        </label>
        <select value={tipo} onChange={(e) => { setTipo(e.target.value as typeof tipo); setVisibles(30); }} className="border border-gray-200 rounded-lg py-1.5 px-2">
          <option value="todas">Todas</option>
          <option value="pausada">Pausadas sin stock</option>
          <option value="por_agotarse">Por agotarse</option>
        </select>
      </div>

      {(picos > 0 || limitadas > 0) && (
        <p className="text-xs text-gray-500">
          {picos > 0 && <>{picos} con posible pico reciente (velocidad de 30 días mayor que {FACTOR_PICO_RECIENTE}× la de 90 días): revisa antes de pedir. </>}
          {limitadas > 0 && <>{limitadas} con el sugerido limitado por el tope.</>}
        </p>
      )}

      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-500 text-left">
              <th className="font-medium pb-1 pr-3">Publicación</th>
              <th className="font-medium pb-1 pr-3">Estado</th>
              <th className="font-medium pb-1 pr-3 text-right">Disp.</th>
              <th className="font-medium pb-1 pr-3 text-right" title="Unidades vendidas por Full en 30 / 60 / 90 días">Full 30/60/90 d</th>
              <th className="font-medium pb-1 pr-3 text-right" title="Unidades por día de la publicación en la ventana de 30 días del Tablero, corregida por los días sin stock">Vel. 30 d</th>
              <th className="font-medium pb-1 pr-3 text-right" title="Unidades Full de los últimos 90 días ÷ los días que lleva en Full (máximo 90, mínimo 7). No se corrige por los días sin stock, así que puede subestimar el ritmo cuando estuvo agotada">Vel. 90 d</th>
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
                  {f.picoReciente && <span className="ml-2 rounded bg-amber-50 text-amber-800 px-1.5 py-0.5" title={`Velocidad de 30 días (${dec(f.velocidad30)}) mayor que ${FACTOR_PICO_RECIENTE}× la de 90 días (${dec(f.velocidad90)}). Puede ser un pico o días sin stock en los 90 días (el promedio de 90 días no se corrige por eso).`}>posible pico reciente, revisa antes de pedir</span>}
                  {f.n90 > 0 && <span className="ml-2 text-gray-400" title="Unidades vendidas por otro canal en 90 días: la velocidad y el margen incluyen canales mezclados">+{f.n90} u por otro canal</span>}
                </td>
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  <span className={`rounded px-1.5 py-0.5 ${f.tipo === "pausada" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-800"}`}>{f.tipo === "pausada" ? "pausada" : "por agotarse"}</span>
                </td>
                <td className="py-1.5 pr-3 text-right">{f.disponible ?? "—"}</td>
                <td className="py-1.5 pr-3 text-right whitespace-nowrap">{f.f30} / {f.f60} / {f.f90}</td>
                <td className="py-1.5 pr-3 text-right">{dec(f.velocidad30)}{f.velocidadConfiable ? "" : "*"}</td>
                <td className="py-1.5 pr-3 text-right" title={`${f.f90} u Full ÷ ${f.diasEnFull} días`}>{dec(f.velocidad90)}</td>
                <td className="py-1.5 pr-3 text-right">{f.margenUnitario === null ? "—" : clpSigno(f.margenUnitario)}</td>
                <td className="py-1.5 pr-3 text-right">{f.tipo === "pausada" ? "agotada" : f.cobertura === null ? "—" : `${dec(f.cobertura)} d`}</td>
                <td className="py-1.5 pr-3 text-right font-semibold">{f.margenPerdidoDia === null ? "—" : clp(f.margenPerdidoDia)}</td>
                <td className="py-1.5 text-right">
                  {f.revisar ? <span className="text-amber-700">{MOTIVO[f.revisar]}</span> : <span className="font-semibold">{f.limitado ? <span title={`Sugerido sin tope: ${num(f.sugeridoBase ?? 0)}`}>{num(f.sugeridoUi ?? 0)} <span className="font-normal text-gray-400">(tope; sin tope {num(f.sugeridoBase ?? 0)})</span></span> : num(f.sugeridoUi ?? 0)}</span>}
                </td>
              </tr>
            ))}
            {filas.length === 0 && <tr><td colSpan={10} className="py-3 text-gray-500">Sin publicaciones en este grupo.</td></tr>}
          </tbody>
        </table>
      </div>
      <ListaTarjetas>
        {filas.slice(0, visibles).map((f) => (
          <TarjetaFila
            key={f.id}
            cabecera={
              <>
                <p className="text-sm font-medium text-gray-900 line-clamp-2">{f.titulo}</p>
                <p className="text-xs mt-0.5 flex flex-wrap items-center gap-1">
                  <span className={`rounded px-1.5 py-0.5 ${f.tipo === "pausada" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-800"}`}>{f.tipo === "pausada" ? "pausada" : "por agotarse"}</span>
                  {f.picoReciente && <span className="rounded bg-amber-50 text-amber-800 px-1.5 py-0.5">posible pico reciente</span>}
                </p>
                <p className="text-xs text-gray-600 mt-0.5">
                  Perdido/día <b className="text-gray-900">{f.margenPerdidoDia === null ? "—" : clp(f.margenPerdidoDia)}</b> · Sugerido <b className="text-gray-900">{f.revisar ? "revisar" : num(f.sugeridoUi ?? 0)}</b>
                </p>
              </>
            }
          >
            <Datos>
              <Dato etiqueta="Disponible">{f.disponible ?? "—"}</Dato>
              <Dato etiqueta="Full 30/60/90 d">{f.f30} / {f.f60} / {f.f90}</Dato>
              <Dato etiqueta="Vel. 30 d">{dec(f.velocidad30)}{f.velocidadConfiable ? "" : "*"}</Dato>
              <Dato etiqueta="Vel. 90 d">{dec(f.velocidad90)} <span className="font-normal text-gray-500">({f.f90} u ÷ {f.diasEnFull} d)</span></Dato>
              <Dato etiqueta="Margen/u*">{f.margenUnitario === null ? "—" : clpSigno(f.margenUnitario)}</Dato>
              <Dato etiqueta="Cobertura">{f.tipo === "pausada" ? "agotada" : f.cobertura === null ? "—" : `${dec(f.cobertura)} d`}</Dato>
              <Dato etiqueta="Sugerido" ancho>
                {f.revisar
                  ? <span className="text-amber-700">{MOTIVO[f.revisar]}</span>
                  : f.limitado ? <>{num(f.sugeridoUi ?? 0)} <span className="font-normal text-gray-500">(tope; sin tope {num(f.sugeridoBase ?? 0)})</span></> : num(f.sugeridoUi ?? 0)}
              </Dato>
              {f.picoReciente && <Dato etiqueta="Aviso" ancho><span className="text-amber-800">Posible pico reciente, revisa antes de pedir (velocidad de 30 días mayor que {FACTOR_PICO_RECIENTE}× la de 90).</span></Dato>}
              {f.n90 > 0 && <Dato etiqueta="Otro canal" ancho>+{f.n90} u en 90 días: la velocidad y el margen mezclan canales</Dato>}
            </Datos>
            <a href={link(f.id)} target="_blank" rel="noopener noreferrer" className="font-mono text-blue-700 hover:underline">{f.id} ↗</a>
          </TarjetaFila>
        ))}
        {filas.length === 0 && <p className="py-3 text-xs text-gray-500">Sin publicaciones en este grupo.</p>}
      </ListaTarjetas>
      {filas.length > visibles && (
        <button onClick={() => setVisibles((v) => v + 30)} className="text-sm text-blue-700 hover:underline">Ver más ({filas.length - visibles})</button>
      )}

      <div className="text-xs text-gray-500 space-y-1">
        <p><b>Supuesto del sugerido:</b> max(vel. 30 d, vel. 90 d) × {dias} días de cobertura − disponible, redondeado hacia arriba{topeNum !== null && topeNum > 0 ? `, con tope de ${Math.floor(topeNum)} u por publicación` : ""}. No se sugiere en las de margen unitario negativo o sin Costo: quedan marcadas para revisar antes de reponer.</p>
        <p>* El margen unitario mezcla lo vendido por Full y por Normal en los últimos 120 días (neto, sin IVA, antes de publicidad) y no incluye costos propios de Full. La velocidad de 30 días es de la publicación completa; si vendió por otro canal antes de pasar a Full, puede sobrestimar el ritmo de Full. La de 90 días es solo Full y se divide por los días que lleva en Full (si entró hace menos de 90).</p>
        <p>Una velocidad con asterisco tiene pocos días con stock en la ventana y es menos confiable. El stock disponible viene de las publicaciones (/items), no del inventario Full por publicación.</p>
      </div>
    </div>
  );
}

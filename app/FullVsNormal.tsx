"use client";

import { useMemo, useState } from "react";
import { evaluarCandidato } from "@/lib/full-vs-normal";
import type { CanalPeriodo, ProductoFvN, ResultadoFvN } from "@/lib/full-vs-normal";

// Comparativo Full vs Normal por período + lista corta de candidatos Normal → Full. Sin llamadas propias:
// usa lo que ya trajo el Tablero. Definiciones en lib/full-vs-normal.ts. El margen es el mismo del Tablero
// (neto, sin IVA, antes de publicidad) y NO incluye costos de Full.

const clp = (n: number) => "$" + Math.round(n).toLocaleString("es-CL");
const clpSigno = (n: number) => (n < 0 ? "-" : "") + clp(Math.abs(n));
const num = (n: number) => Math.round(n).toLocaleString("es-CL");
const pc = (n: number | null) => (n === null ? "—" : `${n.toFixed(1).replace(".", ",")}%`);
const link = (id: string) => `https://articulo.mercadolibre.cl/${id.replace("MLC", "MLC-")}`;

function Fila({ etiqueta, full, normal, ayuda }: { etiqueta: string; full: React.ReactNode; normal: React.ReactNode; ayuda?: string }) {
  return (
    <tr className="border-t border-gray-100">
      <td className="py-1.5 pr-3 text-gray-600" title={ayuda}>{etiqueta}</td>
      <td className="py-1.5 pr-3 text-right font-medium text-gray-900">{full}</td>
      <td className="py-1.5 text-right font-medium text-gray-900">{normal}</td>
    </tr>
  );
}

function Lado({ l }: { l: ProductoFvN["full"] }) {
  if (!l) return <span className="text-gray-300">—</span>;
  return (
    <span className="whitespace-nowrap">
      {num(l.unidades)} u · {clp(l.ingreso)}
      <span className="block text-gray-500">
        {l.margenPesos === null ? (l.estado === "sin_costo" ? "sin Costo" : "sin margen") : `${clpSigno(l.margenPesos)} (${pc(l.margenPct)})`}
        {l.menosFiable && l.margenPesos !== null ? " *" : ""}
      </span>
    </span>
  );
}

export default function FullVsNormal({ datos, generadoEn }: { datos: ResultadoFvN; generadoEn?: string }) {
  const [dias, setDias] = useState(90);
  const [verSinCosto, setVerSinCosto] = useState(false);
  const [filtro, setFiltro] = useState<"todos" | "ambos" | "full" | "normal">("todos");
  const [busqueda, setBusqueda] = useState("");
  const [visibles, setVisibles] = useState(25);
  const [u90Min, setU90Min] = useState<number>(datos.umbrales.u90Min);
  const [semanasMin, setSemanasMin] = useState<number>(datos.umbrales.semanasMin);
  const [verTodosCand, setVerTodosCand] = useState(false);

  const periodo = datos.periodos.find((p) => p.dias === dias) ?? datos.periodos[0];
  const productos = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    return periodo.productos.filter((p) =>
      (filtro === "todos" || (filtro === "ambos" ? p.full && p.normal : filtro === "full" ? p.full && !p.normal : p.normal && !p.full)) &&
      (q === "" || p.titulo.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)));
  }, [periodo, filtro, busqueda]);

  const candidatos = useMemo(
    () => datos.candidatos.map((c) => ({ c, ev: evaluarCandidato(c, u90Min, semanasMin) })),
    [datos, u90Min, semanasMin]
  );
  const califican = candidatos.filter((x) => x.ev.califica);
  const lista = (verTodosCand ? candidatos : califican).slice(0, 15);
  const hora = generadoEn ? new Date(generadoEn).toLocaleString("es-CL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : null;
  const f: CanalPeriodo = periodo.canales.full, n: CanalPeriodo = periodo.canales.normal;

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-6 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-bold text-gray-900 text-lg">Full vs Normal</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Cada venta cuenta en el canal de su orden (Full = fulfillment; Normal = despacho propio y otros). Solo órdenes pagadas{hora ? `. Datos al ${hora}` : ""}.
          </p>
        </div>
        <select value={dias} onChange={(e) => { setDias(Number(e.target.value)); setVisibles(25); }} className="border border-gray-200 rounded-lg text-sm py-1.5 px-2">
          {datos.periodos.map((p) => <option key={p.dias} value={p.dias}>Últimos {p.dias} días</option>)}
        </select>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-gray-500"><th className="text-left font-medium pb-1 pr-3"></th><th className="text-right font-medium pb-1 pr-3">Full</th><th className="text-right font-medium pb-1">Normal</th></tr>
          </thead>
          <tbody>
            <Fila etiqueta="Unidades" full={`${num(f.unidades)} (${pc(f.pctUnidades)})`} normal={`${num(n.unidades)} (${pc(n.pctUnidades)})`} />
            <Fila etiqueta="Ventas (bruto)" full={`${clp(f.ingreso)} (${pc(f.pctIngreso)})`} normal={`${clp(n.ingreso)} (${pc(n.pctIngreso)})`} />
            <Fila etiqueta="Órdenes" full={num(f.ordenes)} normal={num(n.ordenes)} />
            <Fila etiqueta="Ticket promedio" full={clp(f.ticket)} normal={clp(n.ticket)} ayuda="Ventas ÷ órdenes del canal" />
            <Fila etiqueta="Margen neto (sin costos de Full)" full={f.margenPesos === null ? "—" : `${clpSigno(f.margenPesos)} (${pc(f.margenPct)})`} normal={n.margenPesos === null ? "—" : `${clpSigno(n.margenPesos)} (${pc(n.margenPct)})`} ayuda="Neto (sin IVA), antes de publicidad y sin costos de Full. Solo publicaciones con Costo." />
            <Fila etiqueta="Ventas SIN margen calculable" full={<span>{clp(f.ingresoSinMargen)}<span className="block text-xs font-normal text-gray-500">sin Costo: {clp(f.sinCosto.ingreso)}</span></span>} normal={<span>{clp(n.ingresoSinMargen)}<span className="block text-xs font-normal text-gray-500">sin Costo: {clp(n.sinCosto.ingreso)}</span></span>} ayuda="Ventas brutas del canal que quedan fuera del margen: publicaciones sin Costo (y las que no tienen envío o comisión)" />
            <Fila etiqueta="Ventas con margen calculable" full={pc(f.ingresoConMargenPct)} normal={pc(n.ingresoConMargenPct)} ayuda="% de las ventas del canal cuyo margen se pudo calcular (con Costo, comisión y envío)" />
            <Fila etiqueta="Margen con envío estimado" full={pc(f.menosFiablePct)} normal={pc(n.menosFiablePct)} ayuda="% de las ventas con margen cuyo envío no es medido" />
            <Fila etiqueta="Publicaciones sin Costo" full={f.sinCosto.publicaciones} normal={n.sinCosto.publicaciones} />
          </tbody>
        </table>
      </div>
      <p className="text-sm font-semibold text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
        El margen de Full no incluye costos de Full; la brecha real es menor.
      </p>
      <p className="text-xs text-gray-500">
        El margen es el mismo de la sección Margen del Tablero (neto, sin IVA, antes de publicidad); todavía no hay tarifas de Full cargadas.
        {periodo.respaldoPct > 0 && ` ${pc(periodo.respaldoPct)} de las ventas no tiene tipo real y usa el tipo actual de la publicación.`}
      </p>
      {(f.sinCosto.publicaciones > 0 || n.sinCosto.publicaciones > 0) && (
        <div>
          <button onClick={() => setVerSinCosto((v) => !v)} className="text-xs text-blue-700 hover:underline">{verSinCosto ? "Ocultar" : "Ver"} publicaciones sin Costo por canal (las 10 de mayor venta)</button>
          {verSinCosto && (
            <div className="grid sm:grid-cols-2 gap-4 mt-2 text-xs">
              {([["Full", f], ["Normal", n]] as const).map(([nombre, c]) => (
                <div key={nombre}>
                  <p className="font-semibold text-gray-700">{nombre}: {c.sinCosto.publicaciones} sin Costo</p>
                  {c.sinCosto.lista.map((x) => <p key={x.id} className="text-gray-600 truncate"><a href={link(x.id)} target="_blank" rel="noopener noreferrer" className="hover:underline">{x.titulo}</a> · {clp(x.ingreso)}</p>)}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ---- Tabla por producto ---- */}
      <div className="space-y-2">
        <h3 className="font-semibold text-gray-800">Por producto ({dias} días)</h3>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <select value={filtro} onChange={(e) => { setFiltro(e.target.value as typeof filtro); setVisibles(25); }} className="border border-gray-200 rounded-lg py-1.5 px-2">
            <option value="todos">Todos</option><option value="ambos">Vendió en ambos canales</option><option value="full">Solo Full</option><option value="normal">Solo Normal</option>
          </select>
          <input value={busqueda} onChange={(e) => { setBusqueda(e.target.value); setVisibles(25); }} placeholder="Buscar título o MLC…" className="border border-gray-200 rounded-lg py-1.5 px-2 w-56" />
          <span className="text-xs text-gray-500">{productos.length} publicaciones con ese filtro, ordenadas por ventas totales</span>
        </div>
        {periodo.productosTotal > periodo.productos.length && (
          <p className="text-xs text-amber-800 bg-amber-50 rounded-lg px-3 py-1.5">
            Se muestran las {periodo.productos.length} publicaciones de mayor venta de {periodo.productosTotal} que vendieron en el período; {periodo.productosTotal - periodo.productos.length} quedaron fuera (las de menor venta).
          </p>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="text-gray-500 text-left"><th className="font-medium pb-1 pr-3">Publicación</th><th className="font-medium pb-1 pr-3">Full</th><th className="font-medium pb-1">Normal</th></tr></thead>
            <tbody>
              {productos.slice(0, visibles).map((p) => (
                <tr key={p.id} className="border-t border-gray-100 align-top">
                  <td className="py-1.5 pr-3 max-w-[280px]"><a href={link(p.id)} target="_blank" rel="noopener noreferrer" className="text-gray-800 hover:underline block truncate" title={p.titulo}>{p.titulo}</a><span className="font-mono text-gray-400">{p.id}</span></td>
                  <td className="py-1.5 pr-3"><Lado l={p.full} /></td>
                  <td className="py-1.5"><Lado l={p.normal} /></td>
                </tr>
              ))}
              {productos.length === 0 && <tr><td colSpan={3} className="py-3 text-gray-500">Sin publicaciones con ese filtro.</td></tr>}
            </tbody>
          </table>
        </div>
        {productos.length > visibles && <button onClick={() => setVisibles((v) => v + 25)} className="text-sm text-blue-700 hover:underline">Ver más ({productos.length - visibles})</button>}
        <p className="text-xs text-gray-400">Margen por publicación y canal: neto, sin IVA. «*» = el envío de ese canal es estimado, no medido.</p>
      </div>

      {/* ---- Candidatos Normal → Full ---- */}
      <div className="space-y-2 border-t border-gray-100 pt-4">
        <h3 className="font-semibold text-gray-800">Candidatos Normal → Full (lista corta, preliminar)</h3>
        <p className="text-xs text-gray-500">Publicaciones activas que hoy NO están en Full y no vendieron por Full en 120 días, evaluadas solo por rotación y margen actual. No incluye el costo de Full ni la elegibilidad física.</p>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2 text-gray-600">Unidades mín. en 90 d
            <input type="number" min={1} value={u90Min} onChange={(e) => setU90Min(Number(e.target.value))} className="w-20 border border-gray-200 rounded-lg py-1 px-2 text-gray-900" /></label>
          <label className="flex items-center gap-2 text-gray-600">Semanas con ventas mín. (de 13)
            <input type="number" min={1} max={13} value={semanasMin} onChange={(e) => setSemanasMin(Number(e.target.value))} className="w-16 border border-gray-200 rounded-lg py-1 px-2 text-gray-900" /></label>
          <label className="flex items-center gap-2 text-gray-600"><input type="checkbox" checked={verTodosCand} onChange={(e) => setVerTodosCand(e.target.checked)} /> Incluir los que no califican</label>
          <span className="text-xs text-gray-500">{califican.length} califican de {candidatos.length} con rotación mínima · se exige además margen unitario positivo</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 text-left">
                <th className="font-medium pb-1 pr-3">Publicación</th>
                <th className="font-medium pb-1 pr-3 text-right">u 30/60/90 d</th>
                <th className="font-medium pb-1 pr-3 text-right">Semanas c/ventas</th>
                <th className="font-medium pb-1 pr-3 text-right" title="Margen neto por unidad vendida por Normal, sin costos de Full">Margen/u</th>
                <th className="font-medium pb-1 pr-3 text-right" title="Al ritmo de 90 días, por 30 días, sin costos de Full">Margen/mes</th>
                <th className="font-medium pb-1">Por qué</th>
              </tr>
            </thead>
            <tbody>
              {lista.map(({ c, ev }) => (
                <tr key={c.id} className="border-t border-gray-100 align-top">
                  <td className="py-1.5 pr-3 max-w-[260px]"><a href={link(c.id)} target="_blank" rel="noopener noreferrer" className="text-gray-800 hover:underline block truncate" title={c.titulo}>{c.titulo}</a><span className="font-mono text-gray-400">{c.id}</span></td>
                  <td className="py-1.5 pr-3 text-right whitespace-nowrap">{c.u30} / {c.u60} / {c.u90}</td>
                  <td className="py-1.5 pr-3 text-right">{c.semanasConVenta}</td>
                  <td className="py-1.5 pr-3 text-right">{c.margenUnitario === null ? "sin Costo" : clpSigno(c.margenUnitario)}{c.menosFiable ? " *" : ""}</td>
                  <td className="py-1.5 pr-3 text-right font-semibold">{c.margenMes === null ? "—" : clp(c.margenMes)}</td>
                  <td className="py-1.5 text-gray-600">
                    {ev.califica
                      ? `${c.u90} u en 90 d, vende en ${c.semanasConVenta} de 13 semanas, margen ${clpSigno(c.margenUnitario ?? 0)}/u`
                      : [!ev.rotacion && `rotación baja (${c.u90} u)`, !ev.estable && `poco estable (${c.semanasConVenta} sem.)`, !ev.margen && (c.margenUnitario === null ? "sin Costo" : "margen ≤ 0")].filter(Boolean).join(" · ")}
                  </td>
                </tr>
              ))}
              {lista.length === 0 && <tr><td colSpan={6} className="py-3 text-gray-500">Ninguna publicación cumple los umbrales actuales.</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-gray-500"><b>No se pudo evaluar:</b> {datos.noEvaluado.join("; ")}.</p>
        <p className="text-xs text-gray-400">«*» = envío estimado (menos firme). Muchas de estas publicaciones tienen márgenes unitarios de pocos cientos de pesos, que un costo de Full podría superar.</p>
      </div>

      {/* ---- Lista inversa ---- */}
      <div className="space-y-2 border-t border-gray-100 pt-4">
        <h3 className="font-semibold text-gray-800">En Full con ventas bajas</h3>
        <p className="text-xs text-gray-500">Publicaciones activas en Full, con stock y {datos.umbrales.fullVentasBajasU90Max} unidades o menos vendidas en 90 días (todos los canales). Capital = stock × Costo.</p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="text-gray-500 text-left"><th className="font-medium pb-1 pr-3">Publicación</th><th className="font-medium pb-1 pr-3 text-right">Stock</th><th className="font-medium pb-1 pr-3 text-right">u 30 d</th><th className="font-medium pb-1 pr-3 text-right">u 90 d</th><th className="font-medium pb-1 text-right">Capital</th></tr></thead>
            <tbody>
              {datos.fullVentasBajas.slice(0, 15).map((x) => (
                <tr key={x.id} className="border-t border-gray-100">
                  <td className="py-1.5 pr-3 max-w-[300px]"><a href={link(x.id)} target="_blank" rel="noopener noreferrer" className="text-gray-800 hover:underline block truncate" title={x.titulo}>{x.titulo}</a><span className="font-mono text-gray-400">{x.id}</span></td>
                  <td className="py-1.5 pr-3 text-right">{x.stock}</td><td className="py-1.5 pr-3 text-right">{x.u30}</td><td className="py-1.5 pr-3 text-right">{x.u90}</td>
                  <td className="py-1.5 text-right">{x.capital === null ? "sin Costo" : clp(x.capital)}</td>
                </tr>
              ))}
              {datos.fullVentasBajas.length === 0 && <tr><td colSpan={5} className="py-3 text-gray-500">Ninguna.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

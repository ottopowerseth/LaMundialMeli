"use client";

import { useEffect, useMemo, useState } from "react";

// Tablero "desde arriba". Un solo endpoint (/api/tablero) calculado en vivo.
// El resultado se guarda en una variable de módulo para que al cambiar de
// pestaña y volver no se recalcule (tarda ~10-15 s): se muestra al instante y
// solo se vuelve a pedir si pasaron más de 10 minutos o con "Actualizar".

type Variacion = { actual: number; anterior: number; pct: number | null };
type Resumen = { ingresos: number; unidades: number; ordenes: number; ticket: number };
type Confianza = {
  ingresoVentana: number;
  costo: { pct: number; conCosto: number; auto: number; manual: number; enRevision: number; sinCosto: number };
  envioMedido: { pct: number; estimado: number; sinDato: number };
  comisionReal: { pct: number };
  publicacionesConVenta: number;
  excluidas: { publicaciones: number; ingreso: number };
};
type EstadoStock = "sin_stock" | "reponer" | "sobrestock" | "muerto" | "ok";
type FilaStock = {
  id: string; titulo: string; estado: string; abc: "A" | "B" | "C" | "S"; full: boolean; stock: number | null;
  unidades30: number; ingreso30: number; ingreso90: number;
  velocidadIngenua: number; velocidad: number; velocidadConfiable: boolean;
  diasSinStock: number; diasDisponibles: number; fuenteDisponibilidad: string;
  cobertura: number | null; coberturaIngenua: number | null;
  estadoStock: EstadoStock; estadoStockIngenuo: EstadoStock; accion: string; costo: number | null; capital: number | null;
};
type FilaAlerta = { id: string; titulo: string; full: boolean; ingreso30: number; tasaDiaria: number; diasSinVender: number; ingresoPerdido: number; accion: string };
type StockApi = {
  resumen: {
    activas: number; pausadas: number; pausadasSinStockConVentas: number;
    abc: Record<"A" | "B" | "C" | "S", number>; porEstado: Record<EstadoStock, number>;
    capital: { inmovilizado: number; pctConCosto: number }; perdido: { total: number; publicaciones: number };
    deteccion: { conDiasSinStock: number; porFuente: Record<string, number>; cambianEstado: number };
  };
  alerta: FilaAlerta[];
  filas: FilaStock[];
  llamadas: { visitas: number };
};
type FilaMargen = {
  id: string; titulo: string; full: boolean; unidades: number; ingreso: number; precioProm: number;
  costo: number | null; comisionPct: number | null; envioUnidad: number | null; envioFuente: "medido" | "estimado" | null;
  margenPct: number | null; estado: "ok" | "sin_costo" | "sin_envio" | "sin_comision"; menosFiable: boolean; pierde: boolean; fueraDeAlcance: boolean;
};
type SubtotalMargen = { ingreso: number; margenPct: number | null; publicaciones: number };
type MargenApi = {
  resumen: {
    total: SubtotalMargen & { coberturaPct: number; ingresoVentana: number };
    porTipo: { full: SubtotalMargen; estandar: SubtotalMargen };
    menosFiable: { pctIngreso: number; fullEstimado: number };
    pierden: { publicaciones: number; pctIngreso: number };
    margenBajo: { publicaciones: number };
    sinCosto: { publicaciones: number; pctIngreso: number };
  };
  filas: FilaMargen[];
};
type Pareto = { desde: string; hasta: string; ingreso: number; publicaciones: number; para50: number; para80: number; para95: number; top10Pct: number };
type PuntoSerie = Resumen & {
  desde: string; hasta: string; hastaDatos: string; parcial: boolean; incompleto: boolean;
  variacion: { ingresos: number | null; unidades: number | null; ordenes: number | null; ticket: number | null };
  comparadoCon: { desde: string; hasta: string } | null;
};
type TendenciasApi = { pareto: { ventana: Pareto; noventa: Pareto }; semanas: PuntoSerie[]; meses: PuntoSerie[]; datosDesde: string };
type TableroApi = {
  ok: boolean;
  error?: string;
  generadoEn?: string;
  ventana?: { desde: string; hasta: string; dias: number };
  resumen?: { actual: Resumen; anterior: Resumen; variaciones: { ingresos: Variacion; unidades: Variacion; ordenes: Variacion; ticket: Variacion } };
  confianza?: Confianza;
  stock?: StockApi;
  margen?: MargenApi;
  tendencias?: TendenciasApi;
};

let cache: { data: TableroApi; ts: number } | null = null;
const VIGENCIA_MS = 10 * 60 * 1000;

const clp = (n: number) => "$" + Math.round(n).toLocaleString("es-CL");
const num = (n: number) => Math.round(n).toLocaleString("es-CL");

function Chip({ etiqueta, pct, detalle }: { etiqueta: string; pct: number; detalle: string }) {
  const color = pct >= 90 ? "bg-green-50 border-green-200 text-green-800" : pct >= 60 ? "bg-amber-50 border-amber-200 text-amber-800" : "bg-red-50 border-red-200 text-red-800";
  return (
    <div className={`border rounded-xl px-3 py-2 ${color}`} title={detalle}>
      <p className="text-xs opacity-80">{etiqueta}</p>
      <p className="text-lg font-bold leading-tight">{pct.toFixed(1)}%</p>
    </div>
  );
}

function Tarjeta({ titulo, valor, v, anterior }: { titulo: string; valor: string; v: Variacion; anterior: string }) {
  const pct = v.pct;
  return (
    <div className="bg-gray-50 rounded-xl p-3" title={`Período anterior de igual duración: ${anterior}`}>
      <p className="text-xs text-gray-500">{titulo}</p>
      <p className="text-xl font-bold text-gray-900">{valor}</p>
      <p className={`text-xs font-medium ${pct === null ? "text-gray-400" : pct > 0 ? "text-green-600" : pct < 0 ? "text-red-600" : "text-gray-500"}`}>
        {pct === null ? "sin período previo" : `${pct > 0 ? "▲" : pct < 0 ? "▼" : "→"} ${Math.abs(pct)}% vs anterior`}
      </p>
    </div>
  );
}

const linkPublicacion = (id: string) => `https://articulo.mercadolibre.cl/${id.replace("MLC", "MLC-")}`;

function Enlace({ id }: { id: string }) {
  return <a href={linkPublicacion(id)} target="_blank" rel="noopener noreferrer" className="font-mono text-blue-700 hover:underline whitespace-nowrap">{id} ↗</a>;
}
const Tipo = ({ full }: { full: boolean }) => (
  <span className={`rounded-md px-2 py-0.5 ${full ? "bg-blue-50 text-blue-700" : "bg-gray-100 text-gray-600"}`}>{full ? "Full" : "Estándar"}</span>
);

// Alerta: publicaciones pausadas por falta de stock que vendieron en los últimos
// 30 días, ordenadas por ingreso perdido ESTIMADO.
function SeccionAlerta({ alerta, total }: { alerta: FilaAlerta[]; total: number }) {
  const [visibles, setVisibles] = useState(15);
  if (alerta.length === 0) return null;
  return (
    <div className="bg-white rounded-2xl border border-red-200 shadow-sm p-6 space-y-3">
      <div>
        <h3 className="font-bold text-gray-900">Pausadas por falta de stock con ventas</h3>
        <p className="text-sm text-gray-600">
          {alerta.length} publicaciones · ingreso perdido <b>estimado</b> {clp(total)}
          <span className="text-gray-400"> (tope 30 días por publicación)</span>
        </p>
        <p className="text-xs text-gray-400 mt-1">
          Estimado = tasa diaria × días sin vender. La tasa es el ingreso de los 30 días previos a la última venta dividido por los días en que sí había stock
          (excluye los días agotados). ML no informa desde cuándo está pausada: se usa la última venta.
        </p>
      </div>
      <div className="overflow-x-auto rounded-xl border border-gray-200">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200 text-left text-gray-500 uppercase tracking-wide">
              <th className="px-3 py-2">Publicación</th><th className="px-3 py-2">Tipo</th>
              <th className="px-3 py-2 text-right">Ingreso 30d</th><th className="px-3 py-2 text-right">Tasa $/día (est.)</th>
              <th className="px-3 py-2 text-right">Días sin vender</th><th className="px-3 py-2 text-right">Ingreso perdido (est.)</th>
              <th className="px-3 py-2">Acción</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {alerta.slice(0, visibles).map((a) => (
              <tr key={a.id} className="align-top">
                <td className="px-3 py-2"><Enlace id={a.id} /><div className="text-gray-700 max-w-[16rem] truncate" title={a.titulo}>{a.titulo}</div></td>
                <td className="px-3 py-2"><Tipo full={a.full} /></td>
                <td className="px-3 py-2 text-right">{clp(a.ingreso30)}</td>
                <td className="px-3 py-2 text-right">{clp(a.tasaDiaria)}</td>
                <td className="px-3 py-2 text-right">{a.diasSinVender.toFixed(1)}</td>
                <td className="px-3 py-2 text-right font-semibold text-red-700">{clp(a.ingresoPerdido)}</td>
                <td className="px-3 py-2 text-gray-800">{a.accion}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {alerta.length > visibles && (
        <button onClick={() => setVisibles((v) => v + 15)} className="text-sm text-gray-700 hover:text-black underline">Mostrar más ({alerta.length - visibles})</button>
      )}
    </div>
  );
}

const fecha = (iso: string) => new Date(iso).toLocaleDateString("es-CL", { day: "2-digit", month: "short", timeZone: "UTC" });
const mesTxt = (iso: string) => new Date(iso).toLocaleDateString("es-CL", { month: "short", year: "numeric", timeZone: "UTC" });
function Var({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-gray-400">—</span>;
  return <span className={pct > 0 ? "text-green-700" : pct < 0 ? "text-red-700" : "text-gray-500"}>{pct > 0 ? "+" : ""}{pct.toFixed(1).replace(".", ",")}%</span>;
}

// Pareto (cuántas publicaciones hacen el 50/80/95% del ingreso) y series
// semanal / mensual. La semana o el mes en curso se rotula "parcial" y se
// compara contra el mismo tramo del período anterior (no contra el entero).
function SeccionTendencias({ t }: { t: TendenciasApi }) {
  const [tipo, setTipo] = useState<"semanas" | "meses">("semanas");
  const puntos = t[tipo];
  const maxIng = Math.max(1, ...puntos.map((p) => p.ingresos));
  const etiqueta = (p: PuntoSerie) => (tipo === "semanas" ? `${fecha(p.desde)} – ${fecha(new Date(Date.parse(p.hasta) - 86400000).toISOString())}` : mesTxt(p.desde));
  const Fila = ({ titulo, p }: { titulo: string; p: Pareto }) => (
    <div className="bg-gray-50 rounded-xl p-3">
      <p className="text-xs text-gray-500">{titulo}</p>
      <p className="text-sm text-gray-800 mt-1"><b>{p.para50}</b> publicaciones hacen el 50% · <b>{p.para80}</b> el 80% · <b>{p.para95}</b> el 95%</p>
      <p className="text-xs text-gray-400">de {p.publicaciones} con ventas · las 10 mayores = {p.top10Pct}% · ingreso {clp(p.ingreso)}</p>
    </div>
  );
  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-4">
      <div>
        <h3 className="font-bold text-gray-900">Concentración y tendencia</h3>
        <p className="text-xs text-gray-400 mt-1">
          Pareto por publicación, sobre el ingreso de la línea de venta. Semanas de lunes a domingo y meses calendario (UTC). El período en curso es <b>parcial</b> y se compara con el mismo tramo del anterior.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Fila titulo={`Pareto, ventana (${t.pareto.ventana.desde.slice(0, 10)} → ${new Date(Date.parse(t.pareto.ventana.hasta) - 86400000).toISOString().slice(0, 10)})`} p={t.pareto.ventana} />
        <Fila titulo="Pareto, últimos 90 días (base de la clase ABC)" p={t.pareto.noventa} />
      </div>
      <div className="flex gap-2">
        {(["semanas", "meses"] as const).map((k) => (
          <button key={k} onClick={() => setTipo(k)} className={`px-3 py-1.5 rounded-lg text-sm ${tipo === k ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"}`}>{k === "semanas" ? "Semanas (12)" : "Meses"}</button>
        ))}
      </div>
      <div className="overflow-x-auto rounded-xl border border-gray-200">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200 text-left text-gray-500 uppercase tracking-wide">
              <th className="px-3 py-2">Período</th><th className="px-3 py-2 w-40"></th><th className="px-3 py-2 text-right">Ingresos</th>
              <th className="px-3 py-2 text-right">{tipo === "semanas" ? "vs sem. ant." : "vs mes ant."}</th>
              <th className="px-3 py-2 text-right">Unidades</th><th className="px-3 py-2 text-right">Órdenes</th><th className="px-3 py-2 text-right">Ticket</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {[...puntos].reverse().map((p) => (
              <tr key={p.desde} className={p.incompleto ? "text-gray-400" : ""}>
                <td className="px-3 py-2 whitespace-nowrap">{etiqueta(p)}
                  {p.parcial && <span className="ml-1 rounded-md bg-amber-100 text-amber-800 px-1.5 py-0.5">parcial</span>}
                  {p.incompleto && <span className="ml-1 rounded-md bg-gray-100 text-gray-500 px-1.5 py-0.5" title={`Solo hay datos desde ${fecha(t.datosDesde)}`}>datos incompletos</span>}
                </td>
                <td className="px-3 py-2"><div className="h-2 rounded bg-blue-200" style={{ width: `${Math.max(2, (p.ingresos / maxIng) * 100)}%` }} /></td>
                <td className="px-3 py-2 text-right font-semibold">{clp(p.ingresos)}</td>
                <td className="px-3 py-2 text-right" title={p.comparadoCon ? `Contra ${fecha(p.comparadoCon.desde)} – ${fecha(new Date(Date.parse(p.comparadoCon.hasta) - 86400000).toISOString())}` : "Sin base comparable"}><Var pct={p.variacion.ingresos} /></td>
                <td className="px-3 py-2 text-right">{num(p.unidades)}</td>
                <td className="px-3 py-2 text-right">{num(p.ordenes)}</td>
                <td className="px-3 py-2 text-right">{clp(p.ticket)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const COBERTURA_MIN_CIFRA = 90; // % del ingreso con datos completos para mostrar el margen como cifra principal

function SeccionMargen({ margen }: { margen: MargenApi }) {
  const [fTipo, setFTipo] = useState<"todos" | "full" | "estandar">("todos");
  const [fEstado, setFEstado] = useState<"todos" | "pierde" | "bajo" | "sin_costo" | "menos_fiable">("todos");
  const [busqueda, setBusqueda] = useState("");
  const [visibles, setVisibles] = useState(30);
  const r = margen.resumen;
  const parcial = r.total.coberturaPct < COBERTURA_MIN_CIFRA;
  const pctTxt = (x: number | null) => (x === null ? "—" : `${x.toFixed(1).replace(".", ",")}%`);

  const filas = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    return margen.filas
      .filter((f) => fTipo === "todos" || (fTipo === "full") === f.full)
      .filter((f) => fEstado === "todos"
        || (fEstado === "pierde" && f.pierde)
        || (fEstado === "bajo" && f.margenPct !== null && f.margenPct >= 0 && f.margenPct < 10)
        || (fEstado === "sin_costo" && f.estado === "sin_costo" && !f.fueraDeAlcance)
        || (fEstado === "menos_fiable" && f.margenPct !== null && f.menosFiable))
      .filter((f) => !q || `${f.id} ${f.titulo}`.toLowerCase().includes(q));
  }, [margen.filas, fTipo, fEstado, busqueda]);
  const reset = () => setVisibles(30);

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-4">
      <div>
        <h3 className="font-bold text-gray-900">Margen de contribución (estimado)</h3>
        <p className="text-xs text-gray-400 mt-1">
          En % del precio neto, antes de publicidad. Usa la comisión real cobrada por ML y el envío medido por publicación (el estimado se marca como menos fiable);
          Precio, comisión, envío y Costo se llevan a neto (÷1,19). Sin Costo la publicación no tiene margen: no se asume 0.
        </p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-gray-50 rounded-xl p-3" title="Solo publicaciones con Costo, comisión y envío. Ponderado por ingreso neto.">
          <p className="text-xs text-gray-500">Margen total {parcial ? "(parcial)" : "(est.)"}</p>
          {parcial ? (
            <>
              <p className="text-sm font-semibold text-amber-700 mt-1">Costo cargado en solo {r.total.coberturaPct}% del ingreso</p>
              <p className="text-xs text-gray-400">Solo lo evaluable ({r.total.publicaciones} publicaciones): {pctTxt(r.total.margenPct)}. No es el margen del negocio.</p>
            </>
          ) : (
            <>
              <p className="text-xl font-bold text-gray-900">{pctTxt(r.total.margenPct)}</p>
              <p className="text-xs text-gray-400">sobre {r.total.coberturaPct}% del ingreso ({r.total.publicaciones} publicaciones)</p>
            </>
          )}
        </div>
        <div className="bg-gray-50 rounded-xl p-3">
          <p className="text-xs text-gray-500">Full / Estándar</p>
          <p className="text-sm font-semibold text-gray-800 mt-1">{pctTxt(r.porTipo.full.margenPct)} <span className="text-gray-400 font-normal">· {pctTxt(r.porTipo.estandar.margenPct)}</span></p>
          <p className="text-xs text-gray-400">{r.porTipo.full.publicaciones} Full · {r.porTipo.estandar.publicaciones} estándar con margen</p>
        </div>
        <div className="bg-red-50 rounded-xl p-3"><p className="text-xs text-gray-500">Pierden plata</p><p className="text-xl font-bold text-red-800">{r.pierden.publicaciones}</p><p className="text-xs text-gray-400">{r.pierden.pctIngreso}% del ingreso · margen bajo (&lt;10%): {r.margenBajo.publicaciones}</p></div>
        <div className="bg-amber-50 rounded-xl p-3"><p className="text-xs text-gray-500">Sin Costo</p><p className="text-xl font-bold text-amber-800">{r.sinCosto.publicaciones}</p><p className="text-xs text-gray-400">{r.sinCosto.pctIngreso}% del ingreso de la ventana · sin contar cerradas/inactivas</p></div>
      </div>
      {r.menosFiable.pctIngreso > 0 && (
        <p className="text-xs text-amber-700">
          {r.menosFiable.pctIngreso}% del ingreso con margen depende de un envío <b>estimado</b> (menos fiable{r.menosFiable.fullEstimado > 0 ? `; ${r.menosFiable.fullEstimado} son Full, donde la estimación es la más imprecisa` : ""}).
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <select value={fEstado} onChange={(e) => { setFEstado(e.target.value as typeof fEstado); reset(); }} className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm">
          <option value="todos">Todas</option><option value="pierde">Pierden plata</option><option value="bajo">Margen bajo (&lt;10%)</option>
          <option value="sin_costo">Sin Costo</option><option value="menos_fiable">Envío estimado (menos fiable)</option>
        </select>
        <select value={fTipo} onChange={(e) => { setFTipo(e.target.value as typeof fTipo); reset(); }} className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm">
          <option value="todos">Full y estándar</option><option value="full">Solo Full</option><option value="estandar">Solo estándar</option>
        </select>
        <input value={busqueda} onChange={(e) => { setBusqueda(e.target.value); reset(); }} placeholder="Buscar ID o título" className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm flex-1 min-w-40" />
      </div>

      <div className="overflow-x-auto rounded-xl border border-gray-200">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200 text-left text-gray-500 uppercase tracking-wide">
              <th className="px-3 py-2">Publicación</th><th className="px-3 py-2">Tipo</th>
              <th className="px-3 py-2 text-right">Unid.</th><th className="px-3 py-2 text-right">Ingreso</th>
              <th className="px-3 py-2 text-right">Precio prom.</th><th className="px-3 py-2 text-right">Costo</th>
              <th className="px-3 py-2 text-right">Comisión</th><th className="px-3 py-2 text-right">Envío/u</th>
              <th className="px-3 py-2 text-right">Margen (est.)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filas.slice(0, visibles).map((f) => (
              <tr key={f.id} className="align-top">
                <td className="px-3 py-2"><Enlace id={f.id} /><div className="text-gray-700 max-w-[15rem] truncate" title={f.titulo}>{f.titulo}</div></td>
                <td className="px-3 py-2"><Tipo full={f.full} /></td>
                <td className="px-3 py-2 text-right">{f.unidades}</td>
                <td className="px-3 py-2 text-right">{clp(f.ingreso)}</td>
                <td className="px-3 py-2 text-right">{clp(f.precioProm)}</td>
                <td className="px-3 py-2 text-right">{f.costo !== null ? clp(f.costo) : f.fueraDeAlcance ? <span className="text-gray-400" title="Cerrada o inactiva: no cuenta como falta de Costo">cerrada/inactiva</span> : <span className="text-amber-600">sin Costo</span>}</td>
                <td className="px-3 py-2 text-right">{f.comisionPct !== null ? `${(f.comisionPct * 100).toFixed(1).replace(".", ",")}%` : "—"}</td>
                <td className="px-3 py-2 text-right" title={f.envioFuente === "estimado" ? (f.full ? "Envío ESTIMADO en Full: la estimación más imprecisa (error mediano ~49%)." : "Envío estimado: menos fiable que el medido.") : "Envío medido"}>
                  {f.envioUnidad !== null ? clp(f.envioUnidad) : "—"}
                  {f.menosFiable && <span className={`ml-1 ${f.full ? "text-red-500" : "text-amber-600"}`}>{f.full ? "⚠ est." : "est."}</span>}
                </td>
                <td className={`px-3 py-2 text-right font-semibold ${f.pierde ? "text-red-700" : "text-gray-900"}`}>{f.margenPct !== null ? pctTxt(f.margenPct) : <span className="text-gray-400 font-normal">{f.fueraDeAlcance ? "—" : f.estado === "sin_costo" ? "sin Costo" : "sin dato"}</span>}</td>
              </tr>
            ))}
            {filas.length === 0 && <tr><td colSpan={9} className="px-3 py-6 text-center text-gray-400">Ninguna publicación coincide con los filtros.</td></tr>}
          </tbody>
        </table>
      </div>
      {filas.length > visibles && (
        <button onClick={() => setVisibles((v) => v + 30)} className="w-full text-sm text-gray-700 hover:text-black underline">Mostrando {visibles} de {filas.length} — mostrar más</button>
      )}
    </div>
  );
}

const ETIQUETA_ESTADO: Record<EstadoStock, { texto: string; clase: string }> = {
  reponer: { texto: "Reponer", clase: "bg-red-100 text-red-800" },
  sobrestock: { texto: "Sobrestock", clase: "bg-amber-100 text-amber-800" },
  muerto: { texto: "Sin ventas 90d", clase: "bg-gray-200 text-gray-700" },
  sin_stock: { texto: "Sin stock", clase: "bg-red-100 text-red-800" },
  ok: { texto: "OK", clase: "bg-green-50 text-green-700" },
};

function SeccionStock({ stock }: { stock: StockApi }) {
  const [fEstado, setFEstado] = useState<"todos" | EstadoStock>("reponer");
  const [fClase, setFClase] = useState<"todas" | "A" | "B" | "C" | "S">("todas");
  const [fTipo, setFTipo] = useState<"todos" | "full" | "estandar">("todos");
  const [busqueda, setBusqueda] = useState("");
  const [visibles, setVisibles] = useState(40);
  const r = stock.resumen;
  const capitalParcial = r.capital.pctConCosto < 90;

  const filas = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    return stock.filas
      .filter((f) => f.estado === "active")
      .filter((f) => fEstado === "todos" || f.estadoStock === fEstado)
      .filter((f) => fClase === "todas" || f.abc === fClase)
      .filter((f) => fTipo === "todos" || (fTipo === "full") === f.full)
      .filter((f) => !q || `${f.id} ${f.titulo}`.toLowerCase().includes(q))
      .sort((a, b) => (a.cobertura ?? 1e9) - (b.cobertura ?? 1e9) || b.ingreso90 - a.ingreso90);
  }, [stock.filas, fEstado, fClase, fTipo, busqueda]);

  const reset = () => setVisibles(40);
  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-4">
      <div>
        <h3 className="font-bold text-gray-900">Stock: cobertura y capital inmovilizado</h3>
        <p className="text-xs text-gray-400 mt-1">
          Velocidad y cobertura son <b>estimadas</b>: unidades de 30 días ÷ días con stock. Día sin stock = 3 o más días seguidos con 0 visitas (en publicaciones con tráfico mediano ≥ 3 visitas/día), o los días posteriores a la última venta si está pausada por falta de stock ({r.deteccion.conDiasSinStock} publicaciones afectadas).
          Clase ABC por ingreso de 90 días (A hasta 80%, B hasta 95%). Alerta de reposición: SKU A con cobertura ≤ 21 días. Sobrestock (&gt; 90 días): solo B y C.
        </p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-red-50 rounded-xl p-3"><p className="text-xs text-gray-500">Reponer (SKU A ≤ 21 d)</p><p className="text-xl font-bold text-red-800">{r.porEstado.reponer}</p></div>
        <div className="bg-amber-50 rounded-xl p-3"><p className="text-xs text-gray-500">Sobrestock (B/C &gt; 90 d)</p><p className="text-xl font-bold text-amber-800">{r.porEstado.sobrestock}</p></div>
        <div className="bg-gray-50 rounded-xl p-3"><p className="text-xs text-gray-500">Sin ventas en 90 días</p><p className="text-xl font-bold text-gray-800">{r.porEstado.muerto}</p></div>
        <div className="bg-gray-50 rounded-xl p-3" title="Costo × stock de las publicaciones en sobrestock o sin ventas. Solo cuenta las que tienen Costo cargado.">
          <p className="text-xs text-gray-500">Capital inmovilizado {capitalParcial ? "(parcial)" : "(est.)"}</p>
          {capitalParcial ? (
            <>
              <p className="text-sm font-semibold text-amber-700 mt-1">Costo cargado en solo {r.capital.pctConCosto}%</p>
              <p className="text-xs text-gray-400">Solo lo que tiene Costo: {clp(r.capital.inmovilizado)}. No es el total; se mostrará completo al cargar los Costos.</p>
            </>
          ) : (
            <>
              <p className="text-xl font-bold text-gray-900">{clp(r.capital.inmovilizado)}</p>
              <p className="text-xs text-gray-400">con Costo en {r.capital.pctConCosto}% de esas publicaciones</p>
            </>
          )}
        </div>
      </div>
      <p className="text-xs text-gray-500">
        Activas por clase: A {r.abc.A} · B {r.abc.B} · C {r.abc.C} · sin ventas 90 d {r.abc.S}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <select value={fEstado} onChange={(e) => { setFEstado(e.target.value as typeof fEstado); reset(); }} className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm">
          <option value="todos">Todos los estados</option><option value="reponer">Reponer</option><option value="sobrestock">Sobrestock</option>
          <option value="muerto">Sin ventas 90 d</option><option value="ok">OK</option>
        </select>
        <select value={fClase} onChange={(e) => { setFClase(e.target.value as typeof fClase); reset(); }} className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm">
          <option value="todas">Todas las clases</option><option value="A">Clase A</option><option value="B">Clase B</option><option value="C">Clase C</option><option value="S">Sin ventas</option>
        </select>
        <select value={fTipo} onChange={(e) => { setFTipo(e.target.value as typeof fTipo); reset(); }} className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm">
          <option value="todos">Full y estándar</option><option value="full">Solo Full</option><option value="estandar">Solo estándar</option>
        </select>
        <input value={busqueda} onChange={(e) => { setBusqueda(e.target.value); reset(); }} placeholder="Buscar ID o título" className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm flex-1 min-w-40" />
      </div>

      <div className="overflow-x-auto rounded-xl border border-gray-200">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200 text-left text-gray-500 uppercase tracking-wide">
              <th className="px-3 py-2">Publicación</th><th className="px-3 py-2">Clase</th><th className="px-3 py-2">Tipo</th>
              <th className="px-3 py-2 text-right">Stock</th><th className="px-3 py-2 text-right">Vel./día (est.)</th>
              <th className="px-3 py-2 text-right">Cobertura (est.)</th><th className="px-3 py-2">Estado</th><th className="px-3 py-2">Acción</th>
              <th className="px-3 py-2 text-right">Capital</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filas.slice(0, visibles).map((f) => (
              <tr key={f.id} className="align-top">
                <td className="px-3 py-2"><Enlace id={f.id} /><div className="text-gray-700 max-w-[15rem] truncate" title={f.titulo}>{f.titulo}</div></td>
                <td className="px-3 py-2 font-semibold">{f.abc === "S" ? "—" : f.abc}</td>
                <td className="px-3 py-2"><Tipo full={f.full} /></td>
                <td className="px-3 py-2 text-right">{f.stock ?? "—"}</td>
                <td className="px-3 py-2 text-right" title={f.diasSinStock > 0 ? `Excluye ${f.diasSinStock} días sin stock (detectado por ${f.fuenteDisponibilidad}). Sin corregir serían ${f.velocidadIngenua.toFixed(2)}/día.` : undefined}>
                  {f.unidades30 > 0 ? f.velocidad.toFixed(2) : "0"}
                  {f.diasSinStock > 0 && <span className={`ml-1 ${f.velocidadConfiable ? "text-amber-600" : "text-red-500"}`}>{f.velocidadConfiable ? "*" : "?"}</span>}
                </td>
                <td className="px-3 py-2 text-right">{f.cobertura !== null ? `${f.cobertura} d` : "—"}</td>
                <td className="px-3 py-2"><span className={`rounded-md px-2 py-0.5 ${ETIQUETA_ESTADO[f.estadoStock].clase}`}>{ETIQUETA_ESTADO[f.estadoStock].texto}</span></td>
                <td className="px-3 py-2 text-gray-800">{f.accion || "—"}</td>
                <td className="px-3 py-2 text-right text-gray-600">{f.capital !== null && (f.estadoStock === "sobrestock" || f.estadoStock === "muerto") ? clp(f.capital) : "—"}</td>
              </tr>
            ))}
            {filas.length === 0 && <tr><td colSpan={9} className="px-3 py-6 text-center text-gray-400">Ninguna publicación coincide con los filtros.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-400">* velocidad corregida por días sin stock · ? pocos días con stock (&lt; 7): poco confiable</p>
      {filas.length > visibles && (
        <button onClick={() => setVisibles((v) => v + 40)} className="w-full text-sm text-gray-700 hover:text-black underline">
          Mostrando {visibles} de {filas.length} — mostrar más
        </button>
      )}
    </div>
  );
}

export default function Tablero() {
  const [datos, setDatos] = useState<TableroApi | null>(cache?.data ?? null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cargar() {
    setCargando(true);
    setError(null);
    try {
      const res = await fetch("/api/tablero");
      const data: TableroApi = await res.json();
      if (!data.ok) { setError(data.error ?? "Error al calcular el tablero"); return; }
      cache = { data, ts: Date.now() };
      setDatos(data);
    } catch {
      setError("Error de red o tiempo agotado");
    } finally {
      setCargando(false);
    }
  }

  useEffect(() => {
    if (!cache || Date.now() - cache.ts > VIGENCIA_MS) cargar();
  }, []);

  const hora = datos?.generadoEn ? new Date(datos.generadoEn).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" }) : null;
  const fecha = datos?.generadoEn ? new Date(datos.generadoEn).toLocaleDateString("es-CL") : null;
  const c = datos?.confianza;
  const r = datos?.resumen;

  return (
    <div className="space-y-5">
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-bold text-gray-900 text-lg">Tablero</h2>
            <p className="text-sm text-gray-500 mt-0.5">
              {datos?.ventana ? `Últimos ${datos.ventana.dias} días hasta hoy` : "Calculando..."}
              {hora && ` · datos de ${fecha} ${hora}`}
            </p>
          </div>
          <button onClick={cargar} disabled={cargando}
            className="bg-gray-900 hover:bg-black disabled:opacity-40 text-white font-semibold text-sm py-2 px-4 rounded-xl">
            {cargando ? "Calculando..." : "Actualizar"}
          </button>
        </div>

        {error && <p className="text-red-600 text-sm">✗ {error}</p>}
        {cargando && !datos && <p className="text-sm text-gray-500">Leyendo ventas, publicaciones y hojas (10-15 s)...</p>}

        {/* Barra de confianza: cuánto del ingreso tiene cada dato real. Mirar
            antes de creer un margen. */}
        {c && (
          <div className="space-y-2">
            <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Confianza de los datos (% del ingreso de la ventana)</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <Chip etiqueta="Con Costo" pct={c.costo.pct}
                detalle={`Con Costo ${c.costo.pct}% (automático ${c.costo.auto}%, manual ${c.costo.manual}%). En revisión (sin escribir): ${c.costo.enRevision}%. Sin Costo ni propuesta: ${(c.costo.sinCosto - c.costo.enRevision).toFixed(1)}%.${c.excluidas.publicaciones > 0 ? ` No cuenta ${c.excluidas.publicaciones} publicaciones cerradas o inactivas sin Costo (${clp(c.excluidas.ingreso)}).` : ""}`} />
              <Chip etiqueta="Envío medido" pct={c.envioMedido.pct}
                detalle={`Tarifa medida en /shipments/costs: ${c.envioMedido.pct}%. Estimado (respaldo): ${c.envioMedido.estimado}%. Sin fila en la caché: ${c.envioMedido.sinDato}%.`} />
              <Chip etiqueta="Comisión real" pct={c.comisionReal.pct}
                detalle="Comisión cobrada (sale_fee) en las órdenes de la ventana." />
            </div>
            {c.costo.enRevision > 0 && (
              <p className="text-xs text-gray-500">{c.costo.enRevision}% del ingreso está en SKUs con Costo propuesto pero en revisión (no escrito).</p>
            )}
          </div>
        )}

        {r && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Tarjeta titulo="Ingresos" valor={clp(r.actual.ingresos)} v={r.variaciones.ingresos} anterior={clp(r.anterior.ingresos)} />
            <Tarjeta titulo="Unidades" valor={num(r.actual.unidades)} v={r.variaciones.unidades} anterior={num(r.anterior.unidades)} />
            <Tarjeta titulo="Órdenes" valor={num(r.actual.ordenes)} v={r.variaciones.ordenes} anterior={num(r.anterior.ordenes)} />
            <Tarjeta titulo="Ticket promedio" valor={clp(r.actual.ticket)} v={r.variaciones.ticket} anterior={clp(r.anterior.ticket)} />
          </div>
        )}
      </div>

      {datos?.tendencias && <SeccionTendencias t={datos.tendencias} />}
      {datos?.margen && <SeccionMargen margen={datos.margen} />}
      {datos?.stock && <SeccionAlerta alerta={datos.stock.alerta} total={datos.stock.resumen.perdido.total} />}
      {datos?.stock && <SeccionStock stock={datos.stock} />}
    </div>
  );
}

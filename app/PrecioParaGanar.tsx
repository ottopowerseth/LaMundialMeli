"use client";

import { useMemo, useState } from "react";

// Precio para ganar (price_to_win de ML) frente al precio actual y al precio de
// equilibrio, al final del Tablero. A PEDIDO (~20 s), ventana fija de 30 días y de
// solo lectura: NO sugiere cambiar precios; solo muestra los números y rotula la
// posición ("bajo" / "sobre" el equilibrio). Definiciones y mediciones en
// lib/precio-para-ganar.ts. El resultado queda en una variable de módulo para no
// repetir la consulta al cambiar de pestaña.

type Posicion = "bajo" | "sobre" | null;
type Factor = { id: string; descripcion: string; estado: string };
type Fila = {
  id: string; titulo: string; full: boolean; estado: "competing" | "winning" | "sharing_first_place";
  visitShare: string | null; competidoresCompartiendo: number | null;
  precioActual: number; precioParaGanar: number; precioGanador: number | null; ganadorCobra: "mas" | "menos" | "igual" | null;
  ingreso30: number; unidades30: number;
  costo: number | null; envioActual: number | null; envioEstimado: boolean;
  equilibrio: number | null; brechaPct: number | null; posicion: Posicion;
  equilibrioEnvioTramo: number | null; envioTramo: number | null; posicionEnvioTramo: Posicion;
  equilibrioMayorNeto: number | null; posicionMayorNeto: Posicion;
  margenHoyPct: number | null; margenAlPrecioParaGanarPct: number | null; margenAlPrecioParaGanarTramoPct: number | null;
  factores: Factor[]; factoresGanador: Factor[]; factoresGanadorQueNoTenemos: string[];
};
type Monto = { n: number; ingreso: number };
type Datos = {
  ok: boolean; error?: string; generadoEn: string;
  calidadMargen: { coberturaCostoPct: number; envioEstimadoPctIngreso: number };
  resumen: {
    enTabla: Record<"competing" | "winning" | "sharing_first_place", Monto>;
    noParticipan: { total: Monto; propias: Monto; catalogo: Monto; sinDato: Monto };
    pausadasOtras: { pausadas: Monto; otras: Monto };
    competencia: {
      n: number; evaluables: number; bajo: { envioActual: number; envioTramo: number; sinEnvio: number; mayorNeto: number };
      ingresoBajoEnvioActual: number; brechaMedianaPct: number | null;
      ganadorCobraMas: number; ganadorCobraMenos: number; ganadorCobraIgual: number;
      ganadorMasCaroConFactorQueNoTenemos: number; conFactorDelGanadorQueNoTenemos: number; relacionParaGanarSobreGanadorMediana: number | null;
    };
  };
  filas: Fila[];
};

let cache: Datos | null = null;

const clp = (n: number) => "$" + Math.round(n).toLocaleString("es-CL");
const clpN = (n: number | null) => (n === null ? "—" : clp(n));
const pc = (n: number | null) => (n === null ? "—" : `${n.toFixed(1).replace(".", ",")}%`);
const link = (id: string) => `https://articulo.mercadolibre.cl/${id.replace("MLC", "MLC-")}`;
const NOMBRE_ESTADO = { competing: "en competencia", winning: "ganando", sharing_first_place: "compartiendo el primer lugar" } as const;
const VISITAS: Record<string, string> = { minimum: "mínima", medium: "media", maximum: "máxima" };
// Estados de los factores tal como los informa ML.
const ESTADO_FACTOR: Record<string, string> = { boosted: "boosted", opportunity: "oportunidad" };

// Sin verbos ni acciones: solo la posición del precio para ganar frente al equilibrio.
function Pos({ p }: { p: Posicion }) {
  if (p === null) return <span className="text-gray-300">—</span>;
  return <span className={`rounded px-1.5 py-0.5 whitespace-nowrap ${p === "bajo" ? "bg-amber-50 text-amber-800" : "bg-slate-100 text-slate-600"}`}>{p === "bajo" ? "bajo el equilibrio" : "sobre el equilibrio"}</span>;
}

function Tarjeta({ titulo, principal, l2, l3 }: { titulo: string; principal: string; l2?: string; l3?: string }) {
  return (
    <div className="bg-gray-50 rounded-xl p-3">
      <p className="text-xs text-gray-500">{titulo}</p>
      <p className="text-xl font-bold text-gray-900">{principal}</p>
      {l2 && <p className="text-xs text-gray-500">{l2}</p>}
      {l3 && <p className="text-xs text-gray-400">{l3}</p>}
    </div>
  );
}

// Factores que ML marca por publicación (nuestro / ganador actual). Solo dato.
function Factores({ f }: { f: Fila }) {
  const ids = [...new Set([...f.factores.map((x) => x.id), ...f.factoresGanador.map((x) => x.id)])];
  const nombre = (id: string) => f.factores.find((x) => x.id === id)?.descripcion ?? f.factoresGanador.find((x) => x.id === id)?.descripcion ?? id;
  const est = (l: Factor[], id: string) => ESTADO_FACTOR[l.find((x) => x.id === id)?.estado ?? ""] ?? "—";
  if (ids.length === 0) return <span className="text-gray-300">—</span>;
  return (
    <div className="space-y-0.5 text-left">
      {ids.map((id) => (
        <div key={id} className={f.factoresGanadorQueNoTenemos.includes(id) ? "font-semibold text-gray-900" : "text-gray-500"}>
          {nombre(id)}: <span>{est(f.factores, id)}</span> / <span>{f.factoresGanador.length ? est(f.factoresGanador, id) : "—"}</span>
        </div>
      ))}
    </div>
  );
}

export default function PrecioParaGanar() {
  const [datos, setDatos] = useState<Datos | null>(cache);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [extra, setExtra] = useState(false);
  const [fEstado, setFEstado] = useState<"todos" | "competing" | "winning" | "sharing_first_place">("competing");
  const [fPos, setFPos] = useState<"todos" | "bajo" | "sobre">("todos");
  const [fGanador, setFGanador] = useState<"todos" | "mas" | "menos">("todos");
  const [busqueda, setBusqueda] = useState("");
  const [visibles, setVisibles] = useState(40);

  async function calcular() {
    setCargando(true);
    setError(null);
    try {
      const r = await fetch("/api/precio-para-ganar");
      const d = (await r.json()) as Datos;
      if (!d.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      cache = d;
      setDatos(d);
      setVisibles(40);
    } catch (e) {
      setError(String(e));
    } finally {
      setCargando(false);
    }
  }

  const filas = useMemo(() => {
    if (!datos) return [];
    const q = busqueda.trim().toLowerCase();
    return datos.filas
      .filter((f) => fEstado === "todos" || f.estado === fEstado)
      .filter((f) => fPos === "todos" || f.posicion === fPos)
      .filter((f) => fGanador === "todos" || f.ganadorCobra === fGanador)
      .filter((f) => !q || `${f.id} ${f.titulo}`.toLowerCase().includes(q))
      .sort((a, b) => b.ingreso30 - a.ingreso30);
  }, [datos, fEstado, fPos, fGanador, busqueda]);
  const reset = () => setVisibles(40);

  const r = datos?.resumen;
  const c = r?.competencia;
  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-bold text-gray-900">Precio para ganar (catálogo): precio actual, equilibrio y precio para ganar</h3>
          <p className="text-xs text-gray-400 mt-1">Solo lectura y a pedido (~20 s). Ventana fija de 30 días. Muestra los números lado a lado; no sugiere cambiar precios.</p>
        </div>
        <button onClick={calcular} disabled={cargando} className="px-4 py-2 rounded-lg bg-gray-900 text-white text-sm disabled:opacity-50">
          {cargando ? "Consultando ML…" : datos ? "Actualizar" : "Calcular (~20 s)"}
        </button>
      </div>

      <div className="rounded-xl bg-amber-50 border border-amber-200 p-3 text-xs text-amber-900 space-y-1">
        <p><b>Base de IVA y costo de Katteyes pendientes.</b></p>
        <p>
          El equilibrio a un precio distinto del actual es <b>estimado</b>: la comisión es un porcentaje fijo (verificado: igual en el precio actual y en el precio para ganar en todas las publicaciones en competencia),
          pero el envío cambia por tramo de precio y por tamaño, así que a otro precio no se conoce y se estima.
        </p>
        <p>El precio para ganar lo calcula ML; no es el precio del ganador actual. Es una estimación de ML y no garantiza ganar.</p>
      </div>

      {error && <p className="text-sm text-red-700">No se pudo calcular: {error}</p>}
      {!datos && !cargando && !error && <p className="text-sm text-gray-500">Aún no calculado. Pulsa el botón para consultar a ML el precio para ganar de cada publicación activa con ventas.</p>}

      {datos && r && c && (
        <>
          <p className="text-xs text-gray-400">
            Calculado {new Date(datos.generadoEn).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })} · ventas de los últimos 30 días ·
            Costo en {pc(datos.calidadMargen.coberturaCostoPct)} de las ventas · envío estimado en {pc(datos.calidadMargen.envioEstimadoPctIngreso)} de las ventas con margen
          </p>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Tarjeta titulo="En competencia" principal={`${r.enTabla.competing.n} publicaciones`} l2={`ingreso 30d ${clp(r.enTabla.competing.ingreso)}`} l3="participación de visitas: mínima" />
            <Tarjeta titulo="Ganando" principal={`${r.enTabla.winning.n} publicaciones`} l2={`ingreso 30d ${clp(r.enTabla.winning.ingreso)}`} l3="participación de visitas: máxima" />
            <Tarjeta titulo="Compartiendo el primer lugar" principal={`${r.enTabla.sharing_first_place.n} publicaciones`} l2={`ingreso 30d ${clp(r.enTabla.sharing_first_place.ingreso)}`} l3="participación de visitas: media" />
            <Tarjeta titulo="Fuera de la tabla (sin precio para ganar)" principal={`${r.pausadasOtras.pausadas.n + r.noParticipan.total.n + r.pausadasOtras.otras.n} publicaciones`}
              l2={`${r.pausadasOtras.pausadas.n} pausadas (${clp(r.pausadasOtras.pausadas.ingreso)}) · ${r.noParticipan.total.n} activas que no participan (${clp(r.noParticipan.total.ingreso)})${r.pausadasOtras.otras.n ? ` · ${r.pausadasOtras.otras.n} cerradas o inactivas (${clp(r.pausadasOtras.otras.ingreso)})` : ""}`}
              l3={`de las que no participan: ${r.noParticipan.propias.n} propias, ${r.noParticipan.catalogo.n} de catálogo${r.noParticipan.sinDato.n ? `, ${r.noParticipan.sinDato.n} sin dato` : ""}`} />
          </div>

          <div className="text-sm text-gray-800 bg-gray-50 rounded-xl p-3 space-y-2">
            <p>
              <b>Lectura:</b> en <b>{c.bajo.envioActual} de {c.evaluables}</b> publicaciones en competencia el precio para ganar queda por debajo del precio de equilibrio; es decir, con el Costo y el envío actuales,
              ganar por precio implicaría vender bajo el costo.
            </p>
            <p>
              Esta conclusión es <b>condicional al Costo actual</b> (el Mayor tratado como costo con IVA): si el Mayor no fuera el costo real, la brecha cambia (si el Mayor fuera neto, serían {c.bajo.mayorNeto} de {c.evaluables}).
              También depende del envío a ese precio: con el envío típico del tramo del precio para ganar son {c.bajo.envioTramo} de {c.evaluables}, y aun con envío cero serían {c.bajo.sinEnvio} de {c.evaluables}.
              La brecha mediana entre el equilibrio y el precio para ganar es {pc(c.brechaMedianaPct)} del equilibrio.
            </p>
            <p>
              <b>El precio no es el único factor:</b> en {c.ganadorCobraMas} de {c.n} publicaciones en competencia el ganador actual cobra más que nosotros (en {c.ganadorCobraMenos} cobra menos y en {c.ganadorCobraIgual} igual).
              De esas {c.ganadorCobraMas}, el ganador tiene un factor &laquo;boosted&raquo; que nosotros no en {c.ganadorMasCaroConFactorQueNoTenemos}; en las demás los factores de ML que ve esta pantalla no distinguen al ganador.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select value={fEstado} onChange={(e) => { setFEstado(e.target.value as typeof fEstado); reset(); }} className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm">
              <option value="competing">En competencia</option><option value="winning">Ganando</option><option value="sharing_first_place">Compartiendo el primer lugar</option><option value="todos">Todos los estados</option>
            </select>
            <select value={fPos} onChange={(e) => { setFPos(e.target.value as typeof fPos); reset(); }} className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm">
              <option value="todos">Cualquier posición</option><option value="bajo">Precio para ganar bajo el equilibrio</option><option value="sobre">Precio para ganar sobre el equilibrio</option>
            </select>
            <select value={fGanador} onChange={(e) => { setFGanador(e.target.value as typeof fGanador); reset(); }} className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm">
              <option value="todos">Ganador: cualquier precio</option><option value="mas">El ganador cobra más que nosotros</option><option value="menos">El ganador cobra menos que nosotros</option>
            </select>
            <input value={busqueda} onChange={(e) => { setBusqueda(e.target.value); reset(); }} placeholder="Buscar ID o título" className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm flex-1 min-w-40" />
            <button onClick={() => setExtra((s) => !s)} className="text-xs text-gray-700 underline">{extra ? "Ocultar" : "Mostrar"} sensibilidades y factores de ML (informativos)</button>
          </div>

          <div className="overflow-x-auto rounded-xl border border-gray-200">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-left text-gray-500 uppercase tracking-wide">
                  <th className="px-2 py-2">Publicación</th>
                  <th className="px-1.5 py-2 text-right">Precio actual</th>
                  <th className="px-1.5 py-2 text-right" title="(Costo + envío actual) / (1 − comisión). Estimado: a otro precio el envío puede ser distinto.">Precio de equilibrio (est.)</th>
                  <th className="px-1.5 py-2 text-right">Precio para ganar</th>
                  <th className="px-1.5 py-2 text-right">Para ganar vs equilibrio</th>
                  <th className="px-1.5 py-2 text-right">Precio del ganador</th>
                  <th className="px-1.5 py-2 text-right">Margen hoy</th>
                  <th className="px-1.5 py-2 text-right" title="Margen de contribución si se vendiera al precio para ganar, con el envío actual. Estimado.">Margen al precio para ganar (est.)</th>
                  <th className="px-1.5 py-2 text-right">Ingreso 30d</th>
                  {extra && <><th className="px-1.5 py-2 text-right bg-gray-100">Equilibrio con envío típico del tramo (est.)</th><th className="px-1.5 py-2 text-right bg-gray-100">Equilibrio si el Mayor fuera neto</th><th className="px-1.5 py-2 bg-gray-100" title="Estado de cada factor según ML: nuestro / ganador. En negrita: el ganador está boosted y nosotros no.">Factores de ML: nuestro / ganador</th></>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filas.slice(0, visibles).map((f) => (
                  <tr key={f.id} className="align-top">
                    <td className="px-2 py-2">
                      <a href={link(f.id)} target="_blank" rel="noopener noreferrer" className="font-mono text-blue-700 hover:underline whitespace-nowrap">{f.id} ↗</a>
                      <div className="text-gray-700 max-w-[9rem] truncate" title={f.titulo}>{f.titulo}</div>
                      <span className={`rounded-md px-1.5 py-0.5 ${f.full ? "bg-blue-50 text-blue-700" : "bg-gray-100 text-gray-600"}`}>{f.full ? "Full" : "Estándar"}</span>
                      <div className="text-gray-400 mt-0.5">{NOMBRE_ESTADO[f.estado]} · visitas {VISITAS[f.visitShare ?? ""] ?? "—"}</div>
                    </td>
                    <td className="px-1.5 py-2 text-right whitespace-nowrap font-semibold">{clp(f.precioActual)}</td>
                    <td className="px-1.5 py-2 text-right whitespace-nowrap" title={f.envioEstimado ? "El envío actual es estimado: menos fiable" : "Con el envío actual medido"}>
                      {clpN(f.equilibrio)}{f.envioEstimado && <span className="ml-1 text-amber-600">est.</span>}
                      <div className="text-gray-400">{f.costo === null ? "sin Costo" : `envío ${clpN(f.envioActual)}`}</div>
                    </td>
                    <td className="px-1.5 py-2 text-right whitespace-nowrap font-semibold">{clp(f.precioParaGanar)}</td>
                    <td className="px-1.5 py-2 text-right whitespace-nowrap">
                      {f.brechaPct !== null && <div className="text-gray-500">{pc(Math.abs(f.brechaPct))} {f.posicion === "bajo" ? "bajo" : "sobre"}</div>}
                      <div className="mt-0.5"><Pos p={f.posicion} /></div>
                    </td>
                    <td className="px-1.5 py-2 text-right whitespace-nowrap">
                      {clpN(f.precioGanador)}
                      {f.ganadorCobra && f.ganadorCobra !== "igual" && <div className="text-gray-400">cobra {f.ganadorCobra === "mas" ? "más" : "menos"} que nosotros</div>}
                    </td>
                    <td className="px-1.5 py-2 text-right">{pc(f.margenHoyPct)}</td>
                    <td className={`px-1.5 py-2 text-right ${f.margenAlPrecioParaGanarPct !== null && f.margenAlPrecioParaGanarPct < 0 ? "text-red-700" : ""}`}>{pc(f.margenAlPrecioParaGanarPct)}</td>
                    <td className="px-1.5 py-2 text-right whitespace-nowrap">{clp(f.ingreso30)}</td>
                    {extra && (
                      <>
                        <td className="px-1.5 py-2 text-right bg-gray-50 text-gray-600 whitespace-nowrap">{clpN(f.equilibrioEnvioTramo)}<div className="text-gray-400">envío típico {clpN(f.envioTramo)}</div><div className="mt-0.5"><Pos p={f.posicionEnvioTramo} /></div></td>
                        <td className="px-1.5 py-2 text-right bg-gray-50 text-gray-600 whitespace-nowrap">{clpN(f.equilibrioMayorNeto)}<div className="mt-0.5"><Pos p={f.posicionMayorNeto} /></div></td>
                        <td className="px-1.5 py-2 bg-gray-50 whitespace-nowrap"><Factores f={f} /></td>
                      </>
                    )}
                  </tr>
                ))}
                {filas.length === 0 && <tr><td colSpan={extra ? 12 : 9} className="px-3 py-6 text-center text-gray-400">Ninguna publicación coincide con los filtros.</td></tr>}
              </tbody>
            </table>
          </div>
          {filas.length > visibles && <button onClick={() => setVisibles((v) => v + 40)} className="w-full text-sm text-gray-700 hover:text-black underline">Mostrando {visibles} de {filas.length} — mostrar más</button>}
          <p className="text-xs text-gray-400">
            &laquo;Bajo el equilibrio&raquo; = el precio para ganar es menor que el precio de equilibrio (&laquo;sobre&raquo; = igual o mayor). Equilibrio, margen y comisión usan el Costo como Mayor con IVA (pendiente de confirmar) y la comisión real cobrada.
            Los factores de ML (boosted / oportunidad) se muestran solo como dato.
          </p>
        </>
      )}
    </div>
  );
}

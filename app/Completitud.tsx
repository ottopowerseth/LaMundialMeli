"use client";

import { useMemo, useState } from "react";
import { enAlcance, resumirCompletitud } from "@/lib/completitud";
import type { FilaCompletitud, FilaConIngreso, Faltante, TipoFaltante } from "@/lib/completitud";

// Checklist de completitud (ISP, descripción, fotos, GTIN) al final del
// Tablero. A PEDIDO: no se calcula al abrir el Tablero; el botón encadena las
// acciones de /api/completitud (listar → ventas → revisar por lotes), ~40 s.
// Solo lectura. El resultado se guarda en una variable de módulo para que al
// cambiar de pestaña no haya que repetirlo.

type VentasApi = { ingresoTotal90: number; desde: string; hasta: string; items: Record<string, [number, number, string]> };
type Resultado = { filas: FilaConIngreso[]; ingresoTotal90: number; desde: string; hasta: string; ts: number };

let cache: Resultado | null = null;

const clp = (n: number) => "$" + Math.round(n).toLocaleString("es-CL");
const num = (n: number) => Math.round(n).toLocaleString("es-CL");
const pct = (n: number) => `${n.toFixed(1).replace(".", ",")}%`;
const link = (id: string) => `https://articulo.mercadolibre.cl/${id.replace("MLC", "MLC-")}`;

async function llamar<T>(accion: string, extra: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch("/api/completitud", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accion, ...extra }) });
  const d = await r.json();
  if (!d.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
  return d as T;
}

const ESTILO: Record<Faltante["severidad"], string> = {
  principal: "bg-red-50 text-red-700",
  secundario: "bg-amber-50 text-amber-700",
  informativo: "bg-gray-100 text-gray-500",
};
const NOMBRE_TIPO: Record<TipoFaltante, string> = { isp: "ISP", descripcion: "Descripción", fotos: "Fotos", gtin: "GTIN" };

function Chips({ f, omitir }: { f: FilaCompletitud; omitir?: TipoFaltante }) {
  const lista = f.faltantes.filter((x) => x.tipo !== omitir);
  if (lista.length === 0) return <span className="text-gray-300">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {lista.map((x) => (
        <span key={x.tipo} title={`${x.detalle}${x.severidad === "secundario" ? " · secundario (catálogo)" : x.severidad === "informativo" ? " · informativo" : ""}`} className={`rounded px-1.5 py-0.5 ${ESTILO[x.severidad]}`}>
          {NOMBRE_TIPO[x.tipo]}
          {x.tipo === "fotos" ? ` (${f.fotos})` : ""}
          {x.severidad === "informativo" ? " · info" : x.severidad === "secundario" ? " · sec." : ""}
        </span>
      ))}
    </div>
  );
}

const Tipo = ({ f }: { f: FilaCompletitud }) => (
  <div className="whitespace-nowrap">
    <span className={`rounded-md px-1.5 py-0.5 ${f.full ? "bg-blue-50 text-blue-700" : "bg-gray-100 text-gray-600"}`}>{f.full ? "Full" : "Estándar"}</span>
    <span className="ml-1 text-gray-400">{f.catalogo ? "catálogo" : "propia"}</span>
    <div className={`mt-0.5 ${f.estado === "paused" ? "text-amber-700" : "text-gray-500"}`}>{f.estado === "active" ? "activa" : f.estado === "paused" ? "pausada" : f.estado}</div>
  </div>
);
// "raíz › hoja": la hoja sola es ambigua (hay "Aromatizadores" en Vehículos y en Hogar).
const rutaCorta = (f: FilaCompletitud) => (f.categoria ? (f.categoria.ruta.length > 1 ? `${f.categoria.ruta[0]} › ${f.categoria.nombre}` : f.categoria.nombre) : "—");
const Enlace = ({ f }: { f: FilaCompletitud }) => (
  <div>
    <a href={link(f.id)} target="_blank" rel="noopener noreferrer" className="font-mono text-blue-700 hover:underline whitespace-nowrap">{f.id} ↗</a>
    <div className="text-gray-700 max-w-[13rem] truncate" title={f.titulo}>{f.titulo}</div>
  </div>
);

function Tarjeta({ titulo, color, n, linea2, linea3 }: { titulo: string; color: string; n: string; linea2: string; linea3?: string }) {
  return (
    <div className={`${color} rounded-xl p-3`}>
      <p className="text-xs text-gray-500">{titulo}</p>
      <p className="text-xl font-bold text-gray-900">{n}</p>
      <p className="text-xs text-gray-500">{linea2}</p>
      {linea3 && <p className="text-xs text-gray-400">{linea3}</p>}
    </div>
  );
}

// Bloque de la tarea principal: ISP faltante, agrupado por categoría.
function BloqueIspLista({ titulo, subtitulo, filas, color }: { titulo: string; subtitulo: string; filas: FilaConIngreso[]; color: string }) {
  const grupos = useMemo(() => {
    const m = new Map<string, { nombre: string; ruta: string; filas: FilaConIngreso[] }>();
    for (const f of filas) {
      const k = f.categoria?.id ?? "sin-categoria";
      const g = m.get(k) ?? { nombre: f.categoria?.nombre ?? "Sin categoría", ruta: f.categoria?.ruta.join(" › ") ?? "", filas: [] };
      g.filas.push(f);
      m.set(k, g);
    }
    const out = [...m.values()].map((g) => ({ ...g, filas: g.filas.sort((a, b) => b.ingreso90 - a.ingreso90), ingreso: g.filas.reduce((s, x) => s + x.ingreso90, 0) }));
    return out.sort((a, b) => b.ingreso - a.ingreso);
  }, [filas]);
  const total = filas.reduce((s, f) => s + f.ingreso90, 0);
  const conVentas = filas.filter((f) => f.ingreso90 > 0).length;
  return (
    <div className="space-y-2">
      <div className={`${color} rounded-xl p-3`}>
        <p className="font-semibold text-gray-900">{titulo}</p>
        <p className="text-xs text-gray-600">{subtitulo}</p>
        <p className="text-sm text-gray-800 mt-1"><b>{filas.length}</b> sin ISP · <b>{conVentas}</b> con ventas en 90 días · ingreso 90 d expuesto <b>{clp(total)}</b> · {grupos.length} categorías</p>
      </div>
      {filas.length === 0 && <p className="text-xs text-gray-400 px-1">Ninguna publicación en este bloque con los filtros actuales.</p>}
      {grupos.map((g, i) => {
        let acum = 0;
        return (
          <details key={g.ruta + i} open={i < 3} className="border border-gray-200 rounded-xl">
            <summary className="cursor-pointer px-3 py-2 text-sm flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-medium text-gray-900">{g.nombre}</span>
              <span className="text-xs text-gray-400">{g.ruta}</span>
              <span className="text-xs text-gray-600 ml-auto">{g.filas.length} pub · {g.filas.filter((f) => f.ingreso90 > 0).length} con ventas · {clp(g.ingreso)}</span>
            </summary>
            <div className="overflow-x-auto border-t border-gray-100">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-gray-50 text-left text-gray-500 uppercase tracking-wide">
                    <th className="px-2 py-2">Publicación</th><th className="px-2 py-2">Tipo / estado</th>
                    <th className="px-2 py-2">Categoría</th><th className="px-2 py-2 text-right">Ingreso 90d</th><th className="px-2 py-2 text-right">% acum.</th><th className="px-2 py-2">También falta</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {g.filas.map((f) => {
                    acum += f.ingreso90;
                    return (
                      <tr key={f.id} className="align-top">
                        <td className="px-2 py-2"><Enlace f={f} /></td>
                        <td className="px-2 py-2"><Tipo f={f} /></td>
                        <td className="px-2 py-2 text-gray-600 max-w-[10rem]" title={f.categoria?.ruta.join(" › ")}>{rutaCorta(f)}</td>
                        <td className="px-2 py-2 text-right font-semibold whitespace-nowrap">{clp(f.ingreso90)}</td>
                        <td className="px-2 py-2 text-right text-gray-500 whitespace-nowrap">{total > 0 ? pct((acum / total) * 100) : "—"}</td>
                        <td className="px-2 py-2"><Chips f={f} omitir="isp" /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </details>
        );
      })}
    </div>
  );
}

type FiltroFaltante = "todos" | "isp_esperable" | "isp_a_confirmar" | "descripcion" | "fotos" | "gtin" | "sin_faltantes";

export default function Completitud() {
  const [res, setRes] = useState<Resultado | null>(cache);
  const [cargando, setCargando] = useState(false);
  const [progreso, setProgreso] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [incluirOtras, setIncluirOtras] = useState(false);
  const [fFaltante, setFFaltante] = useState<FiltroFaltante>("todos");
  const [fEstado, setFEstado] = useState<"todos" | "active" | "paused">("todos");
  const [fTipo, setFTipo] = useState<"todos" | "full" | "estandar">("todos");
  const [fOrigen, setFOrigen] = useState<"todos" | "catalogo" | "propia">("todos");
  const [busqueda, setBusqueda] = useState("");
  const [visibles, setVisibles] = useState(40);

  async function ejecutar() {
    setCargando(true);
    setError(null);
    try {
      setProgreso("Listando publicaciones…");
      const { ids } = await llamar<{ ids: string[] }>("listar");
      setProgreso("Ventas de 90 días…");
      const ventas = await llamar<VentasApi>("ventas");
      const revisadas: FilaCompletitud[] = [];
      let pendientes = ids;
      for (let ronda = 0; ronda < 5 && pendientes.length > 0; ronda++) {
        const siguiente: string[] = [];
        for (let i = 0; i < pendientes.length; i += 200) {
          setProgreso(`Revisando publicaciones… ${revisadas.length} de ${ids.length}`);
          const r = await llamar<{ filas: FilaCompletitud[]; pendientes: string[] }>("revisar", { ids: pendientes.slice(i, i + 200) });
          revisadas.push(...r.filas);
          siguiente.push(...r.pendientes);
        }
        pendientes = siguiente;
      }
      const filas: FilaConIngreso[] = revisadas.map((f) => {
        const v = ventas.items[f.id];
        return { ...f, ingreso90: v?.[0] ?? 0, unidades90: v?.[1] ?? 0, clase: (v?.[2] as FilaConIngreso["clase"]) ?? "S" };
      });
      cache = { filas, ingresoTotal90: ventas.ingresoTotal90, desde: ventas.desde, hasta: ventas.hasta, ts: Date.now() };
      setRes(cache);
      setVisibles(40);
    } catch (e) {
      setError(String(e));
    } finally {
      setCargando(false);
      setProgreso("");
    }
  }

  const enAlc = useMemo(() => (res ? res.filas.filter((f) => enAlcance(f, incluirOtras)) : []), [res, incluirOtras]);
  const resumen = useMemo(() => (res ? resumirCompletitud(enAlc, res.ingresoTotal90) : null), [res, enAlc]);
  const ispEsperable = useMemo(() => enAlc.filter((f) => f.faltantes.some((x) => x.tipo === "isp") && f.bloqueIsp === "esperable"), [enAlc]);
  const ispAConfirmar = useMemo(() => enAlc.filter((f) => f.faltantes.some((x) => x.tipo === "isp") && f.bloqueIsp === "a_confirmar"), [enAlc]);

  const filas = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    const tiene = (f: FilaConIngreso, t: TipoFaltante) => f.faltantes.some((x) => x.tipo === t);
    return enAlc
      .filter((f) =>
        fFaltante === "todos" ? true
        : fFaltante === "isp_esperable" ? tiene(f, "isp") && f.bloqueIsp === "esperable"
        : fFaltante === "isp_a_confirmar" ? tiene(f, "isp") && f.bloqueIsp === "a_confirmar"
        : fFaltante === "sin_faltantes" ? f.nFaltantes === 0
        : tiene(f, fFaltante))
      .filter((f) => fEstado === "todos" || f.estado === fEstado)
      .filter((f) => fTipo === "todos" || (fTipo === "full") === f.full)
      .filter((f) => fOrigen === "todos" || (fOrigen === "catalogo") === f.catalogo)
      .filter((f) => !q || `${f.id} ${f.titulo} ${f.categoria?.ruta.join(" ") ?? ""}`.toLowerCase().includes(q))
      .sort((a, b) => b.ingreso90 - a.ingreso90);
  }, [enAlc, fFaltante, fEstado, fTipo, fOrigen, busqueda]);
  const reset = () => setVisibles(40);
  const r = resumen;

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-bold text-gray-900">Completitud de publicaciones (ISP, descripción, fotos, GTIN)</h3>
          <p className="text-xs text-gray-400 mt-1">
            Solo lectura y a pedido (~40 s). Ordenada por ingreso de 90 días. La tarea principal es el ISP de las que más venden.
          </p>
        </div>
        <button onClick={ejecutar} disabled={cargando} className="px-4 py-2 rounded-lg bg-gray-900 text-white text-sm disabled:opacity-50">
          {cargando ? progreso || "Revisando…" : res ? "Actualizar" : "Revisar completitud (~40 s)"}
        </button>
      </div>
      {error && <p className="text-sm text-red-700">No se pudo completar la revisión: {error}</p>}
      {!res && !cargando && !error && <p className="text-sm text-gray-500">Aún no se ha revisado. Pulsa el botón para consultar ML publicación por publicación.</p>}

      {res && r && (
        <>
          <p className="text-xs text-gray-400">
            Datos de {new Date(res.ts).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })} · ventas {res.desde.slice(0, 10)} → {new Date(Date.parse(res.hasta) - 86400000).toISOString().slice(0, 10)} · ingreso total 90 d {clp(res.ingresoTotal90)}
          </p>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={incluirOtras} onChange={(e) => { setIncluirOtras(e.target.checked); reset(); }} />
            Incluir publicaciones sin ventas en 90 días y de otros estados ({res.filas.length} en total; por defecto solo activas y pausadas con ventas: {res.filas.filter((f) => enAlcance(f, false)).length})
          </label>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Tarjeta titulo="ISP · cosméticos y cuidado personal (esperable)" color="bg-red-50" n={`${num(r.isp.esperable.publicaciones)} sin ISP`}
              linea2={`${r.isp.esperable.conVentas} con ventas · ${clp(r.isp.esperable.ingreso90)}`} linea3={`${pct(r.isp.esperable.pctIngreso)} del ingreso de 90 d`} />
            <Tarjeta titulo="ISP · a confirmar si lo requieren" color="bg-amber-50" n={`${num(r.isp.aConfirmar.publicaciones)} sin ISP`}
              linea2={`${r.isp.aConfirmar.conVentas} con ventas · ${clp(r.isp.aConfirmar.ingreso90)}`} linea3={`${pct(r.isp.aConfirmar.pctIngreso)} del ingreso de 90 d`} />
            <Tarjeta titulo="Sin descripción (o muy corta)" color="bg-gray-50" n={num(r.descripcion.publicaciones)}
              linea2={`${r.descripcion.conVentas} con ventas · ${clp(r.descripcion.ingreso90)}`} linea3={`${pct(r.descripcion.pctIngreso)} del ingreso de 90 d`} />
            <Tarjeta titulo="Fotos < 3" color="bg-gray-50" n={`${num(r.fotos.propias.publicaciones)} propias`}
              linea2={`${num(r.fotos.catalogo.publicaciones)} de catálogo (secundario)`} linea3={`ingreso propias ${clp(r.fotos.propias.ingreso90)}`} />
            <Tarjeta titulo="Sin GTIN" color="bg-gray-50" n={`${num(r.gtin.propias.publicaciones)} propias`}
              linea2={`${num(r.gtin.catalogoInformativo.publicaciones)} de catálogo (solo informativo)`} linea3="el producto de catálogo casi nunca expone el GTIN por API" />
            <Tarjeta titulo="Sin faltantes" color="bg-green-50" n={`${num(r.sinFaltantes)} de ${num(r.publicaciones)}`} linea2="no cuenta los informativos" />
          </div>

          <p className="text-xs text-gray-500">
            Los bloques de ISP se separan por la categoría raíz de ML: &laquo;esperable&raquo; = Belleza y Cuidado Personal; &laquo;a confirmar&raquo; = el resto (p. ej. aromatizantes de ambiente y de vehículos, productos de lavandería).
            Ninguna publicación se marca como &laquo;no aplica&raquo;: si un producto requiere ISP lo decides tú con el proveedor. Si la categoría no ofrece el campo en ML, no cuenta como faltante.
          </p>

          <div className="space-y-4">
            <h4 className="font-semibold text-gray-900">Tarea principal: ISP de las que más venden, por categoría</h4>
            <BloqueIspLista titulo="Cosméticos y cuidado personal (ISP esperable)" subtitulo="Categoría raíz: Belleza y Cuidado Personal" filas={ispEsperable} color="bg-red-50" />
            <BloqueIspLista titulo="A confirmar si requieren ISP" subtitulo="Todo lo que no es cosmético ni cuidado personal: aromatizantes de ambiente y de vehículos, lavandería, limpieza, toallitas de bebé…" filas={ispAConfirmar} color="bg-amber-50" />
          </div>

          <div className="space-y-3">
            <h4 className="font-semibold text-gray-900">Todas las publicaciones, por ingreso de 90 días</h4>
            <div className="flex flex-wrap items-center gap-2">
              <select value={fFaltante} onChange={(e) => { setFFaltante(e.target.value as FiltroFaltante); reset(); }} className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm">
                <option value="todos">Cualquier faltante</option>
                <option value="isp_esperable">Sin ISP · cosméticos y cuidado personal</option>
                <option value="isp_a_confirmar">Sin ISP · a confirmar</option>
                <option value="descripcion">Sin descripción</option>
                <option value="fotos">Fotos &lt; 3</option>
                <option value="gtin">GTIN (propias; catálogo = informativo)</option>
                <option value="sin_faltantes">Sin faltantes</option>
              </select>
              <select value={fEstado} onChange={(e) => { setFEstado(e.target.value as typeof fEstado); reset(); }} className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm">
                <option value="todos">Activas y pausadas</option><option value="active">Solo activas</option><option value="paused">Solo pausadas</option>
              </select>
              <select value={fTipo} onChange={(e) => { setFTipo(e.target.value as typeof fTipo); reset(); }} className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm">
                <option value="todos">Full y estándar</option><option value="full">Solo Full</option><option value="estandar">Solo estándar</option>
              </select>
              <select value={fOrigen} onChange={(e) => { setFOrigen(e.target.value as typeof fOrigen); reset(); }} className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm">
                <option value="todos">Catálogo y propias</option><option value="catalogo">Solo catálogo</option><option value="propia">Solo propias</option>
              </select>
              <input value={busqueda} onChange={(e) => { setBusqueda(e.target.value); reset(); }} placeholder="Buscar ID, título o categoría" className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm flex-1 min-w-40" />
            </div>
            <div className="overflow-x-auto rounded-xl border border-gray-200">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200 text-left text-gray-500 uppercase tracking-wide">
                    <th className="px-2 py-2">Publicación</th><th className="px-2 py-2">Tipo / estado</th><th className="px-2 py-2">Categoría</th>
                    <th className="px-2 py-2">Clase</th><th className="px-2 py-2 text-right">Ingreso 90d</th><th className="px-2 py-2">Qué le falta</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filas.slice(0, visibles).map((f) => (
                    <tr key={f.id} className="align-top">
                      <td className="px-2 py-2"><Enlace f={f} /></td>
                      <td className="px-2 py-2"><Tipo f={f} /></td>
                      <td className="px-2 py-2 text-gray-600 max-w-[10rem]" title={f.categoria?.ruta.join(" › ")}>{rutaCorta(f)}</td>
                      <td className="px-2 py-2 font-semibold">{f.clase === "S" ? "—" : f.clase}</td>
                      <td className="px-2 py-2 text-right font-semibold whitespace-nowrap">{clp(f.ingreso90)}</td>
                      <td className="px-2 py-2"><Chips f={f} /></td>
                    </tr>
                  ))}
                  {filas.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-400">Ninguna publicación coincide con los filtros.</td></tr>}
                </tbody>
              </table>
            </div>
            {filas.length > visibles && (
              <button onClick={() => setVisibles((v) => v + 40)} className="w-full text-sm text-gray-700 hover:text-black underline">Mostrando {visibles} de {filas.length} — mostrar más</button>
            )}
            <p className="text-xs text-gray-400">Rojo = faltante principal · ámbar = secundario (fotos en catálogo) · gris = informativo (GTIN en catálogo).</p>
          </div>
        </>
      )}
    </div>
  );
}

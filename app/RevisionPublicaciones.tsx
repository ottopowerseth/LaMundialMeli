"use client";

import { useMemo, useRef, useState } from "react";

// Revisión de faltantes de descripción e ISP. Lista los IDs una vez y manda
// lotes sin estado a /api/revision-publicaciones en loop (mismo patrón que el
// backfill de envíos), acumulando las filas acá. El resultado vive solo en
// memoria: al recargar la página hay que volver a correr la revisión.

const TAMANO_LOTE = 150;
const FILAS_POR_PAGINA = 200;

type EstadoCampo = "ok" | "falta" | "error";
type Motivo = "404" | "vacia" | "simbolos" | "corta";

type Fila = {
  id: string;
  titulo: string;
  sku: string | null;
  estado: string;
  catalogo: boolean;
  permalink: string | null;
  descripcion: { estado: EstadoCampo; motivo: Motivo | null; largo: number | null; error?: string };
  isp: { estado: "ok" | "falta" | "no_aplica" | "error"; valor: string | null; error?: string };
  error?: string;
};

type FiltroFaltante = "todos" | "desc" | "isp" | "ambos" | "alguno" | "completas" | "isp_no_aplica" | "error";
type FiltroOrigen = "todos" | "catalogo" | "propias";

const ESTADO_LABEL: Record<string, string> = {
  active: "Activa",
  paused: "Pausada",
  under_review: "En revisión",
  not_yet_active: "Activándose",
  inactive: "Inactiva",
};

const MOTIVO_LABEL: Record<Motivo, string> = {
  "404": "404",
  vacia: "vacía",
  simbolos: "solo símbolos",
  corta: "corta",
};

const estadoLabel = (e: string) => ESTADO_LABEL[e] ?? e;
const hayError = (f: Fila) => !!f.error || f.descripcion.estado === "error" || f.isp.estado === "error";
const faltaDesc = (f: Fila) => f.descripcion.estado === "falta";
const faltaIsp = (f: Fila) => f.isp.estado === "falta";

function textoMotivo(f: Fila) {
  const d = f.descripcion;
  if (d.estado === "error") return "error";
  if (d.estado === "ok") return "";
  const base = d.motivo ? MOTIVO_LABEL[d.motivo] : "";
  return d.largo ? `${base} (${d.largo} car.)` : base;
}

const BOM = String.fromCharCode(0xfeff);

function csvCell(v: string | number | null) {
  let s = v === null ? "" : String(v);
  // Evita que Excel interprete un título como fórmula.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportarCsv(filas: Fila[]) {
  const header = [
    "ID", "Título", "SKU", "Estado", "Origen",
    "Falta descripción", "Motivo descripción", "Largo descripción",
    "Falta ISP", "Valor ISP", "Link",
  ];
  const lineas = filas.map((f) =>
    [
      f.id,
      f.titulo,
      f.sku,
      estadoLabel(f.estado),
      f.catalogo ? "Catálogo" : "Propia",
      f.descripcion.estado === "error" ? "Error" : faltaDesc(f) ? "Sí" : "No",
      f.descripcion.motivo ? MOTIVO_LABEL[f.descripcion.motivo] : "",
      f.descripcion.largo,
      f.isp.estado === "error" ? "Error" : f.isp.estado === "no_aplica" ? "No aplica" : faltaIsp(f) ? "Sí" : "No",
      f.isp.valor,
      f.permalink,
    ].map(csvCell).join(";")
  );
  // Separador ";" y BOM UTF-8: así Excel en configuración regional es_CL abre
  // el archivo en columnas y con tildes correctas.
  const blob = new Blob([BOM + [header.join(";"), ...lineas].join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `revision-publicaciones-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function llamar<T>(body: object): Promise<T> {
  const res = await fetch("/api/revision-publicaciones", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data: { ok?: boolean; error?: string } & Record<string, unknown>;
  try {
    data = await res.json();
  } catch {
    throw new Error(`Respuesta inválida (HTTP ${res.status}); ¿sesión vencida o tiempo agotado?`);
  }
  if (!data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as unknown as T;
}

export default function RevisionPublicaciones({ mlOk }: { mlOk: boolean }) {
  const [corriendo, setCorriendo] = useState<"listando" | "revisando" | null>(null);
  const [filas, setFilas] = useState<Fila[]>([]);
  const [progreso, setProgreso] = useState({ hechas: 0, total: 0 });
  const [sinRevisar, setSinRevisar] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [terminadaA, setTerminadaA] = useState<Date | null>(null);
  const cancelado = useRef(false);

  const [fFaltante, setFFaltante] = useState<FiltroFaltante>("todos");
  const [fEstado, setFEstado] = useState("todos");
  const [fOrigen, setFOrigen] = useState<FiltroOrigen>("todos");
  const [busqueda, setBusqueda] = useState("");
  const [visibles, setVisibles] = useState(FILAS_POR_PAGINA);

  function aplicarFiltros(
    faltante: FiltroFaltante = fFaltante,
    estado: string = fEstado,
    origen: FiltroOrigen = fOrigen
  ) {
    setFFaltante(faltante);
    setFEstado(estado);
    setFOrigen(origen);
    setVisibles(FILAS_POR_PAGINA);
  }

  async function revisarConReintento(lote: string[]) {
    try {
      return await llamar<{ filas: Fila[]; pendientes: string[] }>({ accion: "revisar", ids: lote });
    } catch {
      // Un solo reintento ante un fallo de red/timeout del lote completo.
      return await llamar<{ filas: Fila[]; pendientes: string[] }>({ accion: "revisar", ids: lote });
    }
  }

  // ids: lista a procesar. Sin ids = revisión nueva (lista todo desde ML).
  async function ejecutar(idsReintento?: string[]) {
    cancelado.current = false;
    setError(null);
    const fallidos: string[] = [];
    try {
      let cola: string[];
      let hechasBase: number;
      if (idsReintento) {
        cola = [...idsReintento];
        hechasBase = progreso.total - idsReintento.length;
      } else {
        setCorriendo("listando");
        setFilas([]);
        setSinRevisar([]);
        setTerminadaA(null);
        setProgreso({ hechas: 0, total: 0 });
        setVisibles(FILAS_POR_PAGINA);
        const lista = await llamar<{ ids: string[] }>({ accion: "listar" });
        cola = lista.ids;
        hechasBase = 0;
        setProgreso({ hechas: 0, total: cola.length });
      }
      const total = hechasBase + cola.length;
      let hechas = hechasBase;
      let estancados = 0;
      setCorriendo("revisando");

      while (cola.length > 0 && !cancelado.current) {
        const lote = cola.splice(0, TAMANO_LOTE);
        try {
          const r = await revisarConReintento(lote);
          setFilas((prev) => {
            const nuevas = new Map(prev.map((f) => [f.id, f]));
            for (const f of r.filas) nuevas.set(f.id, f);
            return [...nuevas.values()];
          });
          hechas += r.filas.length;
          if (r.pendientes.length > 0) {
            // El servidor cortó por tiempo: reintenta lo que no alcanzó. Si 3
            // lotes seguidos no avanzan, se da por fallido para no ciclar.
            cola.unshift(...r.pendientes);
            estancados = r.filas.length === 0 ? estancados + 1 : 0;
            if (estancados >= 3) fallidos.push(...cola.splice(0));
          } else {
            estancados = 0;
          }
        } catch (e) {
          // El lote entero falló dos veces: se aparta y la corrida sigue.
          fallidos.push(...lote);
          setError(`Un lote de ${lote.length} publicaciones falló (${e instanceof Error ? e.message : String(e)}). Se puede reintentar al final.`);
        }
        setProgreso({ hechas, total });
      }
      // Si se canceló, lo que quedó en cola también queda pendiente.
      setSinRevisar([...fallidos, ...cola]);
      if (!cancelado.current) setTerminadaA(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCorriendo(null);
    }
  }

  const resumen = useMemo(() => {
    const base = () => ({ total: 0, sinDesc: 0, sinIsp: 0, ambos: 0, ispNoAplica: 0, errores: 0 });
    const total = base();
    const grupos = new Map<string, { estado: string; origen: FiltroOrigen; c: ReturnType<typeof base> }>();
    for (const f of filas) {
      const origen: FiltroOrigen = f.catalogo ? "catalogo" : "propias";
      const key = `${f.estado}|${origen}`;
      if (!grupos.has(key)) grupos.set(key, { estado: f.estado, origen, c: base() });
      for (const c of [total, grupos.get(key)!.c]) {
        c.total++;
        if (faltaDesc(f)) c.sinDesc++;
        if (faltaIsp(f)) c.sinIsp++;
        if (faltaDesc(f) && faltaIsp(f)) c.ambos++;
        if (f.isp.estado === "no_aplica") c.ispNoAplica++;
        if (hayError(f)) c.errores++;
      }
    }
    const orden = Object.keys(ESTADO_LABEL);
    const lista = [...grupos.values()].sort(
      (a, b) =>
        (orden.indexOf(a.estado) === -1 ? 99 : orden.indexOf(a.estado)) -
          (orden.indexOf(b.estado) === -1 ? 99 : orden.indexOf(b.estado)) ||
        a.origen.localeCompare(b.origen)
    );
    return { total, grupos: lista, estados: [...new Set(filas.map((f) => f.estado))] };
  }, [filas]);

  const filtradas = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    return filas
      .filter((f) => {
        if (fEstado !== "todos" && f.estado !== fEstado) return false;
        if (fOrigen === "catalogo" && !f.catalogo) return false;
        if (fOrigen === "propias" && f.catalogo) return false;
        if (fFaltante === "desc" && !faltaDesc(f)) return false;
        if (fFaltante === "isp" && !faltaIsp(f)) return false;
        if (fFaltante === "ambos" && !(faltaDesc(f) && faltaIsp(f))) return false;
        if (fFaltante === "alguno" && !(faltaDesc(f) || faltaIsp(f))) return false;
        if (fFaltante === "completas" && (faltaDesc(f) || faltaIsp(f) || hayError(f))) return false;
        if (fFaltante === "isp_no_aplica" && f.isp.estado !== "no_aplica") return false;
        if (fFaltante === "error" && !hayError(f)) return false;
        if (q && !`${f.id} ${f.titulo} ${f.sku ?? ""}`.toLowerCase().includes(q)) return false;
        return true;
      })
      .sort(
        (a, b) =>
          Number(faltaDesc(b)) + Number(faltaIsp(b)) - (Number(faltaDesc(a)) + Number(faltaIsp(a))) ||
          a.titulo.localeCompare(b.titulo)
      );
  }, [filas, fFaltante, fEstado, fOrigen, busqueda]);

  const { total: t } = resumen;
  const pct = progreso.total > 0 ? Math.round((progreso.hechas / progreso.total) * 100) : 0;
  const hayFiltros = fFaltante !== "todos" || fEstado !== "todos" || fOrigen !== "todos" || busqueda !== "";

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-4">
      <div>
        <h2 className="font-bold text-gray-900 text-lg">Revisar descripción e ISP</h2>
        <p className="text-sm text-gray-500 mt-1">
          Revisa todas las publicaciones de la cuenta y marca las que no tienen descripción (o es muy corta) o no tienen
          número de inscripción ISP. Solo lee de ML, no modifica nada.
        </p>
      </div>

      {corriendo ? (
        <div className="space-y-2">
          <div className="w-full bg-gray-100 rounded-full h-2.5 overflow-hidden">
            <div className="h-2.5 rounded-full transition-all" style={{ width: `${corriendo === "listando" ? 3 : pct}%`, backgroundColor: "#C41230" }} />
          </div>
          <p className="text-sm text-gray-600">
            {corriendo === "listando"
              ? "Listando publicaciones..."
              : `Revisadas ${progreso.hechas} de ${progreso.total} (${pct}%)`}
          </p>
          <button onClick={() => { cancelado.current = true; }}
            className="w-full bg-gray-200 hover:bg-gray-300 text-gray-800 font-bold py-3 px-4 rounded-xl">
            Cancelar
          </button>
        </div>
      ) : (
        <button onClick={() => ejecutar()} disabled={!mlOk}
          className="w-full font-bold py-3 px-4 rounded-xl text-white disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ backgroundColor: "#C41230" }}>
          {filas.length > 0 ? "Volver a revisar" : "Revisar publicaciones"}
        </button>
      )}

      {error && <p className="text-red-600 text-sm">✗ {error}</p>}

      {!corriendo && sinRevisar.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-amber-900">{sinRevisar.length} publicaciones quedaron sin revisar.</p>
          <button onClick={() => ejecutar(sinRevisar)}
            className="bg-amber-600 hover:bg-amber-700 text-white font-semibold text-sm py-1.5 px-4 rounded-lg">
            Reintentar esas {sinRevisar.length}
          </button>
        </div>
      )}

      {filas.length > 0 && (
        <>
          {/* Conteos */}
          <p className="text-sm font-semibold text-gray-800">
            {t.sinDesc} sin descripción · {t.sinIsp} sin ISP · {t.ambos} con ambos faltantes · {t.ispNoAplica} ISP no aplica
            {t.errores > 0 && <span className="text-red-600"> · {t.errores} con error</span>}
            <span className="font-normal text-gray-500"> — de {t.total} revisadas
              {terminadaA && `, ${terminadaA.toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })}`}
            </span>
          </p>

          <div className="overflow-x-auto rounded-xl border border-gray-200">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-left text-gray-500 uppercase tracking-wide">
                  <th className="px-3 py-2">Estado · Origen</th>
                  <th className="px-3 py-2 text-right">Total</th>
                  <th className="px-3 py-2 text-right">Sin descripción</th>
                  <th className="px-3 py-2 text-right">Sin ISP</th>
                  <th className="px-3 py-2 text-right">Ambos</th>
                  <th className="px-3 py-2 text-right">ISP no aplica</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {resumen.grupos.map((g) => (
                  <tr key={`${g.estado}|${g.origen}`} className="hover:bg-gray-50 cursor-pointer"
                    onClick={() => aplicarFiltros("todos", g.estado, g.origen)}
                    title="Filtrar la tabla por esta combinación">
                    <td className="px-3 py-1.5 text-gray-800">{estadoLabel(g.estado)} · {g.origen === "catalogo" ? "Catálogo" : "Propias"}</td>
                    <td className="px-3 py-1.5 text-right">{g.c.total}</td>
                    <td className="px-3 py-1.5 text-right">{g.c.sinDesc}</td>
                    <td className="px-3 py-1.5 text-right">{g.c.sinIsp}</td>
                    <td className="px-3 py-1.5 text-right">{g.c.ambos}</td>
                    <td className="px-3 py-1.5 text-right text-gray-500">{g.c.ispNoAplica}</td>
                  </tr>
                ))}
                <tr className="bg-gray-50 font-semibold">
                  <td className="px-3 py-1.5">Total</td>
                  <td className="px-3 py-1.5 text-right">{t.total}</td>
                  <td className="px-3 py-1.5 text-right">{t.sinDesc}</td>
                  <td className="px-3 py-1.5 text-right">{t.sinIsp}</td>
                  <td className="px-3 py-1.5 text-right">{t.ambos}</td>
                  <td className="px-3 py-1.5 text-right">{t.ispNoAplica}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Filtros */}
          <div className="flex flex-wrap items-center gap-2">
            <select value={fFaltante} onChange={(e) => aplicarFiltros(e.target.value as FiltroFaltante)}
              className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm">
              <option value="todos">Todos</option>
              <option value="alguno">Falta alguno</option>
              <option value="desc">Falta descripción</option>
              <option value="isp">Falta ISP</option>
              <option value="ambos">Faltan ambos</option>
              <option value="completas">Completas</option>
              <option value="isp_no_aplica">ISP no aplica</option>
              <option value="error">Con error de revisión</option>
            </select>
            <select value={fEstado} onChange={(e) => aplicarFiltros(undefined, e.target.value)}
              className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm">
              <option value="todos">Todos los estados</option>
              {resumen.estados.map((e) => <option key={e} value={e}>{estadoLabel(e)}</option>)}
            </select>
            <select value={fOrigen} onChange={(e) => aplicarFiltros(undefined, undefined, e.target.value as FiltroOrigen)}
              className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm">
              <option value="todos">Catálogo y propias</option>
              <option value="catalogo">Solo catálogo</option>
              <option value="propias">Solo propias</option>
            </select>
            <input value={busqueda} onChange={(e) => { setBusqueda(e.target.value); setVisibles(FILAS_POR_PAGINA); }}
              placeholder="Buscar ID, título o SKU"
              className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm flex-1 min-w-40" />
            {hayFiltros && (
              <button onClick={() => { aplicarFiltros("todos", "todos", "todos"); setBusqueda(""); }}
                className="text-sm text-gray-500 hover:text-gray-800 underline">
                Limpiar
              </button>
            )}
            <button onClick={() => exportarCsv(filtradas)} disabled={filtradas.length === 0}
              className="bg-gray-900 hover:bg-black disabled:opacity-40 text-white font-semibold text-sm py-1.5 px-4 rounded-lg">
              Exportar CSV ({filtradas.length})
            </button>
          </div>

          {/* Tabla */}
          <div className="overflow-x-auto rounded-xl border border-gray-200">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-left text-gray-500 uppercase tracking-wide">
                  <th className="px-3 py-2">Publicación</th>
                  <th className="px-3 py-2">Título</th>
                  <th className="px-3 py-2">SKU</th>
                  <th className="px-3 py-2">Estado · Origen</th>
                  <th className="px-3 py-2">Falta descripción</th>
                  <th className="px-3 py-2">Falta ISP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtradas.slice(0, visibles).map((f) => (
                  <tr key={f.id} className="align-top">
                    <td className="px-3 py-2 whitespace-nowrap">
                      {f.permalink ? (
                        <a href={f.permalink} target="_blank" rel="noopener noreferrer"
                          className="font-mono text-blue-700 hover:underline">{f.id} ↗</a>
                      ) : (
                        <span className="font-mono">{f.id}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 min-w-44 text-gray-800">{f.titulo || "—"}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-gray-600">{f.sku ?? "—"}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{estadoLabel(f.estado)} · {f.catalogo ? "Catálogo" : "Propia"}</td>
                    <td className="px-3 py-2">
                      {f.error ? (
                        <span className="text-red-600">Error: {f.error}</span>
                      ) : f.descripcion.estado === "error" ? (
                        <span className="text-red-600" title={f.descripcion.error}>Error al consultar</span>
                      ) : faltaDesc(f) ? (
                        <span className="inline-block rounded-md bg-red-100 text-red-800 px-2 py-0.5"
                          title={f.descripcion.motivo === "404" ? "ML no tiene ninguna descripción para esta publicación (HTTP 404)" : undefined}>
                          Sí · {textoMotivo(f)}
                        </span>
                      ) : (
                        <span className="text-gray-500">No · {f.descripcion.largo} car.</span>
                      )}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {f.isp.estado === "error" ? (
                        <span className="text-red-600" title={f.isp.error}>Error al consultar</span>
                      ) : f.isp.estado === "falta" ? (
                        <span className="inline-block rounded-md bg-red-100 text-red-800 px-2 py-0.5">Sí</span>
                      ) : f.isp.estado === "no_aplica" ? (
                        <span className="inline-block rounded-md bg-gray-100 text-gray-600 px-2 py-0.5" title="La categoría no tiene el atributo ISP">No aplica</span>
                      ) : (
                        <span className="text-gray-500">No · {f.isp.valor}</span>
                      )}
                    </td>
                  </tr>
                ))}
                {filtradas.length === 0 && (
                  <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-400">Ninguna publicación coincide con los filtros.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {filtradas.length > visibles && (
            <button onClick={() => setVisibles((v) => v + FILAS_POR_PAGINA)}
              className="w-full text-sm text-gray-700 hover:text-black underline">
              Mostrando {visibles} de {filtradas.length} — mostrar {Math.min(FILAS_POR_PAGINA, filtradas.length - visibles)} más
            </button>
          )}
        </>
      )}
    </div>
  );
}

"use client";

import { useState } from "react";

// Cola de operación (H), al final del Tablero. A PEDIDO (botón), solo lectura: NO se
// consulta al abrir el Tablero. Muestra qué hay pendiente y no sugiere acciones.
// Definiciones y mediciones en lib/operacion.ts. El resultado queda en una variable
// de módulo para no repetir la consulta al cambiar de pestaña.

type Bloque<T> = ({ ok: true } & T) | { ok: false; error: string };
type Despacho = {
  envioId: number; ordenes: string[]; titulos: string[]; unidades: number; subestado: string | null; estado: string;
  listoIso: string | null; impresoIso: string | null; horasDesdeListo: number | null;
  sla: { estado: string | null; plazoEntregaComprador: string | null } | null;
};
type Reclamo = {
  id: number; tipo: string; etapa: string; motivoId: string; motivo: string | null; afectaReputacion: string | null;
  ordenId: string | null; creadoIso: string | null; actualizadoIso: string | null;
};
type Pregunta = {
  id: number; itemId: string; texto: string; creadaIso: string | null; diasSinResponder: number | null;
  itemTitulo: string | null; itemEstado: string | null; itemSubestado: string[];
};
type Datos = {
  ok: boolean; error?: string; generadoEn: string; segundos: number;
  despachos: Bloque<{ accionables: Despacho[]; full: { total: number; porSubestado: Record<string, number> }; otros: { total: number; porTipo: Record<string, number> } }>;
  reclamos: Bloque<{ datos: Reclamo[] }>;
  preguntas: Bloque<{ datos: Pregunta[] }>;
  reputacion: Bloque<{ datos: string | null }>;
};

let cache: Datos | null = null;

const fecha = (iso: string | null) => (iso ? new Date(iso).toLocaleString("es-CL", { timeZone: "America/Santiago", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
const horas = (h: number | null) => (h === null ? "—" : h >= 48 ? `${(h / 24).toFixed(1).replace(".", ",")} d` : `${Math.round(h)} h`);
const linkItem = (id: string) => `https://articulo.mercadolibre.cl/${id.replace("MLC", "MLC-")}`;
// Etiquetas de ML traducidas solo para leer; los valores originales se ven en el tooltip.
const AFECTA: Record<string, string> = { affected: "afecta la reputación", not_affected: "no afecta la reputación" };

function Error_({ texto }: { texto: string }) {
  return <p className="text-sm text-red-600">No se pudo consultar este bloque: {texto}</p>;
}

export default function Operacion() {
  const [datos, setDatos] = useState<Datos | null>(cache);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verFull, setVerFull] = useState(false);

  async function consultar() {
    setCargando(true);
    setError(null);
    try {
      const r = await fetch("/api/operacion");
      const d = (await r.json()) as Datos;
      if (!d.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      cache = d;
      setDatos(d);
    } catch (e) {
      setError(String(e));
    } finally {
      setCargando(false);
    }
  }

  const desp = datos?.despachos;
  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-6 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-bold text-gray-900">Operación: despachos pendientes, reclamos, preguntas y reputación</h3>
          <p className="text-xs text-gray-400 mt-1">Solo lectura y a pedido (~15 s). Muestra lo que hay abierto hoy en ML; no sugiere acciones.</p>
        </div>
        <button onClick={consultar} disabled={cargando} className="px-4 py-2 rounded-lg bg-gray-900 text-white text-sm disabled:opacity-50">
          {cargando ? "Consultando ML…" : datos ? "Actualizar" : "Consultar (~15 s)"}
        </button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {datos && (
        <>
          <p className="text-xs text-gray-400">Consultado {fecha(datos.generadoEn)} · {datos.segundos.toString().replace(".", ",")} s</p>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="bg-gray-50 rounded-xl p-3"><p className="text-xs text-gray-500">Despachos que gestionas (retiro / punto de despacho)</p><p className="text-xl font-bold text-gray-900">{desp?.ok ? desp.accionables.length : "—"}</p></div>
            <div className="bg-gray-50 rounded-xl p-3"><p className="text-xs text-gray-500">Reclamos abiertos</p><p className="text-xl font-bold text-gray-900">{datos.reclamos.ok ? datos.reclamos.datos.length : "—"}</p></div>
            <div className="bg-gray-50 rounded-xl p-3"><p className="text-xs text-gray-500">Preguntas sin responder</p><p className="text-xl font-bold text-gray-900">{datos.preguntas.ok ? datos.preguntas.datos.length : "—"}</p></div>
            <div className="bg-gray-50 rounded-xl p-3"><p className="text-xs text-gray-500">Nivel de reputación (level_id de ML)</p><p className="text-xl font-bold text-gray-900">{datos.reputacion.ok ? datos.reputacion.datos ?? "sin dato" : "—"}</p></div>
          </div>

          <section className="space-y-2">
            <h4 className="font-semibold text-gray-800 text-sm">Despachos listos para enviar (más horas esperando primero)</h4>
            <p className="text-xs text-gray-400">«Horas» = tiempo desde que el envío quedó listo (date_ready_to_ship). El plazo que informa ML es el de <b>entrega al comprador</b>, no el de despacho: va como dato y no ordena.</p>
            {!desp ? null : !desp.ok ? <Error_ texto={desp.error} /> : (
              <>
                {desp.accionables.length === 0 ? <p className="text-sm text-gray-500">No hay despachos de retiro / punto de despacho listos.</p> : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead><tr className="text-left text-gray-500 border-b"><th className="py-1 pr-3">Horas</th><th className="pr-3">Listo desde</th><th className="pr-3">Etiqueta</th><th className="pr-3">Orden</th><th className="pr-3">Producto</th><th className="pr-3 text-right">Un.</th><th className="pr-3">Estado ML (SLA)</th><th>Plazo de entrega al comprador</th></tr></thead>
                      <tbody>
                        {desp.accionables.map((d) => (
                          <tr key={d.envioId} className="border-b border-gray-50 align-top">
                            <td className="py-1 pr-3 font-semibold text-gray-900 whitespace-nowrap">{horas(d.horasDesdeListo)}</td>
                            <td className="pr-3 whitespace-nowrap">{fecha(d.listoIso)}</td>
                            <td className="pr-3 whitespace-nowrap" title={`subestado ML: ${d.subestado ?? "—"}`}>{d.impresoIso ? "impresa" : "sin imprimir"}</td>
                            <td className="pr-3 whitespace-nowrap">{d.ordenes[0]}{d.ordenes.length > 1 ? ` +${d.ordenes.length - 1}` : ""}</td>
                            <td className="pr-3 max-w-[22rem] truncate" title={d.titulos.join(" | ")}>{d.titulos[0] ?? "—"}{d.titulos.length > 1 ? ` (+${d.titulos.length - 1})` : ""}</td>
                            <td className="pr-3 text-right">{d.unidades}</td>
                            <td className="pr-3 whitespace-nowrap">{d.sla?.estado ?? "—"}</td>
                            <td className="whitespace-nowrap">{fecha(d.sla?.plazoEntregaComprador ?? null)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <button onClick={() => setVerFull((v) => !v)} className="text-xs text-gray-500 underline">
                  {desp.full.total} envíos Full (los gestiona ML) y {desp.otros.total} de otro tipo {verFull ? "▲" : "▼"}
                </button>
                {verFull && (
                  <p className="text-xs text-gray-500">
                    Full por subestado: {Object.entries(desp.full.porSubestado).map(([k, v]) => `${k} ${v}`).join(" · ") || "—"}
                    {desp.otros.total > 0 && <> · Otros: {Object.entries(desp.otros.porTipo).map(([k, v]) => `${k} ${v}`).join(" · ")}</>}
                  </p>
                )}
              </>
            )}
          </section>

          <section className="space-y-2">
            <h4 className="font-semibold text-gray-800 text-sm">Reclamos abiertos</h4>
            {!datos.reclamos.ok ? <Error_ texto={datos.reclamos.error} /> : datos.reclamos.datos.length === 0 ? <p className="text-sm text-gray-500">Sin reclamos abiertos.</p> : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="text-left text-gray-500 border-b"><th className="py-1 pr-3">Reclamo</th><th className="pr-3">Orden</th><th className="pr-3">Tipo / etapa</th><th className="pr-3">Motivo</th><th className="pr-3">Reputación</th><th className="pr-3">Abierto</th><th>Actualizado</th></tr></thead>
                  <tbody>
                    {datos.reclamos.datos.map((c) => (
                      <tr key={c.id} className="border-b border-gray-50 align-top">
                        <td className="py-1 pr-3">{c.id}</td>
                        <td className="pr-3">{c.ordenId ? c.ordenId : "—"}</td>
                        <td className="pr-3 whitespace-nowrap">{c.tipo} / {c.etapa}</td>
                        <td className="pr-3" title={c.motivoId}>{c.motivo ?? c.motivoId}</td>
                        <td className="pr-3 whitespace-nowrap" title={c.afectaReputacion ?? ""}>{c.afectaReputacion ? AFECTA[c.afectaReputacion] ?? c.afectaReputacion : "sin dato"}</td>
                        <td className="pr-3 whitespace-nowrap">{fecha(c.creadoIso)}</td>
                        <td className="whitespace-nowrap">{fecha(c.actualizadoIso)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="space-y-2">
            <h4 className="font-semibold text-gray-800 text-sm">Preguntas sin responder (más antiguas primero)</h4>
            {!datos.preguntas.ok ? <Error_ texto={datos.preguntas.error} /> : datos.preguntas.datos.length === 0 ? <p className="text-sm text-gray-500">Sin preguntas pendientes.</p> : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="text-left text-gray-500 border-b"><th className="py-1 pr-3">Días</th><th className="pr-3">Fecha</th><th className="pr-3">Publicación</th><th className="pr-3">Estado de la publicación</th><th>Pregunta</th></tr></thead>
                  <tbody>
                    {datos.preguntas.datos.map((q) => (
                      <tr key={q.id} className="border-b border-gray-50 align-top">
                        <td className="py-1 pr-3 font-semibold text-gray-900">{q.diasSinResponder ?? "—"}</td>
                        <td className="pr-3 whitespace-nowrap">{fecha(q.creadaIso)}</td>
                        <td className="pr-3 max-w-[18rem] truncate" title={q.itemTitulo ?? ""}><a className="text-blue-700 hover:underline" href={linkItem(q.itemId)} target="_blank" rel="noreferrer">{q.itemTitulo ?? q.itemId}</a></td>
                        <td className="pr-3 whitespace-nowrap">{q.itemEstado ?? "—"}{q.itemSubestado.length ? ` (${q.itemSubestado.join(", ")})` : ""}</td>
                        <td>{q.texto}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <p className="text-xs text-gray-400">Nivel de reputación: se muestra tal cual lo informa ML (level_id), sin umbrales ni interpretación. Esta sección no autoriza por sí sola ninguna decisión.</p>
        </>
      )}
    </div>
  );
}

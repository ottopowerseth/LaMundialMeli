"use client";

import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { ETIQUETA_MODO, desgloseVentas, filasParaPedido, hojasPedido, libroDesdeHojas, notaTipoPocoClaro, tipoNormalPocoClaro } from "@/lib/forecast";
import type { ForecastRow, Modo, Prioridad, ResumenForecast, ParametrosForecast } from "@/lib/forecast";

// Pestaña Forecast: reposición sugerida separada por modo logístico (Full / Normal / Sin clasificar) + Resumen.
// Reglas y fuentes en lib/forecast.ts. Plazos (tiempo de reposición y margen de seguridad) configurables por modo.

type Resultado = {
  ok: boolean;
  parametros?: ParametrosForecast;
  rows?: ForecastRow[];
  resumen?: ResumenForecast;
  notasDiferenciaTablero?: string[];
  avisoTope?: string;
  error?: string;
} | null;

type Pestana = Modo | "resumen";
const ETIQUETA = ETIQUETA_MODO;
const BADGE: Record<Prioridad, string> = {
  SIN_STOCK: "bg-red-100 text-red-700", URGENTE: "bg-red-100 text-red-700", PRONTO: "bg-amber-100 text-amber-700", OK: "bg-green-100 text-green-700", SIN_DATOS: "bg-gray-100 text-gray-500",
};
const num = (n: number) => Math.round(n).toLocaleString("es-CL");
const desglose = desgloseVentas;

function Spinner() {
  return (
    <svg className="animate-spin h-4 w-4 inline mr-2" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
    </svg>
  );
}

function CampoDias({ etiqueta, valor, min, onChange }: { etiqueta: string; valor: number; min: number; onChange: (n: number) => void }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">{etiqueta}</label>
      <input type="number" min={min} value={valor} onChange={(e) => onChange(Number(e.target.value) || 0)}
        className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm" />
    </div>
  );
}

// resultadoInicial / pestanaInicial: solo para probar el render con datos fijos (sin llamar al endpoint).
// activo: la pestaña está a la vista. El componente queda montado al cambiar de pestaña (conserva plazos y resultado, como cuando el estado vivía en la página)
// y recalcula cada vez que se vuelve a entrar. resultadoInicial / pestanaInicial: solo para probar el render con datos fijos (sin llamar al endpoint).
export default function ForecastPorModo({ activo = true, resultadoInicial, pestanaInicial }: { activo?: boolean; resultadoInicial?: NonNullable<Resultado>; pestanaInicial?: Pestana } = {}) {
  const [leadFull, setLeadFull] = useState(15);
  const [safetyFull, setSafetyFull] = useState(7);
  const [leadNormal, setLeadNormal] = useState(15);
  const [safetyNormal, setSafetyNormal] = useState(7);
  const [cargando, setCargando] = useState(false);
  const [resultado, setResultado] = useState<Resultado>(resultadoInicial ?? null);
  const [pestana, setPestana] = useState<Pestana>(pestanaInicial ?? "full");
  const [filtro, setFiltro] = useState<Prioridad | "TODOS">("TODOS");

  async function cargar() {
    setCargando(true);
    try {
      // leadTimeDays/safetyDays = los de Normal (compatibilidad); los de Full van aparte.
      const qs = new URLSearchParams({
        leadTimeDays: String(leadNormal), safetyDays: String(safetyNormal),
        leadTimeFull: String(leadFull), safetyFull: String(safetyFull),
        leadTimeNormal: String(leadNormal), safetyNormal: String(safetyNormal),
      });
      const res = await fetch(`/api/forecast?${qs}`);
      setResultado(await res.json());
    } catch {
      setResultado({ ok: false, error: "Error de red" });
    } finally {
      setCargando(false);
    }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (activo && !resultadoInicial) cargar(); }, [activo]);

  const rows = resultado?.ok ? (resultado.rows ?? []) : [];
  const porModo = useMemo(() => ({
    full: rows.filter((r) => r.modo === "full"), normal: rows.filter((r) => r.modo === "normal"), sin_clasificar: rows.filter((r) => r.modo === "sin_clasificar"),
  }), [rows]);
  const filasPedido = (m: Modo) => filasParaPedido(rows, m);
  const totalPedido = filasPedido("full").length + filasPedido("normal").length + filasPedido("sin_clasificar").length;

  function descargar() {
    if (!resultado?.ok || !resultado.rows || !resultado.resumen || !resultado.parametros) return;
    const hojas = hojasPedido({ rows: resultado.rows, resumen: resultado.resumen, parametros: resultado.parametros, notas: resultado.notasDiferenciaTablero ?? [], generado: new Date().toLocaleString("es-CL") });
    const libro = libroDesdeHojas(XLSX, hojas);
    XLSX.writeFile(libro, `pedido-sugerido-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  const p = resultado?.parametros;
  const lista = pestana === "resumen" ? [] : porModo[pestana].filter((r) => filtro === "TODOS" || r.prioridad === filtro);
  const plazosDe = (m: Modo) => (m === "full" ? { lead: leadFull, safety: safetyFull } : { lead: leadNormal, safety: safetyNormal });

  if (!activo) return null;

  return (
    <>
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-6 space-y-5">
        <div>
          <h2 className="font-bold text-gray-900 text-lg">Reposición sugerida</h2>
          <p className="text-sm text-gray-500 mt-1">Calcula qué productos pedir según la velocidad de venta de los últimos 30 días, separando Full (stock en bodega de Mercado Libre) de Normal (stock propio).</p>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 items-end">
          <CampoDias etiqueta="Full: tiempo de reposición (días)" valor={leadFull} min={1} onChange={setLeadFull} />
          <CampoDias etiqueta="Full: margen de seguridad (días)" valor={safetyFull} min={0} onChange={setSafetyFull} />
          <CampoDias etiqueta="Normal: tiempo de reposición (días)" valor={leadNormal} min={1} onChange={setLeadNormal} />
          <CampoDias etiqueta="Normal: margen de seguridad (días)" valor={safetyNormal} min={0} onChange={setSafetyNormal} />
          <button onClick={cargar} disabled={cargando} className="font-bold py-2.5 px-4 rounded-xl text-white disabled:opacity-40 disabled:cursor-not-allowed col-span-2 sm:col-span-1" style={{ backgroundColor: "#C41230" }}>
            {cargando ? <><Spinner />Calculando...</> : "Recalcular"}
          </button>
        </div>
        <p className="text-xs text-gray-500">«Sin clasificar» usa los plazos de Normal. Valores por defecto: 15 y 7 días.</p>
      </div>

      {resultado && !resultado.ok && (
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-6"><p className="text-red-600 text-sm">✗ Error: {resultado.error}</p></div>
      )}

      {resultado?.ok && (
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 flex items-center justify-between gap-3">
          <p className="text-sm text-gray-500">
            {totalPedido > 0
              ? `${totalPedido} producto${totalPedido === 1 ? "" : "s"} con reposición pendiente (Full ${filasPedido("full").length} · Normal ${filasPedido("normal").length} · Sin clasificar ${filasPedido("sin_clasificar").length})`
              : "Nada que pedir por ahora"}
          </p>
          <button onClick={descargar} disabled={totalPedido === 0} className="font-bold py-2.5 px-4 rounded-xl text-white disabled:opacity-40 disabled:cursor-not-allowed shrink-0" style={{ backgroundColor: "#0F9D58" }}>
            Descargar lista de pedido
          </button>
        </div>
      )}

      {resultado?.ok && resultado.avisoTope && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-2xl p-4 text-sm text-yellow-800">⚠ {resultado.avisoTope}</div>
      )}

      {resultado?.ok && resultado.resumen && (
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-6 space-y-4">
          <div className="flex gap-1 bg-gray-100 rounded-xl p-1 overflow-x-auto">
            {([["full", `Full (${porModo.full.length})`], ["normal", `Normal (${porModo.normal.length})`], ["sin_clasificar", `Sin clasificar (${porModo.sin_clasificar.length})`], ["resumen", "Resumen"]] as [Pestana, string][]).map(([k, label]) => (
              <button key={k} onClick={() => { setPestana(k); setFiltro("TODOS"); }}
                className={`px-3 py-1.5 rounded-lg text-sm font-semibold whitespace-nowrap ${pestana === k ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"}`}>{label}</button>
            ))}
          </div>

          {pestana === "full" && (
            <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 text-xs text-blue-900 space-y-1">
              <p><b>Full:</b> el stock es el disponible en la bodega de Mercado Libre (no incluye lo no disponible, p. ej. en transferencia). Cobertura: objetivo {plazosDe("full").lead + plazosDe("full").safety} días (Tablero: 30).</p>
              <p>La velocidad no se corrige por días sin stock (el Tablero sí): las cifras pueden diferir del panel «Reposición Full» del Tablero. Detalle en la pestaña Resumen.</p>
            </div>
          )}
          {pestana === "sin_clasificar" && (
            <div className="bg-amber-50 border border-amber-100 rounded-xl p-3 text-xs text-amber-900">
              Publicaciones sin tipo logístico en la hoja (columna T vacía) y sin ventas clasificadas en los últimos 35 días. Se calculan con los plazos de Normal. Se resuelven solas con el próximo sync.
            </div>
          )}

          {pestana !== "resumen" && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                {([["SIN_STOCK", "Sin stock", "#DC2626"], ["URGENTE", "Urgente", "#DC2626"], ["PRONTO", "Pronto", "#D97706"], ["OK", "OK", "#059669"]] as const).map(([k, label, color]) => (
                  <div key={k} className="rounded-2xl border border-gray-200 p-4">
                    <p className="text-sm text-gray-500">{label}</p>
                    <p className="text-2xl font-bold" style={{ color }}>{porModo[pestana].filter((r) => r.prioridad === k).length}</p>
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-gray-800">Detalle por producto — {ETIQUETA[pestana]}</h3>
                <select value={filtro} onChange={(e) => setFiltro(e.target.value as Prioridad | "TODOS")} className="border border-gray-300 rounded-xl px-3 py-1.5 text-sm">
                  <option value="TODOS">Todas las prioridades</option>
                  <option value="SIN_STOCK">Sin stock</option><option value="URGENTE">Urgente</option><option value="PRONTO">Pronto</option><option value="OK">OK</option><option value="SIN_DATOS">Sin datos</option>
                </select>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-500 border-b border-gray-200">
                      <th className="py-2 pr-3">Producto</th><th className="py-2 pr-3">{pestana === "full" ? "Stock Full" : "Stock"}</th><th className="py-2 pr-3">Ventas 30d</th><th className="py-2 pr-3">Vel. diaria</th>
                      <th className="py-2 pr-3">Días rest.</th><th className="py-2 pr-3">Quiebre est.</th><th className="py-2 pr-3">Pedir</th><th className="py-2 pr-3">Prioridad</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lista.map((r) => (
                      <tr key={r.id} className="border-b border-gray-100 last:border-0">
                        <td className="py-2 pr-3 text-gray-800 max-w-xs truncate" title={r.titulo}>
                          {r.titulo}
                          {r.migro && <span className="ml-2 text-xs font-semibold px-2 py-0.5 rounded-full bg-purple-100 text-purple-700" title={`Vendió en el otro modo en los últimos 30 días: ${desglose(r)}`}>migró · {desglose(r)}</span>}
                          {tipoNormalPocoClaro(r) && <span className="ml-2 text-xs font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800" title={notaTipoPocoClaro(r.tipoLogistico)}>tipo: {r.tipoLogistico} · se trata como Normal</span>}
                          {r.fuenteModo === "ultima_venta" && <span className="ml-2 text-xs text-gray-400" title="El modo sale de la última venta clasificada (columna T vacía)">modo por última venta</span>}
                        </td>
                        <td className="py-2 pr-3 text-gray-700">{r.stockActual}</td>
                        <td className="py-2 pr-3 text-gray-700">{r.ventas30d}</td>
                        <td className="py-2 pr-3 text-gray-700">{r.velocidadDiaria}</td>
                        <td className="py-2 pr-3 text-gray-700">{r.diasRestantes ?? "-"}</td>
                        <td className="py-2 pr-3 text-gray-700">{r.fechaQuiebre ?? "-"}</td>
                        <td className="py-2 pr-3 font-semibold text-gray-900">{r.cantidadSugerida || "-"}</td>
                        <td className="py-2 pr-3"><span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${BADGE[r.prioridad]}`}>{r.prioridad}</span></td>
                      </tr>
                    ))}
                    {lista.length === 0 && <tr><td colSpan={8} className="py-4 text-center text-gray-400">Sin productos en esta vista</td></tr>}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {pestana === "resumen" && <ResumenVista resumen={resultado.resumen} parametros={p} notas={resultado.notasDiferenciaTablero ?? []} />}
        </div>
      )}
    </>
  );
}

function ResumenVista({ resumen, parametros, notas }: { resumen: ResumenForecast; parametros?: ParametrosForecast; notas: string[] }) {
  return (
    <div className="space-y-5 text-sm">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="text-left text-gray-500 border-b border-gray-200">
              <th className="py-2 pr-3">Modo</th><th className="py-2 pr-3">Publicaciones</th><th className="py-2 pr-3">Stock (unid.)</th><th className="py-2 pr-3">Ventas 30 d</th>
              <th className="py-2 pr-3">Sugerido total</th><th className="py-2 pr-3">Sin stock</th><th className="py-2 pr-3">Urgente</th><th className="py-2 pr-3">Pronto</th><th className="py-2 pr-3">Plazo</th>
            </tr>
          </thead>
          <tbody>
            {(["full", "normal", "sin_clasificar"] as Modo[]).map((m) => {
              const x = resumen.porModo[m]; const pl = parametros ? (m === "full" ? parametros.full : parametros.normal) : null;
              return (
                <tr key={m} className="border-b border-gray-100 last:border-0">
                  <td className="py-2 pr-3 font-medium text-gray-800">{ETIQUETA[m]}</td><td className="py-2 pr-3">{num(x.publicaciones)}</td><td className="py-2 pr-3">{num(x.stockUnidades)}</td><td className="py-2 pr-3">{num(x.ventas30d)}</td>
                  <td className="py-2 pr-3 font-semibold">{num(x.sugeridoTotal)}</td><td className="py-2 pr-3">{x.porPrioridad.SIN_STOCK}</td><td className="py-2 pr-3">{x.porPrioridad.URGENTE}</td><td className="py-2 pr-3">{x.porPrioridad.PRONTO}</td>
                  <td className="py-2 pr-3 text-gray-500">{pl ? `${pl.lead} + ${pl.safety} = ${pl.lead + pl.safety} d${m === "full" ? " (Tablero: 30)" : ""}` : ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-gray-600">
        <b>Sin clasificar:</b> {resumen.sinClasificar} publicaciones. Modo tomado de la columna T: {resumen.porFuente.publicacion} · de la última venta clasificada: {resumen.porFuente.ultima_venta} · sin dato: {resumen.porFuente.ninguna}.
      </p>
      <div>
        <h4 className="font-semibold text-gray-800 mb-1">SKU en Full y en Normal ({resumen.skusEnAmbosModos.length})</h4>
        {resumen.skusEnAmbosModos.length === 0 ? <p className="text-gray-400">Ninguno.</p> : (
          <ul className="space-y-1 text-gray-700">{resumen.skusEnAmbosModos.map((x) => <li key={x.sku}><b>{x.sku}</b> — Full: {x.full.join(", ")} · Normal: {x.normal.join(", ")}</li>)}</ul>
        )}
      </div>
      <div>
        <h4 className="font-semibold text-gray-800 mb-1">Publicaciones que migraron de modo ({resumen.migraron.length})</h4>
        <p className="text-xs text-gray-500 mb-1">Vendieron en el modo contrario al actual en los últimos 30 días. Su demanda es la total (suma de ambos modos).</p>
        {resumen.migraron.length === 0 ? <p className="text-gray-400">Ninguna.</p> : (
          <ul className="space-y-1 text-gray-700">{resumen.migraron.map((x) => <li key={x.id}>{x.titulo} <span className="text-gray-400">({x.id})</span> — ahora {ETIQUETA[x.modo]} · {desglose({ ventasFull30d: x.full, ventasNormal30d: x.normal, ventasSinTipo30d: x.sinTipo })}</li>)}</ul>
        )}
      </div>
      {resumen.tipoPocoClaro.length > 0 && (
        <div>
          <h4 className="font-semibold text-gray-800 mb-1">Normal por un tipo logístico poco claro ({resumen.tipoPocoClaro.length})</h4>
          <p className="text-xs text-gray-500 mb-1">ML informa un logistic_type que no es de los habituales; se trata como Normal.</p>
          <ul className="space-y-1 text-gray-700">{resumen.tipoPocoClaro.map((x) => <li key={x.id}>{x.titulo} <span className="text-gray-400">({x.id})</span> — {x.tipo}</li>)}</ul>
        </div>
      )}
      <div>
        <h4 className="font-semibold text-gray-800 mb-1">Diferencias con el panel «Reposición Full» del Tablero</h4>
        <ul className="list-disc pl-5 space-y-1 text-gray-600">{notas.map((n, i) => <li key={i}>{n}</li>)}</ul>
      </div>
    </div>
  );
}

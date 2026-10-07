"use client";

import { useEffect, useState } from "react";

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
};
type TableroApi = {
  ok: boolean;
  error?: string;
  generadoEn?: string;
  ventana?: { desde: string; hasta: string; dias: number };
  resumen?: { actual: Resumen; anterior: Resumen; variaciones: { ingresos: Variacion; unidades: Variacion; ordenes: Variacion; ticket: Variacion } };
  confianza?: Confianza;
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
                detalle={`Con Costo ${c.costo.pct}% (automático ${c.costo.auto}%, manual ${c.costo.manual}%). En revisión (sin escribir): ${c.costo.enRevision}%. Sin Costo ni propuesta: ${(c.costo.sinCosto - c.costo.enRevision).toFixed(1)}%.`} />
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
    </div>
  );
}

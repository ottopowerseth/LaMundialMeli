"use client";

import { useState } from "react";

// ACoS real, ACoS de equilibrio y TACoS de Product Ads, al final del Tablero.
// A PEDIDO (~10 s) y de solo lectura: no sugiere acciones; solo rotula cada
// anuncio como "sobre" o "bajo" el equilibrio. Ver lib/publicidad-equilibrio.ts
// (definiciones y verificación de la base de IVA contra Billing). El resultado
// de cada ventana queda en una variable de módulo para no repetir la consulta
// al cambiar de pestaña.

type Posicion = "sobre" | "bajo" | null;
type Fila = {
  id: string; titulo: string; full: boolean | null; estadoAd: string; campaignId: number; campana: string;
  gastoSinIva: number; gastoConIva: number; atribuidas: number; acosMl: number | null; acosConIva: number | null;
  equilibrio: number | null; diferenciaPts: number | null; posicion: Posicion;
  equilibrioSiMayorNeto: number | null; posicionSiMayorNeto: Posicion;
  ventasTotales: number; tacosConIva: number | null; margenTrasPublicidad: number | null; envioEstimado: boolean; motivoSinEquilibrio: string | null;
};
type Campana = {
  id: number; nombre: string; estado: string; estrategia: string; acosTarget: number | null; presupuestoDiario: number | null;
  gastoSinIva: number; gastoConIva: number; atribuidas: number; organicas: number; acosMl: number | null; acosConIva: number | null;
  equilibrio: number | null; equilibrioSiMayorNeto: number | null; coberturaEquilibrioPct: number; tacosConIva: number | null; anunciosConGasto: number;
};
type Sobre = { anuncios: number; gastoConIva: number; pctGasto: number | null; evaluables: number };
type Datos = {
  ok: boolean; error?: string; generadoEn: string;
  ventana: { dias: number; dateFrom: string; dateTo: string };
  calidadMargen: { coberturaCostoPct: number; envioEstimadoPctIngreso: number; margenTotalPct: number | null };
  resumen: {
    gasto: { sinIva: number; conIva: number }; atribuidas: number; acosMl: number | null; acosConIva: number | null;
    equilibrio: number | null; equilibrioSiMayorNeto: number | null; coberturaEquilibrioPct: number;
    tacosCuenta: number | null; ventasCuenta: number; margenAntes: number | null; margenDespues: number | null;
    sobreEquilibrio: Sobre; sobreEquilibrioSiMayorNeto: Sobre; anunciosActivosSinGasto: { total: number; conVentasOrganicas: number };
  };
  campanas: Campana[]; filas: Fila[];
};

const cache = new Map<number, Datos>();

const clp = (n: number) => "$" + Math.round(n).toLocaleString("es-CL");
const pc = (n: number | null) => (n === null ? "—" : `${n.toFixed(1).replace(".", ",")}%`);
const pts = (n: number | null) => (n === null ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(1).replace(".", ",")} pts`);
const link = (id: string) => `https://articulo.mercadolibre.cl/${id.replace("MLC", "MLC-")}`;

// Sin verbos ni acciones: solo la posición del ACoS con IVA frente al equilibrio.
function Posicion({ p }: { p: Posicion }) {
  if (p === null) return <span className="text-gray-300">—</span>;
  return <span className={`rounded px-1.5 py-0.5 whitespace-nowrap ${p === "sobre" ? "bg-amber-50 text-amber-800" : "bg-slate-100 text-slate-600"}`}>{p === "sobre" ? "sobre el equilibrio" : "bajo el equilibrio"}</span>;
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

export default function Publicidad() {
  const [dias, setDias] = useState<7 | 30 | 90>(30);
  const [datos, setDatos] = useState<Datos | null>(cache.get(30) ?? null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sensibilidad, setSensibilidad] = useState(false);

  function elegir(d: 7 | 30 | 90) {
    setDias(d);
    setDatos(cache.get(d) ?? null);
    setError(null);
  }

  async function calcular() {
    setCargando(true);
    setError(null);
    try {
      const r = await fetch(`/api/publicidad?dias=${dias}`);
      const d = (await r.json()) as Datos;
      if (!d.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      cache.set(dias, d);
      setDatos(d);
    } catch (e) {
      setError(String(e));
    } finally {
      setCargando(false);
    }
  }

  const r = datos?.resumen;
  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-bold text-gray-900">Publicidad: ACoS real, ACoS de equilibrio y TACoS (Product Ads)</h3>
          <p className="text-xs text-gray-400 mt-1">Solo lectura y a pedido (~10 s). Muestra dónde está cada ACoS frente al equilibrio; no sugiere acciones.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden text-sm">
            {([7, 30, 90] as const).map((d) => (
              <button key={d} onClick={() => elegir(d)} className={`px-3 py-1.5 ${dias === d ? "bg-gray-900 text-white" : "bg-white text-gray-700 hover:bg-gray-50"}`}>{d} días</button>
            ))}
          </div>
          <button onClick={calcular} disabled={cargando} className="px-4 py-2 rounded-lg bg-gray-900 text-white text-sm disabled:opacity-50">
            {cargando ? "Calculando…" : datos ? "Actualizar" : "Calcular (~10 s)"}
          </button>
        </div>
      </div>
      {dias === 7 && <p className="text-xs text-amber-700">Con 7 días el ACoS es ruidoso: pocas ventas atribuidas por anuncio, y un par de ventas más o menos lo mueve mucho.</p>}

      <div className="rounded-xl bg-amber-50 border border-amber-200 p-3 text-xs text-amber-900 space-y-1">
        <p><b>El equilibrio es estimado.</b> Depende de la base de IVA del Mayor (Costo) y del Costo de Katteyes, ambos pendientes de confirmar.</p>
        <p>El equilibrio compara solo ventas atribuidas a la campaña; no incluye el efecto de la publicidad sobre las ventas orgánicas ni el ranking.</p>
        <p>ML reporta el gasto sin IVA y Billing lo cobra con IVA (verificado contra Billing). Por eso se muestran ambos, y el ACoS &laquo;con IVA&raquo; (× 1,19) es el comparable con el margen.</p>
      </div>

      {error && <p className="text-sm text-red-700">No se pudo calcular: {error}</p>}
      {!datos && !cargando && !error && <p className="text-sm text-gray-500">Aún no calculado para {dias} días. Pulsa el botón para consultar Product Ads.</p>}

      {datos && r && (
        <>
          <p className="text-xs text-gray-400">
            Ventana {datos.ventana.dateFrom} → {datos.ventana.dateTo} ({datos.ventana.dias} días) · calculado {new Date(datos.generadoEn).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })} ·
            Costo en {pc(datos.calidadMargen.coberturaCostoPct)} de las ventas · envío estimado en {pc(datos.calidadMargen.envioEstimadoPctIngreso)} de las ventas con margen
          </p>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Tarjeta titulo="Gasto en publicidad" principal={`${clp(r.gasto.sinIva)} sin IVA`} l2={`${clp(r.gasto.conIva)} con IVA (lo que cobra Billing)`} l3={`ventas atribuidas ${clp(r.atribuidas)}`} />
            <Tarjeta titulo="ACoS: ML → con IVA (× 1,19)" principal={`${pc(r.acosMl)} → ${pc(r.acosConIva)}`} l2="ACoS de ML = gasto sin IVA / ventas atribuidas" />
            <Tarjeta titulo="ACoS de equilibrio (margen antes de publicidad)" principal={pc(r.equilibrio)} l2={`ponderado por ventas atribuidas · cobertura ${pc(r.coberturaEquilibrioPct)}`}
              l3={`${r.sobreEquilibrio.anuncios} de ${r.sobreEquilibrio.evaluables} anuncios con ACoS sobre el equilibrio`} />
            <Tarjeta titulo="TACoS de la cuenta (con IVA)" principal={pc(r.tacosCuenta)} l2={`sobre ventas totales ${clp(r.ventasCuenta)}`}
              l3={`margen ${pc(r.margenAntes)} → ≈ ${pc(r.margenDespues)} después de publicidad (aprox.)`} />
          </div>

          <p className="text-xs text-gray-600 bg-gray-50 rounded-lg p-2">
            <b>Sensibilidad informativa — si el Mayor fuera neto:</b> el equilibrio ponderado sería {pc(r.equilibrioSiMayorNeto)} (hoy {pc(r.equilibrio)}) y {r.sobreEquilibrioSiMayorNeto.anuncios} de {r.sobreEquilibrioSiMayorNeto.evaluables} anuncios
            quedarían con ACoS sobre el equilibrio (hoy {r.sobreEquilibrio.anuncios} de {r.sobreEquilibrio.evaluables}).
          </p>
          <p className="text-xs text-gray-600">
            Anuncios activos sin gasto en la ventana: <b>{r.anunciosActivosSinGasto.total}</b>; de ellos <b>{r.anunciosActivosSinGasto.conVentasOrganicas}</b> vendieron orgánico (unidades orgánicas que informa ML).
            Abajo solo se listan los anuncios con gasto.
          </p>

          <h4 className="font-semibold text-gray-900">Por campaña</h4>
          <div className="overflow-x-auto rounded-xl border border-gray-200">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-left text-gray-500 uppercase tracking-wide">
                  <th className="px-2 py-2">Campaña</th><th className="px-2 py-2 text-right">acos_target ML</th>
                  <th className="px-2 py-2 text-right">Gasto sin IVA</th><th className="px-2 py-2 text-right">Gasto con IVA</th><th className="px-2 py-2 text-right">Ventas atribuidas</th>
                  <th className="px-2 py-2 text-right">ACoS ML</th><th className="px-2 py-2 text-right">ACoS con IVA</th><th className="px-2 py-2 text-right">ACoS de equilibrio</th>
                  <th className="px-2 py-2 text-right" title="Gasto con IVA / (ventas atribuidas + ventas orgánicas que informa ML)">TACoS campaña</th><th className="px-2 py-2 text-right">Anuncios con gasto</th>
                  {sensibilidad && <th className="px-2 py-2 text-right bg-gray-100">Equilibrio si el Mayor fuera neto</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {datos.campanas.map((c) => (
                  <tr key={c.id} className="align-top">
                    <td className="px-2 py-2"><div className="font-medium text-gray-900">{c.nombre}</div><div className="text-gray-400">{c.estado} · {c.estrategia}</div></td>
                    <td className="px-2 py-2 text-right text-gray-600">{c.acosTarget === null ? "—" : pc(c.acosTarget)}</td>
                    <td className="px-2 py-2 text-right whitespace-nowrap">{clp(c.gastoSinIva)}</td><td className="px-2 py-2 text-right whitespace-nowrap">{clp(c.gastoConIva)}</td>
                    <td className="px-2 py-2 text-right whitespace-nowrap">{clp(c.atribuidas)}</td>
                    <td className="px-2 py-2 text-right">{pc(c.acosMl)}</td><td className="px-2 py-2 text-right font-semibold">{pc(c.acosConIva)}</td>
                    <td className="px-2 py-2 text-right" title={`Margen ponderado por ventas atribuidas; cubre ${pc(c.coberturaEquilibrioPct)} de ellas (solo publicaciones con Costo)`}>{pc(c.equilibrio)}</td>
                    <td className="px-2 py-2 text-right">{pc(c.tacosConIva)}</td><td className="px-2 py-2 text-right">{c.anunciosConGasto}</td>
                    {sensibilidad && <td className="px-2 py-2 text-right bg-gray-50 text-gray-600">{pc(c.equilibrioSiMayorNeto)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="font-semibold text-gray-900">Por publicación (anuncios con gasto en la ventana)</h4>
            <button onClick={() => setSensibilidad((s) => !s)} className="text-xs text-gray-700 underline">
              {sensibilidad ? "Ocultar" : "Mostrar"} sensibilidad: equilibrio si el Mayor fuera neto (informativa)
            </button>
          </div>
          <div className="overflow-x-auto rounded-xl border border-gray-200">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-left text-gray-500 uppercase tracking-wide">
                  <th className="px-2 py-2">Publicación / campaña</th>
                  <th className="px-1.5 py-2 text-right">Gasto sin / con IVA</th><th className="px-1.5 py-2 text-right">Ventas atrib.</th>
                  <th className="px-1.5 py-2 text-right">ACoS ML</th><th className="px-1.5 py-2 text-right">ACoS con IVA</th>
                  <th className="px-1.5 py-2 text-right">ACoS de equilibrio y posición</th>
                  <th className="px-2 py-2 text-right">Ventas totales</th><th className="px-2 py-2 text-right">TACoS con IVA</th><th className="px-2 py-2 text-right" title="Margen antes de publicidad − TACoS con IVA, sobre las ventas totales de la publicación">Margen tras publicidad</th>
                  {sensibilidad && <th className="px-2 py-2 text-right bg-gray-100">Equilibrio y posición si el Mayor fuera neto</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {datos.filas.map((f) => (
                  <tr key={f.id} className="align-top">
                    <td className="px-2 py-2">
                      <a href={link(f.id)} target="_blank" rel="noopener noreferrer" className="font-mono text-blue-700 hover:underline whitespace-nowrap">{f.id} ↗</a>
                      <div className="text-gray-700 max-w-[9rem] truncate" title={f.titulo}>{f.titulo}</div>
                      {f.full !== null && <span className={`rounded-md px-1.5 py-0.5 ${f.full ? "bg-blue-50 text-blue-700" : "bg-gray-100 text-gray-600"}`}>{f.full ? "Full" : "Estándar"}</span>}
                      <div className="text-gray-400 mt-0.5">{f.campana} · {f.estadoAd}</div>
                    </td>
                    <td className="px-1.5 py-2 text-right whitespace-nowrap"><div className="text-gray-500">{clp(f.gastoSinIva)}</div><div className="font-semibold">{clp(f.gastoConIva)}</div></td>
                    <td className="px-2 py-2 text-right whitespace-nowrap">{clp(f.atribuidas)}</td>
                    <td className="px-2 py-2 text-right">{pc(f.acosMl)}</td><td className="px-2 py-2 text-right font-semibold">{pc(f.acosConIva)}</td>
                    <td className="px-2 py-2 text-right whitespace-nowrap" title={f.motivoSinEquilibrio ?? (f.envioEstimado ? "Envío estimado: menos fiable" : "Margen de contribución antes de publicidad")}>
                      {pc(f.equilibrio)}{f.envioEstimado && <span className="ml-1 text-amber-600">est.</span>}
                      {f.diferenciaPts !== null && <div className="text-gray-400">{pts(f.diferenciaPts)}</div>}
                      {f.equilibrio === null && f.motivoSinEquilibrio && <div className="text-gray-400">{f.motivoSinEquilibrio.split(" (")[0]}</div>}
                      {f.posicion !== null && <div className="mt-1"><Posicion p={f.posicion} /></div>}
                    </td>
                    <td className="px-2 py-2 text-right whitespace-nowrap">{clp(f.ventasTotales)}</td><td className="px-2 py-2 text-right">{pc(f.tacosConIva)}</td>
                    <td className="px-2 py-2 text-right">{pc(f.margenTrasPublicidad)}</td>
                    {sensibilidad && <td className="px-2 py-2 text-right bg-gray-50 text-gray-600">{pc(f.equilibrioSiMayorNeto)}{f.posicionSiMayorNeto !== null && <div className="mt-1"><Posicion p={f.posicionSiMayorNeto} /></div>}</td>}
                  </tr>
                ))}
                {datos.filas.length === 0 && <tr><td colSpan={sensibilidad ? 10 : 9} className="px-3 py-6 text-center text-gray-400">Ningún anuncio tuvo gasto en esta ventana.</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-gray-400">
            &laquo;Sobre el equilibrio&raquo; = el ACoS con IVA es mayor que el margen de contribución antes de publicidad de la publicación (&laquo;bajo&raquo; = menor o igual). El margen y el equilibrio usan el Costo como Mayor con IVA (pendiente de confirmar) y la comisión real cobrada.
          </p>
        </>
      )}
    </div>
  );
}

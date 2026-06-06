"use client";

import { useEffect, useState } from "react";
import Image from "next/image";

type MLStatus = { ok: boolean; nickname?: string } | null;

type StockChange = { titulo: string; antes: number; despues: number; diferencia: number };
type VentaNueva = { titulo: string; cantidad: number; total: number; comprador: string; fecha: string };
type SyncResult = {
  ok: boolean;
  publicaciones?: number;
  ventas?: number;
  cambiosStock?: StockChange[];
  ventasNuevas?: VentaNueva[];
  timestamp?: string;
  error?: string;
} | null;

type ProductoEliminado = { id: string; titulo: string; fila: number };
type DeletedResult = {
  ok: boolean;
  eliminados?: number;
  productos?: ProductoEliminado[];
  error?: string;
} | null;

function Spinner() {
  return (
    <svg className="animate-spin h-4 w-4 inline mr-2" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
    </svg>
  );
}

export default function Home() {
  const [mlStatus, setMlStatus] = useState<MLStatus>(null);
  const [syncing, setSyncing] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult>(null);
  const [deletedResult, setDeletedResult] = useState<DeletedResult>(null);
  const [borrandoFilas, setBorrandoFilas] = useState<number[]>([]);
  const [seleccionados, setSeleccionados] = useState<number[]>([]);

  useEffect(() => {
    fetch("/api/status").then(r => r.json()).then(setMlStatus).catch(() => setMlStatus({ ok: false }));
  }, []);

  async function handleSync() {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch("/api/ml-sync", { method: "POST" });
      setSyncResult(await res.json());
    } catch {
      setSyncResult({ ok: false, error: "Error de red" });
    } finally {
      setSyncing(false);
    }
  }

  async function handleDetectDeleted() {
    setDetecting(true);
    setDeletedResult(null);
    setSeleccionados([]);
    try {
      const res = await fetch("/api/detect-deleted", { method: "POST" });
      setSyncResult(null);
      setDeletedResult(await res.json());
    } catch {
      setDeletedResult({ ok: false, error: "Error de red" });
    } finally {
      setDetecting(false);
    }
  }

  async function borrarDelSheet(filas: number[]) {
    setBorrandoFilas(filas);
    try {
      await fetch("/api/delete-from-sheet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filas }),
      });
      // Remover del log local
      setDeletedResult(prev =>
        prev ? { ...prev, productos: prev.productos?.filter(p => !filas.includes(p.fila)) } : prev
      );
      setSeleccionados([]);
    } finally {
      setBorrandoFilas([]);
    }
  }

  function toggleSeleccion(fila: number) {
    setSeleccionados(prev => prev.includes(fila) ? prev.filter(f => f !== fila) : [...prev, fila]);
  }

  const productosRestantes = deletedResult?.productos ?? [];

  return (
    <main className="min-h-screen" style={{ backgroundColor: "#f5f5f5" }}>

      {/* Header */}
      <div style={{ backgroundColor: "#C41230" }} className="px-8 py-5 shadow-md">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Image src="/logo.png" alt="La Mundial" width={80} height={80} className="object-contain rounded-lg bg-white p-1" />
            <div>
              <h1 className="text-xl font-bold text-white tracking-wide">ML Tracker</h1>
              <p className="text-red-200 text-sm">Panel de Mercado Libre</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className={`w-2.5 h-2.5 rounded-full ${mlStatus === null ? "bg-gray-300" : mlStatus.ok ? "bg-green-400" : "bg-red-300"}`} />
            <span className="text-white text-sm">
              {mlStatus === null ? "Conectando..." : mlStatus.ok ? mlStatus.nickname : "Sin conexión"}
            </span>
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-6 py-8 space-y-5">

        {/* Botones */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-4">
            <div>
              <h2 className="font-bold text-gray-900 text-lg">Actualizar publicaciones</h2>
              <p className="text-sm text-gray-500 mt-1">Sincroniza stock, precios y ventas desde ML hacia Google Sheets.</p>
            </div>
            <button onClick={handleSync} disabled={syncing || !mlStatus?.ok}
              className="w-full font-bold py-3 px-4 rounded-xl text-white disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ backgroundColor: "#C41230" }}>
              {syncing ? <><Spinner />Sincronizando...</> : "Actualizar ahora"}
            </button>
          </div>

          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-4">
            <div>
              <h2 className="font-bold text-gray-900 text-lg">Detectar eliminados</h2>
              <p className="text-sm text-gray-500 mt-1">Detecta productos que ya no existen en ML y los marca en el Sheet.</p>
            </div>
            <button onClick={handleDetectDeleted} disabled={detecting || !mlStatus?.ok}
              className="w-full bg-gray-900 hover:bg-black disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold py-3 px-4 rounded-xl">
              {detecting ? <><Spinner />Detectando...</> : "Detectar eliminados"}
            </button>
          </div>
        </div>

        {/* Log de sync */}
        {syncResult && (
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-4">
            <h2 className="font-bold text-gray-900 text-lg">Log de sincronización</h2>

            {!syncResult.ok ? (
              <p className="text-red-600 text-sm">✗ Error: {syncResult.error}</p>
            ) : (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  <div className="bg-gray-50 rounded-xl p-3 text-center">
                    <p className="text-2xl font-bold text-gray-900">{syncResult.publicaciones}</p>
                    <p className="text-xs text-gray-500 mt-1">Publicaciones</p>
                  </div>
                  <div className="bg-gray-50 rounded-xl p-3 text-center">
                    <p className="text-2xl font-bold text-gray-900">{syncResult.ventas}</p>
                    <p className="text-xs text-gray-500 mt-1">Ventas totales</p>
                  </div>
                  <div className="bg-gray-50 rounded-xl p-3 text-center">
                    <p className="text-2xl font-bold text-gray-900">{syncResult.ventasNuevas?.length ?? 0}</p>
                    <p className="text-xs text-gray-500 mt-1">Ventas últimas 24h</p>
                  </div>
                </div>

                {/* Cambios de stock */}
                {(syncResult.cambiosStock?.length ?? 0) > 0 && (
                  <div>
                    <h3 className="font-semibold text-gray-800 mb-2">Cambios de stock ({syncResult.cambiosStock!.length})</h3>
                    <div className="space-y-1 max-h-48 overflow-y-auto">
                      {syncResult.cambiosStock!.map((c, i) => (
                        <div key={i} className="flex items-center justify-between text-sm bg-gray-50 rounded-lg px-3 py-2">
                          <span className="text-gray-700 truncate flex-1 mr-3">{c.titulo}</span>
                          <span className="text-gray-400 mr-2">{c.antes} → {c.despues}</span>
                          <span className={`font-bold ${c.diferencia > 0 ? "text-green-600" : "text-red-600"}`}>
                            {c.diferencia > 0 ? `+${c.diferencia}` : c.diferencia}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Ventas últimas 24h */}
                {(syncResult.ventasNuevas?.length ?? 0) > 0 && (
                  <div>
                    <h3 className="font-semibold text-gray-800 mb-2">Ventas últimas 24h</h3>
                    <div className="space-y-1 max-h-48 overflow-y-auto">
                      {syncResult.ventasNuevas!.map((v, i) => (
                        <div key={i} className="text-sm bg-gray-50 rounded-lg px-3 py-2">
                          <div className="flex justify-between">
                            <span className="text-gray-700 truncate flex-1 mr-3">{v.titulo}</span>
                            <span className="font-semibold text-gray-900">${Number(v.total).toLocaleString("es-CL")}</span>
                          </div>
                          <div className="text-gray-400 mt-0.5">Cant: {v.cantidad} · {v.comprador} · {v.fecha}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <p className="text-xs text-gray-400">Actualizado: {syncResult.timestamp ? new Date(syncResult.timestamp).toLocaleString("es-CL") : "-"}</p>
              </>
            )}
          </div>
        )}

        {/* Log de eliminados */}
        {deletedResult && (
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-4">
            <h2 className="font-bold text-gray-900 text-lg">Productos eliminados de ML</h2>

            {!deletedResult.ok ? (
              <p className="text-red-600 text-sm">✗ Error: {deletedResult.error}</p>
            ) : productosRestantes.length === 0 ? (
              <p className="text-green-600 text-sm">✓ No hay productos eliminados pendientes</p>
            ) : (
              <>
                <p className="text-sm text-gray-500">{productosRestantes.length} producto(s) marcados como ELIMINADA en el Sheet. Selecciona los que quieres borrar definitivamente.</p>

                {/* Acciones bulk */}
                <div className="flex gap-2 flex-wrap">
                  <button onClick={() => setSeleccionados(productosRestantes.map(p => p.fila))}
                    className="text-sm px-3 py-1.5 rounded-lg border border-gray-300 hover:bg-gray-50">
                    Seleccionar todos
                  </button>
                  <button onClick={() => setSeleccionados([])}
                    className="text-sm px-3 py-1.5 rounded-lg border border-gray-300 hover:bg-gray-50">
                    Deseleccionar
                  </button>
                  {seleccionados.length > 0 && (
                    <button onClick={() => borrarDelSheet(seleccionados)}
                      disabled={borrandoFilas.length > 0}
                      className="text-sm px-3 py-1.5 rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50">
                      {borrandoFilas.length > 0 ? "Borrando..." : `Borrar seleccionados (${seleccionados.length})`}
                    </button>
                  )}
                </div>

                {/* Lista de productos */}
                <div className="space-y-1 max-h-64 overflow-y-auto">
                  {productosRestantes.map((p) => (
                    <div key={p.id} className={`flex items-center gap-3 text-sm rounded-lg px-3 py-2.5 cursor-pointer transition-colors ${seleccionados.includes(p.fila) ? "bg-red-50 border border-red-200" : "bg-gray-50 hover:bg-gray-100"}`}
                      onClick={() => toggleSeleccion(p.fila)}>
                      <input type="checkbox" checked={seleccionados.includes(p.fila)} onChange={() => toggleSeleccion(p.fila)}
                        className="accent-red-600" onClick={e => e.stopPropagation()} />
                      <div className="flex-1 min-w-0">
                        <p className="text-gray-800 truncate font-medium">{p.titulo}</p>
                        <p className="text-gray-400 text-xs">{p.id}</p>
                      </div>
                      <button onClick={(e) => { e.stopPropagation(); borrarDelSheet([p.fila]); }}
                        disabled={borrandoFilas.includes(p.fila)}
                        className="text-xs px-2 py-1 rounded bg-red-100 text-red-700 hover:bg-red-200 disabled:opacity-50 shrink-0">
                        Borrar
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* Link al Sheet */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 flex items-center justify-between">
          <div>
            <p className="font-bold text-gray-900">Google Sheets</p>
            <p className="text-sm text-gray-500">Ver publicaciones y ventas sincronizadas</p>
          </div>
          <a href="https://docs.google.com/spreadsheets/d/14mb2PAwr-xvy_syr-cpXdBWcUx0Nni8byQx6YX03xDM"
            target="_blank" rel="noopener noreferrer"
            className="text-white font-bold py-2.5 px-5 rounded-xl text-sm"
            style={{ backgroundColor: "#0F9D58" }}>
            Abrir Sheet →
          </a>
        </div>

      </div>
    </main>
  );
}

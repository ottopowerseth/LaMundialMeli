"use client";

import { useEffect, useState } from "react";

type MLStatus = { ok: boolean; nickname?: string; id?: string } | null;
type SyncResult = { ok: boolean; publicaciones?: number; ventas?: number; timestamp?: string; error?: string } | null;
type DeletedResult = { ok: boolean; eliminados?: number; ids?: string[]; error?: string } | null;

export default function Home() {
  const [mlStatus, setMlStatus] = useState<MLStatus>(null);
  const [syncing, setSyncing] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult>(null);
  const [deletedResult, setDeletedResult] = useState<DeletedResult>(null);

  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then(setMlStatus)
      .catch(() => setMlStatus({ ok: false }));
  }, []);

  async function handleSync() {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch("/api/ml-sync", { method: "POST" });
      const data = await res.json();
      setSyncResult(data);
    } catch {
      setSyncResult({ ok: false, error: "Error de red" });
    } finally {
      setSyncing(false);
    }
  }

  async function handleDetectDeleted() {
    setDetecting(true);
    setDeletedResult(null);
    try {
      const res = await fetch("/api/detect-deleted", { method: "POST" });
      const data = await res.json();
      setDeletedResult(data);
    } catch {
      setDeletedResult({ ok: false, error: "Error de red" });
    } finally {
      setDetecting(false);
    }
  }

  return (
    <main className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-yellow-400 px-8 py-6 shadow">
        <h1 className="text-2xl font-bold text-gray-900">ML Tracker</h1>
        <p className="text-gray-700 text-sm mt-1">La Mundial — Panel de Mercado Libre</p>
      </div>

      <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">

        {/* Estado de conexión */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 flex items-center gap-4">
          <div className={`w-3 h-3 rounded-full ${mlStatus === null ? "bg-gray-300" : mlStatus.ok ? "bg-green-500" : "bg-red-500"}`} />
          <div>
            <p className="font-semibold text-gray-800">Mercado Libre</p>
            {mlStatus === null && <p className="text-sm text-gray-400">Verificando conexión...</p>}
            {mlStatus?.ok && <p className="text-sm text-gray-600">Conectado como <span className="font-medium">{mlStatus.nickname}</span></p>}
            {mlStatus && !mlStatus.ok && <p className="text-sm text-red-500">Sin conexión — verificar token</p>}
          </div>
        </div>

        {/* Botones de acción */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

          {/* Actualizar stock */}
          <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
            <div>
              <h2 className="font-semibold text-gray-800">Actualizar publicaciones</h2>
              <p className="text-sm text-gray-500 mt-1">Sincroniza stock, precios y ventas desde ML hacia Google Sheets.</p>
            </div>
            <button
              onClick={handleSync}
              disabled={syncing || !mlStatus?.ok}
              className="w-full bg-yellow-400 hover:bg-yellow-500 disabled:opacity-50 disabled:cursor-not-allowed text-gray-900 font-semibold py-2.5 px-4 rounded-lg transition-colors"
            >
              {syncing ? "Sincronizando..." : "Actualizar ahora"}
            </button>
            {syncResult && (
              <div className={`text-sm rounded-lg px-3 py-2 ${syncResult.ok ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>
                {syncResult.ok
                  ? `✓ ${syncResult.publicaciones} publicaciones y ${syncResult.ventas} ventas actualizadas`
                  : `✗ Error: ${syncResult.error}`}
              </div>
            )}
          </div>

          {/* Detectar eliminados */}
          <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
            <div>
              <h2 className="font-semibold text-gray-800">Detectar eliminados</h2>
              <p className="text-sm text-gray-500 mt-1">Detecta productos que ya no existen en ML y los marca en el Sheet.</p>
            </div>
            <button
              onClick={handleDetectDeleted}
              disabled={detecting || !mlStatus?.ok}
              className="w-full bg-gray-800 hover:bg-gray-900 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-2.5 px-4 rounded-lg transition-colors"
            >
              {detecting ? "Detectando..." : "Detectar eliminados"}
            </button>
            {deletedResult && (
              <div className={`text-sm rounded-lg px-3 py-2 ${deletedResult.ok ? "bg-blue-50 text-blue-700" : "bg-red-50 text-red-700"}`}>
                {deletedResult.ok
                  ? deletedResult.eliminados === 0
                    ? "✓ No hay productos eliminados"
                    : `⚠ ${deletedResult.eliminados} producto(s) marcados como ELIMINADA en el Sheet`
                  : `✗ Error: ${deletedResult.error}`}
              </div>
            )}
          </div>
        </div>

        {/* Link al Sheet */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 flex items-center justify-between">
          <div>
            <p className="font-semibold text-gray-800">Google Sheets</p>
            <p className="text-sm text-gray-500">Ver datos sincronizados</p>
          </div>
          <a
            href={`https://docs.google.com/spreadsheets/d/${process.env.NEXT_PUBLIC_GOOGLE_SHEET_ID ?? "14mb2PAwr-xvy_syr-cpXdBWcUx0Nni8byQx6YX03xDM"}`}
            target="_blank"
            rel="noopener noreferrer"
            className="bg-green-600 hover:bg-green-700 text-white font-semibold py-2 px-4 rounded-lg text-sm transition-colors"
          >
            Abrir Sheet →
          </a>
        </div>

      </div>
    </main>
  );
}

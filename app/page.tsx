"use client";

import { useEffect, useState } from "react";
import Image from "next/image";

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
    <main className="min-h-screen" style={{ backgroundColor: "#f5f5f5" }}>

      {/* Header */}
      <div style={{ backgroundColor: "#C41230" }} className="px-8 py-5 shadow-md">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Image
              src="/logo.png"
              alt="La Mundial Perfumeria"
              width={80}
              height={80}
              className="object-contain rounded-lg bg-white p-1"
            />
            <div>
              <h1 className="text-xl font-bold text-white tracking-wide">ML Tracker</h1>
              <p className="text-red-200 text-sm">Panel de Mercado Libre</p>
            </div>
          </div>
          {/* Estado de conexión en el header */}
          <div className="flex items-center gap-2">
            <div className={`w-2.5 h-2.5 rounded-full ${mlStatus === null ? "bg-gray-300" : mlStatus.ok ? "bg-green-400" : "bg-red-300"}`} />
            <span className="text-white text-sm">
              {mlStatus === null
                ? "Conectando..."
                : mlStatus.ok
                ? mlStatus.nickname
                : "Sin conexión"}
            </span>
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-6 py-8 space-y-5">

        {/* Botones de acción */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">

          {/* Actualizar stock */}
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-4">
            <div>
              <h2 className="font-bold text-gray-900 text-lg">Actualizar publicaciones</h2>
              <p className="text-sm text-gray-500 mt-1">Sincroniza stock, precios y ventas desde ML hacia Google Sheets.</p>
            </div>
            <button
              onClick={handleSync}
              disabled={syncing || !mlStatus?.ok}
              className="w-full font-bold py-3 px-4 rounded-xl transition-all text-white disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ backgroundColor: syncing ? "#9b1025" : "#C41230" }}
            >
              {syncing ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                  </svg>
                  Sincronizando...
                </span>
              ) : "Actualizar ahora"}
            </button>
            {syncResult && (
              <div className={`text-sm rounded-xl px-4 py-3 ${syncResult.ok ? "bg-green-50 text-green-700 border border-green-200" : "bg-red-50 text-red-700 border border-red-200"}`}>
                {syncResult.ok
                  ? `✓ ${syncResult.publicaciones} publicaciones y ${syncResult.ventas} ventas actualizadas`
                  : `✗ Error: ${syncResult.error}`}
              </div>
            )}
          </div>

          {/* Detectar eliminados */}
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-4">
            <div>
              <h2 className="font-bold text-gray-900 text-lg">Detectar eliminados</h2>
              <p className="text-sm text-gray-500 mt-1">Detecta productos que ya no existen en ML y los marca en el Sheet.</p>
            </div>
            <button
              onClick={handleDetectDeleted}
              disabled={detecting || !mlStatus?.ok}
              className="w-full bg-gray-900 hover:bg-black disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold py-3 px-4 rounded-xl transition-colors"
            >
              {detecting ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                  </svg>
                  Detectando...
                </span>
              ) : "Detectar eliminados"}
            </button>
            {deletedResult && (
              <div className={`text-sm rounded-xl px-4 py-3 ${deletedResult.ok ? "bg-blue-50 text-blue-700 border border-blue-200" : "bg-red-50 text-red-700 border border-red-200"}`}>
                {deletedResult.ok
                  ? deletedResult.eliminados === 0
                    ? "✓ No hay productos eliminados"
                    : `⚠ ${deletedResult.eliminados} producto(s) marcados como ELIMINADA`
                  : `✗ Error: ${deletedResult.error}`}
              </div>
            )}
          </div>
        </div>

        {/* Link al Sheet */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 flex items-center justify-between">
          <div>
            <p className="font-bold text-gray-900">Google Sheets</p>
            <p className="text-sm text-gray-500">Ver publicaciones y ventas sincronizadas</p>
          </div>
          <a
            href="https://docs.google.com/spreadsheets/d/14mb2PAwr-xvy_syr-cpXdBWcUx0Nni8byQx6YX03xDM"
            target="_blank"
            rel="noopener noreferrer"
            className="text-white font-bold py-2.5 px-5 rounded-xl text-sm transition-colors"
            style={{ backgroundColor: "#0F9D58" }}
          >
            Abrir Sheet →
          </a>
        </div>

      </div>
    </main>
  );
}

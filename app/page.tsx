"use client";

import { Fragment, CSSProperties, useEffect, useState, useRef } from "react";
import Image from "next/image";

type MLStatus = { ok: boolean; nickname?: string } | null;

type StockChange = { titulo: string; antes: number; despues: number; diferencia: number };
type VentaNueva = { titulo: string; cantidad: number; total: number; comprador: string; fecha: string };
type ProductoNuevo = { id: string; titulo: string; precio: number; estado: string };
type SyncResult = {
  ok: boolean;
  publicaciones?: number;
  ventas?: number;
  productosNuevos?: ProductoNuevo[];
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

type ErrorType = "comision_incorrecta" | "envio_incorrecto" | "devolucion_sin_reembolso" | "comision_venta_anulada";

type TransaccionError = {
  tipo: ErrorType;
  fecha: string;
  orden: string;
  producto: string;
  cobrado: number;
  esperado: number;
  diferencia: number;
  detalle: string;
};

type AuditResult = {
  ventas_brutas: number;
  ventas_netas: number;
  comisiones_ml: number;
  comisiones_mp: number;
  total_comisiones: number;
  recuperable: number;
  neto_recibido_mp: number;
  tasa_efectiva: number;
  flex_credito: number;
  flex_debito: number;
  errores_count: number;
  errores: TransaccionError[];
  resumen: string;
  detalle_errores: string[];
};

type AuditApiResult = { ok: boolean; mes?: string; result?: AuditResult; error?: string } | null;

type AuditHistorialRow = {
  mes: string;
  ventas_brutas: number;
  ventas_netas: number;
  comisiones_ml: number;
  comisiones_mp: number;
  total_comisiones: number;
  recuperable: number;
  tasa_efectiva: number;
  errores: number;
  resumen: string;
  analizado: string;
  rowIndex: number; // índice 0-based en Google Sheets (fila real, incluye header)
};

function Spinner() {
  return (
    <svg className="animate-spin h-4 w-4 inline mr-2" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
    </svg>
  );
}

function formatCLP(n: number) {
  return "$" + Math.round(n).toLocaleString("es-CL");
}

type FileZone = { key: string; label: string; hint: string };
const FILE_ZONES: FileZone[] = [
  { key: "facturacion_ml", label: "Facturación Mercado Libre", hint: "Reporte_Facturacion_MercadoLibre_...csv/.xlsx" },
  { key: "csv_mp", label: "Facturación Mercado Pago", hint: "Reporte_Facturacion_MercadoPago_...csv" },
  { key: "notas_credito", label: "Notas de Crédito MP (opcional)", hint: "Reporte_NotasCredito_MercadoPago_...xlsx" },
  { key: "flex_credito", label: "NC Envíos Flex (opcional)", hint: "Reporte_NotasCredito_Flex_...xlsx" },
  { key: "flex_debito", label: "ND Envíos Flex (opcional)", hint: "Reporte_NotasDebito_Flex_...xlsx" },
];

export default function Home() {
  const [activeTab, setActiveTab] = useState<"sync" | "auditoria">("sync");

  // --- Sync state ---
  const [mlStatus, setMlStatus] = useState<MLStatus>(null);
  const [syncing, setSyncing] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult>(null);
  const [deletedResult, setDeletedResult] = useState<DeletedResult>(null);
  const [borrandoFilas, setBorrandoFilas] = useState<number[]>([]);
  const [seleccionados, setSeleccionados] = useState<number[]>([]);

  // --- Auditoría state ---
  const [mes, setMes] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [auditFiles, setAuditFiles] = useState<Record<string, File | null>>({
    csv_mp: null, facturacion_ml: null, notas_credito: null, flex_credito: null, flex_debito: null,
  });
  const [analyzing, setAnalyzing] = useState(false);
  const [auditResult, setAuditResult] = useState<AuditApiResult>(null);
  const [historial, setHistorial] = useState<AuditHistorialRow[]>([]);
  const [expandedMes, setExpandedMes] = useState<string | null>(null);
  const [deletingRowIdx, setDeletingRowIdx] = useState<number | null>(null);
  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({});

  useEffect(() => {
    fetch("/api/status").then(r => r.json()).then(setMlStatus).catch(() => setMlStatus({ ok: false }));
  }, []);

  async function loadHistorial() {
    try {
      const res = await fetch("/api/sheets-data?tab=Auditor%C3%ADa");
      const data = await res.json();
      if (!data.rows) return;
      // Columnas: Mes(0) VentasBrutas(1) VentasNetas(2) ComisionesML(3) ComisionesMP(4) Total(5) Recuperable(6) Tasa(7) Errores(8) Resumen(9) Analizado(10)
      const rows: AuditHistorialRow[] = data.rows
        .filter((r: string[]) => r[0])
        .map((r: string[], i: number) => ({
          mes: r[0] ?? "",
          ventas_brutas: Number(r[1]) || 0,
          ventas_netas: Number(r[2]) || 0,
          comisiones_ml: Number(r[3]) || 0,
          comisiones_mp: Number(r[4]) || 0,
          total_comisiones: Number(r[5]) || 0,
          recuperable: Number(r[6]) || 0,
          tasa_efectiva: Number(r[7]) || 0,
          errores: Number(r[8]) || 0,
          resumen: r[9] ?? "",
          analizado: r[10] ?? "",
          rowIndex: i + 1, // +1 porque fila 0 es el header en el Sheet
        }))
        .reverse(); // más reciente primero
      setHistorial(rows);
    } catch { /* silencioso */ }
  }

  useEffect(() => {
    if (activeTab === "auditoria") loadHistorial();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

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

  async function handleDeleteRow(rowIndex: number) {
    setDeletingRowIdx(rowIndex);
    try {
      await fetch("/api/audit/delete-row", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rowIndex }),
      });
      await loadHistorial();
    } finally {
      setDeletingRowIdx(null);
    }
  }

  async function handleAnalyze() {
    const hasFile = Object.values(auditFiles).some(f => f !== null);
    if (!hasFile) return;

    setAnalyzing(true);
    setAuditResult(null);
    try {
      const fd = new FormData();
      fd.append("mes", mes);
      for (const file of Object.values(auditFiles)) {
        if (file) fd.append("file", file);
      }
      const res = await fetch("/api/audit/analyze", { method: "POST", body: fd });
      const json = await res.json();
      setAuditResult(json);
      if (json.ok) loadHistorial();
    } catch {
      setAuditResult({ ok: false, error: "Error de red" });
    } finally {
      setAnalyzing(false);
    }
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

      {/* Tabs */}
      <div className="max-w-4xl mx-auto px-6 pt-6">
        <div className="flex gap-1 bg-white rounded-2xl border border-gray-200 shadow-sm p-1 w-fit">
          <button onClick={() => setActiveTab("sync")}
            className={`px-5 py-2 rounded-xl font-semibold text-sm transition-colors ${activeTab === "sync" ? "text-white" : "text-gray-500 hover:text-gray-700"}`}
            style={activeTab === "sync" ? { backgroundColor: "#C41230" } : {}}>
            Publicaciones
          </button>
          <button onClick={() => setActiveTab("auditoria")}
            className={`px-5 py-2 rounded-xl font-semibold text-sm transition-colors ${activeTab === "auditoria" ? "text-white" : "text-gray-500 hover:text-gray-700"}`}
            style={activeTab === "auditoria" ? { backgroundColor: "#C41230" } : {}}>
            Auditoría
          </button>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-6 py-6 space-y-5">

        {/* === TAB: PUBLICACIONES === */}
        {activeTab === "sync" && (
          <>
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

                    {(syncResult.productosNuevos?.length ?? 0) > 0 && (
                      <div>
                        <h3 className="font-semibold text-gray-800 mb-2">Productos nuevos ({syncResult.productosNuevos!.length})</h3>
                        <div className="space-y-1 max-h-48 overflow-y-auto">
                          {syncResult.productosNuevos!.map((p, i) => (
                            <div key={i} className="flex items-center justify-between text-sm bg-green-50 rounded-lg px-3 py-2">
                              <span className="text-gray-700 truncate flex-1 mr-3">{p.titulo}</span>
                              <span className="text-gray-400 mr-3">${Number(p.precio).toLocaleString("es-CL")}</span>
                              <span className="text-xs text-green-700 font-medium bg-green-100 px-2 py-0.5 rounded-full">{p.estado}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

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
          </>
        )}

        {/* === TAB: AUDITORÍA === */}
        {activeTab === "auditoria" && (
          <>
            <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-5">
              <div>
                <h2 className="font-bold text-gray-900 text-lg">Auditoría de comisiones</h2>
                <p className="text-sm text-gray-500 mt-1">Sube los reportes del mes y la IA analizará las comisiones cobradas por ML/MP.</p>
              </div>

              {/* Selector de mes */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Mes a auditar</label>
                <input type="month" value={mes} onChange={e => setMes(e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ "--tw-ring-color": "#C41230" } as CSSProperties} />
              </div>

              {/* Zonas de archivo */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {FILE_ZONES.map(zone => {
                  const file = auditFiles[zone.key];
                  return (
                    <div key={zone.key}
                      className={`border-2 border-dashed rounded-xl p-4 cursor-pointer transition-colors ${file ? "border-green-400 bg-green-50" : "border-gray-300 hover:border-gray-400 bg-gray-50"}`}
                      onClick={() => fileRefs.current[zone.key]?.click()}>
                      <input ref={el => { fileRefs.current[zone.key] = el; }} type="file"
                        accept=".csv,.xlsx,.xls" className="hidden"
                        onChange={e => {
                          const f = e.target.files?.[0] ?? null;
                          setAuditFiles(prev => ({ ...prev, [zone.key]: f }));
                          e.target.value = "";
                        }} />
                      <div className="flex items-start gap-3">
                        <span className="text-2xl">{file ? "✅" : "📂"}</span>
                        <div className="min-w-0">
                          <p className="font-medium text-sm text-gray-800">{zone.label}</p>
                          <p className="text-xs text-gray-400 mt-0.5 truncate">{file ? file.name : zone.hint}</p>
                        </div>
                        {file && (
                          <button onClick={e => { e.stopPropagation(); setAuditFiles(prev => ({ ...prev, [zone.key]: null })); }}
                            className="ml-auto text-gray-400 hover:text-red-500 shrink-0 text-lg leading-none">×</button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              <button onClick={handleAnalyze}
                disabled={analyzing || !Object.values(auditFiles).some(f => f !== null)}
                className="w-full font-bold py-3 px-4 rounded-xl text-white disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ backgroundColor: "#C41230" }}>
                {analyzing ? <><Spinner />Analizando con IA...</> : "Analizar"}
              </button>
            </div>

            {/* Resultado */}
            {auditResult && (
              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-5">
                {!auditResult.ok ? (
                  <p className="text-red-600 text-sm">✗ Error: {auditResult.error}</p>
                ) : auditResult.result && (
                  <>
                    <div>
                      <h3 className="font-bold text-gray-900 text-lg">Resultado — {auditResult.mes}</h3>
                      <p className="text-sm text-gray-500 mt-1">{auditResult.result.resumen}</p>
                    </div>

                    {/* Métricas resumen */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      {[
                        { label: "Ventas Brutas", value: formatCLP(auditResult.result.ventas_brutas), color: "text-gray-900" },
                        { label: "Comisiones ML", value: formatCLP(auditResult.result.comisiones_ml), color: "text-orange-600" },
                        { label: "Comisiones MP", value: formatCLP(auditResult.result.comisiones_mp), color: "text-orange-600" },
                        { label: "Total Comisiones", value: formatCLP(auditResult.result.total_comisiones), color: "text-red-700" },
                        { label: "Tasa Efectiva", value: `${auditResult.result.tasa_efectiva.toFixed(2)}%`, color: "text-red-700" },
                        { label: "Neto Recibido MP", value: formatCLP(auditResult.result.neto_recibido_mp), color: "text-blue-700" },
                        { label: "Recuperable", value: formatCLP(auditResult.result.recuperable), color: "text-green-600" },
                        { label: "Errores detectados", value: String(auditResult.result.errores_count), color: auditResult.result.errores_count > 0 ? "text-red-600" : "text-gray-900" },
                      ].map(card => (
                        <div key={card.label} className="bg-gray-50 rounded-xl p-3 text-center">
                          <p className={`text-xl font-bold ${card.color}`}>{card.value}</p>
                          <p className="text-xs text-gray-500 mt-1">{card.label}</p>
                        </div>
                      ))}
                    </div>

                    {/* Ajustes Flex */}
                    {(auditResult.result.flex_credito > 0 || auditResult.result.flex_debito > 0) && (
                      <div className="flex gap-3 flex-wrap">
                        {auditResult.result.flex_credito > 0 && (
                          <span className="text-xs bg-green-50 text-green-700 border border-green-200 rounded-lg px-3 py-1.5 font-medium">
                            Flex crédito aplicado: -{formatCLP(auditResult.result.flex_credito)}
                          </span>
                        )}
                        {auditResult.result.flex_debito > 0 && (
                          <span className="text-xs bg-red-50 text-red-700 border border-red-200 rounded-lg px-3 py-1.5 font-medium">
                            Flex débito aplicado: +{formatCLP(auditResult.result.flex_debito)}
                          </span>
                        )}
                      </div>
                    )}

                    {/* Tabla de errores por transacción */}
                    {auditResult.result.errores.length > 0 && (
                      <div>
                        <div className="flex items-center gap-3 mb-3 flex-wrap">
                          <h4 className="font-semibold text-gray-800">Errores detectados</h4>
                          {(["comision_incorrecta", "envio_incorrecto", "devolucion_sin_reembolso", "comision_venta_anulada"] as ErrorType[]).map(tipo => {
                            const count = auditResult.result!.errores.filter(e => e.tipo === tipo).length;
                            if (count === 0) return null;
                            const labels: Record<ErrorType, string> = {
                              comision_incorrecta: "Comisión incorrecta",
                              envio_incorrecto: "Envío incorrecto",
                              devolucion_sin_reembolso: "Devolución sin reembolso",
                              comision_venta_anulada: "Comisión en venta anulada",
                            };
                            const colors: Record<ErrorType, string> = {
                              comision_incorrecta: "bg-orange-100 text-orange-800",
                              envio_incorrecto: "bg-blue-100 text-blue-800",
                              devolucion_sin_reembolso: "bg-red-100 text-red-800",
                              comision_venta_anulada: "bg-purple-100 text-purple-800",
                            };
                            return (
                              <span key={tipo} className={`text-xs px-2.5 py-1 rounded-full font-medium ${colors[tipo]}`}>
                                {labels[tipo]} ({count})
                              </span>
                            );
                          })}
                        </div>
                        <div className="overflow-x-auto rounded-xl border border-gray-200">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="bg-gray-50 border-b border-gray-200 text-left text-gray-500 uppercase tracking-wide">
                                <th className="px-3 py-2">Tipo</th>
                                <th className="px-3 py-2">Fecha</th>
                                <th className="px-3 py-2">Orden</th>
                                <th className="px-3 py-2">Producto</th>
                                <th className="px-3 py-2 text-right">Cobrado</th>
                                <th className="px-3 py-2 text-right">Esperado</th>
                                <th className="px-3 py-2 text-right">Dif.</th>
                                <th className="px-3 py-2">Detalle</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100">
                              {auditResult.result.errores.map((err, i) => {
                                const badgeColors: Record<ErrorType, string> = {
                                  comision_incorrecta: "bg-orange-100 text-orange-800",
                                  envio_incorrecto: "bg-blue-100 text-blue-800",
                                  devolucion_sin_reembolso: "bg-red-100 text-red-800",
                                  comision_venta_anulada: "bg-purple-100 text-purple-800",
                                };
                                const badgeLabels: Record<ErrorType, string> = {
                                  comision_incorrecta: "Comisión",
                                  envio_incorrecto: "Envío",
                                  devolucion_sin_reembolso: "Devolución",
                                  comision_venta_anulada: "Anulada",
                                };
                                return (
                                  <tr key={i} className="hover:bg-gray-50">
                                    <td className="px-3 py-2">
                                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${badgeColors[err.tipo]}`}>
                                        {badgeLabels[err.tipo]}
                                      </span>
                                    </td>
                                    <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{err.fecha}</td>
                                    <td className="px-3 py-2 text-gray-500 font-mono">{err.orden}</td>
                                    <td className="px-3 py-2 text-gray-700 max-w-[180px] truncate">{err.producto}</td>
                                    <td className="px-3 py-2 text-right text-gray-800 font-medium">{formatCLP(err.cobrado)}</td>
                                    <td className="px-3 py-2 text-right text-gray-500">{err.esperado > 0 ? formatCLP(err.esperado) : "—"}</td>
                                    <td className={`px-3 py-2 text-right font-bold ${err.diferencia > 0 ? "text-green-600" : "text-red-600"}`}>
                                      {err.diferencia > 0 ? "+" : ""}{formatCLP(err.diferencia)}
                                    </td>
                                    <td className="px-3 py-2 text-gray-500 max-w-[200px] truncate">{err.detalle}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                        <p className="text-xs text-gray-400 mt-2">
                          Total recuperable estimado: <span className="font-semibold text-green-600">
                            {formatCLP(auditResult.result.errores.reduce((s, e) => s + Math.abs(e.diferencia), 0))}
                          </span>
                        </p>
                      </div>
                    )}

                    {/* Diagnóstico (colapsable) */}
                    {auditResult.result.detalle_errores.filter(e => !e.startsWith("[DIAG]")).length > 0 && (
                      <details className="text-xs">
                        <summary className="text-gray-400 cursor-pointer hover:text-gray-600">Ver notas adicionales</summary>
                        <ul className="mt-2 space-y-1">
                          {auditResult.result.detalle_errores.filter(e => !e.startsWith("[DIAG]")).map((err, i) => (
                            <li key={i} className="text-gray-600 bg-yellow-50 rounded-lg px-3 py-1.5">{err}</li>
                          ))}
                        </ul>
                      </details>
                    )}
                    <details className="text-xs">
                      <summary className="text-gray-400 cursor-pointer hover:text-gray-600">Diagnóstico técnico</summary>
                      <ul className="mt-2 space-y-1">
                        {auditResult.result.detalle_errores.filter(e => e.startsWith("[DIAG]")).map((err, i) => (
                          <li key={i} className="text-gray-500 bg-gray-50 rounded px-3 py-1">{err}</li>
                        ))}
                      </ul>
                    </details>

                    <p className="text-xs text-gray-400">Guardado en la hoja "Auditoría" del Google Sheets.</p>
                  </>
                )}
              </div>
            )}

            {/* Historial de auditorías */}
            {historial.length > 0 && (
              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6 space-y-3">
                <h3 className="font-bold text-gray-900 text-lg">Historial por mes</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
                        <th className="pb-2 pr-4">Mes</th>
                        <th className="pb-2 pr-4 text-right">Ventas Brutas</th>
                        <th className="pb-2 pr-4 text-right">Com. ML</th>
                        <th className="pb-2 pr-4 text-right">Com. MP</th>
                        <th className="pb-2 pr-4 text-right">Total Com.</th>
                        <th className="pb-2 pr-4 text-right">Tasa</th>
                        <th className="pb-2 pr-4 text-right">Recuperable</th>
                        <th className="pb-2 w-8"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {historial.map((row) => (
                        <Fragment key={row.rowIndex}>
                          <tr
                            className="hover:bg-gray-50 cursor-pointer group"
                            onClick={() => setExpandedMes(expandedMes === row.mes ? null : row.mes)}>
                            <td className="py-2.5 pr-4 font-semibold text-gray-800">{row.mes}</td>
                            <td className="py-2.5 pr-4 text-right text-gray-700">${Math.round(row.ventas_brutas).toLocaleString("es-CL")}</td>
                            <td className="py-2.5 pr-4 text-right text-orange-600">${Math.round(row.comisiones_ml).toLocaleString("es-CL")}</td>
                            <td className="py-2.5 pr-4 text-right text-orange-600">${Math.round(row.comisiones_mp).toLocaleString("es-CL")}</td>
                            <td className="py-2.5 pr-4 text-right font-semibold text-red-700">${Math.round(row.total_comisiones).toLocaleString("es-CL")}</td>
                            <td className="py-2.5 pr-4 text-right text-red-700">{Number(row.tasa_efectiva).toFixed(2)}%</td>
                            <td className="py-2.5 pr-4 text-right text-green-600">${Math.round(row.recuperable).toLocaleString("es-CL")}</td>
                            <td className="py-2.5 text-right">
                              <button
                                onClick={(e) => { e.stopPropagation(); handleDeleteRow(row.rowIndex); }}
                                disabled={deletingRowIdx === row.rowIndex}
                                className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-600 disabled:opacity-30 transition-opacity text-lg leading-none"
                                title="Eliminar">
                                {deletingRowIdx === row.rowIndex ? "…" : "×"}
                              </button>
                            </td>
                          </tr>
                          {expandedMes === row.mes && (
                            <tr>
                              <td colSpan={8} className="py-2 pb-3">
                                <div className="bg-gray-50 rounded-xl px-4 py-3 text-xs text-gray-600 space-y-1">
                                  <p>{row.resumen}</p>
                                  <p className="text-gray-400">Analizado: {row.analizado}</p>
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}

      </div>
    </main>
  );
}

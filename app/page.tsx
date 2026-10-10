"use client";

import { Fragment, CSSProperties, useEffect, useState, useRef } from "react";
import Image from "next/image";
import * as XLSX from "xlsx";
import RevisionPublicaciones from "./RevisionPublicaciones";
import Tablero from "./Tablero";
import { ListaRankingMovil, ListaVisitasMovil, TarjetasCampanas, TarjetasProductos } from "./MetricasMovil";
import { TarjetasRentabilidad } from "./RentabilidadMovil";
import ReclamosPorTipo from "./ReclamosPorTipo";
import { abortoSinBorrar, errorPublicaciones, guardarUltimoSyncPublicaciones, leerUltimoSyncPublicaciones } from "@/lib/sync-estado";

type MLStatus = { ok: boolean; nickname?: string } | null;

type StockChange = { titulo: string; antes: number; despues: number; diferencia: number };
type VentaNueva = { titulo: string; cantidad: number; total: number; comprador: string; fecha: string; orden?: string };
type ProductoNuevo = { id: string; titulo: string; precio: number; estado: string };
type ProductoSinCosto = { id: string; titulo: string; vendidos: number };
type CoberturaCosto = {
  activasTotal: number;
  activasConCosto: number;
  activasSinCosto: number;
  vendidosActivasConCosto: number;
  vendidosActivasSinCosto: number;
  topSinCosto: ProductoSinCosto[];
};
type SyncResult = {
  ok: boolean;
  publicaciones?: number | null;
  ventas?: number;
  productosNuevos?: ProductoNuevo[];
  cambiosStock?: StockChange[];
  coberturaCosto?: CoberturaCosto | null;
  ventasNuevas?: VentaNueva[];
  erroresValidacion?: string[];
  erroresSync?: string[];
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

type Prioridad = "SIN_STOCK" | "URGENTE" | "PRONTO" | "OK" | "SIN_DATOS";
type ForecastRow = {
  id: string;
  titulo: string;
  stockActual: number;
  ventas30d: number;
  velocidadDiaria: number;
  diasRestantes: number | null;
  fechaQuiebre: string | null;
  cantidadSugerida: number;
  prioridad: Prioridad;
  estadoML: string;
};
type ForecastApiResult = {
  ok: boolean;
  leadTimeDays?: number;
  safetyDays?: number;
  rows?: ForecastRow[];
  error?: string;
} | null;

type Periodo = "dia" | "semana" | "mes";
// Variación % genérica actual vs. período anterior — mismo shape que
// calcularVariacionPct en api/metrics/route.ts. null cuando no hay dato
// del período anterior para comparar (evita mostrar un % sin sentido).
type VariacionPct = { actual: number; anterior: number; variacionPct: number | null };
type ComparacionPeriodo = {
  totalVendido: VariacionPct;
  unidades: VariacionPct;
  ticketPromedio: VariacionPct;
};
type ProductoRanking = { id: string; titulo: string; monto: number; unidades: number };

type VentasMetrics = {
  ok: boolean;
  totalVendido?: number;
  unidades?: number;
  cantidadOrdenes?: number;
  ticketPromedio?: number;
  ranking?: ProductoRanking[];
  comparacion?: ComparacionPeriodo | null;
  porLogistica?: {
    ingresoVentana: number;
    real: { ingreso: number; pct: number };
    respaldo: { ingreso: number; pct: number };
    sinDato: { ingreso: number; pct: number };
    porGrupo: Record<string, { ingreso: number; pct: number; ordenes: number }>;
    respaldoPorTipo: { full: number; noFull: number };
  };
  error?: string;
};
type ReputacionMetrics = {
  ok: boolean;
  levelId?: string;
  powerSellerStatus?: string;
  ventasCompletadas?: number;
  ventasCanceladas?: number;
  claims?: { rate: number; value: number; period: string };
  cancellations?: { rate: number; value: number; period: string };
  delayedHandlingTime?: { rate: number; value: number; period: string };
  error?: string;
};
type VisitaPorPublicacion = { id: string; titulo: string; visitas: number; ventas: number; conversion: number | null };
type VisitasMetrics = {
  ok: boolean;
  totalVisitas?: number;
  porPublicacion?: VisitaPorPublicacion[];
  error?: string;
};
type PreguntasMetrics = {
  ok: boolean;
  total?: number;
  sinResponder?: number;
  tiempoRespuestaPromedioHoras?: number | null;
  error?: string;
};
type ReclamosMetrics = {
  ok: boolean;
  total?: number;
  porStatus?: Record<string, number>;
  porTipo?: Record<string, number>;
  error?: string;
};
type CampanaRoas = {
  id: number;
  nombre: string;
  estado: string;
  estrategia: string;
  acosTarget: number;
  presupuestoDiario: number;
  presupuesto: number;
  clics: number;
  impresiones: number;
  ctr: number;
  cpc: number;
  costo: number;
  roas: number;
  acos: number;
  montoDirecto: number;
  montoIndirecto: number;
  unidadesOrganicas: number;
  montoOrganico: number;
  usoPresupuesto: number | null;
};
type RoasMetrics = {
  ok: boolean;
  inversionTotal?: number;
  ventasAtribuidasTotal?: number;
  roasAgregado?: number | null;
  campanas?: CampanaRoas[];
  error?: string;
};
type EtiquetaProducto = "Candidato" | "Revisar" | "Stock bajo";
type FilaTablaProducto = {
  id: string;
  titulo: string;
  ventasMonto: number;
  ventasUnidades: number;
  visitas: number | null;
  conversion: number | null;
  stock: number | null;
  full: boolean;
  precio: number | null;
  costo: number | null;
  margenPct: number | null;
  costoMax: number | null;
  costoMaxFuenteEnvio: "medido" | "estimado" | null;
  comisionPct: number | null;
  comisionFuente: "orden" | "calculada" | null;
  envioPorUnidad: number | null;
  precioEquilibrio: number | null;
  pierde: boolean;
  campana: string | null;
  campanaId: number | null;
  statusAnuncio: string | null;
  clics: number;
  impresiones: number;
  ctr: number;
  cpc: number;
  costoAds: number;
  acos: number;
  roas: number;
  etiquetas: EtiquetaProducto[];
};
type TablaProductosMetrics = {
  ok: boolean;
  filas?: FilaTablaProducto[];
  error?: string;
};

type MetricsApiResult = {
  ok: boolean;
  periodo?: Periodo;
  desde?: string;
  hasta?: string;
  ventas?: VentasMetrics;
  reputacion?: ReputacionMetrics;
  visitas?: VisitasMetrics;
  preguntas?: PreguntasMetrics;
  reclamos?: ReclamosMetrics;
  roas?: RoasMetrics;
  tablaProductos?: TablaProductosMetrics;
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
  comisiones_mp_px: number;
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
  error_cobertura?: string;
};

type ReferenciaML = { ventasBrutas: number; cantidadVentas: number } | null;

type MesDetectado = { year: number; month: number; count: number };

type AuditApiResult = {
  ok: boolean;
  mes?: string;
  result?: AuditResult;
  referenciaML?: ReferenciaML;
  error?: string;
  mesesML?: MesDetectado[];
  mesesMP?: MesDetectado[];
} | null;

type AuditHistorialRow = {
  mes: string;
  ventas_brutas: number;
  ventas_netas: number;
  comisiones_ml: number;
  comisiones_mp: number;
  comisiones_mp_px: number;
  total_comisiones: number;
  notas_credito_ml: number;
  recuperable: number;
  tasa_efectiva: number;
  errores: number;
  resumen: string;
  analizado: string;
  rowIndex: number; // índice 0-based en Google Sheets (fila real, incluye header)
};

type RentabilidadRow = {
  idOrden: string;
  fecha: string;
  producto: string;
  precioVenta: number;
  cogs: number | null;
  comision: number;
  envio: number;
  perdida: number;
  margenNeto: number | null;
  margenPct: number | null;
  multiItem: boolean;
};

type FilaComparador = {
  id: string;
  titulo: string;
  marca: string | null;
  proveedor: string | null;
  precio: number;
  comisionPct: number | null;
  comisionFuente: "orden" | "calculada" | null;
  comisionMonto: number | null;
  envioPorUnidad: number | null;
  envioFuente: "medido" | "estimado" | "sin_dato";
  netoMlPorUnidad: number | null;
  precioMayor: number | null;
  precioMayorNeto: number | null;
  fuenteMayor: "cruce_directo" | "equivalencia" | "sin_referencia";
  vsMayorPct: number | null;
  precioSugerido: number | null;
  semaforo: "rojo" | "amarillo" | "verde" | null;
  mayorEnRevision: boolean;
  motivoRevision: string | null;
  campanaId: number | null;
  statusAnuncio: string | null;
  costoAdsPorUnidadPeriodo: number | null;
  vsMayorConAdsPct: number | null;
};
type ComparadorApiResult = { ok: boolean; objetivo?: number; filas?: FilaComparador[]; error?: string } | null;

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

// Reutilizable por cualquier métrica que muestre comparación de período
// (hoy solo Ventas, ver ComparacionPeriodo en api/metrics/route.ts).
function VariacionBadge({ variacion }: { variacion: VariacionPct | undefined }) {
  if (!variacion || variacion.variacionPct === null) {
    return <span className="text-xs text-gray-400">— sin dato previo</span>;
  }
  const { variacionPct } = variacion;
  const subio = variacionPct > 0;
  const igual = variacionPct === 0;
  const color = igual ? "text-gray-400" : subio ? "text-green-600" : "text-red-600";
  const flecha = igual ? "→" : subio ? "▲" : "▼";
  return (
    <span className={`text-xs font-semibold ${color}`}>
      {flecha} {subio ? "+" : ""}{variacionPct}% <span className="font-normal text-gray-400">vs. período anterior</span>
    </span>
  );
}

type FileZone = { key: string; label: string; hint: string };
const FILE_ZONES: FileZone[] = [
  { key: "facturacion_ml", label: "Facturación Mercado Libre", hint: "Reporte_Facturacion_MercadoLibre_...csv/.xlsx" },
  { key: "csv_mp", label: "Facturación Mercado Pago", hint: "Reporte_Facturacion_MercadoPago_...csv" },
  { key: "notas_credito_ml", label: "Notas de Crédito ML (opcional)", hint: "Reporte_Notas_Credito_MercadoLibre_...csv/.xlsx" },
  { key: "notas_credito", label: "Notas de Crédito MP (opcional)", hint: "Reporte_NotasCredito_MercadoPago_...xlsx" },
  { key: "flex_credito", label: "NC Envíos Flex (opcional)", hint: "Reporte_NotasCredito_Flex_...xlsx" },
  { key: "flex_debito", label: "ND Envíos Flex (opcional)", hint: "Reporte_NotasDebito_Flex_...xlsx" },
];

export default function Home() {
  const [activeTab, setActiveTab] = useState<"tablero" | "sync" | "auditoria" | "forecast" | "metricas" | "rentabilidad" | "comparador">("tablero");

  // --- Sync state ---
  const [mlStatus, setMlStatus] = useState<MLStatus>(null);
  const [syncing, setSyncing] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult>(null);
  // Último sync con Publicaciones correcto visto desde este navegador (solo para el banner de error).
  const [ultimoSyncPubOk, setUltimoSyncPubOk] = useState<string | null>(null);
  const [deletedResult, setDeletedResult] = useState<DeletedResult>(null);
  const [borrandoFilas, setBorrandoFilas] = useState<number[]>([]);
  const [seleccionados, setSeleccionados] = useState<number[]>([]);
  const [ventasSemana, setVentasSemana] = useState<VentaNueva[]>([]);
  const [loadingVentas, setLoadingVentas] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillProgreso, setBackfillProgreso] = useState({ procesadas: 0, nuevasEnCache: 0 });
  const [backfillError, setBackfillError] = useState<string | null>(null);
  const [backfillTotales, setBackfillTotales] = useState<{ http429: number; http404: number; sinEnvio: number; errores: string[] }>({ http429: 0, http404: 0, sinEnvio: 0, errores: [] });
  const backfillCancelado = useRef(false);

  // --- Auditoría state ---
  const [mes, setMes] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [auditFiles, setAuditFiles] = useState<Record<string, File | null>>({
    csv_mp: null, facturacion_ml: null, notas_credito_ml: null, notas_credito: null, flex_credito: null, flex_debito: null,
  });
  const [mesesDetectados, setMesesDetectados] = useState<{ ml: MesDetectado[]; mp: MesDetectado[] } | null>(null);
  const [detectandoMeses, setDetectandoMeses] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const analyzingRef = useRef(false); // guarda síncrona: setAnalyzing(true) no bloquea un 2do click en el mismo frame, antes del re-render
  const [auditResult, setAuditResult] = useState<AuditApiResult>(null);
  const [historial, setHistorial] = useState<AuditHistorialRow[]>([]);
  const [expandedMes, setExpandedMes] = useState<string | null>(null);
  const [deletingRowIdx, setDeletingRowIdx] = useState<number | null>(null);
  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({});

  // --- Forecast state ---
  const [leadTimeDays, setLeadTimeDays] = useState(15);
  const [safetyDays, setSafetyDays] = useState(7);
  const [loadingForecast, setLoadingForecast] = useState(false);
  const [forecastResult, setForecastResult] = useState<ForecastApiResult>(null);
  const [filtroPrioridad, setFiltroPrioridad] = useState<Prioridad | "TODOS">("TODOS");

  // --- Métricas state ---
  const [periodoMetrics, setPeriodoMetrics] = useState<Periodo>("mes");
  const [loadingMetrics, setLoadingMetrics] = useState(false);
  const [metricsResult, setMetricsResult] = useState<MetricsApiResult>(null);

  // --- Rentabilidad state ---
  const [mesRentabilidad, setMesRentabilidad] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [analizandoRentabilidad, setAnalizandoRentabilidad] = useState(false);
  const [progresoRentabilidad, setProgresoRentabilidad] = useState({ filasProcesadas: 0, ordenesNuevas: 0, multiItemDetectadas: 0 });
  const [errorRentabilidad, setErrorRentabilidad] = useState<string | null>(null);
  const [rentabilidadRows, setRentabilidadRows] = useState<RentabilidadRow[]>([]);
  const rentabilidadCancelado = useRef(false);

  // --- Comparador vs Mayor state ---
  const [loadingComparador, setLoadingComparador] = useState(false);
  const [comparadorResult, setComparadorResult] = useState<ComparadorApiResult>(null);
  const [objetivoComparador, setObjetivoComparador] = useState(10);
  const [filtroSemaforo, setFiltroSemaforo] = useState<"todos" | "rojo" | "amarillo" | "verde" | "revision">("todos");
  const [filtroMarca, setFiltroMarca] = useState("");
  const [filtroProveedor, setFiltroProveedor] = useState("");
  const [ordenComparador, setOrdenComparador] = useState<{ campo: keyof FilaComparador; asc: boolean }>({ campo: "vsMayorPct", asc: true });

  useEffect(() => {
    fetch("/api/status").then(r => r.json()).then(setMlStatus).catch(() => setMlStatus({ ok: false }));
    loadVentasSemana();
  }, []);

  async function loadVentasSemana() {
    setLoadingVentas(true);
    try {
      const res = await fetch("/api/sheets-data?tab=Ventas");
      const data = await res.json();
      if (!data.rows) return;
      // Columnas Sheet Ventas: ID Orden(0) Fecha(1) Producto(2) SKU(3) Cantidad(4) Precio Unit.(5) Total(6) Comprador(7) Estado(8)
      const hace7d = new Date(Date.now() - 7 * 86400000);
      const ventas: VentaNueva[] = data.rows
        .filter((r: string[]) => {
          if (!r[1]) return false;
          // fecha formato dd-mm-yyyy o dd/mm/yyyy
          const parts = r[1].split(/[-\/]/);
          if (parts.length < 3) return false;
          const fecha = new Date(Number(parts[2]), Number(parts[1]) - 1, Number(parts[0]));
          return fecha >= hace7d;
        })
        .map((r: string[]) => ({
          orden: r[0] ?? "",
          fecha: r[1] ?? "",
          titulo: r[2] ?? "",
          cantidad: Number(r[4]) || 0,
          total: Number(r[6]) || 0,
          comprador: r[7] ?? "",
        }));
      setVentasSemana(ventas);
    } catch { /* silencioso */ } finally {
      setLoadingVentas(false);
    }
  }

  async function loadHistorial() {
    try {
      const res = await fetch("/api/sheets-data?tab=Auditor%C3%ADa");
      const data = await res.json();
      if (!data.rows) return;
      // La hoja Auditoría acumula filas de distintas generaciones de esquema
      // (el header no se reescribe una vez creado — solo las filas nuevas
      // usan el layout vigente al momento de analizarse), así que el índice
      // de cada campo depende de r.length, no es fijo:
      // - 16 columnas (esquema actual): Mes(0) VentasBrutas(1) VentasNetas(2)
      //   ComisionesML(3) ComisionesMP(4) ComisionesMP_PX(5) Total(6)
      //   NotasCreditoML(7) Recuperable(8) NetoRecibidoMP(9) Tasa(10)
      //   FlexCredito(11) FlexDebito(12) Errores(13) Resumen(14) Analizado(15)
      // - 14 columnas (esquema anterior, sin PX ni NC ML): Mes(0)
      //   VentasBrutas(1) VentasNetas(2) ComisionesML(3) ComisionesMP(4)
      //   Total(5) Recuperable(6) NetoRecibidoMP(7) Tasa(8) FlexCredito(9)
      //   FlexDebito(10) Errores(11) Resumen(12) Analizado(13)
      const rows: AuditHistorialRow[] = data.rows
        .filter((r: string[]) => r[0])
        .map((r: string[], i: number) => {
          const esquemaViejo = r.length <= 14;
          return {
            mes: r[0] ?? "",
            ventas_brutas: Number(r[1]) || 0,
            ventas_netas: Number(r[2]) || 0,
            comisiones_ml: Number(r[3]) || 0,
            comisiones_mp: Number(r[4]) || 0,
            comisiones_mp_px: esquemaViejo ? 0 : Number(r[5]) || 0,
            total_comisiones: Number(r[esquemaViejo ? 5 : 6]) || 0,
            notas_credito_ml: esquemaViejo ? 0 : Number(r[7]) || 0,
            recuperable: Number(r[esquemaViejo ? 6 : 8]) || 0,
            tasa_efectiva: Number(r[esquemaViejo ? 8 : 10]) || 0,
            errores: Number(r[esquemaViejo ? 11 : 13]) || 0,
            resumen: r[esquemaViejo ? 12 : 14] ?? "",
            analizado: r[esquemaViejo ? 13 : 15] ?? "",
            rowIndex: i + 1, // +1 porque fila 0 es el header en el Sheet
          };
        })
        .sort((a: AuditHistorialRow, b: AuditHistorialRow) => a.mes.localeCompare(b.mes)); // cronológico ascendente, para calcular variación mes a mes
      setHistorial(rows);
    } catch { /* silencioso */ }
  }

  async function loadRentabilidad() {
    try {
      const res = await fetch("/api/sheets-data?tab=Rentabilidad");
      const data = await res.json();
      if (!data.rows) return;
      // Columnas: IDOrden(0) Fecha(1) IDItem(2) Producto(3) PrecioVenta(4)
      // COGS(5) Comision(6) Envio(7) Perdida(8) MargenNeto(9) MargenPct(10) MultiItem(11) Analizado(12)
      const rows: RentabilidadRow[] = data.rows
        .filter((r: string[]) => r[0])
        .map((r: string[]) => ({
          idOrden: (r[0] ?? "").replace(/^'/, ""),
          fecha: r[1] ?? "",
          producto: r[3] ?? "",
          precioVenta: Number(r[4]) || 0,
          cogs: r[5] === "" || r[5] == null ? null : Number(r[5]),
          comision: Number(r[6]) || 0,
          envio: Number(r[7]) || 0,
          perdida: Number(r[8]) || 0,
          margenNeto: r[9] === "" || r[9] == null ? null : Number(r[9]),
          margenPct: r[10] === "" || r[10] == null ? null : Number(r[10]),
          multiItem: r[11] === "Sí",
        }));
      setRentabilidadRows(rows);
    } catch { /* silencioso */ }
  }

  async function loadForecast(customLeadTime?: number, customSafety?: number) {
    setLoadingForecast(true);
    try {
      const lt = customLeadTime ?? leadTimeDays;
      const sd = customSafety ?? safetyDays;
      const res = await fetch(`/api/forecast?leadTimeDays=${lt}&safetyDays=${sd}`);
      setForecastResult(await res.json());
    } catch {
      setForecastResult({ ok: false, error: "Error de red" });
    } finally {
      setLoadingForecast(false);
    }
  }

  async function loadMetrics(customPeriodo?: Periodo) {
    setLoadingMetrics(true);
    try {
      const p = customPeriodo ?? periodoMetrics;
      const res = await fetch(`/api/metrics?periodo=${p}`);
      setMetricsResult(await res.json());
    } catch {
      setMetricsResult({ ok: false, error: "Error de red" });
    } finally {
      setLoadingMetrics(false);
    }
  }

  function getFilasParaPedido(): ForecastRow[] {
    if (!forecastResult?.ok || !forecastResult.rows) return [];
    const prioridadesPedido: Prioridad[] = ["SIN_STOCK", "URGENTE", "PRONTO"];
    return forecastResult.rows.filter(
      r => prioridadesPedido.includes(r.prioridad) && r.cantidadSugerida > 0
    );
  }

  function descargarListaPedido() {
    const filas = getFilasParaPedido();
    if (filas.length === 0) return;

    const headers = [
      "PRODUCTO", "STOCK ACTUAL", "VENTAS 30 DÍAS", "VELOCIDAD DIARIA",
      "DÍAS RESTANTES", "FECHA ESTIMADA DE QUIEBRE", "CANTIDAD A PEDIR", "PRIORIDAD",
    ];
    const data = filas.map(r => [
      r.titulo,
      r.stockActual,
      r.ventas30d,
      r.velocidadDiaria,
      r.diasRestantes ?? "",
      r.fechaQuiebre ?? "",
      r.cantidadSugerida,
      r.prioridad,
    ]);

    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...data]);

    // Ancho de columna ajustado al contenido más largo de cada columna (con piso/techo)
    const MIN_WIDTH = 10;
    const MAX_WIDTH = 45;
    worksheet["!cols"] = headers.map((h, colIdx) => {
      const maxLen = Math.max(
        h.length,
        ...data.map(row => String(row[colIdx] ?? "").length)
      );
      return { wch: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, maxLen + 2)) };
    });

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Pedido sugerido");

    const fecha = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(workbook, `pedido-sugerido-${fecha}.xlsx`);
  }

  useEffect(() => {
    if (activeTab === "auditoria") loadHistorial();
    if (activeTab === "forecast") loadForecast();
    if (activeTab === "metricas") loadMetrics();
    if (activeTab === "rentabilidad") loadRentabilidad();
    if (activeTab === "comparador" && !comparadorResult) loadComparador(objetivoComparador);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  async function loadComparador(objetivoPct: number) {
    setLoadingComparador(true);
    try {
      const res = await fetch(`/api/comparador-mayor?objetivo=${objetivoPct / 100}`);
      const data = await res.json();
      setComparadorResult(data);
    } catch {
      setComparadorResult({ ok: false, error: "Error de red" });
    } finally {
      setLoadingComparador(false);
    }
  }

  // Detecta los meses reales contenidos en los archivos de Facturación ML/MP
  // apenas se suben — el nombre del archivo puede no coincidir con su
  // contenido (Fase 1 de validación de Auditoría lo confirmó), así que el mes
  // a auditar debe salir de las fechas reales, no de lo que el usuario adivine.
  useEffect(() => {
    const mlFile = auditFiles.facturacion_ml;
    const mpFile = auditFiles.csv_mp;
    if (!mlFile && !mpFile) {
      setMesesDetectados(null);
      return;
    }
    const fd = new FormData();
    if (mlFile) fd.append("file", mlFile);
    if (mpFile) fd.append("file", mpFile);
    setDetectandoMeses(true);
    fetch("/api/audit/detect-meses", { method: "POST", body: fd })
      .then(res => res.json())
      .then(json => {
        if (json.ok) setMesesDetectados({ ml: json.mesesML ?? [], mp: json.mesesMP ?? [] });
      })
      .catch(() => setMesesDetectados(null))
      .finally(() => setDetectandoMeses(false));
  }, [auditFiles.facturacion_ml, auditFiles.csv_mp]);

  async function handleSync() {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch("/api/ml-sync", { method: "POST" });
      const json = await res.json();
      setUltimoSyncPubOk(leerUltimoSyncPublicaciones());
      if (typeof json.publicaciones === "number") guardarUltimoSyncPublicaciones(json.timestamp ?? new Date().toISOString());
      setSyncResult(json);
      if (json.ok) loadVentasSemana();
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

  async function handleBackfillShipping() {
    setBackfilling(true);
    setBackfillError(null);
    setBackfillProgreso({ procesadas: 0, nuevasEnCache: 0 });
    setBackfillTotales({ http429: 0, http404: 0, sinEnvio: 0, errores: [] });
    backfillCancelado.current = false;
    try {
      // Loop automático: cada llamada procesa un lote limitado por el
      // maxDuration del endpoint. Mientras "completo" venga false, todavía
      // queda backlog por resolver — seguimos llamando hasta terminar o
      // hasta que el usuario cancele.
      // El endpoint recorre ventanas de un día (de hoy hacia atrás, 120 días) y
      // devuelve cursorHastaMs para retomar donde quedó; sin progreso en una
      // corrida se corta para no quedar en un loop infinito.
      let cursorHastaMs: number | null = null;
      while (!backfillCancelado.current) {
        const res: Response = await fetch("/api/backfill-shipping", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dias: 120, cursorHastaMs }),
        });
        const data: { ok: boolean; error?: string; procesadas: number; nuevasEnCache: number; completo: boolean; cursorHastaMs: number | null; sinEnvio: number; errores: { http429: number; http404: number }; erroresValidacion: string[] } = await res.json();
        if (!data.ok) {
          setBackfillError(data.error ?? "Error de red");
          break;
        }
        setBackfillProgreso(prev => ({
          procesadas: prev.procesadas + data.procesadas,
          nuevasEnCache: prev.nuevasEnCache + data.nuevasEnCache,
        }));
        setBackfillTotales(prev => ({
          http429: prev.http429 + data.errores.http429,
          http404: prev.http404 + data.errores.http404,
          sinEnvio: prev.sinEnvio + data.sinEnvio,
          errores: [...prev.errores, ...data.erroresValidacion].slice(0, 20),
        }));
        if (data.completo) break;
        if (data.cursorHastaMs === cursorHastaMs && data.nuevasEnCache === 0) {
          setBackfillError("Sin progreso: revisá los errores de /shipments y reintentá");
          break;
        }
        cursorHastaMs = data.cursorHastaMs;
      }
    } catch {
      setBackfillError("Error de red");
    } finally {
      setBackfilling(false);
    }
  }

  async function handleAnalizarRentabilidad() {
    setAnalizandoRentabilidad(true);
    setErrorRentabilidad(null);
    setProgresoRentabilidad({ filasProcesadas: 0, ordenesNuevas: 0, multiItemDetectadas: 0 });
    rentabilidadCancelado.current = false;
    try {
      // Mismo patrón que handleBackfillShipping: la Billing API tiene rate
      // limit de 5 req/min, así que un mes completo necesita varias
      // invocaciones — seguimos llamando hasta "completo" o cancelación.
      while (!rentabilidadCancelado.current) {
        const res = await fetch("/api/rentabilidad/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mes: mesRentabilidad }),
        });
        const data = await res.json();
        if (!data.ok) {
          setErrorRentabilidad(data.error ?? "Error de red");
          break;
        }
        setProgresoRentabilidad(prev => ({
          filasProcesadas: prev.filasProcesadas + data.filasProcesadas,
          ordenesNuevas: prev.ordenesNuevas + data.ordenesNuevas,
          multiItemDetectadas: prev.multiItemDetectadas + data.multiItemDetectadas,
        }));
        if (data.completo) break;
      }
      await loadRentabilidad();
    } catch {
      setErrorRentabilidad("Error de red");
    } finally {
      setAnalizandoRentabilidad(false);
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
    if (analyzingRef.current) return; // guarda síncrona contra doble click en el mismo frame
    const hasFile = Object.values(auditFiles).some(f => f !== null);
    if (!hasFile) return;

    analyzingRef.current = true;
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
      analyzingRef.current = false;
      setAnalyzing(false);
    }
  }

  const productosRestantes = deletedResult?.productos ?? [];

  return (
    <main className="min-h-screen" style={{ backgroundColor: "#f5f5f5" }}>

      {/* Header */}
      <div style={{ backgroundColor: "#C41230" }} className="px-4 py-3 sm:px-8 sm:py-5 shadow-md">
        <div className="max-w-4xl mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 sm:gap-4 min-w-0">
            <Image src="/logo.png" alt="La Mundial" width={80} height={80} className="object-contain rounded-lg bg-white p-1 w-12 h-12 sm:w-20 sm:h-20 shrink-0" />
            <div className="min-w-0">
              <h1 className="text-lg sm:text-xl font-bold text-white tracking-wide whitespace-nowrap">ML Tracker</h1>
              <p className="hidden sm:block text-red-200 text-sm">Panel de Mercado Libre</p>
            </div>
          </div>
          <div className="flex items-center gap-2 min-w-0">
            <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${mlStatus === null ? "bg-gray-300" : mlStatus.ok ? "bg-green-400" : "bg-red-300"}`} />
            <span className="text-white text-xs sm:text-sm truncate max-w-[9.5rem] sm:max-w-none">
              {mlStatus === null ? "Conectando..." : mlStatus.ok ? mlStatus.nickname : "Sin conexión"}
            </span>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 pt-4 sm:pt-6">
        <div className="flex gap-1 bg-white rounded-2xl border border-gray-200 shadow-sm p-1 w-full sm:w-fit max-w-full overflow-x-auto snap-x snap-mandatory [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <button onClick={() => setActiveTab("tablero")}
            className={`px-4 sm:px-5 py-2 rounded-xl font-semibold text-sm transition-colors whitespace-nowrap shrink-0 snap-start ${activeTab === "tablero" ? "text-white" : "text-gray-500 hover:text-gray-700"}`}
            style={activeTab === "tablero" ? { backgroundColor: "#C41230" } : {}}>
            Tablero
          </button>
          <button onClick={() => setActiveTab("sync")}
            className={`px-4 sm:px-5 py-2 rounded-xl font-semibold text-sm transition-colors whitespace-nowrap shrink-0 snap-start ${activeTab === "sync" ? "text-white" : "text-gray-500 hover:text-gray-700"}`}
            style={activeTab === "sync" ? { backgroundColor: "#C41230" } : {}}>
            Publicaciones
          </button>
          <button onClick={() => setActiveTab("auditoria")}
            className={`px-4 sm:px-5 py-2 rounded-xl font-semibold text-sm transition-colors whitespace-nowrap shrink-0 snap-start ${activeTab === "auditoria" ? "text-white" : "text-gray-500 hover:text-gray-700"}`}
            style={activeTab === "auditoria" ? { backgroundColor: "#C41230" } : {}}>
            Auditoría
          </button>
          <button onClick={() => setActiveTab("forecast")}
            className={`px-4 sm:px-5 py-2 rounded-xl font-semibold text-sm transition-colors whitespace-nowrap shrink-0 snap-start ${activeTab === "forecast" ? "text-white" : "text-gray-500 hover:text-gray-700"}`}
            style={activeTab === "forecast" ? { backgroundColor: "#C41230" } : {}}>
            Forecast
          </button>
          <button onClick={() => setActiveTab("metricas")}
            className={`px-4 sm:px-5 py-2 rounded-xl font-semibold text-sm transition-colors whitespace-nowrap shrink-0 snap-start ${activeTab === "metricas" ? "text-white" : "text-gray-500 hover:text-gray-700"}`}
            style={activeTab === "metricas" ? { backgroundColor: "#C41230" } : {}}>
            Métricas
          </button>
          <button onClick={() => setActiveTab("rentabilidad")}
            className={`px-4 sm:px-5 py-2 rounded-xl font-semibold text-sm transition-colors whitespace-nowrap shrink-0 snap-start ${activeTab === "rentabilidad" ? "text-white" : "text-gray-500 hover:text-gray-700"}`}
            style={activeTab === "rentabilidad" ? { backgroundColor: "#C41230" } : {}}>
            Rentabilidad
          </button>
          <button onClick={() => setActiveTab("comparador")}
            className={`px-4 sm:px-5 py-2 rounded-xl font-semibold text-sm transition-colors whitespace-nowrap shrink-0 snap-start ${activeTab === "comparador" ? "text-white" : "text-gray-500 hover:text-gray-700"}`}
            style={activeTab === "comparador" ? { backgroundColor: "#C41230" } : {}}>
            Comparador vs Mayor
          </button>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-4 sm:py-6 space-y-5">

        {/* === TAB: TABLERO === */}
        {activeTab === "tablero" && <Tablero />}

        {/* === TAB: PUBLICACIONES === */}
        {activeTab === "sync" && (
          <>
            {/* Botones */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-6 space-y-4">
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

              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-6 space-y-4">
                <div>
                  <h2 className="font-bold text-gray-900 text-lg">Detectar eliminados</h2>
                  <p className="text-sm text-gray-500 mt-1">Detecta productos que ya no existen en ML y los marca en el Sheet.</p>
                </div>
                <button onClick={handleDetectDeleted} disabled={detecting || !mlStatus?.ok}
                  className="w-full bg-gray-900 hover:bg-black disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold py-3 px-4 rounded-xl">
                  {detecting ? <><Spinner />Detectando...</> : "Detectar eliminados"}
                </button>
              </div>

              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-6 space-y-4">
                <div>
                  <h2 className="font-bold text-gray-900 text-lg">Historial de envíos</h2>
                  <p className="text-sm text-gray-500 mt-1">Completa el tipo de envío (Full u otro) de las ventas de los últimos 120 días (sin canceladas).</p>
                </div>
                {backfilling ? (
                  <div className="space-y-2">
                    <p className="text-sm text-gray-600">
                      Procesadas: {backfillProgreso.procesadas} · Nuevas en caché: {backfillProgreso.nuevasEnCache}
                    </p>
                    <button onClick={() => { backfillCancelado.current = true; }}
                      className="w-full bg-gray-200 hover:bg-gray-300 text-gray-800 font-bold py-3 px-4 rounded-xl">
                      Cancelar
                    </button>
                  </div>
                ) : (
                  <button onClick={handleBackfillShipping} disabled={!mlStatus?.ok}
                    className="w-full bg-gray-900 hover:bg-black disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold py-3 px-4 rounded-xl">
                    Completar historial de envíos
                  </button>
                )}
                {backfillError && <p className="text-red-600 text-sm">✗ Error: {backfillError}</p>}
                {(backfillProgreso.procesadas > 0 || backfillTotales.sinEnvio > 0 || backfillTotales.http429 > 0 || backfillTotales.http404 > 0) && (
                  <div className="text-sm text-gray-500 space-y-1">
                    <p>429: {backfillTotales.http429} · 404: {backfillTotales.http404} · Sin envío: {backfillTotales.sinEnvio}</p>
                    {backfillTotales.errores.length > 0 && (
                      <ul className="list-disc pl-5 text-red-600">
                        {backfillTotales.errores.map((e, i) => <li key={i}>{e}</li>)}
                      </ul>
                    )}
                  </div>
                )}
                {!backfilling && backfillProgreso.procesadas > 0 && !backfillError && (
                  <p className="text-sm text-gray-500">
                    Última corrida: {backfillProgreso.procesadas} procesadas, {backfillProgreso.nuevasEnCache} nuevas en caché.
                  </p>
                )}
              </div>
            </div>

            {/* Log de sync */}
            {syncResult && (
              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-6 space-y-4">
                <h2 className="font-bold text-gray-900 text-lg">Log de sincronización</h2>
                {errorPublicaciones(syncResult) !== null && (
                  <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800 space-y-1" role="alert">
                    <p className="font-bold">✗ Publicaciones NO se sincronizó{abortoSinBorrar(errorPublicaciones(syncResult)!) ? "; no se borró nada. Reintenta." : ". Revisa la hoja Publicaciones antes de reintentar: el error pudo ocurrir después de limpiarla."}</p>
                    <p>{errorPublicaciones(syncResult)}</p>
                    {ultimoSyncPubOk && (
                      <p className="text-xs text-red-700">Último sync de Publicaciones correcto visto desde este navegador: {new Date(ultimoSyncPubOk).toLocaleString("es-CL")}</p>
                    )}
                  </div>
                )}
                {!syncResult.ok ? (
                  <p className="text-red-600 text-sm">✗ Error: {syncResult.error ?? "ver el detalle de arriba"}</p>
                ) : (
                  <>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      <div className="bg-gray-50 rounded-xl p-3 text-center">
                        {syncResult.publicaciones === null
                          ? <p className="text-lg font-bold text-red-600 leading-8">no sincronizó</p>
                          : <p className="text-2xl font-bold text-gray-900">{syncResult.publicaciones}</p>}
                        <p className="text-xs text-gray-500 mt-1">Publicaciones</p>
                      </div>
                      <div className="bg-gray-50 rounded-xl p-3 text-center">
                        <p className="text-2xl font-bold text-gray-900">{syncResult.ventas}</p>
                        <p className="text-xs text-gray-500 mt-1">Ventas totales</p>
                      </div>
                      <div className="bg-gray-50 rounded-xl p-3 text-center">
                        <p className="text-2xl font-bold text-gray-900">{syncResult.ventasNuevas?.length ?? 0}</p>
                        <p className="text-xs text-gray-500 mt-1">Ventas últimos 7 días</p>
                      </div>
                    </div>

                    {syncResult.coberturaCosto && syncResult.coberturaCosto.activasSinCosto > 0 && (
                      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 space-y-3">
                        <div>
                          <h3 className="font-semibold text-amber-900">
                            {syncResult.coberturaCosto.activasSinCosto} de {syncResult.coberturaCosto.activasTotal} publicaciones activas sin Costo cargado
                            {" "}({Math.round((syncResult.coberturaCosto.activasSinCosto / syncResult.coberturaCosto.activasTotal) * 100)}%)
                          </h3>
                          <p className="text-sm text-amber-700 mt-1">
                            Representan {syncResult.coberturaCosto.vendidosActivasSinCosto.toLocaleString("es-CL")} de{" "}
                            {(syncResult.coberturaCosto.vendidosActivasSinCosto + syncResult.coberturaCosto.vendidosActivasConCosto).toLocaleString("es-CL")}{" "}
                            unidades vendidas ({Math.round((syncResult.coberturaCosto.vendidosActivasSinCosto / Math.max(1, syncResult.coberturaCosto.vendidosActivasSinCosto + syncResult.coberturaCosto.vendidosActivasConCosto)) * 100)}%)
                            — sin Costo no se puede calcular margen ni ACOS de equilibrio para esos productos.
                          </p>
                        </div>
                        {syncResult.coberturaCosto.topSinCosto.length > 0 && (
                          <div className="space-y-1 max-h-64 overflow-y-auto">
                            {syncResult.coberturaCosto.topSinCosto.map((p) => (
                              <div key={p.id} className="flex items-center justify-between text-sm bg-white rounded-lg px-3 py-2">
                                <span className="text-gray-700 truncate flex-1 mr-3">{p.titulo}</span>
                                <span className="text-xs text-amber-700 font-medium bg-amber-100 px-2 py-0.5 rounded-full shrink-0">{p.vendidos} vendidos</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

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
                        <h3 className="font-semibold text-gray-800 mb-2">Ventas últimos 7 días</h3>
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

                    {(syncResult.erroresSync?.length ?? 0) > 0 && (
                      <div>
                        <h3 className="font-semibold text-red-700 mb-2">Errores de sincronización ({syncResult.erroresSync!.length})</h3>
                        <div className="space-y-1 max-h-48 overflow-y-auto">
                          {syncResult.erroresSync!.map((e, i) => (
                            <div key={i} className="text-sm bg-red-50 text-red-700 rounded-lg px-3 py-2">{e}</div>
                          ))}
                        </div>
                      </div>
                    )}

                    {(syncResult.erroresValidacion?.length ?? 0) > 0 && (
                      <div>
                        <h3 className="font-semibold text-amber-700 mb-2">Datos incompletos ({syncResult.erroresValidacion!.length})</h3>
                        <div className="space-y-1 max-h-48 overflow-y-auto">
                          {syncResult.erroresValidacion!.map((e, i) => (
                            <div key={i} className="text-sm bg-amber-50 text-amber-700 rounded-lg px-3 py-2">{e}</div>
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
              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-6 space-y-4">
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

            {/* Ventas de la semana desde el Sheet */}
            <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-6 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="font-bold text-gray-900 text-lg">Ventas de los últimos 7 días</h2>
                <button onClick={loadVentasSemana} disabled={loadingVentas}
                  className="text-xs text-gray-400 hover:text-gray-600 disabled:opacity-40 underline">
                  {loadingVentas ? "Cargando..." : "Actualizar"}
                </button>
              </div>
              {loadingVentas ? (
                <p className="text-sm text-gray-400"><Spinner />Cargando ventas del Sheet...</p>
              ) : ventasSemana.length === 0 ? (
                <p className="text-sm text-gray-400">No hay ventas registradas en los últimos 7 días. Sincroniza primero para actualizar el Sheet.</p>
              ) : (
                <>
                  <div className="flex items-center gap-4 text-sm">
                    <span className="font-semibold text-gray-700">{ventasSemana.length} venta{ventasSemana.length !== 1 ? "s" : ""}</span>
                    <span className="text-gray-400">·</span>
                    <span className="text-green-700 font-semibold">
                      Total: {formatCLP(ventasSemana.reduce((s, v) => s + v.total, 0))}
                    </span>
                  </div>
                  <div className="space-y-1 max-h-72 overflow-y-auto">
                    {ventasSemana.map((v, i) => (
                      <div key={i} className="text-sm bg-gray-50 rounded-lg px-3 py-2">
                        <div className="flex justify-between items-start gap-2">
                          <span className="text-gray-700 truncate flex-1">{v.titulo}</span>
                          <span className="font-semibold text-gray-900 shrink-0">{formatCLP(v.total)}</span>
                        </div>
                        <div className="text-gray-400 mt-0.5 text-xs">
                          Cant: {v.cantidad} · {v.comprador} · {v.fecha}
                          {v.orden && <span className="ml-2 font-mono text-gray-300">{v.orden}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>

            <RevisionPublicaciones mlOk={!!mlStatus?.ok} />

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
            <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-6 space-y-5">
              <div>
                <h2 className="font-bold text-gray-900 text-lg">Auditoría de comisiones</h2>
                <p className="text-sm text-gray-500 mt-1">Sube los reportes del mes para calcular las comisiones cobradas por ML/MP.</p>
              </div>

              {/* Selector de mes */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Mes a auditar</label>
                <input type="month" value={mes} onChange={e => setMes(e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ "--tw-ring-color": "#C41230" } as CSSProperties} />

                {/* Meses detectados por contenido real del archivo (no por su nombre) */}
                {detectandoMeses && <p className="text-xs text-gray-400 mt-1.5">Detectando meses en los archivos...</p>}
                {!detectandoMeses && mesesDetectados && (mesesDetectados.ml.length > 0 || mesesDetectados.mp.length > 0) && (
                  <div className="mt-2 text-xs">
                    <p className="text-gray-500 mb-1">Meses detectados en el contenido de los archivos (el nombre del archivo puede no coincidir):</p>
                    <div className="flex flex-wrap gap-1.5">
                      {[...new Map(
                        [...mesesDetectados.ml, ...mesesDetectados.mp].map(m => [`${m.year}-${m.month}`, m])
                      ).values()]
                        .sort((a, b) => a.year - b.year || a.month - b.month)
                        .map(m => {
                          const key = `${m.year}-${String(m.month).padStart(2, "0")}`;
                          const enML = mesesDetectados.ml.some(x => x.year === m.year && x.month === m.month);
                          const enMP = mesesDetectados.mp.some(x => x.year === m.year && x.month === m.month);
                          return (
                            <button key={key} onClick={() => setMes(key)}
                              className={`px-2 py-1 rounded-lg border ${mes === key ? "border-red-400 bg-red-50 text-red-700" : "border-gray-300 text-gray-600 hover:border-gray-400"}`}>
                              {key} {enML && enMP ? "(ML+MP)" : enML ? "(solo ML)" : "(solo MP)"}
                            </button>
                          );
                        })}
                    </div>
                    {mesesDetectados.ml.length > 0 && mesesDetectados.mp.length > 0 &&
                      !mesesDetectados.ml.some(a => mesesDetectados.mp.some(b => a.year === b.year && a.month === b.month)) && (
                        <p className="text-red-600 mt-1.5">⚠ ML y MP no comparten ningún mes en común — el análisis va a rechazar el cálculo.</p>
                      )}
                  </div>
                )}
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
                {analyzing ? <><Spinner />Analizando...</> : "Analizar"}
              </button>
            </div>

            {/* Resultado */}
            {auditResult && (
              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-6 space-y-5">
                {!auditResult.ok ? (
                  <p className="text-red-600 text-sm">✗ Error: {auditResult.error}</p>
                ) : auditResult.result?.error_cobertura ? (
                  <div className="rounded-xl border border-red-200 bg-red-50 p-4">
                    <p className="text-sm font-semibold text-red-700">✗ No se pudo calcular: mismatch de período entre archivos</p>
                    <p className="text-sm text-red-600 mt-1.5">{auditResult.result.error_cobertura}</p>
                  </div>
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

                    {/* Desglose PX: incluido en Comisiones MP de arriba, pero
                        mostrado aparte porque su clasificación como ML es una
                        asunción del usuario, no verificada por cruce de datos
                        (ver hallazgo Fase 1 de validación de Auditoría). */}
                    {auditResult.result.comisiones_mp_px !== 0 && (
                      <div className="rounded-xl border border-yellow-200 bg-yellow-50 p-3 text-sm">
                        <span className="font-semibold text-yellow-800">PX — asumido ML, no verificado: </span>
                        <span className="text-yellow-700">{formatCLP(auditResult.result.comisiones_mp_px)}</span>
                        <span className="text-yellow-600 text-xs block mt-1">
                          Ya incluido en Comisiones MP. No se pudo confirmar por cruce de datos si "PX" es tráfico del marketplace de ML o de otro canal (ej. Shopify) — se asumió ML según lo indicado por el usuario.
                        </span>
                      </div>
                    )}

                    {/* Comparación contra dashboard de Mercado Libre */}
                    {auditResult.referenciaML && (() => {
                      const ref = auditResult.referenciaML!;
                      const diferencia = auditResult.result!.ventas_brutas - ref.ventasBrutas;
                      const diferenciaPct = ref.ventasBrutas > 0 ? (diferencia / ref.ventasBrutas) * 100 : 0;
                      const coincide = Math.abs(diferenciaPct) < 5;
                      return (
                        <div className={`rounded-xl border p-4 ${coincide ? "bg-green-50 border-green-200" : "bg-yellow-50 border-yellow-200"}`}>
                          <p className="text-sm font-semibold text-gray-800">
                            {coincide ? "✓ Coincide con Mercado Libre" : "⚠ Diferencia vs. Mercado Libre"}
                          </p>
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-2 text-sm">
                            <div>
                              <p className="text-gray-500 text-xs">ML (API, {ref.cantidadVentas} ventas)</p>
                              <p className="font-bold text-gray-900">{formatCLP(ref.ventasBrutas)}</p>
                            </div>
                            <div>
                              <p className="text-gray-500 text-xs">Calculado en esta auditoría</p>
                              <p className="font-bold text-gray-900">{formatCLP(auditResult.result!.ventas_brutas)}</p>
                            </div>
                            <div>
                              <p className="text-gray-500 text-xs">Diferencia</p>
                              <p className={`font-bold ${coincide ? "text-green-700" : "text-yellow-700"}`}>
                                {diferencia >= 0 ? "+" : ""}{formatCLP(diferencia)} ({diferenciaPct >= 0 ? "+" : ""}{diferenciaPct.toFixed(1)}%)
                              </p>
                            </div>
                          </div>
                        </div>
                      );
                    })()}
                    {auditResult.result && !auditResult.referenciaML && (
                      <p className="text-xs text-gray-400">
                        No se pudo obtener la referencia de Mercado Libre para comparar (revisar conexión OAuth).
                      </p>
                    )}

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
              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-6 space-y-3">
                <h3 className="font-bold text-gray-900 text-lg">Historial por mes</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase tracking-wide">
                        <th className="pb-2 pr-4">Mes</th>
                        <th className="pb-2 pr-4 text-right">Ventas Brutas</th>
                        <th className="pb-2 pr-4 text-right">Var. Ventas</th>
                        <th className="pb-2 pr-4 text-right">Com. ML</th>
                        <th className="pb-2 pr-4 text-right">Com. MP</th>
                        <th className="pb-2 pr-4 text-right">Total Com.</th>
                        <th className="pb-2 pr-4 text-right">Var. Com.</th>
                        <th className="pb-2 pr-4 text-right">Tasa</th>
                        <th className="pb-2 pr-4 text-right">NC ML</th>
                        <th className="pb-2 pr-4 text-right">Recuperable</th>
                        <th className="pb-2 w-8"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {/* historial está ordenado cronológico ascendente (para calcular
                          variación % contra el mes anterior); se invierte solo al
                          renderizar para mostrar el más reciente arriba. */}
                      {[...historial].reverse().map((row) => {
                        const idx = historial.findIndex(h => h.rowIndex === row.rowIndex);
                        const anterior = idx > 0 ? historial[idx - 1] : null;
                        const varVentas = anterior && anterior.ventas_brutas > 0
                          ? ((row.ventas_brutas - anterior.ventas_brutas) / anterior.ventas_brutas) * 100
                          : null;
                        const varComisiones = anterior && anterior.total_comisiones > 0
                          ? ((row.total_comisiones - anterior.total_comisiones) / anterior.total_comisiones) * 100
                          : null;
                        const fmtVar = (v: number | null) => v === null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
                        const colorVar = (v: number | null, invertido = false) => {
                          if (v === null) return "text-gray-400";
                          const bueno = invertido ? v < 0 : v > 0;
                          return bueno ? "text-green-600" : v === 0 ? "text-gray-500" : "text-red-600";
                        };
                        return (
                        <Fragment key={row.rowIndex}>
                          <tr
                            className="hover:bg-gray-50 cursor-pointer group"
                            onClick={() => setExpandedMes(expandedMes === row.mes ? null : row.mes)}>
                            <td className="py-2.5 pr-4 font-semibold text-gray-800">{row.mes}</td>
                            <td className="py-2.5 pr-4 text-right text-gray-700">${Math.round(row.ventas_brutas).toLocaleString("es-CL")}</td>
                            <td className={`py-2.5 pr-4 text-right ${colorVar(varVentas)}`}>{fmtVar(varVentas)}</td>
                            <td className="py-2.5 pr-4 text-right text-orange-600">${Math.round(row.comisiones_ml).toLocaleString("es-CL")}</td>
                            <td className="py-2.5 pr-4 text-right text-orange-600">${Math.round(row.comisiones_mp).toLocaleString("es-CL")}</td>
                            <td className="py-2.5 pr-4 text-right font-semibold text-red-700">${Math.round(row.total_comisiones).toLocaleString("es-CL")}</td>
                            <td className={`py-2.5 pr-4 text-right ${colorVar(varComisiones, true)}`}>{fmtVar(varComisiones)}</td>
                            <td className="py-2.5 pr-4 text-right text-red-700">{Number(row.tasa_efectiva).toFixed(2)}%</td>
                            <td className="py-2.5 pr-4 text-right text-gray-600">${Math.round(row.notas_credito_ml).toLocaleString("es-CL")}</td>
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
                              <td colSpan={11} className="py-2 pb-3">
                                <div className="bg-gray-50 rounded-xl px-4 py-3 text-xs text-gray-600 space-y-1">
                                  <p>{row.resumen}</p>
                                  {row.comisiones_mp_px !== 0 && (
                                    <p className="text-yellow-700">PX — asumido ML, no verificado: {formatCLP(row.comisiones_mp_px)}</p>
                                  )}
                                  <p className="text-gray-400">Analizado: {row.analizado}</p>
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}

        {/* === TAB: FORECAST === */}
        {activeTab === "forecast" && (
          <>
            <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-6 space-y-5">
              <div>
                <h2 className="font-bold text-gray-900 text-lg">Reposición sugerida</h2>
                <p className="text-sm text-gray-500 mt-1">Calcula qué productos pedir según la velocidad de venta de los últimos 30 días.</p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-end">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Tiempo de reposición (días)</label>
                  <input type="number" min={1} value={leadTimeDays}
                    onChange={e => setLeadTimeDays(Number(e.target.value) || 0)}
                    className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Margen de seguridad (días)</label>
                  <input type="number" min={0} value={safetyDays}
                    onChange={e => setSafetyDays(Number(e.target.value) || 0)}
                    className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm" />
                </div>
                <button onClick={() => loadForecast()} disabled={loadingForecast}
                  className="font-bold py-2.5 px-4 rounded-xl text-white disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ backgroundColor: "#C41230" }}>
                  {loadingForecast ? <><Spinner />Calculando...</> : "Recalcular"}
                </button>
              </div>
            </div>

            {forecastResult && !forecastResult.ok && (
              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-6">
                <p className="text-red-600 text-sm">✗ Error: {forecastResult.error}</p>
              </div>
            )}

            {forecastResult?.ok && forecastResult.rows && (
              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 flex items-center justify-between">
                {getFilasParaPedido().length > 0 ? (
                  <>
                    <p className="text-sm text-gray-500">
                      {getFilasParaPedido().length} producto{getFilasParaPedido().length === 1 ? "" : "s"} con reposición pendiente
                    </p>
                    <button onClick={descargarListaPedido}
                      className="font-bold py-2.5 px-4 rounded-xl text-white"
                      style={{ backgroundColor: "#0F9D58" }}>
                      Descargar lista de pedido
                    </button>
                  </>
                ) : (
                  <>
                    <p className="text-sm text-gray-500">Nada que pedir por ahora</p>
                    <button disabled
                      className="font-bold py-2.5 px-4 rounded-xl text-white opacity-40 cursor-not-allowed"
                      style={{ backgroundColor: "#0F9D58" }}>
                      Descargar lista de pedido
                    </button>
                  </>
                )}
              </div>
            )}

            {forecastResult?.ok && forecastResult.rows && (
              <>
                {/* Tarjetas resumen */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  {([
                    { key: "SIN_STOCK", label: "Sin stock", color: "#DC2626" },
                    { key: "URGENTE", label: "Urgente", color: "#DC2626" },
                    { key: "PRONTO", label: "Pronto", color: "#D97706" },
                    { key: "OK", label: "OK", color: "#059669" },
                  ] as const).map(({ key, label, color }) => (
                    <div key={key} className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4">
                      <p className="text-sm text-gray-500">{label}</p>
                      <p className="text-2xl font-bold" style={{ color }}>
                        {forecastResult.rows!.filter(r => r.prioridad === key).length}
                      </p>
                    </div>
                  ))}
                </div>

                {/* Filtro + tabla */}
                <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-gray-800">Detalle por producto</h3>
                    <select value={filtroPrioridad} onChange={e => setFiltroPrioridad(e.target.value as Prioridad | "TODOS")}
                      className="border border-gray-300 rounded-xl px-3 py-1.5 text-sm">
                      <option value="TODOS">Todas las prioridades</option>
                      <option value="SIN_STOCK">Sin stock</option>
                      <option value="URGENTE">Urgente</option>
                      <option value="PRONTO">Pronto</option>
                      <option value="OK">OK</option>
                      <option value="SIN_DATOS">Sin datos</option>
                    </select>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-gray-500 border-b border-gray-200">
                          <th className="py-2 pr-3">Producto</th>
                          <th className="py-2 pr-3">Stock</th>
                          <th className="py-2 pr-3">Ventas 30d</th>
                          <th className="py-2 pr-3">Vel. diaria</th>
                          <th className="py-2 pr-3">Días rest.</th>
                          <th className="py-2 pr-3">Quiebre est.</th>
                          <th className="py-2 pr-3">Pedir</th>
                          <th className="py-2 pr-3">Prioridad</th>
                        </tr>
                      </thead>
                      <tbody>
                        {forecastResult.rows!
                          .filter(r => filtroPrioridad === "TODOS" || r.prioridad === filtroPrioridad)
                          .map((r) => {
                            const badge = {
                              SIN_STOCK: "bg-red-100 text-red-700",
                              URGENTE: "bg-red-100 text-red-700",
                              PRONTO: "bg-amber-100 text-amber-700",
                              OK: "bg-green-100 text-green-700",
                              SIN_DATOS: "bg-gray-100 text-gray-500",
                            }[r.prioridad];
                            return (
                              <tr key={r.id} className="border-b border-gray-100 last:border-0">
                                <td className="py-2 pr-3 text-gray-800 max-w-xs truncate">{r.titulo}</td>
                                <td className="py-2 pr-3 text-gray-700">{r.stockActual}</td>
                                <td className="py-2 pr-3 text-gray-700">{r.ventas30d}</td>
                                <td className="py-2 pr-3 text-gray-700">{r.velocidadDiaria}</td>
                                <td className="py-2 pr-3 text-gray-700">{r.diasRestantes ?? "-"}</td>
                                <td className="py-2 pr-3 text-gray-700">{r.fechaQuiebre ?? "-"}</td>
                                <td className="py-2 pr-3 font-semibold text-gray-900">{r.cantidadSugerida || "-"}</td>
                                <td className="py-2 pr-3">
                                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${badge}`}>{r.prioridad}</span>
                                </td>
                              </tr>
                            );
                          })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </>
        )}

        {/* === TAB: MÉTRICAS === */}
        {activeTab === "metricas" && (
          <>
            <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-6 space-y-5">
              <div>
                <h2 className="font-bold text-gray-900 text-lg">Métricas</h2>
                <p className="text-sm text-gray-500 mt-1">Ventas, reputación y conversión, calculados en vivo contra Mercado Libre.</p>
              </div>

              <div className="flex items-center gap-3">
                <div className="flex gap-1 bg-gray-100 rounded-xl p-1">
                  {([
                    { key: "dia", label: "Hoy" },
                    { key: "semana", label: "7 días" },
                    { key: "mes", label: "Este mes" },
                  ] as const).map(({ key, label }) => (
                    <button key={key}
                      onClick={() => { setPeriodoMetrics(key); loadMetrics(key); }}
                      className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors ${periodoMetrics === key ? "bg-white shadow-sm text-gray-900" : "text-gray-500 hover:text-gray-700"}`}>
                      {label}
                    </button>
                  ))}
                </div>
                {loadingMetrics && <Spinner />}
              </div>
            </div>

            {metricsResult && !metricsResult.ok && (
              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-6">
                <p className="text-red-600 text-sm">✗ Error: {metricsResult.error}</p>
              </div>
            )}

            {metricsResult?.ok && (
              <>
                {/* Ventas */}
                <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-6 space-y-4">
                  <h3 className="font-semibold text-gray-800">Ventas</h3>
                  {metricsResult.ventas?.ok ? (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                      <div>
                        <p className="text-sm text-gray-500">Total vendido</p>
                        <p className="text-xl font-bold text-gray-900">${(metricsResult.ventas.totalVendido ?? 0).toLocaleString("es-CL")}</p>
                        <VariacionBadge variacion={metricsResult.ventas.comparacion?.totalVendido} />
                      </div>
                      <div>
                        <p className="text-sm text-gray-500">Unidades</p>
                        <p className="text-xl font-bold text-gray-900">{metricsResult.ventas.unidades ?? 0}</p>
                        <VariacionBadge variacion={metricsResult.ventas.comparacion?.unidades} />
                      </div>
                      <div>
                        <p className="text-sm text-gray-500">Órdenes</p>
                        <p className="text-xl font-bold text-gray-900">{metricsResult.ventas.cantidadOrdenes ?? 0}</p>
                      </div>
                      <div>
                        <p className="text-sm text-gray-500">Ticket promedio</p>
                        <p className="text-xl font-bold text-gray-900">${(metricsResult.ventas.ticketPromedio ?? 0).toLocaleString("es-CL")}</p>
                        <VariacionBadge variacion={metricsResult.ventas.comparacion?.ticketPromedio} />
                      </div>
                      {metricsResult.ventas.porLogistica && (
                        <div className="col-span-2 sm:col-span-4 border-t border-gray-100 pt-3 text-sm text-gray-600 space-y-1">
                          <p className="font-medium text-gray-700">Ingreso por tipo logístico (tipo real de cada orden)</p>
                          <p>
                            {Object.entries(metricsResult.ventas.porLogistica.porGrupo)
                              .filter(([, g]) => g.ingreso > 0)
                              .map(([nombre, g]) => `${nombre}: ${formatCLP(g.ingreso)} (${g.pct}%)`)
                              .join(" · ") || "Sin ventas con tipo real"}
                          </p>
                          <p className="text-xs text-gray-400">
                            {metricsResult.ventas.porLogistica.real.pct}% del ingreso con tipo real
                            {metricsResult.ventas.porLogistica.respaldo.pct > 0 ? ` · ${metricsResult.ventas.porLogistica.respaldo.pct}% en respaldo (tipo actual de la publicación: Full ${formatCLP(metricsResult.ventas.porLogistica.respaldoPorTipo.full)}, no Full ${formatCLP(metricsResult.ventas.porLogistica.respaldoPorTipo.noFull)})` : ""}
                            {metricsResult.ventas.porLogistica.sinDato.pct > 0 ? ` · ${metricsResult.ventas.porLogistica.sinDato.pct}% sin dato` : ""}
                          </p>
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm text-gray-400">No disponible por ahora{metricsResult.ventas?.error ? ` (${metricsResult.ventas.error})` : ""}.</p>
                  )}
                </div>

                {/* Ranking de productos */}
                <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-6 space-y-4">
                  <h3 className="font-semibold text-gray-800">Ranking de productos</h3>
                  {metricsResult.ventas?.ok ? (
                    (metricsResult.ventas.ranking?.length ?? 0) > 0 ? (
                      <>
                      <ListaRankingMovil ranking={metricsResult.ventas.ranking!} />
                      <div className="hidden md:block overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-left text-gray-500 border-b border-gray-200">
                              <th className="py-2 pr-3">#</th>
                              <th className="py-2 pr-3">Producto</th>
                              <th className="py-2 pr-3 text-right">Monto</th>
                              <th className="py-2 pr-3 text-right">Unidades</th>
                            </tr>
                          </thead>
                          <tbody>
                            {metricsResult.ventas.ranking!.map((p, i) => (
                              <tr key={p.id} className="border-b border-gray-100 last:border-0">
                                <td className="py-2 pr-3 text-gray-400">{i + 1}</td>
                                <td className="py-2 pr-3 text-gray-800 max-w-xs truncate">{p.titulo}</td>
                                <td className="py-2 pr-3 text-right text-gray-900 font-semibold">{formatCLP(p.monto)}</td>
                                <td className="py-2 pr-3 text-right text-gray-700">{p.unidades}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      </>
                    ) : (
                      <p className="text-sm text-gray-400">Sin ventas en el período.</p>
                    )
                  ) : (
                    <p className="text-sm text-gray-400">No disponible por ahora{metricsResult.ventas?.error ? ` (${metricsResult.ventas.error})` : ""}.</p>
                  )}
                </div>

                {/* Reputación */}
                <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-6 space-y-4">
                  <h3 className="font-semibold text-gray-800">Reputación</h3>
                  {metricsResult.reputacion?.ok ? (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                      <div>
                        <p className="text-sm text-gray-500">Nivel</p>
                        <p className="text-xl font-bold text-gray-900">{metricsResult.reputacion.levelId ?? "-"}</p>
                      </div>
                      <div>
                        <p className="text-sm text-gray-500">Power Seller</p>
                        <p className="text-xl font-bold text-gray-900 capitalize">{metricsResult.reputacion.powerSellerStatus ?? "-"}</p>
                      </div>
                      <div>
                        <p className="text-sm text-gray-500">Ventas completadas</p>
                        <p className="text-xl font-bold text-gray-900">{metricsResult.reputacion.ventasCompletadas ?? 0}</p>
                      </div>
                      <div>
                        <p className="text-sm text-gray-500">Cancelaciones</p>
                        <p className="text-xl font-bold text-gray-900">{metricsResult.reputacion.ventasCanceladas ?? 0}</p>
                      </div>
                      {metricsResult.reputacion.claims && (
                        <div>
                          <p className="text-sm text-gray-500">Reclamos ({metricsResult.reputacion.claims.period})</p>
                          <p className="text-xl font-bold text-gray-900">{metricsResult.reputacion.claims.value} <span className="text-sm font-normal text-gray-400">({(metricsResult.reputacion.claims.rate * 100).toFixed(2)}%)</span></p>
                        </div>
                      )}
                      {metricsResult.reputacion.cancellations && (
                        <div>
                          <p className="text-sm text-gray-500">Cancelaciones ({metricsResult.reputacion.cancellations.period})</p>
                          <p className="text-xl font-bold text-gray-900">{metricsResult.reputacion.cancellations.value} <span className="text-sm font-normal text-gray-400">({(metricsResult.reputacion.cancellations.rate * 100).toFixed(2)}%)</span></p>
                        </div>
                      )}
                      {metricsResult.reputacion.delayedHandlingTime && (
                        <div>
                          <p className="text-sm text-gray-500">Despacho tardío ({metricsResult.reputacion.delayedHandlingTime.period})</p>
                          <p className="text-xl font-bold text-gray-900">{metricsResult.reputacion.delayedHandlingTime.value} <span className="text-sm font-normal text-gray-400">({(metricsResult.reputacion.delayedHandlingTime.rate * 100).toFixed(2)}%)</span></p>
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm text-gray-400">No disponible por ahora{metricsResult.reputacion?.error ? ` (${metricsResult.reputacion.error})` : ""}.</p>
                  )}
                </div>

                {/* A pedido: reclamos por tipo logístico, con la misma ventana del período */}
                {metricsResult.desde && metricsResult.hasta && (
                  <ReclamosPorTipo key={`${metricsResult.desde}|${metricsResult.hasta}`} desde={metricsResult.desde} hasta={metricsResult.hasta} titulo="Reclamos por tipo logístico (período seleccionado)" />
                )}

                {/* Visitas y conversión */}
                <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-6 space-y-4">
                  <h3 className="font-semibold text-gray-800">Visitas y conversión</h3>
                  {metricsResult.visitas?.ok ? (
                    <>
                      <p className="text-sm text-gray-500">Total de visitas en el período: <span className="font-bold text-gray-900">{(metricsResult.visitas.totalVisitas ?? 0).toLocaleString("es-CL")}</span></p>
                      {(metricsResult.visitas.porPublicacion?.length ?? 0) > 0 && (
                        <>
                        <ListaVisitasMovil filas={metricsResult.visitas.porPublicacion!} />
                        <div className="hidden md:block overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="text-left text-gray-500 border-b border-gray-200">
                                <th className="py-2 pr-3">Producto</th>
                                <th className="py-2 pr-3">Visitas</th>
                                <th className="py-2 pr-3">Ventas</th>
                                <th className="py-2 pr-3">Conversión</th>
                              </tr>
                            </thead>
                            <tbody>
                              {metricsResult.visitas.porPublicacion!.map((v) => (
                                <tr key={v.id} className="border-b border-gray-100 last:border-0">
                                  <td className="py-2 pr-3 text-gray-800 max-w-xs truncate">{v.titulo}</td>
                                  <td className="py-2 pr-3 text-gray-700">{v.visitas}</td>
                                  <td className="py-2 pr-3 text-gray-700">{v.ventas}</td>
                                  <td className="py-2 pr-3 text-gray-700">{v.conversion !== null ? `${v.conversion}%` : "-"}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        </>
                      )}
                    </>
                  ) : (
                    <p className="text-sm text-gray-400">No disponible por ahora{metricsResult.visitas?.error ? ` (${metricsResult.visitas.error})` : ""}.</p>
                  )}
                </div>

                {/* Preguntas */}
                <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-6 space-y-4">
                  <h3 className="font-semibold text-gray-800">Preguntas</h3>
                  {metricsResult.preguntas?.ok ? (
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                      <div>
                        <p className="text-sm text-gray-500">Total del período</p>
                        <p className="text-xl font-bold text-gray-900">{metricsResult.preguntas.total ?? 0}</p>
                      </div>
                      <div>
                        <p className="text-sm text-gray-500">Sin responder</p>
                        <p className="text-xl font-bold text-gray-900">{metricsResult.preguntas.sinResponder ?? 0}</p>
                      </div>
                      <div>
                        <p className="text-sm text-gray-500">Tiempo de respuesta promedio</p>
                        <p className="text-xl font-bold text-gray-900">
                          {metricsResult.preguntas.tiempoRespuestaPromedioHoras !== null && metricsResult.preguntas.tiempoRespuestaPromedioHoras !== undefined
                            ? `${metricsResult.preguntas.tiempoRespuestaPromedioHoras}h`
                            : "-"}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-gray-400">No disponible por ahora{metricsResult.preguntas?.error ? ` (${metricsResult.preguntas.error})` : ""}.</p>
                  )}
                </div>

                {/* Reclamos */}
                <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-6 space-y-4">
                  <h3 className="font-semibold text-gray-800">Reclamos</h3>
                  {metricsResult.reclamos?.ok ? (
                    <>
                      <p className="text-sm text-gray-500">Total del período: <span className="font-bold text-gray-900">{metricsResult.reclamos.total ?? 0}</span></p>
                      {metricsResult.reclamos.porStatus && Object.keys(metricsResult.reclamos.porStatus).length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {Object.entries(metricsResult.reclamos.porStatus).map(([status, cant]) => (
                            <span key={status} className="text-xs font-medium bg-gray-100 text-gray-700 rounded-full px-3 py-1">
                              {status}: {cant}
                            </span>
                          ))}
                        </div>
                      )}
                      {metricsResult.reclamos.porTipo && Object.keys(metricsResult.reclamos.porTipo).length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {Object.entries(metricsResult.reclamos.porTipo).map(([tipo, cant]) => (
                            <span key={tipo} className="text-xs font-medium bg-blue-50 text-blue-700 rounded-full px-3 py-1">
                              {tipo}: {cant}
                            </span>
                          ))}
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="text-sm text-gray-400">No disponible por ahora{metricsResult.reclamos?.error ? ` (${metricsResult.reclamos.error})` : ""}.</p>
                  )}
                </div>

                {/* ROAS / Publicidad */}
                <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-6 space-y-4">
                  <h3 className="font-semibold text-gray-800">ROAS / Publicidad</h3>
                  {metricsResult.roas?.ok ? (
                    <>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                        <div>
                          <p className="text-sm text-gray-500">Inversión total</p>
                          <p className="text-xl font-bold text-gray-900">${(metricsResult.roas.inversionTotal ?? 0).toLocaleString("es-CL")}</p>
                        </div>
                        <div>
                          <p className="text-sm text-gray-500">Ventas atribuidas</p>
                          <p className="text-xl font-bold text-gray-900">${(metricsResult.roas.ventasAtribuidasTotal ?? 0).toLocaleString("es-CL")}</p>
                        </div>
                        <div>
                          <p className="text-sm text-gray-500">ROAS agregado</p>
                          <p className="text-xl font-bold text-gray-900">
                            {metricsResult.roas.roasAgregado !== null && metricsResult.roas.roasAgregado !== undefined
                              ? metricsResult.roas.roasAgregado.toFixed(2)
                              : "-"}
                          </p>
                        </div>
                      </div>
                      {(metricsResult.roas.campanas?.length ?? 0) > 0 && (
                        <>
                        <TarjetasCampanas campanas={metricsResult.roas.campanas!} />
                        <div className="hidden md:block overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="text-left text-gray-500 border-b border-gray-200">
                                <th className="py-2 pr-3">Campaña</th>
                                <th className="py-2 pr-3">Estado</th>
                                <th className="py-2 pr-3">Estrategia</th>
                                <th className="py-2 pr-3">Presup. diario</th>
                                <th className="py-2 pr-3">Uso presup.</th>
                                <th className="py-2 pr-3">Clics</th>
                                <th className="py-2 pr-3">Impresiones</th>
                                <th className="py-2 pr-3">CTR</th>
                                <th className="py-2 pr-3">CPC</th>
                                <th className="py-2 pr-3">Costo</th>
                                <th className="py-2 pr-3">Directo</th>
                                <th className="py-2 pr-3">Indirecto</th>
                                <th className="py-2 pr-3">ROAS</th>
                                <th className="py-2 pr-3">ACOS</th>
                                <th className="py-2 pr-3">ACOS target</th>
                                <th className="py-2 pr-3">Uds. orgánicas</th>
                                <th className="py-2 pr-3">Monto orgánico</th>
                              </tr>
                            </thead>
                            <tbody>
                              {metricsResult.roas.campanas!.map((c) => (
                                <tr key={c.id} className="border-b border-gray-100 last:border-0">
                                  <td className="py-2 pr-3 text-gray-800 max-w-xs truncate">{c.nombre}</td>
                                  <td className="py-2 pr-3 text-gray-700 capitalize">{c.estado}</td>
                                  <td className="py-2 pr-3 text-gray-700 capitalize">{c.estrategia}</td>
                                  <td className="py-2 pr-3 text-gray-700">${c.presupuestoDiario.toLocaleString("es-CL")}</td>
                                  <td className="py-2 pr-3 text-gray-700">{c.usoPresupuesto !== null ? `${c.usoPresupuesto}%` : "-"}</td>
                                  <td className="py-2 pr-3 text-gray-700">{c.clics}</td>
                                  <td className="py-2 pr-3 text-gray-700">{c.impresiones}</td>
                                  <td className="py-2 pr-3 text-gray-700">{c.ctr}%</td>
                                  <td className="py-2 pr-3 text-gray-700">${c.cpc.toLocaleString("es-CL")}</td>
                                  <td className="py-2 pr-3 text-gray-700">${c.costo.toLocaleString("es-CL")}</td>
                                  <td className="py-2 pr-3 text-gray-700">${c.montoDirecto.toLocaleString("es-CL")}</td>
                                  <td className="py-2 pr-3 text-gray-700">${c.montoIndirecto.toLocaleString("es-CL")}</td>
                                  <td className="py-2 pr-3 text-gray-700">{c.costo > 0 ? c.roas.toFixed(2) : "sin actividad en el período"}</td>
                                  <td className="py-2 pr-3 text-gray-700">{c.costo > 0 ? `${c.acos}%` : "-"}</td>
                                  <td className="py-2 pr-3 text-gray-700">{c.acosTarget}%</td>
                                  <td className="py-2 pr-3 text-gray-700">{c.unidadesOrganicas}</td>
                                  <td className="py-2 pr-3 text-gray-700">${c.montoOrganico.toLocaleString("es-CL")}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        </>
                      )}
                    </>
                  ) : (
                    <p className="text-sm text-gray-400">No disponible por ahora{metricsResult.roas?.error ? ` (${metricsResult.roas.error})` : ""}.</p>
                  )}
                </div>

                {/* Tabla por producto */}
                <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-6 space-y-4">
                  <h3 className="font-semibold text-gray-800">Tabla por producto</h3>
                  {metricsResult.tablaProductos?.ok ? (
                    (metricsResult.tablaProductos.filas?.length ?? 0) > 0 ? (
                      <>
                      <TarjetasProductos filas={metricsResult.tablaProductos.filas!} />
                      <div className="hidden md:block overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-left text-gray-500 border-b border-gray-200">
                              <th className="py-2 pr-3">Producto</th>
                              <th className="py-2 pr-3">Etiquetas</th>
                              <th className="py-2 pr-3">Ventas $</th>
                              <th className="py-2 pr-3">Uds.</th>
                              <th className="py-2 pr-3">Visitas</th>
                              <th className="py-2 pr-3">Conv.</th>
                              <th className="py-2 pr-3">Stock</th>
                              <th className="py-2 pr-3">Full</th>
                              <th className="py-2 pr-3">Precio</th>
                              <th className="py-2 pr-3">Costo</th>
                              <th className="py-2 pr-3">Margen%</th>
                              <th className="py-2 pr-3">Costo máx.</th>
                              <th className="py-2 pr-3">Precio equilibrio</th>
                              <th className="py-2 pr-3">Campaña</th>
                              <th className="py-2 pr-3">Estado anuncio</th>
                              <th className="py-2 pr-3">Clics</th>
                              <th className="py-2 pr-3">Impr.</th>
                              <th className="py-2 pr-3">CTR</th>
                              <th className="py-2 pr-3">CPC</th>
                              <th className="py-2 pr-3">Costo ads</th>
                              <th className="py-2 pr-3">ACOS</th>
                              <th className="py-2 pr-3">ROAS</th>
                            </tr>
                          </thead>
                          <tbody>
                            {metricsResult.tablaProductos.filas!.map((f) => (
                              <tr key={f.id} className="border-b border-gray-100 last:border-0">
                                <td className="py-2 pr-3 text-gray-800 max-w-xs truncate">{f.titulo}</td>
                                <td className="py-2 pr-3">
                                  <div className="flex flex-wrap gap-1">
                                    {f.etiquetas.map((e) => (
                                      <span key={e} className={`text-xs font-medium rounded-full px-2 py-0.5 ${
                                        e === "Candidato" ? "bg-green-100 text-green-700"
                                        : e === "Revisar" ? "bg-red-100 text-red-700"
                                        : "bg-orange-100 text-orange-700"
                                      }`}>{e}</span>
                                    ))}
                                  </div>
                                </td>
                                <td className="py-2 pr-3 text-gray-700">${f.ventasMonto.toLocaleString("es-CL")}</td>
                                <td className="py-2 pr-3 text-gray-700">{f.ventasUnidades}</td>
                                <td className="py-2 pr-3 text-gray-700">{f.visitas ?? "-"}</td>
                                <td className="py-2 pr-3 text-gray-700">{f.conversion !== null ? `${f.conversion}%` : "-"}</td>
                                <td className="py-2 pr-3 text-gray-700">{f.stock ?? "-"}</td>
                                <td className="py-2 pr-3 text-gray-700">{f.full ? "Sí" : "No"}</td>
                                <td className="py-2 pr-3 text-gray-700">{f.precio !== null ? `$${f.precio.toLocaleString("es-CL")}` : "-"}</td>
                                <td className="py-2 pr-3 text-gray-700">{f.costo !== null ? `$${f.costo.toLocaleString("es-CL")}` : "SIN DATO"}</td>
                                <td className="py-2 pr-3 text-gray-700"
                                  title={f.comisionPct !== null && f.envioPorUnidad !== null
                                    ? `Margen de contribución antes de publicidad. Comisión ${(f.comisionPct * 100).toFixed(1)}% (${f.comisionFuente === "orden" ? "cobrada en las ventas del período" : "calculada por ML"}) · envío $${Math.round(f.envioPorUnidad).toLocaleString("es-CL")} por unidad (${f.costoMaxFuenteEnvio})`
                                    : undefined}>
                                  {f.margenPct !== null ? `${f.margenPct}%` : "-"}
                                  {f.margenPct !== null && (f.costoMaxFuenteEnvio === "estimado" || f.comisionFuente === "calculada") && (
                                    <span className="ml-1 text-xs text-amber-600">est.</span>
                                  )}
                                  {f.pierde && (
                                    <span className="ml-1 text-xs font-medium bg-red-100 text-red-700 rounded-full px-2 py-0.5">Pierde</span>
                                  )}
                                </td>
                                <td className="py-2 pr-3 text-gray-700">
                                  {f.costoMax !== null ? `$${f.costoMax.toLocaleString("es-CL")}` : "-"}
                                  {f.costoMaxFuenteEnvio && (
                                    <span className={`ml-1 text-xs ${f.costoMaxFuenteEnvio === "estimado" ? "text-amber-600" : "text-gray-400"}`}>(envío {f.costoMaxFuenteEnvio})</span>
                                  )}
                                </td>
                                <td className="py-2 pr-3 text-gray-700">{f.costo !== null && f.precioEquilibrio !== null ? `$${f.precioEquilibrio.toLocaleString("es-CL")}` : "-"}</td>
                                <td className="py-2 pr-3 text-gray-700 max-w-[10rem] truncate">{f.campana ?? "-"}</td>
                                <td className="py-2 pr-3 text-gray-700 capitalize">{f.statusAnuncio ?? "-"}</td>
                                <td className="py-2 pr-3 text-gray-700">{f.clics}</td>
                                <td className="py-2 pr-3 text-gray-700">{f.impresiones}</td>
                                <td className="py-2 pr-3 text-gray-700">{f.ctr}%</td>
                                <td className="py-2 pr-3 text-gray-700">${f.cpc.toLocaleString("es-CL")}</td>
                                <td className="py-2 pr-3 text-gray-700">${f.costoAds.toLocaleString("es-CL")}</td>
                                <td className="py-2 pr-3 text-gray-700">{f.costoAds > 0 ? `${f.acos}%` : "-"}</td>
                                <td className="py-2 pr-3 text-gray-700">{f.costoAds > 0 ? f.roas.toFixed(2) : "-"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      </>
                    ) : (
                      <p className="text-sm text-gray-400">Sin filas para el período.</p>
                    )
                  ) : (
                    <p className="text-sm text-gray-400">No disponible por ahora{metricsResult.tablaProductos?.error ? ` (${metricsResult.tablaProductos.error})` : ""}.</p>
                  )}
                </div>
              </>
            )}
          </>
        )}

        {/* === TAB: RENTABILIDAD === */}
        {activeTab === "rentabilidad" && (
          <>
            <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-6 space-y-5">
              <div>
                <h2 className="font-bold text-gray-900 text-lg">Rentabilidad por orden</h2>
                <p className="text-sm text-gray-500 mt-1">
                  Fase 1: comisión, envío efectivo y pérdidas/devoluciones por orden, vía la Billing API de Mercado Libre. Ads atribuido queda para una fase posterior.
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Mes a analizar</label>
                <input type="month" value={mesRentabilidad} onChange={e => setMesRentabilidad(e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ "--tw-ring-color": "#C41230" } as CSSProperties} />
              </div>

              <div className="flex items-center gap-3">
                <button onClick={handleAnalizarRentabilidad}
                  disabled={analizandoRentabilidad}
                  className="font-bold py-2.5 px-5 rounded-xl text-white disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ backgroundColor: "#C41230" }}>
                  {analizandoRentabilidad ? <><Spinner />Analizando...</> : "Analizar"}
                </button>
                {analizandoRentabilidad && (
                  <button onClick={() => { rentabilidadCancelado.current = true; }}
                    className="text-sm text-gray-500 hover:text-gray-700 underline">
                    Cancelar
                  </button>
                )}
              </div>

              {(progresoRentabilidad.filasProcesadas > 0 || errorRentabilidad) && (
                <div className="text-sm text-gray-500 space-y-1">
                  <p>Filas de cargo procesadas: {progresoRentabilidad.filasProcesadas} · Órdenes nuevas: {progresoRentabilidad.ordenesNuevas}</p>
                  {progresoRentabilidad.multiItemDetectadas > 0 && (
                    <p className="text-yellow-700">⚠ {progresoRentabilidad.multiItemDetectadas} orden(es) con más de un producto detectada(s) — no calculada(s) automáticamente (caso no esperado, ver docs).</p>
                  )}
                  {errorRentabilidad && <p className="text-red-600">✗ Error: {errorRentabilidad}</p>}
                </div>
              )}
            </div>

            {rentabilidadRows.length > 0 && (() => {
              const calculables = rentabilidadRows.filter(r => r.margenNeto !== null);
              const margenTotal = calculables.reduce((sum, r) => sum + (r.margenNeto ?? 0), 0);
              const margenPctPromedio = calculables.length > 0
                ? calculables.reduce((sum, r) => sum + (r.margenPct ?? 0), 0) / calculables.length
                : 0;
              const conMargenNegativo = calculables.filter(r => (r.margenNeto ?? 0) < 0).length;
              const sinCogs = rentabilidadRows.filter(r => r.cogs === null && !r.multiItem).length;

              return (
                <>
                  {/* Resumen agregado */}
                  <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-6 space-y-4">
                    <h3 className="font-semibold text-gray-800">Resumen del período</h3>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                      <div>
                        <p className="text-sm text-gray-500">Margen neto total</p>
                        <p className="text-xl font-bold text-gray-900">{formatCLP(margenTotal)}</p>
                      </div>
                      <div>
                        <p className="text-sm text-gray-500">Margen % promedio</p>
                        <p className="text-xl font-bold text-gray-900">{margenPctPromedio.toFixed(1)}%</p>
                      </div>
                      <div>
                        <p className="text-sm text-gray-500">Órdenes con margen negativo</p>
                        <p className={`text-xl font-bold ${conMargenNegativo > 0 ? "text-red-600" : "text-gray-900"}`}>{conMargenNegativo}</p>
                      </div>
                      <div>
                        <p className="text-sm text-gray-500">Órdenes totales</p>
                        <p className="text-xl font-bold text-gray-900">{rentabilidadRows.length}</p>
                      </div>
                    </div>
                    {sinCogs > 0 && (
                      <p className="text-sm text-yellow-700">⚠ {sinCogs} orden(es) sin COGS disponible en Publicaciones — margen no calculable para esas filas.</p>
                    )}
                  </div>

                  {/* Tabla por orden */}
                  <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-6 space-y-4">
                    <h3 className="font-semibold text-gray-800">Detalle por orden</h3>
                    <TarjetasRentabilidad filas={rentabilidadRows} />
                    <div className="hidden md:block overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-gray-500 border-b border-gray-200">
                            <th className="py-2 pr-3">Fecha</th>
                            <th className="py-2 pr-3">Producto</th>
                            <th className="py-2 pr-3 text-right">Precio Venta</th>
                            <th className="py-2 pr-3 text-right">COGS</th>
                            <th className="py-2 pr-3 text-right">Comisión</th>
                            <th className="py-2 pr-3 text-right">Envío</th>
                            <th className="py-2 pr-3 text-right">Pérdida</th>
                            <th className="py-2 pr-3 text-right">Margen Neto</th>
                            <th className="py-2 pr-3 text-right">Margen %</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rentabilidadRows.map((r) => (
                            <tr key={r.idOrden} className="border-b border-gray-100 last:border-0">
                              <td className="py-2 pr-3 text-gray-500">{r.fecha}</td>
                              <td className="py-2 pr-3 text-gray-800 max-w-xs truncate">{r.producto}</td>
                              <td className="py-2 pr-3 text-right text-gray-900">{formatCLP(r.precioVenta)}</td>
                              <td className="py-2 pr-3 text-right text-gray-700">{r.cogs === null ? "COGS no disponible" : formatCLP(r.cogs)}</td>
                              <td className="py-2 pr-3 text-right text-orange-600">{formatCLP(r.comision)}</td>
                              <td className="py-2 pr-3 text-right text-orange-600">{formatCLP(r.envio)}</td>
                              <td className="py-2 pr-3 text-right text-gray-700">{r.perdida > 0 ? formatCLP(r.perdida) : "-"}</td>
                              <td className={`py-2 pr-3 text-right font-semibold ${r.margenNeto === null ? "text-gray-400" : r.margenNeto < 0 ? "text-red-600" : "text-green-600"}`}>
                                {r.multiItem ? "Multi-item, no calculado" : r.margenNeto === null ? "—" : formatCLP(r.margenNeto)}
                              </td>
                              <td className="py-2 pr-3 text-right text-gray-700">{r.margenPct === null ? "—" : `${r.margenPct}%`}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              );
            })()}
          </>
        )}

        {/* === TAB: COMPARADOR VS MAYOR === */}
        {activeTab === "comparador" && (
          <>
            <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-6 space-y-4">
              <div className="flex flex-wrap items-end gap-4">
                <div>
                  <h2 className="font-bold text-gray-900 text-lg">Comparador vs Mayor</h2>
                  <p className="text-sm text-gray-500 mt-1">Neto ML por unidad vs. precio Mayor de Defontana, para todas las publicaciones activas con cruce.</p>
                </div>
                <div className="flex items-end gap-2 ml-auto">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Objetivo sobre Mayor (%)</label>
                    <input type="number" value={objetivoComparador} min={0} step={1}
                      onChange={e => setObjetivoComparador(Number(e.target.value) || 0)}
                      className="w-24 border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                  </div>
                  <button onClick={() => loadComparador(objetivoComparador)} disabled={loadingComparador}
                    className="font-bold py-2 px-4 rounded-xl text-white disabled:opacity-40 disabled:cursor-not-allowed text-sm"
                    style={{ backgroundColor: "#C41230" }}>
                    {loadingComparador ? <><Spinner />Cargando...</> : "Recalcular"}
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap gap-3">
                <select value={filtroSemaforo} onChange={e => setFiltroSemaforo(e.target.value as typeof filtroSemaforo)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm">
                  <option value="todos">Todos los semáforos</option>
                  <option value="rojo">🔴 Rojo</option>
                  <option value="amarillo">🟡 Amarillo</option>
                  <option value="verde">🟢 Verde</option>
                  <option value="revision">⚠ Mayor en revisión</option>
                </select>
                <input type="text" placeholder="Filtrar por marca" value={filtroMarca} onChange={e => setFiltroMarca(e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                <input type="text" placeholder="Filtrar por proveedor" value={filtroProveedor} onChange={e => setFiltroProveedor(e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm" />
              </div>
            </div>

            {comparadorResult?.ok === false && (
              <p className="text-red-600 text-sm">✗ Error: {comparadorResult.error}</p>
            )}

            {comparadorResult?.ok && comparadorResult.filas && (() => {
              const filasFiltradas = comparadorResult.filas
                .filter(f => filtroSemaforo === "todos" || (filtroSemaforo === "revision" ? f.mayorEnRevision : f.semaforo === filtroSemaforo))
                .filter(f => !filtroMarca || (f.marca ?? "").toLowerCase().includes(filtroMarca.toLowerCase()))
                .filter(f => !filtroProveedor || (f.proveedor ?? "").toLowerCase().includes(filtroProveedor.toLowerCase()));

              const ordenadas = [...filasFiltradas].sort((a, b) => {
                const campo = ordenComparador.campo;
                const va = a[campo], vb = b[campo];
                if (va === null || va === undefined) return 1;
                if (vb === null || vb === undefined) return -1;
                const cmp = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
                return ordenComparador.asc ? cmp : -cmp;
              });

              function toggleOrden(campo: keyof FilaComparador) {
                setOrdenComparador(prev => prev.campo === campo ? { campo, asc: !prev.asc } : { campo, asc: true });
              }

              const conteoSemaforo = { rojo: 0, amarillo: 0, verde: 0, revision: 0, sin: 0 };
              for (const f of comparadorResult.filas!) {
                if (f.mayorEnRevision) conteoSemaforo.revision++;
                else if (f.semaforo === "rojo") conteoSemaforo.rojo++;
                else if (f.semaforo === "amarillo") conteoSemaforo.amarillo++;
                else if (f.semaforo === "verde") conteoSemaforo.verde++;
                else conteoSemaforo.sin++;
              }

              return (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                    <div className="bg-white rounded-xl p-3 text-center border border-gray-200">
                      <p className="text-2xl font-bold text-red-600">{conteoSemaforo.rojo}</p>
                      <p className="text-xs text-gray-500 mt-1">🔴 Rojo (&lt;0%)</p>
                    </div>
                    <div className="bg-white rounded-xl p-3 text-center border border-gray-200">
                      <p className="text-2xl font-bold text-yellow-600">{conteoSemaforo.amarillo}</p>
                      <p className="text-xs text-gray-500 mt-1">🟡 Amarillo (0-10%)</p>
                    </div>
                    <div className="bg-white rounded-xl p-3 text-center border border-gray-200">
                      <p className="text-2xl font-bold text-green-600">{conteoSemaforo.verde}</p>
                      <p className="text-xs text-gray-500 mt-1">🟢 Verde (&gt;10%)</p>
                    </div>
                    <div className="bg-amber-50 rounded-xl p-3 text-center border border-amber-200" title="El Mayor de estas publicaciones quedó marcado como dudoso en CostoOrigen (por ejemplo, costo igual al precio o una cantidad distinta en el título): no se les da semáforo hasta revisarlo.">
                      <p className="text-2xl font-bold text-amber-700">{conteoSemaforo.revision}</p>
                      <p className="text-xs text-gray-500 mt-1">⚠ Mayor en revisión (sin semáforo)</p>
                    </div>
                    <div className="bg-white rounded-xl p-3 text-center border border-gray-200">
                      <p className="text-2xl font-bold text-gray-400">{conteoSemaforo.sin}</p>
                      <p className="text-xs text-gray-500 mt-1">Sin referencia Mayor</p>
                    </div>
                  </div>

                  <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 sm:p-6">
                    <p className="text-sm text-gray-500 mb-3">{ordenadas.length} de {comparadorResult.filas.length} publicaciones (filtradas)</p>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-gray-500 border-b border-gray-200">
                            <th className="py-2 pr-3 cursor-pointer" onClick={() => toggleOrden("titulo")}>Producto</th>
                            <th className="py-2 pr-3">Marca</th>
                            <th className="py-2 pr-3">Proveedor</th>
                            <th className="py-2 pr-3 text-right cursor-pointer" onClick={() => toggleOrden("precio")}>Precio</th>
                            <th className="py-2 pr-3 text-right">Comisión $</th>
                            <th className="py-2 pr-3 text-right">Envío/u</th>
                            <th className="py-2 pr-3 text-right cursor-pointer" onClick={() => toggleOrden("netoMlPorUnidad")}>Neto ML/u</th>
                            <th className="py-2 pr-3 text-right cursor-pointer" onClick={() => toggleOrden("precioMayor")}>Mayor (bruto)</th>
                            <th className="py-2 pr-3 text-right cursor-pointer" onClick={() => toggleOrden("precioMayorNeto")}>Mayor (neto)</th>
                            <th className="py-2 pr-3">Fuente</th>
                            <th className="py-2 pr-3 text-right cursor-pointer" onClick={() => toggleOrden("vsMayorPct")}>vs Mayor</th>
                            <th className="py-2 pr-3 text-right">Precio sugerido</th>
                            <th className="py-2 pr-3">Semáforo</th>
                            <th className="py-2 pr-3">Estado anuncio</th>
                            <th className="py-2 pr-3 text-right">vs Mayor c/ads</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ordenadas.map((f) => (
                            <tr key={f.id} className="border-b border-gray-100 last:border-0">
                              <td className="py-2 pr-3 text-gray-800 max-w-xs truncate">{f.titulo}</td>
                              <td className="py-2 pr-3 text-gray-700">{f.marca ?? "-"}</td>
                              <td className="py-2 pr-3 text-gray-700">{f.proveedor ?? "-"}</td>
                              <td className="py-2 pr-3 text-right text-gray-700">{formatCLP(f.precio)}</td>
                              <td className="py-2 pr-3 text-right text-gray-700">
                                {f.comisionMonto !== null && f.comisionPct !== null ? (
                                  <>
                                    {formatCLP(f.comisionMonto)} <span className="text-xs text-gray-400">({(f.comisionPct*100).toFixed(1)}%)</span>
                                    {f.comisionFuente === "calculada" && <span className="ml-1 text-xs text-amber-600" title="Sin ventas en los últimos 45 días: tarifa calculada por ML para el precio actual">calc.</span>}
                                  </>
                                ) : <span className="text-xs text-red-500">sin dato</span>}
                              </td>
                              <td className="py-2 pr-3 text-right text-gray-700">
                                {f.envioPorUnidad !== null ? formatCLP(f.envioPorUnidad) : <span className="text-xs text-red-500">sin dato</span>}
                                {f.envioFuente === "estimado" && <span className="ml-1 text-xs text-amber-600" title="No hay una tarifa medida para esta publicación: respaldo por SKU gemelo o tramo de precio">(estimado)</span>}
                                {f.envioFuente === "medido" && <span className="ml-1 text-xs text-gray-400">(medido)</span>}
                              </td>
                              <td className="py-2 pr-3 text-right text-gray-700">{f.netoMlPorUnidad !== null ? formatCLP(f.netoMlPorUnidad) : "-"}</td>
                              <td className="py-2 pr-3 text-right text-gray-700">{f.precioMayor !== null ? formatCLP(f.precioMayor) : "-"}</td>
                              <td className="py-2 pr-3 text-right text-gray-500">{f.precioMayorNeto !== null ? formatCLP(f.precioMayorNeto) : "-"}</td>
                              <td className="py-2 pr-3 text-gray-500 text-xs">
                                {f.fuenteMayor === "cruce_directo" ? "Cruce directo" : f.fuenteMayor === "equivalencia" ? "Equivalencia" : "Sin referencia"}
                              </td>
                              <td title={f.mayorEnRevision ? `Mayor en revisión: ${f.motivoRevision}` : undefined} className={`py-2 pr-3 text-right font-semibold ${f.vsMayorPct === null || f.mayorEnRevision ? "text-gray-400" : f.vsMayorPct < 0 ? "text-red-600" : f.vsMayorPct <= 10 ? "text-yellow-600" : "text-green-600"}`}>
                                {f.vsMayorPct !== null ? `${f.vsMayorPct}%` : "-"}
                              </td>
                              <td title={f.mayorEnRevision ? "Calculado con un Mayor en revisión: no usarlo hasta revisarlo" : undefined} className={`py-2 pr-3 text-right ${f.mayorEnRevision ? "text-gray-400" : "text-gray-700"}`}>{f.precioSugerido !== null ? formatCLP(f.precioSugerido) : "-"}</td>
                              <td className="py-2 pr-3">
                                {f.semaforo === "rojo" && "🔴"}
                                {f.semaforo === "amarillo" && "🟡"}
                                {f.semaforo === "verde" && "🟢"}
                                {f.semaforo === null && !f.mayorEnRevision && "-"}
                                {f.mayorEnRevision && <span className="text-xs text-amber-700 whitespace-nowrap" title={`Mayor en revisión: ${f.motivoRevision}`}>⚠ Mayor en revisión</span>}
                              </td>
                              <td className="py-2 pr-3 text-gray-700 capitalize">{f.statusAnuncio ?? "-"}</td>
                              <td className="py-2 pr-3 text-right text-gray-700">{f.vsMayorConAdsPct !== null ? `${f.vsMayorConAdsPct}%` : "-"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              );
            })()}
          </>
        )}

      </div>
    </main>
  );
}

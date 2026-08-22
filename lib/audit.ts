import * as XLSX from "xlsx";

export type AuditData = {
  facturacionML?: Record<string, unknown>[];
  facturacionMP?: Record<string, unknown>[];
  notasCredito?: Record<string, unknown>[];
  notasCreditoML?: Record<string, unknown>[];
  flexCredito?: Record<string, unknown>[];
  flexDebito?: Record<string, unknown>[];
  archivosNoProporcionados: string[];
};

export type ErrorType =
  | "comision_incorrecta"
  | "envio_incorrecto"
  | "devolucion_sin_reembolso"
  | "comision_venta_anulada";

export type TransaccionError = {
  tipo: ErrorType;
  fecha: string;
  orden: string;
  producto: string;
  cobrado: number;
  esperado: number;
  diferencia: number;
  detalle: string;
};

export type AuditResult = {
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

const MESES_ES: Record<string, number> = {
  ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6,
  jul: 7, ago: 8, sep: 9, oct: 10, nov: 11, dic: 12,
};

// Extrae {año, mes} de un valor de fecha en cualquiera de los formatos que
// entregan los reportes de ML/MP (Date nativo, ISO, dd/mm/yyyy, dd-mm-yyyy,
// "15-ago-2026"). Devuelve null si no se pudo parsear — mismo set de formatos
// que isInMonth() en calculateAudit, pero sin filtrar por un mes objetivo.
export function extraerAnioMes(dateVal: unknown): { year: number; month: number } | null {
  if (!dateVal) return null;
  if (dateVal instanceof Date) {
    return { year: dateVal.getFullYear(), month: dateVal.getMonth() + 1 };
  }
  const s = String(dateVal).trim();
  if (!s) return null;
  const iso = s.match(/(\d{4})-(\d{2})-\d{2}/);
  if (iso) return { year: +iso[1], month: +iso[2] };
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (dmy) {
    const y = +dmy[3] < 100 ? 2000 + +dmy[3] : +dmy[3];
    return { year: y, month: +dmy[2] };
  }
  const dmy2 = s.match(/^(\d{1,2})-(\d{2})-(\d{4})/);
  if (dmy2) return { year: +dmy2[3], month: +dmy2[2] };
  const sp = s.match(/(\d{1,2})[- ](ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)[- ](\d{4})/i);
  if (sp) return { year: +sp[3], month: MESES_ES[sp[2].toLowerCase()] };
  try {
    const d = new Date(s);
    if (!isNaN(d.getTime()) && d.getFullYear() > 2000) {
      return { year: d.getFullYear(), month: d.getMonth() + 1 };
    }
  } catch { /* ignorar */ }
  return null;
}

function getValRaw(row: Record<string, unknown>, ...patterns: string[]): unknown {
  const keys = Object.keys(row);
  for (const p of patterns) {
    const np = normBasico(p);
    const match = keys.find(k => normBasico(k).includes(np));
    if (match) return row[match];
  }
  return undefined;
}

// Versión standalone de norm() (sin depender del closure de calculateAudit),
// usada por las funciones de detección de cobertura que corren ANTES de
// calcular el análisis.
function normBasico(s: string): string {
  const s2 = s
    .replace(/Ã¡/g, "a").replace(/Ã©/g, "e").replace(/Ã­/g, "i")
    .replace(/Ã³/g, "o").replace(/Ãº/g, "u").replace(/Ã±/g, "n")
    .replace(/Â°/g, "°");
  return s2.toLowerCase()
    .replace(/[áàã]/g, "a").replace(/[éè]/g, "e").replace(/[íì]/g, "i")
    .replace(/[óòô]/g, "o").replace(/[úùü]/g, "u").replace(/ñ/g, "n");
}

export type CoberturaMeses = { year: number; month: number; count: number }[];

// Detecta qué meses reales (por contenido, no por nombre de archivo) están
// presentes en un dataset ya parseado, contando filas por mes.
export function detectarMesesEnArchivo(rows: Record<string, unknown>[] | undefined): CoberturaMeses {
  if (!rows?.length) return [];
  const counts = new Map<string, { year: number; month: number; count: number }>();
  for (const row of rows) {
    const am = extraerAnioMes(getValRaw(row, "fecha del cargo", "fecha"));
    if (!am) continue;
    const key = `${am.year}-${am.month}`;
    const entry = counts.get(key);
    if (entry) entry.count++;
    else counts.set(key, { ...am, count: 1 });
  }
  return [...counts.values()].sort((a, b) => a.year - b.year || a.month - b.month);
}

// Fase 1 (validación) detectó que Facturación ML y Facturación MP pueden
// venir con nombres de mes iguales pero contenido de rango real distinto
// (ej. ML = solo 12 días de un mes, MP = dos meses completos). Si eso pasa,
// calcular una tasa de comisión mezclando ambos períodos da un número
// imposible (ej. 413% de comisión). Esta función compara la cobertura real
// de ambos archivos ANTES de calcular nada.
export function validarCoberturaMeses(
  coberturaML: CoberturaMeses,
  coberturaMP: CoberturaMeses,
  mesObjetivo: string
): string | null {
  const [yearStr, monthStr] = mesObjetivo.split("-");
  const year = parseInt(yearStr);
  const month = parseInt(monthStr);

  const mlDelMes = coberturaML.find(m => m.year === year && m.month === month);
  const mpDelMes = coberturaMP.find(m => m.year === year && m.month === month);

  const fmtCobertura = (c: CoberturaMeses) =>
    c.length === 0 ? "sin datos" : c.map(m => `${m.year}-${String(m.month).padStart(2, "0")} (${m.count} filas)`).join(", ");

  if (coberturaML.length > 0 && !mlDelMes) {
    return `Facturación ML no contiene ninguna fila del mes ${mesObjetivo}. ` +
      `El archivo cubre: ${fmtCobertura(coberturaML)}. ` +
      `Revisá si el archivo corresponde al mes que estás analizando (el nombre del archivo puede no coincidir con su contenido real).`;
  }
  if (coberturaMP.length > 0 && !mpDelMes) {
    return `Facturación MP no contiene ninguna fila del mes ${mesObjetivo}. ` +
      `El archivo cubre: ${fmtCobertura(coberturaMP)}. ` +
      `Revisá si el archivo corresponde al mes que estás analizando (el nombre del archivo puede no coincidir con su contenido real).`;
  }

  // Ambos tienen datos del mes objetivo, pero si la cantidad de días distintos
  // cubiertos difiere sustancialmente entre archivos (ej. ML solo trae medio
  // mes, MP trae el mes completo), la tasa de comisión mezcla dos períodos de
  // tamaño distinto y da un número engañoso — mismo problema raíz que detectó
  // la Fase 1 (413% de comisión). Se bloquea igual que el caso anterior.
  if (coberturaML.length > 1 || coberturaMP.length > 1) {
    return `Los archivos no cubren exactamente el mismo período: ` +
      `ML cubre ${fmtCobertura(coberturaML)}; MP cubre ${fmtCobertura(coberturaMP)}. ` +
      `No se puede calcular una tasa de comisión confiable mezclando períodos de distinto tamaño — revisá que ambos archivos correspondan al mismo rango de fechas.`;
  }

  return null;
}

// ── Parsers ──────────────────────────────────────────────────────────────────

export function parseAuditFiles(files: { name: string; buffer: Buffer }[]): AuditData {
  const result: AuditData = { archivosNoProporcionados: [] };

  for (const file of files) {
    const name = file.name.toLowerCase();
    const text = file.buffer.toString("latin1");

    if (name.endsWith(".csv")) {
      const esMP = text.includes("Tipo de operaci") || text.includes("Sección ML") || text.includes("Valor de la operaci");
      if (!esMP && (text.includes("Cargo que anula") || (name.includes("nota") && (name.includes("credito") || name.includes("crédito")) && (name.includes("mercadolibre") || name.includes("libre"))))) {
        result.notasCreditoML = parseCSVSemicolon(text);
      } else if (esMP) {
        result.facturacionMP = parseCSVComma(text);
      } else if (text.includes("Porcentaje por categor") || text.includes("Número de venta") || text.includes("Numero de venta")) {
        result.facturacionML = parseCSVSemicolon(text);
      } else if (name.includes("mercadolibre") || name.includes("libre")) {
        result.facturacionML = parseCSVSemicolon(text);
      } else {
        result.facturacionMP = parseCSVComma(text);
      }
    } else if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
      if (name.includes("nota") && (name.includes("credito") || name.includes("crédito")) && (name.includes("mercadolibre") || name.includes("libre"))) {
        result.notasCreditoML = parseXlsx(file.buffer, 7);
      } else if (name.includes("nota") && (name.includes("credito") || name.includes("crédito"))) {
        result.notasCredito = parseXlsx(file.buffer, 7);
      } else if (name.includes("flex") && (name.includes("debito") || name.includes("débito"))) {
        result.flexDebito = parseXlsx(file.buffer, 7);
      } else if (name.includes("flex") && (name.includes("credito") || name.includes("crédito"))) {
        result.flexCredito = parseXlsx(file.buffer, 7);
      } else if (name.includes("mercadolibre") || name.includes("libre")) {
        result.facturacionML = parseXlsx(file.buffer, 7);
      } else {
        result.facturacionMP = parseXlsx(file.buffer, 0);
      }
    }
  }

  if (!result.facturacionML) result.archivosNoProporcionados.push("Facturación ML");
  if (!result.facturacionMP) result.archivosNoProporcionados.push("Facturación MP");

  return result;
}

function parseXlsx(buffer: Buffer, headerRowIndex: number): Record<string, unknown>[] {
  const wb = XLSX.read(buffer, { type: "buffer", cellText: true, cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "" }) as unknown[][];
  if (rows.length <= headerRowIndex) return [];
  const headers = (rows[headerRowIndex] as unknown[]).map((h) => String(h ?? "").trim()).filter(Boolean);
  if (headers.length === 0) return [];
  return rows
    .slice(headerRowIndex + 1)
    .filter((row) => Array.isArray(row) && (row as unknown[]).some((c) => c !== "" && c !== null && c !== undefined))
    .map((row) => {
      const obj: Record<string, unknown> = {};
      headers.forEach((h, i) => { obj[h] = (row as unknown[])[i] ?? ""; });
      return obj;
    });
}

function parseCSVSemicolon(text: string): Record<string, unknown>[] {
  const lines = text.split(/\r?\n/);
  let headerIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    if (lines[i].includes("Fecha del cargo") || lines[i].includes("factura fiscal") || lines[i].includes("Nº de factura")) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) headerIdx = 7;
  const headers = splitLine(lines[headerIdx], ";").map(h => h.trim().replace(/^"|"$/g, ""));
  return lines
    .slice(headerIdx + 1)
    .filter(l => l.trim())
    .map(line => {
      const vals = splitLine(line, ";");
      const obj: Record<string, unknown> = {};
      headers.forEach((h, i) => { obj[h] = (vals[i] ?? "").trim().replace(/^"|"$/g, ""); });
      return obj;
    })
    .filter(row => Object.values(row).some(v => v !== ""));
}

function parseCSVComma(text: string): Record<string, unknown>[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = splitLine(lines[0], ",").map(h => h.trim().replace(/^"|"$/g, ""));
  return lines.slice(1).map(line => {
    const vals = splitLine(line, ",");
    const obj: Record<string, unknown> = {};
    headers.forEach((h, i) => { obj[h] = (vals[i] ?? "").trim().replace(/^"|"$/g, ""); });
    return obj;
  }).filter(row => Object.values(row).some(v => v !== ""));
}

function splitLine(line: string, sep: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const char of line) {
    if (char === '"') { inQuotes = !inQuotes; }
    else if (char === sep && !inQuotes) { result.push(current); current = ""; }
    else { current += char; }
  }
  result.push(current);
  return result;
}

// ── Calculator ────────────────────────────────────────────────────────────────

function auditResultVacio(detalle_errores: string[], error_cobertura?: string): AuditResult {
  return {
    ventas_brutas: 0,
    ventas_netas: 0,
    comisiones_ml: 0,
    comisiones_mp: 0,
    comisiones_mp_px: 0,
    total_comisiones: 0,
    recuperable: 0,
    neto_recibido_mp: 0,
    tasa_efectiva: 0,
    flex_credito: 0,
    flex_debito: 0,
    errores_count: 0,
    errores: [],
    resumen: error_cobertura ?? "No se pudo calcular el análisis.",
    detalle_errores,
    error_cobertura,
  };
}

export function calculateAudit(mes: string, data: AuditData, ventasBrutasML?: number): AuditResult {
  const [yearStr, monthStr] = mes.split("-");
  const year = parseInt(yearStr);
  const month = parseInt(monthStr);
  const detalle_errores: string[] = [];

  // ── Validación de cobertura de período (Fase 1: hallazgo crítico) ─────────
  // Antes de calcular cualquier tasa/comisión, verificar que Facturación ML y
  // Facturación MP cubran el mismo rango real de fechas. Si no, cualquier
  // tasa resultante mezcla períodos de distinto tamaño y no es confiable
  // (ver ejemplo real: ML con 12 días de un mes dio una tasa de 413%).
  const coberturaML = detectarMesesEnArchivo(data.facturacionML);
  const coberturaMP = detectarMesesEnArchivo(data.facturacionMP);
  const errorCobertura = validarCoberturaMeses(coberturaML, coberturaMP, mes);
  if (errorCobertura) {
    return auditResultVacio(
      [`[DIAG] Cobertura ML: ${JSON.stringify(coberturaML)}`, `[DIAG] Cobertura MP: ${JSON.stringify(coberturaMP)}`],
      errorCobertura
    );
  }

  function parseCLP(val: unknown): number {
    if (typeof val === "number") return Math.round(val);
    if (!val) return 0;
    let s = String(val).trim().replace(/\s/g, "").replace(/[$%]/g, "");
    if (s.includes(".") && s.includes(",")) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else if (s.includes(",") && !s.includes(".")) {
      s = s.replace(",", ".");
    } else if (s.includes(".") && !s.includes(",")) {
      const m = s.match(/^-?\d+\.(\d+)$/);
      if (m && m[1].length === 3) s = s.replace(".", "");
    }
    s = s.replace(/[^0-9.\-]/g, "");
    return Math.round(parseFloat(s) || 0);
  }

  const MESES_ES: Record<string, number> = {
    ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6,
    jul: 7, ago: 8, sep: 9, oct: 10, nov: 11, dic: 12,
  };

  function norm(s: string): string {
    // Reparar mojibake típico (texto UTF-8 leído como latin1, p.ej. "OperaciÃ³n")
    const s2 = s
      .replace(/Ã¡/g, "a").replace(/Ã©/g, "e").replace(/Ã­/g, "i")
      .replace(/Ã³/g, "o").replace(/Ãº/g, "u").replace(/Ã±/g, "n")
      .replace(/Â°/g, "°");
    return s2.toLowerCase()
      .replace(/[áàã]/g, "a").replace(/[éè]/g, "e").replace(/[íì]/g, "i")
      .replace(/[óòô]/g, "o").replace(/[úùü]/g, "u").replace(/ñ/g, "n");
  }

  function isInMonth(dateVal: unknown): boolean {
    if (!dateVal) return false;
    if (dateVal instanceof Date) {
      return dateVal.getFullYear() === year && (dateVal.getMonth() + 1) === month;
    }
    const s = String(dateVal).trim();
    if (!s) return false;
    const iso = s.match(/(\d{4})-(\d{2})-\d{2}/);
    if (iso) return +iso[1] === year && +iso[2] === month;
    const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (dmy) {
      const y = +dmy[3] < 100 ? 2000 + +dmy[3] : +dmy[3];
      return y === year && +dmy[2] === month;
    }
    const dmy2 = s.match(/^(\d{1,2})-(\d{2})-(\d{4})/);
    if (dmy2) return +dmy2[3] === year && +dmy2[2] === month;
    const sp = s.match(/(\d{1,2})[- ](ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)[- ](\d{4})/i);
    if (sp) return +sp[3] === year && MESES_ES[sp[2].toLowerCase()] === month;
    try {
      const d = new Date(s);
      if (!isNaN(d.getTime()) && d.getFullYear() > 2000) {
        return d.getFullYear() === year && (d.getMonth() + 1) === month;
      }
    } catch { /* ignorar */ }
    return false;
  }

  function findKey(row: Record<string, unknown>, ...patterns: string[]): string | null {
    const keys = Object.keys(row);
    for (const p of patterns) {
      const np = norm(p);
      const match = keys.find(k => norm(k).includes(np));
      if (match) return match;
    }
    return null;
  }

  function getVal(row: Record<string, unknown>, ...patterns: string[]): unknown {
    const key = findKey(row, ...patterns);
    return key ? row[key] : undefined;
  }

  // ── Procesar Facturación ML ────────────────────────────────────────────────
  type VentaML = {
    orden: string;
    fecha: string;
    producto: string;
    total_venta: number;
    comision_cobrada: number;
    comision_esperada: number;
    envio_cobrado: number;
    tasa: number;
    anulada: boolean;
    cargo_anulado_pendiente: boolean;
  };

  const ventasML = new Map<string, VentaML>();
  let comisiones_ml_raw = 0;
  let ventas_brutas = 0;
  const ordenesContadas = new Set<string>();

  if (data.facturacionML?.length) {
    const mlCols = Object.keys(data.facturacionML[0] ?? {});
    detalle_errores.push(`[DIAG] ML columnas (${mlCols.length}): ${mlCols.slice(0, 10).join(" | ")}`);

    const mlRows = data.facturacionML.filter(row =>
      isInMonth(getVal(row, "fecha del cargo", "fecha"))
    );
    detalle_errores.push(`[DIAG] ML filas total=${data.facturacionML.length} filtradas=${mlRows.length}`);

    for (const row of mlRows) {
      const detalleRaw = String(getVal(row, "detalle") ?? "");
      const detalle = norm(detalleRaw);
      const estado = norm(String(getVal(row, "estado del cargo") ?? ""));
      const cargoAnula = String(getVal(row, "cargo que anula") ?? "").trim();
      const valorCargo = parseCLP(getVal(row, "valor del cargo"));
      const orden = String(getVal(row, "numero de venta", "número de venta") ?? "").trim();
      const fecha = String(getVal(row, "fecha del cargo", "fecha") ?? "").trim();
      const producto = String(getVal(row, "titulo de publicacion", "título de publicación") ?? "").slice(0, 60);
      const totalVenta = parseCLP(getVal(row, "total de la venta"));
      const costoCategoria = parseCLP(getVal(row, "costo por categoria", "costo por categoría"));
      const costoFijo = parseCLP(getVal(row, "costo fijo") ?? 0);
      const tasa = parseCLP(getVal(row, "porcentaje por categoria", "porcentaje por categoría"));

      const esAnulacion = cargoAnula !== "" || detalle.includes("anulacion del cargo");
      const esAnuladoEnFactura = estado.includes("anulado en factura");
      const esPublicidad = !esAnulacion && (detalle.includes("publicidad") || detalle.includes("product ads") || detalle.includes("mi p") || detalle.includes("mantenimiento"));
      const esVenta = detalle.includes("cargo por venta") && !esAnulacion;
      const esEnvio = detalle.includes("envio") && !esAnulacion && !esVenta;

      if (esPublicidad) {
        comisiones_ml_raw += Math.abs(valorCargo);
        continue;
      }

      if (esAnulacion) {
        comisiones_ml_raw += valorCargo; // valorCargo negativo → reduce total
        if (orden && ventasML.has(orden)) {
          const v = ventasML.get(orden)!;
          const anulaVenta = detalle.includes("venta");
          const anulaEnvio = !anulaVenta && detalle.includes("envio");
          if (anulaVenta) v.comision_cobrada = Math.max(0, v.comision_cobrada + valorCargo);
          if (anulaEnvio) v.envio_cobrado = Math.max(0, v.envio_cobrado + valorCargo);
          if (v.comision_cobrada === 0 && v.envio_cobrado === 0) v.anulada = true;
        }
        continue;
      }

      // Registrar o actualizar la venta
      if ((esVenta || esEnvio) && orden) {
        if (!ventasML.has(orden)) {
          ventasML.set(orden, {
            orden, fecha, producto, total_venta: totalVenta,
            comision_cobrada: 0, comision_esperada: 0,
            envio_cobrado: 0, tasa, anulada: false, cargo_anulado_pendiente: false,
          });
        }
        const v = ventasML.get(orden)!;
        if (totalVenta > 0 && v.total_venta === 0) v.total_venta = totalVenta;
        if (costoCategoria + costoFijo > 0) v.comision_esperada = costoCategoria + costoFijo;
        if (tasa > 0 && v.tasa === 0) v.tasa = tasa;
        if (producto && !v.producto) v.producto = producto;

        if (esAnuladoEnFactura) v.cargo_anulado_pendiente = true;
        if (esVenta) v.comision_cobrada += Math.abs(valorCargo);
        if (esEnvio) v.envio_cobrado += Math.abs(valorCargo);
        comisiones_ml_raw += Math.abs(valorCargo);
      } else if (esVenta || esEnvio) {
        comisiones_ml_raw += Math.abs(valorCargo);
      }

      // Ventas brutas: una vez por orden, solo ventas no anuladas
      if (esVenta && !esAnuladoEnFactura && orden && !ordenesContadas.has(orden) && totalVenta > 0) {
        ventas_brutas += totalVenta;
        ordenesContadas.add(orden);
      }
    }
  } else {
    detalle_errores.push("Facturación ML no proporcionada");
  }

  // ── Procesar Facturación MP ────────────────────────────────────────────────
  let comisiones_mp = 0;
  let comisiones_mp_px = 0;
  let neto_recibido_mp = 0;
  let ventas_brutas_mp = 0;

  if (data.facturacionMP?.length) {
    const mpCols = Object.keys(data.facturacionMP[0] ?? {});
    detalle_errores.push(`[DIAG] MP columnas (${mpCols.length}): ${mpCols.slice(0, 8).join(" | ")}`);

    const mpRows = data.facturacionMP.filter(row =>
      isInMonth(getVal(row, "fecha del cargo", "fecha"))
    );
    detalle_errores.push(`[DIAG] MP filas total=${data.facturacionMP.length} filtradas=${mpRows.length}`);

    if (mpRows.length > 0) {
      detalle_errores.push(
        "Nota: \"Comisiones MP\" y \"Neto Recibido MP\" se calculan por fecha de liquidación " +
        "del cargo, no por fecha de venta. Si el reporte de MP no coincide con el mes " +
        "calendario, estas dos cifras pueden incluir cargos de ventas de otro mes."
      );
    }

    const operacionesContadasMP = new Set<string>();

    for (const row of mpRows) {
      const detalle = norm(String(getVal(row, "detalle") ?? ""));
      const estado = norm(String(getVal(row, "estado del cargo") ?? ""));
      const cargoAnula = String(getVal(row, "cargo que anula") ?? "").trim();
      const valorCargo = parseCLP(getVal(row, "valor del cargo"));
      const valorOperacion = parseCLP(getVal(row, "valor de la operacion", "valor de la operación"));
      const operacionRelacionada = String(getVal(row, "operacion relacionada", "operación relacionada") ?? "").trim();
      // "Checkout" a secas = marketplace de Mercado Libre, confirmado. "PX" se
      // trata también como marketplace de ML por asunción del usuario (Otto,
      // dueño de la cuenta) — NO se pudo verificar por cruce de datos en la
      // Fase 1 de validación (el campo "Cliente" del CSV no coincidió con
      // ningún comprador real de /orders/search, ni siquiera para filas
      // "Checkout" que sí son ML con certeza, así que ese cruce no sirvió de
      // prueba). Por eso "PX" se trackea aparte (comisiones_mp_px) y se
      // muestra etiquetado como "asumido, no verificado" en vez de mezclarse
      // invisible en comisiones_mp. "Link de pago" sigue excluido (Shopify).
      const tipoPago = norm(String(getVal(row, "tipo de pago") ?? ""));
      const esCheckout = tipoPago === "checkout";
      const esPX = tipoPago === "px";
      const esCanalML = esCheckout || esPX;

      const esAnulacion = cargoAnula !== "" || detalle.includes("anulacion del cargo");
      const esAnuladoEnFactura = estado.includes("anulado en factura");

      if (!esCanalML) continue;

      if (esAnulacion) {
        // valorCargo viene negativo en las anulaciones → reduce comisión ya sumada
        comisiones_mp += valorCargo;
        if (esPX) comisiones_mp_px += valorCargo;
        continue;
      }

      if (detalle.includes("cobrar con mercado pago") || detalle.includes("cuotas")) {
        comisiones_mp += valorCargo;
        if (esPX) comisiones_mp_px += valorCargo;
      }

      // Neto recibido MP: una vez por operación relacionada, ignorando anuladas.
      // No se suma a ventas_brutas porque "Fecha del cargo" es la fecha de liquidación
      // del cargo (puede caer en el mes siguiente a la venta real), no la fecha de venta.
      if (valorOperacion > 0 && operacionRelacionada && !esAnuladoEnFactura && !operacionesContadasMP.has(operacionRelacionada)) {
        ventas_brutas_mp += valorOperacion;
        neto_recibido_mp += valorOperacion;
        operacionesContadasMP.add(operacionRelacionada);
      }
    }
    comisiones_mp = Math.max(0, comisiones_mp);
  } else {
    detalle_errores.push("Facturación MP no proporcionada");
  }

  // ── Notas de Crédito MP ────────────────────────────────────────────────────
  let recuperable = 0;
  if (data.notasCredito?.length) {
    for (const row of data.notasCredito) {
      const estado = norm(String(getVal(row, "estado") ?? ""));
      const monto = Math.abs(parseCLP(getVal(row, "monto", "importe", "valor", "total")));
      const ref = String(getVal(row, "referencia", "número", "n°", "id", "comprobante") ?? "");
      if (estado.includes("pend") || estado.includes("no aplic") || estado === "") {
        recuperable += monto;
        if (monto > 0) detalle_errores.push(`NC pendiente: ${ref} — $${monto.toLocaleString("es-CL")}`);
      } else {
        comisiones_mp = Math.max(0, comisiones_mp - monto);
      }
    }
  }

  // ── Notas de Crédito ML ───────────────────────────────────────────────────
  let notasCreditoMLTotal = 0;
  if (data.notasCreditoML?.length) {
    for (const row of data.notasCreditoML) {
      const valor = parseCLP(getVal(row, "valor del cargo"));
      // Los valores vienen negativos (crédito a favor), tomamos el valor absoluto
      const monto = Math.abs(valor);
      if (monto > 0) {
        notasCreditoMLTotal += monto;
        const ref = String(getVal(row, "numero del cargo", "número del cargo", "n° de factura", "factura") ?? "").trim();
        detalle_errores.push(`NC ML: ${ref} — -$${monto.toLocaleString("es-CL")}`);
      }
    }
    comisiones_ml_raw = Math.max(0, comisiones_ml_raw - notasCreditoMLTotal);
  }

  // ── Flex Crédito / Débito ──────────────────────────────────────────────────
  let flexCreditoTotal = 0;
  if (data.flexCredito?.length) {
    for (const row of data.flexCredito) {
      flexCreditoTotal += Math.abs(parseCLP(getVal(row, "monto", "importe", "valor", "bonificación", "total")));
    }
    comisiones_ml_raw = Math.max(0, comisiones_ml_raw - flexCreditoTotal);
  }

  let flexDebitoTotal = 0;
  if (data.flexDebito?.length) {
    for (const row of data.flexDebito) {
      flexDebitoTotal += Math.abs(parseCLP(getVal(row, "monto", "importe", "valor", "cargo", "total")));
    }
    comisiones_ml_raw += flexDebitoTotal;
  }

  // ── Detectar errores por transacción ──────────────────────────────────────
  const errores: TransaccionError[] = [];

  for (const [, v] of ventasML) {
    if (v.anulada) continue;

    // Comisión incorrecta: diferencia > $100 entre cobrado y esperado
    const difComision = v.comision_cobrada - v.comision_esperada;
    if (Math.abs(difComision) > 100 && v.comision_esperada > 0) {
      errores.push({
        tipo: "comision_incorrecta",
        fecha: v.fecha,
        orden: v.orden,
        producto: v.producto,
        cobrado: v.comision_cobrada,
        esperado: v.comision_esperada,
        diferencia: difComision,
        detalle: `ML facturó $${v.comision_cobrada.toLocaleString("es-CL")} (${v.tasa}%) · esperado $${v.comision_esperada.toLocaleString("es-CL")}`,
      });
    }

    // Comisión en venta anulada: cobró pero la venta estaba marcada como anulada en factura
    if (v.cargo_anulado_pendiente && v.comision_cobrada > 0) {
      errores.push({
        tipo: "comision_venta_anulada",
        fecha: v.fecha,
        orden: v.orden,
        producto: v.producto,
        cobrado: v.comision_cobrada,
        esperado: 0,
        diferencia: v.comision_cobrada,
        detalle: `Cargo $${v.comision_cobrada.toLocaleString("es-CL")} anulado en factura — verificar reversa`,
      });
    }
  }

  // ── Totales ────────────────────────────────────────────────────────────────
  // ventas_brutas_mp NO se suma: "Fecha del cargo" en el CSV de MP es la fecha de
  // liquidación del cargo, no la fecha real de venta, así que mezcla operaciones de
  // meses distintos. Cuando hay total de la API de ML disponible, se usa como fuente
  // oficial de ventas brutas del mes; si no, se usa lo calculado desde el CSV de ML.
  if (ventasBrutasML !== undefined) {
    ventas_brutas = ventasBrutasML;
  }
  const comisiones_ml = comisiones_ml_raw;
  const ventas_netas = ventas_brutas;
  const total_comisiones = comisiones_ml + comisiones_mp;
  const tasa_efectiva = ventas_brutas > 0
    ? parseFloat(((total_comisiones / ventas_brutas) * 100).toFixed(2))
    : 0;

  const clp = (n: number) => "$" + Math.round(n).toLocaleString("es-CL");
  const partes = [
    `Mes ${mes}: ventas brutas ${clp(ventas_brutas)}.`,
    `Com. ML ${clp(comisiones_ml)} · Com. MP ${clp(comisiones_mp)} · Total ${clp(total_comisiones)} (${tasa_efectiva}%).`,
  ];
  if (comisiones_mp_px !== 0) {
    partes.push(`(de los cuales PX — asumido ML, no verificado: ${clp(comisiones_mp_px)}).`);
  }
  if (recuperable > 0) partes.push(`Recuperable: ${clp(recuperable)}.`);
  if (notasCreditoMLTotal > 0) partes.push(`NC ML aplicadas: -${clp(notasCreditoMLTotal)}.`);
  if (flexCreditoTotal > 0) partes.push(`Flex crédito: -${clp(flexCreditoTotal)}.`);
  if (flexDebitoTotal > 0) partes.push(`Flex débito: +${clp(flexDebitoTotal)}.`);
  if (errores.length > 0) partes.push(`${errores.length} error(es) detectado(s).`);

  return {
    ventas_brutas,
    ventas_netas,
    comisiones_ml,
    comisiones_mp,
    comisiones_mp_px,
    total_comisiones,
    recuperable,
    neto_recibido_mp,
    tasa_efectiva,
    flex_credito: flexCreditoTotal,
    flex_debito: flexDebitoTotal,
    errores_count: errores.length,
    errores,
    resumen: partes.join(" "),
    detalle_errores,
  };
}

import * as XLSX from "xlsx";

export type AuditData = {
  facturacionML?: Record<string, unknown>[];
  facturacionMP?: Record<string, unknown>[];
  cargosFacturas?: Record<string, unknown>[];
  notasCredito?: Record<string, unknown>[];
  flexCredito?: Record<string, unknown>[];
  flexDebito?: Record<string, unknown>[];
  archivosNoProporcionados: string[];
};

export type AuditResult = {
  ventas_brutas: number;
  ventas_netas: number;
  comisiones_ml: number;
  comisiones_mp: number;
  total_comisiones: number;
  recuperable: number;
  tasa_efectiva: number;
  errores: number;
  detalle_errores: string[];
  resumen: string;
};

// ── Parsers ──────────────────────────────────────────────────────────────────

export function parseAuditFiles(files: { name: string; buffer: Buffer }[]): AuditData {
  const result: AuditData = { archivosNoProporcionados: [] };

  for (const file of files) {
    const name = file.name.toLowerCase();

    if (name.includes("settlement") || (name.endsWith(".csv") && (name.includes("mercadopago") || name.includes("pago")))) {
      result.facturacionMP = parseCSV(file.buffer.toString("latin1"));
    } else if (name.includes("mercadolibre") || (name.includes("facturacion") && name.endsWith(".xlsx"))) {
      result.facturacionML = parseXlsx(file.buffer, 7);
    } else if (name.includes("cargos") || name.includes("pagos") || name.includes("facturas")) {
      result.cargosFacturas = parseXlsx(file.buffer, 9);
    } else if (name.includes("flex") && (name.includes("debito") || name.includes("débito"))) {
      result.flexDebito = parseXlsx(file.buffer, 7);
    } else if (name.includes("flex") && (name.includes("credito") || name.includes("crédito"))) {
      result.flexCredito = parseXlsx(file.buffer, 7);
    } else if (name.includes("nota") || name.includes("credito") || name.includes("crédito")) {
      result.notasCredito = parseXlsx(file.buffer, 7);
    }
  }

  if (!result.facturacionMP) result.archivosNoProporcionados.push("CSV Mercado Pago");
  if (!result.facturacionML) result.archivosNoProporcionados.push("Facturación ML");
  if (!result.cargosFacturas) result.archivosNoProporcionados.push("Cargos/Pagos");

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

function parseCSV(text: string): Record<string, unknown>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];

  const headers = splitCSVLine(lines[0]).map((h) => h.trim().replace(/^"|"$/g, ""));

  return lines
    .slice(1)
    .map((line) => {
      const values = splitCSVLine(line);
      const obj: Record<string, unknown> = {};
      headers.forEach((h, i) => { obj[h] = values[i]?.trim().replace(/^"|"$/g, "") ?? ""; });
      return obj;
    })
    .filter((row) => Object.values(row).some((v) => v !== ""));
}

function splitCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const char of line) {
    if (char === '"') { inQuotes = !inQuotes; }
    else if (char === "," && !inQuotes) { result.push(current); current = ""; }
    else { current += char; }
  }
  result.push(current);
  return result;
}

// ── Calculator ────────────────────────────────────────────────────────────────

export function calculateAudit(mes: string, data: AuditData): AuditResult {
  const [yearStr, monthStr] = mes.split("-");
  const year = parseInt(yearStr);
  const month = parseInt(monthStr);
  const detalle_errores: string[] = [];
  let errores = 0;

  // Parse CLP: handles "1.234,56", "1234.56", 1234, "-1234"
  function parseCLP(val: unknown): number {
    if (typeof val === "number") return Math.round(val);
    if (!val) return 0;
    let s = String(val).trim().replace(/\s/g, "").replace(/[$%]/g, "");
    if (s.includes(".") && s.includes(",")) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else if (s.includes(",") && !s.includes(".")) {
      s = s.replace(",", ".");
    }
    s = s.replace(/[^0-9.\-]/g, "");
    return Math.round(parseFloat(s) || 0);
  }

  const MESES_ES: Record<string, number> = {
    ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6,
    jul: 7, ago: 8, sep: 9, oct: 10, nov: 11, dic: 12,
  };

  // Normaliza texto quitando tildes para comparaciones flexibles
  function norm(s: string): string {
    return s.toLowerCase()
      .replace(/[áà]/g, "a").replace(/[éè]/g, "e").replace(/[íì]/g, "i")
      .replace(/[óò]/g, "o").replace(/[úùü]/g, "u").replace(/ñ/g, "n");
  }

  function isInMonth(dateVal: unknown): boolean {
    if (!dateVal) return false;

    // Date objects (XLSX con cellDates:true los devuelve así)
    if (dateVal instanceof Date) {
      return dateVal.getFullYear() === year && (dateVal.getMonth() + 1) === month;
    }

    const s = String(dateVal).trim();
    if (!s) return false;

    // ISO: 2026-01-15 o 2026-01-15T10:00:00
    const iso = s.match(/(\d{4})-(\d{2})-\d{2}/);
    if (iso) return +iso[1] === year && +iso[2] === month;

    // DD/MM/YYYY o DD/MM/YY
    const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (dmy) {
      const y = +dmy[3] < 100 ? 2000 + +dmy[3] : +dmy[3];
      return y === year && +dmy[2] === month;
    }

    // DD-MM-YYYY (guiones en lugar de barras)
    const dmy2 = s.match(/^(\d{1,2})-(\d{2})-(\d{4})/);
    if (dmy2) return +dmy2[3] === year && +dmy2[2] === month;

    // 15-ene-2026 o 15 ene 2026
    const sp = s.match(/(\d{1,2})[- ](ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)[- ](\d{4})/i);
    if (sp) return +sp[3] === year && MESES_ES[sp[2].toLowerCase()] === month;

    // Fallback: dejar que JS parsee el string (cubre "Thu Jan 02 2026 00:00:00 GMT...")
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

  function detectDateKey(rows: Record<string, unknown>[]): string | null {
    if (!rows.length) return null;
    return findKey(rows[0], "fecha", "date", "día", "day");
  }

  function filterByMonth(rows: Record<string, unknown>[], label: string): Record<string, unknown>[] {
    const dateKey = detectDateKey(rows);
    if (!dateKey) {
      detalle_errores.push(`${label}: no se encontró columna de fecha — se incluyen todas las filas`);
      errores++;
      return rows;
    }
    const filtered = rows.filter(row => isInMonth(row[dateKey]));
    if (filtered.length === 0 && rows.length > 0) {
      const sample = rows.slice(0, 3).map(r => String(r[dateKey])).join(" | ");
      detalle_errores.push(`${label}: ninguna fila coincide con mes ${mes} (col "${dateKey}", ej: ${sample}) — se incluyen todas las filas`);
      errores++;
      return rows;
    }
    return filtered;
  }

  // ── Facturación ML ─────────────────────────────────────────────────────────
  let comisiones_ml = 0;
  if (data.facturacionML?.length) {
    const rows = filterByMonth(data.facturacionML, "Facturación ML");
    for (const row of rows) {
      const monto = parseCLP(getVal(row, "monto", "importe", "total", "valor", "cargo", "amount"));
      comisiones_ml += Math.abs(monto);
    }
  } else {
    detalle_errores.push("Facturación ML no proporcionada — comisiones ML no calculadas");
  }

  // ── Facturación MP (settlement_v2) ─────────────────────────────────────────
  let ventas_brutas = 0;
  let devoluciones = 0;
  let comisiones_mp = 0;

  if (data.facturacionMP?.length) {
    const rows = filterByMonth(data.facturacionMP, "Facturación MP");
    for (const row of rows) {
      const tipo = String(getVal(row, "tipo de operación", "tipo", "type", "record_type") ?? "").toLowerCase();
      const valorOp = parseCLP(getVal(row, "valor de la operación", "gross", "monto bruto", "operación"));
      const valorCargo = parseCLP(getVal(row, "valor del cargo", "fee", "cargo"));

      // Devoluciones: tipo explícito de reversa/refund
      const esDevolucion = norm(tipo).includes("refund") || norm(tipo).includes("devolucion")
        || norm(tipo).includes("reversa") || norm(tipo).includes("reversao") || norm(tipo).includes("anulac");

      // Ventas: cualquier fila con valor positivo que no sea devolución
      if (esDevolucion) {
        devoluciones += Math.abs(valorOp);
      } else if (valorOp > 0) {
        ventas_brutas += valorOp;
      }

      // Comisiones MP: "Valor del cargo" puede ser positivo o negativo según el reporte
      if (Math.abs(valorCargo) > 0) comisiones_mp += Math.abs(valorCargo);
    }
  } else {
    detalle_errores.push("CSV Facturación MP no proporcionado — ventas y comisiones MP no calculadas");
  }

  const ventas_netas = ventas_brutas - devoluciones;

  // ── Notas de Crédito MP ────────────────────────────────────────────────────
  let recuperable = 0;
  if (data.notasCredito?.length) {
    for (const row of data.notasCredito) {
      const estado = String(getVal(row, "estado") ?? "").toLowerCase();
      const monto = Math.abs(parseCLP(getVal(row, "monto", "importe", "valor", "total")));
      const ref = String(getVal(row, "referencia", "número", "n°", "id", "comprobante") ?? "");

      if (estado.includes("pend") || estado.includes("no aplic") || estado === "") {
        recuperable += monto;
        errores++;
        if (monto > 0) detalle_errores.push(`NC pendiente: ${ref} — $${monto.toLocaleString("es-CL")}`);
      } else {
        comisiones_mp = Math.max(0, comisiones_mp - monto);
      }
    }
  }

  // ── Flex Crédito (bonificaciones → reducen costos) ─────────────────────────
  let flexCreditoTotal = 0;
  if (data.flexCredito?.length) {
    for (const row of data.flexCredito) {
      flexCreditoTotal += Math.abs(parseCLP(getVal(row, "monto", "importe", "valor", "bonificación", "total")));
    }
    comisiones_ml = Math.max(0, comisiones_ml - flexCreditoTotal);
  }

  // ── Flex Débito (cargos adicionales → aumentan costos) ─────────────────────
  let flexDebitoTotal = 0;
  if (data.flexDebito?.length) {
    for (const row of data.flexDebito) {
      flexDebitoTotal += Math.abs(parseCLP(getVal(row, "monto", "importe", "valor", "cargo", "total")));
    }
    comisiones_ml += flexDebitoTotal;
  }

  // ── Totales ────────────────────────────────────────────────────────────────
  const total_comisiones = comisiones_ml + comisiones_mp;
  const tasa_efectiva = ventas_brutas > 0
    ? parseFloat(((total_comisiones / ventas_brutas) * 100).toFixed(2))
    : 0;

  const clp = (n: number) => "$" + Math.round(n).toLocaleString("es-CL");
  const partes = [
    `Mes ${mes}: ventas brutas ${clp(ventas_brutas)}, netas ${clp(ventas_netas)}.`,
    `Comisiones ML ${clp(comisiones_ml)}, MP ${clp(comisiones_mp)}, total ${clp(total_comisiones)} (tasa ${tasa_efectiva}%).`,
  ];
  if (recuperable > 0) partes.push(`Recuperable: ${clp(recuperable)}.`);
  if (flexCreditoTotal > 0) partes.push(`Flex crédito aplicado: -${clp(flexCreditoTotal)}.`);
  if (flexDebitoTotal > 0) partes.push(`Flex débito aplicado: +${clp(flexDebitoTotal)}.`);

  return {
    ventas_brutas,
    ventas_netas,
    comisiones_ml,
    comisiones_mp,
    total_comisiones,
    recuperable,
    tasa_efectiva,
    errores,
    detalle_errores,
    resumen: partes.join(" "),
  };
}

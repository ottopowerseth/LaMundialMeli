import * as XLSX from "xlsx";

export type AuditData = {
  facturacionML?: Record<string, unknown>[];
  facturacionMP?: Record<string, unknown>[];
  notasCredito?: Record<string, unknown>[];
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

// ── Parsers ──────────────────────────────────────────────────────────────────

export function parseAuditFiles(files: { name: string; buffer: Buffer }[]): AuditData {
  const result: AuditData = { archivosNoProporcionados: [] };

  for (const file of files) {
    const name = file.name.toLowerCase();
    const text = file.buffer.toString("latin1");

    if (name.endsWith(".csv")) {
      if (text.includes("Porcentaje por categor") || text.includes("Número de venta") || text.includes("Numero de venta")) {
        result.facturacionML = parseCSVSemicolon(text);
      } else if (text.includes("Tipo de operaci") || text.includes("Sección ML") || text.includes("Valor de la operaci")) {
        result.facturacionMP = parseCSVComma(text);
      } else if (name.includes("mercadolibre") || name.includes("libre")) {
        result.facturacionML = parseCSVSemicolon(text);
      } else {
        result.facturacionMP = parseCSVComma(text);
      }
    } else if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
      if (name.includes("nota") && (name.includes("credito") || name.includes("crédito"))) {
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

export function calculateAudit(mes: string, data: AuditData): AuditResult {
  const [yearStr, monthStr] = mes.split("-");
  const year = parseInt(yearStr);
  const month = parseInt(monthStr);
  const detalle_errores: string[] = [];

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
    return s.toLowerCase()
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
      const esPublicidad = detalle.includes("publicidad") || detalle.includes("product ads") || detalle.includes("mi p") || detalle.includes("mantenimiento");
      const esEnvio = detalle.includes("envio") || detalle.includes("env");
      const esVenta = detalle.includes("cargo por venta") && !esAnulacion;

      if (esPublicidad) {
        comisiones_ml_raw += Math.abs(valorCargo);
        continue;
      }

      if (esAnulacion) {
        comisiones_ml_raw += valorCargo; // valorCargo negativo → reduce total
        if (orden && ventasML.has(orden)) {
          const v = ventasML.get(orden)!;
          if (detalle.includes("venta")) v.comision_cobrada = Math.max(0, v.comision_cobrada + valorCargo);
          if (esEnvio) v.envio_cobrado = Math.max(0, v.envio_cobrado + valorCargo);
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

        if (esAnuladoEnFactura) {
          v.cargo_anulado_pendiente = true;
          if (esVenta) v.comision_cobrada += Math.abs(valorCargo);
          if (esEnvio) v.envio_cobrado += Math.abs(valorCargo);
          comisiones_ml_raw += Math.abs(valorCargo);
        } else {
          if (esVenta) v.comision_cobrada += Math.abs(valorCargo);
          if (esEnvio) v.envio_cobrado += Math.abs(valorCargo);
          comisiones_ml_raw += Math.abs(valorCargo);
        }
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
  let neto_recibido_mp = 0;

  if (data.facturacionMP?.length) {
    const mpCols = Object.keys(data.facturacionMP[0] ?? {});
    detalle_errores.push(`[DIAG] MP columnas (${mpCols.length}): ${mpCols.slice(0, 8).join(" | ")}`);

    const mpRows = data.facturacionMP.filter(row =>
      isInMonth(getVal(row, "fecha del cargo", "fecha"))
    );
    detalle_errores.push(`[DIAG] MP filas total=${data.facturacionMP.length} filtradas=${mpRows.length}`);

    for (const row of mpRows) {
      const detalle = norm(String(getVal(row, "detalle") ?? ""));
      const valorCargo = parseCLP(getVal(row, "valor del cargo"));
      const cobradoOp = parseCLP(getVal(row, "cobrado en la operacion", "cobrado en la operación"));

      if (detalle.includes("cobrar con mercado pago") || detalle.includes("cuotas")) {
        comisiones_mp += Math.abs(valorCargo);
      }
      if (cobradoOp > 0) neto_recibido_mp += cobradoOp;
    }
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
  if (recuperable > 0) partes.push(`Recuperable: ${clp(recuperable)}.`);
  if (flexCreditoTotal > 0) partes.push(`Flex crédito: -${clp(flexCreditoTotal)}.`);
  if (flexDebitoTotal > 0) partes.push(`Flex débito: +${clp(flexDebitoTotal)}.`);
  if (errores.length > 0) partes.push(`${errores.length} error(es) detectado(s).`);

  return {
    ventas_brutas,
    ventas_netas,
    comisiones_ml,
    comisiones_mp,
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

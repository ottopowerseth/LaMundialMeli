import * as XLSX from "xlsx";

export type AuditData = {
  facturacionML?: Record<string, unknown>[];
  facturacionMP?: Record<string, unknown>[];
  cargosFacturas?: Record<string, unknown>[];
  notasCredito?: Record<string, unknown>[];
  archivosNoProporcionados: string[];
};

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

// Columnas relevantes del CSV de MP para no saturar el contexto de Claude
const MP_COLUMNS = ["Detalle", "Valor del cargo", "Valor de la operación", "Tipo de operación", "Estado del cargo", "Descripción"];

export function buildAuditMessage(mes: string, data: AuditData): string {
  const sections: string[] = [`Mes a analizar: ${mes}`];

  if (data.facturacionML?.length) {
    const sample = data.facturacionML.slice(0, 500);
    sections.push(`\n=== FACTURACIÓN MERCADO LIBRE (${sample.length} filas) ===\n${JSON.stringify(sample)}`);
  }

  if (data.facturacionMP?.length) {
    const filtered = data.facturacionMP
      .slice(0, 2000)
      .map((row) => {
        const filtered: Record<string, unknown> = {};
        MP_COLUMNS.forEach((col) => { if (row[col] !== undefined) filtered[col] = row[col]; });
        return filtered;
      });
    sections.push(`\n=== FACTURACIÓN MERCADO PAGO (${filtered.length} filas, columnas clave) ===\n${JSON.stringify(filtered)}`);
  }

  if (data.cargosFacturas?.length) {
    sections.push(`\n=== CARGOS / PAGOS DE FACTURAS (${data.cargosFacturas.length} filas) ===\n${JSON.stringify(data.cargosFacturas.slice(0, 300))}`);
  }

  if (data.notasCredito?.length) {
    sections.push(`\n=== NOTAS DE CRÉDITO MERCADO PAGO (${data.notasCredito.length} filas) ===\n${JSON.stringify(data.notasCredito.slice(0, 300))}`);
  }

  if (data.archivosNoProporcionados.length) {
    sections.push(`\nArchivos no proporcionados: ${data.archivosNoProporcionados.join(", ")}`);
  }

  return sections.join("\n");
}

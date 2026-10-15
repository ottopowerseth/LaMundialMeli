import { google } from "googleapis";

function getAuthClient() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/^"|"$/g, ""),
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const status =
        (err as { code?: number })?.code ??
        (err as { response?: { status?: number } })?.response?.status;
      const isQuota = status === 429 || status === 503;
      if (isQuota && i < retries - 1) {
        await new Promise((r) => setTimeout(r, (i + 1) * 10000)); // 10s, 20s, 30s
        continue;
      }
      throw err;
    }
  }
  throw new Error("unreachable");
}

export async function ensureSheets(sheetNames: string[]) {
  const auth = getAuthClient();
  const sheets = google.sheets({ version: "v4", auth });

  const { data } = await sheets.spreadsheets.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
  });

  const existing = new Set(data.sheets?.map((s) => s.properties?.title) ?? []);
  const toCreate = sheetNames.filter((name) => !existing.has(name));

  if (toCreate.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      requestBody: {
        requests: toCreate.map((title) => ({
          addSheet: { properties: { title } },
        })),
      },
    });
  }
}

export async function clearSheet(sheetName: string) {
  const auth = getAuthClient();
  const sheets = google.sheets({ version: "v4", auth });

  await withRetry(() =>
    sheets.spreadsheets.values.clear({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `${sheetName}!A:Z`,
    })
  );

  // También limpia el formato de las celdas para evitar que formatos
  // anteriores (ej: "Fecha") distorsionen los nuevos valores
  await resetearFormato(sheetName);
}

// Quita el formato de TODAS las filas de la hoja (todo su alto de cuadrícula, no un número fijo: Ventas ya supera las 2000 filas
// que reseteaba antes). No toca los valores. Las filas que la tabla nueva agregue más allá de la cuadrícula nacen sin formato.
// Devuelve el alto y el ancho de la cuadrícula ANTES de escribir (undefined si la hoja no existe): reemplazarHoja los usa para saber si queda algo por limpiar.
async function resetearFormato(sheetName: string): Promise<{ rowCount?: number; columnCount?: number }> {
  const auth = getAuthClient();
  const sheets = google.sheets({ version: "v4", auth });
  const { data } = await sheets.spreadsheets.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
  });
  const sheet = data.sheets?.find((s) => s.properties?.title === sheetName);
  if (sheet?.properties?.sheetId !== undefined) {
    await withRetry(() =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        requestBody: {
          requests: [{
            repeatCell: {
              range: {
                sheetId: sheet.properties!.sheetId,
                startRowIndex: 0,
                endRowIndex: sheet.properties!.gridProperties?.rowCount ?? 2000,
              },
              cell: { userEnteredFormat: {} },
              fields: "userEnteredFormat",
            },
          }],
        },
      })
    );
  }
  return { rowCount: sheet?.properties?.gridProperties?.rowCount ?? undefined, columnCount: sheet?.properties?.gridProperties?.columnCount ?? undefined };
}

const letraDeColumna = (n: number) => { let s = ""; for (let c = n; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + ((c - 1) % 26)) + s; return s; };

// Reemplaza el contenido de una hoja escribiendo PRIMERO y limpiando el sobrante DESPUÉS (S-08). Reemplaza al par
// clearSheet + writeSheet, que dejaba la hoja vacía si algo fallaba (o si otra lectura caía) entre los dos pasos.
//   1. reset de formato (no toca valores: si falla acá, o en el paso 2, la hoja anterior queda intacta)
//   2. escribe la tabla nueva sobre A1
//   3. limpia SOLO lo que sobra de la tabla anterior: las filas bajo la nueva y las columnas a la derecha de su ancho (hasta Z), y solo si la
//      cuadrícula ANTERIOR tenía algo ahí: una tabla que llena justo la cuadrícula (o la hace crecer) no deja sobrante, y pedir limpiar un rango que
//      empieza fuera de la cuadrícula hace que Sheets responda «exceeds grid limits» (pasaba con Ventas, 2.474 filas justas: un falso error en el sync).
// Si el paso 3 falla NO lanza: la tabla nueva ya está escrita; devuelve sobranteLimpio=false y el próximo reemplazo lo limpia.
// Límite: sigue sin ser atómico; entre el paso 2 y el 3 un lector puede ver la tabla nueva con filas viejas debajo.
export async function reemplazarHoja(sheetName: string, valores: unknown[][]): Promise<{ sobranteLimpio: boolean; errorSobrante?: string }> {
  if (valores.length === 0) throw new Error(`reemplazarHoja(${sheetName}): no hay nada que escribir (se evita vaciar la hoja)`);
  const ancho = Math.max(...valores.map((f) => f.length));
  // Filas más cortas que el ancho se rellenan con "": así ninguna celda de la tabla conserva un valor viejo (clearSheet limpiaba A:Z entero).
  const completas = valores.map((f) => (f.length < ancho ? [...f, ...Array(ancho - f.length).fill("")] : f));
  const grilla = await resetearFormato(sheetName);
  await writeSheet(`${sheetName}!A1`, completas);

  const filas = valores.length;
  const ranges: string[] = [];
  const ultima = letraDeColumna(Math.min(26, grilla.columnCount ?? 26)); // última columna de la cuadrícula (tope Z): no se pide un rango que termine fuera de ella
  // Filas bajo la tabla nueva: solo si la cuadrícula anterior era más alta (sin el dato de la cuadrícula se limpia, como antes).
  if (grilla.rowCount === undefined || filas < grilla.rowCount) ranges.push(`${sheetName}!A${filas + 1}:${ultima}`);
  // Columnas a la derecha del ancho nuevo: solo si la cuadrícula anterior tenía columnas ahí (el tope de limpieza sigue siendo Z).
  if (ancho < 26 && (grilla.columnCount === undefined || ancho < grilla.columnCount)) ranges.push(`${sheetName}!${letraDeColumna(ancho + 1)}1:${ultima}${filas}`);
  if (ranges.length === 0) return { sobranteLimpio: true }; // nada que limpiar
  try {
    const auth = getAuthClient();
    const sheets = google.sheets({ version: "v4", auth });
    await withRetry(() =>
      sheets.spreadsheets.values.batchClear({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        requestBody: { ranges },
      })
    );
    return { sobranteLimpio: true };
  } catch (err) {
    return { sobranteLimpio: false, errorSobrante: err instanceof Error ? err.message : String(err) };
  }
}

export async function readSheet(range: string) {
  const auth = getAuthClient();
  const sheets = google.sheets({ version: "v4", auth });

  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range,
  });

  return data.values ?? [];
}

export async function writeSheet(range: string, values: unknown[][]) {
  const auth = getAuthClient();
  const sheets = google.sheets({ version: "v4", auth });

  await withRetry(() =>
    sheets.spreadsheets.values.update({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range,
      valueInputOption: "USER_ENTERED",
      requestBody: { values },
    })
  );
}

export async function batchWriteSheet(updates: { range: string; values: unknown[][] }[]) {
  if (updates.length === 0) return;
  const auth = getAuthClient();
  const sheets = google.sheets({ version: "v4", auth });

  await withRetry(() =>
    sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: updates.map(({ range, values }) => ({ range, values })),
      },
    })
  );
}

// Borra filas enteras de una pestaña (números 1-based de la hoja), de abajo hacia arriba y sin repetidas, en UNA llamada.
// Las filas de abajo se corren hacia arriba: quien llama debe haber verificado su contenido justo antes (lib/guardas-filas.ts).
export async function borrarFilasHoja(sheetName: string, filas: number[]) {
  const unicas = [...new Set(filas)].sort((a, b) => b - a);
  if (unicas.length === 0) return;
  if (!unicas.every((f) => Number.isInteger(f) && f >= 2)) throw new Error("borrarFilasHoja: las filas deben ser enteros >= 2 (la 1 es el encabezado)");
  const auth = getAuthClient();
  const sheets = google.sheets({ version: "v4", auth });
  const { data } = await sheets.spreadsheets.get({ spreadsheetId: process.env.GOOGLE_SHEET_ID });
  const sheetId = data.sheets?.find((s) => s.properties?.title === sheetName)?.properties?.sheetId;
  if (sheetId === undefined || sheetId === null) throw new Error(`Pestaña ${sheetName} no encontrada`);
  await withRetry(() =>
    sheets.spreadsheets.batchUpdate({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      requestBody: {
        requests: unicas.map((fila) => ({ deleteDimension: { range: { sheetId, dimension: "ROWS", startIndex: fila - 1, endIndex: fila } } })),
      },
    })
  );
}

// Modo de inserción del append (C-14). Con appends SIMULTÁNEOS a la misma hoja, OVERWRITE (el modo de la API por defecto) puede hacer que dos
// llamadas escriban en la misma fila y una pise a la otra: medido contra Sheets real el 2026-10-14, con appends separados por menos de
// ~200 ms se perdieron filas (2 appends a 0 ms: 2 de 8 ensayos con pérdida; 5 appends a 0 y 50 ms: 6 de 6), y con 200 ms o más no se perdió
// ninguna. INSERT_ROWS inserta una fila nueva por cada llamada y no se pisan.
//
// DIFERENCIA A CONOCER: INSERT_ROWS hereda el formato de número de la fila de ARRIBA en las filas nuevas (OVERWRITE no: escribe en filas sin
// formato). Con formatos uniformes por columna es inocuo; pero en hojas donde alguna celda numérica quedó con formato de fecha (S-07: un
// texto como «4989.6» se interpreta como fecha con USER_ENTERED) la herencia propagaría ese formato a todas las filas siguientes y los
// lectores, que usan FORMATTED_VALUE, leerían fechas en vez de números. Esas hojas (ShippingCache, Rentabilidad, TarifaEnvio) se agregan con
// modo: "OVERWRITE" explícito hasta resolver S-07; test-append-modos.mjs vigila que ningún llamador de ellas use el modo por defecto.
export type ModoAppend = "INSERT_ROWS" | "OVERWRITE";
export async function appendSheet(range: string, values: unknown[][], opciones?: { modo?: ModoAppend }) {
  const auth = getAuthClient();
  const sheets = google.sheets({ version: "v4", auth });

  await withRetry(() =>
    sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range,
      valueInputOption: "USER_ENTERED",
      insertDataOption: opciones?.modo ?? "INSERT_ROWS",
      requestBody: { values },
    })
  );
}

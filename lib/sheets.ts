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
async function resetearFormato(sheetName: string) {
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
}

const letraDeColumna = (n: number) => { let s = ""; for (let c = n; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + ((c - 1) % 26)) + s; return s; };

// Reemplaza el contenido de una hoja escribiendo PRIMERO y limpiando el sobrante DESPUÉS (S-08). Reemplaza al par
// clearSheet + writeSheet, que dejaba la hoja vacía si algo fallaba (o si otra lectura caía) entre los dos pasos.
//   1. reset de formato (no toca valores: si falla acá, o en el paso 2, la hoja anterior queda intacta)
//   2. escribe la tabla nueva sobre A1
//   3. limpia SOLO lo que sobra de la tabla anterior: las filas bajo la nueva y las columnas a la derecha de su ancho (hasta Z)
// Si el paso 3 falla NO lanza: la tabla nueva ya está escrita; devuelve sobranteLimpio=false y el próximo reemplazo lo limpia.
// Límite: sigue sin ser atómico; entre el paso 2 y el 3 un lector puede ver la tabla nueva con filas viejas debajo.
export async function reemplazarHoja(sheetName: string, valores: unknown[][]): Promise<{ sobranteLimpio: boolean; errorSobrante?: string }> {
  if (valores.length === 0) throw new Error(`reemplazarHoja(${sheetName}): no hay nada que escribir (se evita vaciar la hoja)`);
  const ancho = Math.max(...valores.map((f) => f.length));
  // Filas más cortas que el ancho se rellenan con "": así ninguna celda de la tabla conserva un valor viejo (clearSheet limpiaba A:Z entero).
  const completas = valores.map((f) => (f.length < ancho ? [...f, ...Array(ancho - f.length).fill("")] : f));
  await resetearFormato(sheetName);
  await writeSheet(`${sheetName}!A1`, completas);

  const filas = valores.length;
  const ranges = [`${sheetName}!A${filas + 1}:Z`];
  if (ancho < 26) ranges.push(`${sheetName}!${letraDeColumna(ancho + 1)}1:Z${filas}`);
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

export async function appendSheet(range: string, values: unknown[][]) {
  const auth = getAuthClient();
  const sheets = google.sheets({ version: "v4", auth });

  await withRetry(() =>
    sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range,
      valueInputOption: "USER_ENTERED",
      requestBody: { values },
    })
  );
}

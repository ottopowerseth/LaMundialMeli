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

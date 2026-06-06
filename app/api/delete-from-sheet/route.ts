import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";

function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/^"|"$/g, ""),
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { filas } = body;

    // Validación estricta
    if (!Array.isArray(filas) || filas.length === 0) {
      return NextResponse.json({ ok: true, borrados: 0 });
    }
    if (filas.length > 100) {
      return NextResponse.json({ error: "Máximo 100 filas por operación" }, { status: 400 });
    }
    if (!filas.every((f) => Number.isInteger(f) && f >= 2)) {
      return NextResponse.json({ error: "Filas inválidas (deben ser enteros ≥ 2)" }, { status: 400 });
    }

    const sheets = getSheetsClient();
    const spreadsheetId = process.env.GOOGLE_SHEET_ID!;

    const { data } = await sheets.spreadsheets.get({ spreadsheetId });
    const sheetId = data.sheets?.find(s => s.properties?.title === "Publicaciones")?.properties?.sheetId;
    if (sheetId === undefined) throw new Error("Pestaña Publicaciones no encontrada");

    const filasOrdenadas = [...new Set(filas)].sort((a, b) => b - a);

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: filasOrdenadas.map(fila => ({
          deleteDimension: {
            range: { sheetId, dimension: "ROWS", startIndex: fila - 1, endIndex: fila },
          },
        })),
      },
    });

    return NextResponse.json({ ok: true, borrados: filasOrdenadas.length });
  } catch (error) {
    console.error("[delete-from-sheet]", error);
    return NextResponse.json({ ok: false, error: "Error al borrar filas" }, { status: 500 });
  }
}

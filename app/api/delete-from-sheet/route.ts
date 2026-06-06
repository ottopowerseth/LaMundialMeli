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
    const { filas }: { filas: number[] } = await req.json();
    if (!filas?.length) return NextResponse.json({ ok: true, borrados: 0 });

    const sheets = getSheetsClient();
    const spreadsheetId = process.env.GOOGLE_SHEET_ID!;

    const { data } = await sheets.spreadsheets.get({ spreadsheetId });
    const sheetId = data.sheets?.find(s => s.properties?.title === "Publicaciones")?.properties?.sheetId;
    if (sheetId === undefined) throw new Error("Pestaña Publicaciones no encontrada");

    // Borrar de abajo hacia arriba para no desplazar índices
    const filasOrdenadas = [...filas].sort((a, b) => b - a);

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: filasOrdenadas.map(fila => ({
          deleteDimension: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex: fila - 1, // 0-based
              endIndex: fila,
            },
          },
        })),
      },
    });

    return NextResponse.json({ ok: true, borrados: filas.length });
  } catch (error) {
    console.error("[delete-from-sheet]", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { google } from "googleapis";
import { logError } from "@/lib/log";
import { readSheet } from "@/lib/sheets";
import { discrepanciaAuditoria } from "@/lib/guardas-filas";

function getAuthClient() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/^"|"$/g, ""),
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

// Borra UNA fila del historial de Auditoría. El cliente manda el índice de la fila (0-based, la 0 es el encabezado) y también el
// mes y la fecha de análisis que mostraba esa fila: si en la hoja ya no está eso (se borró otra fila, otra pestaña, etc.) no se borra nada.
export async function DELETE(request: Request) {
  try {
    const { rowIndex, mes, analizado } = await request.json().catch(() => ({})) as { rowIndex?: unknown; mes?: unknown; analizado?: unknown };

    if (typeof rowIndex !== "number" || !Number.isInteger(rowIndex) || rowIndex < 1) {
      return NextResponse.json({ ok: false, error: "rowIndex inválido: debe ser un entero mayor o igual a 1 (la fila 0 es el encabezado)." }, { status: 400 });
    }
    if (typeof mes !== "string" || !mes.trim() || typeof analizado !== "string") {
      return NextResponse.json({ ok: false, error: "Faltan el mes y la fecha de análisis de la fila a borrar; no se borró nada. Recarga la página e inténtalo de nuevo." }, { status: 400 });
    }

    // Verificar que la fila de la hoja sigue siendo la que el usuario vio (patrón de lib/costo-auto.ts).
    const numeroFila = rowIndex + 1; // 1-indexed para el rango de Sheets
    const fila = (await readSheet(`Auditoría!A${numeroFila}:R${numeroFila}`))[0];
    const motivo = discrepanciaAuditoria(fila, mes, analizado);
    if (motivo) return NextResponse.json({ ok: false, error: `${motivo} No se borró nada.` }, { status: 409 });

    const auth = getAuthClient();
    const sheets = google.sheets({ version: "v4", auth });

    const { data } = await sheets.spreadsheets.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
    });

    const sheet = data.sheets?.find((s) => s.properties?.title === "Auditoría");
    if (sheet?.properties?.sheetId === undefined) {
      return NextResponse.json({ ok: false, error: "Hoja Auditoría no encontrada" }, { status: 404 });
    }

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      requestBody: {
        requests: [{
          deleteDimension: {
            range: {
              sheetId: sheet.properties.sheetId,
              dimension: "ROWS",
              startIndex: rowIndex,
              endIndex: rowIndex + 1,
            },
          },
        }],
      },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    logError("audit/delete-row", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

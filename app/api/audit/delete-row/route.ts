import { NextResponse } from "next/server";
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

export async function DELETE(request: Request) {
  try {
    const { rowIndex } = await request.json() as { rowIndex: number };

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
    console.error("[audit/delete-row]", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { logError } from "@/lib/log";
import { readSheet } from "@/lib/sheets";
import { discrepanciasDeProductos, mensajeDiscrepancias } from "@/lib/guardas-filas";

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
    // Cada fila viaja con el ID del producto que se listó en esa fila: { productos: [{ fila, id }] }.
    const { productos } = body as { productos?: { fila?: unknown; id?: unknown }[] };

    // Validación estricta
    if (!Array.isArray(productos) && Array.isArray((body as { filas?: unknown }).filas)) {
      return NextResponse.json({ ok: false, error: "Formato antiguo (solo números de fila): ahora cada fila debe viajar con su ID, { productos: [{ fila, id }] }. Productos inválidos; no se borró nada. Recarga la página." }, { status: 400 });
    }
    if (!Array.isArray(productos) || productos.length === 0) {
      return NextResponse.json({ ok: true, borrados: 0 });
    }
    if (productos.length > 100) {
      return NextResponse.json({ error: "Máximo 100 filas por operación" }, { status: 400 });
    }
    if (!productos.every((p) => Number.isInteger(p?.fila) && (p.fila as number) >= 2 && typeof p.id === "string" && p.id.trim() !== "")) {
      return NextResponse.json({ error: "Productos inválidos: cada uno necesita { fila (entero ≥ 2), id }. No se borró nada." }, { status: 400 });
    }
    const items = productos.map((p) => ({ fila: p.fila as number, id: String(p.id) }));
    const filas = items.map((p) => p.fila);

    // Anti-carrera: ml-sync reescribe Publicaciones completa y puede reordenar las filas. Si alguna fila ya no contiene el ID
    // esperado, no se borra NADA (ni siquiera las que sí coinciden) y se avisa (patrón de lib/costo-auto.ts).
    const idsActuales = await readSheet(`Publicaciones!A2:A${Math.max(...filas) + 1}`);
    const malos = discrepanciasDeProductos(idsActuales, items);
    if (malos.length > 0) {
      return NextResponse.json({ ok: false, error: mensajeDiscrepancias(malos, "borró"), discrepancias: malos }, { status: 409 });
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
    logError("delete-from-sheet", error);
    return NextResponse.json({ ok: false, error: "Error al borrar filas" }, { status: 500 });
  }
}

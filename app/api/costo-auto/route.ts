import { NextResponse } from "next/server";
import axios from "axios";
import { ensureSheets, readSheet, writeSheet, appendSheet, batchWriteSheet } from "@/lib/sheets";
import { getValidAccessToken } from "@/lib/ml-token";
import { withMlRetry } from "@/lib/http-retry";
import { armarMapasDefontana } from "@/lib/defontana";
import type { FilaDefontana, FilaEquivalencia } from "@/lib/defontana";
import { obtenerVentasPorItem } from "@/lib/tarifa-envio";
import { HOJA_COSTO_ORIGEN, procesarCostoAuto } from "@/lib/costo-auto";
import type { PublicacionCosto, ResultadoCosto } from "@/lib/costo-auto";

// Completa el Costo (columna F de Publicaciones) con el MAYOR de la Lista
// Defontana (ver lib/costo-auto.ts para el cruce, las reglas y por qué el
// origen vive en la hoja CostoOrigen).
//
// Por defecto SIMULA (no escribe nada) y devuelve los conteos y las listas
// de sospechosos y sin match. Solo escribe con { "confirmar": true }: y aun
// así solo completa celdas de Costo vacías con cálculos limpios.
export const maxDuration = 60;

type ItemMl = {
  id: string; title?: string; price?: number; status?: string; seller_custom_field?: string | null;
  attributes?: { id: string; value_name?: string | null }[];
};

function atributo(item: ItemMl, id: string): string | null {
  return item.attributes?.find((a) => a.id === id)?.value_name?.trim() || null;
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const confirmar = body?.confirmar === true;

    const token = await getValidAccessToken();
    const client = axios.create({ baseURL: "https://api.mercadolibre.com", headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });
    const mlGet = <T = unknown>(url: string) => withMlRetry(() => client.get<T>(url), { maxAttempts: 3 });

    // Publicaciones: A(id) F(costo) S(unidades). Mismo rango que el Comparador.
    const filasPub = await readSheet("Publicaciones!A2:S3000");
    const enHoja = filasPub
      .map((r, i) => ({ r, fila: i + 2 }))
      .filter(({ r }) => r[0]);

    // Lista Defontana y equivalencias: mismo parseo que comparador-mayor.
    const filasDefontana: FilaDefontana[] = (await readSheet("Lista Defontana!A2:H100000"))
      .filter((r) => r[3])
      .map((r) => ({
        proveedor: r[0] ?? "", marca: r[1] ?? "", familia: r[2] ?? "",
        cod: r[3] ?? "", barras: r[4] ?? "", articulo: r[5] ?? "", mayor: Number(r[6]) || 0,
      }));
    const { porCod, porBarras } = armarMapasDefontana(filasDefontana);
    const equivalencias = new Map<string, FilaEquivalencia[]>();
    for (const r of await readSheet("Equivalencias Defontana!A2:C1000")) {
      if (!r[0] || !r[1]) continue;
      const eq: FilaEquivalencia = { publicacionId: r[0], componenteCod: r[1], cantidad: Number(r[2]) || 1 };
      if (!equivalencias.has(eq.publicacionId)) equivalencias.set(eq.publicacionId, []);
      equivalencias.get(eq.publicacionId)!.push(eq);
    }

    // Datos vigentes de ML (SKU, GTIN, precio, estado) en lotes de 20, con
    // concurrencia 4 (31 llamadas para ~620 publicaciones).
    const ids = enHoja.map(({ r }) => String(r[0]));
    const lotes: string[][] = [];
    for (let i = 0; i < ids.length; i += 20) lotes.push(ids.slice(i, i + 20));
    const itemsMl = new Map<string, ItemMl>();
    let siguiente = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (siguiente < lotes.length) {
        const lote = lotes[siguiente++];
        const { data } = await mlGet<{ code: number; body: ItemMl }[]>(
          `/items?ids=${lote.join(",")}&attributes=id,title,price,status,attributes,seller_custom_field`
        );
        for (const x of data) if (x.code === 200) itemsMl.set(x.body.id, x.body);
      }
    }));

    // Ingreso de los últimos 30 días, solo para ordenar las listas.
    const { data: user } = await mlGet<{ id: number }>("/users/me");
    const ventas = await obtenerVentasPorItem(mlGet, user.id, 30);

    const noEncontradas: string[] = [];
    const publicaciones: PublicacionCosto[] = [];
    for (const { r, fila } of enHoja) {
      const id = String(r[0]);
      const it = itemsMl.get(id);
      if (!it || !it.price) { noEncontradas.push(id); continue; }
      publicaciones.push({
        id,
        titulo: it.title ?? r[2] ?? id,
        sku: atributo(it, "SELLER_SKU") ?? it.seller_custom_field ?? null,
        gtin: atributo(it, "GTIN") ?? atributo(it, "EAN"),
        precio: it.price,
        estado: it.status ?? r[10] ?? "",
        unidades: Number(r[18]) || 1,
        costoActual: String(r[5] ?? ""),
        fila,
        ingreso30d: ventas.get(id)?.ingreso ?? 0,
      });
    }

    if (confirmar) await ensureSheets([HOJA_COSTO_ORIGEN]);
    const resumen = await procesarCostoAuto({
      readSheet, writeSheet, appendSheet, batchWriteSheet,
      publicaciones, porCod, porBarras, equivalencias, ahora: new Date(), dryRun: !confirmar,
    });

    const detalle = (r: ResultadoCosto) => ({
      id: r.p.id, titulo: r.p.titulo, sku: r.p.sku, estado: r.p.estado, precio: r.p.precio,
      costoActual: r.p.costoActual, costoCalculado: r.calculo.costo, fuente: r.calculo.fuente,
      articulo: r.calculo.articulo, motivos: r.motivos, ingreso30d: Math.round(r.p.ingreso30d),
    });
    const porIngreso = (a: ResultadoCosto, b: ResultadoCosto) => b.p.ingreso30d - a.p.ingreso30d;
    const { lista, ...conteos } = resumen;

    return NextResponse.json({
      ok: true,
      ...conteos,
      noEncontradasEnMl: noEncontradas.length,
      // Listas completas, ordenadas por ingreso de 30 días (mayor primero).
      sospechosos: lista.filter((r) => r.origen === "revisar").sort(porIngreso).map(detalle),
      sinMatch: lista.filter((r) => r.calculo.costo === null && r.p.costoActual.trim() === "").sort(porIngreso).map(detalle),
      aEscribirMuestra: lista.filter((r) => r.escribir).sort(porIngreso).slice(0, 10).map(detalle),
    });
  } catch (error) {
    console.error("[costo-auto]", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

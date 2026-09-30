import { NextRequest, NextResponse } from "next/server";
import axios from "axios";
import { getValidAccessToken } from "@/lib/ml-token";
import { createSyncBudget, withMlRetry } from "@/lib/http-retry";
import { readSheet } from "@/lib/sheets";
import { getComisionPct, IVA } from "@/lib/rentabilidad";
import { obtenerAdsPorItem, resolverAdvertiser } from "@/lib/ml-ads";
import {
  FilaDefontana, FilaEquivalencia,
  armarMapasDefontana, cruzarConDefontana, precioReferenciaEquivalencia,
} from "@/lib/defontana";
import { armarMuestrasEnvio, calcularEnvioEstimadoPorUnidad } from "@/lib/envio-estimado";

// Comparador vs Mayor — pestaña propia con endpoint propio (no dentro de
// metrics/route.ts): cubre TODAS las publicaciones activas con cruce
// (500+), no solo el top 50 de la Tabla por producto — mezclarlo con
// Métricas alargaría esa respuesta sin necesidad, dado que este endpoint
// no depende de ventas/visitas del período, solo de Sheets + ads del mes
// en curso. Usa exclusivamente datos ya en Sheets (Publicaciones, Lista
// Defontana, Equivalencias, Rentabilidad para envío real) — sin llamadas
// nuevas a ML salvo el batch de atributos (SKU/GTIN/listing_type) y ads
// por ítem, ambos ya necesarios para calcular el semáforo.
export const maxDuration = 60;

// Objetivo de margen por defecto sobre el Mayor, usado tanto en el semáforo
// como en el precio sugerido — configurable vía query param ?objetivo=0.15.
const OBJETIVO_DEFAULT = 0.10;

type FilaComparador = {
  id: string;
  titulo: string;
  marca: string | null;
  proveedor: string | null;
  precio: number;
  comisionPct: number;
  comisionMonto: number;
  envioPorUnidad: number;
  // "item": mediana real de este ítem en Rentabilidad. "tramo": sin
  // muestras propias, mediana del tramo de precio (preferido el mismo
  // "sku": sin muestras propias, mediana de OTRA publicación con el mismo
  // SELLER_SKU (mismo producto físico, otro listing). "sin_dato": ningún
  // nivel tiene muestra — envioPorUnidad queda en 0 y esto SÍ debe
  // mostrarse como advertencia, no como envío gratis real. Ver
  // lib/envio-estimado.ts para el orden de prioridad completo.
  envioFuente: "item" | "sku" | "tramo" | "sin_dato";
  envioMuestras: number;
  netoMlPorUnidad: number;
  precioMayor: number | null;
  // Mismo precio que precioMayor pero llevado a neto (÷1.19) — expuesto
  // explícitamente porque vsMayorPct se calcula contra ESTE valor, no
  // contra precioMayor bruto. Mostrar solo precioMayor (bruto) en pantalla
  // mientras el % se calcula contra precioMayorNeto generaba un
  // desajuste real entre lo que se ve y lo que se calculó (bug encontrado
  // 2026-09-30: Plaisance mostraba +3.8% comparando visualmente contra el
  // Mayor bruto, cuando el número correcto en esa base es -12.8%).
  precioMayorNeto: number | null;
  fuenteMayor: "cruce_directo" | "equivalencia" | "sin_referencia";
  vsMayorPct: number | null;
  precioSugerido: number | null;
  semaforo: "rojo" | "amarillo" | "verde" | null;
  campanaId: number | null;
  statusAnuncio: string | null;
  costoAdsPorUnidadPeriodo: number | null;
  vsMayorConAdsPct: number | null;
};

function semaforoDe(vsMayorPct: number): "rojo" | "amarillo" | "verde" {
  if (vsMayorPct < 0) return "rojo";
  if (vsMayorPct <= 10) return "amarillo";
  return "verde";
}

function getAttr(item: Record<string, unknown>, id: string): string | null {
  const attrs = (item.attributes as { id: string; value_name: string | null }[] | undefined) ?? [];
  return attrs.find((a) => a.id === id)?.value_name ?? null;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const objetivoParam = Number(searchParams.get("objetivo"));
  const objetivo = !Number.isNaN(objetivoParam) && objetivoParam > 0 ? objetivoParam : OBJETIVO_DEFAULT;

  try {
    const token = await getValidAccessToken();
    const mlClient = axios.create({
      baseURL: "https://api.mercadolibre.com",
      headers: { Authorization: `Bearer ${token}` },
      timeout: 8000,
    });
    const budget = createSyncBudget();
    const mlGet = <T = unknown>(url: string, params?: Record<string, unknown>, headers?: Record<string, string>) =>
      withMlRetry(() => mlClient.get<T>(url, { params, headers }), { budget });

    // Publicaciones activas — desde Sheets, columnas A(id) C(titulo)
    // F(costo, no se usa acá) G(precio) K(estado) L(listing_type_id) S(unidades).
    const filasPub = await readSheet("Publicaciones!A2:S1000");
    const activas = filasPub.filter((r) => r[0] && r[10] === "active");

    // Lista Defontana + Equivalencias — leídas una vez, reutilizadas para
    // todas las publicaciones.
    const filasDefontanaRaw = await readSheet("Lista Defontana!A2:H100000");
    const filasDefontana: FilaDefontana[] = filasDefontanaRaw
      .filter((r) => r[3])
      .map((r) => ({
        proveedor: r[0] ?? "", marca: r[1] ?? "", familia: r[2] ?? "",
        cod: r[3] ?? "", barras: r[4] ?? "", articulo: r[5] ?? "",
        mayor: Number(r[6]) || 0,
      }));
    const { porCod, porBarras } = armarMapasDefontana(filasDefontana);

    const filasEquivalenciasRaw = await readSheet("Equivalencias Defontana!A2:C1000");
    const equivalenciasPorPublicacion = new Map<string, FilaEquivalencia[]>();
    for (const r of filasEquivalenciasRaw) {
      if (!r[0] || !r[1]) continue;
      const eq: FilaEquivalencia = { publicacionId: r[0], componenteCod: r[1], cantidad: Number(r[2]) || 1 };
      if (!equivalenciasPorPublicacion.has(eq.publicacionId)) equivalenciasPorPublicacion.set(eq.publicacionId, []);
      equivalenciasPorPublicacion.get(eq.publicacionId)!.push(eq);
    }

    // Atributos de ML (SELLER_SKU, GTIN/EAN, listing_type_id, catalog_listing,
    // logistic_type) — batch de 20 ids, mismo endpoint/tope que ya usa ml-sync.
    const ids = activas.map((r) => String(r[0]));
    const atributosPorItem = new Map<string, { sku: string | null; gtin: string | null; listingTypeId: string; catalogListing: boolean; full: boolean }>();
    for (let i = 0; i < ids.length; i += 20) {
      const chunk = ids.slice(i, i + 20);
      const { data } = await mlGet<{ code: number; body: Record<string, unknown> }[]>(
        "/items",
        { ids: chunk.join(","), attributes: "id,attributes,seller_custom_field,listing_type_id,catalog_listing,shipping" }
      );
      for (const r of data) {
        if (r.code !== 200) continue;
        const id = String(r.body.id);
        const shipping = r.body.shipping as Record<string, unknown> | undefined;
        atributosPorItem.set(id, {
          sku: getAttr(r.body, "SELLER_SKU") ?? (r.body.seller_custom_field as string | null) ?? null,
          gtin: getAttr(r.body, "GTIN") ?? getAttr(r.body, "EAN"),
          listingTypeId: String(r.body.listing_type_id ?? ""),
          catalogListing: !!r.body.catalog_listing,
          full: shipping?.logistic_type === "fulfillment",
        });
      }
    }

    // Envío real por unidad — ver lib/envio-estimado.ts. Orden de
    // prioridad: 1) mediana del propio ítem en Rentabilidad, 2) mediana de
    // otra publicación con el mismo SELLER_SKU (mismo producto físico, otro
    // listing), 3) mediana del tramo de precio × logistic_type (Full si el
    // ítem es Full). Antes el fallback final usaba 0 cuando el ítem no
    // tenía datos propios — eso INFLABA el Neto ML al no descontar ningún
    // envío (bug encontrado 2026-09-30: Serum Dream Liso sin datos en
    // Rentabilidad mostraba Neto $6.121 vs $4.553 de su publicación gemela
    // con datos). El nivel "sku" (agregado 2026-09-30) captura justo ese
    // caso sin caer directo al tramo genérico, que mezcla decenas de
    // productos sin relación entre sí.
    const logisticoPorItem = new Map<string, string>();
    const skuPorItem = new Map<string, string>();
    for (const [id, attrs] of atributosPorItem) {
      if (attrs.full) logisticoPorItem.set(id, "fulfillment");
      if (attrs.sku) skuPorItem.set(id, attrs.sku);
    }
    const filasRentabilidad = await readSheet("Rentabilidad!A2:O100000");
    const muestrasEnvio = armarMuestrasEnvio(filasRentabilidad, skuPorItem, logisticoPorItem);

    // Ads del mes en curso — para "vs Mayor con ads". Mismo período que
    // usa metrics/route.ts para "mes": día 1 del mes actual a día 1 del
    // mes siguiente (/product_ads/.../search tolera fechas futuras).
    const ahora = new Date();
    const desdeAds = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), 1));
    const hastaAds = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth() + 1, 1));
    const advertiser = await resolverAdvertiser(mlGet);
    const adsPorItem = advertiser
      ? await obtenerAdsPorItem(mlGet, advertiser, desdeAds.toISOString().slice(0, 10), hastaAds.toISOString().slice(0, 10))
      : new Map();

    const filas: FilaComparador[] = [];
    for (const r of activas) {
      const id = String(r[0]);
      const titulo = r[2] ?? id;
      const precio = Number(r[6]);
      const unidades = Number(r[18]) || 1;
      if (!precio || Number.isNaN(precio)) continue; // sin precio, no se puede calcular nada

      const atributos = atributosPorItem.get(id);
      const comisionPct = atributos ? getComisionPct(atributos.listingTypeId, atributos.catalogListing) : 0.14;

      const { envio: envioPorUnidad, fuente: envioFuenteBase, muestras: envioMuestras } =
        calcularEnvioEstimadoPorUnidad(id, precio, atributos?.full ?? false, muestrasEnvio, atributos?.sku);
      const envioFuente: "item" | "sku" | "tramo" | "sin_dato" = envioMuestras === 0 ? "sin_dato" : envioFuenteBase;

      // Neto ML por unidad = precio − comisión − envío por unidad (todo bruto).
      const comisionBruta = precio * comisionPct;
      const netoMlPorUnidadBruto = precio - comisionBruta - envioPorUnidad;
      const netoMlPorUnidad = netoMlPorUnidadBruto / (1 + IVA);

      // Precio de referencia: equivalencia manual si existe, si no cruce
      // directo contra Lista Defontana × Unidades de la publicación.
      let precioMayor: number | null = null;
      let fuenteMayor: "cruce_directo" | "equivalencia" | "sin_referencia" = "sin_referencia";
      // matchDirecto también se usa para marca/proveedor — en equivalencias
      // se toma del PRIMER componente (todos los combos hoy son de la misma
      // marca/proveedor, ej. Elvive o Aer; si algún día un combo mezcla
      // marcas distintas, esto mostraría solo la del primer componente).
      let matchDirecto: FilaDefontana | null = null;
      const equivalencias = equivalenciasPorPublicacion.get(id);
      if (equivalencias && equivalencias.length > 0) {
        precioMayor = precioReferenciaEquivalencia(equivalencias, porCod);
        fuenteMayor = precioMayor !== null ? "equivalencia" : "sin_referencia";
        matchDirecto = porCod.get(equivalencias[0].componenteCod.trim().toUpperCase()) ?? null;
      } else if (atributos) {
        matchDirecto = cruzarConDefontana(atributos.sku, atributos.gtin, porCod, porBarras);
        if (matchDirecto) {
          precioMayor = matchDirecto.mayor * unidades;
          fuenteMayor = "cruce_directo";
        }
      }

      const precioMayorNeto = precioMayor !== null ? precioMayor / (1 + IVA) : null;
      const vsMayorPct = precioMayorNeto !== null && precioMayorNeto > 0
        ? Math.round(((netoMlPorUnidad - precioMayorNeto) / precioMayorNeto) * 1000) / 10
        : null;

      // Precio sugerido = (Mayor × (1+objetivo) + envío por unidad) / (1 − comisión%)
      // — todo llevado a neto, resultado en bruto (×1.19) para publicar directo.
      let precioSugerido: number | null = null;
      if (precioMayorNeto !== null) {
        const envioNeto = envioPorUnidad / (1 + IVA);
        const precioSugeridoNeto = (precioMayorNeto * (1 + objetivo) + envioNeto) / (1 - comisionPct);
        precioSugerido = Math.round(precioSugeridoNeto * (1 + IVA));
      }

      const ad = adsPorItem.get(id);
      const costoAdsPorUnidadPeriodo = ad ? Math.round((ad.cost / unidades) * 10) / 10 : null;
      let vsMayorConAdsPct: number | null = null;
      if (ad && precioMayorNeto !== null && precioMayorNeto > 0 && costoAdsPorUnidadPeriodo !== null) {
        const netoMlConAdsNeto = netoMlPorUnidad - costoAdsPorUnidadPeriodo / (1 + IVA);
        vsMayorConAdsPct = Math.round(((netoMlConAdsNeto - precioMayorNeto) / precioMayorNeto) * 1000) / 10;
      }

      filas.push({
        id, titulo,
        marca: matchDirecto?.marca ?? null,
        proveedor: matchDirecto?.proveedor ?? null,
        precio, comisionPct, comisionMonto: Math.round(comisionBruta * 10) / 10,
        envioPorUnidad, envioFuente, envioMuestras,
        netoMlPorUnidad: Math.round(netoMlPorUnidad * 10) / 10,
        precioMayor,
        precioMayorNeto: precioMayorNeto !== null ? Math.round(precioMayorNeto * 10) / 10 : null,
        fuenteMayor,
        vsMayorPct, precioSugerido,
        semaforo: vsMayorPct !== null ? semaforoDe(vsMayorPct) : null,
        campanaId: ad?.campaignId ?? null,
        statusAnuncio: ad?.status ?? null,
        costoAdsPorUnidadPeriodo,
        vsMayorConAdsPct,
      });
    }

    return NextResponse.json({ ok: true, objetivo, filas });
  } catch (error) {
    console.error("[comparador-mayor]", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

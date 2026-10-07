import { NextRequest, NextResponse } from "next/server";
import axios from "axios";
import { getValidAccessToken } from "@/lib/ml-token";
import { createSyncBudget, withMlRetry } from "@/lib/http-retry";
import { readSheet } from "@/lib/sheets";
import { IVA } from "@/lib/rentabilidad";
import { obtenerAdsPorItem, resolverAdvertiser } from "@/lib/ml-ads";
import {
  FilaDefontana, FilaEquivalencia,
  armarMapasDefontana, cruzarConDefontana, precioReferenciaEquivalencia,
} from "@/lib/defontana";
import { armarContextoEnvio, parsearTarifasEnvio, resolverEnvio } from "@/lib/envio-medido";
import { pctComisionListingPrices, resolverComision } from "@/lib/comision-real";
import type { ComisionResuelta } from "@/lib/comision-real";
import { obtenerVentasPorItem } from "@/lib/tarifa-envio";

// Comparador vs Mayor — pestaña propia con endpoint propio (no dentro de
// metrics/route.ts): cubre TODAS las publicaciones activas con cruce
// (500+), no solo el top 50 de la Tabla por producto — mezclarlo con
// Métricas alargaría esa respuesta sin necesidad, dado que este endpoint
// no depende de visitas del período, solo de Sheets + ads del mes en curso +
// las ventas de los últimos 45 días (para la comisión real, sale_fee). Datos
// de Sheets: Publicaciones, Lista Defontana, Equivalencias y TarifaEnvio
// (envío medido). Comisión y envío son REALES o quedan sin dato: nada de
// tasas por tipo de publicación ni envío = 0.
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
  // Comisión real (% del precio bruto) y su origen: "orden" = sale_fee
  // cobrado en las ventas de los últimos 45 días; "calculada" = calculadora
  // oficial de ML (sin ventas en la ventana). null = sin dato: neto, % vs
  // Mayor, precio sugerido y semáforo quedan vacíos (no se asume una tasa).
  comisionPct: number | null;
  comisionFuente: "orden" | "calculada" | null;
  comisionMonto: number | null;
  // "medido" = tarifa real de /shipments/{id}/costs (hoja TarifaEnvio);
  // "estimado" = respaldo (SKU gemelo, tramo o fila marcada estimada) y la
  // pantalla debe mostrarlo como tal; "sin_dato" = envioPorUnidad null y no
  // se calcula nada que dependa de él (antes se usaba 0, lo que inflaba el
  // neto). Ver lib/envio-medido.ts.
  envioPorUnidad: number | null;
  envioFuente: "medido" | "estimado" | "sin_dato";
  netoMlPorUnidad: number | null;
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

    // Lecturas de Sheets en paralelo (independientes entre sí). Publicaciones
    // activas — columnas A(id) C(titulo) F(costo, no se usa acá) G(precio)
    // K(estado) L(listing_type_id) S(unidades).
    const [filasPub, filasDefontanaRaw, filasEquivalenciasRaw, filasTarifaEnvio] = await Promise.all([
      readSheet("Publicaciones!A2:S1000"),
      readSheet("Lista Defontana!A2:H100000"),
      readSheet("Equivalencias Defontana!A2:C1000"),
      readSheet("TarifaEnvio!A2:L5000").catch(() => [] as string[][]),
    ]);
    const activas = filasPub.filter((r) => r[0] && r[10] === "active");

    // Lista Defontana + Equivalencias — leídas una vez, reutilizadas para
    // todas las publicaciones.
    const filasDefontana: FilaDefontana[] = filasDefontanaRaw
      .filter((r) => r[3])
      .map((r) => ({
        proveedor: r[0] ?? "", marca: r[1] ?? "", familia: r[2] ?? "",
        cod: r[3] ?? "", barras: r[4] ?? "", articulo: r[5] ?? "",
        mayor: Number(r[6]) || 0,
      }));
    const { porCod, porBarras } = armarMapasDefontana(filasDefontana);

    const equivalenciasPorPublicacion = new Map<string, FilaEquivalencia[]>();
    for (const r of filasEquivalenciasRaw) {
      if (!r[0] || !r[1]) continue;
      const eq: FilaEquivalencia = { publicacionId: r[0], componenteCod: r[1], cantidad: Number(r[2]) || 1 };
      if (!equivalenciasPorPublicacion.has(eq.publicacionId)) equivalenciasPorPublicacion.set(eq.publicacionId, []);
      equivalenciasPorPublicacion.get(eq.publicacionId)!.push(eq);
    }

    const ids = activas.map((r) => String(r[0]));
    // Ads del mes en curso — para "vs Mayor con ads". Mismo período que
    // usa metrics/route.ts para "mes": día 1 del mes actual a día 1 del
    // mes siguiente (/product_ads/.../search tolera fechas futuras).
    const ahora = new Date();
    const desdeAds = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), 1));
    const hastaAds = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth() + 1, 1));

    // Las tres cargas de ML siguientes NO dependen entre sí, así que corren
    // en paralelo (antes iban en serie y sumaban ~31 s; medido por fase
    // 2026-10-07: atributos 6,5 s, ventas 3,6 s, anuncios ~4 s):
    //  - Atributos de ML (SELLER_SKU, GTIN/EAN, listing_type_id, category_id,
    //    logistic_type) — lotes de 20 ids, mismo endpoint/tope que ml-sync,
    //    con concurrencia 4. listing_type_id/category_id solo para la
    //    comisión calculada de las publicaciones sin ventas recientes.
    //  - Ventas de los últimos 45 días (sale_fee → comisión real).
    //  - Ads por ítem.
    type AtributosItem = { sku: string | null; gtin: string | null; listingTypeId: string; categoryId: string; full: boolean };
    const cargarAtributos = async () => {
      const out = new Map<string, AtributosItem>();
      const lotes: string[][] = [];
      for (let i = 0; i < ids.length; i += 20) lotes.push(ids.slice(i, i + 20));
      let siguienteLote = 0;
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (siguienteLote < lotes.length) {
          const chunk = lotes[siguienteLote++];
          const { data } = await mlGet<{ code: number; body: Record<string, unknown> }[]>(
            "/items",
            { ids: chunk.join(","), attributes: "id,attributes,seller_custom_field,listing_type_id,category_id,shipping" }
          );
          for (const r of data) {
            if (r.code !== 200) continue;
            const id = String(r.body.id);
            const shipping = r.body.shipping as Record<string, unknown> | undefined;
            out.set(id, {
              sku: getAttr(r.body, "SELLER_SKU") ?? (r.body.seller_custom_field as string | null) ?? null,
              gtin: getAttr(r.body, "GTIN") ?? getAttr(r.body, "EAN"),
              listingTypeId: String(r.body.listing_type_id ?? ""),
              categoryId: String(r.body.category_id ?? ""),
              full: shipping?.logistic_type === "fulfillment",
            });
          }
        }
      }));
      return out;
    };
    const cargarVentas = async () => {
      const { data: yo } = await mlGet<{ id: number }>("/users/me");
      return obtenerVentasPorItem(mlGet, yo.id, 45);
    };
    const cargarAds = async () => {
      const advertiser = await resolverAdvertiser(mlGet);
      return advertiser
        ? await obtenerAdsPorItem(mlGet, advertiser, desdeAds.toISOString().slice(0, 10), hastaAds.toISOString().slice(0, 10))
        : new Map();
    };
    const [atributosPorItem, ventas45, adsPorItem] = await Promise.all([cargarAtributos(), cargarVentas(), cargarAds()]);

    // Envío por unidad: tarifa MEDIDA de la hoja TarifaEnvio, con respaldo
    // marcado "estimado" (ver lib/envio-medido.ts). Ya no sale de Rentabilidad:
    // esa estimación erraba ~300% (mediana) y dejaba 511 de 573 publicaciones
    // en rojo con precios sugeridos muy por encima del actual (medido
    // 2026-10-07). Sin tarifa ni respaldo → "sin_dato" (nunca envío = 0).
    const logisticoPorItem = new Map<string, string>();
    const skuPorItem = new Map<string, string>();
    const precioPorItem = new Map<string, number>();
    for (const r of filasPub) { const pr = Number(r[6]); if (r[0] && pr > 0) precioPorItem.set(String(r[0]), pr); }
    for (const [id, attrs] of atributosPorItem) {
      logisticoPorItem.set(id, attrs.full ? "fulfillment" : "otro");
      if (attrs.sku) skuPorItem.set(id, attrs.sku);
    }
    const ctxEnvio = armarContextoEnvio(parsearTarifasEnvio(filasTarifaEnvio), precioPorItem, skuPorItem, logisticoPorItem);

    // Comisión real: sale_fee de las ventas de los últimos 45 días; si la
    // publicación no vendió, la calculadora oficial de ML ("calculada").
    // Concurrencia 8 para esa calculadora (hoy ~330 publicaciones sin ventas);
    // necesita los atributos y las ventas, por eso va después del paralelo.
    const comisionAcc = new Map([...ventas45].map(([id, v]) => [id, { ingreso: v.ingresoConComision, comision: v.comision }]));
    const comisionPorItem = new Map<string, ComisionResuelta>();
    let siguienteComision = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (siguienteComision < ids.length) {
        const id = ids[siguienteComision++];
        const at = atributosPorItem.get(id);
        const precio = precioPorItem.get(id);
        comisionPorItem.set(id, await resolverComision(id, comisionAcc, () =>
          at && precio ? pctComisionListingPrices(mlGet, { precio, listingTypeId: at.listingTypeId, categoryId: at.categoryId }) : Promise.resolve(null)
        ));
      }
    }));

    const filas: FilaComparador[] = [];
    for (const r of activas) {
      const id = String(r[0]);
      const titulo = r[2] ?? id;
      const precio = Number(r[6]);
      const unidades = Number(r[18]) || 1;
      if (!precio || Number.isNaN(precio)) continue; // sin precio, no se puede calcular nada

      const atributos = atributosPorItem.get(id);
      const comision = comisionPorItem.get(id) ?? { pct: null, fuente: null };
      const comisionPct = comision.pct;

      const envio = resolverEnvio(id, precio, atributos?.full ?? false, atributos?.sku ?? null, ctxEnvio);
      const envioPorUnidad = envio.envio;
      const envioFuente: "medido" | "estimado" | "sin_dato" = envio.fuente ?? "sin_dato";

      // Neto ML por unidad = precio − comisión − envío por unidad (todo
      // bruto). Sin comisión o sin envío no se calcula (null), no se asume.
      const comisionBruta = comisionPct !== null ? precio * comisionPct : null;
      const netoMlPorUnidad = comisionBruta !== null && envioPorUnidad !== null
        ? (precio - comisionBruta - envioPorUnidad) / (1 + IVA)
        : null;

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
      const vsMayorPct = precioMayorNeto !== null && precioMayorNeto > 0 && netoMlPorUnidad !== null
        ? Math.round(((netoMlPorUnidad - precioMayorNeto) / precioMayorNeto) * 1000) / 10
        : null;

      // Precio sugerido = (Mayor × (1+objetivo) + envío por unidad) / (1 − comisión%)
      // — todo llevado a neto, resultado en bruto (×1.19) para publicar directo.
      let precioSugerido: number | null = null;
      if (precioMayorNeto !== null && comisionPct !== null && envioPorUnidad !== null) {
        const envioNeto = envioPorUnidad / (1 + IVA);
        const precioSugeridoNeto = (precioMayorNeto * (1 + objetivo) + envioNeto) / (1 - comisionPct);
        precioSugerido = Math.round(precioSugeridoNeto * (1 + IVA));
      }

      const ad = adsPorItem.get(id);
      const costoAdsPorUnidadPeriodo = ad ? Math.round((ad.cost / unidades) * 10) / 10 : null;
      let vsMayorConAdsPct: number | null = null;
      if (ad && precioMayorNeto !== null && precioMayorNeto > 0 && costoAdsPorUnidadPeriodo !== null && netoMlPorUnidad !== null) {
        const netoMlConAdsNeto = netoMlPorUnidad - costoAdsPorUnidadPeriodo / (1 + IVA);
        vsMayorConAdsPct = Math.round(((netoMlConAdsNeto - precioMayorNeto) / precioMayorNeto) * 1000) / 10;
      }

      filas.push({
        id, titulo,
        marca: matchDirecto?.marca ?? null,
        proveedor: matchDirecto?.proveedor ?? null,
        precio,
        comisionPct: comisionPct !== null ? Math.round(comisionPct * 1000) / 1000 : null,
        comisionFuente: comision.fuente,
        comisionMonto: comisionBruta !== null ? Math.round(comisionBruta * 10) / 10 : null,
        envioPorUnidad, envioFuente,
        netoMlPorUnidad: netoMlPorUnidad !== null ? Math.round(netoMlPorUnidad * 10) / 10 : null,
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

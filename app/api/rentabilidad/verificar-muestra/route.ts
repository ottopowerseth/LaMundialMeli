import { NextResponse } from "next/server";
import axios from "axios";
import { readSheet } from "@/lib/sheets";
import { getValidAccessToken } from "@/lib/ml-token";
import { createSyncBudget, withMlRetry } from "@/lib/http-retry";

// Verificación estratificada post-corrida (decisión de Otto 2026-10-02):
// 15 filas ya escritas con fuente "costs" — 5 despachos Full
// individuales, 5 hermanas (despacho compartido), 3 xd_drop_off, 2 de
// varias unidades (item_amount>1 sin pack) — comparadas contra
// /shipments/{id}/costs EN VIVO. Deben coincidir exactamente (salvo que
// el costo haya cambiado desde que se escribió, lo cual se reporta como
// discrepancia real, no como fallo del fix).
//
// Más un chequeo SIN llamadas a la API: para cada despacho compartido
// donde TODAS sus órdenes hermanas estén en Rentabilidad (verificable
// sumando envioPorUnidad × unidades de cada hermana), la suma debe ser
// igual a costoTotalDespacho — lista las excepciones (hermanas faltantes
// o suma que no cuadra).
export const maxDuration = 60;

type FilaRent = { idx: number; ordenId: string; itemId: string; envio: number; envioPorUnidad: number; fuente: string; fecha: string; unidades: number };

export async function POST() {
  try {
    const token = await getValidAccessToken();
    const client = axios.create({
      baseURL: "https://api.mercadolibre.com",
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    });
    const budget = createSyncBudget();
    const mlGet = <T = unknown>(url: string) =>
      withMlRetry(() => client.get<T>(url, { headers: { "Api-Version": "1", "Content-Type": "application/json" } }), { budget });

    const filasRentRaw = await readSheet("Rentabilidad!A2:Q100000");
    const filasCosts: FilaRent[] = filasRentRaw
      .map((r, idx) => ({
        idx, ordenId: String(r[0]).replace(/^'/, ""), itemId: r[2],
        envio: Number(r[7]), envioPorUnidad: Number(r[14]), fuente: r[15] ?? "",
        fecha: r[1], unidades: Number(r[13]) || 1,
      }))
      .filter(f => f.fuente === "costs");

    const cacheRows = await readSheet("ShippingCache!A2:I100000");
    const cachePorOrden = new Map<string, { shippingId: string; logisticType: string; costoTotalDespacho: number | null; unidadesDespacho: number | null; unidadesEstaOrden: number | null; itemsDespachoJson: string }>();
    for (const r of cacheRows) {
      if (!r[0]) continue;
      const ordenId = String(r[0]).replace(/^'/, "");
      const fuente = r[7];
      if (fuente !== "costs") continue;
      cachePorOrden.set(ordenId, {
        shippingId: r[1] ?? "", logisticType: r[2] ?? "",
        costoTotalDespacho: r[4] !== "" ? Number(r[4]) : null,
        unidadesDespacho: r[5] !== "" ? Number(r[5]) : null,
        unidadesEstaOrden: r[6] !== "" ? Number(r[6]) : null,
        itemsDespachoJson: r[8] ?? "",
      });
    }

    // Clasificar cada fila por estrato.
    const individualesFull: FilaRent[] = [];
    const hermanas: FilaRent[] = [];
    const xdDropOff: FilaRent[] = [];
    const variasUnidades: FilaRent[] = [];

    for (const f of filasCosts) {
      const cache = cachePorOrden.get(f.ordenId);
      if (!cache) continue;
      if (cache.logisticType === "xd_drop_off") { xdDropOff.push(f); continue; }
      const esCompartido = cache.unidadesDespacho !== cache.unidadesEstaOrden || !!cache.itemsDespachoJson;
      if (esCompartido) { hermanas.push(f); continue; }
      if ((cache.unidadesEstaOrden ?? 1) > 1) { variasUnidades.push(f); continue; }
      individualesFull.push(f);
    }

    function muestraAlAzar<T>(arr: T[], n: number): T[] {
      const copia = [...arr];
      const out: T[] = [];
      while (out.length < n && copia.length > 0) {
        const i = Math.floor(Math.random() * copia.length);
        out.push(copia.splice(i, 1)[0]);
      }
      return out;
    }

    const muestra = [
      ...muestraAlAzar(individualesFull, 5),
      ...muestraAlAzar(hermanas, 5),
      ...muestraAlAzar(xdDropOff, 3),
      ...muestraAlAzar(variasUnidades, 2),
    ];

    const verificaciones = [];
    for (const f of muestra) {
      const cache = cachePorOrden.get(f.ordenId);
      if (!cache?.shippingId) continue;
      const { data: costs } = await mlGet<{ senders?: { cost?: number }[] }>(`/shipments/${cache.shippingId}/costs`);
      const costoEnVivo = costs.senders?.[0]?.cost;
      const unidadesDespacho = cache.unidadesDespacho ?? 1;
      const envioPorUnidadEnVivo = costoEnVivo !== undefined ? Math.round((costoEnVivo / unidadesDespacho) * 10) / 10 : null;
      const coincide = envioPorUnidadEnVivo !== null && Math.abs(envioPorUnidadEnVivo - f.envioPorUnidad) < 0.5;
      verificaciones.push({
        ordenId: f.ordenId, itemId: f.itemId,
        envioPorUnidadEscrito: f.envioPorUnidad, envioPorUnidadEnVivo, coincide,
      });
    }

    // Chequeo sin API: despachos compartidos con TODAS sus hermanas en
    // Rentabilidad — suma de envío asignado debe igualar costoTotalDespacho.
    const porShipping = new Map<string, FilaRent[]>();
    for (const f of hermanas) {
      const cache = cachePorOrden.get(f.ordenId);
      if (!cache?.shippingId) continue;
      if (!porShipping.has(cache.shippingId)) porShipping.set(cache.shippingId, []);
      porShipping.get(cache.shippingId)!.push(f);
    }
    const excepcionesSuma: { shippingId: string; ordenes: string[]; sumaAsignada: number; costoTotalDespacho: number | null; unidadesSumadas: number; unidadesEsperadas: number | null }[] = [];
    for (const [shippingId, filasDelShipping] of porShipping) {
      const cache = cachePorOrden.get(filasDelShipping[0].ordenId);
      if (!cache) continue;
      const sumaAsignada = Math.round(filasDelShipping.reduce((s, f) => s + f.envio, 0) * 10) / 10;
      const unidadesSumadas = filasDelShipping.reduce((s, f) => s + f.unidades, 0);
      const coincideSuma = cache.costoTotalDespacho !== null && Math.abs(sumaAsignada - cache.costoTotalDespacho) < 1;
      const coincideUnidades = cache.unidadesDespacho !== null && unidadesSumadas === cache.unidadesDespacho;
      if (!coincideSuma || !coincideUnidades) {
        excepcionesSuma.push({
          shippingId, ordenes: filasDelShipping.map(f => f.ordenId),
          sumaAsignada, costoTotalDespacho: cache.costoTotalDespacho,
          unidadesSumadas, unidadesEsperadas: cache.unidadesDespacho,
        });
      }
    }

    return NextResponse.json({
      ok: true,
      estratos: {
        individualesFull: individualesFull.length,
        hermanas: hermanas.length,
        xdDropOff: xdDropOff.length,
        variasUnidades: variasUnidades.length,
      },
      verificaciones,
      todasCoinciden: verificaciones.every(v => v.coincide),
      excepcionesSuma,
    });
  } catch (error) {
    console.error("[rentabilidad/verificar-muestra]", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

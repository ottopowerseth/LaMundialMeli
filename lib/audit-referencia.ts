import { listarOrdenesRango, type GetFn } from "@/lib/backfill-shipping";

// Referencia de ventas brutas del ciclo de facturación según la API de Mercado Libre. Auditoría la usa como fuente oficial
// de ventas_brutas (lib/audit.ts: calculateAudit) en lugar de lo calculado desde los archivos.
//
// Antes se paginaba /orders/search con offset hasta 1.000 (máx. 1.050 órdenes): un ciclo con más órdenes quedaba cortado
// (se perdían las más viejas) y la tasa efectiva salía inflada (con las órdenes grabadas: ciclo 2026-08 -12 %, 2026-09 -34 %).
// Ahora se recorre por ventanas de un día (ventanasDeUnDia + listarOrdenesRango, la misma lógica de Métricas, del backfill y
// del sync de Ventas). Si una ventana llega al tope de resultados de ML, la referencia queda INCOMPLETA y no debe usarse.

export type ReferenciaVentas = {
  ventasBrutas: number;
  cantidadVentas: number;
  incompleta: boolean;     // alguna ventana llegó al tope de resultados de ML: el total puede estar cortado
  sinVentas: boolean;      // completa pero con 0 ventas: no hay con qué comparar, se trata como «sin referencia»
  ventanasAlTope: number;
  aviso: string | null;    // texto para el log y para el resultado cuando la referencia es incompleta
};

// desdeMs inclusive, hastaMs exclusivo. Solo órdenes pagadas (igual que antes).
export async function calcularReferenciaVentas(get: GetFn, userId: string | number, desdeMs: number, hastaMs: number): Promise<ReferenciaVentas> {
  const { ordenes, ventanasAlTope } = await listarOrdenesRango<{ id: number | string; date_created?: unknown; total_amount?: unknown }>(
    get, userId, desdeMs, hastaMs, { extraQuery: "&order.status=paid" }
  );
  let ventasBrutas = 0;
  for (const o of ordenes) ventasBrutas += Number(o.total_amount) || 0;
  const incompleta = ventanasAlTope > 0;
  const sinVentas = !incompleta && ventasBrutas <= 0;
  return {
    ventasBrutas,
    cantidadVentas: ordenes.length,
    incompleta,
    sinVentas,
    ventanasAlTope,
    aviso: incompleta
      ? `La referencia de ventas de Mercado Libre quedó incompleta (${ventanasAlTope} ventana(s) de un día llegaron al tope de resultados de ML); no se usó para las ventas brutas, que quedan con el valor calculado desde el archivo de ML.`
      : sinVentas
        ? "Mercado Libre devolvió 0 ventas pagadas para este ciclo, así que no hay referencia con la que comparar: las ventas brutas salen del archivo de ML."
        : null,
  };
}

// Qué valor de referencia puede pisar a ventas_brutas: solo una referencia completa y con ventas. Con null (ML falló),
// incompleta o de total 0 devuelve undefined y calculateAudit se queda con lo calculado desde el archivo de ML
// (un 0 nunca pisa ventas_brutas).
export function ventasBrutasParaAuditoria(referencia: ReferenciaVentas | null): number | undefined {
  return referencia && !referencia.incompleta && !referencia.sinVentas ? referencia.ventasBrutas : undefined;
}

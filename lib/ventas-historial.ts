import { listarOrdenesRango, type GetFn } from "@/lib/backfill-shipping";

// Historial de órdenes que ml-sync escribe en la hoja Ventas (y que lee Forecast): los últimos DIAS_HISTORIAL_VENTAS días.
//
// Antes se paginaba /orders/search por offset hasta 2.000 (máx. ~2.050 órdenes) y el historial quedaba corto cuando las
// ventas subían (la hoja llegaba solo a 31 de los 35 días pedidos). Ahora se recorre por ventanas de un día
// (listarOrdenesRango, la misma lógica de Métricas y del backfill), que no dependen del tope de offset de ML.
//
// Trae TODOS los estados (la hoja tiene la columna Estado): no se filtra por "paid".

export const DIAS_HISTORIAL_VENTAS = 35;
const DIA_MS = 86400000;
const MARGEN_FUTURO_MS = 60_000; // para no dejar fuera una orden creada mientras corre el sync

type Orden = Record<string, unknown> & { id: number | string; date_created?: unknown };

export type HistorialVentas = {
  ordenes: Record<string, unknown>[]; // sin repetidas, de la más reciente a la más vieja
  ventanas: number;
  repetidas: number;      // órdenes que ML devolvió en dos ventanas y se descartaron
  ventanasAlTope: number; // ventanas que llegaron al tope de resultados de ML (lista truncada)
  aviso: string | null;   // texto para el log y la respuesta del sync cuando hay truncamiento
};

export async function cargarHistorialVentas(get: GetFn, userId: string | number, ahoraMs: number): Promise<HistorialVentas> {
  const { ordenes, ventanas, repetidas, ventanasAlTope } = await listarOrdenesRango<Orden>(
    get, userId, ahoraMs - DIAS_HISTORIAL_VENTAS * DIA_MS, ahoraMs + MARGEN_FUTURO_MS
  );
  // Más recientes primero (el orden que tenía la hoja y el que usa seleccionarEnviosPendientes). Orden estable.
  const ms = (o: Orden) => { const t = Date.parse(String(o.date_created)); return Number.isNaN(t) ? 0 : t; };
  ordenes.sort((a, b) => ms(b) - ms(a));
  const aviso = ventanasAlTope > 0
    ? `Ventas: ${ventanasAlTope} ventana(s) de un día llegaron al tope de resultados de Mercado Libre; el historial puede estar incompleto.`
    : null;
  return { ordenes, ventanas, repetidas, ventanasAlTope, aviso };
}

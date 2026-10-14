import { ventasBrutasParaAuditoria, type ReferenciaVentas } from "@/lib/audit-referencia";

// Reglas de /api/audit/analyze antes de guardar la fila del mes en la hoja Auditoría: de dónde salió ventas_brutas y qué
// tasa efectiva se acepta. Funciones puras (sin red ni Sheets) para poder probarlas.

// Columna R de la hoja Auditoría (después de Q, que es «Almacenamiento_Full_Rentabilidad» y la llena Rentabilidad):
// queda al final para no correr los índices que leen el historial (page.tsx) y Rentabilidad.
export const HEADER_FUENTE = "Fuente Ventas Brutas";
export const FUENTE_REFERENCIA_ML = "referencia ML";
export const FUENTE_REFERENCIA_INCOMPLETA = "referencia incompleta";
export const FUENTE_ARCHIVO_ML = "archivo ML (sin referencia)";

// Fuente del valor de ventas_brutas que se guarda. Coincide con lo que hace calculateAudit: solo una referencia completa y
// con ventas pisa el valor; con null (ML falló), incompleta o de total 0 se queda lo calculado desde el archivo de ML.
export function fuenteVentasBrutas(referencia: ReferenciaVentas | null): string {
  if (ventasBrutasParaAuditoria(referencia) !== undefined) return FUENTE_REFERENCIA_ML;
  return referencia?.incompleta ? FUENTE_REFERENCIA_INCOMPLETA : FUENTE_ARCHIVO_ML;
}

// Una tasa (cargos de ML / ventas brutas) mayor al 100 % es imposible: no se guarda. No hay rango «habitual» de aviso: la tasa
// incluye envío y publicidad (en los reportes reales ronda 40 %-55 %), así que un rango sacado de filas de prueba solo daría falsas alarmas.
export const TASA_MAXIMA = 100;

const clp = (n: number) => "$" + Math.round(n).toLocaleString("es-CL");

export type EvaluacionTasa = { tasa: number | null; rechazo: string | null };

// totalCargosML = cargos de ML del ciclo (cargo por venta + envío + publicidad y mantenimiento, netos de anulaciones, NC y Flex).
export function evaluarTasaEfectiva(totalCargosML: number, ventasBrutas: number): EvaluacionTasa {
  if (ventasBrutas <= 0) {
    // Sin ventas la tasa no existe: con cargos es incoherente (se rechaza); sin cargos tampoco hay nada que validar.
    if (totalCargosML > 0) {
      return {
        tasa: null,
        rechazo: `Las ventas brutas del ciclo son ${clp(ventasBrutas)} pero hay cargos de ML por ${clp(totalCargosML)}: no se puede calcular la tasa y no se guardó nada. Probablemente el archivo de Facturación ML no corresponde al ciclo de facturación de este mes.`,
      };
    }
    return { tasa: 0, rechazo: null };
  }
  const tasa = (totalCargosML / ventasBrutas) * 100;
  if (tasa > TASA_MAXIMA) {
    return {
      tasa,
      rechazo: `Los cargos de ML (${clp(totalCargosML)}) superan las ventas brutas (${clp(ventasBrutas)}): la tasa de cargos ML sería ${tasa.toFixed(2).replace(".", ",")} %, imposible. No se guardó nada. Probablemente el archivo de Facturación ML no corresponde al ciclo de facturación de este mes, o las ventas de referencia no son las de este ciclo.`,
    };
  }
  return { tasa, rechazo: null };
}

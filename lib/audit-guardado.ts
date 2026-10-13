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

// Una tasa efectiva (comisiones / ventas brutas) mayor al 100 % es imposible: no se guarda. El rango «habitual» solo
// genera un aviso (no bloquea). Rango tomado de las filas válidas actuales de la hoja (≈12,5 % a 14,5 %) con margen;
// ajustar acá si el negocio cambia.
export const TASA_MAXIMA = 100;
export const TASA_HABITUAL = { min: 8, max: 25 };

const clp = (n: number) => "$" + Math.round(n).toLocaleString("es-CL");

export type EvaluacionTasa = { tasa: number | null; rechazo: string | null; aviso: string | null };

export function evaluarTasaEfectiva(totalComisiones: number, ventasBrutas: number): EvaluacionTasa {
  if (ventasBrutas <= 0) {
    // Sin ventas la tasa no existe: con comisiones es incoherente (se rechaza); sin comisiones tampoco hay nada que validar.
    if (totalComisiones > 0) {
      return {
        tasa: null,
        rechazo: `Las ventas brutas del ciclo son ${clp(ventasBrutas)} pero hay comisiones por ${clp(totalComisiones)}: no se puede calcular la tasa efectiva y no se guardó nada. Probablemente un archivo (Facturación ML o MP) no corresponde al ciclo de facturación de este mes.`,
        aviso: null,
      };
    }
    return { tasa: 0, rechazo: null, aviso: null };
  }
  const tasa = (totalComisiones / ventasBrutas) * 100;
  const tasaTexto = tasa.toFixed(2).replace(".", ",");
  if (tasa > TASA_MAXIMA) {
    return {
      tasa,
      rechazo: `Las comisiones (${clp(totalComisiones)}) superan las ventas brutas (${clp(ventasBrutas)}): la tasa efectiva sería ${tasaTexto} %, imposible. No se guardó nada. Probablemente un archivo (Facturación ML o MP) no corresponde al ciclo de facturación de este mes, o las comisiones de MP incluyen operaciones liquidadas fuera del ciclo.`,
      aviso: null,
    };
  }
  if (tasa < TASA_HABITUAL.min || tasa > TASA_HABITUAL.max) {
    return {
      tasa,
      rechazo: null,
      aviso: `La tasa efectiva (${tasaTexto} %) está fuera del rango habitual (${TASA_HABITUAL.min} % a ${TASA_HABITUAL.max} %). Se guardó igual; conviene revisar que los archivos correspondan al ciclo.`,
    };
  }
  return { tasa, rechazo: null, aviso: null };
}

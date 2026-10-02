import { NextResponse } from "next/server";
import axios from "axios";
import { readSheet, batchWriteSheet, appendSheet } from "@/lib/sheets";
import { getValidAccessToken } from "@/lib/ml-token";
import { createSyncBudget, withMlRetry, SyncRetryBudgetExceededError } from "@/lib/http-retry";
import { calcularMargen } from "@/lib/rentabilidad";
import { procesarTanda } from "@/lib/envio-real";

// Modo "completar" — orquesta varias tandas de procesarTanda() (misma
// lógica que rentabilidad/recalcular-envio, ver lib/envio-real.ts) DENTRO
// de una sola invocación, hasta agotar el tiempo de la invocación o
// cumplir una condición de parada. Pensado para llamarse repetidamente
// (desde la conversación, no automatizado) hasta que pendientesTotal
// llegue a 0 — cada llamada retoma donde quedó el checkpoint de la
// columna Fuente Envío, igual que recalcular-envio.
//
// Condiciones de parada AUTOMÁTICA de la corrida completa (no solo de la
// invocación por tiempo) — decisión de Otto 2026-10-02:
//   - billing_sin_costs ACUMULADO de la corrida (no de una tanda de 30)
//     supera el 10%, evaluado solo a partir de MINIMO_FILAS_PARA_UMBRAL
//     (60) filas procesadas en total — con menos de 60, un par de fallas
//     puntuales dispararía el umbral por simple ruido de muestra chica.
//   - Cualquier fila resultante con envío $0 (salvaguarda: no debería
//     pasar nunca, procesarTanda ya descarta $0 como billing_sin_costs,
//     pero se re-verifica explícito antes de reportar progreso).
//   - Un error de la API con status distinto de 429 (429 ya tiene retry
//     automático en withMlRetry/createSyncBudget).
// Siempre corre con omitirMarca:true — las marcas se asignan en la pasada
// final dedicada (rentabilidad/marcar-mixto), después de que esto termine.
//
// Cada tanda escribe sus filas DENTRO de procesarTanda() (batchWriteSheet/
// appendSheet), no al final de este loop — si la invocación corta a
// mitad de camino, todo lo ya procesado por tandas completas queda
// persistido; nada se pierde ni se reintenta de más.
export const maxDuration = 60;
// Tope por invocación de esta ruta orquestadora — deja margen a MÚLTIPLES
// tandas dentro de la misma invocación de 60s, cortando antes de iniciar
// una tanda nueva (nunca a mitad de una tanda en curso) para no arriesgar
// el límite duro de Vercel.
const TIEMPO_MAXIMO_INVOCACION_MS = 50000;
const TIEMPO_MAXIMO_POR_TANDA_MS = 15000;
const FILAS_POR_TANDA = 30;
const UMBRAL_BILLING_SIN_COSTS = 0.10;
const MINIMO_FILAS_PARA_UMBRAL = 60;

type ProgresoTanda = {
  tanda: number;
  hechas: number;
  pendientesTotalRestantes: number;
  billingSinCosts: number;
  billingSinCostsAcumulado: number;
  envioSubio: { ordenId: string; itemId: string; envioViejo: number; envioNuevo: number }[];
};

async function contarPendientes(readSheetFn: (range: string) => Promise<string[][]>): Promise<number> {
  const filas = await readSheetFn("Rentabilidad!P2:P100000");
  return filas.filter(r => (r[0] ?? "") !== "costs" && (r[0] ?? "") !== "billing_sin_costs").length;
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    // Por defecto corre en modo "simulación" (dryRun en cada tanda, nunca
    // escribe) — decisión de Otto 2026-10-02: solo escribe de verdad con
    // confirmar:true explícito en el body. Sin esto, cada tanda simulada
    // usa dryRunLimite=FILAS_POR_TANDA para procesar el mismo volumen que
    // escribiría en modo real, así el progreso reportado es representativo.
    const confirmar = body?.confirmar === true;
    // Limitación conocida del modo simulación: procesarTanda en dryRun
    // ignora el checkpoint (para poder mostrar antes/después de filas ya
    // resueltas), así que SIN confirmar, cada tanda de este loop simula
    // sobre el MISMO primer lote de pendientes repetidamente — no avanza
    // tanda a tanda como lo haría el modo real. Sirve para ver el
    // comportamiento típico de una tanda (progreso, billing_sin_costs,
    // envioSubio) antes de confirmar, no para simular la corrida completa
    // de punta a punta. Se corta a 1 sola tanda cuando !confirmar, para no
    // repetir la misma simulación varias veces sin aportar información
    // nueva.
    const inicioInvocacion = Date.now();
    const token = await getValidAccessToken();
    const client = axios.create({
      baseURL: "https://api.mercadolibre.com",
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    });
    const budget = createSyncBudget();
    const mlGet = <T = unknown>(url: string) =>
      withMlRetry(() => client.get<T>(url, { headers: { "Api-Version": "1", "Content-Type": "application/json" } }), { budget });

    const progresoTandas: ProgresoTanda[] = [];
    let billingSinCostsAcumulado = 0;
    let recalculadasAcumulado = 0;
    let numeroTanda = 0;
    let detenidoPor: string | null = null;
    let envioCeroEncontrado: { ordenId: string; fila: number } | null = null;

    while (Date.now() - inicioInvocacion < TIEMPO_MAXIMO_INVOCACION_MS) {
      numeroTanda++;
      let resultado;
      try {
        resultado = await procesarTanda({
          mlGet, readSheet, appendSheet, batchWriteSheet, calcularMargen,
          forzarReintentos: false,
          dryRun: !confirmar,
          // En simulación (confirmar:false), dryRunLimite reemplaza a
          // limite como tope de filas de la tanda — mismo volumen que
          // escribiría el modo real, para que el progreso simulado sea
          // representativo del real.
          dryRunLimite: FILAS_POR_TANDA,
          omitirMarca: true, // las marcas se asignan al final, ver rentabilidad/marcar-mixto
          limite: FILAS_POR_TANDA,
          tiempoMaximoMs: TIEMPO_MAXIMO_POR_TANDA_MS,
        });
      } catch (err) {
        if (err instanceof SyncRetryBudgetExceededError) {
          // 429 ya agotó los reintentos permitidos del budget — se trata
          // como parada (no es un error "distinto de 429" en sí, pero
          // llegar acá significa que el 429 persistió más de lo normal).
          detenidoPor = `Budget de reintentos agotado (posible 429 persistente) en la tanda ${numeroTanda}`;
          break;
        }
        // Cualquier otro error de API (status != 429) — se detiene, no se
        // reintenta en bucle.
        detenidoPor = `Error de API en la tanda ${numeroTanda}: ${String(err)}`;
        break;
      }

      billingSinCostsAcumulado += resultado.billingSinCosts;
      recalculadasAcumulado += resultado.recalculadas;
      // Total real de filas pendientes en TODA Rentabilidad (no solo esta
      // tanda de FILAS_POR_TANDA) — una lectura liviana de la columna P
      // sola, no de la hoja completa.
      const pendientesTotalRestantes = await contarPendientes(readSheet);
      progresoTandas.push({
        tanda: numeroTanda,
        hechas: resultado.recalculadas + resultado.billingSinCosts,
        pendientesTotalRestantes,
        billingSinCosts: resultado.billingSinCosts,
        billingSinCostsAcumulado,
        envioSubio: resultado.envioSubio,
      });

      // Salvaguarda: ninguna fila debería quedar con envío $0 (procesarTanda
      // ya descarta $0 de /costs como billing_sin_costs) — se re-verifica
      // explícito sobre lo recién escrito antes de seguir.
      const filaConCero = resultado.antesDespues.find(({ despues }) => despues.fuente === "costs" && Number(despues.envio) === 0);
      if (filaConCero) {
        envioCeroEncontrado = { ordenId: filaConCero.ordenId, fila: filaConCero.despues.fila };
        detenidoPor = `Fila con envío $0 encontrada (orden ${filaConCero.ordenId}, fila ${filaConCero.despues.fila})`;
        break;
      }

      // Parada por umbral de billing_sin_costs ACUMULADO de la corrida
      // (no de esta tanda de 30) — solo se evalúa con MINIMO_FILAS_PARA_
      // UMBRAL (60) o más filas procesadas en total, para no disparar el
      // umbral por ruido de una muestra chica (ej. 2 de 5 en la primera
      // tanda ya sería 40%, sin significar nada todavía).
      const totalAcumulado = recalculadasAcumulado + billingSinCostsAcumulado;
      if (totalAcumulado >= MINIMO_FILAS_PARA_UMBRAL && billingSinCostsAcumulado / totalAcumulado > UMBRAL_BILLING_SIN_COSTS) {
        detenidoPor = `Acumulado: billing_sin_costs ${billingSinCostsAcumulado}/${totalAcumulado} supera el 10% (umbral evaluado desde ${MINIMO_FILAS_PARA_UMBRAL} filas)`;
        break;
      }

      // Nada más que procesar en esta tanda Y en el total — la corrida
      // completa terminó.
      if (resultado.recalculadas === 0 && resultado.billingSinCosts === 0) {
        detenidoPor = "Sin filas pendientes";
        break;
      }
      if (pendientesTotalRestantes === 0) {
        detenidoPor = "Completado — 0 filas pendientes";
        break;
      }

      // Sin confirmar: una sola tanda simulada por invocación — ver nota
      // de la limitación arriba (dryRun no avanza el checkpoint, repetir
      // tandas simuladas no aportaría información nueva).
      if (!confirmar) {
        detenidoPor = "Simulación (confirmar:false) — 1 tanda de muestra, nada escrito";
        break;
      }
    }

    const ultimaTanda = progresoTandas[progresoTandas.length - 1];
    return NextResponse.json({
      ok: true,
      detenidoPor: detenidoPor ?? "Tiempo de la invocación agotado — llamar de nuevo para continuar",
      envioCeroEncontrado,
      tandasEnEstaInvocacion: progresoTandas.length,
      pendientesRestantes: ultimaTanda ? ultimaTanda.pendientesTotalRestantes : null,
      billingSinCostsAcumulado,
      progresoTandas,
    });
  } catch (error) {
    console.error("[rentabilidad/completar]", error);
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}

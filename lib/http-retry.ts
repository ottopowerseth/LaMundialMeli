// Retry para llamadas HTTP a Mercado Libre: reintenta solo errores transitorios
// (429, 5xx, timeout/red) con backoff corto. No reintenta 4xx de negocio
// (401/403/404) porque un segundo intento no los soluciona.
//
// maxAttempts es por request individual. syncBudget (opcional) es un contador
// compartido entre todas las llamadas de un mismo sync: si se acumulan
// demasiadas requests que agotaron sus reintentos, se corta el sync entero
// en vez de seguir gastando tiempo hasta el límite de duración de la función.

export class SyncRetryBudgetExceededError extends Error {
  constructor(reason: "failed_requests" | "elapsed_time") {
    super(
      reason === "elapsed_time"
        ? "Se superó el tiempo máximo disponible para reintentos en este sync"
        : "Se superó el límite de reintentos fallidos para este sync"
    );
    this.name = "SyncRetryBudgetExceededError";
  }
}

// maxFailedRequests: piso de seguridad por cantidad de requests agotadas.
// maxElapsedMs: corte por tiempo real transcurrido, calibrado contra
// maxDuration=60 en route.ts — deja margen para el trabajo que falta
// (escribir en Sheets, etc.) aunque los fallos individuales hayan sido pocos.
export function createSyncBudget(maxFailedRequests = 2, maxElapsedMs = 45000) {
  let failedRequests = 0;
  const inicioSync = Date.now();
  return {
    recordExhausted() {
      failedRequests++;
      if (Date.now() - inicioSync > maxElapsedMs) {
        throw new SyncRetryBudgetExceededError("elapsed_time");
      }
      if (failedRequests > maxFailedRequests) {
        throw new SyncRetryBudgetExceededError("failed_requests");
      }
    },
  };
}

type SyncBudget = ReturnType<typeof createSyncBudget>;

function isRetryable(err: unknown): boolean {
  const e = err as { response?: { status?: number }; code?: string };
  if (!e.response) return true; // error de red/timeout, sin respuesta HTTP
  const status = e.response.status;
  return status === 429 || (status !== undefined && status >= 500);
}

export async function withMlRetry<T>(
  fn: () => Promise<T>,
  opts: { maxAttempts?: number; budget?: SyncBudget } = {}
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 2;
  const delaysMs = [1000, 2000];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLastAttempt = attempt === maxAttempts - 1;
      if (!isRetryable(err) || isLastAttempt) {
        opts.budget?.recordExhausted();
        throw err;
      }
      await new Promise((r) => setTimeout(r, delaysMs[attempt] ?? 2000));
    }
  }
  throw new Error("unreachable");
}

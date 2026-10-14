// Lock cooperativo "tipo ticket" sobre una pestaña de Sheets (S-08). Sin infraestructura nueva.
//
// Protocolo (probado el 2026-10-14 contra Sheets real, N=10 simultáneos, 6 corridas: siempre ganó exactamente uno):
//   1. el contendiente AGREGA su propia fila [clave, token, vence, liberado] con values.append;
//   2. RELEE la pestaña;
//   3. gana si su ticket es el PRIMERO (el más arriba) de su clave que no está liberado ni vencido. Quien pierde responde 409
//      de inmediato (no espera ni sondea) y libera su propio ticket al instante, para no bloquear al siguiente.
//   4. quien gana ejecuta su tarea y SIEMPRE libera en un finally (marca "liberado" en su fila).
//
// Reglas de diseño:
//   - La posición de un ticket se busca SIEMPRE por su token en una lectura; nunca se usa el rango que devuelve el append (con
//     appends simultáneos esa respuesta repite filas y no es confiable). Antes de escribir en una fila (liberar, borrar) se vuelve
//     a leer su token y se compara (patrón de lib/guardas-filas.ts): si la hoja se corrió, no se escribe en la fila equivocada.
//   - Falla cerrado: si Sheets falla o no responde al adquirir, NO se ejecuta la tarea (503 con mensaje claro).
//   - Vencimiento: 90 s. maxDuration de las rutas es 60 s, así que el ticket de una función que Vercel mató a medias vence solo
//     antes de que pase mucho tiempo, y uno vivo nunca vence con la tarea en curso (mientras la tarea respete maxDuration).
//   - Limpieza en lote (best-effort): borra tickets cuyo vencimiento fue hace más de 10 minutos (liberados o caducados). Nunca
//     hace fallar la adquisición, y verifica el token de cada fila justo antes de borrarla.
//
// LÍMITES (no es exclusión mutua real):
//   - Es un lock cooperativo: solo protege entre quienes lo usan; no impide que otro proceso (o una edición manual) escriba.
//   - Depende de que la lectura posterior a un append vea el ticket (lo observado, no una garantía de Google). Si no lo ve,
//     falla cerrado; pero si viera tickets ajenos tarde, dos contendientes podrían ganar.
//   - Probado desde un solo proceso (10 clientes simultáneos) y con hojas en memoria; no entre instancias distintas de Vercel.
//   - El vencimiento se calcula con el reloj de cada instancia (un desfase de segundos importa poco con 90 s).
//   - Una tarea que supere los 90 s pierde la protección (ya no ocurre si respeta maxDuration = 60 s).
//   - Un ticket cuya liberación falla bloquea esa clave hasta que vence (máx. 90 s).
//   - Verificar-y-escribir (liberar o borrar) no es atómico: la ventana es de cientos de milisegundos.
import { ensureSheets, readSheet, writeSheet, appendSheet, borrarFilasHoja } from "@/lib/sheets";
import { discrepanciasDeProductos } from "@/lib/guardas-filas";
import { logError } from "@/lib/log";

export const HOJA_LOCKS = "Locks";
export const TTL_LOCK_S = 90; // maxDuration de las rutas es 60 s; el ticket vive más que la función a propósito.
export const EDAD_LIMPIEZA_S = 600; // solo se limpian tickets con vencimiento de hace más de ~10 minutos
const MAX_LIMPIEZA = 200;
const TIMEOUT_OPERACION_MS = 20000;
const ENCABEZADO = ["Clave", "Token", "Vence (epoch s)", "Liberado"];

export type DepsLock = {
  asegurarHoja: () => Promise<void>;
  agregar: (fila: unknown[]) => Promise<void>;
  leer: () => Promise<unknown[][]>; // Locks!A2:D (la posición 0 es la fila 2 de la hoja)
  leerTokens: (hastaFila: number) => Promise<unknown[][]>; // Locks!B2:B{hastaFila}
  marcarLiberado: (fila: number) => Promise<void>;
  borrarFilas: (filas: number[]) => Promise<void>;
  ahora: () => number; // ms
  nuevoToken: () => string;
  timeoutMs?: number;
  olvidarHoja?: () => void; // invalida el «la pestaña ya está lista» recordado (si alguien borró la pestaña o su encabezado, se rehace)
};

// filaProbable: dónde estaba el ticket en la lectura de la adquisición. Es solo una PISTA para ahorrar una lectura al liberar (la cuota
// de Sheets son 60 lecturas/min): antes de escribir se verifica el token en esa fila y, si no coincide, se busca de nuevo por token.
export type Ticket = { clave: string; token: string; filaProbable?: number };
export type FalloLock = { ok: false; status: 409 | 503; mensaje: string };

// Crea la pestaña si falta. Si dos contendientes la crean a la vez, el segundo addSheet falla con "ya existe": se reintenta una
// vez (ensureSheets vuelve a mirar y ya la encuentra). Y escribe el encabezado si A1 está vacía (idempotente si lo hacen dos).
export async function asegurarHojaLocks(
  ensure: () => Promise<void>,
  leerA1: () => Promise<unknown[][]>,
  escribirEncabezado: () => Promise<void>
): Promise<void> {
  try { await ensure(); } catch { await ensure(); }
  const a1 = await leerA1();
  if (!a1.length || !a1[0]?.length) await escribirEncabezado();
}

const hojasListas = new Set<string>(); // por instancia: evita repetir la verificación de la pestaña en cada adquisición
// `hoja` solo se cambia en las pruebas contra una pestaña desechable; las rutas usan siempre «Locks».
export function depsPorDefecto(hoja: string = HOJA_LOCKS): DepsLock {
  return {
    asegurarHoja: async () => {
      if (hojasListas.has(hoja)) return;
      await asegurarHojaLocks(
        () => ensureSheets([hoja]),
        () => readSheet(`${hoja}!A1:A1`),
        () => writeSheet(`${hoja}!A1:D1`, [ENCABEZADO])
      );
      hojasListas.add(hoja);
    },
    agregar: (fila) => appendSheet(`${hoja}!A:D`, [fila]), // INSERT_ROWS (valor por defecto de appendSheet): con OVERWRITE los tickets simultáneos se pisaban
    leer: () => readSheet(`${hoja}!A2:D`),
    leerTokens: (hasta) => readSheet(`${hoja}!B2:B${hasta}`),
    marcarLiberado: (fila) => writeSheet(`${hoja}!D${fila}`, [["x"]]),
    borrarFilas: (filas) => borrarFilasHoja(hoja, filas),
    ahora: () => Date.now(),
    nuevoToken: () => globalThis.crypto.randomUUID(),
    olvidarHoja: () => { hojasListas.delete(hoja); },
  };
}

// Lee el vencimiento (epoch en segundos) tal como lo devuelve Sheets. La planilla es es_ES: un entero puede venir como «1760443200»,
// «1.760.443.200» (separador de miles) o con espacios (normales, nbsp \u00a0 o de ancho fijo \u202f). Lo ilegible da NaN y el ticket
// se trata como vencido.
export function parsearVence(v: unknown): number {
  if (typeof v === "number") return v;
  let t = String(v ?? "").replace(/[\s\u00a0\u202f]/g, "");
  if (t === "") return NaN;
  if (t.includes(",")) t = t.replace(/\./g, "").replace(",", "."); // 1.760.443.200,5 → 1760443200.5
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, ""); // 1.760.443.200 → 1760443200
  return Number(t);
}

type FilaTicket = { fila: number; clave: string; token: string; venceS: number; liberado: boolean };
const texto = (v: unknown) => String(v ?? "").trim();
const parsear = (f: unknown[] | undefined, idx: number): FilaTicket => ({
  fila: idx + 2, clave: texto(f?.[0]), token: texto(f?.[1]), venceS: parsearVence(f?.[2]), liberado: texto(f?.[3]) !== "",
});
const vigente = (t: FilaTicket, clave: string, ahoraS: number) => t.clave === clave && t.token !== "" && !t.liberado && Number.isFinite(t.venceS) && t.venceS > ahoraS;

async function conTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`Sheets no respondió en ${ms / 1000} s`)), ms); })]);
  } finally { if (timer) clearTimeout(timer); }
}

// Marca "liberado" el ticket con ese token. Busca su fila POR TOKEN y vuelve a verificar la celda justo antes de escribir; si la
// hoja se corrió entre las dos lecturas, reintenta una vez. Devuelve false si no pudo (el ticket vence solo a los 90 s).
export async function liberarTicket(ticket: Ticket, deps: DepsLock = depsPorDefecto()): Promise<boolean> {
  const ms = deps.timeoutMs ?? TIMEOUT_OPERACION_MS;
  if (ticket.filaProbable && ticket.filaProbable >= 2) {
    const f = ticket.filaProbable;
    const actuales = await conTimeout(deps.leerTokens(f), ms);
    if (discrepanciasDeProductos(actuales, [{ fila: f, id: ticket.token }]).length === 0) {
      await conTimeout(deps.marcarLiberado(f), ms);
      return true;
    }
  }
  for (let intento = 0; intento < 2; intento++) {
    const filas = await conTimeout(deps.leer(), ms);
    const idx = filas.findIndex((f) => texto(f?.[1]) === ticket.token);
    if (idx < 0) return false;
    const fila = idx + 2;
    const actuales = await conTimeout(deps.leerTokens(fila), ms);
    if (discrepanciasDeProductos(actuales, [{ fila, id: ticket.token }]).length > 0) continue;
    await conTimeout(deps.marcarLiberado(fila), ms);
    return true;
  }
  return false;
}

async function liberarSinFallar(ticket: Ticket, deps: DepsLock): Promise<void> {
  try {
    if (!(await liberarTicket(ticket, deps))) logError("lock liberar", new Error(`no se pudo liberar el ticket de ${ticket.clave}; vencerá solo`));
  } catch (err) { logError("lock liberar", err); }
}

// Borra tickets con vencimiento de hace más de EDAD_LIMPIEZA_S. Verifica el token de cada fila antes de borrar; si alguna ya no
// coincide (la hoja se corrió), no borra nada. Best-effort: quien llama ignora cualquier error.
export async function limpiarTickets(filas: unknown[][], deps: DepsLock): Promise<number> {
  const ahoraS = Math.floor(deps.ahora() / 1000);
  const candidatos = filas.map(parsear).filter((t) => t.token !== "" && Number.isFinite(t.venceS) && t.venceS < ahoraS - EDAD_LIMPIEZA_S).slice(0, MAX_LIMPIEZA);
  if (candidatos.length === 0) return 0;
  const ms = deps.timeoutMs ?? TIMEOUT_OPERACION_MS;
  const actuales = await conTimeout(deps.leerTokens(Math.max(...candidatos.map((c) => c.fila))), ms);
  if (discrepanciasDeProductos(actuales, candidatos.map((c) => ({ fila: c.fila, id: c.token }))).length > 0) return 0;
  await conTimeout(deps.borrarFilas(candidatos.map((c) => c.fila)), ms);
  return candidatos.length;
}

const falloCerrado = (clave: string, err: unknown): FalloLock => {
  logError("lock adquirir", err);
  return { ok: false, status: 503, mensaje: `No se pudo verificar el bloqueo de «${clave}» en la hoja Locks, así que no se ejecutó nada para no arriesgar escrituras simultáneas. Reintenta en un momento.` };
};

export async function adquirirLock(clave: string, deps: DepsLock = depsPorDefecto()): Promise<{ ok: true; ticket: Ticket } | FalloLock> {
  const ms = deps.timeoutMs ?? TIMEOUT_OPERACION_MS;
  const ticket: Ticket = { clave, token: `tk-${deps.nuevoToken()}` };
  let filas: unknown[][];
  try {
    await conTimeout(deps.asegurarHoja(), ms);
    await conTimeout(deps.agregar([clave, ticket.token, Math.floor(deps.ahora() / 1000) + TTL_LOCK_S, ""]), ms);
    filas = await conTimeout(deps.leer(), ms);
  } catch (err) {
    deps.olvidarHoja?.();
    await liberarSinFallar(ticket, deps); // el append pudo haber llegado aunque la respuesta falló: no dejar un ticket fantasma
    return falloCerrado(clave, err);
  }

  const ahoraS = Math.floor(deps.ahora() / 1000);
  const propiaVisible = filas.some((f) => texto(f?.[1]) === ticket.token);
  if (!propiaVisible) {
    deps.olvidarHoja?.();
    await liberarSinFallar(ticket, deps);
    return falloCerrado(clave, new Error("el ticket propio no apareció al releer la hoja Locks"));
  }
  ticket.filaProbable = filas.findIndex((f) => texto(f?.[1]) === ticket.token) + 2;
  const primero = filas.map(parsear).find((t) => vigente(t, clave, ahoraS));
  const gana = primero?.token === ticket.token;

  // Limpieza en lote: best-effort, con los datos ya leídos; nunca afecta el resultado de la adquisición.
  try { await limpiarTickets(filas, deps); } catch (err) { logError("lock limpieza", err); }

  if (gana) return { ok: true, ticket };
  await liberarSinFallar(ticket, deps); // el perdedor libera su propio ticket YA: si no, bloquearía al siguiente hasta vencer
  const faltan = primero ? Math.max(1, primero.venceS - ahoraS) : TTL_LOCK_S;
  return { ok: false, status: 409, mensaje: `Ya hay otro proceso ejecutando «${clave}». No se ejecutó nada; espera a que termine (o a que venza el bloqueo, en un máximo de ${faltan} s) e inténtalo de nuevo.` };
}

export type ResultadoConLock<T> = { ok: true; valor: T } | FalloLock;

// Adquiere el lock de `clave`, corre `tarea` y SIEMPRE libera en un finally. Si pierde responde 409 sin esperar; si Sheets falla
// al adquirir, falla cerrado (503) y la tarea no se ejecuta. Si la tarea lanza, se libera y el error se propaga.
export async function conLock<T>(clave: string, tarea: () => Promise<T>, deps: DepsLock = depsPorDefecto()): Promise<ResultadoConLock<T>> {
  const adq = await adquirirLock(clave, deps);
  if (!adq.ok) return adq;
  try {
    return { ok: true, valor: await tarea() };
  } finally {
    await liberarSinFallar(adq.ticket, deps);
  }
}

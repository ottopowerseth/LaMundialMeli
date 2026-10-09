// Backfill de ShippingCache (logistic_type real por orden). La lógica vive acá,
// con dependencias inyectadas, para poder probarla en seco sin tocar la hoja.
//
// Recorre las órdenes en ventanas de UN día UTC (order.date_created.from/to),
// de la más reciente a la más vieja, así que no depende del tope de offset de
// /orders/search (una ventana de un día queda muy por debajo de 10.000).
// Excluye las canceladas; incluye pagadas y reembolsadas. Las escrituras se
// agrupan (~100 filas por append) y, antes de cada una, se relee la columna A
// para no generar duplicados nuevos. Idempotente: ShippingCache es el cursor
// real; `cursorHastaMs` solo evita volver a listar los días ya resueltos.

export type GetFn = <T = unknown>(url: string) => Promise<{ data: T }>;

export type DepsBackfill = {
  get: GetFn; // GET crudo a ML, sin reintentos (los reintentos y el conteo de errores se hacen acá)
  userId: string | number;
  leerHoja: (rango: string) => Promise<unknown[][]>;
  agregarFilas: (filas: string[][]) => Promise<void>;
  ahora?: () => number;
};

export type OpcionesBackfill = {
  dias?: number;
  seco?: boolean;
  cursorHastaMs?: number | null;
  tiempoMaxMs?: number;
};

export const DIAS_DEFAULT = 120;
export const DIAS_MAX = 180;
const DIA_MS = 86400000;
const TIEMPO_MAXIMO_MS = 40000; // corte proactivo; maxDuration del endpoint es 60 s (margen para la escritura final y reintentos lentos de ML)
const FILAS_POR_ESCRITURA = 100;
const SHIPMENT_BATCH_SIZE = 8;
const REINTENTOS = 3;

export function normalizarDias(valor: unknown): number {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 1) return DIAS_DEFAULT;
  return Math.min(n, DIAS_MAX);
}

const idPlano = (v: unknown) => String(v ?? "").replace(/^'/, "").trim();

type OrdenApi = { id: number | string; status?: string; shipping?: { id?: number | string | null } | null };

export type ResultadoBackfill = {
  completo: boolean;
  cursorHastaMs: number | null; // null = terminó; si no, día (fin exclusivo) por el que seguir
  dias: number;
  seco: boolean;
  ventanasRecorridas: number;
  ordenesVistas: number; // únicas en toda la corrida
  repetidasEntreVentanas: number; // ML devuelve algunas órdenes en dos días contiguos
  excluidasCanceladas: number;
  yaEnCache: number;
  procesadas: number; // órdenes cuyo /shipments se consultó
  nuevasEnCache: number;
  descartadasPorDuplicado: number;
  sinEnvio: number; // órdenes sin shipping.id (no se pueden clasificar)
  escrituras: number; // appends a ShippingCache
  lecturasHoja: number;
  llamadasMl: number;
  errores: { http429: number; http404: number; otros: number };
  erroresValidacion: string[];
  duracionMs: number;
  faltantes: number; // órdenes sin tipo (en seco: las que se resolverían)
  faltantesPorEstado: Record<string, number>;
  faltantesPorDia: { dia: string; ordenes: number; faltantes: number }[];
  faltantesIds?: string[]; // solo en seco
};

export async function ejecutarBackfill(deps: DepsBackfill, opts: OpcionesBackfill = {}): Promise<ResultadoBackfill> {
  const ahora = deps.ahora ?? Date.now;
  const t0 = ahora();
  const dias = normalizarDias(opts.dias);
  const seco = !!opts.seco;
  const tiempoMax = opts.tiempoMaxMs ?? TIEMPO_MAXIMO_MS;
  const agotado = () => ahora() - t0 > tiempoMax;

  const r: ResultadoBackfill = {
    completo: false, cursorHastaMs: null, dias, seco, ventanasRecorridas: 0, ordenesVistas: 0, repetidasEntreVentanas: 0, excluidasCanceladas: 0,
    yaEnCache: 0, procesadas: 0, nuevasEnCache: 0, descartadasPorDuplicado: 0, sinEnvio: 0, escrituras: 0, lecturasHoja: 0,
    llamadasMl: 0, errores: { http429: 0, http404: 0, otros: 0 }, erroresValidacion: [], duracionMs: 0,
    faltantes: 0, faltantesPorEstado: {}, faltantesPorDia: [],
    ...(seco ? { faltantesIds: [] as string[] } : {}),
  };

  // GET con reintento solo para 429/5xx/red, contando cada intento fallido.
  async function mlGet<T>(url: string): Promise<{ data: T }> {
    for (let intento = 1; ; intento++) {
      r.llamadasMl++;
      try {
        return await deps.get<T>(url);
      } catch (err) {
        const status = (err as { response?: { status?: number } }).response?.status;
        if (status === 429) r.errores.http429++;
        else if (status === 404) r.errores.http404++;
        else r.errores.otros++;
        const reintentable = status === undefined || status === 429 || status >= 500;
        if (!reintentable || intento >= REINTENTOS) throw err;
        await new Promise((res) => setTimeout(res, intento * 1000));
      }
    }
  }

  // Órdenes que ya tienen tipo: no se vuelven a consultar.
  const conTipo = new Set<string>();
  const filasCache = await deps.leerHoja("ShippingCache!A2:C100000");
  r.lecturasHoja++;
  for (const f of filasCache) if (f[0] && f[2]) conTipo.add(idPlano(f[0]));

  const vistas = new Set<string>(); // órdenes ya listadas en esta corrida (entre ventanas)
  let buffer: string[][] = [];
  async function vaciar() {
    if (buffer.length === 0) return;
    // Releer la columna A: otra corrida (ml-sync, otra pestaña) pudo agregar estas órdenes.
    const enHoja = new Set((await deps.leerHoja("ShippingCache!A2:A100000")).map((f) => idPlano(f[0])));
    r.lecturasHoja++;
    const nuevas = buffer.filter((f) => !enHoja.has(idPlano(f[0])));
    r.descartadasPorDuplicado += buffer.length - nuevas.length;
    if (nuevas.length > 0) {
      await deps.agregarFilas(nuevas);
      r.escrituras++;
      r.nuevasEnCache += nuevas.length;
    }
    for (const f of buffer) conTipo.add(idPlano(f[0]));
    buffer = [];
  }

  async function listarDia(desdeMs: number, hastaMs: number): Promise<OrdenApi[]> {
    const base =
      `/orders/search?seller=${deps.userId}&order.date_created.from=${new Date(desdeMs).toISOString()}` +
      `&order.date_created.to=${new Date(hastaMs - 1).toISOString()}&sort=date_desc&limit=50`;
    const porId = new Map<string, OrdenApi>(); // deduplica: ML a veces repite una orden en el borde de página
    for (let offset = 0; offset < 9950; offset += 50) {
      const { data } = await mlGet<{ results: OrdenApi[]; paging: { total: number } }>(`${base}&offset=${offset}`);
      for (const o of data.results) porId.set(String(o.id), o);
      if (data.results.length < 50 || offset + 50 >= data.paging.total) break;
    }
    return [...porId.values()];
  }

  const finDeHoy = (() => { const d = new Date(ahora()); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); })();
  const limite = finDeHoy - dias * DIA_MS;
  let hasta = opts.cursorHastaMs && opts.cursorHastaMs > limite && opts.cursorHastaMs <= finDeHoy ? opts.cursorHastaMs : finDeHoy;

  try {
    let diaIncompleto = false;
    while (hasta > limite) {
      if (agotado()) { diaIncompleto = true; break; }
      const desde = hasta - DIA_MS;
      // ML a veces devuelve la misma orden en dos días contiguos (medido
      // 2026-10-09: 36 de 510 con dias=35): se cuenta y se procesa una sola vez.
      const delDia = await listarDia(desde, hasta);
      const ordenes = delDia.filter((o) => !vistas.has(String(o.id)));
      for (const o of ordenes) vistas.add(String(o.id));
      r.repetidasEntreVentanas += delDia.length - ordenes.length;
      r.ventanasRecorridas++;
      r.ordenesVistas += ordenes.length;

      const candidatas = ordenes.filter((o) => o.status !== "cancelled");
      r.excluidasCanceladas += ordenes.length - candidatas.length;
      const faltan = candidatas.filter((o) => !conTipo.has(String(o.id)));
      r.yaEnCache += candidatas.length - faltan.length;
      r.faltantes += faltan.length;
      for (const o of faltan) {
        const est = o.status ?? "sin_estado";
        r.faltantesPorEstado[est] = (r.faltantesPorEstado[est] ?? 0) + 1;
        if (seco) r.faltantesIds!.push(String(o.id));
      }
      r.faltantesPorDia.push({ dia: new Date(desde).toISOString().slice(0, 10), ordenes: ordenes.length, faltantes: faltan.length });

      if (!seco) {
        for (let i = 0; i < faltan.length; i += SHIPMENT_BATCH_SIZE) {
          if (agotado()) { diaIncompleto = true; break; }
          const lote = faltan.slice(i, i + SHIPMENT_BATCH_SIZE);
          const resultados = await Promise.all(lote.map(async (o) => {
            const shippingId = o.shipping?.id;
            if (!shippingId) { r.sinEnvio++; return null; }
            try {
              const { data } = await mlGet<{ logistic_type?: string }>(`/shipments/${shippingId}`);
              r.procesadas++;
              return [`'${o.id}`, `'${shippingId}`, data.logistic_type ?? "", new Date(ahora()).toISOString()];
            } catch (err) {
              r.procesadas++;
              const status = (err as { response?: { status?: number } }).response?.status;
              if (r.erroresValidacion.length < 20) r.erroresValidacion.push(`Orden ${o.id}: /shipments/${shippingId} falló (${status ?? "red"})`);
              return null; // sin entrada: se reintenta en la próxima corrida
            }
          }));
          for (const f of resultados) if (f) buffer.push(f);
          if (buffer.length >= FILAS_POR_ESCRITURA) await vaciar();
        }
      }
      if (diaIncompleto) break; // el cursor sigue en este día
      hasta = desde;
    }
    r.completo = !diaIncompleto && hasta <= limite;
    r.cursorHastaMs = r.completo ? null : hasta;
  } finally {
    // Antes de salir (por tiempo o por error) se escribe lo acumulado.
    if (!seco) await vaciar();
    r.duracionMs = ahora() - t0;
  }
  return r;
}

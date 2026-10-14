// Forecast por modo logístico (Full / Normal) — lógica pura (sin llamadas); el endpoint lee las hojas y esto arma las filas y el resumen.
//
// Reglas (decididas con Otto, 2026-10-14):
//  - El MODO es de la PUBLICACIÓN, no de la orden: una publicación es Full o Normal a la vez y su stock corresponde a ese modo.
//    Full = shipping.logistic_type "fulfillment"; cualquier otro valor (xd_drop_off, cross_docking, self_service…) = Normal.
//  - Fuente del modo: columna T «Tipo logístico» de Publicaciones (ml-sync). Si T está vacía o la fila es corta (hoja escrita por un
//    sync anterior, de 19 columnas) → respaldo: tipo de la última venta clasificada (no cancelada) de la publicación en Ventas;
//    si no hay ninguna → «sin_clasificar».
//  - La DEMANDA es la total de la publicación (todas sus ventas de 30 días, de cualquier modo, sin canceladas): si migró de Normal a
//    Full, sus ventas Normales siguen siendo la demanda del producto. Se muestra el desglose por modo y la marca «migró» cuando
//    vendió en el modo contrario al actual.
//  - Stock: el de la hoja (available_quantity del ítem): en Full es el disponible en bodega de ML (sin lo no disponible); en Normal, el propio.
//  - Lead time y margen de seguridad por modo (por defecto 15 y 7); «sin_clasificar» usa los de Normal.
import { ESTADOS_EXCLUIDOS_DEMANDA, parseFechaCL } from "@/lib/forecast-demanda";

export type Modo = "full" | "normal" | "sin_clasificar";
export type FuenteModo = "publicacion" | "ultima_venta" | "ninguna";
export type Prioridad = "SIN_STOCK" | "URGENTE" | "PRONTO" | "OK" | "SIN_DATOS";
export type Plazos = { lead: number; safety: number };
export type ParametrosForecast = { full: Plazos; normal: Plazos };

export type ForecastRow = {
  id: string;
  titulo: string;
  stockActual: number;
  ventas30d: number;
  velocidadDiaria: number;
  diasRestantes: number | null;
  fechaQuiebre: string | null;
  cantidadSugerida: number;
  prioridad: Prioridad;
  estadoML: string;
  modo: Modo;
  fuenteModo: FuenteModo;
  tipoLogistico: string; // columna T tal cual ("" si no hay)
  leadTimeDays: number; // los de SU modo
  safetyDays: number;
  ventasFull30d: number;
  ventasNormal30d: number;
  ventasSinTipo30d: number; // ventas de 30 días cuya orden aún no tiene tipo
  migro: boolean; // vendió en el modo contrario al actual
};

export const esTipoFull = (t: string) => t.trim() === "fulfillment";

// Valores de logistic_type que ML usa de verdad para envíos normales. Cualquier otro valor distinto de fulfillment (ej. «not_specified», 3 publicaciones
// el 2026-10-14) también se trata como Normal, pero se destaca con una nota visible para que se note que ML no lo especifica.
export const TIPOS_NORMAL_CONOCIDOS = ["xd_drop_off", "cross_docking", "drop_off", "self_service"];
export const tipoNormalPocoClaro = (r: { modo: Modo; fuenteModo: FuenteModo; tipoLogistico: string }) =>
  r.modo === "normal" && r.fuenteModo === "publicacion" && !TIPOS_NORMAL_CONOCIDOS.includes(r.tipoLogistico.trim());
export const notaTipoPocoClaro = (tipo: string) => `ML informa el tipo logístico «${tipo.trim()}»: se trata como Normal`;
export const modoDeTipo = (t: string): "full" | "normal" | null => { const v = t.trim(); return v === "" ? null : esTipoFull(v) ? "full" : "normal"; };

const limpiaOrden = (s: unknown) => String(s ?? "").replace(/^'/, "").trim();

// Tipo de la orden: columna K de Ventas (la que escribió el sync) y, si está vacía, ShippingCache (el backfill escribe ahí sin tocar Ventas).
export function tipoDeOrden(ventaRow: unknown[], cache: Map<string, string>): string {
  return String(ventaRow[10] ?? "").trim() || cache.get(limpiaOrden(ventaRow[0])) || "";
}

export type Ventas30 = { total: number; full: number; normal: number; sinTipo: number };

// Unidades de 30 días por publicación, con desglose por modo de la orden. Mismo criterio que unidadesPorItem (sin canceladas).
export function demandaPorItem(ventaRows: unknown[][], desde: Date, cache: Map<string, string>): Map<string, Ventas30> {
  const out = new Map<string, Ventas30>();
  for (const r of ventaRows) {
    const fecha = parseFechaCL(String(r[1] ?? ""));
    if (!fecha || fecha < desde) continue;
    if (ESTADOS_EXCLUIDOS_DEMANDA.includes(String(r[8] ?? "").trim())) continue;
    const idItem = String(r[9] ?? "");
    const cantidad = Number(r[4]) || 0;
    if (!idItem || cantidad <= 0) continue;
    const x = out.get(idItem) ?? { total: 0, full: 0, normal: 0, sinTipo: 0 };
    x.total += cantidad;
    const m = modoDeTipo(tipoDeOrden(r, cache));
    if (m === "full") x.full += cantidad; else if (m === "normal") x.normal += cantidad; else x.sinTipo += cantidad;
    out.set(idItem, x);
  }
  return out;
}

// Tipo de la última venta clasificada (no cancelada) de cada publicación, en TODO el historial de Ventas (35 días). Empate de fecha: el
// modo con más unidades ese día; si siguen empatados, Full.
export function ultimaVentaClasificada(ventaRows: unknown[][], cache: Map<string, string>): Map<string, "full" | "normal"> {
  const porItem = new Map<string, { ms: number; full: number; normal: number }>();
  for (const r of ventaRows) {
    const fecha = parseFechaCL(String(r[1] ?? ""));
    if (!fecha) continue;
    if (ESTADOS_EXCLUIDOS_DEMANDA.includes(String(r[8] ?? "").trim())) continue;
    const idItem = String(r[9] ?? "");
    if (!idItem) continue;
    const m = modoDeTipo(tipoDeOrden(r, cache));
    if (!m) continue;
    const cant = Math.max(1, Number(r[4]) || 1);
    const ms = fecha.getTime();
    const x = porItem.get(idItem);
    if (!x || ms > x.ms) porItem.set(idItem, { ms, full: m === "full" ? cant : 0, normal: m === "normal" ? cant : 0 });
    else if (ms === x.ms) { if (m === "full") x.full += cant; else x.normal += cant; }
  }
  return new Map([...porItem].map(([id, x]) => [id, x.full >= x.normal ? "full" : "normal"] as const));
}

export function clasificarPublicacion(tipoT: string, ultimaVenta: "full" | "normal" | undefined): { modo: Modo; fuente: FuenteModo } {
  const m = modoDeTipo(tipoT);
  if (m) return { modo: m, fuente: "publicacion" };
  if (ultimaVenta) return { modo: ultimaVenta, fuente: "ultima_venta" };
  return { modo: "sin_clasificar", fuente: "ninguna" };
}

const ordenPrioridad: Record<Prioridad, number> = { SIN_STOCK: 0, URGENTE: 1, PRONTO: 2, SIN_DATOS: 3, OK: 4 };

// Cálculo de cobertura y sugerido (el mismo del Forecast original).
export function calcularCobertura(stock: number, ventas30d: number, lead: number, safety: number, hoy: Date) {
  const velocidadDiaria = ventas30d / 30;
  let diasRestantes: number | null = null;
  let fechaQuiebre: string | null = null;
  let cantidadSugerida = 0;
  let prioridad: Prioridad;
  if (stock === 0) {
    prioridad = "SIN_STOCK";
    cantidadSugerida = Math.ceil(velocidadDiaria * (lead + safety));
  } else if (velocidadDiaria === 0) {
    prioridad = "SIN_DATOS";
  } else {
    diasRestantes = Math.round(stock / velocidadDiaria);
    fechaQuiebre = new Date(hoy.getTime() + diasRestantes * 86400000).toLocaleDateString("es-CL");
    cantidadSugerida = Math.max(0, Math.ceil(velocidadDiaria * (lead + safety) - stock));
    if (diasRestantes <= lead) prioridad = "URGENTE";
    else if (diasRestantes <= lead + safety) prioridad = "PRONTO";
    else prioridad = "OK";
  }
  return { velocidadDiaria: Math.round(velocidadDiaria * 100) / 100, diasRestantes, fechaQuiebre, cantidadSugerida, prioridad };
}

export type PublicacionForecast = { id: string; titulo: string; stock: number; estadoML: string; tipoT: string };

export function armarFilasForecast(e: {
  publicaciones: PublicacionForecast[];
  demanda: Map<string, Ventas30>;
  ultimaVenta: Map<string, "full" | "normal">;
  parametros: ParametrosForecast;
  hoy: Date;
}): ForecastRow[] {
  const rows = e.publicaciones.map((p): ForecastRow => {
    const { modo, fuente } = clasificarPublicacion(p.tipoT, e.ultimaVenta.get(p.id));
    const plazos = modo === "full" ? e.parametros.full : e.parametros.normal; // sin clasificar usa los de Normal
    const d = e.demanda.get(p.id) ?? { total: 0, full: 0, normal: 0, sinTipo: 0 };
    const c = calcularCobertura(p.stock, d.total, plazos.lead, plazos.safety, e.hoy);
    return {
      id: p.id, titulo: p.titulo, stockActual: p.stock, ventas30d: d.total, ...c, estadoML: p.estadoML,
      modo, fuenteModo: fuente, tipoLogistico: p.tipoT.trim(), leadTimeDays: plazos.lead, safetyDays: plazos.safety,
      ventasFull30d: d.full, ventasNormal30d: d.normal, ventasSinTipo30d: d.sinTipo,
      migro: (modo === "full" && d.normal > 0) || (modo === "normal" && d.full > 0),
    };
  });
  rows.sort((a, b) => ordenPrioridad[a.prioridad] - ordenPrioridad[b.prioridad] || (a.diasRestantes ?? Infinity) - (b.diasRestantes ?? Infinity));
  return rows;
}

export type ResumenModo = { publicaciones: number; stockUnidades: number; ventas30d: number; sugeridoTotal: number; porPrioridad: Record<Prioridad, number> };
export type ResumenForecast = {
  porModo: Record<Modo, ResumenModo>;
  sinClasificar: number;
  porFuente: Record<FuenteModo, number>; // cuántas publicaciones se clasificaron por T, por la última venta o por nada
  skusEnAmbosModos: { sku: string; full: string[]; normal: string[] }[];
  migraron: { id: string; titulo: string; modo: Modo; full: number; normal: number; sinTipo: number }[];
  tipoPocoClaro: { id: string; titulo: string; tipo: string }[]; // Normal por un logistic_type que no es de los habituales (ej. not_specified)
};

const vacioPrioridades = (): Record<Prioridad, number> => ({ SIN_STOCK: 0, URGENTE: 0, PRONTO: 0, OK: 0, SIN_DATOS: 0 });

export function armarResumen(rows: ForecastRow[], skuPorItem: Map<string, string>): ResumenForecast {
  const porModo = Object.fromEntries((["full", "normal", "sin_clasificar"] as Modo[]).map((m) => [m, { publicaciones: 0, stockUnidades: 0, ventas30d: 0, sugeridoTotal: 0, porPrioridad: vacioPrioridades() }])) as Record<Modo, ResumenModo>;
  const porFuente: Record<FuenteModo, number> = { publicacion: 0, ultima_venta: 0, ninguna: 0 };
  for (const r of rows) {
    const x = porModo[r.modo];
    x.publicaciones++; x.stockUnidades += r.stockActual; x.ventas30d += r.ventas30d; x.sugeridoTotal += r.cantidadSugerida; x.porPrioridad[r.prioridad]++;
    porFuente[r.fuenteModo]++;
  }
  const porSku = new Map<string, { full: string[]; normal: string[] }>();
  for (const r of rows) {
    const sku = skuPorItem.get(r.id);
    if (!sku || r.modo === "sin_clasificar") continue;
    const x = porSku.get(sku) ?? { full: [], normal: [] };
    x[r.modo].push(r.id);
    porSku.set(sku, x);
  }
  const skusEnAmbosModos = [...porSku].filter(([, x]) => x.full.length > 0 && x.normal.length > 0).map(([sku, x]) => ({ sku, ...x })).sort((a, b) => a.sku.localeCompare(b.sku));
  const migraron = rows.filter((r) => r.migro).map((r) => ({ id: r.id, titulo: r.titulo, modo: r.modo, full: r.ventasFull30d, normal: r.ventasNormal30d, sinTipo: r.ventasSinTipo30d }))
    .sort((a, b) => b.full + b.normal - (a.full + a.normal));
  const tipoPocoClaro = rows.filter(tipoNormalPocoClaro).map((r) => ({ id: r.id, titulo: r.titulo, tipo: r.tipoLogistico }));
  return { porModo, sinClasificar: porModo.sin_clasificar.publicaciones, porFuente, skusEnAmbosModos, migraron, tipoPocoClaro };
}

// Diferencias con el panel «Reposición Full» del Tablero (para el Resumen y la pestaña Full).
export const NOTAS_DIFERENCIA_TABLERO = [
  "Velocidad: el Forecast usa las unidades de 30 días ÷ 30 sin corregir por días sin stock; el Tablero la corrige (con visitas de ML en vivo) y por eso puede ser mayor.",
  "Cobertura objetivo: el Forecast usa tiempo de reposición + margen de seguridad (22 días por defecto); el Tablero usa 30 días.",
  "Ventas contadas: el Forecast cuenta las órdenes no canceladas (incluye parcialmente reembolsadas); el Tablero solo las pagadas.",
  "Margen: el Tablero marca «revisar» si el margen es ≤ 0 o falta el Costo; el Forecast no mira costos.",
  "Historial: el Forecast solo ve los últimos 35 días de la hoja Ventas; el Tablero usa 90 y 120 días para el piso de velocidad Full.",
];

// ---- Archivo de pedido (XLSX): una hoja por modo con lo que hay que pedir + una hoja «Resumen». Solo arma las filas; el navegador escribe el archivo. ----
export const ETIQUETA_MODO: Record<Modo, string> = { full: "Full", normal: "Normal", sin_clasificar: "Sin clasificar" };
export const PRIORIDADES_PEDIDO: Prioridad[] = ["SIN_STOCK", "URGENTE", "PRONTO"];
export const filasParaPedido = (rows: ForecastRow[], modo: Modo) => rows.filter((r) => r.modo === modo && PRIORIDADES_PEDIDO.includes(r.prioridad) && r.cantidadSugerida > 0);
export const desgloseVentas = (r: { ventasFull30d: number; ventasNormal30d: number; ventasSinTipo30d: number }) =>
  `Full ${r.ventasFull30d} · Normal ${r.ventasNormal30d}${r.ventasSinTipo30d > 0 ? ` · sin tipo ${r.ventasSinTipo30d}` : ""}`;

export function hojasPedido(e: { rows: ForecastRow[]; resumen: ResumenForecast; parametros: ParametrosForecast; notas: string[]; generado: string }): Record<string, (string | number)[][]> {
  const encabezados = ["PRODUCTO", "STOCK ACTUAL", "VENTAS 30 DÍAS", "VELOCIDAD DIARIA", "DÍAS RESTANTES", "FECHA ESTIMADA DE QUIEBRE", "CANTIDAD A PEDIR", "PRIORIDAD", "PLAZO (días)", "MIGRÓ (ventas 30 d por modo)", "NOTA"];
  const hojas: Record<string, (string | number)[][]> = {};
  for (const m of ["full", "normal", "sin_clasificar"] as Modo[]) {
    hojas[ETIQUETA_MODO[m]] = [encabezados, ...filasParaPedido(e.rows, m).map((r) => [
      r.titulo, r.stockActual, r.ventas30d, r.velocidadDiaria, r.diasRestantes ?? "", r.fechaQuiebre ?? "", r.cantidadSugerida, r.prioridad, r.leadTimeDays + r.safetyDays, r.migro ? desgloseVentas(r) : "", tipoNormalPocoClaro(r) ? notaTipoPocoClaro(r.tipoLogistico) : "",
    ])];
  }
  const { resumen: res, parametros: p } = e;
  const a: (string | number)[][] = [["RESUMEN DEL FORECAST", ""], ["Generado", e.generado], [""]];
  a.push(["Plazos (reposición + seguridad)", ""], ["Full", `${p.full.lead} + ${p.full.safety} = ${p.full.lead + p.full.safety} días (Tablero: 30)`], ["Normal / Sin clasificar", `${p.normal.lead} + ${p.normal.safety} = ${p.normal.lead + p.normal.safety} días`], [""]);
  a.push(["Por modo", "Publicaciones", "Stock (unid.)", "Ventas 30 d (unid.)", "Sugerido total (unid.)", "Sin stock", "Urgente", "Pronto"]);
  for (const m of ["full", "normal", "sin_clasificar"] as Modo[]) { const x = res.porModo[m]; a.push([ETIQUETA_MODO[m], x.publicaciones, x.stockUnidades, x.ventas30d, x.sugeridoTotal, x.porPrioridad.SIN_STOCK, x.porPrioridad.URGENTE, x.porPrioridad.PRONTO]); }
  a.push([""], ["Publicaciones Sin clasificar", res.sinClasificar], ["Clasificadas por columna T / última venta / ninguna", `${res.porFuente.publicacion} / ${res.porFuente.ultima_venta} / ${res.porFuente.ninguna}`], [""]);
  a.push(["SKU en Full y en Normal", "Publicaciones Full", "Publicaciones Normal"], ...(res.skusEnAmbosModos.length ? res.skusEnAmbosModos.map((x) => [x.sku, x.full.join(", "), x.normal.join(", ")]) : [["(ninguno)"]]));
  a.push([""], ["Publicaciones que migraron de modo", "Modo actual", "Ventas 30 d por modo"], ...(res.migraron.length ? res.migraron.map((x) => [`${x.titulo} (${x.id})`, ETIQUETA_MODO[x.modo], desgloseVentas({ ventasFull30d: x.full, ventasNormal30d: x.normal, ventasSinTipo30d: x.sinTipo })]) : [["(ninguna)"]]));
  a.push([""], ["Normal por un tipo logístico poco claro", "Tipo informado por ML"], ...(res.tipoPocoClaro.length ? res.tipoPocoClaro.map((x) => [`${x.titulo} (${x.id})`, x.tipo]) : [["(ninguna)"]]));
  a.push([""], ["Diferencias con el panel «Reposición Full» del Tablero", ""], ...e.notas.map((n) => [n]));
  hojas["Resumen"] = a;
  return hojas;
}

// Libro XLSX a partir de las hojas de hojasPedido (anchos de columna ajustados al contenido, con piso y techo). `XLSX` se pasa desde afuera
// (el componente usa el paquete «xlsx») para que esta librería siga sin dependencias; así el navegador y las pruebas arman el MISMO archivo.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function libroDesdeHojas(XLSX: any, hojas: Record<string, (string | number)[][]>) {
  const libro = XLSX.utils.book_new();
  for (const [nombre, aoa] of Object.entries(hojas)) {
    const hoja = XLSX.utils.aoa_to_sheet(aoa);
    hoja["!cols"] = (aoa[0] ?? []).map((h, c) => ({ wch: Math.min(45, Math.max(10, Math.max(String(h).length, ...aoa.map((f) => String(f[c] ?? "").length)) + 2)) }));
    XLSX.utils.book_append_sheet(libro, hoja, nombre);
  }
  return libro;
}

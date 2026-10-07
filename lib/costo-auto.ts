// Costo automático de Publicaciones (columna F) a partir de la Lista Defontana.
//
// Mismo cruce que el Comparador vs Mayor (lib/defontana.ts, una sola fuente de
// verdad): equivalencia manual si existe; si no, SELLER_SKU contra Cod y, como
// respaldo, GTIN contra Barras; siempre MAYOR × Unidades de la publicación.
// (Nota 2026-10-07: la variante del cero de los Aer de lib/defontana.ts no
// genera hoy "COS0022117" desde "COS022117"; esos packs se resuelven por la
// tabla de Equivalencias, que es lo que importa. Bug latente, no de este
// módulo.) El Mayor viene CON IVA (bruto),
// decisión de Otto 2026-09-30 — OJO: esa base está pendiente de contrastar
// contra facturas de compra (ver docs); este módulo no la cambia, solo
// escribe el Mayor tal cual en Costo, que es lo que el resto del sistema ya
// espera (ml-sync, calcularMargen).
//
// Reglas de escritura (decisión de Otto 2026-10-07):
//   - Solo completa celdas de Costo VACÍAS. Nunca pisa un valor existente.
//   - Solo escribe cálculos "limpios". Los sospechosos quedan en "revisar":
//     se listan con su costo propuesto, pero NO se escriben.
//   - El origen (auto / manual / revisar) vive en la hoja "CostoOrigen", no
//     en Publicaciones: ml-sync limpia y reescribe Publicaciones completa en
//     cada sync, así que una columna extra ahí se perdería (y los valores
//     "auto" pasarían a verse "manual").
//   - Simula por defecto; solo escribe con confirmar:true.
import { cruzarConDefontana, precioReferenciaEquivalencia } from "@/lib/defontana";
import type { FilaDefontana, FilaEquivalencia } from "@/lib/defontana";

export const HOJA_COSTO_ORIGEN = "CostoOrigen";
export const HEADERS_COSTO_ORIGEN = [
  "ID Item", "SKU", "Origen", "Costo", "Costo Calculado", "Fuente",
  "Cod Defontana", "Artículo Defontana", "Motivo Revisión", "Actualizado",
];

// Costo / precio de venta: la mediana real de la cuenta es 0,68 y el p5 es
// 0,46 (medido 2026-10-07). Bajo 0,45 casi siempre es un pack vendido como
// unidad (el artículo de Defontana es 1 unidad y la publicación vende varias)
// o un artículo equivocado; sobre 0,92 el margen sería ~0 o negativo y suele
// ser un Mayor que en realidad es precio público (caso "(WEB)", o packs cuyo
// "Mayor" es el precio de venta).
export const RATIO_COSTO_PRECIO_MUY_BAJO = 0.45;
export const RATIO_COSTO_PRECIO_MUY_ALTO = 0.92;

export type FuenteCosto = "equivalencia" | "sku" | "gtin";
export type Origen = "auto" | "manual" | "revisar";

export type PublicacionCosto = {
  id: string;
  titulo: string;
  sku: string | null;
  gtin: string | null;
  precio: number; // precio de venta vigente (bruto)
  estado: string;
  unidades: number; // columna S de Publicaciones (default 1)
  costoActual: string; // columna F tal cual (vacío = sin Costo)
  fila: number; // fila en la hoja (para escribir)
  ingreso30d: number;
};

export type CalculoCosto = { fuente: FuenteCosto | null; costo: number | null; codigo: string | null; articulo: string | null };

export type ResultadoCosto = {
  p: PublicacionCosto;
  calculo: CalculoCosto;
  origen: Origen | null; // null = sin Costo ni match (no se registra)
  motivos: string[];
  escribir: boolean;
};

// Cantidad que declara un texto ("x28", "pack 3", "3 unds", "2x1"); null si no declara.
// Los volúmenes (ML, GR, CC...) no cuentan como cantidad.
export function cantidadDeclarada(texto: string): number | null {
  const t = texto.toUpperCase().replace(/,/g, ".");
  const m =
    t.match(/(?:\bX\s?|\bPACK\s?(?:DE\s?|X\s?)?|\bPAQUETE\s?)(\d{1,3})\b(?!\s?(?:ML|GR?|G|CC|L|KG|CM|MM)\b)/) ||
    t.match(/\b(\d{1,3})\s?(?:UN|UND|UNDS|UNID|UNIDS|UNIDADES|UDS?|U)\b/) ||
    t.match(/\b(\d{1,2})\s?X\s?\d/);
  return m ? Number(m[1]) : null;
}

export function calcularCosto(
  p: Pick<PublicacionCosto, "id" | "sku" | "gtin" | "unidades">,
  porCod: Map<string, FilaDefontana>,
  porBarras: Map<string, FilaDefontana>,
  equivalencias: Map<string, FilaEquivalencia[]>
): CalculoCosto {
  const eq = equivalencias.get(p.id);
  if (eq && eq.length > 0) {
    const total = precioReferenciaEquivalencia(eq, porCod);
    if (total !== null) {
      const primero = porCod.get(eq[0].componenteCod.trim().toUpperCase());
      return {
        fuente: "equivalencia", costo: total, codigo: eq[0].componenteCod,
        articulo: eq.map((c) => `${c.cantidad}×${c.componenteCod}`).join(" + ") + (primero ? ` (${primero.articulo})` : ""),
      };
    }
  }
  const porSku = cruzarConDefontana(p.sku, null, porCod, porBarras);
  if (porSku) return { fuente: "sku", costo: porSku.mayor * p.unidades, codigo: porSku.cod, articulo: porSku.articulo };
  const porGtin = cruzarConDefontana(null, p.gtin, porCod, porBarras);
  if (porGtin) return { fuente: "gtin", costo: porGtin.mayor * p.unidades, codigo: porGtin.cod, articulo: porGtin.articulo };
  return { fuente: null, costo: null, codigo: null, articulo: null };
}

// Motivos por los que un costo calculado NO se escribe automáticamente.
export function motivosRevision(p: PublicacionCosto, c: CalculoCosto): string[] {
  if (c.costo === null || p.precio <= 0) return [];
  const motivos: string[] = [];
  const ratio = c.costo / p.precio;
  if (c.costo === p.precio) motivos.push("costo igual al precio");
  else if (ratio < RATIO_COSTO_PRECIO_MUY_BAJO) motivos.push(`costo/precio muy bajo (${ratio.toFixed(2)})`);
  else if (ratio > RATIO_COSTO_PRECIO_MUY_ALTO) motivos.push(`costo/precio muy alto (${ratio.toFixed(2)})`);
  // Cantidad del título distinta de la del artículo de Defontana, con
  // Unidades=1: el Mayor podría ser de otra cantidad que la que vende la
  // publicación. No aplica a equivalencias (ya declaran sus cantidades).
  if (c.fuente !== "equivalencia" && p.unidades === 1) {
    const mt = cantidadDeclarada(p.titulo);
    const ma = c.articulo ? cantidadDeclarada(c.articulo) : null;
    if (mt && mt > 1 && ma !== mt) motivos.push(`título x${mt} vs Defontana ${ma ? "x" + ma : "sin cantidad"} (Unidades=1)`);
  }
  return motivos;
}

export function decidir(
  p: PublicacionCosto,
  c: CalculoCosto,
  previo?: { origen: string; costo: number }
): Pick<ResultadoCosto, "origen" | "motivos" | "escribir"> {
  const actual = p.costoActual.trim();
  if (actual !== "") {
    // Hay un Costo: nunca se pisa. Es "auto" solo si lo escribió este
    // proceso y nadie lo cambió desde entonces; cualquier otro caso es manual.
    const eraAuto = previo?.origen === "auto" && Number(actual) === previo.costo;
    return { origen: eraAuto ? "auto" : "manual", motivos: [], escribir: false };
  }
  if (c.costo === null) return { origen: null, motivos: [], escribir: false };
  const motivos = motivosRevision(p, c);
  if (motivos.length > 0) return { origen: "revisar", motivos, escribir: false };
  return { origen: "auto", motivos: [], escribir: true };
}

export type OpcionesCostoAuto = {
  readSheet: (range: string) => Promise<string[][]>;
  writeSheet: (range: string, values: unknown[][]) => Promise<void>;
  appendSheet: (range: string, values: unknown[][]) => Promise<void>;
  batchWriteSheet: (updates: { range: string; values: unknown[][] }[]) => Promise<void>;
  publicaciones: PublicacionCosto[];
  porCod: Map<string, FilaDefontana>;
  porBarras: Map<string, FilaDefontana>;
  equivalencias: Map<string, FilaEquivalencia[]>;
  ahora: Date;
  dryRun: boolean;
};

export type ResumenCostoAuto = {
  dryRun: boolean;
  publicaciones: number;
  porEstadoPublicacion: Record<string, number>;
  calculables: number;
  porFuente: Record<string, number>;
  sinMatch: number;
  conCostoPrevio: number; // manual o auto ya escrito
  manuales: number;
  sospechosos: number;
  porMotivo: Record<string, number>;
  limpios: number; // calculables sin sospecha, tengan o no Costo ya
  aEscribir: number; // limpios con Costo vacío
  escritas: { costos: number; origenNuevos: number; origenActualizados: number };
  lista: ResultadoCosto[];
};

// Agrupa los motivos por tipo (sin los números) para el conteo del resumen.
const clave = (m: string) => (m.startsWith("título") ? "cantidad del título distinta de la de Defontana" : m.replace(/\s*\(.*\)$/, ""));

export async function procesarCostoAuto(op: OpcionesCostoAuto): Promise<ResumenCostoAuto> {
  const hoja = HOJA_COSTO_ORIGEN;
  const origenPrevio = new Map<string, { fila: number; origen: string; costo: number }>();
  try {
    const rows = await op.readSheet(`${hoja}!A2:J20000`);
    rows.forEach((r, i) => { if (r[0]) origenPrevio.set(String(r[0]), { fila: i + 2, origen: r[2] ?? "", costo: Number(r[3]) }); });
  } catch { /* hoja nueva */ }

  const lista: ResultadoCosto[] = op.publicaciones.map((p) => {
    const calculo = calcularCosto(p, op.porCod, op.porBarras, op.equivalencias);
    return { p, calculo, ...decidir(p, calculo, origenPrevio.get(p.id)) };
  });

  const porEstadoPublicacion: Record<string, number> = {};
  const porFuente: Record<string, number> = {};
  const porMotivo: Record<string, number> = {};
  for (const r of lista) {
    porEstadoPublicacion[r.p.estado] = (porEstadoPublicacion[r.p.estado] ?? 0) + 1;
    if (r.calculo.fuente) porFuente[r.calculo.fuente] = (porFuente[r.calculo.fuente] ?? 0) + 1;
    for (const m of r.motivos) porMotivo[clave(m)] = (porMotivo[clave(m)] ?? 0) + 1;
  }
  const calculables = lista.filter((r) => r.calculo.costo !== null);
  const sospechosos = calculables.filter((r) => motivosRevision(r.p, r.calculo).length > 0);
  const resumen: ResumenCostoAuto = {
    dryRun: op.dryRun,
    publicaciones: lista.length,
    porEstadoPublicacion,
    calculables: calculables.length,
    porFuente,
    sinMatch: lista.length - calculables.length,
    conCostoPrevio: lista.filter((r) => r.p.costoActual.trim() !== "").length,
    manuales: lista.filter((r) => r.origen === "manual").length,
    sospechosos: sospechosos.length,
    porMotivo,
    limpios: calculables.length - sospechosos.length,
    aEscribir: lista.filter((r) => r.escribir).length,
    escritas: { costos: 0, origenNuevos: 0, origenActualizados: 0 },
    lista,
  };
  if (op.dryRun) return resumen;

  // ---- Escritura ----
  const aEscribir = lista.filter((r) => r.escribir);
  const registrar = lista.filter((r) => r.origen !== null);

  // Anti-carrera: ml-sync reescribe Publicaciones completa y puede reordenar
  // las filas. Si lo que hay AHORA en una fila ya no es el id esperado, se
  // aborta sin escribir. Se verifica antes de empezar y de nuevo justo antes
  // de escribir el Costo (entre ambos pasa la escritura de CostoOrigen).
  const verificarFilas = async () => {
    if (aEscribir.length === 0) return;
    const ahoraIds = await op.readSheet(`Publicaciones!A2:A${Math.max(...aEscribir.map((r) => r.p.fila)) + 1}`);
    for (const r of aEscribir) {
      if (String(ahoraIds[r.p.fila - 2]?.[0] ?? "") !== r.p.id) {
        throw new Error(`Publicaciones cambió durante la corrida (fila ${r.p.fila} ya no es ${r.p.id}); ¿hay un sync en curso? No se escribió ningún Costo, reintentar.`);
      }
    }
  };
  await verificarFilas();

  // 1) CostoOrigen primero: si el paso 2 fallara, queda "auto" con la celda
  //    vacía y la próxima corrida simplemente la completa (idempotente). Al
  //    revés, quedaría un Costo escrito sin origen y se leería como manual.
  const encabezado = await op.readSheet(`${hoja}!A1:J1`).catch(() => [] as string[][]);
  if (!encabezado.length || (encabezado[0]?.length ?? 0) < HEADERS_COSTO_ORIGEN.length) await op.writeSheet(`${hoja}!A1`, [HEADERS_COSTO_ORIGEN]);
  const updates: { range: string; values: unknown[][] }[] = [];
  const nuevas: unknown[][] = [];
  for (const r of registrar) {
    const costoEscrito = r.escribir ? String(r.calculo.costo) : r.p.costoActual.trim();
    const fila = [
      r.p.id, r.p.sku ?? "", r.origen, costoEscrito,
      r.calculo.costo === null ? "" : String(r.calculo.costo), r.calculo.fuente ?? "",
      r.calculo.codigo ?? "", r.calculo.articulo ?? "", r.motivos.join(" + "), op.ahora.toISOString(),
    ];
    const previo = origenPrevio.get(r.p.id);
    if (previo) { updates.push({ range: `${hoja}!A${previo.fila}:J${previo.fila}`, values: [fila] }); resumen.escritas.origenActualizados++; }
    else { nuevas.push(fila); resumen.escritas.origenNuevos++; }
  }
  if (updates.length > 0) await op.batchWriteSheet(updates);
  if (nuevas.length > 0) await op.appendSheet(`${hoja}!A:J`, nuevas);

  // 2) Costo en Publicaciones, tras re-verificar las filas.
  if (aEscribir.length > 0) {
    await verificarFilas();
    // Números, no strings: son enteros (Mayor × cantidad), sin riesgo de locale.
    await op.batchWriteSheet(aEscribir.map((r) => ({ range: `Publicaciones!F${r.p.fila}`, values: [[r.calculo.costo]] })));
    resumen.escritas.costos = aEscribir.length;
  }
  return resumen;
}

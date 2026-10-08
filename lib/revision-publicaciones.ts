// Revisión de faltantes por publicación: descripción e ISP (registro sanitario
// del Instituto de Salud Pública). Solo lectura (no escribe en ML ni en Sheets).
// Vive en una librería para que la compartan /api/revision-publicaciones y
// /api/completitud (que además pide fotos, GTIN, categoría y tipo logístico:
// ver `extras`).

// Una descripción con menos caracteres (sin espacios en los extremos) se
// considera faltante. Medido contra las 616 publicaciones reales (2026-10-05):
// bajo 100 caracteres no hay descripciones reales sino el título repetido,
// "Incluye: 1 unidad" o una sola frase de marketing repetida entre productos;
// desde ~100 empieza a ser una oración completa. Con 50 se habrían escapado
// 19 publicaciones de ese tipo.
export const UMBRAL_DESCRIPCION_CHARS = 100;

// ISP: el dato vive en el atributo del ítem ISP_PRODUCT_INSCRIPTION_NUMBER
// (jerarquía ITEM, opcional en todas las categorías: tags {}). Ojo con qué
// significa "vacío": ML devuelve el atributo con value_id "-1" y
// value_name null (no lo omite), y a veces directamente no lo incluye. Ambos
// casos cuentan como faltante. El formato del valor NO se valida (en la
// cuenta hay "110c-6113", "N°110C-3594", "102/97", "1618C-562; 111C-864"...):
// solo importa que haya algo escrito. Si la categoría no define el atributo,
// la publicación es "no_aplica" y se informa igual, no se oculta.
export const ISP_ATTR_ID = "ISP_PRODUCT_INSCRIPTION_NUMBER";

const MAX_IDS_POR_LOTE = 200;
const MULTIGET_SIZE = 20;
const CONCURRENCIA = 8;

// Corte proactivo: si el lote se acerca al límite duro de 60s, lo que no se
// alcanzó a procesar se devuelve en "pendientes" y el frontend lo reintenta.
const TIEMPO_MAXIMO_MS = 45000;

export const ESTADOS_A_LISTAR = ["active", "paused", "under_review", "not_yet_active", "inactive"];
export const MAX_IDS_REVISION = MAX_IDS_POR_LOTE;

export type MlGet = <T = unknown>(url: string) => Promise<{ data: T }>;

type EstadoCampo = "ok" | "falta" | "error";
type MotivoDescripcion = "404" | "vacia" | "simbolos" | "corta";

export type FilaRevision = {
  id: string;
  titulo: string;
  sku: string | null;
  estado: string;
  catalogo: boolean;
  permalink: string | null;
  descripcion: {
    estado: EstadoCampo;
    motivo: MotivoDescripcion | null;
    largo: number | null;
    error?: string;
  };
  isp: {
    estado: "ok" | "falta" | "no_aplica" | "error";
    valor: string | null;
    error?: string;
  };
  error?: string;
};

// Campos adicionales (solo con extras: true): los usa /api/completitud.
export type ExtrasRevision = {
  categoriaId: string | null;
  fotos: number;
  gtin: { estado: "con_valor" | "ausente"; valor: string | null };
  full: boolean;
};
export type FilaRevisionExtendida = FilaRevision & Partial<ExtrasRevision>;

type MlAttr = { id: string; value_id?: string | null; value_name?: string | null };
type MlItem = {
  id: string;
  title?: string;
  status?: string;
  category_id?: string;
  catalog_listing?: boolean;
  pictures?: unknown[];
  shipping?: { logistic_type?: string };
  permalink?: string;
  seller_custom_field?: string | null;
  attributes?: MlAttr[];
};

// Caché de módulo: qué categorías definen el atributo ISP. Es metadata casi
// estática y se reutiliza entre lotes mientras la instancia siga caliente.
const categoriaTieneIsp = new Map<string, boolean>();

export async function mapConLimite<T, R>(
  lista: T[],
  limite: number,
  fn: (x: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(lista.length);
  let i = 0;
  async function worker() {
    while (i < lista.length) {
      const idx = i++;
      out[idx] = await fn(lista[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limite, lista.length) }, worker));
  return out;
}

function valorIsp(attrs: MlAttr[] | undefined): { presente: boolean; valor: string | null } {
  const a = (attrs ?? []).find((x) => x.id === ISP_ATTR_ID);
  if (!a) return { presente: false, valor: null };
  const texto = typeof a.value_name === "string" ? a.value_name.trim() : "";
  return { presente: true, valor: a.value_id === "-1" || !texto ? null : texto };
}

export function clasificarDescripcion(plain: string): { estado: EstadoCampo; motivo: MotivoDescripcion | null; largo: number } {
  const t = plain.trim();
  if (t.length === 0) return { estado: "falta", motivo: "vacia", largo: 0 };
  // Solo símbolos/puntuación (ej. ".") — no hay ni una letra ni un dígito.
  if (!/[\p{L}\p{N}]/u.test(t)) return { estado: "falta", motivo: "simbolos", largo: t.length };
  if (t.length < UMBRAL_DESCRIPCION_CHARS) return { estado: "falta", motivo: "corta", largo: t.length };
  return { estado: "ok", motivo: null, largo: t.length };
}

// Todos los IDs de la cuenta por estado (search_type=scan recorre todo; el
// offset clásico da 400 "Invalid limit and offset values" a partir de 1000).
export async function listarIdsPublicaciones(mlGet: MlGet): Promise<{ ids: string[]; porEstado: Record<string, number> }> {
  const { data: user } = await mlGet<{ id: string }>("/users/me");
  const ids: string[] = [];
  const porEstado: Record<string, number> = {};
  for (const status of ESTADOS_A_LISTAR) {
    let scrollId: string | null = null;
    let vistos = 0;
    for (let vuelta = 0; vuelta < 200; vuelta++) {
      const url: string =
        `/users/${user.id}/items/search?status=${status}&search_type=scan&limit=100` +
        (scrollId ? `&scroll_id=${encodeURIComponent(scrollId)}` : "");
      const { data } = await mlGet<{ results: string[]; scroll_id?: string }>(url);
      if (!data.results.length) break;
      ids.push(...data.results);
      vistos += data.results.length;
      scrollId = data.scroll_id ?? null;
      if (!scrollId) break;
    }
    if (vistos > 0) porEstado[status] = vistos;
  }
  return { ids: [...new Set(ids)], porEstado };
}

export async function revisarPublicaciones(
  mlGet: MlGet,
  ids: string[],
  opciones: { extras?: boolean } = {}
): Promise<{ filas: FilaRevisionExtendida[]; pendientes: string[]; tiempoMs: number }> {
  const inicio = Date.now();
  const agotado = () => Date.now() - inicio > TIEMPO_MAXIMO_MS;

  // 1) Detalle por multiget. Un chunk que falla no tira el lote: sus IDs
  //    quedan como fila con error.
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += MULTIGET_SIZE) chunks.push(ids.slice(i, i + MULTIGET_SIZE));
  const detalle = new Map<string, MlItem>();
  const errorPorId = new Map<string, string>();
  const attrsPedidos =
    "id,title,status,category_id,catalog_listing,permalink,seller_custom_field,attributes" +
    (opciones.extras ? ",pictures,shipping" : "");
  await mapConLimite(chunks, 4, async (chunk) => {
    try {
      const { data } = await mlGet<{ code: number; body: MlItem }[]>(
        `/items?ids=${chunk.join(",")}&attributes=${attrsPedidos}`
      );
      const vistos = new Set<string>();
      data.forEach((r, i) => {
        const id = r.body?.id ?? chunk[i];
        vistos.add(id);
        if (r.code === 200 && r.body) detalle.set(id, r.body);
        else errorPorId.set(id, `ML respondió ${r.code} al pedir el ítem`);
      });
      for (const id of chunk) if (!vistos.has(id)) errorPorId.set(id, "ML no devolvió el ítem");
    } catch (err) {
      for (const id of chunk) errorPorId.set(id, `No se pudo leer el ítem (${String(err)})`);
    }
  });

  // 2) Categorías que definen el atributo ISP (solo las no cacheadas).
  const categoriasNuevas = [
    ...new Set(
      [...detalle.values()]
        .map((it) => it.category_id)
        .filter((c): c is string => !!c && !categoriaTieneIsp.has(c))
    ),
  ];
  await mapConLimite(categoriasNuevas, CONCURRENCIA, async (cat) => {
    try {
      const { data } = await mlGet<{ id: string }[]>(`/categories/${cat}/attributes`);
      categoriaTieneIsp.set(cat, data.some((a) => a.id === ISP_ATTR_ID));
    } catch {
      // Sin caché: si falla, el ISP de esos ítems se resuelve por el
      // atributo del propio ítem o queda como error (nunca se adivina).
    }
  });

  // 3) Descripciones, con corte por tiempo.
  const pendientes: string[] = [];
  const filas = await mapConLimite(ids, CONCURRENCIA, async (id): Promise<FilaRevisionExtendida | null> => {
    const it = detalle.get(id);
    if (!it) {
      return {
        id,
        titulo: "",
        sku: null,
        estado: "desconocido",
        catalogo: false,
        permalink: null,
        descripcion: { estado: "error", motivo: null, largo: null },
        isp: { estado: "error", valor: null },
        error: errorPorId.get(id) ?? "Sin detalle",
      };
    }
    if (agotado()) {
      pendientes.push(id);
      return null;
    }

    const skuAttr = (it.attributes ?? []).find((a) => a.id === "SELLER_SKU")?.value_name?.trim();
    const sku = skuAttr || it.seller_custom_field?.trim() || null;

    let descripcion: FilaRevision["descripcion"];
    try {
      const { data } = await mlGet<{ plain_text?: string }>(`/items/${id}/description`);
      descripcion = clasificarDescripcion(data.plain_text ?? "");
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      descripcion =
        status === 404
          ? { estado: "falta", motivo: "404", largo: null }
          : { estado: "error", motivo: null, largo: null, error: String(err) };
    }

    const { presente, valor } = valorIsp(it.attributes);
    const soporta = presente || (it.category_id ? categoriaTieneIsp.get(it.category_id) : undefined);
    let isp: FilaRevision["isp"];
    if (valor) isp = { estado: "ok", valor };
    else if (soporta === true) isp = { estado: "falta", valor: null };
    else if (soporta === false) isp = { estado: "no_aplica", valor: null };
    else isp = { estado: "error", valor: null, error: "No se pudo consultar la categoría" };

    const fila: FilaRevisionExtendida = {
      id,
      titulo: it.title ?? "",
      sku,
      estado: it.status ?? "desconocido",
      catalogo: !!it.catalog_listing,
      permalink: it.permalink ?? null,
      descripcion,
      isp,
    };
    if (opciones.extras) {
      const gtinAttr = (it.attributes ?? []).find((a) => a.id === "GTIN");
      const gtinValor = typeof gtinAttr?.value_name === "string" ? gtinAttr.value_name.trim() : "";
      fila.categoriaId = it.category_id ?? null;
      fila.fotos = it.pictures?.length ?? 0;
      fila.gtin = gtinValor ? { estado: "con_valor", valor: gtinValor } : { estado: "ausente", valor: null };
      fila.full = it.shipping?.logistic_type === "fulfillment";
    }
    return fila;
  });

  return { filas: filas.filter((f): f is FilaRevisionExtendida => f !== null), pendientes, tiempoMs: Date.now() - inicio };
}

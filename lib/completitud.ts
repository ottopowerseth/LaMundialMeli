// Checklist propio de completitud por publicación: ISP, descripción, fotos y
// GTIN. Lógica pura (sin llamadas, salvo rutaCategorias): la usan el endpoint
// /api/completitud y la pantalla.
//
// Reglas (decididas por Otto, 2026-10-08):
//  - ISP: "falta" = la categoría ofrece el campo ISP_PRODUCT_INSCRIPTION_NUMBER
//    y está vacío (ver lib/revision-publicaciones.ts). Nada se marca "no
//    aplica" por cuenta propia: si ML no ofrece el campo en la categoría se
//    informa tal cual ("sin_campo") y no cuenta como faltante. Las faltas se
//    separan en dos bloques por la RAÍZ de la categoría: "esperable"
//    (cosméticos y cuidado personal) y "a confirmar" (todo lo demás, p. ej.
//    aromatizantes de ambiente); si un producto del bloque "a confirmar"
//    requiere ISP lo decide Otto con el proveedor.
//  - Fotos: menos de 3 es faltante; en catálogo es secundario.
//  - GTIN: faltante solo en publicaciones propias; en catálogo es informativo
//    (medido 2026-10-08: el producto de catálogo expone GTIN en 1 de 202, así
//    que no hay base para suponer que lo hereda).
//  - Descripción: umbral de la revisión existente (100 caracteres).
import type { FilaRevisionExtendida, MlGet } from "@/lib/revision-publicaciones";
import { mapConLimite } from "@/lib/revision-publicaciones";

export const UMBRAL_FOTOS = 3;
// Raíces de categoría donde el ISP es esperable. Todo lo demás cae en
// "a confirmar". Ajustable aquí sin tocar el resto.
export const RAICES_ISP_ESPERABLE = ["Belleza y Cuidado Personal"];

export type BloqueIsp = "esperable" | "a_confirmar";
export type Severidad = "principal" | "secundario" | "informativo";
export type TipoFaltante = "isp" | "descripcion" | "fotos" | "gtin";
export type Faltante = { tipo: TipoFaltante; severidad: Severidad; detalle: string };

export type Categoria = { id: string; nombre: string; ruta: string[] };

export type FilaCompletitud = {
  id: string;
  titulo: string;
  sku: string | null;
  estado: string;
  catalogo: boolean;
  full: boolean;
  permalink: string | null;
  categoria: Categoria | null;
  bloqueIsp: BloqueIsp | null; // null si la categoría no ofrece el campo ISP
  isp: { estado: "ok" | "falta" | "sin_campo" | "error"; valor: string | null };
  descripcion: { estado: "ok" | "falta" | "error"; motivo: string | null; largo: number | null };
  fotos: number;
  gtin: { estado: "con_valor" | "ausente"; valor: string | null };
  faltantes: Faltante[];
  nFaltantes: number; // sin contar los informativos
  error?: string;
};

export function bloqueIsp(ruta: string[]): BloqueIsp {
  return ruta.length > 0 && RAICES_ISP_ESPERABLE.includes(ruta[0]) ? "esperable" : "a_confirmar";
}

const MOTIVO_DESCRIPCION: Record<string, string> = {
  "404": "sin descripción",
  vacia: "descripción vacía",
  simbolos: "descripción solo con símbolos",
  corta: "descripción muy corta (<100 caracteres)",
};

export function evaluarCompletitud(f: FilaRevisionExtendida, categoria: Categoria | null): FilaCompletitud {
  const fotos = f.fotos ?? 0;
  const gtin = f.gtin ?? { estado: "ausente" as const, valor: null };
  const ispEstado = f.isp.estado === "no_aplica" ? "sin_campo" : f.isp.estado;
  const faltantes: Faltante[] = [];

  if (ispEstado === "falta") faltantes.push({ tipo: "isp", severidad: "principal", detalle: "sin ISP" });
  if (f.descripcion.estado === "falta") {
    faltantes.push({ tipo: "descripcion", severidad: "principal", detalle: MOTIVO_DESCRIPCION[f.descripcion.motivo ?? ""] ?? "sin descripción" });
  }
  if (fotos < UMBRAL_FOTOS) {
    faltantes.push({ tipo: "fotos", severidad: f.catalogo ? "secundario" : "principal", detalle: `${fotos} ${fotos === 1 ? "foto" : "fotos"} (mínimo ${UMBRAL_FOTOS})` });
  }
  if (gtin.estado === "ausente") {
    faltantes.push({
      tipo: "gtin",
      severidad: f.catalogo ? "informativo" : "principal",
      detalle: f.catalogo ? "la publicación no muestra GTIN (catálogo)" : "sin GTIN",
    });
  }

  return {
    id: f.id, titulo: f.titulo, sku: f.sku, estado: f.estado, catalogo: f.catalogo, full: f.full ?? false, permalink: f.permalink,
    categoria,
    bloqueIsp: ispEstado === "sin_campo" || !categoria ? null : bloqueIsp(categoria.ruta),
    isp: { estado: ispEstado, valor: f.isp.valor },
    descripcion: { estado: f.descripcion.estado, motivo: f.descripcion.motivo, largo: f.descripcion.largo },
    fotos, gtin, faltantes,
    nFaltantes: faltantes.filter((x) => x.severidad !== "informativo").length,
    error: f.error,
  };
}

// ---------- Alcance y resumen ----------
export type FilaConIngreso = FilaCompletitud & { ingreso90: number; unidades90: number; clase: "A" | "B" | "C" | "S" };

// Por defecto: activas y pausadas con ventas en 90 días.
export function enAlcance(f: FilaConIngreso, incluirOtras: boolean): boolean {
  return incluirOtras || (["active", "paused"].includes(f.estado) && f.ingreso90 > 0);
}

export type Exposicion = { publicaciones: number; conVentas: number; ingreso90: number; pctIngreso: number };
export type ResumenCompletitud = {
  publicaciones: number;
  ingresoTotal90: number;
  isp: { esperable: Exposicion; aConfirmar: Exposicion };
  descripcion: Exposicion;
  fotos: { propias: Exposicion; catalogo: Exposicion };
  gtin: { propias: Exposicion; catalogoInformativo: Exposicion };
  sinFaltantes: number;
};

export function resumirCompletitud(filas: FilaConIngreso[], ingresoTotal90: number): ResumenCompletitud {
  const exp = (sel: FilaConIngreso[]): Exposicion => {
    const ing = sel.reduce((s, x) => s + x.ingreso90, 0);
    return { publicaciones: sel.length, conVentas: sel.filter((x) => x.ingreso90 > 0).length, ingreso90: Math.round(ing), pctIngreso: ingresoTotal90 > 0 ? Math.round((ing / ingresoTotal90) * 1000) / 10 : 0 };
  };
  const tiene = (x: FilaConIngreso, tipo: TipoFaltante) => x.faltantes.some((f) => f.tipo === tipo);
  return {
    publicaciones: filas.length,
    ingresoTotal90,
    isp: {
      esperable: exp(filas.filter((x) => tiene(x, "isp") && x.bloqueIsp === "esperable")),
      aConfirmar: exp(filas.filter((x) => tiene(x, "isp") && x.bloqueIsp === "a_confirmar")),
    },
    descripcion: exp(filas.filter((x) => tiene(x, "descripcion"))),
    fotos: { propias: exp(filas.filter((x) => tiene(x, "fotos") && !x.catalogo)), catalogo: exp(filas.filter((x) => tiene(x, "fotos") && x.catalogo)) },
    gtin: { propias: exp(filas.filter((x) => tiene(x, "gtin") && !x.catalogo)), catalogoInformativo: exp(filas.filter((x) => tiene(x, "gtin") && x.catalogo)) },
    sinFaltantes: filas.filter((x) => x.nFaltantes === 0).length,
  };
}

// ---------- Categorías (nombre y ruta) ----------
// Caché de módulo: la ruta de una categoría casi no cambia.
const cacheCategorias = new Map<string, Categoria>();

export async function rutaCategorias(mlGet: MlGet, ids: string[]): Promise<Map<string, Categoria>> {
  const nuevas = [...new Set(ids)].filter((id) => !cacheCategorias.has(id));
  await mapConLimite(nuevas, 5, async (id) => {
    try {
      const { data } = await mlGet<{ name: string; path_from_root?: { name: string }[] }>(`/categories/${id}`);
      cacheCategorias.set(id, { id, nombre: data.name, ruta: (data.path_from_root ?? []).map((p) => p.name) });
    } catch {
      // Sin ruta: la fila queda sin categoría (y sin bloque), nunca se adivina.
    }
  });
  const out = new Map<string, Categoria>();
  for (const id of ids) { const c = cacheCategorias.get(id); if (c) out.set(id, c); }
  return out;
}

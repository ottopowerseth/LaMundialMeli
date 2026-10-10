"use client";

import { useState } from "react";
import { Dato, Datos, TarjetaFila } from "./TarjetaFila";

// Vista móvil (< md) del Comparador vs Mayor: control «Ordenar por» y una tarjeta por publicación, con las
// primeras 50 y «Ver más» de 50 en 50. Solo se muestra bajo md, junto a la tabla de siempre (que lleva
// `hidden md:block`). Las tarjetas reciben las filas ya filtradas y ordenadas por page.tsx (mismo orden que la
// tabla) y el control usa el MISMO estado de orden que los encabezados de la tabla.
// Los textos de ayuda que en la tabla son tooltips (se ven al pasar el cursor) van aquí como líneas visibles.

export type CampoOrden = "titulo" | "precio" | "netoMlPorUnidad" | "precioMayor" | "precioMayorNeto" | "vsMayorPct";
const CAMPOS: { campo: CampoOrden; etiqueta: string }[] = [
  { campo: "titulo", etiqueta: "Producto" }, { campo: "precio", etiqueta: "Precio" }, { campo: "netoMlPorUnidad", etiqueta: "Neto ML/u" },
  { campo: "precioMayor", etiqueta: "Mayor (bruto)" }, { campo: "precioMayorNeto", etiqueta: "Mayor (neto)" }, { campo: "vsMayorPct", etiqueta: "vs Mayor" },
];

export function OrdenarComparadorMovil({ campo, asc, onCampo, onToggle }: { campo: string; asc: boolean; onCampo: (c: CampoOrden) => void; onToggle: () => void }) {
  return (
    <div className="md:hidden mb-3 flex items-end gap-2">
      <label className="min-w-0 flex-1 text-xs text-gray-500">
        Ordenar por
        <select value={campo} onChange={(e) => onCampo(e.target.value as CampoOrden)} className="mt-1 w-full border border-gray-300 rounded-lg px-3 text-sm text-gray-900">
          {CAMPOS.map((c) => <option key={c.campo} value={c.campo}>{c.etiqueta}</option>)}
        </select>
      </label>
      <button type="button" onClick={onToggle} aria-label={asc ? "Orden ascendente" : "Orden descendente"} className="shrink-0 rounded-lg border border-gray-300 px-3 text-sm text-gray-800">
        {asc ? "Ascendente ↑" : "Descendente ↓"}
      </button>
    </div>
  );
}

type Fila = {
  id: string; titulo: string; marca: string | null; proveedor: string | null; precio: number;
  comisionPct: number | null; comisionFuente: "orden" | "calculada" | null; comisionMonto: number | null;
  envioPorUnidad: number | null; envioFuente: "medido" | "estimado" | "sin_dato"; netoMlPorUnidad: number | null;
  precioMayor: number | null; precioMayorNeto: number | null; fuenteMayor: "cruce_directo" | "equivalencia" | "sin_referencia";
  vsMayorPct: number | null; precioSugerido: number | null; semaforo: "rojo" | "amarillo" | "verde" | null;
  mayorEnRevision: boolean; motivoRevision: string | null; statusAnuncio: string | null; vsMayorConAdsPct: number | null;
};

const PASO = 50;
const clp = (n: number) => "$" + Math.round(n).toLocaleString("es-CL");

export function TarjetasComparador({ filas }: { filas: Fila[] }) {
  const [visibles, setVisibles] = useState(PASO); // page.tsx remonta este componente (key) al cambiar orden o filtros: vuelve a 50
  const mostradas = Math.min(visibles, filas.length);
  return (
    <div className="md:hidden mb-0 space-y-2">
      {filas.slice(0, visibles).map((f) => {
        const colorVs = f.vsMayorPct === null || f.mayorEnRevision ? "text-gray-400" : f.vsMayorPct < 0 ? "text-red-600" : f.vsMayorPct <= 10 ? "text-yellow-600" : "text-green-600";
        return (
          <TarjetaFila
            key={f.id}
            cabecera={
              <>
                <p className="text-sm font-medium text-gray-900 line-clamp-2">{f.titulo}</p>
                <p className="mt-0.5 text-xs text-gray-600">
                  {f.semaforo === "rojo" && "🔴 "}{f.semaforo === "amarillo" && "🟡 "}{f.semaforo === "verde" && "🟢 "}
                  {f.mayorEnRevision && <span className="text-amber-700">⚠ Mayor en revisión · </span>}
                  Precio <b className="text-gray-900">{clp(f.precio)}</b> · vs Mayor <b className={colorVs}>{f.vsMayorPct !== null ? `${f.vsMayorPct}%` : "-"}</b>
                </p>
              </>
            }
          >
            <Datos>
              <Dato etiqueta="Marca">{f.marca ?? "-"}</Dato>
              <Dato etiqueta="Proveedor">{f.proveedor ?? "-"}</Dato>
              <Dato etiqueta="Comisión">
                {f.comisionMonto !== null && f.comisionPct !== null
                  ? <>{clp(f.comisionMonto)} <span className="font-normal text-gray-500">({(f.comisionPct * 100).toFixed(1)}%)</span>{f.comisionFuente === "calculada" && <span className="ml-1 text-amber-600">calc.</span>}</>
                  : <span className="text-red-500">sin dato</span>}
              </Dato>
              <Dato etiqueta="Envío/u">
                {f.envioPorUnidad !== null ? clp(f.envioPorUnidad) : <span className="text-red-500">sin dato</span>}
                {f.envioFuente === "estimado" && <span className="ml-1 text-amber-600">(estimado)</span>}
                {f.envioFuente === "medido" && <span className="ml-1 font-normal text-gray-400">(medido)</span>}
              </Dato>
              <Dato etiqueta="Neto ML/u">{f.netoMlPorUnidad !== null ? clp(f.netoMlPorUnidad) : "-"}</Dato>
              <Dato etiqueta="Mayor (bruto)">{f.precioMayor !== null ? clp(f.precioMayor) : "-"}</Dato>
              <Dato etiqueta="Mayor (neto)">{f.precioMayorNeto !== null ? clp(f.precioMayorNeto) : "-"}</Dato>
              <Dato etiqueta="Fuente">{f.fuenteMayor === "cruce_directo" ? "Cruce directo" : f.fuenteMayor === "equivalencia" ? "Equivalencia" : "Sin referencia"}</Dato>
              <Dato etiqueta="vs Mayor"><span className={colorVs}>{f.vsMayorPct !== null ? `${f.vsMayorPct}%` : "-"}</span></Dato>
              <Dato etiqueta="Precio sugerido"><span className={f.mayorEnRevision ? "text-gray-400" : ""}>{f.precioSugerido !== null ? clp(f.precioSugerido) : "-"}</span></Dato>
              <Dato etiqueta="Estado anuncio"><span className="capitalize">{f.statusAnuncio ?? "-"}</span></Dato>
              <Dato etiqueta="vs Mayor c/ ads">{f.vsMayorConAdsPct !== null ? `${f.vsMayorConAdsPct}%` : "-"}</Dato>
            </Datos>
            {f.mayorEnRevision && (
              <p className="text-amber-700">Mayor en revisión: {f.motivoRevision}. El vs Mayor y el precio sugerido están calculados con un Mayor en revisión: no usarlos hasta revisarlo.</p>
            )}
            {f.comisionFuente === "calculada" && (
              <p className="text-gray-500">Comisión calculada por ML para el precio actual (sin ventas en los últimos 45 días).</p>
            )}
            {f.envioFuente === "estimado" && (
              <p className="text-gray-500">Envío estimado: no hay una tarifa medida para esta publicación; se usa un respaldo por SKU gemelo o tramo de precio.</p>
            )}
          </TarjetaFila>
        );
      })}
      <p className="text-center text-xs text-gray-500">Mostrando {mostradas} de {filas.length}</p>
      {filas.length > visibles && (
        <button type="button" onClick={() => setVisibles((v) => v + PASO)} className="w-full rounded-xl border border-gray-200 bg-white text-sm text-gray-700">Ver más</button>
      )}
    </div>
  );
}

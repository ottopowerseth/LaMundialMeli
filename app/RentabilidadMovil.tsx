"use client";

import { useMemo, useState } from "react";
import { Dato, Datos, TarjetaFila } from "./TarjetaFila";

// Vista móvil (< md) del "Detalle por orden" de Rentabilidad: una tarjeta por orden, con las primeras 100 y
// «Ver más» de 100 en 100. Se muestra solo bajo md, junto a la tabla de siempre (que lleva `hidden md:block`
// y desde md sigue mostrando TODAS las órdenes). Mismas filas que la tabla, pero en orden INVERSO: las más
// recientes primero (la tabla de escritorio sigue de la más antigua a la más reciente).

type Fila = {
  idOrden: string; fecha: string; producto: string; precioVenta: number; cogs: number | null; comision: number;
  envio: number; perdida: number; margenNeto: number | null; margenPct: number | null; multiItem: boolean;
};

const PASO = 100;
const clp = (n: number) => "$" + Math.round(n).toLocaleString("es-CL");

export function TarjetasRentabilidad({ filas }: { filas: Fila[] }) {
  const [visibles, setVisibles] = useState(PASO);
  const recientesPrimero = useMemo(() => [...filas].reverse(), [filas]); // copia: no altera el arreglo que usa la tabla
  const mostradas = Math.min(visibles, filas.length);
  return (
    <div className="md:hidden mb-0 space-y-2">
      {recientesPrimero.slice(0, visibles).map((r) => (
        <TarjetaFila
          key={r.idOrden}
          cabecera={
            <>
              <p className="text-xs text-gray-500">{r.fecha}</p>
              <p className="text-sm font-medium text-gray-900 line-clamp-2">{r.producto}</p>
              <p className="mt-0.5 text-sm">
                <span className={`font-semibold ${r.margenNeto === null ? "text-gray-400" : r.margenNeto < 0 ? "text-red-600" : "text-green-600"}`}>
                  {r.multiItem ? "Multi-item, no calculado" : r.margenNeto === null ? "—" : clp(r.margenNeto)}
                </span>
                <span className="text-gray-600"> · {r.margenPct === null ? "—" : `${r.margenPct}%`}</span>
              </p>
            </>
          }
        >
          <Datos>
            <Dato etiqueta="Precio venta">{clp(r.precioVenta)}</Dato>
            <Dato etiqueta="COGS">{r.cogs === null ? "COGS no disponible" : clp(r.cogs)}</Dato>
            <Dato etiqueta="Comisión"><span className="text-orange-600">{clp(r.comision)}</span></Dato>
            <Dato etiqueta="Envío"><span className="text-orange-600">{clp(r.envio)}</span></Dato>
            <Dato etiqueta="Pérdida">{r.perdida > 0 ? clp(r.perdida) : "-"}</Dato>
          </Datos>
        </TarjetaFila>
      ))}
      <p className="text-center text-xs text-gray-500">Mostrando {mostradas} de {filas.length}</p>
      {filas.length > visibles && (
        <button type="button" onClick={() => setVisibles((v) => v + PASO)} className="w-full rounded-xl border border-gray-200 bg-white text-sm text-gray-700">
          Ver más
        </button>
      )}
    </div>
  );
}

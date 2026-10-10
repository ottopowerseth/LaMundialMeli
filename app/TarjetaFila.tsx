"use client";

import { useState } from "react";
import type { ReactNode } from "react";

// Vista móvil (< md) de las tablas anchas: una tarjeta por fila con la cabecera siempre visible y el
// detalle expandible. Se usa junto a la tabla de siempre, que desde md sigue mostrándose igual:
// la tabla lleva `hidden md:block` y la lista de tarjetas `md:hidden`.
// Toda la cabecera es un botón (≥ 44 px de alto) con un indicador claro de abierto/cerrado.

export function ListaTarjetas({ children }: { children: ReactNode }) {
  return <div className="md:hidden space-y-2">{children}</div>;
}

export function TarjetaFila({ cabecera, children }: { cabecera: ReactNode; children: ReactNode }) {
  const [abierta, setAbierta] = useState(false);
  return (
    <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
      <button
        type="button"
        aria-expanded={abierta}
        onClick={() => setAbierta((v) => !v)}
        className="w-full min-h-[44px] flex items-start gap-3 px-3 py-2.5 text-left"
      >
        <div className="min-w-0 flex-1">{cabecera}</div>
        <span className="shrink-0 self-center flex items-center gap-1 text-xs text-gray-500">
          {abierta ? "Cerrar" : "Detalle"}
          <span aria-hidden className={`inline-block transition-transform ${abierta ? "rotate-180" : ""}`}>▾</span>
        </span>
      </button>
      {abierta && <div className="border-t border-gray-100 bg-gray-50 px-3 py-2.5 text-xs text-gray-700 space-y-2 break-words">{children}</div>}
    </div>
  );
}

// Pares etiqueta/valor en dos columnas (sin ancho fijo: no genera scroll horizontal).
export function Datos({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-2 gap-x-4 gap-y-2">{children}</dl>;
}

export function Dato({ etiqueta, children, ancho }: { etiqueta: string; children: ReactNode; ancho?: boolean }) {
  return (
    <div className={`min-w-0 ${ancho ? "col-span-2" : ""}`}>
      <dt className="text-gray-500">{etiqueta}</dt>
      <dd className="font-medium text-gray-900 break-words">{children}</dd>
    </div>
  );
}

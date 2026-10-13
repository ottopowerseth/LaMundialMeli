"use client";

import { useState } from "react";
import { Dato, Datos, TarjetaFila } from "./TarjetaFila";

// Vista móvil (< md) de las tablas de Auditoría: "Historial por mes" y "Errores detectados". Solo se muestran bajo
// md, junto a las tablas de siempre (que llevan `hidden md:block`). Mismas filas y mismo orden que la tabla.
// El historial NO lleva ningún control de borrado (eliminar un mes sigue siendo solo de escritorio).

const clp = (n: number) => "$" + Math.round(n).toLocaleString("es-CL");

// ---------------- Historial por mes ----------------
type FilaHistorial = {
  mes: string; ventas_brutas: number; comisiones_ml: number; comisiones_mp: number; comisiones_mp_px: number;
  total_comisiones: number; notas_credito_ml: number; recuperable: number; tasa_efectiva: number; resumen: string;
  analizado: string; rowIndex: number;
};

const fmtVar = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`);
const colorVar = (v: number | null, invertido = false) => {
  if (v === null) return "text-gray-400";
  const bueno = invertido ? v < 0 : v > 0;
  return bueno ? "text-green-600" : v === 0 ? "text-gray-500" : "text-red-600";
};

// `historial` viene en orden cronológico ascendente (igual que en page.tsx): se invierte solo para mostrar el más
// reciente arriba y la variación se calcula contra el mes anterior, como en la tabla.
export function TarjetasHistorial({ historial }: { historial: FilaHistorial[] }) {
  return (
    <div className="md:hidden mb-0 space-y-2">
      {[...historial].reverse().map((row) => {
        const idx = historial.findIndex((h) => h.rowIndex === row.rowIndex);
        const anterior = idx > 0 ? historial[idx - 1] : null;
        const varVentas = anterior && anterior.ventas_brutas > 0 ? ((row.ventas_brutas - anterior.ventas_brutas) / anterior.ventas_brutas) * 100 : null;
        const varComisiones = anterior && anterior.total_comisiones > 0 ? ((row.total_comisiones - anterior.total_comisiones) / anterior.total_comisiones) * 100 : null;
        return (
          <TarjetaFila
            key={row.rowIndex}
            cabecera={
              <>
                <p className="text-sm font-semibold text-gray-900">{row.mes}</p>
                <p className="mt-0.5 text-xs text-gray-600">
                  Total comisiones <b className="text-red-700">{clp(row.total_comisiones)}</b> · Tasa <b className="text-red-700">{Number(row.tasa_efectiva).toFixed(2)}%</b>
                </p>
                <p className="text-xs text-gray-600">Recuperable <b className="text-green-600">{clp(row.recuperable)}</b></p>
              </>
            }
          >
            <Datos>
              <Dato etiqueta="Ventas brutas">{clp(row.ventas_brutas)}</Dato>
              <Dato etiqueta="Var. ventas"><span className={colorVar(varVentas)}>{fmtVar(varVentas)}</span></Dato>
              <Dato etiqueta="Com. ML"><span className="text-orange-600">{clp(row.comisiones_ml)}</span></Dato>
              <Dato etiqueta="Com. MP"><span className="text-orange-600">{clp(row.comisiones_mp)}</span></Dato>
              <Dato etiqueta="Var. comisiones"><span className={colorVar(varComisiones, true)}>{fmtVar(varComisiones)}</span></Dato>
              <Dato etiqueta="NC ML">{clp(row.notas_credito_ml)}</Dato>
            </Datos>
            <p className="text-gray-600">{row.resumen}</p>
            {row.comisiones_mp_px !== 0 && <p className="text-yellow-700">PX — asumido ML, no verificado: {clp(row.comisiones_mp_px)}</p>}
            <p className="text-gray-400">Analizado: {row.analizado}</p>
          </TarjetaFila>
        );
      })}
    </div>
  );
}

// ---------------- Errores detectados: tarjeta por error, 50 y «Ver más» de 50 en 50 ----------------
type ErrorTipo = "comision_incorrecta" | "envio_incorrecto" | "devolucion_sin_reembolso" | "comision_venta_anulada";
type ErrorFila = { tipo: ErrorTipo; fecha: string; orden: string; producto: string; cobrado: number; esperado: number; diferencia: number; detalle: string };

const BADGE_COLOR: Record<ErrorTipo, string> = {
  comision_incorrecta: "bg-orange-100 text-orange-800", envio_incorrecto: "bg-blue-100 text-blue-800",
  devolucion_sin_reembolso: "bg-red-100 text-red-800", comision_venta_anulada: "bg-purple-100 text-purple-800",
};
const BADGE_LABEL: Record<ErrorTipo, string> = { comision_incorrecta: "Comisión", envio_incorrecto: "Envío", devolucion_sin_reembolso: "Devolución", comision_venta_anulada: "Anulada" };
const PASO = 50;

export function TarjetasErrores({ errores }: { errores: ErrorFila[] }) {
  const [visibles, setVisibles] = useState(PASO);
  const mostradas = Math.min(visibles, errores.length);
  return (
    <div className="md:hidden mb-0 space-y-2">
      {errores.slice(0, visibles).map((err, i) => (
        <TarjetaFila
          key={i}
          cabecera={
            <>
              <p className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                <span className={`px-2 py-0.5 rounded-full font-medium ${BADGE_COLOR[err.tipo]}`}>{BADGE_LABEL[err.tipo]}</span>
                <span>{err.fecha}</span>
              </p>
              <p className="mt-0.5 text-sm font-medium text-gray-900 line-clamp-2">{err.producto}</p>
              <p className={`mt-0.5 text-sm font-bold ${err.diferencia > 0 ? "text-green-600" : "text-red-600"}`}>
                {err.diferencia > 0 ? "+" : ""}{clp(err.diferencia)}
              </p>
            </>
          }
        >
          <Datos>
            <Dato etiqueta="Orden"><span className="font-mono">{err.orden}</span></Dato>
            <Dato etiqueta="Cobrado">{clp(err.cobrado)}</Dato>
            <Dato etiqueta="Esperado">{err.esperado > 0 ? clp(err.esperado) : "—"}</Dato>
            <Dato etiqueta="Dif."><span className={err.diferencia > 0 ? "text-green-600" : "text-red-600"}>{err.diferencia > 0 ? "+" : ""}{clp(err.diferencia)}</span></Dato>
            <Dato etiqueta="Detalle" ancho>{err.detalle}</Dato>
          </Datos>
        </TarjetaFila>
      ))}
      <p className="text-center text-xs text-gray-500">Mostrando {mostradas} de {errores.length}</p>
      {errores.length > visibles && (
        <button type="button" onClick={() => setVisibles((v) => v + PASO)} className="w-full rounded-xl border border-gray-200 bg-white text-sm text-gray-700">Ver más</button>
      )}
    </div>
  );
}

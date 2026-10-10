"use client";

import { useState } from "react";
import { Dato, Datos, TarjetaFila } from "./TarjetaFila";

// Vista móvil (< md) de las tablas de la pestaña Métricas. Cada componente se muestra solo bajo md,
// junto a la tabla de siempre (que lleva `hidden md:block`), con las mismas filas y el mismo orden.
// Los tipos son los campos que usa cada vista (page.tsx no puede exportar sus tipos).

const clp = (n: number) => "$" + Math.round(n).toLocaleString("es-CL");

// ---------------- Ranking de productos y Visitas y conversión: listas compactas (título completo) ----------------
export function ListaRankingMovil({ ranking }: { ranking: { id: string; titulo: string; monto: number; unidades: number }[] }) {
  return (
    <ol className="md:hidden mb-0 divide-y divide-gray-100">
      {ranking.map((p, i) => (
        <li key={p.id} className="flex items-start gap-3 py-2.5">
          <span className="w-6 shrink-0 text-sm text-gray-400">{i + 1}</span>
          <p className="min-w-0 flex-1 text-sm text-gray-800 break-words">{p.titulo}</p>
          <div className="shrink-0 text-right">
            <p className="text-sm font-semibold text-gray-900">{clp(p.monto)}</p>
            <p className="text-xs text-gray-500">{p.unidades} u</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function ListaVisitasMovil({ filas }: { filas: { id: string; titulo: string; visitas: number; ventas: number; conversion: number | null }[] }) {
  return (
    <ul className="md:hidden mb-0 divide-y divide-gray-100">
      {filas.map((v) => (
        <li key={v.id} className="py-2.5">
          <p className="text-sm text-gray-800 break-words">{v.titulo}</p>
          <p className="mt-0.5 text-xs text-gray-600">
            Visitas <b className="text-gray-900">{v.visitas}</b> · Ventas <b className="text-gray-900">{v.ventas}</b> · Conversión <b className="text-gray-900">{v.conversion !== null ? `${v.conversion}%` : "-"}</b>
          </p>
        </li>
      ))}
    </ul>
  );
}

// ---------------- ROAS / Publicidad: tarjeta por campaña ----------------
type Campana = {
  id: number; nombre: string; estado: string; estrategia: string; acosTarget: number; presupuestoDiario: number;
  clics: number; impresiones: number; ctr: number; cpc: number; costo: number; roas: number; acos: number;
  montoDirecto: number; montoIndirecto: number; unidadesOrganicas: number; montoOrganico: number; usoPresupuesto: number | null;
};

export function TarjetasCampanas({ campanas }: { campanas: Campana[] }) {
  return (
    <div className="md:hidden mb-0 space-y-2">
      {campanas.map((c) => (
        <TarjetaFila
          key={c.id}
          cabecera={
            <>
              <p className="text-sm font-medium text-gray-900 break-words">{c.nombre}</p>
              <p className="mt-0.5 text-xs text-gray-500 capitalize">{c.estado}</p>
              <p className="mt-0.5 text-xs text-gray-600">
                ROAS <b className="text-gray-900">{c.costo > 0 ? c.roas.toFixed(2) : "sin actividad"}</b> · ACOS <b className="text-gray-900">{c.costo > 0 ? `${c.acos}%` : "-"}</b> · Costo <b className="text-gray-900">{clp(c.costo)}</b>
              </p>
            </>
          }
        >
          <Datos>
            <Dato etiqueta="Estrategia"><span className="capitalize">{c.estrategia}</span></Dato>
            <Dato etiqueta="Presup. diario">{clp(c.presupuestoDiario)}</Dato>
            <Dato etiqueta="Uso presup.">{c.usoPresupuesto !== null ? `${c.usoPresupuesto}%` : "-"}</Dato>
            <Dato etiqueta="ACOS target">{c.acosTarget}%</Dato>
            <Dato etiqueta="Clics">{c.clics}</Dato>
            <Dato etiqueta="Impresiones">{c.impresiones}</Dato>
            <Dato etiqueta="CTR">{c.ctr}%</Dato>
            <Dato etiqueta="CPC">{clp(c.cpc)}</Dato>
            <Dato etiqueta="Directo">{clp(c.montoDirecto)}</Dato>
            <Dato etiqueta="Indirecto">{clp(c.montoIndirecto)}</Dato>
            <Dato etiqueta="Uds. orgánicas">{c.unidadesOrganicas}</Dato>
            <Dato etiqueta="Monto orgánico">{clp(c.montoOrganico)}</Dato>
          </Datos>
        </TarjetaFila>
      ))}
    </div>
  );
}

// ---------------- Tabla por producto: tarjeta por fila (20 y "Ver más" de 20 en 20) ----------------
type FilaProducto = {
  id: string; titulo: string; ventasMonto: number; ventasUnidades: number; visitas: number | null; conversion: number | null;
  stock: number | null; full: boolean; precio: number | null; costo: number | null; margenPct: number | null; costoMax: number | null;
  costoMaxFuenteEnvio: "medido" | "estimado" | null; comisionPct: number | null; comisionFuente: "orden" | "calculada" | null;
  envioPorUnidad: number | null; precioEquilibrio: number | null; pierde: boolean; campana: string | null; statusAnuncio: string | null;
  clics: number; impresiones: number; ctr: number; cpc: number; costoAds: number; acos: number; roas: number; etiquetas: string[];
};

const PASO = 20;
const claseEtiqueta = (e: string) => (e === "Candidato" ? "bg-green-100 text-green-700" : e === "Revisar" ? "bg-red-100 text-red-700" : "bg-orange-100 text-orange-700");

export function TarjetasProductos({ filas }: { filas: FilaProducto[] }) {
  const [visibles, setVisibles] = useState(PASO);
  return (
    <div className="md:hidden mb-0 space-y-2">
      {filas.slice(0, visibles).map((f) => {
        const estimado = f.margenPct !== null && (f.costoMaxFuenteEnvio === "estimado" || f.comisionFuente === "calculada");
        return (
          <TarjetaFila
            key={f.id}
            cabecera={
              <>
                <p className="text-sm font-medium text-gray-900 line-clamp-2">{f.titulo}</p>
                {f.etiquetas.length > 0 && (
                  <p className="mt-1 flex flex-wrap gap-1">
                    {f.etiquetas.map((e) => <span key={e} className={`text-xs font-medium rounded-full px-2 py-0.5 ${claseEtiqueta(e)}`}>{e}</span>)}
                  </p>
                )}
                <p className="mt-0.5 text-xs text-gray-600">
                  Ventas <b className="text-gray-900">{clp(f.ventasMonto)}</b> · {f.ventasUnidades} u · Margen{" "}
                  <b className="text-gray-900">{f.margenPct !== null ? `${f.margenPct}%` : "-"}</b>
                  {estimado && <span className="ml-1 text-amber-600">est.</span>}
                  {f.pierde && <span className="ml-1 font-medium bg-red-100 text-red-700 rounded-full px-2 py-0.5">Pierde</span>}
                </p>
              </>
            }
          >
            <p className="font-semibold text-gray-800">Tráfico</p>
            <Datos>
              <Dato etiqueta="Visitas">{f.visitas ?? "-"}</Dato>
              <Dato etiqueta="Conversión">{f.conversion !== null ? `${f.conversion}%` : "-"}</Dato>
            </Datos>
            <p className="font-semibold text-gray-800">Inventario y precio</p>
            <Datos>
              <Dato etiqueta="Stock">{f.stock ?? "-"}</Dato>
              <Dato etiqueta="Full">{f.full ? "Sí" : "No"}</Dato>
              <Dato etiqueta="Precio">{f.precio !== null ? clp(f.precio) : "-"}</Dato>
              <Dato etiqueta="Costo">{f.costo !== null ? clp(f.costo) : "SIN DATO"}</Dato>
              <Dato etiqueta="Costo máx.">
                {f.costoMax !== null ? clp(f.costoMax) : "-"}
                {f.costoMaxFuenteEnvio && <span className={`ml-1 ${f.costoMaxFuenteEnvio === "estimado" ? "text-amber-600" : "text-gray-400"}`}>(envío {f.costoMaxFuenteEnvio})</span>}
              </Dato>
              <Dato etiqueta="Precio equilibrio">{f.costo !== null && f.precioEquilibrio !== null ? clp(f.precioEquilibrio) : "-"}</Dato>
            </Datos>
            {f.comisionPct !== null && f.envioPorUnidad !== null && (
              <p className="text-gray-500">
                Margen de contribución antes de publicidad. Comisión {(f.comisionPct * 100).toFixed(1)}% ({f.comisionFuente === "orden" ? "cobrada en las ventas del período" : "calculada por ML"}) · envío {clp(f.envioPorUnidad)} por unidad ({f.costoMaxFuenteEnvio}).
              </p>
            )}
            <p className="font-semibold text-gray-800">Publicidad</p>
            <Datos>
              <Dato etiqueta="Campaña" ancho>{f.campana ?? "-"}</Dato>
              <Dato etiqueta="Estado anuncio"><span className="capitalize">{f.statusAnuncio ?? "-"}</span></Dato>
              <Dato etiqueta="Clics">{f.clics}</Dato>
              <Dato etiqueta="Impr.">{f.impresiones}</Dato>
              <Dato etiqueta="CTR">{f.ctr}%</Dato>
              <Dato etiqueta="CPC">{clp(f.cpc)}</Dato>
              <Dato etiqueta="Costo ads">{clp(f.costoAds)}</Dato>
              <Dato etiqueta="ACOS">{f.costoAds > 0 ? `${f.acos}%` : "-"}</Dato>
              <Dato etiqueta="ROAS">{f.costoAds > 0 ? f.roas.toFixed(2) : "-"}</Dato>
            </Datos>
          </TarjetaFila>
        );
      })}
      {filas.length > visibles && (
        <button type="button" onClick={() => setVisibles((v) => v + PASO)} className="w-full rounded-xl border border-gray-200 bg-white text-sm text-gray-700">
          Mostrando {visibles} de {filas.length} — Ver más
        </button>
      )}
    </div>
  );
}

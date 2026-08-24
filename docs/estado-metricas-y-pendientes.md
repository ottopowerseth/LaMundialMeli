# Estado — Pestaña Métricas y pendientes (ml-tracker)

**Última actualización:** 2026-08-24

> Nota: este documento se reconstruyó a partir del código fuente real del repo
> (no existía una versión previa disponible en este entorno de trabajo). Las
> 6 secciones "ya en producción" reflejan el estado de `app/api/metrics/route.ts`
> y `app/page.tsx` (tab Métricas) al momento de esta actualización.

## Arquitectura general

- Endpoint único: `GET /api/metrics?periodo=dia|semana|mes` (`app/api/metrics/route.ts`).
- Todo se calcula **en vivo** contra la API de Mercado Libre en cada request —
  no persiste nada en Google Sheets (a diferencia de Publicaciones/Ventas/Auditoría).
- Fechas siempre construidas con `Date.UTC(...)`, nunca `new Date()` en hora
  local — mismo criterio que usa Auditoría, para que los números cuadren
  entre pestañas.
- Cada sección devuelve `{ ok: boolean, ...datos, error?: string }` — si una
  sección falla, el resto sigue funcionando (degradación independiente).

## Secciones en producción

1. **Ventas / ticket promedio** — `/orders/search` (status=paid). Trae total
   vendido, unidades, cantidad de órdenes, ticket promedio, y `ventasPorItem`
   (detalle por publicación, usado también por Visitas y por el Ranking).
2. **Reputación** — viene directo de `/users/me` (`seller_reputation`), sin
   llamada adicional. Nivel, power seller, reclamos, cancelaciones, despacho tardío.
3. **Visitas / Conversión** — `/users/{id}/items_visits` (total) +
   `/items/{id}/visits` (top 10 publicaciones por ventas del período, límite
   para no disparar decenas de requests).
   **Gotcha:** la API de Visits devuelve 400 si `date_to` cae en el futuro
   (a diferencia de `/orders/search`, que sí lo tolera). El cap se aplica
   **solo en esa llamada puntual** (`hastaVisitas = min(hasta, ahora)`), no
   en `rangoFechas()` ni en el resto de las secciones — para el período
   "mes" en curso, el `hasta` real (usado por Ventas/Auditoría) sigue siendo
   el primer día del mes siguiente.
4. **Preguntas** — `/questions/search`, filtrado por fecha en el código (el
   endpoint no soporta filtro de fecha nativo). `date_created` viene en hora
   Chile (-04:00), no UTC — se normaliza antes de comparar contra el rango.
5. **Reclamos** — `/post-purchase/v1/claims/search`.
   **Gotcha:** este endpoint **ignora silenciosamente** cualquier parámetro
   de fecha que se le pase (confirmado empíricamente: `paging.total` no
   cambia con o sin esos params) — siempre devuelve el histórico completo.
   El filtrado por `date_created` se hace 100% client-side, igual que
   Preguntas, normalizando la misma hora Chile (-04:00) antes de comparar.
6. **ROAS / Publicidad** — `/advertising/advertisers` +
   `/marketplace/advertising/{site}/advertisers/{id}/product_ads/campaigns/search`.
   Inversión, ventas atribuidas, ROAS agregado (cálculo propio, no de ML) y
   tabla de campañas.
   **Gotcha (no es de código):** el bloqueo inicial para implementar esta
   sección no fue técnico — el scope **"Publicidad de un producto"** estaba
   en **"Sin acceso"** en el DevCenter de la aplicación. Hubo que cambiarlo a
   **"Lectura"** y volver a autorizar la app (re-consentimiento OAuth) para
   que emitiera un token nuevo con ese permiso — el token viejo no lo
   adquiere solo con el cambio de scope en el panel.
7. **Ranking de productos + Comparación de período** *(nuevo — commit `83e4497`)*
   — ver detalle abajo.

### 7. Ranking de productos + Comparación de período

**Commit:** `83e4497` — *feat: agregar ranking de productos y comparación de período a Métricas*

- **Ranking**: top 10 productos por monto vendido (con unidades), en la
  pestaña Ventas de Métricas. `ventasPorItem` **ya existía** en
  `calcularVentas()` — se usaba para alimentar el top de publicaciones de
  Visitas — así que no hizo falta ningún cambio de sync ni endpoint nuevo de
  ML: el ranking solo ordena y expone un dato que ya se calculaba.
- **Comparación de período anterior**: aplicada a las 3 métricas de Ventas
  donde tiene sentido (total vendido, unidades, ticket promedio). Muestra
  variación % con flecha de tendencia (▲/▼/→).
- Dos piezas reutilizables, no atadas a Ventas, pensadas para que otras
  secciones de Métricas se sumen más adelante sin duplicar lógica:
  - Backend: `rangoAnterior(periodo, desde, hasta)` (calcula el rango
    inmediatamente anterior de igual duración) y `calcularVariacionPct(actual, anterior)`.
  - Frontend: componente `VariacionBadge`.
- **Probado con datos reales** (mes en curso vs. mes anterior): +25% en
  ventas totales, +19% en unidades, +11.3% en ticket promedio. También
  verificado con `periodo=semana` contra la API real (rango de 7 días,
  período anterior de igual duración calculado correctamente).

## Historial de commits relevantes

| Commit | Descripción |
|---|---|
| `66555c7` | Agregar sección ROAS/Publicidad a la pestaña Métricas |
| `3a06e35` | Corrige 3 hallazgos de la validación de Auditoría (Fase 1): validación de cobertura contra el ciclo real de facturación 15→14, fix de truncado de timestamp, `isInMonth`/`fetchReferenciaML` alineados al ciclo real |
| `2f35371` | *chore: eliminar código muerto* — `lib/mercadolibre.ts` eliminado (cliente ML redundante con `lib/ml-token.ts`, sin refresh automático, sin ningún import en el proyecto) y `@anthropic-ai/sdk` removido de `package.json`/`package-lock.json` (declarado pero nunca usado en ningún archivo) |
| `83e4497` | *feat: agregar ranking de productos y comparación de período a Métricas* — ver sección 7 arriba |

## Pendiente / sin decidir

### Auditoría — reemplazar CSV manual por la API de Facturación de ML

Ya está confirmado (investigación previa) que `/billing/integration/periods/key/{KEY}/group/ML/details`
reemplaza 100% el parseo de Facturación ML y Notas de Crédito (ambos grupos)
desde CSV/XLSX. El grupo `MP` tiene la misma contaminación de Shopify que el
CSV (ningún campo distingue canal), así que no resuelve ese problema por sí
solo. Ver commits de la Fase de validación de cobertura (`3a06e35`) para el
detalle de por qué el ciclo real de facturación es 15→14, no el mes calendario.

### Bloque blando de rentabilidad — diagnóstico

Paso previo al diseño del esquema de Rentabilidad por orden (paso 4 del
roadmap). Ya está confirmado que el bloque "duro" (comisión + envío + ads)
está disponible por orden vía la Billing API, usando `sales_info.order_id`
como llave (241 filas reales confirmadas, grupo ML). Falta el bloque
"blando": Costo de Almacenamiento, Penalizaciones y Pérdidas.

**Almacenamiento (Fulfillment/Full)** — disponible en la misma Billing API,
como `detail_sub_type: "CFWA"` (`transaction_detail: "Cargo por servicio de
almacenamiento Full"`). Es un cargo **agregado, no por orden**: confirmado
con una fila real que trae `sales_info: null`, `shipping_info: null`,
`items_info: null` y `debited_from_operation: "NO"` — no liga a ninguna
venta puntual. Confirmado además que La Mundial usa Full **activamente**:
1027 de 1550 órdenes cacheadas en `ShippingCache` (66%) tienen
`logistic_type: "fulfillment"`. **Decisión pendiente**: como ML no expone
ninguna base de prorrateo (no hay relación a SKU/orden en el cargo), la
opción más honesta es mostrarlo como costo operativo del período, aparte
del cálculo de costo de venta *por orden* — prorratearlo (ej. por unidades
vendidas) sería inventar una regla que ML no respalda.

**Penalizaciones** — no encontradas como cargo monetario en ningún archivo
real de Facturación ML de La Mundial (se revisaron todos los `Detalle`
únicos de todos los meses descargados, y se muestreó la Billing API real de
agosto sin encontrar ningún `detail_sub_type` de este tipo). Las
penalizaciones en ML son **principalmente reputacionales**, no una línea de
cargo en pesos: bajan de nivel de reputación → menor visibilidad → menor
bonificación de envío → se compensa con más gasto en Ads (impacto
indirecto, ya capturado en parte por la sección ROAS). La documentación de
ML sí menciona "incumplimiento" como tipo de cargo dentro del reporte de
Fulfillment, pero La Mundial no ha tenido ese caso en los períodos
revisados. **No estimable** hasta que aparezca un caso real que se pueda
capturar y clasificar.

**Pérdidas (Cargo por devolución)** — disponible en la misma Billing API,
`detail_sub_type: "CDSD"` (`transaction_detail: "Cargo por devolución"`).
**Sí liga a una orden específica**: confirmado con una fila real (período
2026-02, `detail_id: 57388604981`) que trae `sales_info.order_id`,
`shipping_info` e `items_info` completos, con `debited_from_operation:
"YES"` — mismo patrón que `CV`/`CXD`/`CFF` (bloque duro), no como
`CFWA` (almacenamiento). No hay riesgo de doble conteo con la sección de
Reclamos (Métricas sección 5): `/post-purchase/v1/claims/search` no trae
ningún monto en pesos, solo conteo por status/tipo — es puramente
informativo, así que "Cargo por devolución" de la Billing API es la única
fuente real de esta cifra en dinero.

| Concepto | Endpoint/dato | Por orden | La Mundial lo genera hoy | Esfuerzo |
|---|---|---|---|---|
| Almacenamiento (Full) | Billing API, `CFWA` | No (agregado) | Sí, activamente (66% de órdenes) | Bajo para traer el dato; requiere decisión de diseño para no romper la premisa "por orden" |
| Penalizaciones | No encontrado | — | No, en los períodos revisados | No estimable — sin caso real que capturar |
| Pérdidas (devolución) | Billing API, `CDSD` | Sí (`order_id` confirmado) | Sí (al menos 1 caso real en feb-2026) | Bajo — mismo patrón que el bloque duro ya validado |

### rangoAnterior() no generaliza a rangos custom (diagnosticado, no bloqueante)

La rama `"mes"` de `rangoAnterior()` calcula siempre el mes calendario
anterior, ignorando la duración real del rango `{desde, hasta}` que recibe.
**Hoy esto no es un bug**: `Periodo` es un enum cerrado (`"dia" | "semana" | "mes"`)
y no existe ningún selector de fecha custom en la UI — ese estado
(rango arbitrario de N días pasando por la rama `"mes"`) no es alcanzable
desde la interfaz actual. Verificado con datos reales: la rama genérica
(`dia`/`semana`, resta de duración en milisegundos) sí calcula correctamente
el período anterior para cualquier duración, incluida una custom.

**Si en el futuro se agrega un selector de fecha custom**, hay que cambiar
`rangoAnterior()` para que decida por la duración/forma real del rango
recibido en vez de por el string `periodo`: tratar "mes calendario" solo
cuando `desde` cae exactamente en el día 1 y `hasta` en el día 1 del mes
siguiente; en cualquier otro caso, usar la resta de duración en ms (la misma
lógica que ya usan `dia`/`semana` hoy).

### Ranking de productos no cruza contra estado de publicación ni stock (diagnosticado, no bloqueante)

El ranking (sección 7) solo muestra monto y unidades vendidas — no indica si
la publicación sigue activa, está pausada, o sin stock.

- `order_items[].item` dentro de `/orders/search` (la única llamada que
  arma `ventasPorItem`) **no trae** `status` ni `available_quantity` —
  confirmado contra la API real: solo expone `id, title, category_id,
  variation_id, seller_custom_field, variation_attributes, warranty,
  condition, seller_sku`.
- **Pero el dato sí está disponible sin ninguna llamada nueva a ML**: la
  hoja **"Publicaciones"** ya sincroniza `Stock` (columna D) y `Estado ML`
  (columna K) vía `ml-sync` (`/items?ids=...`, batch). Cruzar el ranking
  contra esa hoja por `ID` sería una lectura adicional de Google Sheets
  dentro de `metrics/route.ts` (que hoy es 100% en vivo, sin tocar Sheets
  en ninguna sección) — costo bajo, sin rate limit de ML de por medio.
- **Pendiente de decidir**: qué mostrar si un producto vendido en el período
  ya no tiene fila en Publicaciones (por ejemplo, se descontinuó o se borró
  la publicación) — el cruce por `ID` no encontraría match en ese caso.

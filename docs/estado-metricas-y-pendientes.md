# Estado — Pestaña Métricas y pendientes (ml-tracker)

**Última actualización:** 2026-08-24 (diseño de Rentabilidad por orden)

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

### Diseño de Rentabilidad por orden (Fase 1 y 2)

Diseño completo (sin implementar), construido sobre el diagnóstico del
bloque blando de arriba. COGS: columna `Costo` (F) de la hoja
**Publicaciones**, ya sincronizada por `ml-sync`, cargada/editada a mano y
preservada entre syncs.

**Esquema de datos — hoja nueva `Rentabilidad`**, una fila por orden,
append-only con upsert por `ID Orden` (mismo patrón que Auditoría: si se
re-calcula un período ya guardado, se sobreescribe la fila existente en vez
de duplicarla).

| Columna | Origen | Notas |
|---|---|---|
| `ID Orden` | Billing API `sales_info.order_id` | Llave de la fila. Prefijo `'` (texto literal), mismo criterio que Ventas/ShippingCache. |
| `Fecha` | Billing API `sales_info.sale_date_time` | |
| `ID Item` | Billing API `items_info[].item_id` | Llave para cruzar contra Publicaciones. |
| `Producto` | Billing API `items_info[].item_title` | |
| `Precio de venta` | Billing API `sales_info.transaction_amount` | |
| `COGS` | Cruce contra `Publicaciones!F` por `ID Item` | Snapshot copiado en el momento del cálculo, no referenciado en vivo — si el costo del producto cambia después, el margen de una orden vieja no debe moverse solo. |
| `Comisión` | Billing API, suma de filas `CV` de esa orden | |
| `Envío efectivo` | Billing API, suma de filas `CXD`/`CFF` de esa orden | |
| `Pérdida/devolución` | Billing API, suma de filas `CDSD` de esa orden (0 si no aplica) | |
| `Ads atribuido` | Cálculo propio, ver fórmula abajo | Columna separada, no mezclada en "Comisión", para que quede auditable. |
| `Margen neto` | Fórmula abajo | Fórmula de Sheets o valor calculado en backend, a decidir en implementación. |
| `Margen %` | `Margen neto / Precio de venta` | |
| `Logístico` | Cruce contra `ShippingCache` por `ID Orden` | Full vs. estándar — no es un costo, es contexto (por qué una orden Full no tiene línea de Almacenamiento: ese costo está agregado, no acá). |
| `Analizado` | timestamp | |

No se duplica `Publicaciones!F` ni `ShippingCache` — ambas se leen por llave
en el momento del cálculo, sin re-guardarlas en `Rentabilidad`.

**Almacenamiento Full**: en vez de una hoja nueva de una sola columna, se
agrega como columna a la hoja **Auditoría** ya existente (ya es "una fila
por mes"). Esto es un **préstamo intencional de esquema, no que el dato
pertenezca a Auditoría** — conceptualmente es parte de Rentabilidad (costo
operativo que reduce el margen del negocio, no una comisión de venta). Para
que quede claro en el propio Sheet sin depender de este documento, el
nombre de columna debe ser explícito: **`Almacenamiento_Full_Rentabilidad`**,
no algo genérico como "Almacenamiento".

**COGS sin match** (producto vendido que ya no tiene fila en Publicaciones,
descontinuado o eliminado): `COGS` queda vacío, `Margen neto` no se calcula
(se muestra "—" o "COGS no disponible") y se lista aparte como advertencia
— nunca se asume COGS=0, inflaría el margen falsamente.

**Fórmula final por orden:**

```
Margen neto = Precio de venta − COGS − Comisión − Envío efectivo − Ads atribuido − Pérdida/devolución
```

Almacenamiento queda fuera de esta fórmula (tarjeta de resumen a nivel
período, no resta del margen de ninguna orden puntual).

**El problema de Ads — resuelto con investigación real.** ML no expone
atribución de Ads a nivel de venta individual (`calcularRoas` solo trae
costo por campaña/período). Confirmado contra la cuenta real de La Mundial
que el mapeo campaña→producto sí existe:
`GET /marketplace/advertising/{site}/advertisers/{id}/product_ads/ads/search`
(mismo grupo de endpoints que ROAS, mismo header `Api-Version: 1`) devuelve
68 publicaciones reales repartidas entre las 2 campañas de la cuenta
(`358688613` "Top Ventas", `353997794` "Elvive Serum"), cada una con
`item_id` + `campaign_id`.

**Gotcha:** el filtro server-side de `/product_ads/ads/search` por campaña
(`campaign_id`, `campaign_ids`, `campaignId` — se probaron las 3 variantes)
**no funciona** — el endpoint siempre devuelve el total de la cuenta (396
ads en la prueba real), ignorando el parámetro. Hay que traer todas las
páginas (~400 filas, 8 páginas de 50) y filtrar client-side por
`campaign_id`, comparando contra el listado de campañas ya obtenido de
`calcularRoas`. Mismo patrón que otros endpoints de ML que ignoran filtros
no soportados (ver gotcha de Reclamos, sección 5 arriba).

**Método propuesto — prorrateo por unidades vendidas del producto en el
período de la campaña:**

```
Ads atribuido a una orden =
  (costo total de la campaña en el período, de calcularRoas)
  × (unidades de ESE producto en ESA orden)
  ÷ (unidades totales vendidas de ese producto durante el período de la campaña)
```

Limitación que sigue en pie (el mapeo se resolvió, esto no): es prorrateo
uniforme, no atribución real — una campaña puede generar ventas orgánicas
del mismo producto, y este método les carga el mismo costo de Ads a todas
las unidades por igual. Es una limitación estructural de la API de Product
Ads (no expone atribución por clic-a-venta), no algo que el mapeo de items
resuelva. Recomendación: marcar `Ads atribuido` como estimación
explícitamente etiquetada en la UI ("Ads (prorrateado, no exacto)"), mismo
criterio que ya usa el ROAS agregado ("cálculo propio, no de ML").

**UI propuesta — pestaña propia "Rentabilidad", no sección 8 de Métricas.**
Razones: Métricas hoy son tarjetas de lectura rápida; Rentabilidad necesita
una tabla densa por orden (potencialmente cientos de filas/mes) — mismo
criterio que ya separó Auditoría y Forecast de Métricas. Evita además
alargar el tiempo de respuesta de Métricas (hoy ~20-26s) con más llamadas a
la Billing API (rate limit 5 req/min). Tres niveles de detalle: (1)
tarjetas de resumen del período (margen neto total, margen % promedio,
órdenes con margen negativo, tarjeta separada de Almacenamiento), (2)
resumen por producto (agregado, como el Ranking), (3) tabla por orden
(detalle colapsable, como el histórico de Auditoría). Almacenamiento se
muestra con texto explícito ("costo operativo, no incluido en el margen por
orden porque ML no lo liga a ventas específicas") — mismo criterio que "PX
— asumido ML, no verificado" en Auditoría: visible, etiquetado, sin
esconder el número aunque no encaje limpio en el cálculo principal.

**Costo de implementación y fasamiento:**

| Bloque | Esfuerzo |
|---|---|
| Comisión + Envío + Pérdidas por orden (Billing API, ya validada) | Medio |
| COGS por orden (lectura de Sheets, sin llamada nueva) | Bajo |
| Almacenamiento agregado (mismo request de Billing API, filtro `CFWA`) | Bajo |
| Ads atribuido (`/product_ads/ads/search`, mapeo confirmado, sigue siendo prorrateo) | Medio |
| Pestaña nueva completa (tabla densa, filtros, 3 niveles de detalle) | Medio-Alto |

Gotcha transversal: la Billing API tiene rate limit de 5 req/min — traer el
detalle completo de un mes ya toma ~1 minuto solo en llamadas. Para
Rentabilidad esto es más exigente que para Auditoría (acá se necesita el
detalle completo por orden, no solo totales agregados) — hay que diseñar
con caché en mente desde el principio (guardar en `Rentabilidad` lo ya
calculado, no repetir la consulta si la orden ya está en la hoja).

**Fasamiento recomendado:**
1. **Fase 1 — bloque duro sin Ads**: Comisión + Envío + COGS + Pérdidas por
   orden, hoja `Rentabilidad`, pestaña nueva con los 3 niveles de detalle,
   Almacenamiento como columna en Auditoría. Todo con datos y endpoints ya
   100% validados — menor riesgo.
2. **Fase 2 — Ads atribuido**: el mapeo campaña→producto ya está confirmado,
   así que ya no depende de investigación previa — implementa el prorrateo
   directamente. Sigue separada de Fase 1 porque es una pieza aparte
   (llamada adicional, lógica de prorrateo, disclaimer en UI) que no
   bloquea al resto del esquema, y conviene validar el bloque duro
   (100% confirmado) antes de sumar la complejidad de una estimación.

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

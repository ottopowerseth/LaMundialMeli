# Estado — Pestaña Métricas y pendientes (ml-tracker)

**Última actualización:** 2026-09-29 (IVA en cálculos de margen, envío por unidad, fix de COGS×unidades, Costo máx./Precio equilibrio en la tabla por producto)

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
   (a diferencia de `/orders/search`, que sí lo tolera), y además **no acepta
   más de 1 id por llamada** (`ids=id1,id2` da 400 explícito "maximum amount
   of items to query is 1") — no hay forma de batchear visitas, hay que
   seguir 1 request por publicación.
   El cap de fecha vive en un helper único, **`hastaEfectivo(hasta)`**
   (`hastaEfectivo = min(hasta, ahora)`), usado por esta sección y por la
   Tabla por producto (sección 8) — única fuente de verdad para este gotcha
   en todo el endpoint. No se aplica en `rangoFechas()` ni en el resto de
   las secciones — para el período "mes" en curso, el `hasta` real (usado
   por Ventas/Auditoría/Ads) sigue siendo el primer día del mes siguiente.
   Se olvidó reutilizar este helper una vez (Fase C, ver historial de
   commits) — cualquier llamada nueva a Visits debe usarlo, no repetir el
   cálculo inline.
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
   tabla de campañas con: estado, estrategia, `acos_target`, presupuesto
   diario, **uso de presupuesto** (cálculo propio, ver gotcha abajo), clics,
   impresiones, CTR, CPC, costo, montos directo/indirecto, ROAS, ACOS,
   unidades y monto orgánicos *(campos ampliados — commit `4a173e6`)*.
   **Gotcha (no es de código):** el bloqueo inicial para implementar esta
   sección no fue técnico — el scope **"Publicidad de un producto"** estaba
   en **"Sin acceso"** en el DevCenter de la aplicación. Hubo que cambiarlo a
   **"Lectura"** y volver a autorizar la app (re-consentimiento OAuth) para
   que emitiera un token nuevo con ese permiso — el token viejo no lo
   adquiere solo con el cambio de scope en el panel.
   **Gotcha (fechas, al revés que Visits):** este endpoint SÍ tolera
   `date_to` en el futuro — no aplicar el cap de `hastaEfectivo` acá.
   **Uso de presupuesto** (`usoPresupuesto = costo del período / (daily_budget
   × días TRANSCURRIDOS))` — no días del período completo. Bug encontrado y
   corregido (commit `8b3b280`): al principio se usaba `(hasta - desde)` sin
   capear, que para "mes" en curso son 30 días (mes calendario completo,
   incluyendo días futuros que todavía no gastaron nada) — daba 84.8% en vez
   del ~98% real. Fix: usar `hastaEfectivo(hasta)` (mismo helper de Visits,
   por una razón distinta — no es que la API lo rechace, es que el cálculo
   estaba mal planteado).
   **Campaña sin metadata (`338628484`):** existe una 3ra campaña, vista solo
   indirectamente vía el `campaign_id` de sus ítems en `/ads/search` (503
   ítems, marca "Issue", `catalog_listing`, mayormente `idle`/`hold`) — no
   aparece en `/campaigns/search` y `GET /product_ads/campaigns/{id}` por id
   directo da 404 explícito (no existe endpoint de metadata propia). Costo,
   clics e impresiones = 0 en el período probado (2026-09). Decisión
   (2026-09-26): no incluirla en `inversionTotal`/`roasAgregado` mientras
   siga en cero — no hay nada que ganar y no hay forma de mostrarla como fila
   de campaña sin metadata. Si en algún sync futuro aparece con costo > 0,
   tratarla ahí como "campaña sin metadata, solo agregados".
7. **Ranking de productos + Comparación de período** *(commit `83e4497`)*
   — ver detalle abajo.
8. **Tabla por producto** *(nuevo — commit `bd8d412`, fixes `351562c`/`8b3b280`)*
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

### 8. Tabla por producto

**Commits:** `bd8d412` (feature) + `351562c`, `8b3b280` (fixes) — todos del
2026-09-26.

Filas: unión de top 50 por ventas del período (`TABLA_PRODUCTOS_TOP_VENTAS`)
y todo ítem con costo de ads > 0 en el período — así no se pierde ningún
producto que ya tiene inversión activa aunque no esté en el top de ventas.
Columnas por fila: ventas $/unidades, visitas, conversión, stock, Full
sí/no, precio, Costo/margen % (desde Sheets, `null` si no hay Costo
cargado — nunca 0% ni NaN), campaña, estado del anuncio, y métricas de ads
por ítem (clics, impresiones, CTR, CPC, costo, ACOS, ROAS).

**Fuente de las métricas de ads por ítem:**
`GET /marketplace/advertising/{site}/advertisers/{id}/product_ads/ads/search`
— mismo grupo de endpoints y parámetro `metrics=` que la sección ROAS, pero
a nivel `item_id` en vez de campaña.
**Gotcha:** el parámetro `campaign_id` en la query se **ignora
silenciosamente** (mismo patrón que el filtro de fecha roto de Reclamos,
sección 5) — confirmado probando los 2 ids reales y sin filtro: siempre
devuelve el mismo total paginado. Hay que traer todas las páginas y
filtrar por el `campaign_id` que trae cada resultado, client-side.
Verificado por consistencia: sumando costo/clics/impresiones de los ítems
de una campaña, el total calza con el agregado de esa campaña (diferencia
<0.3%, dentro del margen de redondeo).

**Etiquetas automáticas** (umbrales como constantes comentadas en el
código — `TABLA_PRODUCTOS_TOP_VENTAS`, `STOCK_BAJO_DIAS_COBERTURA`,
`ACOS_REVISAR_MARGEN_RELATIVO`):
- **Candidato** — top ventas, sin campaña activa, stock en Full, conversión
  ≥ mediana de la tabla (mediana calculada solo sobre filas con visitas > 0,
  para no sesgar con "sin datos" tratado como 0% de conversión).
- **Revisar** — ACOS de la campaña del ítem por encima de su `acos_target`
  con un 20% de margen relativo, o costo de ads > 0 con cero ventas
  atribuidas (roas = 0).
- **Stock bajo** — en campaña activa, con menos de `STOCK_BAJO_DIAS_COBERTURA`
  días de cobertura al ritmo de ventas del período. Requiere ventas > 0 en
  el período para estimar velocidad — un ítem con 0 ventas no se etiqueta
  aunque tenga poco stock (no hay forma de distinguir "stock bajo" de "sin
  rotación" sin ese dato). Verificado con datos reales: 0 candidatos para
  esta etiqueta en la cuenta al momento de implementarla (ningún ítem en
  campaña activa bajaba de 41 días de cobertura) — no es un umbral roto,
  es que la cuenta no tiene hoy ningún caso real.

**Bug encontrado y corregido antes del push (`351562c`, `8b3b280`):** la
llamada a `/items/{id}/visits` dentro de esta sección no usaba el cap de
`hastaEfectivo` (mandaba el `hasta` real, futuro para "mes" en curso) — la
API la rechazaba con 400 y el `catch` silencioso dejaba `visitas=null` en
**todas** las filas sin ningún error visible. Efecto en cascada: mediana de
conversión = `NaN` → la etiqueta "Candidato" nunca se disparaba (0 siempre,
sin importar los datos reales). Se extrajo el helper `hastaEfectivo` (ver
sección 3) como única fuente de verdad. Verificado post-fix contra datos
reales: 8-9 candidatos reales con conversión 6%-26% (mediana ~5.4%).

**Viabilidad medida con llamadas reales:** la tabla agrega ~7s sobre el
resto del endpoint (paginación de `/ads/search` + visitas con concurrencia
8 + batch stock/Full de 20 + lectura de Sheets para Costo/Precio) — total
~17-33s en corridas reales (dev y producción), con margen holgado contra
el límite de 60s de Vercel Hobby. Se descartó separar en endpoint aparte
por este motivo.

## IVA en los cálculos de margen (2026-09-29)

**Confirmado con datos reales de la Billing API:** todo lo que ML reporta
viene **bruto** (con IVA incluido) — `transaction_amount` (precio de
venta), comisión (`CV`) y envío (`CXD`/`CFF`). Verificado indirectamente:
la comisión calculada sobre el precio bruto da tasas redondas conocidas
(11%, 13%); calculada sobre precio neto no da números redondos. **Costo**
(columna F de Publicaciones) es **neto** — confirmado por Otto, es la
misma base que usa la lista de precios del proveedor. La Billing API **no
expone ningún campo de impuesto explícito** (búsqueda exhaustiva de
`tax`/`iva`/`net`/`gross` en el esquema completo: 0 resultados) — el ajuste
de IVA es indispensable inferirlo, no viene resuelto por la API.

**Constante `IVA = 0.19`**, exportada desde `lib/rentabilidad.ts` (junto a
`getComisionPct`, movida ahí desde `ml-sync/route.ts` para no duplicarla),
usada en los 3 lugares que calculan margen: `calcularFilaOrden` (hoja
Rentabilidad), la fórmula de Ganancia/Margen% de `ml-sync` (hoja
Publicaciones — Precio y Envío manual también son brutos, Envío manual
confirmado por Otto que se carga en bruto), y `calcularTablaProductos`
(columna Margen% de la tabla por producto). Patrón: llevar
precio/comisión/envío a neto (÷1.19) antes de restar el Costo; los campos
crudos que persisten en Sheets (`precioVenta`, `comision`, `envio`) NO se
tocan — siguen guardando el monto bruto real que ML cobró, útil como
referencia auditable.

**Impacto medido:** sin este ajuste, el sistema comparaba un Costo neto
contra montos brutos, inflando el margen reportado en hasta 14 puntos
porcentuales en casos reales.

## Costo de envío — hallazgos de la investigación de rentabilidad (2026-09-29)

**El envío se cobra por unidad DE DESPACHO, con tarifa constante por
ítem — confirmado 2026-09-30, ver sección "Envío Full/xd_drop_off" más
abajo para el detalle completo.** Investigando por qué el mismo producto
(Aer Brisa Marina, mismo peso/precio que Aer Rosas) mostraba envíos
promedio muy distintos ($886 vs $3.729), se encontró que los valores de
envío observados en una muestra amplia son múltiplos casi exactos de una
tarifa base (ej. $799,4 × 1, 2, 3, 4...). **Confirmado con
`/shipments/{id}/costs`:** el multiplicador es la cantidad de unidades
TOTALES del despacho (`shipping_items[].quantity` sumado, que puede incluir
más de una orden cuando varias comparten `pack_id`), no `item_amount` de
un solo ítem — dividiendo el costo real del despacho por esas unidades
totales, la tarifa por unidad resultó **perfectamente constante por ítem**
(`mín = mediana = máx` en 15 de 15 ítems probados del top 20: Aer $799,4,
Elvive $410, Dove/Petrizzio $260, Fijador $1.000, Plaisance $1.020). El
peso/dimensiones del producto tampoco correlaciona con el envío (un ítem
de 100g y uno de 1.320g tienen envíos similares) — la tarifa depende del
ítem, no del despacho ni de la región.

**`logistic_type` sí importa, pero la cifra "Full 55% más barato" NO ES
CONFIABLE — ver sección "Envío Full/xd_drop_off", punto de no
confiables.** Envío promedio $2.423 en **Full** vs $3.748 en envío
estándar, medido sobre 36 ítems del top 50, mezclaba: (a) épocas previas y
posteriores al cambio a Full de cada publicación, y (b) el sesgo de
despachos compartidos que infla el envío "Full" 2-3× en varios ítems (ver
más abajo). No usar esta cifra hasta que ambos se corrijan.

**"0 órdenes multi-producto" es correcto por ORDEN, no por DESPACHO —
matiz añadido 2026-09-30.** Confirmado en todo el histórico (julio-
septiembre 2026, ~1.020 filas de Rentabilidad): ninguna orden individual
tiene más de un `order_item` (`/orders/{id}.order_items.length` siempre
1, verificado sobre 286 órdenes). Pero varias órdenes SEPARADAS (cada una
de 1 producto) pueden compartir `pack_id` y ser despachadas juntas en un
solo `shipment` — en ese caso, Rentabilidad hoy asigna el costo TOTAL del
despacho compartido a CADA orden hermana por separado, en vez de repartirlo
proporcionalmente. Ver sección "Envío Full/xd_drop_off" para el detalle y
el diseño del fix (no implementado). La conclusión de que La Mundial "no
tiene volumen de carritos con productos distintos en la misma orden" sigue
siendo correcta en el sentido estricto (por `order_id`) — la rama
`multiItem` de `calcularFilaOrden` sigue existiendo como salvaguarda, no
como caso activo. Lo que no estaba cubierto es el caso de varias órdenes
de 1 producto compartiendo despacho, que si afecta el envío calculado.

**Envío por unidad, no envío total de la orden (commit `77fc54e`):** el
CXD/CFF que trae la Billing API es el total de LA ORDEN completa — con
`item_amount>1` (mismo producto, varias unidades en una orden, confirmado
~17% de las órdenes en una muestra real), ese total no es directamente
"envío del ítem". `calcularFilaOrden` ahora captura `item_amount` y calcula
`envioPorUnidad = envio / unidades`, persistido en 2 columnas nuevas al
FINAL de la hoja Rentabilidad (N: Unidades, O: Envío por Unidad) — no en
medio, para no correr los índices que ya leen la hoja por posición.
**Limitación de `77fc54e` identificada 2026-09-30:** ese fix divide el
envío de Billing por `item_amount` de ESTA orden, asumiendo que el `envio`
de Billing corresponde solo a esta orden — correcto cuando la orden va
sola en su despacho, pero incorrecto cuando varias órdenes comparten
`pack_id`/despacho (ver sección "Envío Full/xd_drop_off" más abajo, punto
h): en ese caso el `envio` de Billing ya es el costo del despacho
COMPLETO, no de una sola orden, y dividirlo por el `item_amount` de una
sola orden infla el resultado tantas veces como órdenes hermanas haya.

**Bug real encontrado y corregido — COGS no se multiplicaba por unidades
(commit `91ab870`):** `costoPorItemId` trae el Costo **unitario**
(Publicaciones!F), pero `precioVenta` es el total de la orden (confirmado:
`item_price × item_amount = transaction_amount`). Con `item_amount>1`, el
margen restaba solo 1×COGS contra el precio de N unidades, inflando el
margen. Verificado con la orden real `2000017436494266` (2 unidades de
Serum Elvive Anti-caída, COGS unitario $6.350): reportaba margen **+26.2%**
con el bug — el margen real es **-18.3%**. La orden que parecía la más
rentable de toda la muestra en realidad perdía plata. Fix: `cogs =
costoUnitario × unidades`. El header de esa columna en Sheets se cambió a
"COGS Total" — **no se reescribe automáticamente el header ya existente en
la hoja** (el código solo escribe headers si la hoja está vacía), así que
la hoja real sigue mostrando "COGS" hasta que alguien la actualice a mano.

**Margen por tramo de precio, recalculado con el fix completo (COGS×unidades,
envío total de la orden — sobre los ~1.020 filas del backfill):**

| Tramo | Órdenes | Publicaciones distintas | Margen % promedio |
|---|---|---|---|
| <$10k | 88 | 5 | -44.4% |
| $10-20k | 10 | 1 | -23.7% |
| $20-30k | 25 | 2 | -14.9% a -15.0% |
| >$30k | 1 | 1 | -14.9% |

Todos los tramos dan negativo con los datos actuales — antes del fix de
COGS×unidades, los tramos $10-20k y $20-30k parecían rentables (+17% y
+13.9%). Cobertura todavía baja: solo 9 publicaciones distintas del
catálogo activo (500+) tienen Costo cargado y aparecen en estas órdenes.

## Costo máx. y Precio equilibrio en la tabla por producto (commits `38798ed`, `77fc54e`, `879d543`, `91ab870`)

Dos columnas nuevas en la sección 8 (Tabla por producto):
- **Costo máx.**: costo neto máximo que se puede pagar por el producto sin
  perder plata al precio actual de venta. Fórmula (despejada de margen=0,
  mismo criterio que `calcularFilaOrden`): `costoMax = (precio/1.19) ×
  (1 − comisión%) − (envío estimado/1.19)`. Comisión real por tipo de
  publicación (`getComisionPct`, con `listing_type_id`/`catalog_listing`
  agregados al batch de `/items?ids=` ya existente — sin llamada nueva).
- **Precio equilibrio** + etiqueta **"Pierde"**: solo para ítems con Costo
  ya cargado — precio bruto mínimo al que el margen sería 0, y bandera
  cuando `Costo > Costo máx.` al precio actual.

**Envío estimado — dos fuentes, indicadas en la propia columna:**
promedio real por unidad del ítem si existe en la hoja Rentabilidad
("envío real"), o promedio por unidad del tramo de precio si no ("envío
tramo") — mismos 4 tramos que la investigación de costo de envío
(`TRAMOS_PRECIO_ENVIO`, constante comentada). Tras el backfill completo de
Rentabilidad, la cobertura de "envío real" en el top 50 pasó de 16/50
(32%) a 33/50 (66%).

**Constantes comentadas en el código** (todas en `metrics/route.ts`):
`TABLA_PRODUCTOS_TOP_VENTAS`, `TRAMOS_PRECIO_ENVIO`,
`STOCK_BAJO_DIAS_COBERTURA`, `ACOS_REVISAR_MARGEN_RELATIVO`.

## Historial de commits relevantes

| Commit | Descripción |
|---|---|
| `66555c7` | Agregar sección ROAS/Publicidad a la pestaña Métricas |
| `3a06e35` | Corrige 3 hallazgos de la validación de Auditoría (Fase 1): validación de cobertura contra el ciclo real de facturación 15→14, fix de truncado de timestamp, `isInMonth`/`fetchReferenciaML` alineados al ciclo real |
| `2f35371` | *chore: eliminar código muerto* — `lib/mercadolibre.ts` eliminado (cliente ML redundante con `lib/ml-token.ts`, sin refresh automático, sin ningún import en el proyecto) y `@anthropic-ai/sdk` removido de `package.json`/`package-lock.json` (declarado pero nunca usado en ningún archivo) |
| `83e4497` | *feat: agregar ranking de productos y comparación de período a Métricas* — ver sección 7 arriba |
| `4a173e6` | *feat: exponer campos ROAS descartados y cancelaciones/porTipo en Métricas* — Fase A: cpc, direct_amount, indirect_amount, organic_units_quantity/amount, strategy, acos_target, daily_budget + uso de presupuesto (con bug inicial, ver `8b3b280`); reputacion.cancellations y reclamos.porTipo ya se calculaban pero no se renderizaban |
| `b855cd0` | *feat: aviso de cobertura del campo Costo en Publicaciones* — Fase F: aviso en el Log de sincronización con % de activas sin Costo (por cantidad y volumen) y top 20 sin costo por ventas |
| `bd8d412` | *feat: tabla por producto en Métricas para decidir candidatos a campaña* — Fase C, ver sección 8 arriba (con bug inicial de visitas, ver `351562c`) |
| `351562c` | *fix: capear date_to futuro en visitas de la tabla por producto* — extrae `hastaEfectivo`, corrige el bug de "Candidato" nunca se disparaba |
| `8b3b280` | *fix: uso de presupuesto con días transcurridos, no días del período completo* — corrige el 84.8% → 97.9% de "Top Ventas" |
| `1a0c521` | *fix: llevar precio/comisión/envío a neto antes de calcular margen* — constante `IVA=0.19` en los 3 lugares que calculan margen, ver sección de IVA arriba |
| `38798ed` | *feat: Costo máx. y Precio equilibrio en la tabla por producto* — ver sección dedicada arriba. `getComisionPct` movida a `lib/rentabilidad.ts` (antes duplicada en `ml-sync`) |
| `77fc54e` | *feat: envío por unidad en Rentabilidad, no envío total de la orden* — `envioPorUnidad`/`unidades` nuevas en `calcularFilaOrden`, columnas N/O al final de la hoja Rentabilidad |
| `879d543` | *fix: Costo máx. usa envío por unidad, no envío total de la orden* — `metrics/route.ts` lee la columna O en vez de recalcular desde la columna H |
| `91ab870` | *fix: multiplicar COGS por unidades en calcularFilaOrden* — bug real que inflaba el margen de órdenes con `item_amount>1`, ver sección de costo de envío arriba |

## Pendiente / sin decidir

### Tablero — decisiones y pendientes (2026-10-08)

Pestaña "Tablero" (primera): resumen de ventas, confianza de datos, margen, stock + alerta de pausadas por falta de stock, Pareto y series. Costo (519 automáticos, origen en la hoja CostoOrigen) ya escrito el 2026-10-08; la cobertura de Costo no cuenta publicaciones cerradas o inactivas sin Costo.

**Decisiones de Otto (2026-10-08)**
- Gillette Prestobarba MLC4366166348: **cerrado, costo correcto**. Es el display x28 (SKU PRO180207, GTIN 7500435180207, UNITS_PER_PACK 28); Unidades = 1 es correcto. Margen real −0,6%.
- Katteyes (18 publicaciones, Costo calculado ≈ precio de venta): **se quedan en "revisar"**, no se escribe su Costo.
- Orden de implementación: **J (completitud) → G (TACoS y ACoS de equilibrio) → F (price_to_win) → H (operación)**. I (calidad de ML) y M (campañas nuevas) quedan fuera por ahora.
- F y G: solo lectura, equilibrio y precio para ganar lado a lado, **sin sugerir acciones**, con la nota "base de IVA y costo Katteyes pendientes".
- Siguen en espera: Aer COS022114, margen en pesos, Envío (I) desde TarifaEnvio, "Mayor en revisión".

**Para el equipo de publicaciones (sin escribir en ML)**
- **Schick Quattro Titanium, MLC4485749662:** el atributo de unidades de la publicación está inconsistente con el título. El título dice "10 Unidades" pero `UNITS_PER_PACK` = 1 y `SALE_FORMAT` = Unidad; el artículo de Defontana es un cartón de 10 (SCHICK QUATTRO4 CARTON 10 UN TITANIUM) y el Costo ($7.990) parece corresponder al cartón: la hermana MLC4485749640 (Quattro For Women, "Pack X10", `UNITS_PER_PACK` = 10) tiene el mismo precio ($9.990) y el mismo Costo. Es una inferencia, no una confirmación: el equipo de publicaciones debe confirmar que se vende el cartón de 10 y corregir el atributo en ML a mano (no corregido).
- Otros dos nombres para confirmar que son el mismo producto: Paris Hilton Heiress MLC4447122436 (título "Colonia", Defontana "B MIST", es decir body mist) y S By Shakira MLC4447128692 (Defontana "SHAKIRA 50 CLASICA").

**Completitud de publicaciones (J), pusheada el 2026-10-08 (`origin/master` = `09b9b2a`)** — sección al final del Tablero, a pedido, endpoint `/api/completitud` (solo lectura). Pendiente de confirmar con el proveedor: **las categorías del bloque "a confirmar" del ISP**. Hoy son las que no están bajo la raíz "Belleza y Cuidado Personal": Accesorios para Vehículos > Limpieza de Vehículos > Aromatizadores (Aer Power Pocket, 10 publicaciones, ~$8,2 M de ingreso en 90 días), Hogar y Muebles > Cuidado del Hogar y Lavandería (perfumes para ropa, aromatizantes de hogar, detergentes, suavizantes, lavalozas, cloros) y Bebés > Toallitas Húmedas; 42 publicaciones sin ISP en total (28 con ventas en 90 días). Mientras no se confirme, el Tablero no las da por "no aplica" ni por "faltante confirmado": solo las separa. Si el proveedor confirma que alguna categoría no requiere ISP, o que alguna del bloque "a confirmar" sí lo requiere y debe pasar al bloque "esperable", el cambio es la lista `RAICES_ISP_ESPERABLE` de `lib/completitud.ts` (la separación es por categoría raíz).

**Riesgo a vigilar:** `/api/tablero` llegó a 34 s en 4 llamadas seguidas (ML frena las ráfagas de visitas; ~15 s en frío). Si en producción pasa de ~45 s, partirlo por dominios. Límite de Vercel: 60 s.

### Bug latente — `variantesCodigoAer` no genera la variante del cero (diagnosticado 2026-10-07, SIN corregir)

`variantesCodigoAer` en `lib/defontana.ts` existe para cruzar los códigos Aer:
ML usa `COS022117` y Defontana `COS0022117` (un cero más). Pero su regex
(`/^(COS)0*(\d+)$/`) consume **todos** los ceros iniciales, así que desde
`COS022117` genera solo `COS022117` y `COS0` + `22117` = `COS022117` — nunca
`COS0022117`. Verificado con datos reales: `cruzarConDefontana("COS022117"…)`
devuelve `null` para los 5 packs Aer (`COS022114`…`COS022118`), cuyo artículo
en Defontana es "PACK AER CAJA 6 UN … (WEB)" con `Mayor` = precio público.

**Impacto hoy: ninguno.** Esos packs se resuelven por la tabla de
Equivalencias (6 × el artículo suelto de $690), que es justamente lo correcto
porque el `Mayor` del pack "(WEB)" no es un costo. 0 publicaciones activas
dependen de la variante. El riesgo es futuro: si alguien borra una
equivalencia esperando que el cruce directo la reemplace, el pack quedaría sin
Costo (y, de arreglarse la variante, tomaría el precio público como costo).
No tocar sin decidir antes qué debe pasar con los artículos "(WEB)".

Pendiente relacionado: `COS022114` (MLC4111943362, pausado, ~$536.000 de
ingreso en 30 días) todavía no tiene fila en Equivalencias; a la espera de
confirmar unidades del pack y aroma.

### Auditoría — reemplazar CSV manual por la API de Facturación de ML

Ya está confirmado (investigación previa) que `/billing/integration/periods/key/{KEY}/group/ML/details`
reemplaza 100% el parseo de Facturación ML y Notas de Crédito (ambos grupos)
desde CSV/XLSX. El grupo `MP` tiene la misma contaminación de Shopify que el
CSV (ningún campo distingue canal), así que no resuelve ese problema por sí
solo. Ver commits de la Fase de validación de cobertura (`3a06e35`) para el
detalle de por qué el ciclo real de facturación es 15→14, no el mes calendario.

**Historial real limitado a 1 mes** (2026-06, triplicado en la hoja) y
calculado ANTES del fix del ciclo 15→14 (`1ea0bdc`) — el número que
muestra hoy no refleja el ciclo corregido. La variación % mes a mes
(`9aa6a0c`) está verificada matemáticamente contra datos de prueba, pero
sin validación con 2+ meses reales consecutivos todavía. **Acción
pendiente:** re-analizar 2026-06 (y subir más meses) con el ciclo
corregido para tener historial real utilizable.

**Gotcha — triplicación de la fila 2026-06:** las 3 filas no son
idénticas. Filas 1 y 2 (mismo timestamp exacto, `04-07-2026 3:52:05 p.m.`)
tienen los mismos valores (ventas $77.742.142, tasa 2.74%) — condición de
carrera clásica: 2 requests de análisis disparadas casi simultáneas
leyeron `existing` (para decidir upsert vs. append en
`app/api/audit/analyze/route.ts`) antes de que la primera terminara de
escribir, así que ambas hicieron `appendSheet` en vez de que la segunda
sobreescribiera a la primera. La fila 3 (38 min después, `4:30:09 p.m.`)
tiene datos visiblemente anómalos (ventas $1.651.272 — ~47x menor —, tasa
128.96%, imposible en un negocio real) — un tercer análisis con un archivo
mal cargado, que además volvió a caer en la misma condición de carrera
del upsert (`findIndex` por mes debería haber pisado la fila 1, pero
agregó una fila nueva). **No implementado todavía:** el upsert por mes en
`audit/analyze/route.ts` no es atómico — dos requests casi simultáneas
pueden leer el mismo estado "sin fila" y ambas hacer `append`. Mismo tipo
de problema que el de doble-invocación ya visto en Rentabilidad (Billing
API, curl timeout ≠ finalización real del server).

**Bug conocido: condición de carrera en upsert por mes.**
`app/api/audit/analyze/route.ts` hace upsert por mes leyendo `existing` al
inicio del request y luego decidiendo append vs. overwrite por
`findIndex`. Si 2 análisis del mismo mes se disparan casi simultáneos
(doble click, reintento de red, etc.), ambos pueden leer "no existe
todavía" antes de que el primero termine de escribir, resultando en filas
duplicadas para el mismo mes en vez de que la segunda sobreescriba a la
primera. Confirmado en producción: 3 filas para 2026-06 (commit `cfee265`,
hallazgo del 2026-08-24). Las filas duplicadas ya existentes no se
limpiaron a propósito; se resolverán solas cuando se re-analice ese mes
con datos reales post-fix del ciclo 15→14, momento en el que las filas
huérfanas se podrán borrar con el dato bueno confirmado al lado.

**Estado (2026-08-24): mitigado, no eliminado al 100%.** Dos capas: (a)
`AuditoriaLocks` en el backend (commit `6760353`) — reduce la ventana de
carrera de "todo el procesamiento" a "el instante de la primera
escritura", pero no la elimina, porque la API de Sheets no ofrece
compare-and-swap real (confirmado con una prueba directa: 2 llamadas a
`intentarAdquirirLock` disparadas en el mismo tick de Node ambas
obtuvieron el lock); (b) guardia del lado del cliente (`app/page.tsx`,
commit siguiente) — botón deshabilitado mientras el análisis está en
curso más una guarda síncrona (`useRef`) que no depende del re-render de
React, previene el caso real más común (doble-click humano) sin depender
en absoluto del backend. Se investigó cerrar la ventana del backend por
completo (append incondicional + relectura de confirmación) pero se
descartó por complejidad desproporcionada al caso de uso real (equipo de
2 personas, uso manual). Riesgo residual aceptado.

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

**Estado (2026-08-24):** Fase 1 implementada y en producción (commit
`bb72bcd` + fix `b589417`). Cobertura real limitada: solo 11 de 85 órdenes
con COGS calculable, causa 100% operativa — solo 7 de 400 productos en
Publicaciones tienen columna Costo cargada. Fase 2 (Ads atribuido) queda
en pausa hasta resolver la carga de costos del catálogo; no tiene sentido
construir sobre una base con <2% de cobertura. Próximo paso: cargar Costo
para el resto del catálogo, luego retomar Fase 2 según diseño ya
documentado.

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

**Órdenes multi-item — confirmado que no aplica hoy.** Verificado contra
datos reales de la Billing API (agosto, grupo ML): agrupando las filas `CV`
(comisión de venta, una por línea de producto) por su propio `order_id`
dentro de `items_info[]`, **0 de 267 órdenes reales tienen más de un
`item_id` distinto** — coincide exacto con la medición independiente vía
`/orders/search` (0 de 1000 órdenes). El diseño asume 1 item por orden
(`items_info[0]`), pero esto está **verificado, no asumido implícitamente**:
si en el futuro aparece un caso real, la implementación debe marcar
explícitamente la fila como multi-item (no calcular un margen tomando solo
el primer producto en silencio) en vez de prorratear a ciegas sin volver a
confirmar el volumen real.

**Gotcha descubierto al medir esto**: agrupar por `sales_info[0].order_id`
en vez de por el `order_id` propio de cada `items_info[]` da un falso
positivo — los cargos `CXD` (envío) a veces traen `items_info[]` con
`order_id` de **múltiples órdenes distintas que comparten el mismo
`pack_id`** (compras separadas del mismo comprador que ML agrupa en un solo
despacho/envío). Agrupar mal por `sales_info[0].order_id` dio 18.35% de
"multi-item" (falso), agrupar correctamente por el `order_id` dentro de
`items_info[]` dio 0%. Cualquier código que procese `items_info[]` de un
cargo `CXD`/`CFF` debe usar el `order_id` que trae cada item, nunca asumir
que `sales_info[0].order_id` aplica a todos los items de esa fila.

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

**Gotcha (Fase 1, implementado):** `Margen neto` con precisión de punto
flotante — la resta encadenada de floats (`precioVenta - cogs - comision -
envio - perdida`) puede arrastrar imprecisión de base 2 (ej.
`-1583.3000000000002` en vez de `-1583.3`). Al escribir ese número con
muchos dígitos vía `USER_ENTERED` en Sheets, se reinterpreta mal (aparente
error de separador de miles), corrompiendo el valor guardado (ej.
`-15.833.000.000.000.000`). Detectado auditando manualmente los resultados
contra datos reales — no se ve en pruebas superficiales porque solo
aparece con ciertas combinaciones de decimales. **Fix:** redondear
(`Math.round(x * 10) / 10`) antes de convertir a string. Aplica a
cualquier cálculo futuro que escriba montos calculados directamente a
Sheets, no solo Rentabilidad.

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

### Fases B, D, E — pendientes (roadmap de revisión periódica y decisión de campañas)

Ver investigación completa del 2026-09-26 (Fases A/C/F ya implementadas,
secciones 6 y 8 arriba). Quedan 3 fases del roadmap original sin implementar:

**Fase B — Comparación de período anterior en todas las secciones.**
Hoy solo Ventas la tiene (`rangoAnterior`/`calcularVariacionPct`/
`VariacionBadge`, ya reutilizables — ver sección 7). Extenderla a
Reputación, Visitas, Preguntas, Reclamos y ROAS es aplicar el mismo patrón
ya validado, sin investigación nueva pendiente. Da contexto de tendencia
para revisión periódica (ej. "reclamos +40% vs. mes anterior").

**Fase D — Botón "Exportar para revisión".** Formato texto compacto (no
JSON) pensado para pegar en un chat: todas las métricas del período +
comparación con el período anterior equivalente (depende de que Fase B
esté lista para todas las secciones, no solo Ventas) + la tabla por
producto (sección 8, ya implementada). Diseño de formato ya propuesto en
la investigación del 2026-09-26 — falta implementar el ensamblado y el
botón en la UI.

**Fase E — Tabla por producto completa (519 activas, no solo top 50).**
La Fase C (sección 8) cubre top 50 por ventas + ítems con costo de ads > 0
— deja afuera "candidatos ocultos" (buena conversión, pocas ventas
históricas, fuera del top). Cubrir las 519 publicaciones activas no cabe
en el mismo request de `metrics/route.ts` sin arriesgar el límite de 60s
(519 llamadas a `/items/{id}/visits`, 1 por ítem, sin batch posible — ver
gotcha de la sección 3). **Solo implementar si la Fase C, en uso real,
demuestra que deja afuera candidatos que sí importan** — si el top 50
alcanza para las decisiones de campaña de Otto, no vale el esfuerzo de un
endpoint separado (`/api/tabla-productos`, maxDuration 60 propio) solo para
cubrir el resto del catálogo.

## Envío Full/xd_drop_off — gotchas y hallazgos de la investigación 2026-09-30

Investigación read-only sobre por qué el Comparador vs Mayor mostraba
envíos por unidad muy dispares dentro del mismo ítem (Aer Brisa Marina:
$0 a $7.888). Varias conclusiones corrigen o matizan lo asumido hasta
ahora — documentadas acá antes de tocar código, sin implementar ningún fix.

**(a) `logistic_type` vacío/null NUNCA se trata como `xd_drop_off` en el
código.** `ml-sync/route.ts` y `backfill-shipping/route.ts` escriben
`data.logistic_type ?? ""` en ShippingCache — cadena vacía significa "la
API no devolvió el dato", nunca se confunde con xd_drop_off al escribir.

**(b) El Comparador y Métricas usan el `logistic_type` ACTUAL de la
publicación, no el histórico real por venta — y ShippingCache no se lee
en ningún endpoint de producción.** `armarMuestrasEnvio()`
(`lib/envio-estimado.ts`) arma el balde `porTramoYLogistico` clasificando
cada fila de Rentabilidad según el `shipping.logistic_type` que tiene la
publicación **hoy** (vía `/items` batch), no el logistic_type real que tuvo
esa venta en particular. ShippingCache sí tiene el dato real por orden
(vía `/shipments/{id}`, escrito por `ml-sync` y `backfill-shipping`), pero
ningún endpoint de producción (`comparador-mayor/route.ts`,
`metrics/route.ts`) lo lee — es una fuente de datos huérfana, solo
consumida por scripts de investigación puntuales.

**(c) El backfill de ShippingCache está incompleto y sesgado hacia
ventas recientes.** Verificado sobre las 208 filas de Aer en Rentabilidad:
100 (48%) no tienen entrada en ShippingCache. Donde SÍ hay entrada,
coincide 100% con `/shipments/{id}` en vivo (no hay error de dato, solo de
cobertura) — pero la falta de cobertura sesga cualquier agregado calculado
solo sobre lo cacheado. Aparte, `/orders/search` se corta en `offset<=3000`
en scripts que no paginan hasta el final — con ~4.000+ órdenes en la
cuenta, cualquier script de investigación que recorra el histórico
completo debe paginar por ventanas de fecha, no confiar en un único loop
con tope de offset fijo.

**(d) y (i) CORREGIDO 2026-09-30 — la tarifa Full de Aer SÍ es fija
($799,4 por unidad); la variación observada era el sesgo de despachos
compartidos.** El rango $799,4-$5.689 reportado antes venía de dividir el
costo TOTAL de despachos que a veces combinan varias órdenes (ver punto h)
por las unidades de una sola orden. Corrigiendo esa división (costo real
del despacho vía `/shipments/{id}/costs` ÷ unidades REALES del despacho),
la tarifa resultó perfectamente constante: Aer $799,4 en 8/8 muestras
probadas (`mín = mediana = máx`), sin excepción. Mismo patrón confirmado
en otros 14 ítems del top 20 (Elvive $410, Dove/Petrizzio $260, Fijador
$1.000, Plaisance $1.020 — todos con `mín = mediana = máx`).

**(e) → confirmado con matices, ver (f).** Hipótesis original: el
historial de envío mezcla la época previa y posterior al cambio a Full de
cada publicación (ej. Serum Antifall: xd_drop_off hasta el 26 de julio,
Full desde el 16 de agosto, sin ventas registradas en el medio). Confirmado
con `/shipments/{id}` en vivo para ese caso puntual.

**(f) El cambio a Full ocurrió en DOS oleadas distintas, no una sola
fecha de corte.** Verificado sobre el top 50 por ventas (`primeraFull` por
ítem, resuelto vía ShippingCache + `/shipments/{id}` en vivo donde faltaba
cache):

- **Oleada temprana (12-22 de julio 2026):** las 5 variantes de Aer, Bond
  Intense Repair, Óleo Extraordinario, Dove Uv Repair, Sérum en Barra (3
  variantes), Serum Dream Liso, Óleo Nutrición.
- **Oleada tardía (15-18 de agosto 2026):** Serum Capilar Antifall,
  Fijador Infaillible, Petrizzio, Poett Suavidad, Herbal Essences (2
  variantes), Aceite Dream Long, Perfume Vendetta, Perfumante Poett, Poett
  Primavera.

Dentro de julio, para varios Aer `primeraFull` y `ultimaXd` cayeron el
mismo día — sugiere una transición gradual (días de coexistencia Full/xd),
no un corte limpio de un día para otro.

**(g) RESTAURADO 2026-09-30 — "el envío se cobra por unidad DE
DESPACHO, tarifa constante por ítem".** La corrección del 2026-09-30
("NO CONFIRMADO", ver historial de esta sección) se basó en una mala
lectura propia: la orden de Brisa con `item_amount=2` que parecía "cobrar
1× en vez de 2×" en realidad cobró 2× en total ($1.598,8, verificado con
`/shipments/{id}/costs`) — dividido por las 2 unidades da $799,4 por
unidad, que es exactamente la tarifa esperada, no una anomalía. Retirada
la duda: la tarifa por unidad SÍ es constante por ítem — ver (d)/(i) y (h).

**(h) CORREGIDO 2026-09-30 — el múltiplo de $799,4 no es un despacho
compartido "de una sola orden que se lleva todo": son ÓRDENES SEPARADAS
QUE COMPARTEN PACK Y DESPACHO, y cada una se lleva el costo TOTAL por
separado.** La investigación anterior (`/packs/{pack_id}` + `sibling_id`
sobre 9 órdenes con envío no-múltiplo-limpio) concluyó que no había
despacho compartido porque miró packs con una sola orden — pero no probó
el caso real. Verificado ahora con el caso completo: 3 órdenes separadas
(`2000017565265218`, `2000017565272130`, `2000017565265220`), cada una de
1 solo producto (Aer de colores distintos), comparten un mismo `pack_id` y
fueron despachadas juntas en un solo `shipment` (3 `shipping_items`,
`/shipments/{id}/costs` → `senders[0].cost=$2.398,2`, exactamente 3×
$799,4). **Las 3 órdenes SÍ aparecen en Rentabilidad — ninguna falta — pero
las 3 muestran el mismo `envioPorUnidad=$2.398,2` (el costo total del
despacho), en vez de $799,4 cada una.** Sumando las 3 filas de
Rentabilidad se contabilizan $7.194,6 de envío cuando el costo real pagado
a ML fue $2.398,2 — una sobre-contabilización de 3×. Este es el mecanismo
real detrás de toda la variación "$0 a $5.689" documentada en los puntos
(d)/(i) de versiones anteriores de esta sección: despachos con 1, 2, 3+
órdenes hermanas compartiendo `pack_id`, cada orden cargando el total en
vez de su parte.

Nota: "0 órdenes multi-producto" (una orden con varios `order_items`)
sigue siendo correcto — verificado sobre 286 órdenes (100 de muestra + las
208 de Aer), ninguna tiene `order_items.length > 1`. El problema no es una
orden con productos mezclados; es varias órdenes de 1 producto cada una
compartiendo despacho. Ver sección "Costo de envío" más arriba, donde se
corrigió la frase original.

**El caso de $0 en Rentabilidad sigue siendo válido como hallazgo
separado** (documentado en versiones anteriores de este punto h): el
shipment de una orden con $0 puede tener costo real según ML, pero la
Billing API no generó fila CXD/CFF vinculable a esa orden (~66% de las
filas CXD/CFF de un mes típico no traen `items_info`). Un $0 puede ser
dato faltante, no envío gratis — eso no cambia con esta corrección.

**Diseño del fix (no implementado) — ver "Diseño del fix de envío
compartido" al final de esta sección.**

**Nota sobre `/orders/search?pack_id=`:** ese filtro es ignorado
silenciosamente por la API (devuelve resultados que ni siquiera incluyen
la orden de origen) — mismo tipo de gotcha ya documentado con
`campaign_id` en Product Ads. Para verificar órdenes de un mismo pack, usar
`/packs/{pack_id}` directo, no `/orders/search`.

**Medición de impacto de una ventana de fecha reciente (sin implementar):**
sobre 9 de los 10 ítems Aer/Dove/Serum del top 20 (uno sin match en el
Comparador), comparando la mediana histórica completa vs. una ventana de
45 días (ampliando de a 30 hasta 5 muestras), el vs Mayor mejora de forma
consistente en todos los casos — ej. Serum Antifall pasa de -44,1% a
+0,4%; Bond Intense Repair pasa de -10,6% a +23,2%. Un tercer criterio
("solo ventas con el logistic_type actual del ítem, según ShippingCache")
resultó el menos usable hoy: 5 de 9 ítems quedaron sin ninguna muestra por
la cobertura incompleta de ShippingCache (ver punto c), y los que sí
tuvieron dato se apoyaron en n=1 a n=3 muestras, poco confiables. Pendiente
de decisión de Otto si implementar la ventana de fecha — no implementado
en este commit.

### Cifras NO CONFIABLES hasta que se corrija el envío de despachos compartidos (2026-09-30)

Con el mecanismo del punto (h) confirmado (varias órdenes de un mismo
pack cargan el costo total del despacho por separado), **las siguientes
cifras están infladas y no deben usarse para decisiones hasta corregirse**:

- **"Full 55% más barato que xd_drop_off"** ($2.423 vs $3.748) — ya
  marcada provisional más arriba, doblemente no confiable: mezcla épocas
  y sufre el sesgo de despacho compartido.
- **Sobrecosto estimado de xd_drop_off vs Full (~$60.000, investigación
  previa)** — calculado sobre envíos Full ya inflados por el sesgo de
  despacho compartido; el sobrecosto real probablemente es mayor (la
  mediana Full de referencia estaba sobreestimada).
- **Margen por tramo de precio** (sección "Costo de envío", tabla con
  tramos <$10k -44,4%, $10-20k -23,7%, $20-30k -14,9% a -15,0%, >$30k
  -14,9%) — calculada con `calcularFilaOrden` sobre el envío tal como
  está guardado hoy en Rentabilidad (inflado en despachos compartidos).
  El margen real es probablemente mejor que lo mostrado, en un grado que
  no se puede estimar sin recalcular fila por fila.
- **Costo máx. y Precio equilibrio (Tabla por producto, Fase C)** — usan
  la misma `calcularEnvioEstimadoPorUnidad()` que el Comparador. Ejemplo
  verificado: para Aer con envío inflado a $3.197,6, Costo máx. muestra
  $1.714; con el envío real $799,4, Costo máx. debería ser $3.729 —
  subestimado en ~$2.015. El campo "pierde" (Costo > Costo máx.) puede
  estar marcando falsos positivos para ítems en despacho compartido.
- **vs Mayor del Comparador, para cualquier ítem cuyas ventas recientes
  hayan salido en despacho compartido** — verificado en 12 de 15 ítems
  Aer/Dove/Serum/Elvive del top 20 con datos Full: diferencia de +6 a
  +61 puntos porcentuales entre el vs Mayor actual y el corregido (ej.
  Petrizzio Óleo Capilar: -54,4% actual vs +6,6% corregido; Serum
  Antifall: -44,1% actual vs +0,4% corregido). **Aclaración sobre qué
  significa el número:** "vs Mayor +7,2%" (caso Aer recalculado) NO es
  margen de ganancia — es cuánto más deja el Neto ML por unidad
  comparado con el precio Mayor (costo de referencia de Defontana). Un
  +7,2% significa que ML deja un 7,2% MÁS que el Mayor, no que el margen
  sobre el precio de venta sea 7,2%. Ver `vsMayorPct` en
  `comparador-mayor/route.ts` para la fórmula exacta.

### Diseño del fix de envío compartido (propuesto 2026-09-30, NO IMPLEMENTADO)

Por orden nueva (en `ml-sync`/`backfill-shipping`, donde ya se resuelve
`/shipments/{id}` para `logistic_type`):

1. `shippingId` de `order.shipping.id` (ya se obtiene hoy).
2. `/shipments/{shippingId}` → ya se llama hoy; ampliar el uso para leer
   `shipping_items[]`.
3. Unidades de ESTA orden: buscar en `shipping_items[]` el ítem con
   `order_id` igual al de esta orden (campo no siempre presente en la
   práctica, verificado — cuando falta, usar `item_amount` de Billing
   como fallback, el mismo valor que ya se usa hoy).
4. Unidades TOTALES del despacho: `shipping_items[].reduce((s,it) =>
   s+it.quantity, 0)`.
5. `/shipments/{shippingId}/costs` → `senders[0].cost` = costo total real
   del despacho (endpoint verificado, status 200, coincide exactamente
   con Rentabilidad cuando no hay despacho compartido).
6. `envioDeEstaOrden = costoTotal × (unidadesEstaOrden / unidadesTotales)`.
   `envioPorUnidad = costoTotal / unidadesTotales` (constante entre
   órdenes hermanas de un mismo pack, confirmado — ver (d)/(i)).
7. Guardar en ShippingCache ampliado (2 columnas nuevas al final, mismo
   patrón ya usado para no correr índices existentes): costo total del
   despacho y unidades totales del despacho.
8. Si `/shipments/{id}/costs` falla: usar el envío ya calculado hoy desde
   Billing como respaldo, marcado explícitamente (ej. columna "Fuente
   Costo") para poder identificar después qué filas quedaron con el
   método menos preciso.

**Despachos que mezclan ítems de distinta tarifa** (ej. Aer $799,4 +
Elvive $410 en el mismo pack): el reparto proporcional a unidades NO
alcanza en ese caso — infla el ítem barato y subestima el caro. Mejor
ponderar por la tarifa individual conocida de cada ítem cuando esté
disponible (de la propia mediana histórica en `envio-estimado.ts`):
`envioDeEstaOrden = costoTotal × (tarifaEsteItem × unidadesEsteItem) /
Σ(tarifaCadaItem × unidadesCadaItem)`. Si algún ítem del despacho no
tiene tarifa conocida (publicación nueva), cae al reparto proporcional
simple. **No verificado con datos reales cuán frecuente es este caso
mixto** — los 3 casos de pack compartido encontrados eran todos Aer con
Aer (misma tarifa); antes de implementar el reparto ponderado, medir
cuántos despachos reales mezclan ítems de tarifa distinta.

**Prueba manual del cálculo, sobre casos reales (sin implementar código,
solo verificación aritmética):** las 3 órdenes hermanas del ejemplo del
punto (h) dan exactamente $799,4 cada una con esta fórmula (hoy muestran
$2.398,2 cada una). La orden con `item_amount=2` sin pack compartido
(`2000017999196484`) se mantiene en $799,4 por unidad ($1.598,8 total),
sin cambios — confirma que el fix no rompe el caso ya correcto de
múltiples unidades del mismo ítem en una sola orden.

### Plan de corrección de filas existentes (propuesto, NO EJECUTADO)

No hace falta volver a pasar por la Billing API (rate limit 5/min) — el
recálculo por orden solo necesita `/orders/{id}` → `/shipments/{id}` →
`/shipments/{id}/costs`, sin el límite estricto de Billing. Estimado:
1.020 filas × 3 llamadas = ~3.060 llamadas, ~10 minutos a un ritmo
conservador de 5 req/s (a confirmar con un lote pequeño primero, no hay
límite documentado para estos 3 endpoints). Requeriría su propio cursor
de progreso — `RentabilidadProgreso` no aplica acá porque solo rastrea el
recorrido de Billing, no el de este recálculo por Sheets.

**`RentabilidadProgreso` quedó con datos engañosos para agosto y
septiembre:** ambos meses están marcados "Completo" con offsets (650 y
375 respectivamente) muy por debajo del total actual de Billing para esos
períodos (2.489 y 3.525) — porque el período de Billing sigue acumulando
filas con el paso de los días del mes en curso, y el offset se comparó
contra el total de cuando `analyze` corrió por última vez, no contra el
total de hoy. No bloquea el recálculo de envío (que no usa
`RentabilidadProgreso`), pero sí afecta si se decide re-correr `analyze`
para cargar comisión/envío de órdenes nuevas — no hecho todavía.

**El ciclo de facturación iniciado el 15-sep tiene su propio período,
`key=2026-10-01` (2.003 filas, confirmado con `creation_date_time` del
15-sep en adelante) — Billing usa ciclos de facturación, NO meses
calendario.** El código de `analyze` arma la key como `${mes}-01` con
`mes` en formato `YYYY-MM` — eso asume alineación con el mes calendario,
que no coincide con los ciclos reales de Billing (el ciclo que arranca el
15 de un mes usa una key del mes SIGUIENTE). Esto necesita revisión
aparte antes de confiar en una re-ejecución de `analyze` para cualquier
mes — no solo para septiembre.

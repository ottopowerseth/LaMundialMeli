# Herramientas de un solo uso

Scripts escritos para dos correcciones puntuales de la planilla de producción. Se conservan como registro y para poder auditar qué se cambió. **No son parte de la aplicación**: `tsc`, `next build` y el verificador de prebuild no los recorren.

| Concern | Script | Pruebas |
|---|---|---|
| S-07: limpieza de formatos de fecha/número en 7 columnas | `limpiar-formatos-s07.mjs` | `test-limpiar-formatos-s07.mjs` |
| C-16: corrección de márgenes de Rentabilidad (J:K) | `recalcular-margen-c16.mjs` (+ `margen-c16-nucleo.mjs`) | `test-recalcular-margen-c16.mjs` |

Cada modo `--aplicar` requiere una autorización explícita y por separado. Las cifras de abajo son las de la planilla del 2026-10-14. No volver a ejecutar `--aplicar` sin una revisión nueva.

## Planes originales (en la carpeta temporal, fuera del repo; NO regenerarlos)

| Plan | Archivo | sha256 (prefijo) |
|---|---|---|
| Limpieza S-07 (2.081 celdas) | `%TEMP%\s07_plan_real.json` | `59ea21adaf840af8` |
| Recálculo C-16 previo a la limpieza (120 filas) | `%TEMP%\c16_plan_margen.json` | `a26aba19fb415181` |

El ensayo se niega a sobrescribir un plan existente: usa siempre otro nombre con `--salida=`. El nombre por defecto del plan de la limpieza (`s07_plan_limpieza.json`) no es el del original.

## Antes de cualquier aplicación

- Apagar el sync, el análisis de Auditoría, el análisis de Rentabilidad y el backfill. Los scripts se niegan si ven tickets activos de `rentabilidad:*`, `audit:*` o `ml-sync`.
- Los respaldos (pestañas duplicadas) **no se borran hasta que Otto lo diga**.
- Los tiempos indicados son **estimaciones no medidas** (por cuotas y pausas).

## Orden: limpieza → ensayo repetido → recálculo (nunca a la vez)

### A. Limpieza S-07 (primero)

1. Ensayo (ya existe el plan original; si hay dudas de que la planilla cambió, repetirlo con otra salida, p. ej. `--salida=%TEMP%\s07_plan_2.json`). Debe dar 2.081 celdas (1.348 con formato de fecha + 733 planas) y 0 ambiguas.
2. Duplicar `Rentabilidad`, `ShippingCache` y `TarifaEnvio` como `<hoja> RESPALDO S07`.
3. `node scripts/una-vez/limpiar-formatos-s07.mjs --aplicar --plan=%TEMP%\s07_plan_real.json --respaldo=S07`
4. Si falla a mitad: repetir el mismo comando con el mismo plan (salta lo ya convertido).
5. Verificar: el final debe decir «✓ Limpieza verificada» (0 fechas, mismos totales, sumas y valores mostrados).
6. Volver atrás: copiar los valores de cada pestaña de respaldo sobre su hoja real (el rollback de Vercel no deshace lo escrito en las hojas).
7. Escrituras (estimadas): 2.081 celdas en 42 lotes (42 `batchUpdate`) y 1 `batchUpdate` final con 7 `repeatCell`; unos 6 a 10 minutos.

### B. Ensayo repetido y recálculo C-16 (después de A)

1. Repetir el ensayo con la limpieza ya hecha y compararlo con el original:
   `node scripts/una-vez/recalcular-margen-c16.mjs --salida=%TEMP%\c16_plan_post_limpieza.json --comparar-con=%TEMP%\c16_plan_margen.json`
   Debe decir «IGUAL» (`a26aba19…`), con 120 filas, margen total −15.612, promedio −14,4 %, 89 negativas y 10 cambios de signo. Si dice «DIFIERE», no seguir.
2. Duplicar `Rentabilidad` como `Rentabilidad RESPALDO C16` **DESPUÉS de la limpieza y de ese ensayo repetido**. Si algo cambia después, hay que duplicar de nuevo y repetir el ensayo (el script lo detecta comparando el respaldo con el «antes» del plan).
3. `node scripts/una-vez/recalcular-margen-c16.mjs --aplicar --plan=%TEMP%\c16_plan_post_limpieza.json --respaldo=C16`
4. Si falla a mitad: repetir el mismo comando con el mismo plan.
5. Verificar: debe imprimir «IGUAL a lo acordado», «resto de la hoja sin cambios = sí», «120/120» y «un nuevo ensayo propone 0 filas»; la tarjeta de Rentabilidad debe mostrar −15.612, −14,4 % y 89.
6. Volver atrás: copiar J:K de `Rentabilidad RESPALDO C16` sobre la real.
7. Escrituras (estimadas): 120 filas (240 celdas) en 6 `batchUpdate`; unos 2 a 3 minutos con la verificación.

Hasta aplicar B no se deben ejecutar `recalcular-envio` ni `completar` (reescribirían J:K con la fórmula actual sobre el costo guardado).

## Datos reales

Las pruebas usan planillas sintéticas y una API simulada. Los planes, registros y diffs van a la carpeta temporal y nunca al repo (ver `.gitignore`).

- Pruebas: `node scripts/una-vez/test-limpiar-formatos-s07.mjs` y `node scripts/una-vez/test-recalcular-margen-c16.mjs`.

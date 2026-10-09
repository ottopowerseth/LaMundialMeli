# Arnés de respuestas grabadas

Compara el JSON COMPLETO de `/api/tablero` y `/api/metrics` entre dos versiones del código con las
mismas respuestas de ML y de Sheets. Con datos en vivo no se puede (ML pierde o repite alguna orden al
paginar y el reloj corre); con una grabación y el reloj congelado, dos corridas del mismo código dan
exactamente lo mismo, así que cualquier diferencia viene del código.

## Cómo correrlo (desde la raíz del repo, Node 24)

1. **Grabar** (solo lectura; necesita `.env.local` y un token de ML vigente en `Config`, de menos de 5 h):

   ```
   node scripts/harness/run.mjs record .
   ```

   Lee ML y Sheets una vez y guarda todo en `scripts/harness/grabaciones/` (ignorada por git). Graba con
   el código del árbol de trabajo para que la grabación incluya también las llamadas nuevas.
   No refresca el token ni escribe en ninguna hoja: cualquier intento de escritura falla.

2. **Sacar el código anterior** a una carpeta aparte:

   ```
   mkdir -p /tmp/codigo_antes && git archive <commit-anterior> app lib | tar -x -C /tmp/codigo_antes
   ```

3. **Reproducir con las dos versiones** y comparar:

   ```
   node scripts/harness/run.mjs replay /tmp/codigo_antes scripts/harness/grabaciones out_antes
   node scripts/harness/run.mjs replay .                 scripts/harness/grabaciones out_despues
   node scripts/harness/comparar.mjs scripts/harness/grabaciones/out_antes scripts/harness/grabaciones/out_despues
   ```

   `DETALLE=40 node scripts/harness/comparar.mjs ...` lista las primeras 40 diferencias con su ruta.

## Qué hay

- `run.mjs`: ejecuta `GET` de las rutas reales. Edita `SOLICITUDES` para cambiar las ventanas.
- `hooks.mjs` y `stubs/`: reemplazan `axios`, `next/server`, `@/lib/sheets` y `@/lib/ml-token` y resuelven `@/…`.
- `comparar.mjs`: diff profundo de dos carpetas de salida, agrupado por sección.

## Datos personales

Las grabaciones contienen respuestas reales de ML (apodos de compradores, ids de orden, etc.) y filas de
las hojas: **no se versionan** (`scripts/harness/grabaciones/` está en `.gitignore`). No las pegues en
issues ni en chats.

## Límites

- Solo cubre `/api/tablero` y `/api/metrics`. Otras rutas necesitarían sumar su `GET` a `SOLICITUDES`.
- Si el código nuevo hace una llamada a ML que la grabación no tiene, el replay falla con "url no
  grabada": vuelve a grabar con el código nuevo.
- Se usa el type stripping de Node 24 (sin `enum`, `namespace` ni parameter properties en los archivos que se importan).

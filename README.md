# ML Tracker — La Mundial

## Descripción
App de tracking para Mercado Libre. Sincroniza publicaciones, ventas y stock hacia Google Sheets.

## Stack
- Next.js 15 (App Router) + TypeScript + Tailwind
- Google Sheets API (base de datos)
- Mercado Libre API
- Deploy en Vercel

## Empresa
- La Mundial: distribuidora de productos de aseo personal e higiene
- Tiene ecommerce propio + 2 locales físicos
- Objetivo: retomar y potenciar canal Mercado Libre (llegó a ~20M CLP)

## Estructura
- /app/api/ml-sync → sincroniza ML hacia Sheets
- /app/api/sheets-data → lee datos desde Sheets
- /lib/mercadolibre.ts → cliente ML API
- /lib/sheets.ts → cliente Google Sheets

## Variables de entorno necesarias
- ML_CLIENT_ID, ML_CLIENT_SECRET, ML_ACCESS_TOKEN
- GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY

## Estado actual
- [x] Proyecto creado
- [x] Dependencias instaladas
- [ ] Credenciales ML configuradas
- [ ] Credenciales Google Sheets configuradas
- [ ] Dashboard construido
- [ ] Deploy en Vercel

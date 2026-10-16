# YiQi → Zentor (Dentalab)

Programa que corre en Cloudflare y envía los costos de compra de YiQi a Zentor.

- Lee los smarties de YiQi **2379** (costos en ARS) y **2380** (costos en USD), schema 328.
- Columnas usadas: `Art. SKU`, `Artículo - Nombre`, `Neto c/Dto` (costo) y `Final c/ Dto` (para calcular el IVA: 10,5% o 21%).
- Envía ARS y USD **por separado y sin conversión** a la carga de costos de Zentor, usando su servidor MCP (disponible en todos los planes).
- Corre solo cada 3 horas. También se puede correr a mano desde el panel.
- Mientras `ENVIO_ACTIVO = "no"` (en `wrangler.toml`), lee y prepara todo pero **no envía nada** a Zentor.

## Secretos (se cargan en Cloudflare, nunca en este repositorio)

| Nombre | Qué es |
|---|---|
| `CLAVE_PANEL` | Clave inventada por vos para entrar al panel |
| `YIQI_USUARIO` | Email del usuario de YiQi para la integración |
| `YIQI_CLAVE` | Contraseña de ese usuario |
| `ZENTOR_CLIENT_ID` | Lo genera la página "Conectar Zentor" |
| `ZENTOR_CLIENT_SECRET` | Lo genera la página "Conectar Zentor" |

## Páginas del panel

Al entrar se pide la clave del panel (queda recordada 30 días en ese navegador).

- `/` — panel y estado de la configuración
- `/configurar-zentor` — crea la credencial de Zentor con tu email y contraseña (no se guardan)
- `/diagnostico` — prueba YiQi y Zentor y muestra una muestra de los datos
- `/sincronizar` — corre la sincronización ahora

## Cambios

- **v1.2 (2026-10-16)** — Diagnóstico lee solo la primera página de cada smartie (límite de 50 consultas del plan gratuito de Cloudflare); se piden páginas de 500 filas (máximo de YiQi).
- **v1.1 (2026-10-16)** — El panel pide la clave en una pantalla de ingreso en vez de ponerla en la dirección.
- **v1.0 (2026-10-16)** — Primera versión: lectura de smarties ARS/USD, cálculo de IVA, envío a Zentor por MCP, panel con configuración y diagnóstico. Envío desactivado hasta validar el formato con el diagnóstico.

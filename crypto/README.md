# Altcoin Tracker · Revolut

Panel de seguimiento del portfolio de altcoins (59 posiciones, capturas de Revolut del 6-nov-2026) con análisis en
profundidad de cada moneda, alertas de compra/venta y plan de compras mensual (10.000 €/mes × 3 meses).

## Qué hay aquí

| Fichero | Qué es |
|---|---|
| `index.html` | El dashboard (HTML autónomo, sin build). Pestañas: Resumen · Recomendadas · Análisis · Alertas · Plan DCA · Candidatas · Ajustes. |
| `portfolio.json` | Las posiciones (ticker, id de CoinGecko, cantidad, precio y % de la captura). **Edítalo cuando compres o vendas.** |
| `analysis.json` | Análisis por moneda: tier (A/B/C/D), puntuación 0-100, tesis, acción, matemática del x100, catalizadores, riesgos, noticias 2026, fuentes; plan DCA y lista de ventas. |
| `ANALISIS.md` | El mismo análisis en formato documento, para leer de un tirón. |
| `RECOMENDADAS.md` | Lista única (cartera + candidatas externas + apuestas + cribado < 200 M€) con puntuación x100 común, momento de compra, precio objetivo y plan mínimo de brokers (mercados reales de CoinGecko). Pestaña **Recomendadas** del panel (`analysis.json` → `recomendadas`, `brokers`). |
| `APUESTAS-X1000.md` | Cartera de lotería: 10 apuestas de 1.000 € (x100-x1000) con probabilidades reales, reglas y escalera de ventas; 56 micro-caps investigadas. Aparecen en la pestaña Candidatas (tier L) y el worker las sigue (`analysis.json` → `apuestas_x1000`). |
| `CRIBADO-200M.md` | Cribado de altcoins con capitalización < 200 M€: 662 pasan el filtro cuantitativo, 124 investigadas en 12 lotes con la rúbrica común; las que alcanzan 65 puntos (umbral `cribado_umbral`; al principio se exigió > 70) entran en Recomendadas (grupo `cribado`), en la pestaña Candidatas y en el seguimiento del worker con alertas de tier A (`analysis.json` → `cribado_200m`, `cribado_todas`). |
| `CANDIDATAS-EXTERNAS.md` | Búsqueda de candidatas fuera de la cartera (cribado de 1.750 monedas + ingresos de DeFiLlama + 40 fichas). Las 21 con ficha aparecen en la pestaña **Candidatas** y el worker las sigue con las mismas alertas que el tier A (`analysis.json` → `candidatas_externas`, campo `seguir`). |
| `rules.js` | Indicadores (RSI, medias, mínimos 30/90/365 d) y reglas de alerta. Lo usan el dashboard y el worker. |
| `worker/snapshot.mjs` | Worker (Node 20+, sin dependencias): precios, histórico diario, indicadores, alertas, historial de valor, Telegram. |
| `data/` | Lo que escribe el worker: `snapshot.json`, `alerts.json`, `history.json` y `bundle.js` (para abrir el dashboard en local). |
| `../.github/workflows/crypto-snapshot.yml` | Ejecuta el worker cada 6 h en GitHub Actions y hace commit de `data/`. |

## Abrir el dashboard

- **Un solo archivo**: `crypto/altcoin-tracker.html` lleva embebidos `rules.js` y el último `data/bundle.js`; se abre con doble clic, se puede enviar al móvil o publicar como página. Se regenera con `node crypto/worker/build-standalone.mjs` (el workflow lo hace tras cada snapshot).

- **GitHub Pages** (recomendado, siempre actualizado): `https://raulyanezalonso.github.io/DAX40/crypto/` si Pages sirve la rama `main`
  desde la raíz (Settings → Pages → Deploy from a branch → `main` / `/ (root)`).
- **En local**: abre `crypto/index.html` con doble clic. Usa `data/bundle.js` (el último snapshot del worker) y, si hay
  conexión, pide precios en vivo a CoinGecko.

El botón **⟳ Precios en vivo** hace una sola llamada a la API pública de CoinGecko (si responde 429, espera un minuto).
Los indicadores (RSI, mínimos, medias) salen del histórico que descarga el worker; con el precio en vivo se recalculan.

## Alertas

Solo los tiers **A** y **B** generan alertas de compra; los tiers **C/D** generan alertas de venta en rebotes.

| Nivel | Condición | Qué hacer según el plan |
|---|---|---|
| L1 zona de compra | RSI14 ≤ 35, o precio a ≤ 8 % del mínimo de 90 d, o por debajo de tu objetivo manual | Tramo por alerta (25 % del mensual) |
| L2 oportunidad fuerte | RSI ≤ 30 cerca del mínimo de 90 d, o -20 % en 7 d con RSI ≤ 32; también L1 + miedo extremo (tier A) | Tramo de oportunidad (25 %) |
| L3 capitulación | -30 % en 7 d y RSI ≤ 25 | Tramo extra |
| venta (rebote) | Tier C/D: +35 % desde el mínimo de 30 d o RSI ≥ 68 | Ventana para reducir/salir |
| aviso | Caída ≥ 20 % en 24 h (revisar noticias) · RSI ≥ 75 (no comprar) | — |
| mercado | Miedo/Codicia ≤ 20 · BTC ≤ -45 % desde ATH · BTC ≤ -15 % en 7 d | Condiciones de ciclo |

Los objetivos manuales de precio se editan en la pestaña Alertas (se guardan en el navegador).

## Notificaciones por Telegram (opcional)

1. Crea un bot con `@BotFather` y copia el token.
2. Escribe al bot y obtén tu chat id (p. ej. con `@userinfobot` o `https://api.telegram.org/bot<TOKEN>/getUpdates`).
3. En el repositorio: Settings → Secrets and variables → Actions → `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID`.

El worker envía las alertas **nuevas** en cada ejecución y un resumen diario (valor del portfolio, BTC, Miedo/Codicia,
alertas fuertes).

## Clave de CoinGecko (recomendado)

La API pública limita mucho las llamadas (errores 429). Crea una clave **Demo** gratuita en coingecko.com (10.000
llamadas/mes) y guárdala como secreto `COINGECKO_API_KEY`; el worker la usa automáticamente.

## Mantener el portfolio

- Cada compra real: regístrala en **Plan DCA → Registro de compras** (efecto inmediato en el navegador) y, cuando puedas,
  actualiza `portfolio.json` (cantidad, precio, % de Revolut) para que el worker y Telegram usen los datos reales.
  En Ajustes hay un botón para exportar `portfolio.json` con las cantidades efectivas.
- Para añadir una moneda nueva: añade una línea en `portfolio.json` con su id de CoinGecko (`cg`) y, si quieres análisis, una
  entrada en `analysis.json` (`tier`, `score`, `tesis`, `accion`...). Sin entrada en `analysis.json` la moneda aparece como tier X.
- Ejecutar el worker a mano: `node crypto/worker/snapshot.mjs` (desde la raíz del repo), o en GitHub: Actions → crypto-snapshot → Run workflow.

## Aviso

Esto es análisis e infraestructura de seguimiento, no asesoramiento financiero. Las cifras proceden de CoinGecko,
DeFiLlama, informes de los protocolos y prensa de 2026 a fecha 6-nov-2026; las que no se han podido verificar se indican
en cada ficha.

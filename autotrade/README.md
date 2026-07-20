# Auto-trading — DAX Opening Trader (3 plataformas)

Tres ejecutores independientes que leen **la misma señal congelada** por el worker (`history.json`
a las 8:25) y solo operan si `p ≥ umbral`, `EV > 0` y **todas** las puertas están en verde.
Una operación al día, con TP/SL desde el primer segundo, salida por tiempo a las 10:30 y
límites duros: pérdida máxima diaria y semanal, pausa automática tras N pérdidas seguidas,
bloqueo por evento de alto impacto, festivos y kill-switch.

| Ejecutor | Dónde corre | Instrumento | Fracciona tamaño |
|---|---|---|---|
| `ig-trader.mjs` + `ig-trader.yml` | GitHub Actions (nube, PC apagado) | CFD Germany 40 (IG) | Sí (0,5 €/pt mín.) |
| `ibkr-trader.mjs` | Tu PC (gateway local encendido) | Futuro Micro-DAX FDXS (1 €/pt) | No (contratos enteros) |
| `DaxOpeningTrader.mq5` | MT5 en tu PC o VPS (~5 €/mes) | CFD DE40 del broker MT5 | Sí (lotes) |

## ⚠ Antes de nada — el orden correcto
1. **`enabled` está en `false` por defecto**: nada opera hasta que lo cambies a `true` conscientemente.
2. El backtest sintético NO avala dinero real. Aval mínimo: **≥40–60 señales reales** en el
   Histórico con acierto sostenido ≥55 % y batiendo a los benchmarks naïve.
3. Secuencia obligatoria: **DEMO/paper 4–6 semanas → tamaño mínimo real → tamaño objetivo.**
4. El kill-switch de emergencia es triple: `enabled:false`, crear un archivo `STOP-TRADING`
   en la raíz del repo, o (IG) desactivar el workflow en Actions.

## Configuración común
Copia `trade-config.json` a la **raíz del repo `dax-worker`** (junto a `capture.mjs`,
`config.json` y `history.json`) y ajusta: capital, % riesgo, umbral, spread de tu broker,
límites de pérdida. Los tres ejecutores usan los mismos criterios; cada uno lleva su registro
(`trades-ig.json`, `trades-ibkr.json`, historial del propio MT5) y **sus límites son por
plataforma**: si activas más de una a la vez, divide los límites entre ellas (o mejor: activa solo una).

## 1 · IG (GitHub Actions — funciona con el PC apagado)
1. Sube `ig-trader.mjs` y `trade-config.json` a la raíz de `dax-worker`, y `ig-trader.yml` a `.github/workflows/`.
2. Repo → Settings → Secrets and variables → Actions → New repository secret (×4):
   `IG_API_KEY`, `IG_USERNAME`, `IG_PASSWORD`, `IG_ENV` = `DEMO`.
3. Pon `"enabled": true` en `trade-config.json` (commit).
4. Prueba en demo: Actions → dax-ig-trader → Run workflow. Fuera de ventana dirá «fuera de
   ventanas — nada que hacer» (correcto). Para forzar una prueba completa un laborable por la
   mañana: edita temporalmente el paso a `node ig-trader.mjs open --force` (solo DEMO) y revierte.
5. Ciclo real: 9:05 evalúa y abre si procede · 10:31 cierra por tiempo o reconcilia TP/SL ·
   todo queda en `trades-ig.json` (committeado).
6. Paso a real (tras semanas de demo validada): cambia el secret `IG_ENV` a `REAL` y crea la API
   key de la cuenta real. Empieza con `maxEurPerPoint: 1`.

## 2 · IBKR (futuro Micro-DAX — requiere tu PC con el gateway)
1. Requisitos: cuenta IBKR + suscripción de datos Eurex + Client Portal Gateway con login
   (fase D del checklist). IBKR ofrece **cuenta paper**: úsala primero (login del gateway con el usuario paper).
2. Clona tu repo `dax-worker` en el PC y copia dentro `ibkr-trader.mjs` (los `history.json`,
   `config.json` y `trade-config.json` ya están). Haz `git pull` cada mañana (o script).
3. `node ibkr-trader.mjs find` → localiza el **Micro-DAX (FDXS, multiplicador 1)** del vencimiento
   más cercano → pega su `conid` en `trade-config.json → ibkr.conid`.
4. `node ibkr-trader.mjs status` → todo OK.
5. Cada mañana operativa: gateway abierto y `node ibkr-trader.mjs wait` desde ~8:50 (abre a las
   9:05 si procede, cierra a las 10:30). Sin PC encendido, ese día simplemente no opera.
6. Ojo con el tamaño: 1 contrato FDXS ≈ 1 €/punto → un SL de 60 pts arriesga ~60 €. El bot no
   abre si 1 contrato ya supera tu presupuesto de riesgo.

## 3 · MetaTrader 5 (cualquier broker con DE40 — ideal en VPS)
1. Abre cuenta demo en un broker MT5 con el índice DE40/GER40.
2. MT5 → Archivo → Abrir carpeta de datos → `MQL5/Experts/` → copia `DaxOpeningTrader.mq5` →
   MetaEditor → Compilar (F7): 0 errores.
3. Herramientas → Opciones → Asesores Expertos → marca «Permitir WebRequest para las URL» y añade:
   `https://raw.githubusercontent.com` y `https://nfs.faireconomy.media`.
4. Arrastra el EA al gráfico DE40 (timeframe indiferente). Ajusta inputs:
   - `InpUrlHistory` / `InpUrlConfig`: tus URLs RAW del repo `dax-worker`.
   - `InpBrokerMinusBerlin`: minutos que el reloj del broker adelanta a Berlín (brokers EET: 60;
     compruébalo comparando la hora del terminal con la de Berlín).
   - Riesgo, umbral y límite diario.
   - `InpEnabled = true` solo cuando quieras que opere.
5. Para 24/7 sin tu PC: contrata un VPS (el propio MT5 ofrece uno integrado ~15 $/mes, o
   cualquier VPS Windows ~5 €/mes) y deja el terminal abierto con el EA cargado.
6. El EA opera 9:05–9:20 Berlín, una vez al día, TP/SL nativos, cierre 10:30, y si el equity del
   día cae más que `InpMaxDailyLossEur` cierra y se bloquea hasta mañana.

## Qué NO hacen (a propósito)
- No promedian, no re-entran, no mueven el stop en contra, no operan sin señal congelada del día.
- No operan si el calendario marca evento HIGH (EUR/USD) entre ~8:40 y ~10:35.
- Si el P&L de una operación cerrada por TP/SL no puede recuperarse por API, **cuenta como
  pérdida** para los límites (conservador).

## Comprobación end-to-end (en demo)
1. Día 1, 8:25: el worker congela la señal (Actions verde, `history.json` con la fila de hoy).
2. 9:05: el ejecutor decide — mira el log: o «ABRE …» con TP/SL, o «NO OPERA · motivo exacto».
3. 10:31: cierre por tiempo o reconciliación; P&L anotado en el registro.
4. El dashboard sigue midiendo en paralelo (Histórico/Precisión real): compara lo ejecutado con
   lo previsto cada semana.

*Herramienta de análisis y aprendizaje. Operar CFD/futuros con apalancamiento conlleva alto
riesgo de pérdida; nada de esto es asesoramiento de inversión.*

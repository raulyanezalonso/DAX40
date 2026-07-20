# Worker 24/7 — DAX Opening Trader

Ejecuta la captura diaria (predicción 8:25–9:00 CET, cierre real 10:35, día completo a la mañana
siguiente) en GitHub Actions, **gratis y sin ordenador encendido**. El dashboard se sincroniza
después con un clic.

## Qué hace
- **8:25 CET (L–V)**: congela la predicción del índice (modelo *lite*: regresión 90 min con TUS β
  exportadas del dashboard) y las 40 predicciones por empresa (β × μ).
- **10:40 CET**: anota el movimiento real 9:00→10:30 del índice y de las 40.
- **Mañana siguiente**: cierra el movimiento de día completo por empresa.
- Todo queda en `history.json`, con el mismo formato que el dashboard.

> Honestidad: el worker usa un modelo *lite* (regresión calibrada + gap implícito simplificado, sin
> noticias/las 40 en vivo). Sus filas quedan marcadas `lite: true`. Cuando la pestaña esté abierta,
> la captura completa del navegador tiene prioridad y sobreescribe a la lite.

## Instalación (10 minutos, una vez)
1. Crea un repositorio **privado** en GitHub (p. ej. `dax-worker`).
2. Copia `capture.mjs` a la raíz y `capture.yml` a `.github/workflows/capture.yml`.
3. En el dashboard → módulo Histórico → **⬇ Config worker**: descarga `config.json` y súbelo a la
   raíz del repo (contiene tus β calibradas; re-súbelo cuando recalibres).
4. Repo → Settings → Actions → General → Workflow permissions → **Read and write**.
5. Prueba: pestaña Actions → `dax-capture` → *Run workflow*. Debe crear/actualizar `history.json`.
6. Copia la URL RAW de `history.json`
   (`https://raw.githubusercontent.com/TUUSUARIO/dax-worker/main/history.json` — si el repo es
   privado, usa un token de solo lectura en la URL o hazlo público si no te importa).
7. Pega esa URL en el dashboard (campo junto a **☁ Sync worker**) y pulsa el botón: fusiona el
   histórico remoto con el local sin pisar nada más completo.

## Notas
- Los crons están duplicados para cubrir horario de verano/invierno; el script se auto-descarta si
  está fuera de la ventana de Berlín, así que no hay dobles capturas.
- GitHub Actions puede retrasar un cron hasta ~15 min: la ventana de congelación (8:25–9:00) lo
  tolera.
- Alternativas si prefieres otra cosa: (a) un mini-PC/Raspberry con la pestaña abierta y la
  suspensión desactivada — captura COMPLETA, no lite; (b) un VPS de ~5 €/mes con Chrome headless.

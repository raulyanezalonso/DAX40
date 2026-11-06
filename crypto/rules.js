// Altcoin Tracker — indicadores y reglas de alerta compartidas (navegador + worker Node).
// UMD: en el navegador expone window.CryptoRules; en Node (require/import) exporta el mismo objeto.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CryptoRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- utilidades numéricas ----------
  function last(a, n) { return a.slice(Math.max(0, a.length - n)); }
  function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
  function std(a) { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); }
  function ma(closes, n) { return closes.length >= n ? mean(last(closes, n)) : null; }
  function minN(closes, n) { const s = last(closes, n); return s.length ? Math.min.apply(null, s) : null; }
  function maxN(closes, n) { const s = last(closes, n); return s.length ? Math.max.apply(null, s) : null; }
  function pct(a, b) { return (a == null || b == null || b === 0) ? null : (a / b - 1) * 100; }

  // RSI de Wilder sobre cierres diarios
  function rsi(closes, n) {
    n = n || 14;
    if (closes.length < n + 1) return null;
    let g = 0, l = 0;
    for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
    g /= n; l /= n;
    for (let i = n + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      g = (g * (n - 1) + Math.max(d, 0)) / n;
      l = (l * (n - 1) + Math.max(-d, 0)) / n;
    }
    if (l === 0) return 100;
    return 100 - 100 / (1 + g / l);
  }

  // Reduce una serie [[ts, precio], ...] (horaria o diaria) a un cierre por día UTC.
  function dailyCloses(points) {
    const byDay = new Map();
    for (const p of points) { const day = Math.floor(p[0] / 86400000); byDay.set(day, p[1]); }
    return Array.from(byDay.entries()).sort((a, b) => a[0] - b[0]).map(e => e[1]);
  }

  // Indicadores a partir de cierres diarios (el último elemento = precio más reciente)
  function computeIndicators(closes, extra) {
    extra = extra || {};
    const c = closes.filter(x => typeof x === 'number' && isFinite(x));
    if (c.length < 15) return { ok: false, n: c.length };
    const price = c[c.length - 1];
    const rets = []; for (let i = 1; i < c.length; i++) rets.push(Math.log(c[i] / c[i - 1]));
    const r30 = last(rets, 30);
    const ma20 = ma(c, 20), ma50 = ma(c, 50), ma200 = ma(c, 200);
    const sd30 = std(r30);
    const low30 = minN(c, 30), low90 = minN(c, 90), low365 = minN(c, 365);
    const high30 = maxN(c, 30), high90 = maxN(c, 90), high365 = maxN(c, 365);
    const idxLow90 = c.lastIndexOf(low90);
    return {
      ok: true, n: c.length, price,
      rsi14: rsi(c, 14),
      ma20, ma50, ma200,
      vs_ma20: pct(price, ma20), vs_ma50: pct(price, ma50), vs_ma200: pct(price, ma200),
      low30, low90, low365, high30, high90, high365,
      vs_low30: pct(price, low30), vs_low90: pct(price, low90), vs_low365: pct(price, low365),
      vs_high30: pct(price, high30), vs_high90: pct(price, high90), vs_high365: pct(price, high365),
      ret7: c.length > 7 ? pct(price, c[c.length - 8]) : null,
      ret30: c.length > 30 ? pct(price, c[c.length - 31]) : null,
      ret90: c.length > 90 ? pct(price, c[c.length - 91]) : null,
      vol30_anual: sd30 != null ? sd30 * Math.sqrt(365) * 100 : null,
      z30: (ma20 != null && sd30) ? (Math.log(price / ma20)) / (sd30 * Math.sqrt(10)) : null,
      dias_desde_min90: c.length - 1 - idxLow90,
      ath: extra.ath || null,
      vs_ath: extra.ath ? pct(price, extra.ath) : null
    };
  }

  // ---------- reglas de alerta ----------
  // ctx: { tier:'A'|'B'|'C'|'D', price, ind, change24h, fng (0-100), btcVsAth (negativo), objetivo (precio fijo opcional) }
  function evaluateCoin(ctx) {
    const out = [];
    const ind = ctx.ind || {};
    const tier = ctx.tier || 'C';
    const p = ctx.price, r = ind.rsi14, vl90 = ind.vs_low90, vl30 = ind.vs_low30, r7 = ind.ret7;
    const fear = ctx.fng != null && ctx.fng <= 20;
    const has = ind.ok;
    const acumula = tier === 'A' || tier === 'B';

    if (ctx.change24h != null && ctx.change24h <= -20)
      out.push({ nivel: 'aviso', codigo: 'caida_anomala', msg: 'Caída de ' + ctx.change24h.toFixed(1) + '% en 24h: revisa noticias antes de actuar' });

    if (acumula && has) {
      const capitulacion = r != null && r7 != null && r <= 25 && r7 <= -30;
      const fuerte = (r != null && vl90 != null && r <= 30 && vl90 <= 5) || (r != null && r7 != null && r <= 32 && r7 <= -20);
      const zona = (r != null && r <= 35) || (vl90 != null && vl90 <= 8) || (ctx.objetivo != null && p <= ctx.objetivo);
      if (capitulacion) out.push({ nivel: 'L3', codigo: 'capitulacion', msg: 'Capitulación (RSI ' + r.toFixed(0) + ', ' + r7.toFixed(0) + '% en 7d): tramo extra del plan' });
      else if (fuerte || (zona && fear && tier === 'A')) out.push({ nivel: 'L2', codigo: 'oportunidad', msg: 'Oportunidad fuerte: RSI ' + (r != null ? r.toFixed(0) : '?') + (vl90 != null ? ', a ' + vl90.toFixed(0) + '% del mínimo 90d' : '') + (fear ? ', miedo extremo en mercado' : '') });
      else if (zona) out.push({ nivel: 'L1', codigo: 'zona_compra', msg: 'Zona de compra: ' + (r != null && r <= 35 ? 'RSI ' + r.toFixed(0) : '') + (vl90 != null && vl90 <= 8 ? ' cerca del mínimo 90d (' + vl90.toFixed(0) + '%)' : '') + (ctx.objetivo != null && p <= ctx.objetivo ? ' por debajo del objetivo ' + ctx.objetivo : '') });
      if (r != null && r >= 75) out.push({ nivel: 'aviso', codigo: 'sobrecompra', msg: 'Sobrecomprado (RSI ' + r.toFixed(0) + '): no añadir ahora, espera retroceso' });
    }
    if (!acumula && has) {
      const rebote = (vl30 != null && vl30 >= 35) || (r != null && r >= 68);
      if (rebote) out.push({ nivel: 'venta', codigo: 'rebote', msg: 'Rebote (' + (vl30 != null ? '+' + vl30.toFixed(0) + '% desde mínimo 30d' : '') + (r != null ? ', RSI ' + r.toFixed(0) : '') + '): ventana para reducir/salir' });
    }
    return out;
  }

  function evaluateMarket(m) {
    const out = [];
    if (m.fng != null && m.fng <= 20) out.push({ nivel: 'L2', codigo: 'miedo_extremo', msg: 'Miedo extremo (' + m.fng + '/100): ventana histórica de compra para posiciones de convicción' });
    else if (m.fng != null && m.fng <= 30) out.push({ nivel: 'L1', codigo: 'miedo', msg: 'Miedo en el mercado (' + m.fng + '/100): condiciones favorables para DCA' });
    if (m.fng != null && m.fng >= 75) out.push({ nivel: 'aviso', codigo: 'codicia', msg: 'Codicia (' + m.fng + '/100): frena compras, considera tomar beneficios parciales en tier C/D' });
    if (m.btcVsAth != null && m.btcVsAth <= -45) out.push({ nivel: 'L2', codigo: 'btc_drawdown', msg: 'BTC ' + m.btcVsAth.toFixed(0) + '% desde máximos: zona de acumulación de ciclo' });
    if (m.btcRet7 != null && m.btcRet7 <= -15) out.push({ nivel: 'L1', codigo: 'btc_semana', msg: 'BTC ' + m.btcRet7.toFixed(0) + '% en 7 días: volatilidad alta, escalona compras' });
    return out;
  }

  // Peso de prioridad para ordenar alertas
  const PESO = { L3: 4, L2: 3, L1: 2, venta: 2, aviso: 1 };

  return { rsi, ma, dailyCloses, computeIndicators, evaluateCoin, evaluateMarket, PESO };
});

// Altcoin Tracker — worker de snapshot (GitHub Actions / Node 20+, sin dependencias).
// 1) Descarga precios, capitalización e histórico diario de cada moneda del portfolio (CoinGecko).
// 2) Calcula indicadores (RSI, medias, mínimos 30/90/365d) y evalúa las reglas de alerta (rules.js).
// 3) Escribe crypto/data/snapshot.json, alerts.json, history.json y bundle.js (para abrir el dashboard en local).
// 4) Si hay TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID, envía las alertas nuevas y un resumen diario.
// Variables opcionales: COINGECKO_API_KEY (clave Demo gratuita: evita los 429 del API público).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const Rules = require(join(ROOT, 'rules.js'));
const DATA = join(ROOT, 'data');
mkdirSync(DATA, { recursive: true });

const KEY = process.env.COINGECKO_API_KEY || '';
const CG = 'https://api.coingecko.com/api/v3';
const HEADERS = KEY ? { 'x-cg-demo-api-key': KEY, 'User-Agent': 'altcoin-tracker-worker' } : { 'User-Agent': 'altcoin-tracker-worker' };
const PACE_MS = KEY ? 2200 : 6500; // API público: ~10 llamadas/min para no recibir 429
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function readJson(p, fallback) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } }
const portfolio = readJson(join(ROOT, 'portfolio.json'), { holdings: [] });
const analysis = readJson(join(ROOT, 'analysis.json'), { coins: {} });
const prevAlerts = readJson(join(DATA, 'alerts.json'), { activas: [], historial: [] });
const prevSnap = readJson(join(DATA, 'snapshot.json'), null);
const history = readJson(join(DATA, 'history.json'), { puntos: [] });

async function jf(url, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: HEADERS });
      if (r.status === 429 || r.status >= 500) { const w = 30000 * (i + 1); log('HTTP', r.status, '→ espero', w / 1000, 's'); await sleep(w); continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
      return await r.json();
    } catch (e) { if (i === tries - 1) throw e; await sleep(5000 * (i + 1)); }
  }
}

const ids = portfolio.holdings.map(h => h.cg);
const ctxIds = ['bitcoin', 'ethereum'];

// --- 1. mercados (una sola llamada) ---
const allIds = Array.from(new Set(ids.concat(ctxIds)));
const markets = {};
for (let i = 0; i < allIds.length; i += 100) {
  const chunk = allIds.slice(i, i + 100);
  const arr = await jf(`${CG}/coins/markets?vs_currency=eur&ids=${chunk.join(',')}&order=market_cap_desc&per_page=100&page=1&sparkline=false&price_change_percentage=24h,7d,30d,1y`);
  for (const m of arr) markets[m.id] = m;
  await sleep(PACE_MS);
}
log('mercados:', Object.keys(markets).length);

// --- 2. contexto global + miedo/codicia ---
let global = null, fng = null;
try { global = (await jf(`${CG}/global`)).data; await sleep(PACE_MS); } catch (e) { log('global fail', e.message); }
try {
  const r = await fetch('https://api.alternative.me/fng/?limit=1');
  if (r.ok) { const j = await r.json(); const d = j.data && j.data[0]; if (d) fng = { valor: Number(d.value), texto: d.value_classification, ts: Number(d.timestamp) * 1000 }; }
} catch (e) { log('fng fail', e.message); }

// --- 3. histórico diario por moneda (reutiliza el snapshot anterior si es del mismo día para ahorrar llamadas) ---
const today = new Date().toISOString().slice(0, 10);
const coins = {};
for (const h of portfolio.holdings) {
  const id = h.cg, m = markets[id];
  if (!m) { log('sin mercado', id); continue; }
  let series = null;
  const prev = prevSnap && prevSnap.monedas && prevSnap.monedas[id];
  if (prev && prev.series_dia === today && prev.series && prev.series.length > 100 && !process.env.FORCE_CHARTS) series = prev.series;
  if (!series) {
    try {
      const ch = await jf(`${CG}/coins/${id}/market_chart?vs_currency=eur&days=365`);
      series = Rules.dailyCloses(ch.prices || []);
      await sleep(PACE_MS);
    } catch (e) { log('chart fail', id, e.message); series = (prev && prev.series) || []; }
  }
  // sustituye el último cierre por el precio actual para que los indicadores reflejen el momento
  const closes = series.slice();
  if (closes.length) closes[closes.length - 1] = m.current_price; else closes.push(m.current_price);
  const ind = Rules.computeIndicators(closes, { ath: m.ath });
  coins[id] = {
    id, simbolo: m.symbol.toUpperCase(), nombre: m.name, imagen: m.image,
    precio: m.current_price, mc: m.market_cap, fdv: m.fully_diluted_valuation, rank: m.market_cap_rank,
    vol24h: m.total_volume, circ: m.circulating_supply, total: m.total_supply, max: m.max_supply,
    ath: m.ath, ath_fecha: m.ath_date, vs_ath: m.ath_change_percentage, atl: m.atl, atl_fecha: m.atl_date,
    c24h: m.price_change_percentage_24h_in_currency, c7d: m.price_change_percentage_7d_in_currency,
    c30d: m.price_change_percentage_30d_in_currency, c1y: m.price_change_percentage_1y_in_currency,
    ind, series: series.slice(-400), series_dia: today
  };
}
log('monedas con histórico:', Object.values(coins).filter(c => c.ind.ok).length);

// --- 4. contexto BTC/ETH ---
const btc = markets.bitcoin, eth = markets.ethereum;
const contexto = {
  btc: btc ? { precio: btc.current_price, vs_ath: btc.ath_change_percentage, c24h: btc.price_change_percentage_24h_in_currency, c7d: btc.price_change_percentage_7d_in_currency, c30d: btc.price_change_percentage_30d_in_currency } : null,
  eth: eth ? { precio: eth.current_price, vs_ath: eth.ath_change_percentage, c7d: eth.price_change_percentage_7d_in_currency } : null,
  dominancia_btc: global ? global.market_cap_percentage.btc : null,
  mcap_total_usd: global ? global.total_market_cap.usd : null,
  mcap_24h_pct: global ? global.market_cap_change_percentage_24h_usd : null,
  fng
};

// --- 5. valor del portfolio + alertas ---
let total = 0; const valores = {};
for (const h of portfolio.holdings) {
  const c = coins[h.cg]; if (!c) continue;
  const cant = h.cantidad != null ? h.cantidad : (h.valor_eur && c.precio ? h.valor_eur / c.precio : 0);
  const v = cant * c.precio; valores[h.cg] = Math.round(v * 100) / 100; total += v;
}
const activas = [];
const mercadoAlertas = Rules.evaluateMarket({ fng: fng && fng.valor, btcVsAth: contexto.btc && contexto.btc.vs_ath, btcRet7: contexto.btc && contexto.btc.c7d });
for (const a of mercadoAlertas) activas.push({ ambito: 'mercado', id: 'mercado', simbolo: 'MERCADO', ...a });
for (const h of portfolio.holdings) {
  const c = coins[h.cg]; if (!c) continue;
  const an = (analysis.coins && analysis.coins[h.cg]) || {};
  const res = Rules.evaluateCoin({ tier: an.tier || 'C', price: c.precio, ind: c.ind, change24h: c.c24h, fng: fng && fng.valor, objetivo: an.precio_objetivo_eur || null });
  for (const a of res) activas.push({ ambito: 'moneda', id: h.cg, simbolo: c.simbolo, nombre: c.nombre, tier: an.tier || 'C', precio: c.precio, ...a });
}
activas.sort((a, b) => (Rules.PESO[b.nivel] || 0) - (Rules.PESO[a.nivel] || 0));
const key = a => a.id + '|' + a.codigo;
const prevKeys = new Set((prevAlerts.activas || []).map(key));
const nuevas = activas.filter(a => !prevKeys.has(key(a)));
const historial = (prevAlerts.historial || []).concat(nuevas.map(a => ({ ts: Date.now(), ...a }))).slice(-500);
log('alertas activas:', activas.length, 'nuevas:', nuevas.length);

// --- 6. escribir ficheros ---
const snapshot = { at: Date.now(), fecha: today, moneda: 'EUR', contexto, total_eur: Math.round(total * 100) / 100, valores, monedas: coins };
writeFileSync(join(DATA, 'snapshot.json'), JSON.stringify(snapshot));
const alerts = { at: Date.now(), activas, nuevas: nuevas.map(key), historial, ultimo_resumen: prevAlerts.ultimo_resumen || null };
if (!history.puntos.length || history.puntos[history.puntos.length - 1].fecha !== today) history.puntos.push({ fecha: today, ts: Date.now(), total_eur: snapshot.total_eur, valores });
else history.puntos[history.puntos.length - 1] = { fecha: today, ts: Date.now(), total_eur: snapshot.total_eur, valores };
history.puntos = history.puntos.slice(-730);
writeFileSync(join(DATA, 'history.json'), JSON.stringify(history));

// --- 7. Telegram (opcional) ---
const TG = process.env.TELEGRAM_BOT_TOKEN, CHAT = process.env.TELEGRAM_CHAT_ID;
async function tg(text) {
  const r = await fetch(`https://api.telegram.org/bot${TG}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }) });
  if (!r.ok) log('telegram fail', r.status, await r.text());
}
const fmt = n => n == null ? '—' : n.toLocaleString('es-ES', { maximumFractionDigits: n < 1 ? 6 : 2 });
if (TG && CHAT) {
  const relevantes = nuevas.filter(a => a.nivel !== 'aviso' || a.codigo === 'caida_anomala');
  if (relevantes.length) {
    const lines = relevantes.slice(0, 20).map(a => `• <b>${a.simbolo}</b>${a.tier ? ' [' + a.tier + ']' : ''} ${a.precio != null ? fmt(a.precio) + '€ ' : ''}— ${a.msg}`);
    await tg(`🔔 <b>Alertas nuevas</b> (${today})\n` + lines.join('\n'));
  }
  if (alerts.ultimo_resumen !== today) {
    const top = activas.filter(a => a.nivel === 'L3' || a.nivel === 'L2').slice(0, 8).map(a => `• ${a.simbolo}: ${a.msg}`);
    await tg(`📊 <b>Resumen diario</b> ${today}\nPortfolio: <b>${fmt(snapshot.total_eur)} €</b>\nBTC ${fmt(contexto.btc && contexto.btc.precio)}€ (${contexto.btc ? contexto.btc.vs_ath.toFixed(0) : '?'}% vs ATH) · Miedo/Codicia ${fng ? fng.valor : '?'}\nAlertas activas: ${activas.length}` + (top.length ? '\n' + top.join('\n') : ''));
    alerts.ultimo_resumen = today;
  }
}
writeFileSync(join(DATA, 'alerts.json'), JSON.stringify(alerts));

// --- 8. bundle para abrir index.html en local (file://) ---
const bundle = { portfolio, analysis, snapshot, alerts, history };
writeFileSync(join(DATA, 'bundle.js'), 'window.__CRYPTO_BUNDLE=' + JSON.stringify(bundle) + ';');
log('listo:', Object.keys(coins).length, 'monedas · total', snapshot.total_eur, '€ · alertas', activas.length);

// DAX Opening Trader — BOT DE EJECUCIÓN IG (CFD Germany 40) · Node 20, sin dependencias
// Lee la señal congelada por capture.mjs (history.json) + config.json + trade-config.json,
// evalúa las puertas y, solo si TODAS están en verde, abre 1 operación con TP/SL a las ~9:05
// y la cierra por tiempo a las ~10:31 si no saltó antes.
//
// Uso:  node ig-trader.mjs auto        (decide open/close según la hora de Berlín — para GitHub Actions)
//       node ig-trader.mjs open        (fuerza evaluación de apertura; añade --force para saltar ventana/eventos en pruebas DEMO)
//       node ig-trader.mjs close       (cierre por tiempo / limpieza)
//       node ig-trader.mjs status      (muestra señal, puertas y posiciones sin operar)
// Credenciales por variables de entorno (Secrets en GitHub Actions):
//       IG_API_KEY, IG_USERNAME, IG_PASSWORD, IG_ENV=DEMO|REAL
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const MODE = process.argv[2] || 'auto';
const FORCE = process.argv.includes('--force');
const cl = (v, a, b) => Math.min(b, Math.max(a, isFinite(v) ? v : a));
const r1 = v => Math.round(v * 10) / 10;
const pad = x => (x < 10 ? '0' : '') + x;
const log = (...a) => console.log('[ig-trader]', ...a);
const jread = (p, d) => { try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : d; } catch (e) { return d; } };

function berlin() {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour12: false }).formatToParts(new Date());
  const g = t => p.find(x => x.type === t).value;
  const wd = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 }[g('weekday')];
  return { y: +g('year'), mo: +g('month'), d: +g('day'), mins: +g('hour') * 60 + +g('minute'), wd };
}
const B = berlin();
const TODAY = B.y + '-' + pad(B.mo) + '-' + pad(B.d);

// ---------- estado y límites duros ----------
const TC = jread('trade-config.json', null);
if (!TC) { log('ABORTO: falta trade-config.json en la raíz del repo (plantilla en autotrade/).'); process.exit(0); }
const TL = jread('trades-ig.json', { trades: [] });
const save = () => writeFileSync('trades-ig.json', JSON.stringify(TL, null, 1));
const doneT = TL.trades.filter(t => t.closedAt);
const pnlOf = t => t.pnlEur != null ? t.pnlEur : -(t.riskEur || 0); // pnl desconocido cuenta como pérdida (conservador)
const dayPnl = doneT.filter(t => t.date === TODAY).reduce((a, t) => a + pnlOf(t), 0);
const weekMs = Date.now() - 7 * 86400000;
const weekPnl = doneT.filter(t => Date.parse(t.date) > weekMs).reduce((a, t) => a + pnlOf(t), 0);
let consec = 0;
for (let i = doneT.length - 1; i >= 0; i--) { if (pnlOf(doneT[i]) < 0) consec++; else break; }

function hardGates() {
  const g = [];
  if (!TC.enabled) g.push('trade-config.json → enabled=false (kill-switch principal)');
  if (existsSync('STOP-TRADING')) g.push('existe el archivo STOP-TRADING en el repo (kill-switch de emergencia)');
  if ((TC.blackoutDates || []).includes(TODAY)) g.push('fecha en blackoutDates (festivo)');
  if (B.wd === 0 || B.wd === 6) g.push('fin de semana');
  if (dayPnl <= -Math.abs(TC.maxDailyLossEur || 100)) g.push('límite de pérdida DIARIA alcanzado (' + r1(dayPnl) + ' €)');
  if (weekPnl <= -Math.abs(TC.maxWeeklyLossEur || 250)) g.push('límite de pérdida SEMANAL alcanzado (' + r1(weekPnl) + ' €)');
  if (consec >= (TC.maxConsecLosses || 3)) g.push(consec + ' pérdidas consecutivas — bot auto-pausado: revisa el sistema y borra/edita trades-ig.json para rearmar');
  return g;
}

// ---------- señal + puertas del modelo ----------
function evalSignal() {
  const H = jread('history.json', null), CFG = jread('config.json', {});
  if (!H || !H.siglog) return { err: 'no hay history.json — el worker capture.mjs debe correr a las 8:25 en este mismo repo' };
  const se = H.siglog.find(x => x.date === TODAY);
  if (!se || se.mu == null) return { err: 'sin señal congelada HOY (' + TODAY + ') en history.json' };
  const thresh = cl(TC.umbralProbabilidad != null ? TC.umbralProbabilidad : (CFG.thresh || 58), 52, 70);
  const sigma = Math.max(0.15, (CFG.calib90 && CFG.calib90.sd90) || 0.45);
  const tgtPct = cl(Math.abs(se.mu) * 1.6, 0.5, TC.objetivoMaxPct || 1.0);
  const stpPct = tgtPct * 0.6;
  const muDir = se.dir * se.mu;
  const u = -2 * muDir / (sigma * sigma);
  let pHit = Math.abs(u) < 1e-4 ? stpPct / (tgtPct + stpPct) : (1 - Math.exp(-u * stpPct)) / (Math.exp(u * tgtPct) - Math.exp(-u * stpPct));
  pHit = cl(pHit, 0.05, 0.95);
  const lvl = se.lvl || 24000;
  const tgtPts = Math.round(lvl * tgtPct / 100), stpPts = Math.round(lvl * stpPct / 100);
  const ev = pHit * tgtPts - (1 - pHit) * stpPts - (TC.spreadPts || 2);
  return { se, thresh, sigma, tgtPts, stpPts, ev, pHit };
}

async function eventBlock() {
  try {
    const r = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json');
    const j = await r.json();
    const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    for (const e of j) {
      if (!/high/i.test(e.impact || '') || (e.country !== 'EUR' && e.country !== 'USD')) continue;
      const d = new Date(e.date); if (isNaN(d.getTime())) continue;
      const p = fmt.formatToParts(d); const g = t => p.find(x => x.type === t).value;
      const ds = g('year') + '-' + g('month') + '-' + g('day'), mins = +g('hour') * 60 + +g('minute');
      if (ds === TODAY && mins >= 520 && mins <= 635) return e.title + ' a las ' + g('hour') + ':' + g('minute') + ' CET';
    }
  } catch (e) { log('aviso: calendario ForexFactory no disponible (no bloquea):', e.message); }
  return null;
}

// ---------- API IG ----------
const ENV = String(process.env.IG_ENV || 'DEMO').trim().toUpperCase();
const BASE = (ENV === 'REAL' ? 'https://api.ig.com' : 'https://demo-api.ig.com') + '/gateway/deal';
let CST = null, XST = null;
async function ig(path, opts) {
  const o = opts || {};
  const hdr = { 'Content-Type': 'application/json; charset=UTF-8', 'Accept': 'application/json; charset=UTF-8', 'X-IG-API-KEY': process.env.IG_API_KEY, 'Version': String(o.v || 1) };
  if (CST) { hdr.CST = CST; hdr['X-SECURITY-TOKEN'] = XST; }
  if (o.del) hdr._method = 'DELETE';
  const r = await fetch(BASE + path, { method: o.method || (o.body ? 'POST' : 'GET'), headers: hdr, body: o.body ? JSON.stringify(o.body) : undefined });
  const tx = await r.text();
  let j = null; try { j = JSON.parse(tx); } catch (e) { }
  if (!r.ok) throw new Error('IG ' + path + ' HTTP ' + r.status + ' · ' + (j && j.errorCode || tx.slice(0, 120)));
  return { j, h: r.headers };
}
async function login() {
  if (!process.env.IG_API_KEY || !process.env.IG_USERNAME || !process.env.IG_PASSWORD) throw new Error('faltan IG_API_KEY / IG_USERNAME / IG_PASSWORD (Secrets)');
  const { h } = await ig('/session', { v: 2, body: { identifier: process.env.IG_USERNAME, password: process.env.IG_PASSWORD } });
  CST = h.get('CST'); XST = h.get('X-SECURITY-TOKEN');
  if (!CST || !XST) throw new Error('sesión IG sin tokens');
  log('sesión IG creada (' + ENV + ')');
}

async function confirmRef(ref) {
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 900));
    try { const { j } = await ig('/confirms/' + ref, { v: 1 }); if (j && j.dealStatus) return j; } catch (e) { }
  }
  return null;
}

// ---------- OPEN ----------
async function doOpen() {
  const hg = hardGates();
  if (hg.length) { log('NO OPERA · límites/kill-switch:', hg.join(' | ')); return; }
  const inWin = B.wd >= 1 && B.wd <= 5 && B.mins >= 540 && B.mins <= 580; // 9:00–9:40
  if (!inWin && !FORCE) { log('fuera de ventana de apertura 9:00–9:40 Berlín (usa --force solo para pruebas DEMO)'); return; }
  if ((TC.oneTradePerDay !== false) && TL.trades.some(t => t.date === TODAY)) { log('ya hay operación registrada hoy — una al día'); return; }
  const S = evalSignal();
  if (S.err) { log('NO OPERA ·', S.err); return; }
  const se = S.se;
  const gates = [];
  if (se.p < S.thresh) gates.push('p ' + se.p + ' % < umbral ' + S.thresh + ' %');
  if (S.ev <= 0) gates.push('EV ' + r1(S.ev) + ' pts ≤ 0 tras spread');
  if (se.gap != null && Math.abs(se.gap) > (TC.gapMaxPct || 1.5)) gates.push('|gap| ' + se.gap + ' % > ' + (TC.gapMaxPct || 1.5) + ' %');
  const ev9 = FORCE ? null : await eventBlock();
  if (ev9) gates.push('evento de alto impacto en ventana: ' + ev9);
  if (gates.length) { log('NO OPERA · puertas en rojo:', gates.join(' | ')); return; }
  await login();
  const epic = (TC.ig && TC.ig.epic) || 'IX.D.DAX.IFMM.IP';
  const { j: mk } = await ig('/markets/' + encodeURIComponent(epic), { v: 3 });
  const sn = mk && mk.snapshot;
  if (!sn || sn.marketStatus !== 'TRADEABLE') { log('NO OPERA · mercado no operable:', sn && sn.marketStatus); return; }
  const spread = sn.offer - sn.bid;
  if (spread > (TC.maxSpreadPts || 4)) { log('NO OPERA · spread real ' + r1(spread) + ' pts > máx ' + (TC.maxSpreadPts || 4)); return; }
  const riskEur = (TC.capitalEur || 10000) * (TC.riskPctPorOperacion || 1) / 100;
  let size = Math.floor(Math.min(riskEur / S.stpPts, TC.maxEurPerPoint || 5) * 10) / 10;
  const minSize = (TC.ig && TC.ig.minSize) || 0.5;
  if (size < minSize) { log('NO OPERA · tamaño calculado ' + size + ' €/pt < mínimo ' + minSize + ' (sube capital/riesgo o baja el stop)'); return; }
  const dirStr = se.dir > 0 ? 'BUY' : 'SELL';
  log('ABRE ' + dirStr + ' ' + size + ' €/pt · TP +' + S.tgtPts + ' pts · SL −' + S.stpPts + ' pts · p ' + se.p + ' % · EV ' + r1(S.ev) + ' pts · riesgo ' + r1(size * S.stpPts) + ' €');
  const { j: dr } = await ig('/positions/otc', { v: 2, body: { epic, expiry: '-', direction: dirStr, size, orderType: 'MARKET', guaranteedStop: false, stopDistance: S.stpPts, limitDistance: S.tgtPts, forceOpen: true, currencyCode: 'EUR' } });
  const conf = await confirmRef(dr.dealReference);
  if (!conf || conf.dealStatus !== 'ACCEPTED') { log('ORDEN RECHAZADA:', conf ? conf.reason || conf.dealStatus : 'sin confirmación'); return; }
  TL.trades.push({ date: TODAY, platform: 'IG-' + ENV, dir: se.dir, size, entry: conf.level, tpPts: S.tgtPts, slPts: S.stpPts, riskEur: r1(size * S.stpPts), dealId: conf.dealId, openedAt: new Date().toISOString(), p: se.p, mu: se.mu, ev: r1(S.ev), closedAt: null, exit: null, pnlEur: null, reason: null });
  save();
  log('ABIERTA · dealId ' + conf.dealId + ' @ ' + conf.level);
}

// ---------- CLOSE (salida por tiempo 10:30 + reconciliación TP/SL) ----------
async function doClose() {
  const open = TL.trades.filter(t => !t.closedAt && t.platform === 'IG-' + ENV);
  if (!open.length) { log('sin operaciones abiertas registradas'); return; }
  await login();
  const { j: ps } = await ig('/positions', { v: 2 });
  const list = (ps && ps.positions) || [];
  for (const t of open) {
    const pos = list.find(p => p.position && p.position.dealId === t.dealId);
    if (pos) {
      const dirStr = t.dir > 0 ? 'SELL' : 'BUY';
      const { j: dr } = await ig('/positions/otc', { v: 1, del: true, body: { dealId: t.dealId, direction: dirStr, size: t.size, orderType: 'MARKET' } });
      const conf = await confirmRef(dr.dealReference);
      if (conf && conf.dealStatus === 'ACCEPTED') {
        t.closedAt = new Date().toISOString(); t.exit = conf.level;
        t.pnlEur = r1((conf.level - t.entry) * t.dir * t.size);
        t.reason = 'salida por tiempo 10:30';
        log('CERRADA por tiempo @ ' + conf.level + ' · P&L ' + t.pnlEur + ' €');
      } else log('cierre no confirmado — REVISA EN IG:', conf && (conf.reason || conf.dealStatus));
    } else {
      // ya no existe: la cerró el TP o el SL
      t.closedAt = new Date().toISOString();
      try {
        const { j: act } = await ig('/history/activity?from=' + TODAY + 'T00:00:00&detailed=true', { v: 3 });
        const it = ((act && act.activities) || []).find(a => JSON.stringify(a).indexOf(t.dealId) >= 0 && /clos/i.test(JSON.stringify(a)));
        const lvl9 = it && it.details && it.details.level;
        if (lvl9) { t.exit = lvl9; t.pnlEur = r1((lvl9 - t.entry) * t.dir * t.size); t.reason = 'cerrada por TP/SL'; }
        else { t.reason = 'cerrada por TP/SL (nivel no recuperado: P&L exacto en el historial IG; para límites cuenta como pérdida)'; }
      } catch (e) { t.reason = 'cerrada por TP/SL (historial IG no accesible; para límites cuenta como pérdida)'; }
      log('reconciliada:', t.reason, t.pnlEur != null ? t.pnlEur + ' €' : '');
    }
  }
  save();
}

function doStatus() {
  log('hoy', TODAY, '· Berlín', Math.floor(B.mins / 60) + ':' + pad(B.mins % 60), '· entorno', ENV, '· enabled', !!TC.enabled);
  const hg = hardGates(); log('límites:', hg.length ? hg.join(' | ') : 'todos OK', '· P&L día', r1(dayPnl), '€ · semana', r1(weekPnl), '€ · pérdidas seguidas', consec);
  const S = evalSignal();
  if (S.err) log('señal:', S.err);
  else log('señal: μ ' + S.se.mu + ' % · p ' + S.se.p + ' % (umbral ' + S.thresh + ') · TP ' + S.tgtPts + ' / SL ' + S.stpPts + ' pts · EV ' + r1(S.ev) + ' pts');
  log('operaciones registradas:', TL.trades.length, '· abiertas:', TL.trades.filter(t => !t.closedAt).length);
}

if (MODE === 'status') doStatus();
else if (MODE === 'open') await doOpen();
else if (MODE === 'close') await doClose();
else { // auto (GitHub Actions)
  if (B.wd >= 1 && B.wd <= 5 && B.mins >= 540 && B.mins <= 580) await doOpen();
  else if (B.wd >= 1 && B.wd <= 5 && B.mins >= 625 && B.mins <= 700) await doClose();
  else log('fuera de ventanas (' + B.mins + ' min Berlín) — nada que hacer');
}

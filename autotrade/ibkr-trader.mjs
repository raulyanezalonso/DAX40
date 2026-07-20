// DAX Opening Trader — BOT DE EJECUCIÓN IBKR (futuro Micro-DAX FDXS, 1 €/pt) · Node 20, sin dependencias
// Corre EN TU ORDENADOR contra el Client Portal Gateway local (https://localhost:5000) con sesión iniciada.
// Lee history.json + config.json + trade-config.json del MISMO directorio (clona tu repo dax-worker y ejecútalo dentro,
// o copia esos 3 archivos junto al script). Solo opera si TODAS las puertas están en verde.
//
// Uso:  node ibkr-trader.mjs find      (lista los futuros DAX con su conid → pega el del Micro-DAX en trade-config.json)
//       node ibkr-trader.mjs wait      (espera a las 9:05 Berlín, abre si procede, espera a las 10:30 y cierra — dejar corriendo desde ~8:50)
//       node ibkr-trader.mjs open      (evalúa y abre ahora; --force salta ventana/eventos en pruebas de PAPEL)
//       node ibkr-trader.mjs close     (cierre por tiempo: cancela órdenes hijas y aplana la posición)
//       node ibkr-trader.mjs status    (señal, puertas, posición — sin operar)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // solo para el certificado autofirmado del gateway LOCAL
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const MODE = process.argv[2] || 'status';
const FORCE = process.argv.includes('--force');
const cl = (v, a, b) => Math.min(b, Math.max(a, isFinite(v) ? v : a));
const r1 = v => Math.round(v * 10) / 10;
const pad = x => (x < 10 ? '0' : '') + x;
const log = (...a) => console.log('[ibkr-trader]', ...a);
const jread = (p, d) => { try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : d; } catch (e) { return d; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function berlin() {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour12: false }).formatToParts(new Date());
  const g = t => p.find(x => x.type === t).value;
  return { y: +g('year'), mo: +g('month'), d: +g('day'), mins: +g('hour') * 60 + +g('minute'), wd: { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 }[g('weekday')] };
}
const today = () => { const b = berlin(); return b.y + '-' + pad(b.mo) + '-' + pad(b.d); };

const TC = jread('trade-config.json', null);
if (!TC) { log('ABORTO: falta trade-config.json junto al script.'); process.exit(0); }
const GW = ((TC.ibkr && TC.ibkr.gateway) || 'https://localhost:5000') + '/v1/api';
const TL = jread('trades-ibkr.json', { trades: [] });
const save = () => writeFileSync('trades-ibkr.json', JSON.stringify(TL, null, 1));

async function api(path, opts) {
  const o = opts || {};
  const r = await fetch(GW + path, { method: o.method || (o.body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json' }, body: o.body ? JSON.stringify(o.body) : undefined });
  const tx = await r.text();
  let j = null; try { j = JSON.parse(tx); } catch (e) { }
  if (!r.ok) throw new Error('IBKR ' + path + ' HTTP ' + r.status + ' · ' + tx.slice(0, 140));
  return j;
}
async function ensureAuth() {
  const t = await api('/tickle', { method: 'POST' }).catch(() => null);
  const st = await api('/iserver/auth/status', { method: 'POST' }).catch(() => null);
  if (!st || !st.authenticated) throw new Error('gateway sin sesión: abre https://localhost:5000 y haz login');
  const ac = await api('/iserver/accounts');
  const acct = (ac && (ac.selectedAccount || (ac.accounts && ac.accounts[0]))) || null;
  if (!acct) throw new Error('sin cuenta seleccionable');
  return acct;
}

// límites duros compartidos (mismos criterios que ig-trader)
const doneT = TL.trades.filter(t => t.closedAt);
const pnlOf = t => t.pnlEur != null ? t.pnlEur : -(t.riskEur || 0);
const dayPnl = doneT.filter(t => t.date === today()).reduce((a, t) => a + pnlOf(t), 0);
const weekPnl = doneT.filter(t => Date.parse(t.date) > Date.now() - 7 * 86400000).reduce((a, t) => a + pnlOf(t), 0);
let consec = 0; for (let i = doneT.length - 1; i >= 0; i--) { if (pnlOf(doneT[i]) < 0) consec++; else break; }
function hardGates(B) {
  const g = [];
  if (!TC.enabled) g.push('enabled=false en trade-config.json');
  if (existsSync('STOP-TRADING')) g.push('archivo STOP-TRADING presente');
  if ((TC.blackoutDates || []).includes(today())) g.push('festivo (blackoutDates)');
  if (B.wd === 0 || B.wd === 6) g.push('fin de semana');
  if (dayPnl <= -Math.abs(TC.maxDailyLossEur || 100)) g.push('pérdida diaria máx. alcanzada (' + r1(dayPnl) + ' €)');
  if (weekPnl <= -Math.abs(TC.maxWeeklyLossEur || 250)) g.push('pérdida semanal máx. alcanzada (' + r1(weekPnl) + ' €)');
  if (consec >= (TC.maxConsecLosses || 3)) g.push(consec + ' pérdidas seguidas — auto-pausa');
  return g;
}
function evalSignal() {
  const H = jread('history.json', null), CFG = jread('config.json', {});
  if (!H || !H.siglog) return { err: 'falta history.json (clona el repo del worker y ejecuta dentro)' };
  const se = H.siglog.find(x => x.date === today());
  if (!se || se.mu == null) return { err: 'sin señal congelada hoy en history.json (haz git pull después de las 8:30)' };
  const thresh = cl(TC.umbralProbabilidad != null ? TC.umbralProbabilidad : (CFG.thresh || 58), 52, 70);
  const sigma = Math.max(0.15, (CFG.calib90 && CFG.calib90.sd90) || 0.45);
  const tgtPct = cl(Math.abs(se.mu) * 1.6, 0.5, TC.objetivoMaxPct || 1.0);
  const stpPct = tgtPct * 0.6;
  const u = -2 * (se.dir * se.mu) / (sigma * sigma);
  let pHit = Math.abs(u) < 1e-4 ? stpPct / (tgtPct + stpPct) : (1 - Math.exp(-u * stpPct)) / (Math.exp(u * tgtPct) - Math.exp(-u * stpPct));
  pHit = cl(pHit, 0.05, 0.95);
  const lvl = se.lvl || 24000;
  const tgtPts = Math.round(lvl * tgtPct / 100), stpPts = Math.round(lvl * stpPct / 100);
  const ev = pHit * tgtPts - (1 - pHit) * stpPts - (TC.spreadPts || 2);
  return { se, thresh, tgtPts, stpPts, ev };
}
async function eventBlock() {
  try {
    const j = await (await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json')).json();
    const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    for (const e of j) {
      if (!/high/i.test(e.impact || '') || (e.country !== 'EUR' && e.country !== 'USD')) continue;
      const d = new Date(e.date); if (isNaN(d.getTime())) continue;
      const p = fmt.formatToParts(d); const g = t => p.find(x => x.type === t).value;
      if (g('year') + '-' + g('month') + '-' + g('day') === today()) { const m = +g('hour') * 60 + +g('minute'); if (m >= 520 && m <= 635) return e.title + ' ' + g('hour') + ':' + g('minute'); }
    }
  } catch (e) { }
  return null;
}

async function doFind() {
  await ensureAuth();
  const j = await api('/trsrv/futures?symbols=DAX');
  const list = (j && j.DAX) || [];
  if (!list.length) { log('sin futuros DAX — ¿tienes la suscripción Eurex activa?'); return; }
  log('Futuros DAX disponibles (elige el MICRO-DAX FDXS = multiplicador 1 €/pt, vencimiento más cercano):');
  list.sort((a, b) => (a.expirationDate || 0) - (b.expirationDate || 0)).slice(0, 12).forEach(f => log('  conid ' + f.conid + ' · vence ' + f.expirationDate + (f.symbol ? ' · ' + f.symbol : '') + (f.multiplier ? ' · mult ' + f.multiplier : '')));
  log('→ pega el conid en trade-config.json → ibkr.conid y ajusta ibkr.eurPerPoint (FDXS=1, FDXM=5, FDAX=25).');
}

async function replyLoop(res, acct) {
  // IBKR devuelve avisos que hay que confirmar antes de que la orden entre
  let cur = res;
  for (let i = 0; i < 6; i++) {
    const q = Array.isArray(cur) ? cur[0] : cur;
    if (q && q.id && q.message) { log('confirmando aviso IBKR:', String(q.message).slice(0, 90)); cur = await api('/iserver/reply/' + q.id, { body: { confirmed: true } }); continue; }
    return Array.isArray(cur) ? cur[0] : cur;
  }
  return Array.isArray(cur) ? cur[0] : cur;
}

async function doOpen() {
  const B = berlin();
  const hg = hardGates(B);
  if (hg.length) { log('NO OPERA ·', hg.join(' | ')); return; }
  if (!(B.wd >= 1 && B.wd <= 5 && B.mins >= 540 && B.mins <= 580) && !FORCE) { log('fuera de ventana 9:00–9:40 Berlín (--force solo en papel)'); return; }
  if ((TC.oneTradePerDay !== false) && TL.trades.some(t => t.date === today())) { log('ya hay operación hoy'); return; }
  const S = evalSignal();
  if (S.err) { log('NO OPERA ·', S.err); return; }
  const gates = [];
  if (S.se.p < S.thresh) gates.push('p ' + S.se.p + ' < umbral ' + S.thresh);
  if (S.ev <= 0) gates.push('EV ' + r1(S.ev) + ' ≤ 0');
  if (S.se.gap != null && Math.abs(S.se.gap) > (TC.gapMaxPct || 1.5)) gates.push('|gap| > ' + (TC.gapMaxPct || 1.5) + ' %');
  const ev9 = FORCE ? null : await eventBlock();
  if (ev9) gates.push('evento: ' + ev9);
  if (gates.length) { log('NO OPERA ·', gates.join(' | ')); return; }
  const acct = await ensureAuth();
  const conid = TC.ibkr && TC.ibkr.conid;
  if (!conid) { log('NO OPERA · falta ibkr.conid — ejecuta: node ibkr-trader.mjs find'); return; }
  const epp = (TC.ibkr && TC.ibkr.eurPerPoint) || 1;
  const snap = await api('/iserver/marketdata/snapshot?conids=' + conid + '&fields=31,84,86');
  const row = Array.isArray(snap) ? snap[0] : null;
  const px = row ? parseFloat(row['86'] || row['31'] || row['84']) : NaN;
  if (!(px > 1000)) { log('NO OPERA · sin precio del futuro (¿mercado abierto? ¿suscripción?)'); return; }
  const riskEur = (TC.capitalEur || 10000) * (TC.riskPctPorOperacion || 1) / 100;
  const qty = Math.min(Math.max(1, Math.floor(riskEur / (S.stpPts * epp))), (TC.ibkr && TC.ibkr.maxContracts) || 1);
  if (riskEur < S.stpPts * epp) { log('AVISO: 1 contrato ya arriesga ' + r1(S.stpPts * epp) + ' € > presupuesto ' + r1(riskEur) + ' € — NO OPERA (sube capital/riesgo o usa IG con fracciones)'); return; }
  const side = S.se.dir > 0 ? 'BUY' : 'SELL', anti = S.se.dir > 0 ? 'SELL' : 'BUY';
  const tp = Math.round(px + S.se.dir * S.tgtPts), sl = Math.round(px - S.se.dir * S.stpPts);
  const coid = 'daxot-' + today();
  log('ABRE ' + side + ' ' + qty + ' × conid ' + conid + ' @ ~' + px + ' · TP ' + tp + ' · SL ' + sl + ' · riesgo ' + r1(qty * S.stpPts * epp) + ' €');
  const res = await api('/iserver/account/' + acct + '/orders', {
    body: {
      orders: [
        { conid, orderType: 'MKT', side, quantity: qty, tif: 'DAY', cOID: coid },
        { conid, orderType: 'LMT', price: tp, side: anti, quantity: qty, tif: 'DAY', parentId: coid },
        { conid, orderType: 'STP', price: sl, side: anti, quantity: qty, tif: 'DAY', parentId: coid }
      ]
    }
  });
  const fin = await replyLoop(res, acct);
  const oid = fin && (fin.order_id || fin.orderId || fin.id);
  if (!oid) { log('ORDEN NO CONFIRMADA — revisa en el portal:', JSON.stringify(fin).slice(0, 160)); return; }
  TL.trades.push({ date: today(), platform: 'IBKR', dir: S.se.dir, size: qty, entry: px, tpPts: S.tgtPts, slPts: S.stpPts, riskEur: r1(qty * S.stpPts * epp), epp, conid, orderId: oid, coid, openedAt: new Date().toISOString(), p: S.se.p, mu: S.se.mu, ev: r1(S.ev), closedAt: null, exit: null, pnlEur: null, reason: null });
  save();
  log('ENVIADA · orderId ' + oid + ' (bracket TP/SL como órdenes hijas)');
}

async function doClose() {
  const open = TL.trades.filter(t => !t.closedAt && t.platform === 'IBKR');
  if (!open.length) { log('sin operaciones abiertas registradas'); return; }
  const acct = await ensureAuth();
  for (const t of open) {
    // 1) cancelar órdenes vivas del conid (TP/SL pendientes)
    try {
      const os = await api('/iserver/account/orders');
      for (const o of ((os && os.orders) || [])) {
        if (o.conid === t.conid && /Submitted|PreSubmitted|Pending/i.test(o.status || '')) {
          await api('/iserver/account/' + acct + '/order/' + o.orderId, { method: 'DELETE' }).catch(e => log('cancelación:', e.message));
        }
      }
    } catch (e) { log('aviso al cancelar hijas:', e.message); }
    // 2) aplanar la posición si sigue viva
    let pos = null;
    try { const ps = await api('/portfolio/' + acct + '/positions/0'); pos = (ps || []).find(p => p.conid === t.conid && p.position); } catch (e) { }
    if (pos && pos.position) {
      const side = pos.position > 0 ? 'SELL' : 'BUY';
      const res = await api('/iserver/account/' + acct + '/orders', { body: { orders: [{ conid: t.conid, orderType: 'MKT', side, quantity: Math.abs(pos.position), tif: 'DAY', cOID: t.coid + '-close' }] } });
      await replyLoop(res, acct);
      const snap = await api('/iserver/marketdata/snapshot?conids=' + t.conid + '&fields=31').catch(() => null);
      const px = Array.isArray(snap) && snap[0] ? parseFloat(snap[0]['31']) : null;
      t.closedAt = new Date().toISOString(); t.exit = px;
      t.pnlEur = px ? r1((px - t.entry) * t.dir * t.size * t.epp) : null;
      t.reason = 'salida por tiempo 10:30';
      log('CERRADA por tiempo' + (px ? ' @ ' + px + ' · P&L ~' + t.pnlEur + ' €' : ''));
    } else {
      t.closedAt = new Date().toISOString();
      t.reason = 'cerrada por TP/SL (P&L exacto en el portal IBKR; para límites cuenta como pérdida si no se recupera)';
      log('reconciliada: la cerró TP o SL');
    }
  }
  save();
}

async function doStatus() {
  const B = berlin();
  log('hoy', today(), '· Berlín', Math.floor(B.mins / 60) + ':' + pad(B.mins % 60), '· enabled', !!TC.enabled, '· conid', (TC.ibkr && TC.ibkr.conid) || 'SIN CONFIGURAR');
  const hg = hardGates(B); log('límites:', hg.length ? hg.join(' | ') : 'todos OK', '· P&L día', r1(dayPnl), '€ · semana', r1(weekPnl), '€');
  const S = evalSignal();
  if (S.err) log('señal:', S.err); else log('señal: μ ' + S.se.mu + ' % · p ' + S.se.p + ' % (umbral ' + S.thresh + ') · TP ' + S.tgtPts + ' / SL ' + S.stpPts + ' · EV ' + r1(S.ev));
  try { const acct = await ensureAuth(); log('gateway OK · cuenta', acct); } catch (e) { log('gateway:', e.message); }
}

async function doWait() {
  log('modo espera: abriré en la ventana 9:05 y cerraré a las 10:30 (Berlín). Ctrl+C para abortar.');
  let opened = false, closed = false;
  while (!closed) {
    const B = berlin();
    if (!opened && B.mins >= 545 && B.mins <= 580) { await doOpen().catch(e => log('open error:', e.message)); opened = true; }
    if (opened && B.mins >= 630) { await doClose().catch(e => log('close error:', e.message)); closed = true; break; }
    if (B.mins > 700) break;
    await sleep(20000);
  }
  log('jornada terminada');
}

if (MODE === 'find') await doFind().catch(e => log('error:', e.message));
else if (MODE === 'open') await doOpen().catch(e => log('error:', e.message));
else if (MODE === 'close') await doClose().catch(e => log('error:', e.message));
else if (MODE === 'wait') await doWait();
else await doStatus().catch(e => log('error:', e.message));

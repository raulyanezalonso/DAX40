// DAX Opening Trader — worker de captura 24/7 (GitHub Actions / Node 20, sin dependencias)
// Congela la predicción 8:25–9:00 CET, cierra el real 9:00→10:30 a las 10:40 y el día completo a la mañana siguiente.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const COMPANIES = ['SAP.DE','SIE.DE','ALV.DE','AIR.DE','DTE.DE','MUV2.DE','RHM.DE','IFX.DE','MBG.DE','BMW.DE','DB1.DE','DBK.DE','DHL.DE','ENR.DE','BAS.DE','EOAN.DE','ADS.DE','RWE.DE','VOW3.DE','BAYN.DE','HNR1.DE','CBK.DE','DTG.DE','MRK.DE','HEI.DE','MTX.DE','SHL.DE','VNA.DE','HEN3.DE','FRE.DE','BEI.DE','SY1.DE','CON.DE','BNR.DE','QIA.DE','ZAL.DE','P911.DE','SRT3.DE','FME.DE','PAH3.DE'];
const cl = (v, a, b) => Math.min(b, Math.max(a, isFinite(v) ? v : a));
const r4 = v => v == null || !isFinite(v) ? null : Math.round(v * 10000) / 10000;

function berlin(ts) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour12: false }).formatToParts(ts ? new Date(ts) : new Date());
  const g = t => p.find(x => x.type === t).value;
  const wdMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };
  return { y: +g('year'), mo: +g('month'), d: +g('day'), mins: +g('hour') * 60 + +g('minute'), wd: wdMap[g('weekday')], day: g('day') + '/' + g('month') };
}
const UA = { headers: { 'User-Agent': 'Mozilla/5.0 (worker dax-opening-trader)' } };
async function j(url) { const r = await fetch(url, UA); if (!r.ok) throw new Error(url.slice(0, 60) + ' http ' + r.status); return await r.json(); }
async function spark(syms, range) {
  const out = {};
  for (let i = 0; i < syms.length; i += 10) {
    try {
      const jr = await j('https://query1.finance.yahoo.com/v8/finance/spark?symbols=' + encodeURIComponent(syms.slice(i, i + 10).join(',')) + '&range=' + (range || '2d') + '&interval=15m');
      (jr.spark && jr.spark.result || []).forEach(rr => {
        const rs = rr.response && rr.response[0]; if (!rs) return;
        const cls = (((rs.indicators || {}).quote || [])[0] || {}).close || [];
        const sp = [], ts = [];
        for (let k = 0; k < cls.length; k++) if (cls[k] != null && isFinite(cls[k])) { sp.push(cls[k]); ts.push(rs.timestamp[k] * 1000); }
        const meta = rs.meta || {};
        out[rr.symbol] = { p: meta.regularMarketPrice != null ? meta.regularMarketPrice : sp[sp.length - 1], prev: meta.chartPreviousClose != null ? meta.chartPreviousClose : meta.previousClose, sp, ts };
      });
    } catch (e) { console.log('spark fail', e.message); }
    await new Promise(r2 => setTimeout(r2, 600));
  }
  return out;
}
function move90(q, dayLbl) {
  if (!q || !q.sp) return null;
  let a = null, b = null;
  for (let i = 0; i < q.sp.length; i++) {
    const c = berlin(q.ts[i]);
    if (c.day !== dayLbl) continue;
    if (a == null && c.mins >= 540 && c.mins <= 565) a = q.sp[i];
    if (c.mins >= 605 && c.mins <= 635) b = q.sp[i];
  }
  return a > 0 && b > 0 ? Math.round((b - a) / a * 1e4) / 100 : null;
}
async function dailyChg(sym) {
  try {
    const jr = await j('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?range=5d&interval=1d');
    const rs = jr.chart.result[0], c = rs.indicators.quote[0].close.filter(v => v != null);
    return c.length >= 2 ? (c[c.length - 1] - c[c.length - 2]) / c[c.length - 2] * 100 : null;
  } catch (e) { return null; }
}

const B = berlin();
if (B.wd === 0 || B.wd === 6) { console.log('fin de semana'); process.exit(0); }
const pad = x => (x < 10 ? '0' : '') + x;
const dkey = B.y + '-' + pad(B.mo) + '-' + pad(B.d);
const H = existsSync('history.json') ? JSON.parse(readFileSync('history.json', 'utf8')) : { siglog: [], cohist: [] };
const CFG = existsSync('config.json') ? JSON.parse(readFileSync('config.json', 'utf8')) : {};
let changed = false;

if (B.mins >= 500 && B.mins < 540) {
  // ---- CONGELAR predicción (modelo lite con β exportadas) ----
  const Q = await spark(['ES=F', '^GDAXI'].concat(COMPANIES), '2d');
  const es = Q['ES=F'];
  let esd = 0;
  if (es && es.sp.length > 4) {
    let anchor = null;
    for (let i = 0; i < es.sp.length; i++) { const c = berlin(es.ts[i]); if (c.day !== B.day && c.mins >= 1310 && c.mins <= 1345) anchor = es.sp[i]; }
    if (anchor > 0) esd = (es.sp[es.sp.length - 1] - anchor) / anchor * 100;
  }
  const usPrev = (await dailyChg('^GSPC')) || 0;
  const nkd = (await dailyChg('^N225')) || 0;
  const gap = cl(0.5 * esd + 0.22 * usPrev + 0.15 * nkd, -3, 3); // gap implícito LITE (documentado)
  let mu;
  const b9 = CFG.calib90 && CFG.calib90.b;
  if (b9 && b9.length >= 6) mu = cl(b9[0] + b9[1] * gap + b9[2] * gap * Math.abs(gap) + b9[3] * esd + b9[4] * 0 + b9[5] * nkd, -1.5, 1.5);
  else mu = cl(0.45 * gap + 0.2 * esd, -1.2, 1.2);
  const sigma = Math.max(0.15, (CFG.calib90 && CFG.calib90.sd90) || 0.45);
  const calF = cl(CFG.cal || 1, 0.6, 1.4);
  let pRaw = cl(1 / (1 + Math.exp(-1.15 * calF * (mu / sigma))), 0.15, 0.85);
  let p = (mu >= 0 ? pRaw : 1 - pRaw) * 100;
  if (CFG.platt && isFinite(CFG.platt.a)) { const q0 = cl(p / 100, 0.02, 0.98); p = cl(1 / (1 + Math.exp(-(CFG.platt.a * Math.log(q0 / (1 - q0)) + CFG.platt.b))), 0.15, 0.9) * 100; }
  let se = H.siglog.find(x => x.date === dkey);
  const snap = { date: dkey, mu: r4(mu), p: Math.round(p * 10) / 10, dir: mu >= 0 ? 1 : -1, gap: r4(gap), lvl: Q['^GDAXI'] ? r4(Q['^GDAXI'].p) : null, lite: true, out: null, hit: null, brier: null };
  if (!se) { H.siglog.push(snap); changed = true; }
  else if (se.out == null && se.lite !== false) { Object.assign(se, snap); changed = true; }
  const BETA = CFG.BETA || {};
  let ce = H.cohist.find(x => x.date === dkey);
  const preds = {};
  COMPANIES.forEach(s => { const be = BETA[s] || 1; const q2 = Q[s]; preds[s] = { p90: r4(cl(be * mu, -2.5, 2.5)), pd: r4(cl(be * 1.85 * mu, -3.5, 3.5)), b: q2 && q2.prev > 0 ? r4(q2.prev) : null, lite: true }; });
  if (!ce) { H.cohist.push({ date: dkey, preds, real: {}, lite: true }); changed = true; }
  console.log('congelado', dkey, 'mu', mu.toFixed(3), 'p', p.toFixed(1));
} else if (B.mins >= 635 && B.mins <= 780) {
  // ---- CERRAR real 9:00→10:30 (índice + 40) y rday de ayer ----
  const Q = await spark(['^GDAXI'].concat(COMPANIES), '2d');
  const se = H.siglog.find(x => x.date === dkey);
  if (se && se.out == null) {
    const r90 = move90(Q['^GDAXI'], B.day);
    if (r90 != null) { se.out = r90; se.hit = se.dir * r90 > 0 ? 1 : 0; se.brier = Math.pow(se.p / 100 - se.hit, 2); changed = true; console.log('cierre índice', r90); }
  }
  const ce = H.cohist.find(x => x.date === dkey);
  if (ce && ce.preds) {
    ce.real = ce.real || {};
    COMPANIES.forEach(s => { const r90 = move90(Q[s], B.day); if (r90 != null) { ce.real[s] = Object.assign({}, ce.real[s], { r90 }); changed = true; } });
    ce.closed90 = true;
  }
  for (let k = H.cohist.length - 1; k >= 0; k--) {
    const ce2 = H.cohist[k];
    if (ce2.date >= dkey || ce2.rdayDone) continue;
    let dn = 0;
    COMPANIES.forEach(s => { const pr = ce2.preds && ce2.preds[s], q2 = Q[s]; if (!pr || !(pr.b > 0) || !q2 || !(q2.prev > 0)) return; ce2.real = ce2.real || {}; const r2 = ce2.real[s] = ce2.real[s] || {}; if (r2.rday == null) { r2.rday = Math.round((q2.prev - pr.b) / pr.b * 1e4) / 100; dn++; } });
    if (dn) changed = true;
    ce2.rdayDone = true; changed = true;
    break;
  }
} else { console.log('fuera de ventana Berlín (' + B.mins + ' min) — nada que hacer'); }

if (changed) {
  H.siglog.sort((a, b) => a.date < b.date ? -1 : 1); H.cohist.sort((a, b) => a.date < b.date ? -1 : 1);
  if (H.siglog.length > 120) H.siglog = H.siglog.slice(-120);
  if (H.cohist.length > 60) H.cohist = H.cohist.slice(-60);
  writeFileSync('history.json', JSON.stringify(H));
  console.log('history.json actualizado:', H.siglog.length, 'señales ·', H.cohist.length, 'días de empresas');
} else console.log('sin cambios');

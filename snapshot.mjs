// DAX Opening Trader — worker de SNAPSHOT de mercado 24/7 (GitHub Actions / Node 20, sin dependencias)
// Descarga los mismos datos de Yahoo que pide el dashboard, DESDE EL SERVIDOR (sin CORS, fiable),
// y los guarda en data/yahoo.json. El dashboard los lee con un fetch de mismo origen (sin proxies).
// Se ejecuta en cron cada 15 min → los módulos se llenan aunque el navegador esté cerrado.
import { mkdirSync, writeFileSync } from 'node:fs';

// Mismos universos de símbolos que el dashboard (this.CTX2D / MACRO1D / COMPANIES)
const CTX2D = ['^GSPC', 'ES=F', 'NQ=F', '^N225', '^GDAXI'];
const MACRO1D = ['^HSI', '000001.SS', '^KS11', '^AXJO', 'EURUSD=X', '^VIX', '^TNX', 'JPY=X', 'GC=F', 'CL=F', 'BTC-USD', '^STOXX50E', '^DJI', '^IXIC', '^RUT', 'YM=F', 'RTY=F', '^FTSE', '^FCHI', '^IBEX', '^SSMI', '^TWII', '^STI', '^HSCE', '^BSESN', '^NSEI', 'GBPUSD=X', 'EURJPY=X', 'EURGBP=X', 'EURCHF=X', 'CNY=X', '^FVX', '^TYX', 'BZ=F', 'NG=F', 'HG=F', 'SI=F', 'ETH-USD', '^VXN', 'XLK', 'XLF', 'XLI', 'XLE', 'XLY', 'SOXX', 'ITA', 'EWG', 'NVDA', 'MSFT', 'AAPL', 'TSLA', 'HYG', 'LQD', 'TLT', 'XLV', 'XLP', 'XLU', 'XLB', 'XLC', 'FEZ', 'VGK', 'EUFN', 'EWQ', 'EWU', 'EWI', 'EWP', 'PA=F', 'PL=F', 'AUDUSD=X', 'AUDJPY=X', '^VVIX', '^IRX', 'ZN=F', 'ZF=F', 'DX-Y.NYB', 'NIY=F'];
const COMPANIES = ['SAP.DE', 'SIE.DE', 'ALV.DE', 'AIR.DE', 'DTE.DE', 'MUV2.DE', 'RHM.DE', 'IFX.DE', 'MBG.DE', 'BMW.DE', 'DB1.DE', 'DBK.DE', 'DHL.DE', 'ENR.DE', 'BAS.DE', 'EOAN.DE', 'ADS.DE', 'RWE.DE', 'VOW3.DE', 'BAYN.DE', 'HNR1.DE', 'CBK.DE', 'DTG.DE', 'MRK.DE', 'HEI.DE', 'MTX.DE', 'SHL.DE', 'VNA.DE', 'HEN3.DE', 'FRE.DE', 'BEI.DE', 'SY1.DE', 'CON.DE', 'BNR.DE', 'QIA.DE', 'ZAL.DE', 'P911.DE', 'SRT3.DE', 'FME.DE', 'PAH3.DE'];
// Charts que consume el dashboard: velas 15m (5d), runs100 (60d/15m), diario (5d/1d), volumen ETF
const CHARTS = [['^GDAXI', '5d', '15m'], ['^GDAXI', '60d', '15m'], ['^GDAXI', '5d', '1d'], ['EXS1.DE', '5d', '15m']];

const UA = { headers: { 'User-Agent': 'Mozilla/5.0 (dax-snapshot-worker)' } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function jf(url) { const r = await fetch(url, UA); if (!r.ok) throw new Error('http ' + r.status); return r.json(); }

async function spark(syms, range, out) {
  for (let i = 0; i < syms.length; i += 10) {
    const chunk = syms.slice(i, i + 10);
    let tries = 0, ok = false;
    while (tries < 2 && !ok) {
      try {
        const host = tries === 0 ? 'query1' : 'query2';
        const jr = await jf('https://' + host + '.finance.yahoo.com/v8/finance/spark?symbols=' + encodeURIComponent(chunk.join(',')) + '&range=' + range + '&interval=15m');
        (jr.spark && jr.spark.result || []).forEach(rr => {
          const rs = rr.response && rr.response[0]; if (!rs) return;
          const meta = rs.meta || {};
          out[rr.symbol] = {
            meta: { regularMarketPrice: meta.regularMarketPrice, chartPreviousClose: meta.chartPreviousClose, previousClose: meta.previousClose },
            timestamp: rs.timestamp || [],
            close: ((((rs.indicators || {}).quote || [])[0] || {}).close) || []
          };
        });
        ok = true;
      } catch (e) { tries++; if (tries < 2) await sleep(800); else console.log('spark fail', chunk[0], e.message); }
    }
    await sleep(500);
  }
}
async function chart(sym, range, interval) {
  let tries = 0;
  while (tries < 2) {
    try {
      const host = tries === 0 ? 'query1' : 'query2';
      const jr = await jf('https://' + host + '.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?range=' + range + '&interval=' + interval);
      const rs = jr.chart && jr.chart.result && jr.chart.result[0]; if (!rs) throw new Error('sin result');
      const q = (rs.indicators && rs.indicators.quote && rs.indicators.quote[0]) || {};
      return {
        meta: { regularMarketPrice: (rs.meta || {}).regularMarketPrice, chartPreviousClose: (rs.meta || {}).chartPreviousClose },
        timestamp: rs.timestamp || [],
        indicators: { quote: [{ open: q.open || [], high: q.high || [], low: q.low || [], close: q.close || [], volume: q.volume || [] }] }
      };
    } catch (e) { tries++; if (tries >= 2) throw e; await sleep(800); }
  }
}

const snap = { at: Date.now(), spark: {}, chart: {} };
await spark(CTX2D, '2d', snap.spark);
await spark(MACRO1D, '1d', snap.spark);
await spark(COMPANIES, '1d', snap.spark);
for (const [sym, range, interval] of CHARTS) {
  try { snap.chart[sym + '|' + range + '|' + interval] = await chart(sym, range, interval); await sleep(500); }
  catch (e) { console.log('chart fail', sym, range, interval, e.message); }
}
mkdirSync('data', { recursive: true });
writeFileSync('data/yahoo.json', JSON.stringify(snap));
console.log('snapshot listo: ' + Object.keys(snap.spark).length + ' símbolos · ' + Object.keys(snap.chart).length + ' charts');

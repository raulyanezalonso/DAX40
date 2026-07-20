//+------------------------------------------------------------------+
//| DaxOpeningTrader.mq5 — DAX Opening Trader · Expert Advisor MT5    |
//| Lee la señal congelada del worker (history.json + config.json en  |
//| GitHub RAW), evalúa las puertas y opera la ventana 9:00-10:30 CET |
//| con TP/SL, salida por tiempo, límite de pérdida diaria y          |
//| kill-switch. 1 operación al día como máximo.                      |
//| REQUISITO: MT5 → Herramientas → Opciones → Asesores Expertos →    |
//| "Permitir WebRequest para las URL:" añadir                        |
//|   https://raw.githubusercontent.com                               |
//|   https://nfs.faireconomy.media                                   |
//+------------------------------------------------------------------+
#property copyright "DAX Opening Trader"
#property version   "1.00"
#property strict
#include <Trade/Trade.mqh>

input bool   InpEnabled            = false;   // ACTIVAR el bot (kill-switch principal)
input string InpUrlHistory        = "https://raw.githubusercontent.com/TUUSUARIO/dax-worker/main/history.json"; // URL RAW history.json
input string InpUrlConfig         = "https://raw.githubusercontent.com/TUUSUARIO/dax-worker/main/config.json";  // URL RAW config.json
input double InpUmbralProb        = 58;      // Umbral de probabilidad %
input double InpObjetivoMaxPct    = 1.0;     // Objetivo máximo %
input double InpSpreadCostePts    = 2;       // Coste spread asumido (pts) para el EV
input double InpMaxSpreadPts      = 4;       // Spread real máximo para operar (pts)
input double InpGapMaxPct         = 1.5;     // |gap| máximo %
input double InpRiskPct           = 1.0;     // % del equity arriesgado por operación
input double InpMaxDailyLossEur   = 100;     // Pérdida diaria máxima (moneda de la cuenta)
input int    InpBrokerMinusBerlin = 60;      // Minutos que el reloj del broker va POR DELANTE de Berlín (EET=60)
input bool   InpUsarFiltroEventos = true;    // Bloquear con evento HIGH EUR/USD 8:40-10:35
input long   InpMagic             = 90210;   // Número mágico

CTrade trade;
string GV_DAY = "daxot_daytraded_";  // global var por fecha
string GV_EQ  = "daxot_dayequity_";

int OnInit(){ trade.SetExpertMagicNumber(InpMagic); EventSetTimer(15); return(INIT_SUCCEEDED); }
void OnDeinit(const int reason){ EventKillTimer(); }

// ---- utilidades ----
int BerlinMins(){ MqlDateTime t; TimeToStruct(TimeCurrent(), t); int m = t.hour*60 + t.min - InpBrokerMinusBerlin; if(m < 0) m += 1440; return m; }
string TodayKey(){ MqlDateTime t; TimeToStruct(TimeCurrent() - InpBrokerMinusBerlin*60, t); return StringFormat("%04d-%02d-%02d", t.year, t.mon, t.day); }
int BerlinDow(){ MqlDateTime t; TimeToStruct(TimeCurrent() - InpBrokerMinusBerlin*60, t); return t.day_of_week; }

string HttpGet(string url){
  char data[], result[]; string rh;
  int code = WebRequest("GET", url, "", 8000, data, result, rh);
  if(code != 200){ Print("[daxot] WebRequest ", code, " en ", url, " — ¿URL en la lista blanca de Opciones?"); return ""; }
  return CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
}
// extrae un número "clave":valor dentro de un bloque de texto
double JNum(string block, string key, double def){
  int i = StringFind(block, "\"" + key + "\":");
  if(i < 0) return def;
  int a = i + StringLen(key) + 3;
  string s = StringSubstr(block, a, 24);
  return StringToDouble(s);
}

// ---- señal del worker ----
bool GetSignal(double &mu, double &p, int &dir, double &gap, double &lvl, double &sd90, double &thrCfg){
  string h = HttpGet(InpUrlHistory);
  if(h == "") return false;
  int i = StringFind(h, "\"date\":\"" + TodayKey() + "\"");
  if(i < 0){ Print("[daxot] sin señal congelada hoy (", TodayKey(), ") en history.json"); return false; }
  string block = StringSubstr(h, i, 320);
  mu = JNum(block, "mu", 0); p = JNum(block, "p", 0);
  dir = (JNum(block, "dir", (mu >= 0 ? 1 : -1)) >= 0) ? 1 : -1;
  gap = JNum(block, "gap", 0); lvl = JNum(block, "lvl", 0);
  string c = HttpGet(InpUrlConfig);
  sd90 = 0.45; thrCfg = InpUmbralProb;
  if(c != ""){ double s = JNum(c, "sd90", 0.45); if(s > 0.05) sd90 = s; double th = JNum(c, "thresh", 0); if(th >= 52 && th <= 70 && InpUmbralProb <= 0) thrCfg = th; }
  if(p <= 0 || lvl <= 0){ Print("[daxot] señal incompleta (p o lvl vacíos)"); return false; }
  return true;
}

bool EventBlock(){
  if(!InpUsarFiltroEventos) return false;
  string j = HttpGet("https://nfs.faireconomy.media/ff_calendar_thisweek.json");
  if(j == "") return false; // sin calendario no bloquea, solo avisa
  // busca eventos HIGH de EUR/USD; comprueba fecha y hora aproximada (el feed da hora con zona)
  int pos = 0;
  while((pos = StringFind(j, "\"impact\":\"High\"", pos)) >= 0){
    int a = MathMax(0, pos - 400);
    string blk = StringSubstr(j, a, 500);
    if(StringFind(blk, "\"country\":\"EUR\"") >= 0 || StringFind(blk, "\"country\":\"USD\"") >= 0){
      int di = StringFind(blk, "\"date\":\"");
      if(di >= 0){
        string ds = StringSubstr(blk, di + 8, 25); // ej 2026-07-20T14:30:00-04:00
        if(StringSubstr(ds, 0, 10) == TodayKey()){
          // hora del feed en su zona: convertimos grosso modo con el offset del sufijo
          int hh = (int)StringToInteger(StringSubstr(ds, 11, 2));
          int mi = (int)StringToInteger(StringSubstr(ds, 14, 2));
          int off = 0; string sgn = StringSubstr(ds, 19, 1);
          if(sgn == "+" || sgn == "-"){ off = (int)StringToInteger(StringSubstr(ds, 20, 2)) * 60 + (int)StringToInteger(StringSubstr(ds, 23, 2)); if(sgn == "-") off = -off; }
          int utc = hh*60 + mi - off;               // minutos UTC
          int berlinOffset = 120;                    // CEST verano; invierno 60 — margen amplio abajo lo cubre
          int bm = utc + berlinOffset; if(bm < 0) bm += 1440; if(bm >= 1440) bm -= 1440;
          if(bm >= 490 && bm <= 665) return true;   // 8:10–11:05 Berlín (margen por el cambio de hora)
        }
      }
    }
    pos += 10;
  }
  return false;
}

bool HasOpenPosition(){
  for(int i = PositionsTotal()-1; i >= 0; i--){
    ulong tk = PositionGetTicket(i);
    if(tk > 0 && PositionGetString(POSITION_SYMBOL) == _Symbol && (long)PositionGetInteger(POSITION_MAGIC) == InpMagic) return true;
  }
  return false;
}

void OnTimer(){
  if(!InpEnabled) return;
  string day = TodayKey();
  int bm = BerlinMins(); int dow = BerlinDow();
  if(dow == 0 || dow == 6) return;

  // equity de inicio de día + límite de pérdida diaria (cierra y bloquea)
  if(!GlobalVariableCheck(GV_EQ + day)) GlobalVariableSet(GV_EQ + day, AccountInfoDouble(ACCOUNT_EQUITY));
  double dd = AccountInfoDouble(ACCOUNT_EQUITY) - GlobalVariableGet(GV_EQ + day);
  if(dd <= -MathAbs(InpMaxDailyLossEur)){
    if(HasOpenPosition()){ trade.PositionClose(_Symbol); Print("[daxot] LÍMITE DIARIO: posición cerrada (", DoubleToString(dd,1), ")"); }
    GlobalVariableSet(GV_DAY + day, 1); return;
  }

  // salida por tiempo 10:30
  if(bm >= 630 && HasOpenPosition()){ trade.PositionClose(_Symbol); Print("[daxot] salida por tiempo 10:30 Berlín"); return; }

  // ventana de apertura 9:05–9:20 · una vez al día
  if(bm < 545 || bm > 580) return;
  if(GlobalVariableCheck(GV_DAY + day)) return;
  if(HasOpenPosition()) return;

  double mu, p, gap, lvl, sd90, thr; int dir;
  if(!GetSignal(mu, p, dir, gap, lvl, sd90, thr)){ GlobalVariableSet(GV_DAY + day, 1); return; }
  double umbral = (InpUmbralProb > 0 ? InpUmbralProb : thr);
  if(p < umbral){ Print("[daxot] NO OPERA · p ", p, " < umbral ", umbral); GlobalVariableSet(GV_DAY + day, 1); return; }
  if(MathAbs(gap) > InpGapMaxPct){ Print("[daxot] NO OPERA · |gap| ", gap, " > ", InpGapMaxPct); GlobalVariableSet(GV_DAY + day, 1); return; }
  if(EventBlock()){ Print("[daxot] NO OPERA · evento de alto impacto en la ventana"); GlobalVariableSet(GV_DAY + day, 1); return; }

  // objetivo/stop + EV (misma fórmula de barrera del dashboard)
  double tgtPct = MathMin(MathMax(MathAbs(mu)*1.6, 0.5), InpObjetivoMaxPct);
  double stpPct = tgtPct*0.6;
  double u = -2.0*(dir*mu)/(sd90*sd90);
  double pHit = (MathAbs(u) < 0.0001) ? stpPct/(tgtPct+stpPct) : (1.0-MathExp(-u*stpPct))/(MathExp(u*tgtPct)-MathExp(-u*stpPct));
  pHit = MathMin(0.95, MathMax(0.05, pHit));
  double tgtPts = lvl*tgtPct/100.0, stpPts = lvl*stpPct/100.0;
  double ev = pHit*tgtPts - (1.0-pHit)*stpPts - InpSpreadCostePts;
  if(ev <= 0){ Print("[daxot] NO OPERA · EV ", DoubleToString(ev,1), " ≤ 0"); GlobalVariableSet(GV_DAY + day, 1); return; }

  double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK), bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
  if((ask-bid) > InpMaxSpreadPts){ Print("[daxot] NO OPERA · spread real ", DoubleToString(ask-bid,1), " > ", InpMaxSpreadPts); return; }

  // tamaño por riesgo: valor de 1.0 punto de índice por lote
  double tickV = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
  double tickS = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
  if(tickV <= 0 || tickS <= 0){ Print("[daxot] símbolo sin tick value"); return; }
  double ptValue = tickV / tickS;                       // moneda por punto por lote
  double riskEur = AccountInfoDouble(ACCOUNT_EQUITY) * InpRiskPct / 100.0;
  double lots = riskEur / (stpPts * ptValue);
  double lmin = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN), lstep = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
  lots = MathFloor(lots/lstep)*lstep;
  if(lots < lmin){ Print("[daxot] NO OPERA · lote calculado ", DoubleToString(lots,2), " < mínimo ", DoubleToString(lmin,2), " (riesgo insuficiente para este símbolo)"); GlobalVariableSet(GV_DAY + day, 1); return; }

  double price = (dir > 0 ? ask : bid);
  double sl = NormalizeDouble(price - dir*stpPts, _Digits);
  double tp = NormalizeDouble(price + dir*tgtPts, _Digits);
  bool ok = (dir > 0) ? trade.Buy(lots, _Symbol, 0, sl, tp, "daxot") : trade.Sell(lots, _Symbol, 0, sl, tp, "daxot");
  GlobalVariableSet(GV_DAY + day, 1);
  if(ok) Print("[daxot] ABIERTA ", (dir>0?"BUY ":"SELL "), DoubleToString(lots,2), " lotes · TP +", DoubleToString(tgtPts,0), " · SL -", DoubleToString(stpPts,0), " · p ", p, "% · EV ", DoubleToString(ev,1));
  else   Print("[daxot] ORDEN RECHAZADA: ", trade.ResultRetcodeDescription());
}
//+------------------------------------------------------------------+

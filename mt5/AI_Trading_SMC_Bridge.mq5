#property strict
#property version   "2.00"
#property description "AI Trading SMC - MT5 Bridge V2 history/data mode"

input string ApiBaseUrl = "https://ai-trading-smc-production.up.railway.app";
input string BridgeToken = "";
input int SendIntervalSeconds = 5;
input int HistoryBars = 100;

string TFName(ENUM_TIMEFRAMES tf){ if(tf==PERIOD_M3)return "M3"; if(tf==PERIOD_M5)return "M5"; if(tf==PERIOD_M15)return "M15"; return "UNKNOWN"; }

string EscapeJson(string s){ StringReplace(s,"\\","\\\\"); StringReplace(s,"\"","\\\""); return s; }

bool PostJson(string endpoint,string payload){
 uchar data[]; StringToCharArray(payload,data,0,WHOLE_ARRAY,CP_UTF8); if(ArraySize(data)>0) ArrayResize(data,ArraySize(data)-1);
 uchar result[]; string result_headers; string headers="Content-Type: application/json\r\n";
 if(StringLen(BridgeToken)>0) headers += "X-Bridge-Token: "+BridgeToken+"\r\n";
 ResetLastError(); int status=WebRequest("POST",ApiBaseUrl+endpoint,headers,10000,data,result,result_headers);
 if(status==-1){ Print("Bridge V2 WebRequest error ",GetLastError(),". Check Allow WebRequest URL."); return false; }
 if(status<200 || status>=300){ Print("Bridge V2 HTTP ",status," response: ",CharArrayToString(result)); return false; }
 return true;
}

bool SendHistory(ENUM_TIMEFRAMES tf){
 int bars=MathMax(20,MathMin(HistoryBars,300)); MqlRates rates[]; ArraySetAsSeries(rates,true);
 int copied=CopyRates(_Symbol,tf,1,bars,rates); if(copied<20){ Print("Bridge V2 CopyRates insufficient ",TFName(tf)," copied=",copied); return false; }
 MqlTick tick; if(!SymbolInfoTick(_Symbol,tick)) return false;
 string candles="[";
 for(int i=copied-1;i>=0;i--){ MqlRates b=rates[i]; if(StringLen(candles)>1)candles+=","; candles+=StringFormat("{\"time\":%I64d,\"open\":%.*f,\"high\":%.*f,\"low\":%.*f,\"close\":%.*f,\"tickVolume\":%I64d}",(long)b.time,_Digits,b.open,_Digits,b.high,_Digits,b.low,_Digits,b.close,(long)b.tick_volume); }
 candles+="]";
 string payload=StringFormat("{\"symbol\":\"%s\",\"timeframe\":\"%s\",\"bid\":%.*f,\"ask\":%.*f,\"account\":\"%I64d\",\"bars\":%d,\"candles\":%s}",EscapeJson(_Symbol),TFName(tf),_Digits,tick.bid,_Digits,tick.ask,(long)AccountInfoInteger(ACCOUNT_LOGIN),copied,candles);
 return PostJson("/api/mt5/history",payload);
}

void SendAll(){ SendHistory(PERIOD_M3); SendHistory(PERIOD_M5); SendHistory(PERIOD_M15); }
int OnInit(){ if(SendIntervalSeconds<1 || HistoryBars<20) return INIT_PARAMETERS_INCORRECT; EventSetTimer(SendIntervalSeconds); Print("AI Trading SMC Bridge V2 started. History bars=",HistoryBars,". Auto trading DISABLED."); SendAll(); return INIT_SUCCEEDED; }
void OnDeinit(const int reason){ EventKillTimer(); }
void OnTimer(){ SendAll(); }
void OnTick(){ /* V2 remains data-only. */ }

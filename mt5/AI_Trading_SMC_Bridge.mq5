#property strict
#property version "4.10"
#property description "AI Trading SMC V4 Multi-Setup Real-Time Feed - data only"

input string ApiBaseUrl="https://ai-trading-smc-production.up.railway.app";
input string BridgeToken="";
input int LiveIntervalSeconds=1;
input int HistoryBars=100;

string TFName(ENUM_TIMEFRAMES tf){if(tf==PERIOD_M1)return "M1";if(tf==PERIOD_M3)return "M3";if(tf==PERIOD_M5)return "M5";if(tf==PERIOD_M15)return "M15";if(tf==PERIOD_H1)return "H1";if(tf==PERIOD_H4)return "H4";if(tf==PERIOD_D1)return "D1";return "UNKNOWN";}
string EscapeJson(string s){StringReplace(s,"\\","\\\\");StringReplace(s,"\"","\\\"");return s;}
bool PostJson(string endpoint,string payload){uchar data[];StringToCharArray(payload,data,0,WHOLE_ARRAY,CP_UTF8);if(ArraySize(data)>0)ArrayResize(data,ArraySize(data)-1);uchar result[];string rh,headers="Content-Type: application/json\r\n";if(StringLen(BridgeToken)>0)headers+="X-Bridge-Token: "+BridgeToken+"\r\n";ResetLastError();int status=WebRequest("POST",ApiBaseUrl+endpoint,headers,5000,data,result,rh);if(status==-1){Print("SMC V4 WebRequest error ",GetLastError());return false;}if(status<200||status>=300){Print("SMC V4 HTTP ",status," ",CharArrayToString(result));return false;}return true;}
bool SendHistory(ENUM_TIMEFRAMES tf){int bars=MathMax(20,MathMin(HistoryBars,300));MqlRates rates[];ArraySetAsSeries(rates,true);int copied=CopyRates(_Symbol,tf,1,bars,rates);if(copied<20)return false;MqlTick tick;if(!SymbolInfoTick(_Symbol,tick))return false;string candles="[";for(int i=copied-1;i>=0;i--){MqlRates b=rates[i];if(StringLen(candles)>1)candles+=",";candles+=StringFormat("{\"time\":%I64d,\"open\":%.*f,\"high\":%.*f,\"low\":%.*f,\"close\":%.*f,\"tickVolume\":%I64d}",(long)b.time,_Digits,b.open,_Digits,b.high,_Digits,b.low,_Digits,b.close,(long)b.tick_volume);}candles+="]";string p=StringFormat("{\"symbol\":\"%s\",\"timeframe\":\"%s\",\"bid\":%.*f,\"ask\":%.*f,\"account\":\"%I64d\",\"candles\":%s}",EscapeJson(_Symbol),TFName(tf),_Digits,tick.bid,_Digits,tick.ask,(long)AccountInfoInteger(ACCOUNT_LOGIN),candles);return PostJson("/api/mt5/history",p);}
bool SendLive(ENUM_TIMEFRAMES tf){MqlRates r[];ArraySetAsSeries(r,true);if(CopyRates(_Symbol,tf,0,1,r)!=1)return false;MqlTick tick;if(!SymbolInfoTick(_Symbol,tick))return false;MqlRates b=r[0];string p=StringFormat("{\"symbol\":\"%s\",\"timeframe\":\"%s\",\"time\":%I64d,\"open\":%.*f,\"high\":%.*f,\"low\":%.*f,\"close\":%.*f,\"tickVolume\":%I64d,\"bid\":%.*f,\"ask\":%.*f,\"account\":\"%I64d\"}",EscapeJson(_Symbol),TFName(tf),(long)b.time,_Digits,b.open,_Digits,b.high,_Digits,b.low,_Digits,b.close,(long)b.tick_volume,_Digits,tick.bid,_Digits,tick.ask,(long)AccountInfoInteger(ACCOUNT_LOGIN));return PostJson("/api/mt5/ohlc",p);}
void SendInitialHistory(){SendHistory(PERIOD_M1);SendHistory(PERIOD_M3);SendHistory(PERIOD_M5);SendHistory(PERIOD_M15);SendHistory(PERIOD_H1);SendHistory(PERIOD_H4);SendHistory(PERIOD_D1);}
void SendRealtime(){SendLive(PERIOD_M1);SendLive(PERIOD_M3);SendLive(PERIOD_M5);SendLive(PERIOD_M15);SendLive(PERIOD_H1);SendLive(PERIOD_H4);SendLive(PERIOD_D1);}
int OnInit(){if(LiveIntervalSeconds<1||HistoryBars<20)return INIT_PARAMETERS_INCORRECT;EventSetTimer(LiveIntervalSeconds);Print("AI Trading SMC V4 Multi-Setup started. Scalping M5-M3-M1, Intraday H1-M15-M5, Swing D1/H4-H1-M15. Auto trade OFF.");SendInitialHistory();SendRealtime();return INIT_SUCCEEDED;}
void OnDeinit(const int reason){EventKillTimer();}
void OnTimer(){SendRealtime();}
void OnTick(){}

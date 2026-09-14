#property strict
#property version   "1.00"
#property description "AI Trading SMC - MT5 Bridge V1 (data/signal mode only)"

input string ApiBaseUrl = "https://ai-trading-smc-production.up.railway.app";
input string BridgeToken = "";
input int    SendIntervalSeconds = 5;

string TFName(ENUM_TIMEFRAMES tf)
{
   if(tf == PERIOD_M3)  return "M3";
   if(tf == PERIOD_M5)  return "M5";
   if(tf == PERIOD_M15) return "M15";
   return "UNKNOWN";
}

bool SendSnapshot(ENUM_TIMEFRAMES tf)
{
   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   if(CopyRates(_Symbol, tf, 0, 3, rates) < 3)
   {
      Print("Bridge: CopyRates failed for ", TFName(tf));
      return false;
   }

   MqlTick tick;
   if(!SymbolInfoTick(_Symbol, tick))
      return false;

   MqlRates bar = rates[1]; // last fully closed candle
   string payload = StringFormat(
      "{\"symbol\":\"%s\",\"timeframe\":\"%s\",\"time\":%I64d,\"open\":%.*f,\"high\":%.*f,\"low\":%.*f,\"close\":%.*f,\"tickVolume\":%I64d,\"bid\":%.*f,\"ask\":%.*f,\"account\":\"%I64d\"}",
      _Symbol,
      TFName(tf),
      (long)bar.time,
      _Digits, bar.open,
      _Digits, bar.high,
      _Digits, bar.low,
      _Digits, bar.close,
      (long)bar.tick_volume,
      _Digits, tick.bid,
      _Digits, tick.ask,
      (long)AccountInfoInteger(ACCOUNT_LOGIN)
   );

   uchar data[];
   StringToCharArray(payload, data, 0, WHOLE_ARRAY, CP_UTF8);
   if(ArraySize(data) > 0)
      ArrayResize(data, ArraySize(data) - 1);

   uchar result[];
   string result_headers;
   string headers = "Content-Type: application/json\r\n";
   if(StringLen(BridgeToken) > 0)
      headers += "X-Bridge-Token: " + BridgeToken + "\r\n";

   string url = ApiBaseUrl + "/api/mt5/ohlc";
   ResetLastError();
   int status = WebRequest("POST", url, headers, 5000, data, result, result_headers);

   if(status == -1)
   {
      Print("Bridge WebRequest error ", GetLastError(), ". Add URL to Tools > Options > Expert Advisors > Allow WebRequest.");
      return false;
   }

   if(status < 200 || status >= 300)
   {
      Print("Bridge HTTP ", status, " response: ", CharArrayToString(result));
      return false;
   }

   return true;
}

void SendAll()
{
   SendSnapshot(PERIOD_M3);
   SendSnapshot(PERIOD_M5);
   SendSnapshot(PERIOD_M15);
}

int OnInit()
{
   if(SendIntervalSeconds < 1)
   {
      Print("SendIntervalSeconds must be >= 1");
      return INIT_PARAMETERS_INCORRECT;
   }

   EventSetTimer(SendIntervalSeconds);
   Print("AI Trading SMC Bridge V1 started. Auto trading is DISABLED.");
   SendAll();
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
}

void OnTimer()
{
   SendAll();
}

void OnTick()
{
   // V1 intentionally does not place, modify, or close any trade.
}

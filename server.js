const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const mt5State = {
  connected: false,
  lastSeen: null,
  account: null,
  symbols: {}
};

function normalizeSymbol(symbol = '') {
  const s = String(symbol).toUpperCase();
  if (s.includes('XAUUSD')) return 'XAUUSD';
  if (s.includes('BTCUSD')) return 'BTCUSD';
  return s.replace(/[^A-Z0-9]/g, '').slice(0, 24);
}

function bridgeAuth(req, res, next) {
  const expected = process.env.MT5_BRIDGE_TOKEN;
  if (!expected) return next(); // Safe bridge mode: ingest only, execution remains disabled.
  const supplied = req.get('x-bridge-token');
  if (supplied !== expected) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
}

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'ai-trading-smc' }));

app.get('/api/status', (req, res) => res.json({
  status: 'online',
  engine: 'SMC',
  symbols: ['XAUUSD', 'BTCUSD'],
  mt5: { connected: mt5State.connected, lastSeen: mt5State.lastSeen },
  execution: {
    enabled: false,
    type: 'limit',
    slPips: 50,
    tp1Pips: 50,
    tp2Pips: 100,
    breakEvenAfterPips: 30
  }
}));

app.post('/api/mt5/ohlc', bridgeAuth, (req, res) => {
  const body = req.body || {};
  const symbol = normalizeSymbol(body.symbol);
  const timeframe = String(body.timeframe || '').toUpperCase();
  const allowedTf = new Set(['M3', 'M5', 'M15']);

  if (!symbol || !allowedTf.has(timeframe)) {
    return res.status(400).json({ ok: false, error: 'symbol and timeframe (M3/M5/M15) are required' });
  }

  const numericFields = ['open', 'high', 'low', 'close'];
  for (const field of numericFields) {
    if (!Number.isFinite(Number(body[field]))) {
      return res.status(400).json({ ok: false, error: `${field} must be numeric` });
    }
  }

  const now = new Date().toISOString();
  mt5State.connected = true;
  mt5State.lastSeen = now;
  mt5State.account = body.account || mt5State.account;
  mt5State.symbols[symbol] = mt5State.symbols[symbol] || {};
  mt5State.symbols[symbol][timeframe] = {
    time: body.time || null,
    open: Number(body.open),
    high: Number(body.high),
    low: Number(body.low),
    close: Number(body.close),
    tickVolume: Number(body.tickVolume || 0),
    bid: Number(body.bid || 0),
    ask: Number(body.ask || 0),
    receivedAt: now
  };

  res.json({
    ok: true,
    symbol,
    timeframe,
    receivedAt: now,
    executionEnabled: false
  });
});

app.get('/api/mt5/status', (req, res) => {
  const ageMs = mt5State.lastSeen ? Date.now() - new Date(mt5State.lastSeen).getTime() : null;
  const live = ageMs !== null && ageMs < 30000;
  res.json({
    connected: live,
    lastSeen: mt5State.lastSeen,
    ageSeconds: ageMs === null ? null : Math.round(ageMs / 1000),
    account: mt5State.account,
    symbols: mt5State.symbols
  });
});

app.get('/api/orders/pending', bridgeAuth, (req, res) => {
  res.json({
    executionEnabled: false,
    orders: [],
    message: 'MT5 Bridge V1 is in signal/data mode only. Automatic execution is disabled.'
  });
});

app.post('/api/orders/report', bridgeAuth, (req, res) => {
  res.json({ ok: true, stored: false, executionEnabled: false });
});

app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, '0.0.0.0', () => console.log(`AI Trading SMC running on port ${PORT}`));

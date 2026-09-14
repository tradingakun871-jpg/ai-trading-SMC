// SMC engine scaffold. Market-data adapters and execution remain disabled until credentials are configured.
function buildTradingPlan({ symbol, bias = 'WAIT' }) {
  return {
    symbol,
    bias,
    sequence: ['liquidity_sweep', 'mss_m3', 'retest', 'limit_entry'],
    risk: { slPips: 50, tp1Pips: 50, tp2Pips: 100, breakEvenAfterPips: 30 },
    executionEnabled: false
  };
}
module.exports = { buildTradingPlan };

'use strict';

// NAS100 FVG / iFVG Telegram alert. The workflow reads this file on every run.
// Zone detection is not configured here: nas_alert.js loads fvgScan and FVG_CFG
// from js/nas.js, so the zones stay the ones the NAS page draws.
//
// proximity — points. Alert when the live price is inside an active zone or at
// most this far from the nearer edge. H1 is the desk's 20 points. M1/M5 are
// tighter so a small gap does not page on every wiggle; H4/D1 are wider because
// those gaps and the noise around them are larger.
//
// session
//   "market"  — whenever NAS100 is open (not the weekend, not the 17:00–18:00
//               New York break). In US winter that break is 05:00–06:00 Thai;
//               in US summer it is 04:00–05:00 Thai. Same rule as the NAS page.
//   "us-cash" — also inside usCash below (09:30–16:00 America/New_York).
//               Winter EST: 21:30–04:00 Thai. Summer EDT: 20:30–03:00 Thai.
//
// lookback — base candles to request, matching js/nas.js (chart history asks for
// 500*1.4, H4 asks for 1100 one-hour bars). D1 is longer because the page has
// no D1 chart: one-hour bars are folded with the page's aggD1 (day starts 17:00
// New York). H1, H4 and D1 share one hourly download of the longest lookback.

module.exports = {
  reminder: 'ยืนยันใน MT5 + รอ M1 EMA14/60 rejection + FVG เล็กทิศเดียวกันก่อนเข้า',
  dedupeDays: 120,
  usCash: { tz: 'America/New_York', start: '09:30', end: '16:00' },
  timeframes: [
    { id: '1',   label: 'M1',  enabled: true, proximity: 5,  session: 'us-cash', lookback: 700 },
    { id: '5',   label: 'M5',  enabled: true, proximity: 8,  session: 'us-cash', lookback: 700 },
    { id: '15',  label: 'M15', enabled: true, proximity: 12, session: 'market',  lookback: 700 },
    { id: '30',  label: 'M30', enabled: true, proximity: 16, session: 'market',  lookback: 700 },
    { id: '60',  label: 'H1',  enabled: true, proximity: 20, session: 'market',  lookback: 700 },
    { id: '240', label: 'H4',  enabled: true, proximity: 40, session: 'market',  lookback: 1100 },
    { id: 'D',   label: 'D1',  enabled: true, proximity: 80, session: 'market',  lookback: 2500 },
  ],
};

# AiTD Gold Live

Static XAUUSD live-chart site (Thai, dark, mobile-first). No server, no API keys. Works on GitHub Pages.

## What is live vs static
| Part | Source | Live? |
|---|---|---|
| Tab "TradingView (OANDA)" chart, EMA20/50, M1–H4 | TradingView free widget, `OANDA:XAUUSD` | Live (TradingView) |
| Tab "กราฟ + โซน" candles + zone bands + EMA20/50 | Binance Futures `XAUUSDT` (REST + WebSocket) → fallback OKX `XAU-USDT-SWAP` (REST + WebSocket) → fallback gold-api.com spot polling | Live (tick-by-tick on WS). Perp prices are shifted to spot by an auto offset |
| Spot reference + offset calibration | `https://api.gold-api.com/price/XAU` (CORS `*`, no key, ~30 s cache) | Every 15 s |
| Header price / today high-low | same as zone chart (offset-adjusted); day = from 17:00 New York | Live |
| Ticker strip, market quotes, economic calendar | TradingView free widgets | Live |
| Zones, event list | `zones.json`, `events.json` | Static, rewritten by `update_data.py` (page re-reads zones every 10 min) |
| Balance, floor, daily stop, today's P/L | typed by the user, saved in that browser's localStorage only | Never published |
| Clock, sessions, countdown | browser clock, `Asia/Bangkok` | Live |

URL options: `?feed=okx`, `?feed=binance`, `?feed=none` (forces spot-only fallback).

## Data files
- `zones.json` — copy of `/workspace/gold_zones.json`:
  `{date, source, zones:[{zone:[low,high], type:"resistance"|"pivot"|"support", note}], prev_day:{high,low,close}, week:{high,low}, bias}`.
  `prev_day.close` is the reference for the header change.
- `events.json` — `{events:[{title, title_en, country, impact, time:"ISO+07:00", forecast, previous}]}` (high-impact USD).
- `candles_seed.json` — optional static M15 seed used only by the spot-only fallback.

## Daily update
```
python3 update_data.py            # writes zones.json, events.json, candles_seed.json only
python3 update_data.py --no-net   # skip live ForexFactory fetch, use /workspace/hub/ff_week.json
```
No account data (balance, P/L, journal) is ever read or written by this script.

## Host on GitHub Pages
1. Create a repo (e.g. `aitd-gold-live`), copy this folder's contents to the repo root (keep `.nojekyll`; `screenshots/` optional).
2. `git add . && git commit -m "AiTD Gold Live" && git push`.
3. Repo → Settings → Pages → Source: "Deploy from a branch", Branch `main` / `/ (root)` → Save.
4. Site: `https://<user>.github.io/<repo>/`. Daily: run `update_data.py`, commit `zones.json` + `events.json`, push.

## Local test
`python3 -m http.server 8765` then open http://localhost:8765/ (opening the file directly will not load the JSON files).

# AiTD Gold Live

Static XAUUSD live-chart site (Thai, dark, mobile-first). No server, no API keys. Works on GitHub Pages.

## What is live vs static
| Part | Source | Live? |
|---|---|---|
| Tab "TradingView (OANDA)" chart, EMA20/50, M1–H4 | TradingView free widget, `OANDA:XAUUSD` | Live (TradingView) |
| Tab "กราฟ + โซน" candles + zone bands + EMA20/50 | **OKX index `XAU-USD`** (spot gold in USD, CORS `*`, no key): history from `/api/v5/market/history-index-candles` (M1/M5/M15/H1 native; H4 aggregated from H1 and anchored at 17:00 New York like OANDA/MT5), live from WebSocket `index-tickers` (REST poll fallback) → fallback Binance `XAUUSDT` / OKX `XAU-USDT-SWAP` perps shifted by an auto offset → fallback gold-api.com spot polling | Live (tick-by-tick). No offset needed for the index; bars inside the spot-market close (Fri 17:00 → Sun 18:00 NY and the daily 17:00–18:00 NY break) are dropped |
| Spot reference / cross-check | `https://api.gold-api.com/price/XAU` (CORS `*`, no key, ~30 s cache) — the info line shows the difference vs the chart | Every 15 s |
| Header price / today high-low | same as zone chart; day = from 17:00 New York | Live |
| Ticker strip, market quotes, economic calendar | TradingView free widgets | Live |
| Zones, event list | `zones.json`, `events.json` | Static, rewritten by `update_data.py` (page re-reads zones every 10 min) |
| Option OI levels (chart price lines + panel "ระดับจากออปชัน") | `options_levels.json` from `options_levels.py`: **Cboe delayed GLD options** + **SHFE au gold options** (proxies, not CME) | Daily (GitHub Actions `update-options.yml`) |
| Balance, floor, daily stop, today's P/L | typed by the user, saved in that browser's localStorage only | Never published |
| Clock, sessions, countdown | browser clock, `Asia/Bangkok` | Live |

URL options: `?feed=okxidx` (default), `?feed=okx`, `?feed=binance`, `?feed=none` (forces spot-only fallback).

## Data files
- `zones.json` — copy of `/workspace/gold_zones.json`:
  `{date, source, zones:[{zone:[low,high], type:"resistance"|"pivot"|"support", note}], prev_day:{high,low,close}, week:{high,low}, bias}`.
  `prev_day.close` is the reference for the header change.
- `events.json` — `{events:[{title, title_en, country, impact, time:"ISO+07:00", forecast, previous}]}` (high-impact USD).
- `candles_seed.json` — optional static M15 seed used only by the spot-only fallback (M15, aggregated for H1/H4).

- `options_levels.json` — `{gld:{...}, shfe:{...}, generated_at}`; each block: `source, source_url, data_date, conversion{...}, expiries:[{expiry|series, kind, underlying, call_oi_total, put_oi_total, pc_oi_ratio, max_pain{strike,level_spot}, call_walls:[{strike, level_spot, oi, oi_chg}], put_walls:[...], top_any}], fetched_at, stale`.
  Walls = top-5 OI strikes within ±10 % of the underlying. `level_spot` = strike × ratio (GLD: spot/GLD at the GLD quote time; SHFE: spot at 15:00 Beijing / au futures close, which bakes in USDCNY and the SHFE premium; both inputs are written in `conversion`). A failed source keeps its last good block with `stale: true`.
- `options_oi_state.json` — previous Cboe per-strike OI snapshot, used for GLD OI change (SHFE gives the change itself).

## Option levels automation
`.github/workflows/update-options.yml` runs `python3 options_levels.py` Mon–Fri at 07:40 & 09:10 UTC (14:40 / 16:10 Thai, after SHFE posts ~14:25 Thai) and 15:00 & 21:30 UTC (22:00 / 04:30 Thai, Cboe GLD after the OCC OI refresh and after the US close), plus manual `workflow_dispatch`, and commits `options_levels.json` + `options_oi_state.json` if they changed (default `GITHUB_TOKEN`, `contents: write`). Stdlib only. Manual: `python3 options_levels.py [--only gld|shfe]`.

## Daily update
```
python3 update_data.py            # writes zones.json, events.json, candles_seed.json (+ options_levels.json)
python3 update_data.py --no-options   # skip the option levels
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

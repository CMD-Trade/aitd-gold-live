# AiTD Gold Live

Static XAUUSD live-chart site (Thai, dark, mobile-first). No server, no API keys. Works on GitHub Pages.

## What is live vs static
| Part | Source | Live? |
|---|---|---|
| Tab "TradingView (OANDA)" chart, EMA20/50, M1/M5/M15/M30/H1/H4 | TradingView free widget, `OANDA:XAUUSD` | Live (TradingView) |
| Tab "กราฟ + โซน" candles + zone bands + EMA20/50 | **OKX index `XAU-USD`** (spot gold in USD, CORS `*`, no key): history from `/api/v5/market/history-index-candles` (M1/M5/M15/H1 native; H4 aggregated from H1 and anchored at 17:00 New York like OANDA/MT5), live from WebSocket `index-tickers` (REST poll fallback) → fallback Binance `XAUUSDT` / OKX `XAU-USDT-SWAP` perps shifted by an auto offset → fallback gold-api.com spot polling | Live (tick-by-tick). No offset needed for the index; bars inside the spot-market close (Fri 17:00 → Sun 18:00 NY and the daily 17:00–18:00 NY break) are dropped |
| Spot reference / cross-check | `https://api.gold-api.com/price/XAU` (CORS `*`, no key, ~30 s cache) — the info line shows the difference vs the chart | Every 15 s |
| Header price / today high-low | same as zone chart; day = from 17:00 New York | Live |
| Ticker strip, market quotes, economic calendar | TradingView free widgets | Live |
| Zones | `zones.json` — automatic public zones from `zones_auto.py` (OKX XAU-USD index H1) or the owner's hand-made file via `update_data.py` | Weekday 07:00 Thai (GitHub Actions `update-zones.yml`); page re-reads every 10 min |
| Event list ("ข่าวแรงถัดไป") | `events.json` from ForexFactory weekly JSON (`update_data.py --events-only`) | Hourly 07:05–23:05 Thai weekdays (`update-news.yml`) |
| Gold news panel "ข่าวทองล่าสุด" | `news.json` from `news.py`: public RSS headlines (Google News EN/TH, Reuters/Kitco/FXStreet via Google News, investingLive) with automatic keyword tags | Hourly 07:05–23:05 Thai weekdays (`update-news.yml`) |
| Volume Profile (chart overlay, toggle + period) | Shared engine `createVP` in `js/app.js`. Perp 5m/15m candle volume (oz) from **OKX `XAU-USDT-SWAP` → Bitget `XAUUSDT` → Binance `XAUUSDT`**, all requested at once (4 s timeouts, `raceFeeds`), first in that order wins — works in Thailand where okx.com is blocked. Source shown after “ที่มา”. Shifted onto the chart candles by median(perp close − chart close) over bars that close together, $1 bins, POC + 70 % value area. If every source fails: “Volume Profile โหลดไม่ได้” under the chart and on it, retried every minute | Client-side, every 60 s |
| NAS100 chart card (next to the gold chart: side by side ≥1100 px, directly under gold on mobile) | `js/nas.js`: **OKX index `US100-USDT`** (CORS, no key) — history `/api/v5/market/history-index-candles`, live WebSocket `index-tickers` (REST poll fallback), tail resync every 60 s; fallback OKX `US100-USDT-SWAP` perp. Same chart options, EMA20/50, M1/M5/M15/M30/H1/H4 (H4 anchored 17:00 NY) and broker-hours filter as gold. Bands from `nas_zones.json` drawn on the chart like gold zones (colour follows live price), inline NAS-only zone status (±15 pts), collapsible level list, second tab TradingView `SKILLING:US100` (the user's broker). Candles/price shifted per feed to Skilling US100 points (defaults OKX −12, Bitget −36, perp −30; user can set their own with “ปรับให้ตรง MT5”, saved in localStorage); ^NDX bands shifted −5. Volume Profile like gold (own toggle + period; OKX `US100-USDT-SWAP` → Bitget `NDX100USDT` perp volume, 5-pt bins, shifted onto the Skilling-offset candles so it follows “ปรับให้ตรง MT5”; crypto-perp NAS volume is tiny, so it is a rough guide only). No option lines for NAS (no free NDX option OI). Price can differ from MT5 by tens of points | Live; levels weekday 07:00 Thai with `update-zones.yml` |
| Option OI levels (chart price lines + panel "ระดับจากออปชัน") | `options_levels.json` from `options_levels.py`: **Cboe delayed GLD options** + **SHFE au gold options** (proxies, not CME) | Daily (GitHub Actions `update-options.yml`) |
| Balance, floor, daily stop, today's P/L | typed by the user, saved in that browser's localStorage only | Never published |
| Clock, sessions, countdown | browser clock, `Asia/Bangkok` | Live |

URL options: `?nastf=1|5|15|30|60|240`, `?nasvp=0|1`, `?nasvpp=today|asia|h24|week`, `?nasfeed=okxidx|perp` (NAS100 chart); `?feed=okxidx` (default), `?feed=okx`, `?feed=binance`, `?feed=none` (forces spot-only fallback); `?vp=0|1`, `?vpp=today|asia|h24|week` (Volume Profile), `?opt=gld|shfe`.

## Data files
- `zones.json` — `{date, source, zones:[{zone:[low,high], type:"resistance"|"pivot"|"support", note[, score]}], prev_day:{high,low,close}, week:{high,low}, bias, generated_at[, auto, pivot, asia, price_at_build]}`.
  `prev_day.close` is the reference for the header change. Either the owner's hand-made `/workspace/gold_zones.json` (copied by `update_data.py`)
  or the automatic file from `zones_auto.py` (`"auto": true`): previous trading day (17:00→17:00 New York) high/low/close, classic daily pivot P/R1/S1,
  this/last week high/low, last Asian session (07:00–15:00 Thai) high/low, H1 swings (last 3 days) and H4 swings (last 20 days), round $25 levels;
  candidates within $4 are merged into zones (≥$3 wide, ≤$10), 5–8 best-scoring zones within ±1.7 % of price are kept, each with a note listing its reasons.
  `zones_auto.py` never overwrites a hand-made zones.json already dated today (use `--force`), and keeps the old file on any failure.
- `news.json` — `{generated_at, note, sources:[{id,name,ok,parsed,fresh,used|error}], items:[{title, source, link, published:"ISO+07:00", feed, tags:[Thai], lean:"ทองบวก"|"ทองลบ"|"กลาง"}]}`.
  Headlines + links only (no article text). ≤30 items from the last 48 h, deduped, merged with the previous file; tags and lean are keyword rules on the headline.
- `events.json` — `{events:[{title, title_en, country, impact, time:"ISO+07:00", forecast, previous}]}` (high-impact USD).
- `candles_seed.json` — optional static M15 seed used only by the spot-only fallback (M15, aggregated for H1/H4).

- `nas_zones.json` — `{date, auto, symbol:"^NDX", chart_symbol, source, last_close:{date,close}, prev_day:{date,open,high,low,close}, week:{start,days,high,low}|null, prev_week:{start,high,low,close}, pivot, levels:[{price, type:"resistance"|"support"|"pivot", label, note}], zones:[{zone:[price-10, price+10], type, level, label, note}], generated_at}`.
  Built by `nas_zones.py` from completed US cash sessions only: previous day high/low/close, classic pivot, this/previous week high/low, 3 round-100 levels above and below the last close; levels within 20 points merged. Cash index ≠ broker CFD (can differ by tens of points). Keeps the old file on failure. Gold zone banner/checklist ignore it.
- `options_levels.json` — `{gld:{...}, shfe:{...}, generated_at}`; each block: `source, source_url, data_date, conversion{...}, expiries:[{expiry|series, kind, underlying, call_oi_total, put_oi_total, pc_oi_ratio, max_pain{strike,level_spot}, call_walls:[{strike, level_spot, oi, oi_chg}], put_walls:[...], top_any}], fetched_at, stale`.
  Walls = top-5 OI strikes within ±10 % of the underlying. `level_spot` = strike × ratio (GLD: spot/GLD at the GLD quote time; SHFE: spot at 15:00 Beijing / au futures close, which bakes in USDCNY and the SHFE premium; both inputs are written in `conversion`). A failed source keeps its last good block with `stale: true`.
- `options_oi_state.json` — previous Cboe per-strike OI snapshot, used for GLD OI change (SHFE gives the change itself).

## Option levels automation
`.github/workflows/update-options.yml` runs `python3 options_levels.py` Mon–Fri at 07:40 & 09:10 UTC (14:40 / 16:10 Thai, after SHFE posts ~14:25 Thai) and 15:00 & 21:30 UTC (22:00 / 04:30 Thai, Cboe GLD after the OCC OI refresh and after the US close), plus manual `workflow_dispatch`, and commits `options_levels.json` + `options_oi_state.json` if they changed (default `GITHUB_TOKEN`, `contents: write`). Stdlib only. Manual: `python3 options_levels.py [--only gld|shfe]`.

## Zones + news automation
- `.github/workflows/update-zones.yml`: `python3 zones_auto.py` at 00:00 UTC Mon–Fri (07:00 Thai) + `workflow_dispatch`; commits `zones.json` if changed.
- `.github/workflows/update-news.yml`: `python3 news.py` and `python3 update_data.py --events-only` at :05 every hour 00–16 UTC Mon–Fri (07:05–23:05 Thai) + `workflow_dispatch`; commits `news.json` + `events.json` if changed.
GitHub may start scheduled runs several minutes late. All scripts are stdlib-only and need no secrets beyond the default `GITHUB_TOKEN` (`contents: write`).

## Daily update
```
python3 update_data.py            # writes zones.json, events.json, candles_seed.json (+ options_levels.json)
python3 update_data.py --no-options   # skip the option levels
python3 update_data.py --no-net   # skip live ForexFactory fetch, use /workspace/hub/ff_week.json
python3 update_data.py --events-only  # events.json only (keeps the old file if ForexFactory fails)
python3 zones_auto.py [--force] [--dry]   # automatic zones.json from OKX index candles
python3 news.py [--dry]           # news.json from public RSS
python3 nas_zones.py [--dry]      # nas_zones.json (NAS100 reference levels) from Yahoo ^NDX daily bars
```
If `/workspace/gold_zones.json` is missing, `update_data.py` falls back to `zones_auto.py`.
No account data (balance, P/L, journal) is ever read or written by this script.

## Host on GitHub Pages
1. Create a repo (e.g. `aitd-gold-live`), copy this folder's contents to the repo root (keep `.nojekyll`; `screenshots/` optional).
2. `git add . && git commit -m "AiTD Gold Live" && git push`.
3. Repo → Settings → Pages → Source: "Deploy from a branch", Branch `main` / `/ (root)` → Save.
4. Site: `https://<user>.github.io/<repo>/`. Daily: run `update_data.py`, commit `zones.json` + `events.json`, push.

## Local test
`python3 -m http.server 8765` then open http://localhost:8765/ (opening the file directly will not load the JSON files).

## Zone guard + เช็กก่อนกด
- แบนเนอร์ติดหัวจอ (sticky) เทียบราคาสด OKX XAU-USD index กับ: โซน `support`/`resistance` ใน zones.json (ไม่นับ pivot), Put wall/Call wall ของ GLD และ SHFE (expiry/ซีรีส์แรกเท่านั้น), VAL/VAH ของ Volume Profile (เมื่อเปิด VP)
- เกณฑ์ระยะ `ZONE_NEAR_USD = 3` (ต้นไฟล์ js/app.js) · ในแนวรับ = ห้าม SELL · ในแนวต้าน = ห้าม BUY · ติดทั้งสองฝั่ง = ห้ามทั้งคู่
- ปุ่ม 🔕/🔔 = เสียง beep + Notification ตอนเข้าโซน (ปิดเป็นค่าเริ่มต้น, เก็บใน localStorage)
- การ์ด "เช็กก่อนกด" 7 ข้อ เก็บใน localStorage เท่านั้น ล้างเองหลัง 30 นาที (`CHECK_EXPIRE_MIN`)
- ทดสอบ: `?testprice=4030` บังคับราคาสำหรับแบนเนอร์/เช็กลิสต์ (กราฟไม่เปลี่ยน)

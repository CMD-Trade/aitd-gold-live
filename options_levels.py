#!/usr/bin/env python3
"""AiTD Gold Live — option open-interest levels -> options_levels.json  (Python stdlib only).

Two PROXY sources (neither is CME/COMEX; CME blocks automated access):
  gld  : Cboe delayed quotes  https://cdn.cboe.com/api/global/delayed_quotes/options/GLD.json
         (SPDR Gold Shares ETF options; OI as published by Cboe/OCC = positions at the previous settlement)
  shfe : Shanghai Futures Exchange daily option data  https://www.shfe.com.cn/data/tradedata/option/dailydata/kxYYYYMMDD.dat
         (au gold options on au futures, strikes in CNY/gram; OPENINTERESTCHG = official OI change vs previous day)
         + futures file .../future/dailydata/kxYYYYMMDD.dat for the underlying au close price.

Conversion to spot XAUUSD (what the chart shows, OKX XAU-USD spot index):
  gld  : ratio = spot_at_GLD_quote_time / GLD_price      level_spot = strike * ratio
  shfe : ratio = spot_at_SHFE_close(15:00 Beijing) / au_futures_close   level_spot = strike * ratio
         (this one ratio contains USDCNY, the g->oz factor 31.1035 and the SHFE-vs-London premium; USDCNY and the
          premium are also written out separately for transparency)
  spot : OKX index candles  https://www.okx.com/api/v5/market/history-index-candles?instId=XAU-USD (1m close)
  fx   : https://api.frankfurter.dev (ECB reference rate), fallback https://open.er-api.com (documentation only)

Walls = largest OI strikes within +-WINDOW of the underlying (far-OTM lottery strikes are listed in top_any).
Max pain = strike that minimises total intrinsic value paid to holders (sum over calls+puts of OI*intrinsic).
If a source fails, the previous good block is kept and marked "stale": true with the error.
No account / balance data is read or written.

Usage: python3 options_levels.py [--only gld|shfe]
"""
import json, sys, time, gzip, datetime as dt, urllib.request, re
from pathlib import Path

SITE = Path(__file__).resolve().parent
OUT = SITE / "options_levels.json"
STATE = SITE / "options_oi_state.json"          # previous GLD per-strike OI (for OI change)
TH = dt.timezone(dt.timedelta(hours=7))
CN = dt.timezone(dt.timedelta(hours=8))
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
      "Accept": "application/json, text/plain, */*", "Accept-Encoding": "gzip"}
WINDOW = 0.10
TOP = 5
OZ = 31.1034768


def now_th():
    return dt.datetime.now(TH).isoformat(timespec="seconds")


def get_json(url, tries=3, timeout=30):
    err = None
    for i in range(tries):
        try:
            r = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout)
            b = r.read()
            if r.headers.get("Content-Encoding") == "gzip":
                b = gzip.decompress(b)
            return json.loads(b.decode("utf-8"))
        except Exception as e:
            err = e
            time.sleep(2 * (i + 1))
    raise RuntimeError(f"{url}: {err}")


def spot_at(ms):
    """OKX XAU-USD index 1m close of the minute containing ms (UTC epoch ms)."""
    m = ms // 60000 * 60000
    d = get_json(f"https://www.okx.com/api/v5/market/history-index-candles?instId=XAU-USD&bar=1m&after={m + 60000}&limit=3")
    rows = d.get("data") or []
    for k in rows:
        if int(k[0]) == m:
            return float(k[4]), int(k[0])
    if rows:   # nearest earlier minute (e.g. market break)
        k = rows[0]
        if int(k[0]) > m:
            raise RuntimeError("OKX candle after requested time")
        if m - int(k[0]) <= 3 * 3600e3:
            return float(k[4]), int(k[0])
    raise RuntimeError(f"no OKX index candle near {ms}")


def usdcny():
    try:
        d = get_json("https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY", tries=2)
        return float(d["rates"]["CNY"]), f"ECB via frankfurter.dev ({d['date']})"
    except Exception:
        d = get_json("https://open.er-api.com/v6/latest/USD", tries=2)
        return float(d["rates"]["CNY"]), f"open.er-api.com ({d.get('time_last_update_utc', '')})"


def fnum(*vals):
    for v in vals:
        try:
            if v not in ("", None):
                return float(v)
        except (TypeError, ValueError):
            pass
    return None


def max_pain(calls, puts):
    ks = sorted(set(calls) | set(puts))
    best = None
    for s in ks:
        pain = sum(oi * (s - k) for k, oi in calls.items() if s > k) + sum(oi * (k - s) for k, oi in puts.items() if k > s)
        if best is None or pain < best[1]:
            best = (s, pain)
    return best[0] if best else None


def summarise(calls, puts, under, ratio, chg=None, unit=""):
    """calls/puts: {strike: oi}. Returns metrics dict."""
    lo, hi = under * (1 - WINDOW), under * (1 + WINDOW)
    rnd = lambda x: round(x, 2)
    def lv(k, oi, typ):
        d = {"type": typ, "strike": k, "level_spot": rnd(k * ratio), "oi": int(oi)}
        if chg is not None and (typ, k) in chg:
            d["oi_chg"] = int(chg[(typ, k)])
        return d
    near = lambda side: sorted(((k, v) for k, v in side.items() if lo <= k <= hi and v > 0), key=lambda x: -x[1])[:TOP]
    anyk = lambda side: sorted(((k, v) for k, v in side.items() if v > 0), key=lambda x: -x[1])[:3]
    tc, tp = sum(calls.values()), sum(puts.values())
    mp = max_pain(calls, puts)
    return {
        "underlying": under, "window_pct": WINDOW * 100,
        "call_oi_total": int(tc), "put_oi_total": int(tp),
        "pc_oi_ratio": round(tp / tc, 3) if tc else None,
        "max_pain": {"strike": mp, "level_spot": rnd(mp * ratio)} if mp is not None else None,
        "call_walls": [lv(k, v, "call") for k, v in near(calls)],
        "put_walls": [lv(k, v, "put") for k, v in near(puts)],
        "top_any": {"call": [[k, int(v)] for k, v in anyk(calls)], "put": [[k, int(v)] for k, v in anyk(puts)]},
        "strike_unit": unit,
    }


# ---------------------------------------------------------------- GLD (Cboe)
def third_friday(y, m):
    d = dt.date(y, m, 15)
    return d + dt.timedelta(days=(4 - d.weekday()) % 7)


def is_monthly(d):
    tf = third_friday(d.year, d.month)
    return d == tf or d == tf - dt.timedelta(days=1)   # Thursday when the Friday is a holiday


def us_eastern_offset(d):
    """EDT (-4) between 2nd Sun Mar and 1st Sun Nov, else EST (-5)."""
    y = d.year
    m2 = dt.date(y, 3, 8); dst_start = m2 + dt.timedelta(days=(6 - m2.weekday()) % 7)
    n1 = dt.date(y, 11, 1); dst_end = n1 + dt.timedelta(days=(6 - n1.weekday()) % 7)
    return -4 if dst_start <= d < dst_end else -5


def et_now(now=None):
    """(date, datetime) in New York now. OPT_NOW=ISO-UTC overrides the clock for tests."""
    import os
    now = now or (dt.datetime.fromisoformat(os.environ["OPT_NOW"]) if os.environ.get("OPT_NOW") else dt.datetime.now(dt.timezone.utc))
    off = us_eastern_offset(now.date())
    t = now.astimezone(dt.timezone(dt.timedelta(hours=off)))
    off2 = us_eastern_offset(t.date())
    if off2 != off:
        t = now.astimezone(dt.timezone(dt.timedelta(hours=off2)))
    return t.date(), t


def gld_close_th(e):
    """16:00 New York on expiry day e, as Thai time ISO."""
    return dt.datetime.combine(e, dt.time(16), dt.timezone(dt.timedelta(hours=us_eastern_offset(e)))).astimezone(TH).isoformat(timespec="minutes")


def shfe_last_trade(ser):
    """SHFE au option last trading day ≈ 5th-last weekday of the month before the futures delivery month
    (Chinese holidays ignored, so it is an estimate)."""
    y, m = 2000 + int(ser[:2]), int(ser[2:])
    y, m = (y - 1, 12) if m == 1 else (y, m - 1)
    d = (dt.date(y + (m == 12), m % 12 + 1, 1) - dt.timedelta(days=1))
    n = 0
    while True:
        if d.weekday() < 5:
            n += 1
            if n == 5:
                return d
        d -= dt.timedelta(days=1)


def do_gld(prev_block):
    url = "https://cdn.cboe.com/api/global/delayed_quotes/options/GLD.json"
    d = get_json(url, timeout=60)
    q = d["data"]
    ltt = dt.datetime.fromisoformat(q["last_trade_time"])            # New York local time
    et = dt.timezone(dt.timedelta(hours=us_eastern_offset(ltt.date())))
    ltt = ltt.replace(tzinfo=et)
    gld_px = float(q["current_price"])
    spot, spot_ms = spot_at(int(ltt.timestamp() * 1000))
    ratio = spot / gld_px
    by = {}
    for o in q["options"]:
        m = re.match(r"GLD(\d{6})([CP])(\d{8})$", o["option"])
        if not m:
            continue
        e = dt.datetime.strptime(m.group(1), "%y%m%d").date()
        by.setdefault(e, ({}, {}))[0 if m.group(2) == "C" else 1][int(m.group(3)) / 1000] = fnum(o.get("open_interest")) or 0.0
    # Auto-roll: keep only expiries that have NOT expired yet, judged by the clock (New York), not by the quote date —
    # a GLD option stops trading at 16:00 ET on its expiry day. So the expiring weekly stays on its last day (it pins
    # price that session) and drops out at the first run after 16:00 ET (21:30 UTC cron = 04:30 Thai next morning).
    today_et, now_et = et_now()
    alive = lambda e: e > today_et or (e == today_et and now_et.hour < 16)
    exps = sorted(e for e in by if alive(e) and sum(by[e][0].values()) + sum(by[e][1].values()) > 0)
    if not exps:
        raise RuntimeError("no live GLD expiries")
    tot = lambda e: sum(by[e][0].values()) + sum(by[e][1].values())
    # GLD lists daily expiries; "front weekly" = the biggest-OI expiry within the next 8 days (normally Friday)
    wk = [e for e in exps if (e - today_et).days <= 8] or exps[:1]
    front = max(wk, key=tot)
    pick = [(front, "front weekly")]
    mon = next((e for e in exps if is_monthly(e)), None)
    # when the front weekly expires within 2 days, also publish the next weekly so the site can roll by itself
    if (front - today_et).days <= 2:
        nx = [e for e in exps if front < e <= front + dt.timedelta(days=8) and e != mon]
        if nx:
            pick.append((max(nx, key=tot), "next weekly"))
    if mon and mon != front:
        pick.append((mon, "monthly"))
    elif mon == front:
        pick[0] = (mon, "front weekly + monthly")

    # OI change vs the previous distinct Cboe OI snapshot (Cboe has no change field)
    st = json.loads(STATE.read_text()) if STATE.exists() else {}
    cur = {e.isoformat(): {"C": {str(k): v for k, v in by[e][0].items()}, "P": {str(k): v for k, v in by[e][1].items()}} for e, _ in pick}
    sig = json.dumps(cur, sort_keys=True)
    g = st.get("gld", {})
    if g.get("sig_cur") != sig:
        g = {"prev": g.get("cur"), "prev_quote": g.get("cur_quote"), "cur": cur, "cur_quote": ltt.isoformat(), "sig_cur": sig}
        st["gld"] = g
        STATE.write_text(json.dumps(st, separators=(",", ":")) + "\n")
    prev = g.get("prev") or {}

    exp_out = []
    for e, kind in pick:
        chg = None
        pe = prev.get(e.isoformat())
        if pe:
            chg = {}
            for typ, side, key in (("call", by[e][0], "C"), ("put", by[e][1], "P")):
                for k, v in side.items():
                    chg[(typ, k)] = v - float(pe[key].get(str(k), 0))
        s = summarise(by[e][0], by[e][1], gld_px, ratio, chg, "USD per GLD share")
        s.update({"expiry": e.isoformat(), "kind": kind, "expires_at_th": gld_close_th(e)})
        exp_out.append(s)
    return {
        "source": "Cboe delayed quotes GLD.json (SPDR Gold Shares ETF options; proxy, not CME)",
        "source_url": url,
        "quote_time": ltt.isoformat(), "quote_time_th": ltt.astimezone(TH).isoformat(timespec="minutes"),
        "data_date": ltt.date().isoformat(),
        "oi_note": "OI = OCC open interest published by Cboe (positions as of the previous settlement)",
        "oi_chg_vs": g.get("prev_quote"),
        "conversion": {"method": "level_spot = strike * spot / GLD", "gld_price": gld_px, "spot": spot,
                       "spot_time": dt.datetime.fromtimestamp(spot_ms / 1000, TH).isoformat(timespec="minutes"),
                       "spot_source": "OKX XAU-USD index 1m close", "ratio": round(ratio, 5)},
        "expiries": exp_out, "fetched_at": now_th(), "stale": False,
    }


# ---------------------------------------------------------------- SHFE au
def do_shfe(prev_block):
    base = "https://www.shfe.com.cn/data/tradedata/{}/dailydata/kx{}.dat"
    day = dt.datetime.now(CN).date()
    opt = fut = None; errs = []
    nowcn = dt.datetime.now(CN)
    for i in range(10):
        dd = day - dt.timedelta(days=i)
        if dt.datetime.combine(dd, dt.time(15, 30), CN) > nowcn:
            continue                      # day session (closes 15:00 Beijing) not finished yet
        ds = dd.strftime("%Y%m%d")
        try:
            o = get_json(base.format("option", ds), tries=2)
            rows = [r for r in o.get("o_curinstrument", []) if str(r.get("PRODUCTGROUPID", "")).strip() == "au"]
            if not rows:
                continue
            f = get_json(base.format("future", ds), tries=2)
            fut = {r["DELIVERYMONTH"]: r for r in f["o_curinstrument"] if str(r.get("PRODUCTGROUPID", "")).strip() == "au"}
            if not any(fnum(r.get("CLOSEPRICE")) for r in fut.values()):
                continue                  # partial (in-session) file
            opt, ds_ok = (o, rows), ds
            break
        except Exception as e:
            errs.append(str(e)[:120])
    if not opt:
        raise RuntimeError("no complete SHFE option file in last 10 days: " + "; ".join(errs[-2:]))
    o, rows = opt
    series = {}
    for r in rows:
        iid = str(r["INSTRUMENTID"]).strip()
        m = re.match(r"au(\d{4})([CP])(\d+)$", iid)
        if not m:
            continue
        s = series.setdefault(m.group(1), {"C": {}, "P": {}, "chg": {}})
        k = float(m.group(3)); typ = "call" if m.group(2) == "C" else "put"
        s[m.group(2)][k] = fnum(r.get("OPENINTEREST")) or 0.0
        s["chg"][(typ, k)] = fnum(r.get("OPENINTERESTCHG")) or 0.0
    tot = {k: sum(v["C"].values()) + sum(v["P"].values()) for k, v in series.items()}
    active = max(tot, key=tot.get)
    picks = [(active, "active (largest OI)")]
    front = min(k for k in tot if tot[k] > 0)
    if front != active and tot[front] >= 0.05 * tot[active]:
        picks.insert(0, (front, "front"))
    # underlying + conversion: spot at the 15:00 Beijing close of that day
    rd = dt.datetime.strptime(ds_ok, "%Y%m%d").replace(tzinfo=CN)
    close_dt = rd.replace(hour=15)
    spot, spot_ms = spot_at(int(close_dt.timestamp() * 1000) - 60000)
    fx, fx_src = usdcny()
    exp_out = []; conv = {}
    for ser, kind in picks:
        fr = fut.get(ser)
        if not fr:
            continue
        fclose = fnum(fr.get("CLOSEPRICE"), fr.get("SETTLEMENTPRICE"))
        if not fclose:
            continue
        ratio = spot / fclose
        fusd = fclose * OZ / fx
        conv[ser] = {"au_future": "au" + ser, "au_close_cny_g": fclose, "au_settle_cny_g": fnum(fr.get("SETTLEMENTPRICE")),
                     "au_close_usd_oz": round(fusd, 2), "premium_usd_oz_vs_spot": round(fusd - spot, 2), "ratio": round(ratio, 5)}
        s = series[ser]
        out = summarise(s["C"], s["P"], fclose, ratio, s["chg"], "CNY per gram")
        lt = shfe_last_trade(ser)
        out.update({"series": "au" + ser, "kind": kind, "expiry_est": lt.isoformat(),
                    "expires_at_th": dt.datetime.combine(lt, dt.time(15), CN).astimezone(TH).isoformat(timespec="minutes")})
        exp_out.append(out)
    return {
        "source": "Shanghai Futures Exchange daily option data (au gold options; proxy, not CME)",
        "source_url": base.format("option", ds_ok),
        "data_date": rd.date().isoformat(), "exchange_update": o.get("update_date"),
        "oi_note": "OI at the SHFE day-session close (15:00 Beijing = 14:00 Thai); oi_chg = official change vs previous day",
        "conversion": {"method": "level_spot = strike(CNY/g) * spot / au_futures_close(CNY/g)", "spot": spot,
                       "spot_time": dt.datetime.fromtimestamp(spot_ms / 1000, TH).isoformat(timespec="minutes"),
                       "spot_source": "OKX XAU-USD index 1m close at 15:00 Beijing", "usdcny": fx, "usdcny_source": fx_src,
                       "grams_per_oz": OZ, "series": conv},
        "expiries": exp_out, "fetched_at": now_th(), "stale": False,
    }


def strip_volatile(b):
    return {k: v for k, v in (b or {}).items() if k not in ("fetched_at", "stale", "error")}


def main(argv):
    only = argv[argv.index("--only") + 1] if "--only" in argv else None
    old = json.loads(OUT.read_text()) if OUT.exists() else {}
    new = dict(old)
    changed = False
    for name, fn in (("gld", do_gld), ("shfe", do_shfe)):
        if only and name != only:
            continue
        try:
            b = fn(old.get(name))
            if strip_volatile(b) != strip_volatile(old.get(name)) or (old.get(name) or {}).get("stale"):
                new[name] = b; changed = True
                print(f"{name}: updated ({b['data_date']})")
            else:
                print(f"{name}: unchanged")
        except Exception as e:
            print(f"{name}: FAILED {e}", file=sys.stderr)
            if old.get(name):
                if not old[name].get("stale"):
                    new[name] = dict(old[name], stale=True, error=str(e)[:300], failed_at=now_th()); changed = True
            else:
                new[name] = {"stale": True, "error": str(e)[:300], "failed_at": now_th(), "expiries": []}; changed = True
    if changed or not OUT.exists():
        new["generated_at"] = now_th()
        new["_note"] = ("Option open-interest levels from PROXY markets (GLD ETF options via Cboe; SHFE au options). "
                        "Not CME/COMEX data, not trade signals. level_spot = strike converted to spot XAUUSD.")
        OUT.write_text(json.dumps(new, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print("wrote options_levels.json")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

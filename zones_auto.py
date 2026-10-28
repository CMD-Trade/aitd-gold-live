#!/usr/bin/env python3
"""AiTD Gold Live — automatic public zones -> zones.json (Python stdlib only).

Data: OKX XAU-USD spot index H1 candles (public REST, same source as the chart):
  https://www.okx.com/api/v5/market/history-index-candles?instId=XAU-USD&bar=1H
Trading day = 17:00 New York -> 17:00 New York (broker day); bars inside the spot close
(Fri 17:00 -> Sun 18:00 NY, daily 17:00-18:00 NY) are ignored, like the chart.

Candidate levels (weight):
  previous day high/low (3), previous close (1), daily pivot P (2) / R1 S1 (1),
  this week high/low (2), previous week high/low (1.5), last Asian session high/low (07:00-15:00 Thai) (1.5),
  H1 swing highs/lows of the last 3 days (1 each, fractal 3 left/3 right),
  H4 swing highs/lows of the last 20 days (1.5 each, fractal 2/2), round 25s near price (0.5).
Candidates within CLUSTER $ of each other are merged into one zone [min-PAD, max+PAD]; the zone holding the
daily-pivot zone is typed "pivot", others resistance (mid above price) / support (mid below). Best-scoring 5-8 zones within
+-RANGE_PCT of price are kept (at least 2 above and 2 below when available).

Keeps the previous zones.json if anything fails or the result looks wrong. Does not overwrite a hand-made
zones.json already dated today (no "auto": true) unless --force. No account data anywhere.
Usage: python3 zones_auto.py [--force] [--dry]
"""
import json, sys, time, gzip, datetime as dt, urllib.request
from pathlib import Path

SITE = Path(__file__).resolve().parent
OUT = SITE / "zones.json"
TH = dt.timezone(dt.timedelta(hours=7))
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36", "Accept-Encoding": "gzip"}
CLUSTER, PAD, MIN_W, MAX_W = 4.0, 1.0, 3.0, 10.0
RANGE_PCT, MIN_GAP = 1.7, 2.0


def get_json(url, tries=4):
    err = None
    for i in range(tries):
        try:
            r = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=25)
            b = r.read()
            if r.headers.get("Content-Encoding") == "gzip":
                b = gzip.decompress(b)
            d = json.loads(b)
            if d.get("code") not in ("0", 0):
                raise RuntimeError(d.get("msg"))
            return d["data"]
        except Exception as e:
            err = e; time.sleep(1.5 * (i + 1))
    raise RuntimeError(f"{url}: {err}")


def ny_off(ms):
    d = dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc)
    y = d.year
    m8 = dt.datetime(y, 3, 8, 7, tzinfo=dt.timezone.utc); start = m8 + dt.timedelta(days=(6 - m8.weekday()) % 7)
    n1 = dt.datetime(y, 11, 1, 6, tzinfo=dt.timezone.utc); end = n1 + dt.timedelta(days=(6 - n1.weekday()) % 7)
    return -4 if start <= d < end else -5


def ny(ms):
    return dt.datetime.fromtimestamp(ms / 1000, dt.timezone(dt.timedelta(hours=ny_off(ms))))


def closed(ms):
    t = ny(ms); wd, h = t.weekday(), t.hour
    return (wd == 4 and h >= 17) or wd == 5 or (wd == 6 and h < 18) or h == 17


def day_key(ms):
    """broker trading day = NY date of (time + 7h)  (17:00 NY starts the next day)"""
    return (ny(ms) + dt.timedelta(hours=7)).date()


def fetch_h1(n_bars=720):
    rows, after = [], None
    while len(rows) < n_bars:
        url = "https://www.okx.com/api/v5/market/history-index-candles?instId=XAU-USD&bar=1H&limit=100" + (f"&after={after}" if after else "")
        d = get_json(url)
        if not d:
            break
        rows += d; after = d[-1][0]
        time.sleep(0.25)
    bars = {}
    for k in rows:
        ms = int(k[0])
        if not closed(ms):
            bars[ms] = {"t": ms, "o": float(k[1]), "h": float(k[2]), "l": float(k[3]), "c": float(k[4])}
    return [bars[k] for k in sorted(bars)]


def swings(bars, left, right):
    out = []
    for i in range(left, len(bars) - right):
        h, l = bars[i]["h"], bars[i]["l"]
        if all(h >= bars[j]["h"] for j in range(i - left, i + right + 1) if j != i):
            out.append(("H", h, bars[i]["t"]))
        if all(l <= bars[j]["l"] for j in range(i - left, i + right + 1) if j != i):
            out.append(("L", l, bars[i]["t"]))
    return out


def h4(bars):
    """H4 anchored at 17:00 NY (17,21,1,5,9,13)."""
    g = {}
    for b in bars:
        t = ny(b["t"]); hrs = (t.hour - 17) % 24
        key = (day_key(b["t"]), hrs // 4)
        x = g.get(key)
        if not x:
            g[key] = dict(b)
        else:
            x["h"] = max(x["h"], b["h"]); x["l"] = min(x["l"], b["l"]); x["c"] = b["c"]
    return [g[k] for k in sorted(g, key=lambda k: g[k]["t"])]


def ema(vals, n):
    k, e = 2 / (n + 1), None
    for v in vals:
        e = v if e is None else v * k + e * (1 - k)
    return e


def thai(ms):
    return dt.datetime.fromtimestamp(ms / 1000, TH).strftime("%d/%m %H:%M")


def build():
    bars = fetch_h1()
    if len(bars) < 200:
        raise RuntimeError(f"only {len(bars)} H1 bars")
    now_ms = int(time.time() * 1000)
    price = bars[-1]["c"]
    days = {}
    for b in bars:
        days.setdefault(day_key(b["t"]), []).append(b)
    keys = sorted(days)
    today = day_key(now_ms)
    done = [k for k in keys if k < today]
    pd_ = days[done[-1]]
    P = {"high": max(b["h"] for b in pd_), "low": min(b["l"] for b in pd_), "close": pd_[-1]["c"]}
    piv = (P["high"] + P["low"] + P["close"]) / 3
    r1, s1 = 2 * piv - P["low"], 2 * piv - P["high"]
    # weeks (Mon..Fri trading days; Sunday-evening open belongs to Monday's trading day)
    wk = lambda d: d.isocalendar()[:2]
    cw = [b for k in keys if wk(k) == wk(today) for b in days[k]]
    pw = [b for k in keys if wk(k) == wk(today - dt.timedelta(days=7)) for b in days[k]]
    week = {"high": max(b["h"] for b in cw), "low": min(b["l"] for b in cw)} if cw else None
    pweek = {"high": max(b["h"] for b in pw), "low": min(b["l"] for b in pw)} if pw else None
    # last completed Asian session 07:00-15:00 Thai
    asia = []
    for back in range(0, 6):
        d = (dt.datetime.fromtimestamp(now_ms / 1000, TH) - dt.timedelta(days=back)).date()
        a0 = dt.datetime.combine(d, dt.time(7), TH).timestamp() * 1000
        a1 = a0 + 8 * 3600e3
        if a1 > now_ms:
            continue
        asia = [b for b in bars if a0 <= b["t"] < a1]
        if len(asia) >= 5:
            break
    C = []   # (price, weight, reason)
    add = lambda p, w, r: C.append((round(p, 2), w, r))
    add(P["high"], 3, f"High เมื่อวาน {P['high']:.2f}"); add(P["low"], 3, f"Low เมื่อวาน {P['low']:.2f}")
    add(P["close"], 1, f"ปิดเมื่อวาน {P['close']:.2f}")
    add(piv, 2, f"Pivot รายวัน {piv:.2f}"); add(r1, 1, f"R1 {r1:.2f}"); add(s1, 1, f"S1 {s1:.2f}")
    if week:
        add(week["high"], 2, f"High สัปดาห์นี้ {week['high']:.2f}"); add(week["low"], 2, f"Low สัปดาห์นี้ {week['low']:.2f}")
    if pweek:
        add(pweek["high"], 1.5, f"High สัปดาห์ก่อน {pweek['high']:.2f}"); add(pweek["low"], 1.5, f"Low สัปดาห์ก่อน {pweek['low']:.2f}")
    if asia:
        ah, al = max(b["h"] for b in asia), min(b["l"] for b in asia)
        add(ah, 1.5, f"High เอเชีย {ah:.2f}"); add(al, 1.5, f"Low เอเชีย {al:.2f}")
    cut3 = now_ms - 3 * 86400e3
    for typ, p, t in swings([b for b in bars if b["t"] >= cut3 - 4 * 3600e3], 3, 3):
        if t >= cut3:
            add(p, 1, f"H1 swing {'high' if typ == 'H' else 'low'} {p:.2f} ({thai(t)})")
    H4 = h4(bars)
    cut20 = now_ms - 20 * 86400e3
    for typ, p, t in swings(H4, 2, 2):
        if t >= cut20:
            add(p, 1.5, f"H4 swing {'high' if typ == 'H' else 'low'} {p:.2f} ({thai(t)})")
    lo, hi = price * (1 - RANGE_PCT / 100), price * (1 + RANGE_PCT / 100)
    for r in range(int(lo // 25) * 25, int(hi) + 25, 25):
        add(r, 1.0 if r % 100 == 0 else 0.5, f"เลขกลม {r}")
    # cluster
    C = sorted(c for c in C if lo - 10 <= c[0] <= hi + 10)
    clusters = []
    for c in C:
        if clusters and c[0] - clusters[-1][0][0] <= CLUSTER * 2 and c[0] - clusters[-1][-1][0] <= CLUSTER:
            clusters[-1].append(c)
        else:
            clusters.append([c])
    def split(cl):   # break an over-wide cluster at its largest internal gap
        if len(cl) < 2 or cl[-1][0] - cl[0][0] + 2 * PAD <= MAX_W:
            return [cl]
        i = max(range(1, len(cl)), key=lambda j: cl[j][0] - cl[j - 1][0])
        return split(cl[:i]) + split(cl[i:])
    clusters = [c for cl in clusters for c in split(cl)]
    zones = []
    for cl in clusters:
        a, b = cl[0][0] - PAD, cl[-1][0] + PAD
        if b - a < MIN_W:
            m = (a + b) / 2; a, b = m - MIN_W / 2, m + MIN_W / 2
        score = sum(x[1] for x in cl)
        if all(x[2].startswith("เลขกลม") for x in cl):
            score *= 0.6
        a, b = round(a * 2) / 2, round(b * 2) / 2
        has_piv = any(x[2].startswith("Pivot") for x in cl)
        typ = "pivot" if has_piv else ("resistance" if (a + b) / 2 > price else "support")
        reasons = []
        for x in sorted(cl, key=lambda x: -x[1]):
            if x[2] not in reasons:
                reasons.append(x[2])
        dist = abs((a + b) / 2 - price) / (price * RANGE_PCT / 100)
        zones.append({"zone": [a, b], "type": typ, "score": round(score, 1), "rank": score * (1 - 0.35 * min(dist, 1)),
                      "piv": has_piv, "note": " · ".join(reasons[:4])})
    zones = [z for z in zones if lo <= (z["zone"][0] + z["zone"][1]) / 2 <= hi]
    above = sorted([z for z in zones if (z["zone"][0] + z["zone"][1]) / 2 > price and not z["piv"]], key=lambda z: -z["rank"])
    below = sorted([z for z in zones if (z["zone"][0] + z["zone"][1]) / 2 <= price and not z["piv"]], key=lambda z: -z["rank"])
    inside = [z for z in zones if z["piv"]]
    pick = inside[:1]
    for z in above[:2] + below[:2]:
        if all(abs(z["zone"][0] - y["zone"][1]) >= MIN_GAP and abs(y["zone"][0] - z["zone"][1]) >= MIN_GAP for y in pick):
            pick.append(z)
    rest = sorted([z for z in zones if z not in pick], key=lambda z: -z["rank"])
    for z in rest:
        if len(pick) >= 8 or z["score"] < 2.5 and len(pick) >= 5:
            break
        if all(abs(z["zone"][0] - y["zone"][1]) >= MIN_GAP and abs(y["zone"][0] - z["zone"][1]) >= MIN_GAP for y in pick):
            pick.append(z)
    pick.sort(key=lambda z: -z["zone"][1])
    for z in pick:
        z.pop("rank", None); z.pop("piv", None)
    # bias
    h1c = [b["c"] for b in bars]
    dcl = [days[k][-1]["c"] for k in done]
    e50h1, e20d = ema(h1c[-300:], 50), ema(dcl, 20)
    bias = (f"H1 {'เหนือ' if price > e50h1 else 'ใต้'} EMA50 ({e50h1:.0f}) · Daily {'เหนือ' if price > e20d else 'ใต้'} EMA20 ({e20d:.0f}) "
            f"— อัตโนมัติจากราคา ไม่ใช่สัญญาณ")
    return {
        "date": dt.datetime.fromtimestamp(now_ms / 1000, TH).date().isoformat(),
        "auto": True,
        "source": "อัตโนมัติ: OKX XAU-USD spot index H1 (public REST) — High/Low เมื่อวาน, Pivot, เอเชีย, swing H1/H4, เลขกลม",
        "price_at_build": price, "price_time": dt.datetime.now(TH).strftime("%d/%m %H:%M"),
        "zones": pick,
        "prev_day": {"high": round(P["high"], 2), "low": round(P["low"], 2), "close": round(P["close"], 2)},
        "week": {"high": round(week["high"], 2), "low": round(week["low"], 2)} if week else None,
        "pivot": {"P": round(piv, 2), "R1": round(r1, 2), "S1": round(s1, 2)},
        "asia": {"high": round(max(b["h"] for b in asia), 2), "low": round(min(b["l"] for b in asia), 2)} if asia else None,
        "bias": bias,
        "generated_at": dt.datetime.now(TH).isoformat(timespec="seconds"),
        "_format": "zones: list of {zone:[low,high], type: resistance|pivot|support, note, score}. prev_day/week: {high,low[,close]}. Prices = spot XAUUSD (OKX index).",
    }


def main(argv):
    old = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    today = dt.datetime.now(TH).date().isoformat()
    if old.get("date") == today and not old.get("auto") and "--force" not in argv:
        print("zones.json is a hand-made file for today; not overwritten (use --force)"); return 0
    try:
        z = build()
        n = len(z["zones"])
        if not 4 <= n <= 8 or not any(x["type"] != "support" for x in z["zones"]):
            raise RuntimeError(f"implausible result ({n} zones)")
    except Exception as e:
        print("zones_auto FAILED, previous zones.json kept:", e, file=sys.stderr); return 0
    txt = json.dumps(z, ensure_ascii=False, indent=1) + "\n"
    if "--dry" in argv:
        print(txt); return 0
    OUT.write_text(txt, encoding="utf-8"); print(f"wrote zones.json ({n} zones, price {z['price_at_build']})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

#!/usr/bin/env python3
"""AiTD Gold Live — NAS100 reference levels -> nas_zones.json (Python stdlib only).

Data: Yahoo Finance public chart endpoint, Nasdaq-100 cash index ^NDX, daily bars (no key):
  https://query1.finance.yahoo.com/v8/finance/chart/%5ENDX?interval=1d&range=3mo
Only completed US cash sessions are used (a bar dated today in New York counts only after 16:00 NY).

Levels (all from real bars, nothing invented):
  previous day high / low / close, classic daily pivot P = (H+L+C)/3,
  this week high / low (completed days of the current NY week, if any),
  previous week high / low,
  round 100-point numbers: the 3 nearest above and 3 nearest below the last close.
Levels within MERGE points of each other are merged (labels joined). Type: above the last close = resistance,
below = support, pivot P = pivot. Each level is also written as a chart band "zones":[{zone:[level-PAD, level+PAD], type, note}]
in the same shape as zones.json, so the NAS100 chart draws it exactly like the gold zones.

The site chart uses the OKX US100-USDT index (tracks CFD NAS100 quotes; matched the ^NDX cash close within ~5 points at
16:00 NY on 27 Oct 2026). Broker CFDs can still differ by a few to tens of points.
Keeps the previous nas_zones.json if anything fails or looks wrong.
Usage: python3 nas_zones.py [--dry]
"""
import json, sys, time, datetime as dt, urllib.request
from pathlib import Path

SITE = Path(__file__).resolve().parent
OUT = SITE / "nas_zones.json"
TH = dt.timezone(dt.timedelta(hours=7))
UA = {"User-Agent": "Mozilla/5.0"}          # Yahoo answers 429 to full browser-like UAs from scripts
SYMBOL = "^NDX"
URLS = ["https://query1.finance.yahoo.com/v8/finance/chart/%5ENDX?interval=1d&range=3mo",
        "https://query2.finance.yahoo.com/v8/finance/chart/%5ENDX?interval=1d&range=3mo"]
ROUND, N_ROUND, MERGE = 100, 3, 20.0
PAD = 10.0          # chart band = level ± PAD points (gold uses ≥$3-wide bands ≈ 0.07 %; 20 pts ≈ 0.07 % of NAS100)


def fetch():
    err = None
    for i in range(6):
        url = URLS[i % len(URLS)]
        try:
            r = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=25)
            d = json.loads(r.read())
            res = d["chart"]["result"][0]
            return res
        except Exception as e:
            err = e; time.sleep(2 * (i + 1))
    raise RuntimeError(f"yahoo: {err}")


def bars_from(res):
    off = dt.timedelta(seconds=res["meta"].get("gmtoffset", -14400))
    q = res["indicators"]["quote"][0]
    now_ny = dt.datetime.now(dt.timezone.utc) + off
    out = []
    for i, t in enumerate(res.get("timestamp") or []):
        o, h, l, c = q["open"][i], q["high"][i], q["low"][i], q["close"][i]
        if None in (o, h, l, c):
            continue
        d = (dt.datetime.fromtimestamp(t, dt.timezone.utc) + off).date()
        if d > now_ny.date() or (d == now_ny.date() and now_ny.hour < 16):
            continue                                    # session not finished yet
        out.append({"date": d, "open": o, "high": h, "low": l, "close": c})
    return out, now_ny


def r2(x):
    return round(float(x), 2)


def build():
    res = fetch()
    bars, now_ny = bars_from(res)
    if len(bars) < 10:
        raise RuntimeError(f"too few bars: {len(bars)}")
    last = bars[-1]
    close = last["close"]
    wk = lambda d: d - dt.timedelta(days=d.weekday())          # Monday of that week
    cur_wk = wk(now_ny.date())
    this_week = [b for b in bars if wk(b["date"]) == cur_wk]
    prev_wk_start = max(wk(b["date"]) for b in bars if wk(b["date"]) < cur_wk)
    prev_week = [b for b in bars if wk(b["date"]) == prev_wk_start]

    P = (last["high"] + last["low"] + last["close"]) / 3
    cands = [
        (last["high"], "High เมื่อวาน", f"High วันที่ {last['date']:%d/%m}"),
        (last["low"], "Low เมื่อวาน", f"Low วันที่ {last['date']:%d/%m}"),
        (P, "Pivot รายวัน", "(H+L+C)/3 ของวันก่อน"),
        (max(b["high"] for b in prev_week), "High สัปดาห์ก่อน", f"สัปดาห์เริ่ม {prev_wk_start:%d/%m}"),
        (min(b["low"] for b in prev_week), "Low สัปดาห์ก่อน", f"สัปดาห์เริ่ม {prev_wk_start:%d/%m}"),
    ]
    if this_week:
        cands += [(max(b["high"] for b in this_week), "High สัปดาห์นี้", f"{len(this_week)} วันที่ปิดแล้ว"),
                  (min(b["low"] for b in this_week), "Low สัปดาห์นี้", f"{len(this_week)} วันที่ปิดแล้ว")]
    base = int(close // ROUND) * ROUND
    ups = [base + ROUND * k for k in range(1, N_ROUND + 1)]
    dns = [base - ROUND * k for k in range(0, N_ROUND)]
    if base == close:
        ups = [base + ROUND * k for k in range(1, N_ROUND + 1)]; dns = [base - ROUND * k for k in range(1, N_ROUND + 1)]
    for v in ups + dns:
        cands.append((float(v), "เลขกลม", f"ระดับ {ROUND} จุด"))

    # merge nearby levels (structural labels first, round numbers last)
    levels = []
    for price, label, note in cands:
        hit = next((L for L in levels if abs(L["price"] - price) <= MERGE), None)
        if hit:
            if label not in hit["labels"]:
                hit["labels"].append(label); hit["notes"].append(f"{label} {price:,.2f}")
            continue
        levels.append({"price": price, "labels": [label], "notes": [f"{label} {price:,.2f}" + (f" ({note})" if label != "เลขกลม" else "")]})
    out = []
    for L in levels:
        lab = L["labels"]
        typ = "pivot" if lab[0] == "Pivot รายวัน" else ("resistance" if L["price"] > close else "support")
        out.append({"price": r2(L["price"]), "type": typ, "label": " · ".join(lab), "note": " · ".join(L["notes"])})
    out.sort(key=lambda x: -x["price"])

    return {
        "date": f"{last['date']}",
        "auto": True,
        "symbol": SYMBOL,
        "chart_symbol": "OKX US100-USDT index",
        "source": "อัตโนมัติ: Yahoo Finance ^NDX (ดัชนี Nasdaq 100 เงินสด) แท่งรายวันที่ปิดแล้ว — High/Low/Close เมื่อวาน, Pivot, High/Low สัปดาห์นี้และสัปดาห์ก่อน, เลขกลม 100 จุด",
        "last_close": {"date": f"{last['date']}", "close": r2(close)},
        "prev_day": {"date": f"{last['date']}", "open": r2(last["open"]), "high": r2(last["high"]), "low": r2(last["low"]), "close": r2(close)},
        "week": ({"start": f"{cur_wk}", "days": len(this_week), "high": r2(max(b["high"] for b in this_week)), "low": r2(min(b["low"] for b in this_week))} if this_week else None),
        "prev_week": {"start": f"{prev_wk_start}", "high": r2(max(b["high"] for b in prev_week)), "low": r2(min(b["low"] for b in prev_week)), "close": r2(prev_week[-1]["close"])},
        "pivot": r2(P),
        "levels": out,
        "zones": [{"zone": [r2(L["price"] - PAD), r2(L["price"] + PAD)], "type": L["type"], "level": L["price"], "label": L["label"], "note": L["note"]} for L in out],
        "generated_at": dt.datetime.now(TH).replace(microsecond=0).isoformat(),
    }


def main():
    dry = "--dry" in sys.argv
    try:
        z = build()
        lv = [L["price"] for L in z["levels"]]
        c = z["last_close"]["close"]
        if not lv or any(abs(p - c) / c > 0.15 for p in lv):
            raise RuntimeError("levels look wrong")
    except Exception as e:
        print(f"nas_zones: failed, keeping old file: {e}", file=sys.stderr)
        return 0 if OUT.exists() else 1
    s = json.dumps(z, ensure_ascii=False, indent=1)
    if dry:
        print(s); return 0
    OUT.write_text(s + "\n", encoding="utf-8")
    print(f"nas_zones.json: {len(z['levels'])} levels, last close {z['last_close']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

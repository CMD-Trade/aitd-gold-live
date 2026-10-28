#!/usr/bin/env python3
"""AiTD Gold Live — rewrite the site's PUBLIC data files (zones.json, events.json, candles_seed.json).

PRIVACY: this script never reads the trading journal and never writes balance, P/L or any
account figure. Balance / floor / daily stop / today's P/L are typed by the user in the page
and stored only in that browser's localStorage.

Read-only sources (never modified):
  /workspace/gold_zones.json         -> zones.json   (same format, + "generated_at")
  ForexFactory weekly JSON            -> events.json  (high-impact USD; tries live nfs.faireconomy.media,
                                          then /workspace/hub/ff_week.json, /workspace/ff.json;
                                          FOMC 29 Oct 2026 01:00 Thai always kept)
Optional: /workspace/hub/candles.json -> candles_seed.json (static M15 seed for the zone chart fallback)

Usage:  python3 update_data.py [--no-net]
"""
import json, sys, datetime as dt, urllib.request
from pathlib import Path

SITE = Path(__file__).resolve().parent
WS = Path('/workspace')
ZONES_SRC = WS / 'gold_zones.json'
TH = dt.timezone(dt.timedelta(hours=7))
NOW = dt.datetime.now(TH)

FOMC = {"title": "FOMC (ดอกเบี้ย Fed + Statement)", "country": "USD", "impact": "High",
        "time": "2026-10-29T01:00:00+07:00", "forecast": "4.00%", "previous": "4.00%"}

TITLE_TH = {
    "Federal Funds Rate": "Fed ประกาศดอกเบี้ย", "FOMC Statement": "แถลงการณ์ FOMC",
    "FOMC Press Conference": "แถลงข่าวประธาน Fed (FOMC)", "Advance GDP q/q": "GDP สหรัฐ (ล่วงหน้า)",
    "Core PCE Price Index m/m": "Core PCE m/m", "Non-Farm Employment Change": "Non-Farm Payrolls",
    "Unemployment Rate": "อัตราว่างงานสหรัฐ", "CPI m/y": "CPI y/y", "Core CPI m/m": "Core CPI m/m",
    "CPI y/y": "CPI y/y", "ISM Manufacturing PMI": "ISM ภาคการผลิต", "ISM Services PMI": "ISM ภาคบริการ",
}


def write(name, obj):
    p = SITE / name
    p.write_text(json.dumps(obj, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {p.relative_to(SITE)}")


def do_zones():
    z = json.loads(ZONES_SRC.read_text(encoding="utf-8"))
    z["generated_at"] = NOW.isoformat(timespec="seconds")
    z["_format"] = ("zones: list of {zone:[low,high], type: resistance|pivot|support, note}. "
                    "prev_day/week: {high,low[,close]}. Prices = spot XAUUSD (OANDA-like).")
    write("zones.json", z)


def load_ff(no_net):
    if not no_net:
        try:
            req = urllib.request.Request("https://nfs.faireconomy.media/ff_calendar_thisweek.json",
                                         headers={"User-Agent": "Mozilla/5.0"})
            return json.loads(urllib.request.urlopen(req, timeout=15).read()), "ForexFactory (live)"
        except Exception as e:
            print("ff live fetch failed:", e)
    for p in (WS / "hub/ff_week.json", WS / "ff.json"):
        if p.exists():
            return json.loads(p.read_text()), f"ForexFactory ({p})"
    return [], "none"


def do_events(no_net):
    ff, src = load_ff(no_net)
    ev = []
    for e in ff:
        if e.get("impact") != "High" or e.get("country") != "USD":
            continue
        t = dt.datetime.fromisoformat(e["date"]).astimezone(TH)
        ev.append({"title": TITLE_TH.get(e["title"], e["title"]), "title_en": e["title"], "country": "USD",
                   "impact": "High", "time": t.isoformat(), "forecast": e.get("forecast", ""),
                   "previous": e.get("previous", "")})
    if not any(x["time"].startswith("2026-10-29T01:00") for x in ev) and NOW < dt.datetime.fromisoformat(FOMC["time"]) + dt.timedelta(days=1):
        ev.append(FOMC)
    ev.sort(key=lambda x: x["time"])
    write("events.json", {"generated_at": NOW.isoformat(timespec="seconds"), "source": src,
                          "_format": "events: list of {title, country, impact, time (ISO with +07:00), forecast, previous}",
                          "events": ev})


def do_seed():
    p = WS / "hub/candles.json"
    if not p.exists():
        return
    raw = json.loads(p.read_text())
    out = []
    year = NOW.year
    for row in raw.get("15", []):
        t = dt.datetime.strptime(f"{row[0]} {year}", "%d/%m %H:%M %Y").replace(tzinfo=TH)
        out.append({"time": int(t.timestamp()), "open": row[1], "high": row[2], "low": row[3], "close": row[4]})
    write("candles_seed.json", {"generated_at": NOW.isoformat(timespec="seconds"), "interval": "15m",
                                "source": "box snapshot (OANDA/Dukascopy M15) — static seed only", "candles": out})


if __name__ == "__main__":
    a = sys.argv[1:]
    do_zones(); do_events("--no-net" in a); do_seed()
    stale = SITE / "account.json"
    if stale.exists():
        stale.unlink(); print("removed account.json (balance is never published)")

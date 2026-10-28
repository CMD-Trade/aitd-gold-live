#!/usr/bin/env python3
"""AiTD Gold Live — gold news headlines -> news.json (Python stdlib only, no API keys, no LLM).

Public RSS feeds only; stores headline, source, link and publish time (Thai time) — never article text.
Thai category tags and the "lean" (ทองบวก / ทองลบ / กลาง) come from simple keyword rules on the headline
(automatic keyword tagging, not analysis). Dedupes, merges with the previous file, keeps <= MAX_ITEMS
headlines from the last MAX_AGE_H hours. If every feed fails the previous news.json is kept.
Usage: python3 news.py [--dry]
"""
import json, re, sys, time, gzip, html, datetime as dt, urllib.request, urllib.parse
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
from pathlib import Path

SITE = Path(__file__).resolve().parent
OUT = SITE / "news.json"
TH = dt.timezone(dt.timedelta(hours=7))
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
      "Accept": "application/rss+xml, application/xml;q=0.9, */*;q=0.8", "Accept-Encoding": "gzip"}
MAX_ITEMS, MAX_AGE_H = 30, 48


def gn(q, th=False):
    hl = "hl=th&gl=TH&ceid=TH:th" if th else "hl=en-US&gl=US&ceid=US:en"
    return f"https://news.google.com/rss/search?q={urllib.parse.quote(q)}&{hl}"


# id, display name, url, max items taken, needs keyword relevance filter
FEEDS = [
    ("gn_gold", "Google News (gold)", gn("gold price OR XAUUSD OR \"gold prices\" when:2d"), 10, False),
    ("gn_th", "Google News ไทย (ราคาทอง)", gn("ราคาทอง when:2d", th=True), 8, False),
    ("gn_fed", "Google News (Fed)", gn("Fed OR FOMC OR Powell interest rates when:2d"), 5, False),
    ("gn_reuters", "Reuters (via Google News)", gn("gold OR Fed OR dollar site:reuters.com when:2d"), 5, True),
    ("gn_kitco", "Kitco (via Google News)", gn("site:kitco.com gold when:3d"), 4, True),
    ("gn_fxstreet", "FXStreet (via Google News)", gn("site:fxstreet.com gold OR XAU/USD when:2d"), 4, True),
    ("fxstreet", "FXStreet RSS", "https://www.fxstreet.com/rss/news", 4, True),
    ("investing", "Investing.com Metals RSS", "https://www.investing.com/rss/commodities_Metals.rss", 4, False),
    ("investinglive", "investingLive (ForexLive) RSS", "https://investinglive.com/feed/", 4, True),
    ("fxempire", "FXEmpire RSS", "https://www.fxempire.com/api/v1/en/articles/rss/news", 3, True),
    ("fed", "Federal Reserve press", "https://www.federalreserve.gov/feeds/press_monetary.xml", 3, False),
]

RELEVANT = re.compile(r"gold|xau|bullion|\bfed\b|fomc|powell|federal reserve|dollar|treasur|yields?\b|central bank|ทอง", re.I)
# local retail-price / off-topic headlines that flood the gold queries
NOISE = re.compile(r"bangladesh|bhori|tola\b|\bindia|diwali|dhanteras|pakistan|nepal|kerala|chennai|mumbai|rupee|\btk\b|"
                   r"ringgit|dirham|dubai|\buae\b|vietnam|philippine|jewel|live (gold|silver) price|silver price \w+ today|"
                   r"price today \||ไนติงเกล|ฟุตบอล|ลูกฟุตบอล", re.I)
BAD_SRC = re.compile(r"vietnam\.vn|baomoi|tmgm|facebook|youtube|tiktok|instagram|\bx\.com|twitter", re.I)
# English Google-News queries: keep well-known market news outlets only
GOOD_SRC = re.compile(r"reuters|bloomberg|kitco|fxstreet|cnbc|marketwatch|wall street journal|wsj|financial times|\bft\b|"
                      r"investing\.com|barron|mining\.com|fxempire|tradingview|investinglive|forexlive|yahoo|associated press|"
                      r"\bap news|business insider|fortune|the economist|axios|cnn|bbc|guardian|nikkei|scmp|"
                      r"economic times|business standard|livemint|fxleaders|forex\.com|ig\b|saxo|oanda|dailyforex|actionforex|"
                      r"world gold council|nasdaq|benzinga|seeking alpha|thestreet|morningstar|zerohedge|schiffgold|gold\.org|"
                      r"usagold|apmex|jm bullion|bullionvault|money metals", re.I)
CORE = re.compile(r"gold|xau|bullion|ทอง|\bfed\b|fomc|powell|dollar|yields?\b|treasur", re.I)

TAGS = [  # (Thai tag, regex on headline)
    ("Fed/ดอกเบี้ย", r"\bfed\b|fomc|powell|federal reserve|rate cut|rate hike|interest rate|rates? decision|ดอกเบี้ย|เฟด"),
    ("เงินเฟ้อ", r"inflation|\bcpi\b|\bpce\b|\bppi\b|เงินเฟ้อ"),
    ("ตลาดแรงงาน", r"payroll|\bnfp\b|\bjobs?\b|jobless|unemployment|employment|labor market|การจ้างงาน|ว่างงาน"),
    ("ดอลลาร์/บอนด์", r"dollar|\bdxy\b|greenback|\byields?\b|treasur|bond|ดอลลาร์|บอนด์|พันธบัตร"),
    ("ภูมิรัฐศาสตร์", r"\bwar\b|israel|iran|ukraine|russia|taiwan|tariff|sanction|geopolit|middle east|conflict|missile|"
                      r"trade deal|trade talks|ภูมิรัฐศาสตร์|สงคราม|ภาษีนำเข้า|ขัดแย้ง"),
    ("ธนาคารกลาง", r"central bank|\bpboc\b|\becb\b|\bboj\b|\bboe\b|reserve bank|ธนาคารกลาง"),
    ("ETF/กองทุน", r"\betf\b|\bspdr\b|\bgld\b|holdings|inflows?|outflows?|กองทุน"),
    ("ราคาทองไทย", r"ทองคำแท่ง|ทองรูปพรรณ|สมาคมค้าทอง|บาทละ|ราคาทองวันนี้|ฮั่วเซ่งเฮง|ออสสิริส|เอ็มทีเอส"),
    ("เศรษฐกิจสหรัฐ", r"\bgdp\b|\bpmi\b|\bism\b|retail sales|consumer|recession|shutdown|economy|เศรษฐกิจ"),
    ("เทคนิค/คาดการณ์", r"technical|forecast|outlook|prediction|support|resistance|analysis|chart|วิเคราะห์|แนวโน้ม|คาดการณ์"),
]
TAGS = [(t, re.compile(r, re.I)) for t, r in TAGS]

UP = re.compile(r"gold\w*\b[^.]{0,25}\b(rise|rises|rising|gain|gains|climb|climbs|jump|jumps|surge|surges|rall(y|ies)|rebound\w*|"
                r"higher|soar\w*|record|all-time high|hits? high|advance\w*|extends? gains|up\b)|safe[- ]haven (demand|bid|buying)|"
                r"rate cuts?\b|dovish|dollar( index)? (falls?|slips?|slides?|weakens?|drops?)|weaker dollar|yields? (fall|drop|slip|ease)\w*|"
                r"ทอง\S{0,12}(ขึ้น|พุ่ง|บวก|ทะยาน|ดีด|ปรับขึ้น|ทุบสถิติ|นิวไฮ)|ขึ้น ?\d[\d,]* ?บาท|พุ่งขึ้น|ปรับขึ้น|ขึ้นต่อเนื่อง|ดีดตัว|ทะยาน|นิวไฮ|ทุบสถิติ", re.I)
DOWN = re.compile(r"gold\w*\b[^.]{0,25}\b(fall|falls|falling|drop|drops|slip|slips|slide|slides|decline\w*|tumble\w*|plunge\w*|"
                  r"lower|retreat\w*|eases?|sink\w*|loses?|losses|down\b|weaker|pressure)|hawkish|rate hikes?\b|"
                  r"dollar( index)? (rises?|gains?|strengthens?|firms?|jumps?|climbs?|hits? (\w+[- ])?(week|month|year) high)|stronger dollar|yields? (rise|climb|jump|rises|climbs|jumps)|"
                  r"ทอง\S{0,12}(ลง|ร่วง|ดิ่ง|ปรับลง|ลบ|ทรุด)|ลง ?\d[\d,]* ?บาท|ร่วง|ดิ่ง|ปรับลง|ลดลง|ทรุด|ลงต่อเนื่อง", re.I)


def fetch(url):
    r = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20)
    b = r.read()
    if r.headers.get("Content-Encoding") == "gzip":
        b = gzip.decompress(b)
    return b


def ptime(s):
    s = (s or "").strip()
    if not s:
        return None
    for f in (lambda x: parsedate_to_datetime(x),
              lambda x: dt.datetime.fromisoformat(x.replace("Z", "+00:00")),
              lambda x: dt.datetime.strptime(x, "%b %d, %Y %H:%M GMT").replace(tzinfo=dt.timezone.utc),
              lambda x: dt.datetime.strptime(x, "%Y-%m-%d %H:%M:%S").replace(tzinfo=dt.timezone.utc)):
        try:
            t = f(s)
            return t if t.tzinfo else t.replace(tzinfo=dt.timezone.utc)
        except Exception:
            pass
    return None


def parse(b, feed_name):
    root = ET.fromstring(b)
    out = []
    strip = lambda tag: tag.split("}")[-1]
    for it in root.iter():
        if strip(it.tag) not in ("item", "entry"):
            continue
        f = {strip(c.tag): c for c in it}
        title = html.unescape((f.get("title").text or "") if f.get("title") is not None else "").strip()
        link = ""
        if f.get("link") is not None:
            link = (f["link"].text or f["link"].get("href") or "").strip()
        when = ptime((f.get("pubDate") if f.get("pubDate") is not None else f.get("published") if f.get("published") is not None
                      else f.get("updated")).text if any(k in f for k in ("pubDate", "published", "updated")) else "")
        src = feed_name
        if f.get("source") is not None and (f["source"].text or "").strip():
            src = f["source"].text.strip()
            title = re.sub(r"\s+-\s+" + re.escape(src) + r"\s*$", "", title)
        title = re.sub(r"\s+", " ", title)
        if title and link.startswith("http") and when:
            out.append({"title": title[:220], "source": src, "link": link, "t": when})
    return out


def tag(title):
    tags = [t for t, rx in TAGS if rx.search(title)]
    if not CORE.search(title):
        return tags or ["ทั่วไป"], "กลาง"
    u, d = len(UP.findall(title)), len(DOWN.findall(title))
    lean = "ทองบวก" if u > d else "ทองลบ" if d > u else "กลาง"
    return tags or ["ทั่วไป"], lean


def key(title):
    return re.sub(r"[^0-9a-zก-๙]+", "", title.lower())[:70]


def main(argv):
    now = dt.datetime.now(TH)
    cutoff = now - dt.timedelta(hours=MAX_AGE_H)
    items, report = [], []
    for fid, name, url, cap, filt in FEEDS:
        try:
            got = parse(fetch(url), name)
            fresh = [x for x in got if x["t"] >= cutoff and x["t"] <= now + dt.timedelta(minutes=10)]
            if fid == "fed":
                fresh = [x for x in fresh if re.search(r"fomc|monetary|federal open market|rate", x["title"], re.I)]
            if filt:
                fresh = [x for x in fresh if RELEVANT.search(x["title"])]
            fresh = [x for x in fresh if not NOISE.search(x["title"]) and "{" not in x["title"] and not BAD_SRC.search(x["source"])]
            if fid in ("gn_gold", "gn_fed"):
                fresh = [x for x in fresh if GOOD_SRC.search(x["source"])]
            if fid == "gn_kitco":
                fresh = [x for x in fresh if re.search(r"gold", x["title"], re.I)]
            fresh.sort(key=lambda x: x["t"], reverse=True)
            for x in fresh[:cap]:
                x["feed"] = fid
            items += fresh[:cap]
            report.append({"id": fid, "name": name, "ok": True, "parsed": len(got), "fresh": len(fresh), "used": min(cap, len(fresh))})
        except Exception as e:
            report.append({"id": fid, "name": name, "ok": False, "error": str(e)[:120]})
        time.sleep(0.4)
    new = [{"title": x["title"], "source": x["source"], "link": x["link"],
            "published": x["t"].astimezone(TH).isoformat(timespec="minutes"), "feed": x["feed"]} for x in items]
    old = []
    if OUT.exists():
        try:
            old = json.loads(OUT.read_text(encoding="utf-8")).get("items", [])
        except Exception:
            old = []
    if not new:
        print("news: no feed returned items; previous news.json kept", file=sys.stderr)
        for r in report: print(" ", r, file=sys.stderr)
        return 0
    seen, merged = set(), []
    for x in sorted(new + old, key=lambda x: x["published"], reverse=True):
        try:
            if dt.datetime.fromisoformat(x["published"]) < cutoff:
                continue
        except Exception:
            continue
        k = key(x["title"])
        if k in seen or x["link"] in seen:
            continue
        if sum(1 for y in merged if y["source"] == x["source"]) >= 4:
            continue
        seen.add(k); seen.add(x["link"])
        x["tags"], x["lean"] = tag(x["title"])
        merged.append(x)
    merged = merged[:MAX_ITEMS]
    doc = {"generated_at": now.isoformat(timespec="seconds"),
           "note": "หัวข้อข่าวและลิงก์จาก RSS สาธารณะเท่านั้น · หมวดและ ทองบวก/ทองลบ/กลาง ติดอัตโนมัติจากคำในหัวข้อ (keyword) ไม่ใช่บทวิเคราะห์",
           "sources": report, "items": merged,
           "_format": "items: {title (original), source, link, published (ISO +07:00), feed, tags[Thai], lean: ทองบวก|ทองลบ|กลาง}"}
    txt = json.dumps(doc, ensure_ascii=False, indent=1) + "\n"
    if "--dry" in argv:
        print(txt); return 0
    OUT.write_text(txt, encoding="utf-8")
    print(f"wrote news.json: {len(merged)} items; feeds ok: " + ", ".join(f"{r['id']}={r.get('used', 'x')}" for r in report))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

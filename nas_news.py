#!/usr/bin/env python3
"""AiTD Gold Live — Nasdaq-100 / US-stocks headlines -> nas_news.json for nas100.html (stdlib only, no API keys, no LLM).

Same engine as news.py (public RSS, headline + source + link + time only, keyword tags, dedupe/merge, keeps the old
file if every feed fails) with NAS100-specific feeds, filters, tags and lean (NASบวก / NASลบ / กลาง).
Usage: python3 nas_news.py [--dry]
"""
import re, sys
import news as N

N.OUT = N.SITE / "nas_news.json"
N.LEAN = ("NASบวก", "NASลบ")
N.GOOD_ONLY = ("gn_nas", "gn_fed", "gn_tech")
N.SUBJECT = r"nasdaq|stocks?|futures|s&p|tech|nvidia|apple|microsoft"
gn = N.gn
N.FEEDS = [
    ("gn_nas", "Google News (Nasdaq)", gn("Nasdaq OR \"Nasdaq 100\" OR \"tech stocks\" stock market when:2d"), 10, False),
    ("gn_th", "Google News ไทย (แนสแด็ก)", gn("แนสแด็ก OR Nasdaq หุ้นสหรัฐ when:2d", th=True), 6, False),
    ("gn_tech", "Google News (megacap tech)", gn("Nvidia OR Apple OR Microsoft OR Amazon OR Alphabet OR Meta OR Tesla stock when:2d"), 6, False),
    ("gn_fed", "Google News (Fed)", gn("Fed OR FOMC OR Powell interest rates when:2d"), 5, False),
    ("gn_kitco", "Reuters markets (via Google News)", gn("stocks OR Nasdaq OR Wall Street site:reuters.com when:2d"), 5, True),
    ("gn_cnbc", "CNBC (via Google News)", gn("site:cnbc.com stocks OR Nasdaq OR futures when:2d"), 4, True),
    ("investinglive", "investingLive (ForexLive) RSS", "https://investinglive.com/feed/", 4, True),
    ("fed", "Federal Reserve press", "https://www.federalreserve.gov/feeds/press_monetary.xml", 3, False),
]
N.RELEVANT = re.compile(r"nasdaq|stocks?|equit|wall street|s&p|dow\b|futures|tech|chip|semiconductor|nvidia|apple|microsoft|"
                        r"amazon|alphabet|google|meta\b|tesla|earnings|\bai\b|\bfed\b|fomc|powell|federal reserve|treasur|yields?\b|"
                        r"หุ้น|แนสแด็ก", re.I)
N.NOISE = re.compile(r"\bindia|sensex|nifty|pakistan|bangladesh|nepal|rupee|ไนติงเกล|ฟุตบอล|crypto price prediction|"
                     r"penny stock|stocks? to buy (now|today)|\d+ (best|top) stocks", re.I)
N.CORE = re.compile(r"nasdaq|stocks?|wall street|s&p|futures|tech|chip|nvidia|apple|microsoft|amazon|alphabet|meta\b|tesla|"
                    r"\bfed\b|fomc|powell|yields?\b|treasur|หุ้น|แนสแด็ก", re.I)
TAGS = [
    ("Fed/ดอกเบี้ย", r"\bfed\b|fomc|powell|federal reserve|rate cut|rate hike|interest rate|rates? decision|ดอกเบี้ย|เฟด"),
    ("เงินเฟ้อ", r"inflation|\bcpi\b|\bpce\b|\bppi\b|เงินเฟ้อ"),
    ("ตลาดแรงงาน", r"payroll|\bnfp\b|\bjobs?\b|jobless|unemployment|employment|labor market|การจ้างงาน|ว่างงาน"),
    ("งบบริษัท", r"earnings|results|revenue|guidance|quarter|profit|outlook|งบ|กำไร"),
    ("หุ้นเทค/AI", r"nvidia|apple|microsoft|amazon|alphabet|google|meta\b|tesla|broadcom|\bai\b|chip|semiconductor|tech|เทค"),
    ("บอนด์/ดอลลาร์", r"\byields?\b|treasur|bond|dollar|ดอลลาร์|บอนด์|พันธบัตร"),
    ("ภูมิรัฐศาสตร์", r"\bwar\b|israel|iran|ukraine|russia|taiwan|tariff|sanction|geopolit|middle east|trade deal|trade talks|"
                      r"export curbs?|สงคราม|ภาษีนำเข้า"),
    ("เศรษฐกิจสหรัฐ", r"\bgdp\b|\bpmi\b|\bism\b|retail sales|consumer|recession|shutdown|economy|เศรษฐกิจ"),
]
N.TAGS = [(t, re.compile(r, re.I)) for t, r in TAGS]
_IDX = r"(nasdaq|stocks?|wall street|s&p( 500)?|futures|tech( stocks| shares)?|equities|indexes|indices|หุ้น\S{0,10}|แนสแด็ก)"
N.UP = re.compile(_IDX + r"\b[^.]{0,25}\b(rise|rises|rising|gain|gains|climb|climbs|jump|jumps|surge|surges|rall(y|ies)|rebound\w*|"
                  r"higher|soar\w*|record|all-time high|advance\w*|extends? gains|up\b)|rate cuts?\b|dovish|yields? (fall|drop|slip|ease)\w*|"
                  r"beats? (estimates|expectations)|(ขึ้น|พุ่ง|บวก|ทะยาน|ดีดตัว|นิวไฮ)", re.I)
N.DOWN = re.compile(_IDX + r"\b[^.]{0,25}\b(fall|falls|falling|drop|drops|slip|slips|slide|slides|decline\w*|tumble\w*|plunge\w*|"
                    r"lower|retreat\w*|sink\w*|loses?|losses|down\b|sell-?off|rout|slump\w*)|hawkish|rate hikes?\b|"
                    r"yields? (rise|climb|jump|rises|climbs|jumps)|miss(es)? (estimates|expectations)|(ร่วง|ดิ่ง|ปรับลง|ลดลง|ทรุด|เทขาย)", re.I)

if __name__ == "__main__":
    sys.exit(N.main(sys.argv[1:]))

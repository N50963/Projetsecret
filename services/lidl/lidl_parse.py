"""Parse le htmlPrintedReceipt Lidl FR en lignes d'achat. Tout en centimes (int)."""
import html, re
from decimal import Decimal

PARSER_VERSION = 1
SPAN = re.compile(r'<span id="purchase_list_line_(\d+)" class="([^"]*)"([^>]*)>(.*?)</span>', re.S)
ART = re.compile(r'^(?P<name>.+?)\s+(?P<unit>-?\d+,\d{2})\s+x?\s*(?P<qty>\d+)\s+(?P<total>-?\d+,\d{2})\s+(?P<tax>[A-Z])(?:\s+T)?$')
WART = re.compile(r'^(?P<name>.+?)\s+(?P<total>-?\d+,\d{2})\s+(?P<tax>[A-Z])(?:\s+T)?$')
WLINE = re.compile(r'^(?P<kg>\d+,\d+)\s*kg\s*x\s*(?P<ppk>\d+,\d{2})\s*EUR/kg$')
MONEY = re.compile(r'^-?\d+,\d{2}$')

def cents(s): return int((Decimal(s.replace(",", ".")) * 100).to_integral_value())
def clean(t): return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", t))).strip()

def parse_lines(h):
    """Regroupe les spans par numéro de ligne, puis classe chaque ligne."""
    lines = {}
    for m in SPAN.finditer(h):
        n = int(m.group(1)); L = lines.setdefault(n, {"classes": set(), "attrs": "", "raw": []})
        L["classes"].add(m.group(2).split()[0]); L["attrs"] += m.group(3); L["raw"].append(m.group(4))
    return [(n, lines[n]) for n in sorted(lines)]

def parse_receipt(h):
    items, problems, last = [], [], None
    for n, L in parse_lines(h):
        raw_text = "".join(L["raw"]); text = clean(raw_text)
        if not text or "currency" in L["classes"]: continue
        a = L["attrs"]
        if "article" in L["classes"] and WLINE.match(text):
            m = WLINE.match(text)
            if last is not None and last.get("_weighed") and last["weight_g"] is None:
                last["weight_g"] = int(Decimal(m["kg"].replace(",", ".")) * 1000); last["unit_price"] = cents(m["ppk"]); last["quantity"] = 1
            else: problems.append((n, "ligne de pesée orpheline", text))
        elif "article" in L["classes"] and "data-art-id" in a:
            art_id = re.search(r'data-art-id="([^"]*)"', a).group(1)
            m = ART.match(text)
            if m:
                it = dict(line_no=n, art_id=art_id, label_raw=m["name"].strip(), unit_price=cents(m["unit"]), quantity=int(m["qty"]),
                          weight_g=None, line_total=cents(m["total"]), tax=m["tax"], discount=0, discount_labels=[])
            else:
                m = WART.match(text)
                if not m: problems.append((n, "ligne article illisible", text)); last = None; continue
                it = dict(line_no=n, art_id=art_id, label_raw=m["name"].strip(), unit_price=None, quantity=None,
                          weight_g=None, line_total=cents(m["total"]), tax=m["tax"], discount=0, discount_labels=[], _weighed=True)
            items.append(it); last = it
        elif "article" in L["classes"]:
            m = WLINE.match(text)
            if m and last is not None and last.get("_weighed"):
                last["weight_g"] = int(Decimal(m["kg"].replace(",", ".")) * 1000); last["unit_price"] = cents(m["ppk"]); last["quantity"] = 1
            else: problems.append((n, "ligne article sans id non reconnue", text))
        elif "discount" in L["classes"] or "css_bold" in L["classes"]:
            amounts = [t for t in (clean(r) for r in L["raw"]) if MONEY.match(t)]
            label = " ".join(t for t in (clean(r) for r in L["raw"]) if t and not MONEY.match(t))
            if not amounts: continue
            if last is None: problems.append((n, "remise sans article", text)); continue
            last["discount"] += sum(cents(x) for x in amounts); last["discount_labels"].append(label or "remise")
    return items, problems

def payable(h):
    m = re.search(r"A payer\s+(-?\d+,\d{2})", clean(h)); return cents(m.group(1)) if m else None

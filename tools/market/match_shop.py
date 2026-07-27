#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""1店の <key>_tequila_final.csv を tequiladojo マスタに名寄せ（カタカナ ブランド＋クラス）。
出力: <key>_matched.csv / <key>_unmatched.csv（shop/shopName 列つき・importで使用）。

使い方: python3 match_shop.py --shop wazawaza [--master tequiladojo_master.csv]
"""
import argparse, csv, re, sys, unicodedata
from difflib import SequenceMatcher

try:
    from crawl_shops import SHOPS
except Exception:
    SHOPS = {}

BRAND_THRESHOLD = 0.72
CLASS_BY_DIGIT = {"1": "Blanco", "2": "Joven/Gold", "3": "Reposado", "4": "Anejo", "5": "ExtraAnejo"}
CLASS_PAT = re.compile(
    r"ブランコ|シルバー|プラタ|レポサ[ドート]*|アニェホ|アネホ|エクストラ|クリスタリーノ|"
    r"ゴールド|ホーベン|オロ|blanco|silver|plata|reposado|añejo|anejo|extra|cristalino|gold|joven|oro", re.I)

def clean(s):
    s = unicodedata.normalize("NFKC", str(s or "")); s = re.sub(r"【[^】]*】", "", s)
    s = re.sub(r"\d+(?:\.\d+)?\s*ml", "", s, flags=re.I); s = re.sub(r"\d+(?:\.\d+)?\s*l\b", "", s, flags=re.I); return s
def sep_strip(s): return re.sub(r"[\s・･_\-‐―（）()\[\]]", "", s).lower()
def brand_key(name): return sep_strip(CLASS_PAT.sub("", clean(name)))
def teq_class_label(cid):
    c = str(cid or ""); return CLASS_BY_DIGIT.get(c[1], "") if len(c) >= 2 else ""
def ratio(a, b):
    if not a or not b: return 0.0
    r = SequenceMatcher(None, a, b).ratio()
    if len(a) >= 2 and len(b) >= 2 and (a in b or b in a): r = max(r, 0.9)
    return r
def load(p):
    try: return list(csv.DictReader(open(p, encoding="utf-8-sig")))
    except FileNotFoundError: print(f"入力なし: {p}", file=sys.stderr); sys.exit(1)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shop", required=True)
    ap.add_argument("--master", default="tequiladojo_master.csv")
    ap.add_argument("--in", dest="infile", default=None)
    a = ap.parse_args()
    shop = a.shop; shopName = (SHOPS.get(shop, {}) or {}).get("name", shop)
    mus = load(a.infile or f"{shop}_tequila_final.csv")
    master = load(a.master)

    brands = {}
    for t in master:
        bid = t.get("brandId", "") or t.get("brandJa", "")
        b = brands.setdefault(bid, {"brandJa": t.get("brandJa", ""), "key": brand_key(t.get("brandJa", "")), "bottles": []})
        if not b["key"]: b["key"] = brand_key(t.get("bottleJa", ""))
        b["bottles"].append({"id": t.get("id", ""), "bottleJa": t.get("bottleJa", ""),
                             "classId": t.get("classId", ""), "label": teq_class_label(t.get("classId", ""))})
    brand_list = [(k, v) for k, v in brands.items() if v["key"]]

    rows, unmatched = [], []
    for m in mus:
        if str(m.get("is_drink", "1")) == "0": continue
        name = m.get("name", ""); mbk = brand_key(name); mclass = m.get("class_guess", "")
        bestk = best = None; best_r = 0.0
        for k, b in brand_list:
            r = ratio(mbk, b["key"])
            if r > best_r: bestk, best, best_r = k, b, r
        if not best or best_r < BRAND_THRESHOLD: unmatched.append(m); continue
        bottle = next((x for x in best["bottles"] if x["label"] and x["label"] == mclass), None)
        if bottle: mtype, conf = "brand+class", ("high" if best_r >= 0.9 else "mid")
        else:
            bottle = best["bottles"][0] if best["bottles"] else {"id": "", "bottleJa": "", "classId": ""}
            mtype, conf = "brand-only", ("mid" if best_r >= 0.9 else "low")
        rows.append({"shop": shop, "shopName": shopName, "item_id": m.get("id", ""), "name": name,
            "m_class": mclass, "price": m.get("price_yen", ""), "price750": m.get("price_750ml", ""),
            "availability": m.get("availability", ""), "teq_bottle_id": bottle["id"], "teq_bottleJa": bottle["bottleJa"],
            "teq_classId": bottle.get("classId", ""), "brand_score": round(best_r, 3),
            "match_type": mtype, "confidence": conf, "url": m.get("url", "")})

    mcols = ["shop","shopName","item_id","name","m_class","price","price750","availability",
             "teq_bottle_id","teq_bottleJa","teq_classId","brand_score","match_type","confidence","url"]
    rows.sort(key=lambda x: (-x["brand_score"]))
    with open(f"{shop}_matched.csv", "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=mcols); w.writeheader()
        for r in rows: w.writerow(r)
    ucols = ["shop","shopName","item_id","name","brand_guess","class_guess","price","price750","availability","url"]
    with open(f"{shop}_unmatched.csv", "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=ucols, extrasaction="ignore"); w.writeheader()
        for u in unmatched:
            w.writerow({"shop": shop, "shopName": shopName, "item_id": u.get("id", ""), "name": u.get("name", ""),
                "brand_guess": u.get("brand_guess", ""), "class_guess": u.get("class_guess", ""),
                "price": u.get("price_yen", ""), "price750": u.get("price_750ml", ""),
                "availability": u.get("availability", ""), "url": u.get("url", "")})

    bc = sum(1 for r in rows if r["match_type"] == "brand+class")
    print(f"[{shop}] マッチ {len(rows)}（brand+class {bc}）/ 未マッチ {len(unmatched)} "
          f"→ {shop}_matched.csv / {shop}_unmatched.csv")

if __name__ == "__main__":
    main()

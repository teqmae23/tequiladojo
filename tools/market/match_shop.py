#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""1店の <key>_tequila_final.csv を tequiladojo マスタに名寄せ（カタカナ ブランド＋クラス）。
出力: <key>_matched.csv / <key>_unmatched.csv（shop/shopName 列つき・importで使用）。

使い方: python3 match_shop.py --shop wazawaza [--master tequiladojo_master.csv]
"""
import argparse, csv, json, os, re, sys, unicodedata
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
def load_aliases(path):
    """ブランド別名 {店の表記: brandId}。マスタ綴りと違う店名を補う（例: カジェ23→1545001）。"""
    try:
        with open(path, encoding="utf-8") as f: d = json.load(f)
        a = d.get("aliases", d) if isinstance(d, dict) else {}
        return {str(k): str(v) for k, v in a.items() if not str(k).startswith("_")}
    except Exception:
        return {}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shop", required=True)
    ap.add_argument("--master", default="tequiladojo_master.csv")
    ap.add_argument("--in", dest="infile", default=None)
    a = ap.parse_args()
    shop = a.shop; shopName = (SHOPS.get(shop, {}) or {}).get("name", shop)
    mus = load(a.infile or f"{shop}_tequila_final.csv")
    master = load(a.master)

    # ブランド別名（店の表記→brandId）。マスタ綴りと違う店名を照合キーに追加する
    # （例: マスタ「カジェ・ベインティトレス」 ⇄ 各店「カジェ23」）。
    alias_map = load_aliases(os.path.join(os.path.dirname(os.path.abspath(__file__)), "brand_aliases.json"))
    alias_keys = {}
    for al, bid in alias_map.items():
        k = brand_key(al)
        if k: alias_keys.setdefault(str(bid), []).append(k)

    brands = {}
    for t in master:
        bid = t.get("brandId", "") or t.get("brandJa", "")
        b = brands.setdefault(bid, {"brandJa": t.get("brandJa", ""), "key": brand_key(t.get("brandJa", "")), "bottles": []})
        if not b["key"]: b["key"] = brand_key(t.get("bottleJa", ""))
        # 紐付け先は12桁ボトルマスタID(bottleId)を優先（手動リンク・相場比較の行キーと一致させ合流させる）。
        # bottleId が無いデータのみ bottleData ID(T番号=id)にフォールバック。
        b["bottles"].append({"id": t.get("bottleId", "") or t.get("id", ""), "bottleJa": t.get("bottleJa", ""),
                             "classId": t.get("classId", ""), "label": teq_class_label(t.get("classId", ""))})
    # 各ブランドの照合キー群（マスタ名キー＋別名キー）。マッチは全キーの最大類似度で判定。
    for bid, b in brands.items():
        keys = [b["key"]] if b["key"] else []
        for ak in alias_keys.get(str(bid), []):
            if ak and ak not in keys: keys.append(ak)
        b["keys"] = keys
    brand_list = [(k, v) for k, v in brands.items() if v["keys"]]

    rows, unmatched = [], []
    for m in mus:
        if str(m.get("is_drink", "1")) == "0": continue
        name = m.get("name", ""); mbk = brand_key(name); mclass = m.get("class_guess", "")
        bestk = best = None; best_r = 0.0
        for k, b in brand_list:
            r = max((ratio(mbk, bk) for bk in b["keys"]), default=0.0)
            if r > best_r: bestk, best, best_r = k, b, r
        if not best or best_r < BRAND_THRESHOLD: unmatched.append(m); continue
        bottle = next((x for x in best["bottles"] if x["label"] and x["label"] == mclass), None)
        if bottle: mtype, conf = "brand+class", ("high" if best_r >= 0.9 else "mid")
        else:
            bottle = best["bottles"][0] if best["bottles"] else {"id": "", "bottleJa": "", "classId": ""}
            mtype, conf = "brand-only", ("mid" if best_r >= 0.9 else "low")
        rows.append({"shop": shop, "shopName": shopName, "item_id": m.get("id", ""), "name": name,
            "m_class": mclass, "price": m.get("price_yen", ""), "price750": m.get("price_750ml", ""),
            "volume_ml": m.get("volume_ml", ""), "abv": m.get("abv", ""),
            "availability": m.get("availability", ""), "teq_bottle_id": bottle["id"], "teq_bottleJa": bottle["bottleJa"],
            "teq_classId": bottle.get("classId", ""), "brand_score": round(best_r, 3),
            "match_type": mtype, "confidence": conf, "url": m.get("url", "")})

    mcols = ["shop","shopName","item_id","name","m_class","price","price750","volume_ml","abv","availability",
             "teq_bottle_id","teq_bottleJa","teq_classId","brand_score","match_type","confidence","url"]
    rows.sort(key=lambda x: (-x["brand_score"]))
    with open(f"{shop}_matched.csv", "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=mcols); w.writeheader()
        for r in rows: w.writerow(r)
    ucols = ["shop","shopName","item_id","name","brand_guess","class_guess","price","price750","volume_ml","abv","availability","url"]
    with open(f"{shop}_unmatched.csv", "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=ucols, extrasaction="ignore"); w.writeheader()
        for u in unmatched:
            w.writerow({"shop": shop, "shopName": shopName, "item_id": u.get("id", ""), "name": u.get("name", ""),
                "brand_guess": u.get("brand_guess", ""), "class_guess": u.get("class_guess", ""),
                "price": u.get("price_yen", ""), "price750": u.get("price_750ml", ""),
                "volume_ml": u.get("volume_ml", ""), "abv": u.get("abv", ""),
                "availability": u.get("availability", ""), "url": u.get("url", "")})

    bc = sum(1 for r in rows if r["match_type"] == "brand+class")
    print(f"[{shop}] マッチ {len(rows)}（brand+class {bc}）/ 未マッチ {len(unmatched)} "
          f"→ {shop}_matched.csv / {shop}_unmatched.csv")

if __name__ == "__main__":
    main()

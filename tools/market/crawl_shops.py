#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""マルチショップ・テキーラ価格クローラ（設定駆動）。
各店の基盤(shopify / eccube / colorme)に応じて商品名・価格・URLを取得し、
Musashiya と同じ最終CSVスキーマ <key>_tequila_final.csv を出力する。

使い方（Cloud Shell 等・対象サイトに到達できる環境で）:
    pip install requests beautifulsoup4
    python3 crawl_shops.py --shop wazawaza          # 1店だけ
    python3 crawl_shops.py --all                    # 全店（disabled除く）
    python3 crawl_shops.py --shop chagata --debug   # 1ページ目を <key>_dump.* に保存
    python3 crawl_shops.py --list                   # 設定一覧

出力: <key>_tequila_final.csv（id,name,brand_guess,class_guess,price_yen,volume_ml,
      volume_used,vol_assumed,price_per_ml,price_750ml,availability,is_drink,is_set,shop,url）
礼儀: robots.txt 確認・UA設定・--delay 待機。
"""
import argparse, csv, json, re, sys, time, urllib.parse, urllib.robotparser
import requests
from bs4 import BeautifulSoup

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")

# ── 店舗設定 ──────────────────────────────────────────────
# cbid/csid が None のものは、サイトのテキーラカテゴリURLを確認して埋める（--debug 参照）
SHOPS = {
  "musashiya":   {"name": "武蔵屋",           "platform": "eccube",  "base": "https://store.musashiya-net.co.jp", "list_path": "/products/list", "category_id": 72},
  "wazawaza":    {"name": "テキーラムーチョ", "platform": "shopify", "base": "https://wazawaza.jp", "collections": ["all"]},
  "kinemon":     {"name": "酒商金右衛門",     "platform": "shopify", "base": "https://kinemon.shop", "collections": ["all"]},
  "liquorsato":  {"name": "サトー酒店",       "platform": "eccube",  "base": "https://liquor-sato.com", "list_path": "/cart/products/list", "category_id": 42},
  "youshuchiga": {"name": "洋酒専門店 千雅",  "platform": "colorme", "base": "https://youshuchiga.shop-pro.jp", "cbid": 1181170, "csid": 0},
  "chagata":     {"name": "ちゃがたパーク",   "platform": "colorme", "base": "https://www.chagata.com", "cbid": 2444445, "csid": 4},
  "mukawa":      {"name": "武川蒸留酒販売",   "platform": "colorme", "base": "https://mukawa-spirit.com", "cbid": 2163597, "csid": 0},
  "biccamera":   {"name": "ビックカメラ",     "platform": "disabled", "base": "https://www.biccamera.com",
                  "note": "大規模・bot対策が強くカテゴリ構造も独自のため保留。必要なら個別対応。"},
}

# ── finalize 相当（クラス推定・ブランド・容量・750ml換算） ──
CLASS_RULES = [
    ("Cristalino", r"クリスタリーノ|cristalino"),
    ("ExtraAnejo", r"エクストラ|extra"),
    ("Reposado",   r"レポサ|reposado"),
    ("Anejo",      r"アネホ|アニェホ|anejo|añejo"),
    ("Joven/Gold", r"ゴールド|ホーベン|オロ\b|gold|joven|oro"),
    ("Blanco",     r"ブランコ|シルバー|プラタ|blanco|silver|plata"),
]
NONDRINK_RE = re.compile(r"教科書|グラス|Tシャツ|ステッカー|ジガー|メジャーカップ|コースター|グッズ|書籍|"
                         r"チケット|試飲券|キャップ|ボトルホルダ|ポスター|タンブラー|マグ|エプロン|パーカー|book", re.I)
SET_RE = re.compile(r"セット|飲み比べ|ギフトBOX|詰め合わせ|アソート")
VOL_RE = re.compile(r"(\d{2,4})\s*ml|(\d(?:\.\d+)?)\s*[lL](?![a-z])", re.I)

def class_of(name):
    for label, pat in CLASS_RULES:
        if re.search(pat, name or "", re.I): return label
    return ""
def brand_of(name):
    n = re.sub(r"^【[^】]*】", "", name or "").strip()
    n = re.sub(r"\d{2,4}\s*ml|\d(?:\.\d+)?\s*[lL]\b", "", n)
    toks = [t for t in re.split(r"[\s　]+", n) if t]
    return " ".join(toks[:2]) if toks else ""
def vol_from_name(name):
    m = VOL_RE.search(name or "")
    if not m: return None
    return int(m.group(1)) if m.group(1) else int(float(m.group(2)) * 1000)
def finalize_row(shop, it):
    name = it["name"]; price = it.get("price")
    vol = it.get("volume_ml") or vol_from_name(name)
    is_drink = 0 if NONDRINK_RE.search(name or "") else 1
    is_set = 1 if SET_RE.search(name or "") else 0
    vol_used = vol if vol else 750
    ppm = round(price / vol_used, 2) if (price and is_drink and not is_set) else ""
    p750 = round(ppm * 750) if ppm != "" else ""
    return {
        "id": it["id"], "name": name, "brand_guess": brand_of(name), "class_guess": class_of(name),
        "price_yen": price if price else "", "volume_ml": vol if vol else "", "volume_used": vol_used,
        "vol_assumed": 0 if vol else 1, "price_per_ml": ppm, "price_750ml": p750,
        "availability": it.get("availability", ""), "is_drink": is_drink, "is_set": is_set,
        "shop": shop, "url": it.get("url", ""),
    }

# ── HTTP ──────────────────────────────────────────────────
def make_session():
    s = requests.Session()
    s.headers.update({"User-Agent": UA, "Accept-Language": "ja,en;q=0.8"})
    return s
def robots_ok(session, base, path):
    rp = urllib.robotparser.RobotFileParser()
    try:
        r = session.get(base + "/robots.txt", timeout=20)
        if r.status_code == 200:
            rp.parse(r.text.splitlines())
            return rp.can_fetch(UA, base + path)
    except Exception:
        pass
    return True

# ── パーサ（純関数・テスト可能） ──
def parse_shopify(data, base):
    out = []
    for p in (data.get("products") or []):
        variants = p.get("variants") or []
        prices = []
        for v in variants:
            try: prices.append(float(str(v.get("price")).replace(",", "")))
            except (TypeError, ValueError): pass
        price = round(min(prices)) if prices else None
        avail = any(v.get("available") for v in variants)
        handle = p.get("handle") or ""
        out.append({"id": str(p.get("id") or handle), "name": p.get("title") or handle,
                    "price": price, "availability": "在庫あり" if avail else "品切れ",
                    "url": base + "/products/" + handle})
    return out

def _parse_by_detail_links(html, base, detail_re):
    """EC-CUBE / ColorMe 共通: 詳細リンクを起点に名前＋価格を近傍から拾う。"""
    soup = BeautifulSoup(html, "html.parser")
    items = {}
    for a in soup.find_all("a", href=True):
        mm = detail_re.search(a["href"])
        if not mm: continue
        pid = mm.group(1)
        cont = a
        for _ in range(5):
            if cont.parent is None: break
            cont = cont.parent
            cls = " ".join(cont.get("class", []))
            if cont.name == "li" or re.search(r"(item|product|list|goods|cart)", cls, re.I): break
        name = (a.get_text(strip=True) or (a.find("img") and a.find("img").get("alt", "").strip()) or "")
        if not name:
            h = cont.select_one(".product_name,.item_name,.goods_name,.ec-shelfGrid__title,h3,h4,p")
            if h: name = h.get_text(strip=True)
        txt = cont.get_text(" ", strip=True)
        prices = [int(m.group(1).replace(",", "")) for m in re.finditer(r"(?:¥|￥)\s*([0-9][0-9,]*)|([0-9][0-9,]*)\s*円", txt) if m.group(1)]
        prices += [int(m.group(2).replace(",", "")) for m in re.finditer(r"(?:¥|￥)\s*([0-9][0-9,]*)|([0-9][0-9,]*)\s*円", txt) if m.group(2)]
        price = max(prices) if prices else None
        url = urllib.parse.urljoin(base + "/", a["href"])
        prev = items.get(pid)
        if prev is None or (not prev["name"] and name) or (prev.get("price") is None and price is not None):
            items[pid] = {"id": pid, "name": name, "price": price, "availability": "", "url": url}
    return list(items.values())

DETAIL_RE_ECCUBE = re.compile(r"/products/detail/(\d+)")
DETAIL_RE_COLORME = re.compile(r"[?&]pid=(\d+)")

# ── クローラ本体 ──
def crawl_shop(session, key, cfg, delay, max_pages, debug):
    plat = cfg["platform"]; base = cfg["base"]
    raw = []
    if plat == "disabled":
        print(f"[{key}] platform=disabled のためスキップ（{cfg.get('note','')}）", file=sys.stderr)
        return raw
    if plat == "shopify":
        for handle in cfg.get("collections", ["all"]):
            for page in range(1, max_pages + 1):
                url = f"{base}/collections/{handle}/products.json?limit=250&page={page}"
                r = session.get(url, timeout=30)
                if r.status_code != 200: print(f"[{key}] p{page} HTTP {r.status_code}", file=sys.stderr); break
                if debug and page == 1: open(f"{key}_dump.json", "w", encoding="utf-8").write(r.text)
                data = r.json()
                prods = parse_shopify(data, base)
                if not prods: break
                raw += prods
                print(f"[{key}] {handle} p{page}: {len(prods)}件（累計{len(raw)}）", file=sys.stderr)
                if len(data.get("products") or []) < 250: break
                time.sleep(delay)
    elif plat == "eccube":
        robots_ok(session, base, cfg["list_path"])
        seen = set()
        for page in range(1, max_pages + 1):
            q = {"category_id": cfg["category_id"], "disp_number": 100, "pageno": page}
            url = base + cfg["list_path"] + "?" + urllib.parse.urlencode(q)
            r = session.get(url, timeout=30)
            if r.status_code != 200: print(f"[{key}] p{page} HTTP {r.status_code}", file=sys.stderr); break
            if debug and page == 1: open(f"{key}_dump.html", "w", encoding="utf-8").write(r.text)
            items = _parse_by_detail_links(r.text, base, DETAIL_RE_ECCUBE)
            new = [x for x in items if x["id"] not in seen]
            for x in new: seen.add(x["id"])
            print(f"[{key}] p{page}: {len(items)}件（新規{len(new)}／累計{len(raw)+len(new)}）", file=sys.stderr)
            if not new: break
            raw += new; time.sleep(delay)
    elif plat == "colorme":
        if not cfg.get("cbid"):
            print(f"[{key}] cbid 未設定。サイトのテキーラカテゴリURL(?mode=cate&cbid=...)を確認して設定してください。", file=sys.stderr)
            return raw
        seen = set()
        for page in range(1, max_pages + 1):
            q = {"mode": "cate", "cbid": cfg["cbid"], "csid": cfg.get("csid", 0), "page": page}
            url = base + "/?" + urllib.parse.urlencode(q)
            r = session.get(url, timeout=30)
            if r.status_code != 200: print(f"[{key}] p{page} HTTP {r.status_code}", file=sys.stderr); break
            if debug and page == 1: open(f"{key}_dump.html", "w", encoding="utf-8").write(r.text)
            items = _parse_by_detail_links(r.text, base, DETAIL_RE_COLORME)
            new = [x for x in items if x["id"] not in seen]
            for x in new: seen.add(x["id"])
            print(f"[{key}] p{page}: {len(items)}件（新規{len(new)}／累計{len(raw)+len(new)}）", file=sys.stderr)
            if not new: break
            raw += new; time.sleep(delay)
    else:
        print(f"[{key}] 未対応 platform: {plat}", file=sys.stderr)
    return raw

def write_final(key, raw):
    rows = [finalize_row(key, it) for it in raw if it.get("name")]
    rows.sort(key=lambda x: (x["price_per_ml"] == "", x["price_per_ml"] if x["price_per_ml"] != "" else 0))
    cols = ["id","name","brand_guess","class_guess","price_yen","volume_ml","volume_used",
            "vol_assumed","price_per_ml","price_750ml","availability","is_drink","is_set","shop","url"]
    out = f"{key}_tequila_final.csv"
    with open(out, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols); w.writeheader()
        for r in rows: w.writerow(r)
    priced = [r["price_750ml"] for r in rows if r["price_750ml"] != ""]
    print(f"  → {out}: {len(rows)}件 / 価格{len([r for r in rows if r['price_yen']!=''])} / "
          f"750ml換算{len(priced)}" + (f" 最安¥{min(priced):,}〜最高¥{max(priced):,}" if priced else ""))
    return len(rows)

def main():
    ap = argparse.ArgumentParser(description="マルチショップ テキーラ価格クローラ")
    ap.add_argument("--shop"); ap.add_argument("--all", action="store_true")
    ap.add_argument("--list", action="store_true"); ap.add_argument("--debug", action="store_true")
    ap.add_argument("--delay", type=float, default=1.5); ap.add_argument("--max-pages", type=int, default=60)
    a = ap.parse_args()
    if a.list:
        for k, c in SHOPS.items(): print(f"{k:12} {c['platform']:9} {c['name']}  {c.get('base','')}")
        return
    keys = [a.shop] if a.shop else (list(SHOPS) if a.all else [])
    if not keys: print("--shop <key> または --all を指定（--list で一覧）", file=sys.stderr); sys.exit(1)
    session = make_session(); total = 0
    for k in keys:
        cfg = SHOPS.get(k)
        if not cfg: print(f"未知の店: {k}", file=sys.stderr); continue
        print(f"=== {k} ({cfg['name']} / {cfg['platform']}) ===", file=sys.stderr)
        try:
            raw = crawl_shop(session, k, cfg, a.delay, a.max_pages, a.debug)
            if raw: total += write_final(k, raw)
        except Exception as e:
            print(f"[{k}] 失敗: {e}", file=sys.stderr)
    print(f"\n完了。合計 {total} 件を各 <key>_tequila_final.csv に出力しました。")

if __name__ == "__main__":
    main()

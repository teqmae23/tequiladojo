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
from html import unescape as _unescape
import requests
from bs4 import BeautifulSoup

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")

# ── 店舗設定 ──────────────────────────────────────────────
# cbid/csid が None のものは、サイトのテキーラカテゴリURLを確認して埋める（--debug 参照）
SHOPS = {
  "musashiya":   {"name": "武蔵屋",           "platform": "eccube",  "base": "https://store.musashiya-net.co.jp", "list_path": "/products/list", "category_id": 72},
  "wazawaza":    {"name": "テキーラムーチョ", "platform": "shopify", "base": "https://wazawaza.jp", "collections": ["all"]},
  "kinemon":     {"name": "酒商金右衛門",     "platform": "shopify", "base": "https://kinemon.shop", "collections": ["all"], "only_tequila": True},
  "liquorsato":  {"name": "サトー酒店",       "platform": "eccube",  "base": "https://liquor-sato.com", "list_path": "/cart/products/list", "category_id": 42},
  "youshuchiga": {"name": "洋酒専門店 千雅",  "platform": "colorme", "base": "https://youshuchiga.shop-pro.jp", "cbid": 1181170, "csid": 0},
  "chagata":     {"name": "ちゃがたパーク",   "platform": "colorme", "base": "https://www.chagata.com", "cbid": 2444445, "csid": 4},
  "mukawa":      {"name": "武川蒸留酒販売",   "platform": "colorme", "base": "https://mukawa-spirit.com", "cbid": 2163597, "csid": 0, "subcats": True},
  "biccamera":   {"name": "ビックカメラ",     "platform": "disabled", "base": "https://www.biccamera.com",
                  "note": "大規模・bot対策が強くカテゴリ構造も独自のため保留。必要なら個別対応。"},
  # ── 海外店（intl:True）。全件収集し import_intl.js で marketIntl に格納（マスタ紐付けは任意） ──
  # platform は --probe で確認してから確定。多くの米国酒販は Shopify。
  "oldtowntequila": {"name": "Old Town Tequila", "platform": "bigcommerce", "base": "https://www.oldtowntequila.com", "category_path": "/tequila/", "intl": True, "currency": "USD", "country": "US", "note": "BigCommerce(Stencil)。/tequila/ カテゴリを ?page= で巡回。"},
  "siptequila":     {"name": "Sip Tequila",      "platform": "shopify", "base": "https://siptequila.com",       "collections": ["all"],            "only_tequila": True, "intl": True, "currency": "USD"},
  "sftequilashop":  {"name": "SF Tequila Shop",  "platform": "shopify", "base": "https://sftequilashop.com",    "collections": ["all"],            "only_tequila": True, "intl": True, "currency": "USD"},
  "hiproof":        {"name": "Hi Proof",         "platform": "shopify", "base": "https://www.hiproof.com",      "collections": ["all"],            "only_tequila": True, "intl": True, "currency": "USD"},
  "klwines":        {"name": "K&L Wines",        "platform": "saved","base": "https://www.klwines.com",      "intl": True, "currency": "USD",
                     "note": "Cloudflare Turnstileで自動取得不可。ブラウザ保存HTMLを crawl_saved.py --shop klwines で処理（parse_klwines）。"},
  # ── 追加の海外店。base は推測ドメイン。まず `--intl --probe` で疎通/基盤を確認し、
  #    ✓Shopify のものはそのまま crawl、✗/到達失敗は base 修正 or 個別対応へ。
  #    小規模な米国酒販は Shopify が多いため shopify で仮置き、大規模/独自基盤は disabled。
  "remedy":         {"name": "Remedy Liquor",              "platform": "shopify", "base": "https://remedyliquor.com",      "collections": ["all"], "only_tequila": True, "intl": True, "currency": "USD", "country": "US"},
  "delmesa":        {"name": "Del Mesa Liquor",            "platform": "shopify", "base": "https://delmesaliquor.com",     "collections": ["all"], "only_tequila": True, "intl": True, "currency": "USD", "country": "US"},
  "uptown":         {"name": "Uptown Spirits",             "platform": "shopify", "base": "https://uptownspirits.com",     "collections": ["all"], "only_tequila": True, "intl": True, "currency": "USD", "country": "US"},
  "thirdbase":      {"name": "Third Base Market & Spirits","platform": "disabled", "base": "https://thirdbasemarketandspirits.com", "intl": True, "currency": "USD", "country": "US", "note": "正URL確認済だが /shop/product-groups/ の独自基盤（非Shopify）。要個別パーサ。"},
  "hitime":         {"name": "Hi-Time Wine Cellars",       "platform": "bigcommerce", "base": "https://www.hitimewine.net", "category_path": "/spirits/tequila/", "intl": True, "currency": "USD", "country": "US", "note": "BigCommerce。/spirits/tequila/ を ?page= で巡回。"},
  "montagave":      {"name": "Montagave",                  "platform": "shopify", "base": "https://montagave.com",         "collections": ["all"], "only_tequila": False, "intl": True, "currency": "USD", "country": "US", "note": "アガベ専門ブランド店。商品名にtequila語が無いため全商品収集(only_tequila:False)。"},
  "chips":          {"name": "Chips Liquor",               "platform": "shopify", "base": "https://chipsliquor.com",       "collections": ["all"], "only_tequila": True, "intl": True, "currency": "USD", "country": "US"},
  "frootbat":       {"name": "Froot Bat",                  "platform": "disabled", "base": "https://frootbat.com",         "intl": True, "currency": "USD", "country": "US", "note": "products.json 404。非Shopify基盤。要個別対応。"},
  "kegnbottles":    {"name": "Keg N Bottle",               "platform": "shopify", "base": "https://www.kegnbottle.com",    "collections": ["all"], "only_tequila": True, "intl": True, "currency": "USD", "country": "US", "note": "旧kegnbottles.comはDNS不可。kegnbottle.com(単数)を推測。--probe で再確認。"},
  "hedonism":       {"name": "Hedonism Wines",             "platform": "shopify", "base": "https://hedonism.co.uk",        "collections": ["all"], "only_tequila": True, "intl": True, "currency": "GBP", "country": "GB",
                     "note": "英・基盤不明。--probe で確認。"},
  # ── 大規模/独自基盤（bot対策強め・products.json 非対応の可能性大）: 既定 disabled。
  #    URL/基盤を --probe で確認し、可能なら個別パーサを追加。
  "totalwine":      {"name": "Total Wine & More",          "platform": "disabled", "base": "https://www.totalwine.com",        "intl": True, "currency": "USD", "country": "US", "note": "大規模EC・bot対策強。個別対応が必要。"},
  "masterofmalt":   {"name": "Master of Malt",             "platform": "disabled", "base": "https://www.masterofmalt.com",     "intl": True, "currency": "GBP", "country": "GB", "note": "英・独自基盤。個別対応が必要。"},
  "whiskyexchange": {"name": "The Whisky Exchange",        "platform": "disabled", "base": "https://www.thewhiskyexchange.com", "intl": True, "currency": "GBP", "country": "GB", "note": "英・独自基盤。個別対応が必要。"},
  "maisonduwhisky": {"name": "La Maison du Whisky",        "platform": "jsonld", "base": "https://www.whisky.fr", "category_path": "/achat/alcool/spiritueux/tequila-mezcal-sotol.html", "intl": True, "currency": "EUR", "country": "FR", "note": "Next.js。カテゴリのJSON-LD Productをページ送りで取得（テキーラ/メスカル/ソトル）。"},
  "whiskysite":     {"name": "Whiskysite.nl",              "platform": "htmlcards", "base": "https://www.whiskysite.nl", "category_path": "/nl/tequila/", "page_tmpl": "/nl/tequila/page{n}.html", "card_sel": ".product-block", "price_sel": ".product-block-price", "link_re": r"/nl/[^/]+\.html", "intl": True, "currency": "EUR", "country": "NL", "note": "サーバー描画。.product-block カードを pageN.html で巡回。"},
  # ── URL未確定（推測ドメイン）: 既定 disabled。正しい URL を確認してから有効化。
  "ludwig":         {"name": "Ludwig's Fine Wine",         "platform": "shopify", "base": "https://ludwigsfinewine.com",  "collections": ["tequila", "all"], "only_tequila": True, "intl": True, "currency": "USD", "country": "US", "note": "正URL: ludwigsfinewine.com（/collections/tequila でShopify想定）。--probe で確認。"},
  "beverlyhills":   {"name": "Beverly Hills Liquor & Wine","platform": "disabled", "base": "https://shopbeverlyhillsliquor.com","intl": True, "currency": "USD", "country": "US", "note": "正URL確認済だが /shop/?region= の独自基盤（非Shopify）。要個別パーサ。"},
  "elcerrito":      {"name": "El Cerrito Liquor",          "platform": "shopify", "base": "https://elcerritoliquor.com",   "collections": ["all"], "only_tequila": True, "intl": True, "currency": "USD", "country": "US"},
  "roadrunner":     {"name": "Road Runner Spirits",        "platform": "wix", "base": "https://www.roadrunner.la", "category_path": "/agave", "intl": True, "currency": "USD", "country": "US", "note": "Wix。カテゴリの wix-warmup-data(JSON) から商品抽出。"},
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
                         r"チケット|試飲券|キャップ|ボトルホルダ|ポスター|タンブラー|マグ|エプロン|パーカー|book|"
                         r"ラッピング|包装|カレンダー|ドリップバッグ|珈琲|コーヒー|お猪口|おちょこ|ぐい呑|升\b|マドラー|"
                         r"ポアラー|保冷|巾着|レシピ|冊子|DVD|ギフトボックス|化粧箱|手帳|ノート|ステッカー|トートバッグ|"
                         r"送料|配送|クール便|代引|ラッピング料|手数料|のし|熨斗", re.I)
# ColorMe等のサイドバー/ランキング枠を除外するための ancestor id/class パターン
SIDEBAR_RE = re.compile(r"sidebar|side_a|side_b|_side|side_|ranking|rank_|recommend|osusume|pickup|"
                        r"history|checkitem|recent|saikin|viewed|relation|relate|footer|header|breadcrumb|topicpath", re.I)
RANK_NAME_RE = re.compile(r"^\s*No\.?\s*\d")
SET_RE = re.compile(r"セット|飲み比べ|ギフトBOX|詰め合わせ|アソート")
# 品切れ文言（ColorMe/EC-CUBE等は在庫を明示要素で持たないため文言/ボタンで推定）。
# EC-CUBEの「再入荷通知」系（＝在庫切れ）も対象。単なる「再入荷しました」等の誤検出は近接語で回避。
SOLDOUT_RE = re.compile(r"品切れ|売り?切れ|在庫切れ|在庫なし|完売|入荷待ち|入荷未定|SOLD\s*OUT|soldout|再入荷.{0,8}(?:通知|希望|お知らせ|メール)", re.I)
# 容量: カンマ区切り(4,000ml)にも対応。取得後にカンマ除去し妥当域のみ採用。
VOL_RE = re.compile(r"(\d[\d,]*)\s*ml|(\d(?:\.\d+)?)\s*[lL](?![a-z])", re.I)
# 度数(ABV): 誤検出（"25% off" / "100% agave"）を避けるためアルコール語が隣接する場合のみ採用。
ABV_RE = re.compile(r"(\d{2,3}(?:\.\d+)?)\s*%\s*(?:abv|alc\.?|alcohol|vol)|(?:abv|alc\.?|alcohol)[^0-9]{0,8}(\d{2,3}(?:\.\d+)?)\s*%|(\d{2,3}(?:\.\d+)?)\s*proof", re.I)

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
    if m.group(1):
        v = int(m.group(1).replace(",", ""))       # 4,000ml → 4000
        return v if 10 <= v <= 20000 else None
    return int(float(m.group(2)) * 1000)
def abv_of(text):
    for m in ABV_RE.finditer(text or ""):
        if m.group(3):                                   # proof → ABV = proof/2
            try: v = float(m.group(3)) / 2.0
            except ValueError: continue
        else:
            g = m.group(1) or m.group(2)
            try: v = float(g)
            except (TypeError, ValueError): continue
        if 35 <= v <= 75: return round(v, 1)             # テキーラの妥当域（35%以上）のみ採用
    return None
def _abv_loose(text):
    """スペック専用要素（千雅 .product-list__expl「750ml 40％」等）向けの緩い度数抽出。
    文脈が明確なので % / ％ / 度 の数値をそのまま採用（テキーラ妥当域 35〜75% のみ）。"""
    for m in re.finditer(r"(\d{2,3}(?:\.\d+)?)\s*(?:[%％]|度)", text or ""):
        try: v = float(m.group(1))
        except ValueError: continue
        if 35 <= v <= 75: return round(v, 1)
    return None
def abv_ja(text):
    """商品名・本文から日本語の度数表記を安全に抽出（"100% agave"/"25% off"等の誤検出回避）。
    採用: 「40度」および「度数/アルコール分/アルコール度数 40%」。裸の「40%」は採らない。"""
    t = text or ""
    for m in re.finditer(r"(\d{2,3}(?:\.\d+)?)\s*度(?!数)", t):                 # 「40度」
        try: v = float(m.group(1))
        except ValueError: continue
        if 35 <= v <= 75: return round(v, 1)
    for m in re.finditer(r"(?:アルコール度数|アルコール分|度数|alc\.?|abv|alcohol)[^0-9]{0,6}(\d{2,3}(?:\.\d+)?)\s*[%％]", t, re.I):
        try: v = float(m.group(1))
        except ValueError: continue
        if 35 <= v <= 75: return round(v, 1)
    return None
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
        "currency": SHOPS.get(shop, {}).get("currency", "JPY"),
        "abv": (it.get("abv") if it.get("abv") is not None else (abv_of(name) or abv_ja(name))) or "",
    }

# ── HTTP ──────────────────────────────────────────────────
def make_session():
    s = requests.Session()
    # 実ブラウザに近いヘッダ（簡易な403対策を通す狙い。JSチャレンジ型のCloudflareは通らない）
    s.headers.update({
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,ja;q=0.8",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "sec-ch-ua": '"Chromium";v="125", "Not.A/Brand";v="24", "Google Chrome";v="125"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
    })
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
# only_tequila 判定: 「テキーラ/tequila」語が無くても、テキーラ/メスカル固有のクラス語
# （ブランコ/レポサド/アニェホ等）やメスカルを含むものはテキーラ扱いにする。
# 例: 金右衛門「カジェ23 ブランコ 700ml【新バッチ】」（tags: ブランコ）は "ブランコ" で拾う。
# クラス語はテキーラ/メスカル固有のためウイスキー等の誤混入は起きにくい。
TEQ_TYPE_RE = re.compile(
    r"テキーラ|tequila|メスカル|mezcal|mescal"
    r"|ブランコ|レポサ[ドート]|アニェホ|アネホ|クリスタリーノ|ホーベン|プラタ"
    r"|blanco|reposado|a[ñn]ejo|cristalino|joven|plata", re.I)
def parse_shopify(data, base, only_tequila=False):
    out = []
    for p in (data.get("products") or []):
        if only_tequila:
            hay = (p.get("product_type") or "") + " " + " ".join(p.get("tags") or []) + " " + (p.get("title") or "")
            if not TEQ_TYPE_RE.search(hay): continue
        variants = p.get("variants") or []
        prices = []
        for v in variants:
            try: prices.append(float(str(v.get("price")).replace(",", "")))
            except (TypeError, ValueError): pass
        price = round(min(prices)) if prices else None
        avail = any(v.get("available") for v in variants)
        handle = p.get("handle") or ""
        hay = (p.get("title") or "") + " " + (p.get("body_html") or "")
        out.append({"id": str(p.get("id") or handle), "name": p.get("title") or handle,
                    "price": price, "availability": "在庫あり" if avail else "品切れ",
                    "abv": abv_of(hay) or abv_ja(hay),
                    "url": base + "/products/" + handle})
    return out

_PRICE_RE = re.compile(r"(?:¥|￥)\s*([0-9][0-9,]*)|([0-9][0-9,]*)\s*円")
_META_CS_RE = re.compile(rb'charset\s*=\s*["\']?\s*([A-Za-z0-9_\-]+)', re.I)
def _decoded(r):
    """HTMLを正しい文字コードで取得。ヘッダに charset が無い店（shop-pro/ColorMe等の
    EUC-JP、一部EC-CUBEのShift_JIS）を UTF-8 と誤読して価格『円』が化ける問題を回避する。
    優先順位: HTTPヘッダの charset > HTML内の <meta charset> > バイト列からの推定。"""
    ctype = (r.headers.get("content-type") or "").lower()
    if "charset=" in ctype:
        return r.text                          # ヘッダ明示ありは requests の r.encoding を尊重
    m = _META_CS_RE.search(r.content[:4096])   # <meta charset=...> を優先（shop-proはeuc-jp明示）
    if m:
        try:
            r.encoding = m.group(1).decode("ascii")
            return r.text
        except Exception:
            pass
    if r.apparent_encoding:                     # 最後はバイト列から推定（EUC-JP/Shift_JIS/UTF-8を判別）
        r.encoding = r.apparent_encoding
    return r.text

def _extract_prices(txt):
    vals = []
    for m in _PRICE_RE.finditer(txt or ""):
        g = m.group(1) or m.group(2)
        if g:
            try: vals.append(int(g.replace(",", "")))
            except ValueError: pass
    return vals

def _in_sidebar(a):
    for anc in a.parents:
        idc = ((anc.get("id") or "") + " " + " ".join(anc.get("class") or [])).strip()
        if idc and SIDEBAR_RE.search(idc): return True
    return False

# 商品タイル内の「価格要素」を優先的に拾うためのセレクタ（shop-pro/ColorMe/EC-CUBE/BEM系）。
# 定価・ポイント・送料無料条件などの余計な数値を巻き込まないよう、まず価格要素だけを見る。
PRICE_SELECTORS = [
    ".product-list__price", ".list-product-item__price", ".ec-price", ".ec-shelfGrid__item .price",
    ".product_price", ".product-price", ".item_price", ".item-price", ".goods_price",
    ".price", '[class*="price"]', '[class*="Price"]',
]

def _single_product_scope(a, detail_re, max_up=8):
    """アンカー(商品リンク)を起点に、他商品を含まない範囲で最大の祖先要素を返す。
    価格を近傍から拾う際、隣のタイルや『最近チェックした商品』等の別商品(=高額ボトル)の
    価格を max() で誤って拾う事故を防ぐ。親へ辿り、2件目の商品リンクが現れたら直前で止める。"""
    node = a; best = a
    for _ in range(max_up):
        p = node.parent
        if p is None: break
        pids = set()
        for x in p.find_all("a", href=True):
            m = detail_re.search(x.get("href") or "")
            if m: pids.add(m.group(1))
        if len(pids) > 1: break   # 別商品を含み始めた → これ以上広げない
        best = p; node = p
    return best

def _parse_by_detail_links(html, base, detail_re, exclude_sidebar=False):
    """EC-CUBE / ColorMe 共通: 詳細リンクを起点に名前＋価格を近傍から拾う。
    exclude_sidebar=True でサイドバー/ランキング枠のリンクを除外（ColorMe用）。"""
    soup = BeautifulSoup(html, "html.parser")
    items = {}
    for a in soup.find_all("a", href=True):
        mm = detail_re.search(a["href"])
        if not mm: continue
        if exclude_sidebar and _in_sidebar(a): continue
        pid = mm.group(1)
        cont = a
        for _ in range(5):
            if cont.parent is None: break
            cont = cont.parent
            cls = " ".join(cont.get("class", []))
            if cont.name == "li" or re.search(r"(item|product|list|goods|cart)", cls, re.I): break
        # 商品名: タイル全体が単一<a>で囲まれ get_text だと価格/容量が混ざる形式(武川等)に対応。
        # 専用の商品名要素(.list-product-item__ttl)があれば最優先で採用する（他店は該当なしで従来通り）。
        ttl = a.select_one(".list-product-item__ttl") or cont.select_one(".list-product-item__ttl")
        name = ttl.get_text(strip=True) if ttl else (a.get_text(strip=True) or (a.find("img") and a.find("img").get("alt", "").strip()) or "")
        if not name:
            h = cont.select_one(".product_name,.item_name,.goods_name,.ec-shelfGrid__title,h3,h4,p")
            if h: name = h.get_text(strip=True)
        # 容量/度数ヒント: 名前でなく別要素にスペックがある形式を補完。
        #   武川 .list-product-item__memo「テキーラ | 700ml / 40% / 正規品」/ 千雅 .product-list__expl「750ml 40％」。
        vol_hint = None; abv_hint = None
        spec = (a.select_one(".list-product-item__memo") or cont.select_one(".list-product-item__memo")
                or cont.select_one(".product-list__expl") or cont.select_one(".item_expl"))
        if spec:
            stxt = spec.get_text(" ", strip=True)
            vol_hint = vol_from_name(stxt); abv_hint = _abv_loose(stxt)
        if exclude_sidebar and RANK_NAME_RE.match(name): continue  # 「No.3 …」等のランキング枠を除外
        # 価格: 「この商品タイル」の範囲(=他商品を含まない最大の祖先)に限定して拾う。
        #   ①専用の価格要素があればそこだけを見る（定価/ポイント/送料条件などの数値を除外）
        #   ②無ければタイル全体テキストから抽出。いずれも税込を優先して max。
        #   隣接タイルや『最近チェックした商品』等の別商品(高額ボトル)を巻き込まない。
        scope = _single_product_scope(a, detail_re)
        ps = []
        for sel in PRICE_SELECTORS:
            pe = scope.select_one(sel)
            if pe:
                got = _extract_prices(pe.get_text(" ", strip=True))
                if got: ps = got; break
        if not ps:
            ps = _extract_prices(scope.get_text(" ", strip=True))
        price = max(ps) if ps else None
        url = urllib.parse.urljoin(base + "/", a["href"])
        # 在庫（明示要素が無いColorMe/EC-CUBE向け・複数シグナルで推定。不明は在庫あり側に倒す）:
        #   ①品切れ文言(SOLD OUT/売切れ/品切れ/在庫なし/完売/入荷待ち/再入荷通知) または
        #   ②カート/購入ボタンが disabled → 品切れ。それ以外で価格あり → 在庫あり。
        soldout = bool(SOLDOUT_RE.search(scope.get_text(" ", strip=True)))
        if not soldout:
            for b in scope.find_all(["button", "input", "a"]):
                lbl = (b.get_text(" ", strip=True) + " " + (b.get("value") or "")).strip()
                if re.search(r"カート|購入|買い物|cart", lbl, re.I):
                    cls = " ".join(b.get("class") or [])
                    if b.has_attr("disabled") or re.search(r"disabled|sold ?out|nostock|out-?of-?stock", cls, re.I):
                        soldout = True; break
        # 品切れは価格を持たせない（武蔵屋等は品切れ時に価格を表示しないため、
        # タイル内やレイアウトに残る数値を相場として拾わないよう明示的に None にする）。
        if soldout: price = None
        # 商品ページはあるが価格が取れない＝購入不可＝在庫切れ扱い（? ではなく品切れ=赤丸）
        avail = "品切れ" if (soldout or price is None) else "在庫あり"
        prev = items.get(pid)
        if prev is None or (not prev["name"] and name) or (prev.get("price") is None and price is not None):
            items[pid] = {"id": pid, "name": name, "price": price, "availability": avail, "url": url, "volume_ml": vol_hint, "abv": abv_hint}
    return list(items.values())

DETAIL_RE_ECCUBE = re.compile(r"/products/detail/(\d+)")
DETAIL_RE_COLORME = re.compile(r"[?&]pid=(\d+)")

# ── 通貨記号つき金額の抽出（$ / £ / €、USD等）。海外店HTML用 ──
# 米/英式(1,234.56) と 欧式(1.234,56 / 18,95) の両方に対応。末尾の「区切り＋1〜2桁」を小数部とみなす。
_MONEY_RE = re.compile(r'(?:\$|£|€|USD|GBP|EUR)\s*([0-9][0-9.,]*)')
def _num_from_money(tok):
    tok = tok.strip().rstrip(".,")
    m = re.search(r'[.,](\d{1,2})$', tok)
    if m:
        idx = m.start()
        intp = re.sub(r'[.,]', '', tok[:idx]) or "0"
        return float(intp + "." + tok[idx + 1:])
    return float(re.sub(r'[.,]', '', tok) or "0")
def _extract_money(txt):
    vals = []
    for m in _MONEY_RE.finditer(txt or ""):
        try: vals.append(_num_from_money(m.group(1)))
        except ValueError: pass
    return vals
def _slug_id(url):
    if not url: return ""
    return (url.rstrip("/").split("/")[-1].split("?")[0])[:60]

def parse_html_cards(html, base, cfg):
    """設定駆動の汎用カードパーサ（サーバー描画のカテゴリHTML用）。
    card_sel でカード要素、price_sel で価格、link_re で商品リンクを特定。名前は
    リンク文字列→img alt→title→URLスラッグ の順でフォールバック。"""
    soup = BeautifulSoup(html, "html.parser")
    cards = soup.select(cfg.get("card_sel", ".product"))
    link_re = re.compile(cfg["link_re"]) if cfg.get("link_re") else None
    price_sel = cfg.get("price_sel")
    out, seen = [], set()
    for c in cards:
        a = None
        for cand in c.select("a[href]"):
            if link_re and not link_re.search(cand.get("href", "")): continue
            a = cand; break
        if a is None: a = c.select_one("a[href]")
        url = a.get("href", "") if a else ""
        name = ""
        if a:
            img = a.select_one("img")
            name = (a.get_text(strip=True) or (img.get("alt", "").strip() if img else "") or a.get("title", "").strip())
        if not name:
            im = c.select_one("img")
            if im: name = im.get("alt", "").strip()
        if not name and url:
            name = _slug_id(url).replace("-", " ").replace(".html", "").strip()
        if not name: continue
        pe = c.select_one(price_sel) if price_sel else None
        prices = _extract_money(pe.get_text(" ", strip=True)) if pe else _extract_money(c.get_text(" ", strip=True))
        price = min(prices) if prices else None
        avail = "品切れ" if re.search(r"sold ?out|uitverkocht|out of stock|niet (op|meer) voorraad", c.get_text(" ", strip=True), re.I) else "在庫あり"
        pid = _slug_id(url) or name
        if pid in seen: continue
        seen.add(pid)
        out.append({"id": pid, "name": name, "price": price, "availability": avail,
                    "url": urllib.parse.urljoin(base + "/", url) if url else ""})
    return out

def parse_wix_warmup(html, base):
    """Wixのカテゴリページに埋め込まれた wix-warmup-data(JSON)から商品を抽出。
    name(文字列)+price(数値)+スラッグ系キーを持つオブジェクトを再帰的に拾う。"""
    blob = None
    m = re.search(r'<script[^>]+id=["\']wix-warmup-data["\'][^>]*>(.*?)</script>', html or "", re.S)
    if m:
        try: blob = json.loads(m.group(1))
        except Exception: blob = None
    if blob is None:
        m2 = re.search(r'warmupData\s*=\s*(\{.*?\})\s*;\s*</script>', html or "", re.S)
        if m2:
            try: blob = json.loads(m2.group(1))
            except Exception: blob = None
    if blob is None: return []
    out, seen, stack = [], set(), [blob]
    while stack:
        d = stack.pop()
        if isinstance(d, list): stack.extend(d); continue
        if not isinstance(d, dict): continue
        name, price = d.get("name"), d.get("price")
        keys = d.keys()
        if isinstance(name, str) and isinstance(price, (int, float)) and price > 0 \
           and any(k in keys for k in ("urlPart", "productPageUrl", "slug", "formattedPrice")):
            slug = d.get("urlPart") or d.get("slug") or ""
            url = ""
            ppu = d.get("productPageUrl")
            if isinstance(ppu, dict): url = (ppu.get("base", "") + ppu.get("path", "")) or ""
            elif isinstance(ppu, str): url = ppu
            if not url and slug: url = base + "/product-page/" + slug
            avail = "品切れ" if (d.get("inStock") is False or d.get("isInStock") is False) else "在庫あり"
            pid = slug or name
            if pid not in seen:
                seen.add(pid)
                out.append({"id": pid, "name": name, "price": float(price), "availability": avail, "url": url})
        for v in d.values():
            if isinstance(v, (dict, list)): stack.append(v)
    return out

def parse_klwines(html_text, base="https://shop.klwines.com"):
    """K&L Wines(Next.js/Algolia)の【手動保存HTML】から商品を抽出。
    商品名は aria-label='View details for …'、価格は同一タイル内の $x.xx（次商品の直前まで）。
    自動取得はCloudflare Turnstileで不可 → ブラウザ保存HTMLを crawl_saved.py で処理する。"""
    seen, uniq = set(), []
    for m in re.finditer(r'aria-label="View details for ([^"]+)"[^>]*href="https://shop\.klwines\.com/products/details/(\d+)"', html_text):
        pid = m.group(2)
        if pid in seen: continue
        seen.add(pid); uniq.append((pid, m.group(1), m.start()))
    pr = re.compile(r'\$([0-9][0-9,]*\.[0-9]{2})')
    out = []
    for i, (pid, name, pos) in enumerate(uniq):
        end = uniq[i + 1][2] if i + 1 < len(uniq) else len(html_text)
        prices = [float(x.replace(",", "")) for x in pr.findall(html_text[pos:end])]
        price = min(prices) if prices else None      # 価格なし=入荷待ち/店頭のみ(allocated)
        out.append({"id": pid, "name": _unescape(name).strip(), "price": price,
                    "availability": "在庫あり" if price is not None else "",
                    "url": base + "/products/details/" + pid})
    return out

def parse_bigcommerce(html, base):
    """BigCommerce(Stencil)のカテゴリHTMLから商品カードを抽出（name/price/url/在庫）。
    テーマ差に強いよう複数セレクタをフォールバック。カテゴリ配下＝全テキーラ前提。"""
    soup = BeautifulSoup(html, "html.parser")
    cards = soup.select("li.product")
    if not cards: cards = soup.select("article.card")
    if not cards: cards = soup.select("ul.productGrid > li, .productGrid li, li.productGrid-item")
    out, seen = [], set()
    for c in cards:
        a = c.select_one(".card-title a, h3.card-title a, h4.card-title a, .card-title, .productView-title a")
        name, url = "", ""
        if a:
            name = a.get_text(strip=True) or (a.get("aria-label") or "").strip()
            if a.name == "a": url = a.get("href", "")
        if not url:
            la = c.select_one("a[href]")
            if la:
                url = la.get("href", "")
                if not name:
                    img = la.select_one("img"); name = (img.get("alt", "").strip() if img else "")
        if not name: continue
        pe = c.select_one("[data-product-price-without-tax], .price--withoutTax, .price--main, .price-section .price, span.price, .price")
        prices = _extract_money(pe.get_text(" ", strip=True)) if pe else []
        if not prices: prices = _extract_money(c.get_text(" ", strip=True))
        price = min(prices) if prices else None
        avail = "品切れ" if re.search(r"out of stock|sold out|unavailable|品切", c.get_text(" ", strip=True), re.I) else "在庫あり"
        pid = _slug_id(url) or name
        if pid in seen: continue
        seen.add(pid)
        out.append({"id": pid, "name": name, "price": price, "availability": avail,
                    "url": urllib.parse.urljoin(base + "/", url) if url else ""})
    return out

# ── クローラ本体 ──
def crawl_shop(session, key, cfg, delay, max_pages, debug):
    plat = cfg["platform"]; base = cfg["base"]
    raw = []
    if plat == "disabled":
        print(f"[{key}] platform=disabled のためスキップ（{cfg.get('note','')}）", file=sys.stderr)
        return raw
    if plat == "saved":
        print(f"[{key}] platform=saved: ブラウザ保存HTMLを crawl_saved.py --shop {key} <保存.html> で処理してください。", file=sys.stderr)
        return raw
    if plat == "shopify":
        for handle in cfg.get("collections", ["all"]):
            for page in range(1, max_pages + 1):
                url = f"{base}/collections/{handle}/products.json?limit=250&page={page}"
                r = session.get(url, timeout=30)
                if r.status_code != 200: print(f"[{key}] p{page} HTTP {r.status_code}", file=sys.stderr); break
                if debug and page == 1: open(f"{key}_dump.json", "w", encoding="utf-8").write(r.text)
                data = r.json()
                rawprods = data.get("products") or []
                if not rawprods: break
                prods = parse_shopify(data, base, only_tequila=cfg.get("only_tequila", False))
                raw += prods
                print(f"[{key}] {handle} p{page}: {len(prods)}件（累計{len(raw)}）", file=sys.stderr)
                if len(rawprods) < 250: break
                time.sleep(delay)
    elif plat == "eccube":
        robots_ok(session, base, cfg["list_path"])
        seen = set()
        for page in range(1, max_pages + 1):
            q = {"category_id": cfg["category_id"], "disp_number": 100, "pageno": page}
            url = base + cfg["list_path"] + "?" + urllib.parse.urlencode(q)
            r = session.get(url, timeout=30)
            if r.status_code != 200: print(f"[{key}] p{page} HTTP {r.status_code}", file=sys.stderr); break
            txt = _decoded(r)
            if debug and page == 1: open(f"{key}_dump.html", "w", encoding="utf-8").write(txt)
            items = _parse_by_detail_links(txt, base, DETAIL_RE_ECCUBE)
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
        base_csid = cfg.get("csid", 0)
        # subcats: カテゴリ(csid=0)が商品一覧ではなくブランド別サブカテゴリ索引の店（武川等）。
        #   索引ページから同一cbid配下のcsidを収集し、各サブカテゴリを巡回して商品を集約する。
        csids = [base_csid]
        if cfg.get("subcats"):
            idx_url = base + "/?" + urllib.parse.urlencode({"mode": "cate", "cbid": cfg["cbid"], "csid": base_csid})
            r = session.get(idx_url, timeout=30)
            if r.status_code == 200:
                idx = _decoded(r)
                found = re.findall(r"cbid=%s&(?:amp;)?csid=(\d+)" % re.escape(str(cfg["cbid"])), idx)
                subs = sorted({int(c) for c in found if int(c) != int(base_csid or 0)})
                if subs: csids = subs
                print(f"[{key}] サブカテゴリ {len(csids)}件を巡回", file=sys.stderr)
            else:
                print(f"[{key}] 索引取得 HTTP {r.status_code}", file=sys.stderr)
        for ci, csid in enumerate(csids):
            for page in range(1, max_pages + 1):
                q = {"mode": "cate", "cbid": cfg["cbid"], "csid": csid, "page": page}
                url = base + "/?" + urllib.parse.urlencode(q)
                r = session.get(url, timeout=30)
                if r.status_code != 200: print(f"[{key}] csid{csid} p{page} HTTP {r.status_code}", file=sys.stderr); break
                txt = _decoded(r)
                if debug and page == 1 and ci == 0: open(f"{key}_dump.html", "w", encoding="utf-8").write(txt)
                items = _parse_by_detail_links(txt, base, DETAIL_RE_COLORME, exclude_sidebar=True)
                new = [x for x in items if x["id"] not in seen]
                for x in new: seen.add(x["id"])
                if not cfg.get("subcats"):
                    print(f"[{key}] p{page}: {len(items)}件（新規{len(new)}／累計{len(raw)+len(new)}）", file=sys.stderr)
                raw += new
                if not new: break
                time.sleep(delay)
            if cfg.get("subcats"):
                print(f"[{key}] csid{csid} ({ci+1}/{len(csids)}) 累計{len(raw)}", file=sys.stderr)
    elif plat == "bigcommerce":
        cat = cfg.get("category_path", "/")
        seen = set()
        for page in range(1, max_pages + 1):
            sep = "&" if "?" in cat else "?"
            url = base + cat + f"{sep}page={page}"
            r = session.get(url, timeout=30)
            if r.status_code != 200: print(f"[{key}] p{page} HTTP {r.status_code}", file=sys.stderr); break
            txt = _decoded(r)
            if debug and page == 1: open(f"{key}_dump.html", "w", encoding="utf-8").write(txt)
            items = parse_bigcommerce(txt, base)
            new = [x for x in items if x["id"] not in seen]
            for x in new: seen.add(x["id"])
            print(f"[{key}] p{page}: {len(items)}件（新規{len(new)}／累計{len(raw)+len(new)}）", file=sys.stderr)
            if not new: break
            raw += new; time.sleep(delay)
    elif plat == "jsonld":
        # カテゴリHTMLの JSON-LD(Product/ItemList) からページ送りで取得（多くのECで共通に使える）
        cat = cfg.get("category_path", "/")
        page_param = cfg.get("page_param", "page")
        only_teq = cfg.get("only_tequila", False)
        seen = set()
        for page in range(1, max_pages + 1):
            sep = "&" if "?" in cat else "?"
            url = base + cat + ("" if page == 1 else f"{sep}{page_param}={page}")
            r = session.get(url, timeout=30)
            if r.status_code != 200: print(f"[{key}] p{page} HTTP {r.status_code}", file=sys.stderr); break
            txt = _decoded(r)
            if debug and page == 1: open(f"{key}_dump.html", "w", encoding="utf-8").write(txt)
            items = []
            for p in extract_jsonld_products(txt):
                name = (p.get("name") or "").strip()
                if not name: continue
                if only_teq and not TEQ_TYPE_RE.search(name): continue
                try: price = float(str(p.get("price")).replace(",", "")) if p.get("price") not in (None, "") else None
                except ValueError: price = None
                av = str(p.get("availability") or "")
                avail = "在庫あり" if re.search(r"instock|in_stock", av, re.I) else ("品切れ" if av else "")
                purl = p.get("url") or ""
                items.append({"id": _slug_id(purl) or name, "name": name, "price": price,
                              "availability": avail, "url": urllib.parse.urljoin(base + "/", purl) if purl else ""})
            new = [x for x in items if x["id"] not in seen]
            for x in new: seen.add(x["id"])
            print(f"[{key}] p{page}: {len(items)}件（新規{len(new)}／累計{len(raw)+len(new)}）", file=sys.stderr)
            if not new: break
            raw += new; time.sleep(delay)
    elif plat == "htmlcards":
        cat = cfg.get("category_path", "/")
        tmpl = cfg.get("page_tmpl")   # page>1 のURL（{n}）。無ければ ?page=N
        seen = set()
        for page in range(1, max_pages + 1):
            if page == 1: path = cat
            elif tmpl: path = tmpl.replace("{n}", str(page))
            else: sep = "&" if "?" in cat else "?"; path = f"{cat}{sep}page={page}"
            r = session.get(base + path, timeout=30)
            if r.status_code != 200: print(f"[{key}] p{page} HTTP {r.status_code}", file=sys.stderr); break
            txt = _decoded(r)
            if debug and page == 1: open(f"{key}_dump.html", "w", encoding="utf-8").write(txt)
            items = parse_html_cards(txt, base, cfg)
            new = [x for x in items if x["id"] not in seen]
            for x in new: seen.add(x["id"])
            print(f"[{key}] p{page}: {len(items)}件（新規{len(new)}／累計{len(raw)+len(new)}）", file=sys.stderr)
            if not new: break
            raw += new; time.sleep(delay)
    elif plat == "wix":
        cat = cfg.get("category_path", "/")
        seen = set()
        for page in range(1, max_pages + 1):
            sep = "&" if "?" in cat else "?"
            url = base + cat + ("" if page == 1 else f"{sep}page={page}")
            r = session.get(url, timeout=30)
            if r.status_code != 200: print(f"[{key}] p{page} HTTP {r.status_code}", file=sys.stderr); break
            txt = _decoded(r)
            if debug and page == 1: open(f"{key}_dump.html", "w", encoding="utf-8").write(txt)
            items = parse_wix_warmup(txt, base)
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
            "vol_assumed","price_per_ml","price_750ml","availability","is_drink","is_set","shop","url","currency","abv"]
    out = f"{key}_tequila_final.csv"
    with open(out, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols); w.writeheader()
        for r in rows: w.writerow(r)
    priced = [r["price_750ml"] for r in rows if r["price_750ml"] != ""]
    cur = SHOPS.get(key, {}).get("currency", "JPY")
    sym = {"JPY": "¥", "USD": "$", "EUR": "€", "GBP": "£"}.get(cur, cur + " ")
    print(f"  → {out}: {len(rows)}件 / 価格{len([r for r in rows if r['price_yen']!=''])} / "
          f"750ml換算{len(priced)}" + (f" 最安{sym}{min(priced):,}〜最高{sym}{max(priced):,}" if priced else ""))
    return len(rows)

def probe_shop(session, key, cfg):
    """Shopify(products.json)対応か判定。crawler が実際に使う collections/all を優先し、
    ダメなら root /products.json も試す（root feed だけ無効な店を拾う）。海外店の基盤確認用。"""
    base = cfg.get("base", "")
    last_status, last_ct = None, ""
    for ep in ("/collections/all/products.json?limit=1", "/products.json?limit=1"):
        try:
            r = session.get(base + ep, timeout=25)
        except Exception as e:
            print(f"{key:16} 到達失敗: {e}")
            return
        last_status, last_ct = r.status_code, r.headers.get("content-type", "")
        if r.status_code == 200 and "json" in last_ct.lower():
            try:
                d = r.json(); prods = d.get("products", [])
                sample = (prods[0].get("title", "") if prods else "")[:40]
                print(f"{key:16} ✓ Shopify（{ep} OK, {len(prods)}件 例:{sample}）")
                return
            except Exception:
                pass
    print(f"{key:16} ✗ 非Shopify?  HTTP {last_status} / {last_ct}  → 個別対応が必要")

# ── 非Shopify店の基盤・構造を調べる sniff（個別パーサ作成の下調べ用） ──
def detect_platform(html, headers):
    h = (html or "")[:300000].lower()
    sig = {
        "shopify":       ("cdn.shopify.com" in h or "shopify.theme" in h or "myshopify.com" in h),
        "bigcommerce":   ("bigcommerce.com" in h or "stencil-utils" in h or "data-stencil" in h),
        "woocommerce":   ("woocommerce" in h or "wp-content/plugins/woocommerce" in h),
        "magento":       ("mage/cookies" in h or "/static/version" in h or "magento" in h or "data-mage-init" in h),
        "wordpress":     ("wp-content" in h or "wp-json" in h),
        "squarespace":   ("squarespace" in h or "static1.squarespace" in h),
        "wix":           ("wixstatic" in h or "wix.com" in h),
        "salesforce_cc": ("demandware" in h or "dwstatic" in h),
        "shopware":      ("shopware" in h),
        "prestashop":    ("prestashop" in h),
        "city_hive":     ("cityhive" in h or "city-hive" in h),
        "bottlecapps":   ("bottlecapps" in h),
    }
    found = [k for k, v in sig.items() if v]
    server = (headers.get("server", "") if headers else "")
    powered = (headers.get("x-powered-by", "") if headers else "")
    extra = " ".join(x for x in [f"server:{server}" if server else "", f"x-powered-by:{powered}" if powered else ""] if x)
    return (", ".join(found) or "unknown") + (f"  [{extra}]" if extra else "")

def _iter_jsonld(html):
    for m in re.finditer(r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>', html or "", re.I | re.S):
        try:
            data = json.loads(m.group(1).strip())
        except Exception:
            continue
        stack = [data]
        while stack:
            d = stack.pop()
            if isinstance(d, list): stack.extend(d); continue
            if isinstance(d, dict):
                if isinstance(d.get("@graph"), list): stack.extend(d["@graph"])
                yield d

def extract_jsonld_products(html):
    """JSON-LD(構造化データ)から Product / ItemList を抽出（多くのEC共通で使える）。"""
    def types_of(d):
        t = d.get("@type"); return t if isinstance(t, list) else [t]
    def one_offer(off):
        if isinstance(off, list): off = off[0] if off else {}
        if not isinstance(off, dict): return None, "", ""
        price = off.get("price") or off.get("lowPrice") or (off.get("priceSpecification", {}) or {}).get("price")
        return price, off.get("availability", ""), off.get("priceCurrency", "")
    out = []
    for d in _iter_jsonld(html):
        ts = types_of(d)
        if "Product" in ts:
            price, avail, cur = one_offer(d.get("offers") or {})
            out.append({"name": d.get("name"), "price": price, "availability": avail, "currency": cur, "url": d.get("url", "")})
        elif "ItemList" in ts:
            for el in (d.get("itemListElement") or []):
                item = el.get("item") if isinstance(el, dict) else None
                if isinstance(item, dict):
                    price, avail, cur = one_offer(item.get("offers") or {})
                    out.append({"name": item.get("name"), "price": price, "availability": avail, "currency": cur, "url": item.get("url", "")})
    return out

def sniff_shop(session, key, cfg, path):
    """非Shopify店の下調べ: 指定URLを取得し、基盤判定・JSON-LD商品抽出・テキーラ関連リンクを表示。
    HTMLは <key>_sniff.html に保存。--path 未指定ならトップページを見てカテゴリ候補リンクを探す。"""
    base = cfg.get("base", "")
    url = base + (path or "")
    try:
        r = session.get(url, timeout=30)
    except Exception as e:
        print(f"[{key}] 到達失敗 {url}: {e}"); return
    html = _decoded(r) or ""
    fn = f"{key}_sniff.html"
    try: open(fn, "w", encoding="utf-8").write(html)
    except Exception: pass
    print(f"[{key}] {url}")
    print(f"  HTTP {r.status_code} / {r.headers.get('content-type','')[:28]} / {len(html):,}bytes / dump: {fn}")
    print(f"  platform = {detect_platform(html, r.headers)}")
    prods = extract_jsonld_products(html)
    print(f"  JSON-LD Product/ItemList: {len(prods)}件" + ("（このページから直接取れる可能性）" if prods else "（このページには無し）"))
    for p in prods[:6]:
        print(f"    - {str(p.get('name'))[:46]:46} | {p.get('price')} {p.get('currency','')} | {str(p.get('availability'))[-18:]}")
    # BigCommerce等のカードHTML抽出テスト（同じ実行で個別パーサの効きを確認）
    try: cards = parse_bigcommerce(html, base)
    except Exception as e: cards = []; print(f"  カード抽出エラー: {e}")
    print(f"  カード抽出テスト(BigCommerce): {len(cards)}件")
    for p in cards[:8]:
        print(f"    - {str(p.get('name'))[:44]:44} | {p.get('price')} | {p.get('availability')} | {p.get('url','')[-36:]}")
    # テキーラ関連リンク（カテゴリURL探し。トップ or 一覧ページで有用）
    links = []
    for m in re.finditer(r'href=["\']([^"\']+)["\']', html, re.I):
        href = m.group(1)
        if re.search(r'tequila|agave', href, re.I) and href not in links:
            links.append(href)
    if links:
        print(f"  'tequila/agave' を含むリンク {len(links)}件（先頭12）:")
        for l in links[:12]:
            print(f"    {l}")
    # ページネーション痕跡
    pag = sorted(set(re.findall(r'[?&](page|p|start|offset|pagenumber)=(\d+)', html, re.I)))
    if pag: print(f"  ページング痕跡: {pag[:6]}")
    # 埋め込みJSON（Next.js等）: 商品配列を含むことが多く個別解析で取得可能
    nd = re.search(r'<script id=["\']__NEXT_DATA__["\'][^>]*>(.*?)</script>', html, re.S)
    if nd:
        blob = nd.group(1)
        print(f"  __NEXT_DATA__ 検出（Next.js, {len(blob):,}bytes）: 中の product 配列を解析すれば取得可。")
        for kw in ("price", "sku", "product"):
            print(f"    '{kw}' 出現: {blob.lower().count(kw)}回")
    if re.search(r'requirejs|mage/|data-mage-init|/static/version', html, re.I):
        print("  Magento痕跡あり（カテゴリHTMLの .product-item をパース、または /rest/V1 API を検討）")

def main():
    ap = argparse.ArgumentParser(description="マルチショップ テキーラ価格クローラ")
    ap.add_argument("--shop"); ap.add_argument("--all", action="store_true")
    ap.add_argument("--intl", action="store_true", help="海外店（intl:True）のみ対象")
    ap.add_argument("--probe", action="store_true", help="対象店のプラットフォーム(Shopify)判定のみ")
    ap.add_argument("--sniff", action="store_true", help="非Shopify店の下調べ（基盤判定・JSON-LD抽出・カテゴリ探索）")
    ap.add_argument("--path", default="", help="--sniff で取得する base 相対パス（例: /tequila）")
    ap.add_argument("--list", action="store_true"); ap.add_argument("--debug", action="store_true")
    ap.add_argument("--delay", type=float, default=1.5); ap.add_argument("--max-pages", type=int, default=60)
    a = ap.parse_args()
    if a.list:
        for k, c in SHOPS.items(): print(f"{k:16} {c['platform']:9} {'INTL' if c.get('intl') else '    '} {c['name']}  {c.get('base','')}")
        return
    if a.intl:
        keys = [k for k, c in SHOPS.items() if c.get("intl")]
    else:
        keys = [a.shop] if a.shop else (list(SHOPS) if a.all else [])
    if a.probe:
        session = make_session()
        for k in keys:
            cfg = SHOPS.get(k)
            if cfg: probe_shop(session, k, cfg)
        return
    if a.sniff:
        session = make_session()
        for k in keys:
            cfg = SHOPS.get(k)
            if cfg: sniff_shop(session, k, cfg, a.path)
        return
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

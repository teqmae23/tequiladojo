#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Playwright(ヘッドレスChrome)経由のクローラ。Cloudflare等の bot対策で requests が
403/429 になる店（K&L Wines など）用。実ブラウザでページを描画してからHTMLを解析する。

依存（Cloud Shell 等で一度だけ）:
    pip install playwright
    python -m playwright install chromium        # ~150MBのChromiumを取得

使い方:
    # ① 下調べ: カテゴリURLを描画して基盤/JSON-LD/カード/テキーラリンクを表示（HTMLも保存）
    python3 crawl_pw.py --shop klwines --sniff
    python3 crawl_pw.py --shop klwines --sniff --url "https://www.klwines.com/<カテゴリ>"

    # ② 本クロール: 指定パーサでページ送り取得 → <shop>_tequila_final.csv
    python3 crawl_pw.py --shop klwines --crawl --url "<カテゴリURL>" --parser jsonld --pages 30
    #   htmlcards の場合は --card-sel/--price-sel/--link-re を指定

同ディレクトリの crawl_shops.py のパーサ・仕上げ(finalize/write_final)を再利用する。
"""
import argparse, sys, time, urllib.parse
import crawl_shops as cs   # パーサ/仕上げを再利用（import時にmainは走らない）


def fetch_html(url, wait_sel=None, headful=False, settle=2.5, timeout=45000):
    """Playwrightでurlを開き、描画後のHTMLを返す。Cloudflareチャレンジ通過のため少し待つ。"""
    from playwright.sync_api import sync_playwright
    html = ""
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not headful, args=["--disable-blink-features=AutomationControlled"])
        ctx = browser.new_context(
            user_agent=cs.UA, locale="en-US",
            viewport={"width": 1366, "height": 900},
            extra_http_headers={"Accept-Language": "en-US,en;q=0.9"},
        )
        page = ctx.new_page()
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=timeout)
            try: page.wait_for_load_state("networkidle", timeout=timeout)
            except Exception: pass
            if wait_sel:
                try: page.wait_for_selector(wait_sel, timeout=15000)
                except Exception: pass
            time.sleep(settle)
            html = page.content()
        finally:
            browser.close()
    return html


def sniff(key, cfg, url, headful):
    print(f"[{key}] Playwright取得: {url}", file=sys.stderr)
    html = fetch_html(url, headful=headful)
    fn = f"{key}_pw.html"
    try: open(fn, "w", encoding="utf-8").write(html)
    except Exception: pass
    print(f"  {len(html):,}bytes / dump: {fn}")
    print(f"  platform = {cs.detect_platform(html, None)}")
    prods = cs.extract_jsonld_products(html)
    print(f"  JSON-LD Product/ItemList: {len(prods)}件")
    for pr in prods[:8]:
        print(f"    - {str(pr.get('name'))[:44]:44} | {pr.get('price')} {pr.get('currency','')} | {str(pr.get('availability'))[-16:]}")
    try: cards = cs.parse_bigcommerce(html, cfg.get("base", ""))
    except Exception: cards = []
    print(f"  BigCommerceカード: {len(cards)}件")
    for pr in cards[:6]:
        print(f"    - {str(pr.get('name'))[:44]:44} | {pr.get('price')} | {pr.get('url','')[-34:]}")
    base = cfg.get("base", "")
    links = []
    import re
    for m in re.finditer(r'href=["\']([^"\']+)["\']', html, re.I):
        h = m.group(1)
        if re.search(r'tequila|agave', h, re.I) and h not in links: links.append(h)
    if links:
        print(f"  'tequila/agave' リンク {len(links)}件（先頭12）:")
        for l in links[:12]: print(f"    {l}")
    pag = sorted(set(re.findall(r'[?&](page|p|start|offset|pagenumber)=(\d+)', html, re.I)))
    if pag: print(f"  ページング痕跡: {pag[:6]}")


def crawl(key, cfg, url, parser, pages, headful, page_param, page_tmpl):
    raw, seen = [], set()
    for pageno in range(1, pages + 1):
        if pageno == 1:
            purl = url
        elif page_tmpl:
            purl = page_tmpl.replace("{n}", str(pageno))
        else:
            sep = "&" if "?" in url else "?"
            purl = f"{url}{sep}{page_param}={pageno}"
        html = fetch_html(purl, headful=headful)
        if parser == "jsonld":
            items = []
            for p in cs.extract_jsonld_products(html):
                name = (p.get("name") or "").strip()
                if not name: continue
                try: price = float(str(p.get("price")).replace(",", "")) if p.get("price") not in (None, "") else None
                except ValueError: price = None
                av = str(p.get("availability") or "")
                avail = "在庫あり" if "instock" in av.lower() else ("品切れ" if av else "")
                pu = p.get("url") or ""
                items.append({"id": cs._slug_id(pu) or name, "name": name, "price": price,
                              "availability": avail, "url": urllib.parse.urljoin(cfg.get("base", "") + "/", pu) if pu else ""})
        elif parser == "bigcommerce":
            items = cs.parse_bigcommerce(html, cfg.get("base", ""))
        else:  # htmlcards
            items = cs.parse_html_cards(html, cfg.get("base", ""), cfg)
        new = [x for x in items if x["id"] not in seen]
        for x in new: seen.add(x["id"])
        print(f"[{key}] p{pageno}: {len(items)}件（新規{len(new)}／累計{len(raw)+len(new)}）", file=sys.stderr)
        if not new: break
        raw += new
        time.sleep(1.0)
    if raw: cs.write_final(key, raw)
    else: print(f"[{key}] 取得0件。--sniff で構造/URLを確認してください。", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser(description="Playwright経由クローラ（bot対策店用）")
    ap.add_argument("--shop", required=True)
    ap.add_argument("--url", default="")
    ap.add_argument("--sniff", action="store_true")
    ap.add_argument("--crawl", action="store_true")
    ap.add_argument("--parser", default="jsonld", choices=["jsonld", "bigcommerce", "htmlcards"])
    ap.add_argument("--pages", type=int, default=30)
    ap.add_argument("--page-param", default="page")
    ap.add_argument("--page-tmpl", default="")
    ap.add_argument("--card-sel", default=""); ap.add_argument("--price-sel", default=""); ap.add_argument("--link-re", default="")
    ap.add_argument("--headful", action="store_true")
    a = ap.parse_args()
    cfg = dict(cs.SHOPS.get(a.shop, {}))
    if not cfg: print(f"未知の店: {a.shop}（crawl_shops.py の SHOPS に無い）", file=sys.stderr); sys.exit(1)
    if a.card_sel: cfg["card_sel"] = a.card_sel
    if a.price_sel: cfg["price_sel"] = a.price_sel
    if a.link_re: cfg["link_re"] = a.link_re
    url = a.url or (cfg.get("base", "") + cfg.get("category_path", "/"))
    if a.sniff:
        sniff(a.shop, cfg, url, a.headful); return
    if a.crawl:
        crawl(a.shop, cfg, url, a.parser, a.pages, a.headful, a.page_param, a.page_tmpl or None); return
    print("--sniff または --crawl を指定", file=sys.stderr); sys.exit(1)


if __name__ == "__main__":
    main()

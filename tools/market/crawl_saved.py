#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""手動保存したHTMLから商品を抽出してCSV化する（bot対策で自動取得できない店用）。

Cloudflare Turnstile 等で requests/headless が通らない店（K&L Wines など）は、
ブラウザでカテゴリページを開いて「ページを保存(完全なHTML)」した .html を渡す。
複数ページ・複数カテゴリはまとめて指定可（商品IDの重複は自動排除）。

使い方（Cloud Shell 等・要 crawl_shops.py と同ディレクトリ）:
    python3 crawl_saved.py --shop klwines Tequila*.html
    python3 crawl_saved.py --shop klwines --glob '~/klwines_*.html'
    → <shop>_tequila_final.csv を出力（そのまま import_intl.js --shop <shop> で取込）

対応店（保存HTMLパーサ）:
    klwines … K&L Wines（Next.js/Algolia。aria-label名＋タイル内$価格）
    ※ 他のbot対策店も、保存HTMLの構造が分かれば PARSERS に追加できる
      （jsonld/htmlcards 等は crawl_shops.py の既存関数を流用可）。
"""
import argparse, glob, os, sys
import crawl_shops as cs

PARSERS = {
    # K&L の商品URLは shop.klwines.com（SHOPS.base の www ではない）
    "klwines": lambda html, base: cs.parse_klwines(html, "https://shop.klwines.com"),
}

def main():
    ap = argparse.ArgumentParser(description="手動保存HTML → 相場CSV")
    ap.add_argument("--shop", required=True)
    ap.add_argument("files", nargs="*", help="保存したHTMLファイル（複数可）")
    ap.add_argument("--glob", default="", help="ワイルドカードでまとめて指定（例: 'klwines_*.html'）")
    a = ap.parse_args()

    files = list(a.files)
    if a.glob:
        files += glob.glob(os.path.expanduser(a.glob))
    files = [f for f in dict.fromkeys(files)]  # 重複排除・順序維持
    if not files:
        print("HTMLファイルを指定してください（引数 or --glob）", file=sys.stderr); sys.exit(1)

    parser = PARSERS.get(a.shop)
    if not parser:
        print(f"{a.shop} 用の保存HTMLパーサが未定義です（PARSERS に追加が必要）", file=sys.stderr); sys.exit(1)
    base = cs.SHOPS.get(a.shop, {}).get("base", "")

    raw, seen = [], set()
    for fn in files:
        try:
            html = open(fn, encoding="utf-8", errors="replace").read()
        except Exception as e:
            print(f"  読込失敗 {fn}: {e}", file=sys.stderr); continue
        items = parser(html, base)
        new = [x for x in items if x["id"] not in seen]
        for x in new: seen.add(x["id"])
        raw += new
        print(f"  {os.path.basename(fn)}: {len(items)}件（新規{len(new)}／累計{len(raw)}）", file=sys.stderr)

    if raw:
        cs.write_final(a.shop, raw)
    else:
        print("0件（HTMLの構造が想定と違うか、対象商品なし）", file=sys.stderr)

if __name__ == "__main__":
    main()

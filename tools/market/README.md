# ネットショップ参考相場パイプライン（マルチショップ）

自店で扱う（＋今後扱う）テキーラのネット相場を複数ショップから集計し、
`admin_tequila` の「参考相場」列と「相場照合」タブに供給する。
対象サイトに到達できる環境（Cloud Shell / GitHub Actions）で実行する。**本番Firestoreへ書き込む**ため取り扱い注意。

## 対応ショップと基盤（`crawl_shops.py` の SHOPS）
| key | 店 | 基盤 | 取得方法 |
|---|---|---|---|
| musashiya | 武蔵屋 | EC-CUBE | `/products/list?category_id=72` |
| liquorsato | サトー酒店 | EC-CUBE | `/cart/products/list?category_id=42` |
| wazawaza | テキーラムーチョ | Shopify | `/collections/all/products.json` |
| kinemon | 酒商金右衛門 | Shopify | `kinemon.shop /collections/all/products.json` |
| youshuchiga | 洋酒専門 千雅 | ColorMe | `?mode=cate&cbid=1181170` |
| chagata | ちゃがたパーク | ColorMe | `?mode=cate&cbid=2444445&csid=4` |
| mukawa | ムカワ | ColorMe | cbid **要特定**（`--debug` でカテゴリURL確認） |
| biccamera | ビックカメラ | 独自/大規模 | **保留**（bot対策強・独自構造） |

> ColorMe の cbid/csid や EC-CUBE のカテゴリは変わることがある。取りこぼし時は
> `python3 crawl_shops.py --shop <key> --debug` で `<key>_dump.*` を保存し、構造を確認して SHOPS を調整する。

## 依存
```
pip install requests beautifulsoup4
# 取り込みは firebase-admin（~/functions/node_modules を利用 or npm i firebase-admin）
```

## 手動更新（1店ずつ）
```
python3 crawl_shops.py --shop wazawaza          # → wazawaza_tequila_final.csv
node export_tequila_master.js                   # → tequiladojo_master.csv（初回/更新時）
PYTHONPATH=. python3 match_shop.py --shop wazawaza   # → wazawaza_matched.csv / _unmatched.csv
cd ~/functions && node <repo>/tools/market/import_market.js --shop wazawaza
```

## 一括更新（推奨）
```
REPO=<repoのパス> NODE_PATH=~/functions/node_modules \
  bash <repo>/tools/market/refresh_all.sh        # 既定セットを巡回
# または: ... refresh_all.sh wazawaza kinemon liquorsato
```
`refresh_all.sh` は 作業ディレクトリ(WORK, 既定 ~/market-work) で
「マスタ書き出し → 各店クロール＋名寄せ → 取り込み」を実行する。

## 定期巡回（週次・GitHub Actions）
`.github/workflows/market-crawl.yml` が毎週 `refresh_all.sh` を実行する。
- 事前設定: リポジトリ Secrets に **`GCP_SA_KEY`**（Firestore書込権限のサービスアカウントJSON）。
- 手動実行: Actions → market-crawl → Run workflow（対象店を入力可）。
- 間隔変更: cron を編集。

## Firestore
- `marketPrices/{shop}__{bottleId}` … ボトル紐付け済み相場（admin_tequilaが表示。複数店は750ml換算 最安を採用）。
- `marketStaging/{shop}__{itemId}` … 未紐付け（未マッチ＋brand-only/low）。相場照合タブで紐付け/新規登録/対象外。

## 注意（礼儀・規約）
- robots.txt を確認し、`--delay`（既定1.5秒）で待機。巡回は週次程度に留める。
- 各サイトの利用規約で自動取得が制限される場合がある。相場の**社内参考**用途に限定し、負荷をかけない。
- biccamera は bot対策が強いため既定で無効。必要時のみ個別対応。

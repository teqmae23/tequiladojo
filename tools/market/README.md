# ネットショップ参考相場パイプライン（武蔵屋）

自店で扱うテキーラの「ネット相場」を集計し、管理画面(admin_tequila)に参考相場として表示する。
Cloud Shell 等、対象サイトに到達できる環境で実行する（本番Firestoreへ書き込むため取り扱い注意）。

## 手順
1. **抽出**（Python / Cloud Shell）: `store.musashiya-net.co.jp`（EC-CUBE, category_id=72）から
   `musashiya_tequila.csv` を作成。任意で `--detail` で在庫・実容量・欠損価格を補完。
2. **仕上げ**: クラス推定・750ml換算・在庫を付与した `musashiya_tequila_final.csv` を作成。
3. **マスタ書き出し**: `node export_tequila_master.js` で `~/tequiladojo_master.csv`（bottleData+brands）。
4. **名寄せ**: `musashiya_tequila_final.csv` × `tequiladojo_master.csv` を突合し
   `matched.csv`（信頼度つき）／`unmatched_musashiya.csv` を作成。
5. **取り込み**: `cd ~/functions && node <repo>/tools/market/import_market_prices.js`
   - brand+class(high/mid) → `marketPrices/{shop}__{bottleId}`（ボトル紐付け済みの相場。admin_tequila が表示）
   - それ以外(brand-only/low)＋未マッチ → `marketStaging/{shop}__{musashiyaId}`（照合UI用の保留）

## Firestore
- `marketPrices`  : スタッフ読み書き（会員非公開）。admin_tequila の「参考相場」列で表示。
- `marketStaging` : スタッフ読み書き。既存マスタへの紐付け／新規ボトル登録の照合UI（Phase 2）で使用。

## 更新
相場を更新するときは 1→5 を再実行。`import_market_prices.js` は doc を merge 上書きするので重複しない。

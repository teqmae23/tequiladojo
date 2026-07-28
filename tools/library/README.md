# 書庫ドキュメントの一括取り込み

原文（スペイン語）を解析して生成した目次・章を、`libraryDocs` / `chapters` に取り込むツール。
`admin_library` の編集画面で翻訳（EN/JA）・解説を追記して公開する運用を想定。

## 生成済みデータ
- `nom006.json` … NOM-006-SCFI-2012（テキーラ規格）**全文**の解析結果（第17章＋TRANSITORIOSまで、計117節）。
  - **3種類の要素**で構成：
    - **分類なし文書**（目次の前）… `p0_intro`（冒頭文）/ `p1_considerando`（CONSIDERANDO）/ `p2_prefacio`（PREFACIO）。`isFront:true`、タイトル(墨英日)＋本文(墨英日)＋解説(日)。
    - **目次**（大分類）… `doc.toc`：大番号＋タイトル(墨英日)。閲覧側で各章の節(中小)を読んで**ツリー表示**し、章内アンカーへリンク。
    - **分類あり文書**（章）… `c0`〜`c17`＋`transitorios`。1章=1ページ。章内は「節」＝`{t:'sec', mid:中番号, sub:小番号, titleEs/titleEn/titleJa:見出し(墨英日), es/en/ja:本文(墨英日), note:解説(日)}`。
  - **ES原文のみ格納**（`en`/`ja`/`titleEn`/`titleJa`/`note` は空。編集画面で翻訳・解説を追記）。

## 既存 nom006 を更新する場合
以前の簡易版を取り込み済みなら、章キーの一部（`c0`〜`c17`）が重複します。**新しい多言語見出し等を反映するには `--force`** を付けてください（既存 rows も上書き）。
旧 `front` 章（前回版）は残るので、`admin_library` で不要なら削除してください（新版は `p0_intro`/`p1_considerando`/`p2_prefacio`）。

## 取り込み（Cloud Shell 等・ADC 認証）
```bash
cd ~/functions   # firebase-admin がある場所
node <repoのパス>/tools/library/import_doc.js <repoのパス>/tools/library/nom006.json
```
- 既定は **安全モード**：既存の文書・本文ありの章は上書きしません（翻訳・編集を保護）。空章には構造だけ補います。
- 構造を作り直したいときのみ `--force` を付けて全上書き（`published` は保持）。

## 取り込み後
1. `admin_library` で `nom006` を選び、各章の EN/日本語/解説を追記。
2. 表は画像として節に差し込み（編集画面の「表（画像）」）。
3. 内容を確認して「公開」にすると会員の書庫に表示。

## データ形式（他文書の取り込みにも流用可）
```json
{
  "doc": { "docId": "xxx", "title": "…", "subtitle": "…", "order": 1, "published": false,
           "toc": [ { "num": "1", "titleEs": "…", "titleJa": "" } ] },
  "chapters": [
    { "key": "front", "data": { "isFront": true, "order": 0, "titleJa": "主文",
        "rows": [ { "t": "sec", "mid": "", "sub": "", "title": "", "es": "…", "en": "", "ja": "", "note": "" } ] } },
    { "key": "c1", "data": { "num": "1", "titleEs": "…", "isFront": false, "order": 10, "rows": [ … ] } }
  ]
}
```
`key` は `admin_library` の章キー（`front` / `c<番号>`）に合わせる。

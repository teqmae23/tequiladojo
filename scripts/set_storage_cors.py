#!/usr/bin/env python3
"""Cloud Storage バケットに CORS 設定を投入する（GCS JSON API 経由）。

ブラウザからの直接アクセス（トップレベル遷移）は CORS 対象外なので開けるが、
ページ内 JS の fetch/XHR（pdf.js など）はバケットに CORS 設定が無いと
"Failed to fetch" でブロックされる。セミナー配信/資料ビューアの PDF 表示が
これで失敗するため、GET/HEAD を許可する CORS をバケットに設定する。

`gsutil cors set` は CI に gsutil が無いため使えないが、GCS JSON API の
`PATCH /storage/v1/b/<bucket>` は google-github-actions/auth のアクセストークンで
呼べる（サービスアカウントに storage.buckets.update 権限が必要）。

必要な環境変数:
  GOOGLE_OAUTH_ACCESS_TOKEN  google-github-actions/auth のアクセストークン
  STORAGE_BUCKET             バケット名（省略時 tequiladojo.firebasestorage.app）
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

TOKEN = os.environ.get("GOOGLE_OAUTH_ACCESS_TOKEN", "")
BUCKET = os.environ.get("STORAGE_BUCKET", "tequiladojo.firebasestorage.app")

CORS = [
    {
        "origin": ["*"],
        "method": ["GET", "HEAD"],
        "responseHeader": [
            "Content-Type",
            "Content-Length",
            "Content-Range",
            "Range",
            "Accept-Ranges",
            "ETag",
            "Last-Modified",
        ],
        "maxAgeSeconds": 3600,
    }
]


def main():
    if not TOKEN:
        sys.stderr.write("GOOGLE_OAUTH_ACCESS_TOKEN が未設定です\n")
        return 1
    url = (
        "https://storage.googleapis.com/storage/v1/b/"
        + urllib.parse.quote(BUCKET, safe="")
        + "?fields=cors"
    )
    body = json.dumps({"cors": CORS}).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="PATCH")
    req.add_header("Authorization", "Bearer " + TOKEN)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as resp:
            print("CORS設定を反映しました (" + BUCKET + "): " + resp.read().decode("utf-8"))
        return 0
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        sys.stderr.write("HTTP {} {}\n{}\n".format(e.code, url, detail))
        return 2


if __name__ == "__main__":
    sys.exit(main())

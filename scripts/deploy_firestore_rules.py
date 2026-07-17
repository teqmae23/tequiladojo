#!/usr/bin/env python3
"""Firestore セキュリティルールを Firebase Rules REST API 経由でデプロイする。

`firebase deploy --only firestore:rules` は実行前に serviceusage.googleapis.com へ
「firestore.googleapis.com が有効か」を問い合わせる（ensureApiEnabled）。CI のサービス
アカウントは serviceusage.services.get 権限を持たないため、この事前チェックで 403 と
なり、ルール本体のデプロイまで到達せず失敗していた（会員パーミッションエラーの真因）。

Rules REST API（firebaserules.googleapis.com）には serviceusage の事前チェックが無い
ため、アクセストークンさえあればルールを確実に反映できる。

必要な環境変数:
  GOOGLE_OAUTH_ACCESS_TOKEN  google-github-actions/auth が発行するアクセストークン
  FIREBASE_PROJECT           プロジェクトID（省略時 tequiladojo）
"""
import json
import os
import sys
import urllib.error
import urllib.request

PROJECT = os.environ.get("FIREBASE_PROJECT", "tequiladojo")
TOKEN = os.environ.get("GOOGLE_OAUTH_ACCESS_TOKEN", "")
RULES_FILE = os.environ.get("RULES_FILE", "firestore.rules")
RELEASE = os.environ.get("RULES_RELEASE", "cloud.firestore")
BASE = "https://firebaserules.googleapis.com/v1"


def api(method, path, body=None):
    url = BASE + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + TOKEN)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        sys.stderr.write("HTTP {} {} {}\n{}\n".format(e.code, method, url, detail))
        raise


def main():
    if not TOKEN:
        sys.stderr.write("GOOGLE_OAUTH_ACCESS_TOKEN が未設定です\n")
        return 1

    with open(RULES_FILE, "r", encoding="utf-8") as f:
        source = f.read()

    # 1) ルールセットを作成
    ruleset = api(
        "POST",
        "/projects/{}/rulesets".format(PROJECT),
        {"source": {"files": [{"name": RULES_FILE, "content": source}]}},
    )
    ruleset_name = ruleset["name"]  # projects/<id>/rulesets/<uuid>
    print("作成したルールセット: " + ruleset_name)

    # 2) リリースを更新して新しいルールセットを本番へ反映
    release_path = "/projects/{}/releases/{}".format(PROJECT, RELEASE)
    body = {
        "release": {
            "name": "projects/{}/releases/{}".format(PROJECT, RELEASE),
            "rulesetName": ruleset_name,
        }
    }
    try:
        api("PATCH", release_path, body)
        print("リリースを更新しました: " + RELEASE)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            # リリースが存在しない場合は新規作成
            api("POST", "/projects/{}/releases".format(PROJECT), body["release"])
            print("リリースを新規作成しました: " + RELEASE)
        else:
            raise
    return 0


if __name__ == "__main__":
    sys.exit(main())

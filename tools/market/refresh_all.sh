#!/usr/bin/env bash
# マルチショップ相場を一括更新: マスタ書き出し → 各店クロール＋名寄せ → Firestore取り込み。
# 前提: python3(requests,beautifulsoup4) / node(firebase-admin) / GCPのADCまたはサービスアカウント。
# 使い方:
#   REPO=~/tequiladojo NODE_PATH=~/functions/node_modules tools/market/refresh_all.sh wazawaza kinemon liquorsato
#   （店キー省略時は BIC以外の既定セットを巡回）
set -euo pipefail
REPO="${REPO:-$(cd "$(dirname "$0")/../.." && pwd)}"
WORK="${WORK:-$HOME/market-work}"
SHOPS=("$@")
if [ ${#SHOPS[@]} -eq 0 ]; then SHOPS=(musashiya wazawaza kinemon liquorsato youshuchiga chagata); fi
: "${NODE_PATH:=$HOME/functions/node_modules}"; export NODE_PATH

mkdir -p "$WORK"; cd "$WORK"
echo "== working dir: $WORK / NODE_PATH=$NODE_PATH =="

echo "== 1) マスタ書き出し =="
node "$REPO/tools/market/export_tequila_master.js"

for s in "${SHOPS[@]}"; do
  echo "== 2) $s: クロール =="
  python3 "$REPO/tools/market/crawl_shops.py" --shop "$s" || { echo "  [$s] crawl 失敗・スキップ"; continue; }
  [ -f "${s}_tequila_final.csv" ] || { echo "  [$s] 出力なし・スキップ"; continue; }
  echo "== 3) $s: 名寄せ =="
  PYTHONPATH="$REPO/tools/market" python3 "$REPO/tools/market/match_shop.py" --shop "$s" --master tequiladojo_master.csv
  echo "== 4) $s: 取り込み =="
  node "$REPO/tools/market/import_market.js" --shop "$s"
done
echo "== 完了 =="

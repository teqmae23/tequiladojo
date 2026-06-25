"""
CRT (Consejo Regulador del Tequila) 輸出統計取得スクリプト
Power BI 公開レポートAPIを直接呼ぶ

使い方:
  # カラム一覧・実値確認（初回必須）
  python3 crt_fetch.py --discover

  # 日本 2026年5月 データ取得
  python3 crt_fetch.py --country "Japón" --year 2026 --month 5

  # CSV出力
  python3 crt_fetch.py --country "Japón" --year 2026 --month 5 --output csv
"""

import requests, json, argparse, csv
from datetime import datetime

ENDPOINT     = "https://wabi-paas-1-scus-api.analysis.windows.net/public/reports/querydata"
RESOURCE_KEY = "56739c8d-5830-48ac-8185-932395973bb6"
DATASET_ID   = "939ce5cb-cbfd-4d83-979d-c0f07089f729"
REPORT_ID    = "c131a218-ef98-4513-a36b-afd7acb34575"
MODEL_ID     = 5590467
ENTITY       = "vEstPagWebExportacionesDestino"

# フォームラベルから推定した実カラム名
COL_COUNTRY = "Paises"  # seleccione Paises
COL_YEAR    = "Ano"     # seleccione Ano
COL_MONTH   = "Mes"     # seleccione Mes
COL_GRUPO   = "Grupo"   # seleccione Categoria（Power BIモデル上はGrupo）
COL_CLASE   = "Clase"   # Blanco/Joven/Reposado/Anejo/Extra Anejo

# 輸出量カラム候補（--discoverで正しいものを確認）
VOLUME_CANDIDATES = [
    "Litros", "LitrosTotal", "LitrosExportados", "LitrosEnvasados",
    "LitrosGranel", "Volumen", "VolumenTotal", "Cajas", "CajasTotal",
]

HEADERS = {
    "Content-Type": "application/json;charset=UTF-8",
    "X-PowerBI-ResourceKey": RESOURCE_KEY,
    "Origin": "https://app.powerbi.com",
    "Referer": "https://app.powerbi.com/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
}

def build_select(columns):
    return [
        {
            "Column": {
                "Expression": {"SourceRef": {"Source": "v"}},
                "Property": col
            },
            "Name": f"v.{col}",
            "NativeReferenceName": col
        }
        for col in columns
    ]

def filter_str(col, val):
    return {"Condition": {"In": {
        "Expressions": [{"Column": {"Expression": {"SourceRef": {"Source": "v"}}, "Property": col}}],
        "Values": [[{"Literal": {"Value": f"'{val}'"}}]]
    }}}

def filter_int(col, val):
    return {"Condition": {"In": {
        "Expressions": [{"Column": {"Expression": {"SourceRef": {"Source": "v"}}, "Property": col}}],
        "Values": [[{"Literal": {"Value": f"{val}L"}}]]
    }}}

def filter_in_str(col, vals):
    """複数値 IN フィルタ"""
    return {"Condition": {"In": {
        "Expressions": [{"Column": {"Expression": {"SourceRef": {"Source": "v"}}, "Property": col}}],
        "Values": [[{"Literal": {"Value": f"'{v}'"}}] for v in vals]
    }}}

def build_payload(columns, where=None):
    query = {
        "Version": 2,
        "From": [{"Name": "v", "Entity": ENTITY, "Type": 0}],
        "Select": build_select(columns),
    }
    if where:
        query["Where"] = where
    return {
        "version": "1.0.0",
        "queries": [{
            "Query": {"Commands": [{"SemanticQueryDataShapeCommand": {
                "Query": query,
                "Binding": {
                    "Primary": {"Groupings": [{"Projections": list(range(len(columns)))}]},
                    "DataReduction": {"DataVolume": 4, "Primary": {"Window": {"Count": 5000}}},
                    "Version": 1
                },
                "ExecutionMetricsKind": 1
            }}]},
            "QueryId": "",
            "ApplicationContext": {
                "DatasetId": DATASET_ID,
                "Sources": [{"ReportId": REPORT_ID}]
            }
        }],
        "cancelQueries": [],
        "modelId": MODEL_ID
    }

def query_api(payload):
    resp = requests.post(ENDPOINT + "?synchronous=true", headers=HEADERS, json=payload, timeout=30)
    resp.raise_for_status()
    return resp.json()

def parse_results(data):
    """Power BI DSR形式レスポンスをレコードリストに変換"""
    try:
        ds = data["results"][0]["result"]["data"]["dsr"]["DS"][0]
        col_names = [c["N"] for c in ds["S"]]
        rows = []
        prev = {}
        for vd in ds.get("PH", [{}])[0].get("DM0", []):
            if "R" in vd:
                repeat_bits = vd["R"]
                row = {}
                for i, col in enumerate(col_names):
                    if repeat_bits & (1 << i):
                        row[col] = prev.get(col)
                    else:
                        row[col] = vd.get(f"C{i}")
            else:
                row = {col: vd.get(f"C{i}") for i, col in enumerate(col_names)}
            prev = {**prev, **{k: v for k, v in row.items() if v is not None}}
            rows.append(row)
        return col_names, rows
    except (KeyError, IndexError) as e:
        print("パースエラー:", e)
        print(json.dumps(data, ensure_ascii=False, indent=2)[:3000])
        return [], []

def discover():
    """実際のカラム名と取りうる値を確認"""
    print(f"=== エンティティ '{ENTITY}' カラム探索 ===\n")
    candidates = [COL_COUNTRY, COL_YEAR, COL_MONTH, COL_GRUPO, COL_CLASE] + VOLUME_CANDIDATES
    for col in candidates:
        try:
            _, rows = parse_results(query_api(build_payload([col])))
            if rows:
                vals = list(dict.fromkeys(r.get(col) for r in rows if r.get(col) is not None))[:8]
                print(f"  ✓ {col:32s} 例: {vals}")
            else:
                print(f"  △ {col:32s} データなし")
        except Exception as e:
            print(f"  ✗ {col:32s} {e}")

def fetch_data(country, year, month, output):
    # ★ --discover の結果を見てここを修正する
    VOLUME_COL = "Litros"

    columns = [COL_COUNTRY, COL_YEAR, COL_MONTH, COL_GRUPO, COL_CLASE, VOLUME_COL]

    where = []
    if country:
        where.append(filter_str(COL_COUNTRY, country))
    if year:
        where.append(filter_int(COL_YEAR, year))
    if month:
        where.append(filter_int(COL_MONTH, month))
    # 両カテゴリ（Grupo）は絞らず全取得 → CSVで後から集計可能
    # 絞る場合は下記のコメントを外してGrupoの正確な文字列を入れる
    # where.append(filter_in_str(COL_GRUPO, ["100% AGAVE", "Tequila"]))

    print(f"クエリ: country={country!r} year={year} month={month}")
    _, rows = parse_results(query_api(build_payload(columns, where or None)))

    if not rows:
        print("データなし。--discover でカラム名・値を確認してください")
        return

    print(f"\n取得件数: {len(rows)} 件\n")
    header = f"{'国':<10} {'年':>4} {'月':>2}  {'カテゴリ':<20} {'クラス':<12} {'輸出量':>12}"
    print(header)
    print("-" * len(header))
    for row in rows[:50]:
        print(f"{str(row.get(COL_COUNTRY,'')):<10} {str(row.get(COL_YEAR,'')): >4} {str(row.get(COL_MONTH,'')): >2}  "
              f"{str(row.get(COL_GRUPO,'')):<20} {str(row.get(COL_CLASE,'')):<12} {str(row.get(VOLUME_COL,'')):>12}")
    if len(rows) > 50:
        print(f"... 他 {len(rows)-50} 件")

    if output == "csv":
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        fname = f"crt_{(country or 'all').replace(' ','_')}_{year or 'all'}_{month or 'all'}_{ts}.csv"
        with open(fname, "w", newline="", encoding="utf-8-sig") as f:
            writer = csv.DictWriter(f, fieldnames=[COL_COUNTRY, COL_YEAR, COL_MONTH, COL_GRUPO, COL_CLASE, VOLUME_COL])
            writer.writeheader()
            writer.writerows(rows)
        print(f"\nCSV保存: {fname}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--discover", action="store_true", help="カラム名と値の一覧を表示")
    parser.add_argument("--country", default="Japón",  help="国名（例: Japón）")
    parser.add_argument("--year",    type=int,          help="年（例: 2026）")
    parser.add_argument("--month",   type=int,          help="月（例: 5）")
    parser.add_argument("--output",  default="stdout",  choices=["stdout", "csv"])
    args = parser.parse_args()

    if args.discover:
        discover()
    else:
        fetch_data(args.country, args.year, args.month, args.output)

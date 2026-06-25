"""
CRT (Consejo Regulador del Tequila) 輸出統計取得スクリプト
Power BI 公開レポートAPIを直接呼ぶ

使い方:
  # カラム一覧確認
  python3 crt_fetch.py --discover

  # 日本 2026年5月 データ取得
  python3 crt_fetch.py --country "Japón" --year 2026 --month 5

  # 全カ国 2026年5月
  python3 crt_fetch.py --year 2026 --month 5
"""

import requests, json, sys, argparse, csv, io
from datetime import datetime

ENDPOINT = "https://wabi-paas-1-scus-api.analysis.windows.net/public/reports/querydata"
RESOURCE_KEY = "56739c8d-5830-48ac-8185-932395973bb6"
DATASET_ID   = "939ce5cb-cbfd-4d83-979d-c0f07089f729"
REPORT_ID    = "c131a218-ef98-4513-a36b-afd7acb34575"
MODEL_ID     = 5590467
ENTITY       = "vEstPagWebExportacionesDestino"

HEADERS = {
    "Content-Type": "application/json;charset=UTF-8",
    "X-PowerBI-ResourceKey": RESOURCE_KEY,
    "Origin": "https://app.powerbi.com",
    "Referer": "https://app.powerbi.com/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
}

def build_query(columns, filters=None):
    """Power BI DAX クエリを構築"""
    from_clause = [{"Name": "v", "Entity": ENTITY, "Type": 0}]
    
    select_clause = [
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
    
    query = {
        "Version": 2,
        "From": from_clause,
        "Select": select_clause,
    }
    
    if filters:
        where_clauses = []
        for col, val in filters.items():
            if isinstance(val, str):
                cond = {
                    "Condition": {
                        "In": {
                            "Expressions": [{"Column": {"Expression": {"SourceRef": {"Source": "v"}}, "Property": col}}],
                            "Values": [[{"Literal": {"Value": f"'{val}'"}}]]
                        }
                    }
                }
            else:
                cond = {
                    "Condition": {
                        "In": {
                            "Expressions": [{"Column": {"Expression": {"SourceRef": {"Source": "v"}}, "Property": col}}],
                            "Values": [[{"Literal": {"Value": str(val) + "L"}}]]
                        }
                    }
                }
            where_clauses.append(cond)
        query["Where"] = where_clauses
    
    payload = {
        "version": "1.0.0",
        "queries": [{
            "Query": {
                "Commands": [{
                    "SemanticQueryDataShapeCommand": {
                        "Query": query,
                        "Binding": {
                            "Primary": {"Groupings": [{"Projections": list(range(len(columns)))}]},
                            "DataReduction": {"DataVolume": 4, "Primary": {"Window": {"Count": 5000}}},
                            "Version": 1
                        },
                        "ExecutionMetricsKind": 1
                    }
                }]
            },
            "QueryId": "",
            "ApplicationContext": {
                "DatasetId": DATASET_ID,
                "Sources": [{"ReportId": REPORT_ID}]
            }
        }],
        "cancelQueries": [],
        "modelId": MODEL_ID
    }
    return payload

def query_api(payload):
    resp = requests.post(
        ENDPOINT + "?synchronous=true",
        headers=HEADERS,
        json=payload,
        timeout=30
    )
    resp.raise_for_status()
    return resp.json()

def parse_results(data):
    """Power BI レスポンスをレコードリストに変換"""
    try:
        ds = data["results"][0]["result"]["data"]["dsr"]["DS"][0]
        col_names = [c["N"] for c in ds["S"]]  # カラム名
        rows = []
        
        value_dicts = ds.get("PH", [{}])[0].get("DM0", [])
        prev = {}
        for vd in value_dicts:
            if "R" in vd:
                # 繰り返し (前の行を継承するビット)
                repeat_bits = vd["R"]
                row = {}
                for i, col in enumerate(col_names):
                    if repeat_bits & (1 << i):
                        row[col] = prev.get(col)
                    else:
                        key = f"C{i}"
                        row[col] = vd.get(key)
            else:
                row = {col: vd.get(f"C{i}") for i, col in enumerate(col_names)}
            prev = {**prev, **{k: v for k, v in row.items() if v is not None}}
            rows.append(row)
        
        return col_names, rows
    except (KeyError, IndexError) as e:
        print("パースエラー:", e)
        print(json.dumps(data, ensure_ascii=False, indent=2)[:2000])
        return [], []

def discover_columns():
    """利用可能なカラムを探索"""
    # まず既知カラムだけ取得してレスポンス構造を確認
    guessed = ["Grupo", "Destino", "Anio", "Mes", "Clase",
               "LitrosEnvasados", "LitrosGranel", "Litros",
               "CajasEnvasadas", "Cajas", "ValorDolares"]
    
    print(f"エンティティ '{ENTITY}' のカラム探索中...")
    for col in guessed:
        try:
            payload = build_query([col])
            data = query_api(payload)
            cols, rows = parse_results(data)
            if rows:
                print(f"  ✓ {col}: 例={rows[0].get(col)}")
            else:
                print(f"  ✓ {col}: (データなし)")
        except Exception as e:
            print(f"  ✗ {col}: {e}")

def fetch_data(country=None, year=None, month=None, output="stdout"):
    columns = ["Destino", "Grupo", "Clase", "Anio", "Mes",
               "LitrosEnvasados", "LitrosGranel", "CajasEnvasadas"]
    
    filters = {}
    if country:
        filters["Destino"] = country
    if year:
        filters["Anio"] = int(year)
    if month:
        filters["Mes"] = int(month)
    
    print(f"クエリ: country={country} year={year} month={month}")
    payload = build_query(columns, filters if filters else None)
    
    data = query_api(payload)
    col_names, rows = parse_results(data)
    
    if not rows:
        print("データが取得できませんでした")
        print("レスポンス:", json.dumps(data, ensure_ascii=False, indent=2)[:3000])
        return
    
    print(f"\n取得件数: {len(rows)} 件")
    print(f"カラム: {col_names}")
    print()
    
    if output == "csv":
        fname = f"crt_export_{country or 'all'}_{year or 'all'}_{month or 'all'}.csv"
        with open(fname, "w", newline="", encoding="utf-8-sig") as f:
            writer = csv.DictWriter(f, fieldnames=col_names)
            writer.writeheader()
            writer.writerows(rows)
        print(f"CSVを保存: {fname}")
    else:
        for row in rows[:20]:
            print(row)
        if len(rows) > 20:
            print(f"... 他 {len(rows)-20} 件")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--discover", action="store_true", help="カラム一覧を調査")
    parser.add_argument("--country", help="国名（例: Japón）")
    parser.add_argument("--year",    type=int, help="年（例: 2026）")
    parser.add_argument("--month",   type=int, help="月（例: 5）")
    parser.add_argument("--output",  default="stdout", choices=["stdout","csv"])
    args = parser.parse_args()
    
    if args.discover:
        discover_columns()
    else:
        fetch_data(args.country, args.year, args.month, args.output)

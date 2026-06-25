"""
CRT (Consejo Regulador del Tequila) 輸出統計取得スクリプト
Power BI 公開レポートAPIを直接呼ぶ

使い方:
  # カラム一覧確認（実際に存在するカラム名を調べる）
  python3 crt_fetch.py --discover

  # 日本 2026年5月 データ取得（カラム名確認後に使用）
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

def get_api_error(data):
    """APIエラーメッセージを抽出"""
    try:
        return data["results"][0]["result"]["data"]["dsr"]["DS"][0].get("error", {})
    except Exception:
        pass
    try:
        return data["results"][0].get("error", {})
    except Exception:
        return {}

def discover_columns():
    """エンティティに実在するカラム名を総当たりで探索"""
    # CRT UIのフォーム項目と一般的なPower BIスペイン語カラム名候補
    candidates = [
        # 国・地域
        "Grupo", "Destino", "Pais", "Paises", "País", "Países",
        "DestinoExportacion", "PaisDestino", "NombrePais",
        # 年
        "Anio", "Año", "Ano", "Year", "Anyo",
        "AñoExportacion", "AnioExportacion",
        # 月
        "Mes", "Month", "NumMes", "NombreMes",
        # カテゴリ・クラス
        "Clase", "Categoria", "Categoría", "TipoProducto", "Tipo",
        "ClaseProducto", "NombreClase",
        # 数量
        "Litros", "LitrosTotal", "TotalLitros", "LitrosExportados",
        "LitrosEnvasados", "LitrosGranel",
        "Cajas", "CajasTotal", "TotalCajas", "CajasEnvasadas",
        # 金額
        "ValorDolares", "Valor", "ValorUSD", "Dolares",
        "ValorExportacion", "MontoUSD",
        # その他
        "Certificado", "NOM", "Empresa", "Marca",
        "FechaExportacion", "Periodo",
    ]

    print(f"エンティティ '{ENTITY}' のカラム探索中 ({len(candidates)} 候補)...")
    print("=" * 60)
    found = []
    failed = []

    for col in candidates:
        try:
            payload = build_query([col])
            data = query_api(payload)
            cols, rows = parse_results(data)
            if cols:
                example = rows[0].get(col) if rows else "(データなし)"
                print(f"  ✓ {col}: 例={example}")
                found.append(col)
            else:
                # エラー内容を確認
                err = get_api_error(data)
                raw = json.dumps(data, ensure_ascii=False)
                if "invalid Column" in raw or "Cannot find" in raw or "QueryDefinition" in raw:
                    print(f"  ✗ {col}: カラム不存在")
                else:
                    print(f"  ? {col}: 不明 err={err}")
                failed.append(col)
        except Exception as e:
            print(f"  ✗ {col}: 例外={e}")
            failed.append(col)

    print("=" * 60)
    print(f"\n✓ 存在するカラム ({len(found)}件): {found}")
    print(f"✗ 存在しないカラム ({len(failed)}件): {failed}")

def fetch_data(country=None, year=None, month=None, output="stdout",
               col_country="Grupo", col_year="Anio", col_month="Mes",
               col_class="Clase", col_liters_bottle="LitrosEnvasados",
               col_liters_bulk="LitrosGranel", col_cases="CajasEnvasadas"):
    """
    データ取得。--discover で確認したカラム名を --col-* オプションで指定できる。
    デフォルト値は discover 結果が出るまでのプレースホルダ（要更新）。
    """
    columns = [col_country, col_year, col_month, col_class,
               col_liters_bottle, col_liters_bulk, col_cases]
    # 重複除去（Noneなど）
    columns = list(dict.fromkeys(c for c in columns if c))

    filters = {}
    if country and col_country:
        filters[col_country] = country
    if year and col_year:
        filters[col_year] = int(year)
    if month and col_month:
        filters[col_month] = int(month)

    print(f"クエリ: country={country} year={year} month={month}")
    print(f"カラム: {columns}")
    payload = build_query(columns, filters if filters else None)

    data = query_api(payload)

    # エラーチェック
    raw = json.dumps(data, ensure_ascii=False)
    if "invalid Column" in raw or "Cannot find field" in raw:
        print("ERROR: カラム名が正しくありません。--discover を実行して正しいカラム名を確認してください。")
        print("レスポンス:", raw[:2000])
        sys.exit(1)

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
    parser.add_argument("--discover", action="store_true", help="カラム一覧を調査（最初に必ず実行）")
    parser.add_argument("--country", help="国名フィルタ（例: Japón）")
    parser.add_argument("--year",    type=int, help="年フィルタ（例: 2026）")
    parser.add_argument("--month",   type=int, help="月フィルタ（例: 5）")
    parser.add_argument("--output",  default="stdout", choices=["stdout","csv"])
    # discover 結果を受けて正しいカラム名を指定するオプション
    parser.add_argument("--col-country",       default="Grupo",          help="国カラム名")
    parser.add_argument("--col-year",          default="Anio",           help="年カラム名")
    parser.add_argument("--col-month",         default="Mes",            help="月カラム名")
    parser.add_argument("--col-class",         default="Clase",          help="クラスカラム名")
    parser.add_argument("--col-liters-bottle", default="LitrosEnvasados",help="瓶詰リットルカラム名")
    parser.add_argument("--col-liters-bulk",   default="LitrosGranel",   help="バルクリットルカラム名")
    parser.add_argument("--col-cases",         default="CajasEnvasadas", help="ケース数カラム名")
    args = parser.parse_args()

    if args.discover:
        discover_columns()
    else:
        fetch_data(
            country=args.country,
            year=args.year,
            month=args.month,
            output=args.output,
            col_country=args.col_country,
            col_year=args.col_year,
            col_month=args.col_month,
            col_class=args.col_class,
            col_liters_bottle=args.col_liters_bottle,
            col_liters_bulk=args.col_liters_bulk,
            col_cases=args.col_cases,
        )

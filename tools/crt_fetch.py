"""
CRT (Consejo Regulador del Tequila) 輸出統計取得スクリプト
Power BI 公開レポートAPIを直接呼ぶ

確認済みカラム（discover実行結果）:
  Grupo    = 地域（Norte/Sur 等、常に全選択）
  Pais     = 国名（UIラベル: Paises、例: Japón）
  Clase    = クラス（Blanco/Reposado 等）
  Categoria = カテゴリ
  Año      = 年（スライサー確認済み）
  Mes      = 月（スライサー確認済み）

メジャー（集計値）:
  Litros_40 = 輸出量（40%アルコール換算リットル）

使い方:
  # カラム一覧確認
  python3 crt_fetch.py --discover

  # 全データ取得（年・月・輸出量含む）
  python3 crt_fetch.py

  # 日本のデータ取得
  python3 crt_fetch.py --country "JAPON"

  # 生レスポンスをダンプ（デバッグ用）
  python3 crt_fetch.py --dump
"""

import requests, json, sys, argparse, csv
from datetime import datetime

ENDPOINT = "https://wabi-paas-1-scus-api.analysis.windows.net/public/reports/querydata"
RESOURCE_KEY = "56739c8d-5830-48ac-8185-932395973bb6"
DATASET_ID   = "939ce5cb-cbfd-4d83-979d-c0f07089f729"
REPORT_ID    = "c131a218-ef98-4513-a36b-afd7acb34575"
MODEL_ID     = 5590467
ENTITY       = "vEstPagWebExportacionesDestino"

# discover で存在確認済みのカラム
# Grupo=地域（常に全選択）、Pais=国名（UIは"Paises"）
CONFIRMED_COLUMNS = ["Pais", "Clase", "Categoria", "Grupo"]
COUNTRY_COLUMN    = "Pais"

# UIスライサーで確認された年月カラム候補（discover結果で更新）
YEAR_COLUMN  = "Año"
MONTH_COLUMN = "Mes"

# UIで確認されたメジャー名（集計値はColumn型ではなくMeasure型で取得）
MEASURE_LITROS = "Litros_40"

HEADERS = {
    "Content-Type": "application/json;charset=UTF-8",
    "X-PowerBI-ResourceKey": RESOURCE_KEY,
    "Origin": "https://app.powerbi.com",
    "Referer": "https://app.powerbi.com/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
}

def build_query(columns, filters=None, measures=None):
    """Power BI DAX クエリを構築

    columns : list[str]  — カラム名（ディメンション）
    measures: list[str]  — メジャー名（集計値、例: Litros_40）
    filters : dict       — {カラム名: 値} のフィルタ
    """
    from_clause = [{"Name": "v", "Entity": ENTITY, "Type": 0}]
    measures = measures or []

    select_clause = []
    for col in columns:
        select_clause.append({
            "Column": {
                "Expression": {"SourceRef": {"Source": "v"}},
                "Property": col
            },
            "Name": f"v.{col}",
            "NativeReferenceName": col
        })
    for m in measures:
        select_clause.append({
            "Measure": {
                "Expression": {"SourceRef": {"Source": "v"}},
                "Property": m
            },
            "Name": f"v.{m}",
            "NativeReferenceName": m
        })

    n_total = len(columns) + len(measures)
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
                            "Primary": {"Groupings": [{"Projections": list(range(n_total))}]},
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

def has_column_error(data):
    """カラム不存在エラーかどうかチェック"""
    raw = json.dumps(data, ensure_ascii=False)
    return ("CouldNotResolveSemanticQueryDefinition" in raw or
            "invalid Column" in raw or
            "Cannot find field" in raw)

def parse_results(data):
    """Power BI DSR レスポンスをレコードリストに変換"""
    try:
        result_data = data["results"][0]["result"]["data"]

        # 列名は descriptor.Select から取得
        col_names = []
        for sel in result_data.get("descriptor", {}).get("Select", []):
            gk = sel.get("GroupKeys", [])
            col_names.append(gk[0]["Source"]["Property"] if gk else sel.get("Name", f"col{len(col_names)}"))

        if "dsr" not in result_data:
            return col_names, []

        ds = result_data["dsr"]["DS"][0]

        # S キーがある場合は列名を上書き
        if "S" in ds:
            col_names = [c["N"] for c in ds["S"]]

        n_cols = len(col_names)
        value_dicts = ds.get("ValueDicts", {})
        rows = []
        dm0 = ds.get("PH", [{}])[0].get("DM0", [])
        prev = [None] * n_cols

        for vd in dm0:
            c_arr = vd.get("C", [])
            r_bits = vd.get("R", 0)

            row_vals = list(prev)
            c_idx = 0
            for i in range(n_cols):
                if r_bits & (1 << i):
                    pass  # 前行から繰り越し
                else:
                    val = c_arr[c_idx] if c_idx < len(c_arr) else None
                    # 整数はValueDictのインデックス
                    if isinstance(val, int):
                        d = value_dicts.get(f"D{i}", [])
                        val = d[val] if val < len(d) else val
                    row_vals[i] = val
                    c_idx += 1

            prev = row_vals
            rows.append(dict(zip(col_names, row_vals)))

        return col_names, rows
    except (KeyError, IndexError):
        return [], []

def discover_columns():
    """エンティティに実在するカラム名を総当たりで探索"""
    candidates = [
        "Grupo", "Destino", "Pais", "Paises", "País", "Países",
        "DestinoExportacion", "PaisDestino", "NombrePais",
        "Anio", "Año", "Ano", "Year", "Anyo",
        "Mes", "Month", "NumMes", "NombreMes", "NumeroMes",
        "Clase", "Categoria", "Categoría", "TipoProducto", "Tipo",
        "Litros", "LitrosTotal", "LitrosEnvasados", "LitrosGranel",
        "Litros_40", "Litros40", "LitrosA40",
        "Cajas", "CajasTotal", "CajasEnvasadas",
        "ValorDolares", "Valor", "ValorUSD",
        "Certificado", "NOM", "Empresa", "Marca", "Periodo",
        "Anio_Exportacion", "Año_Exportacion", "AñoExportacion",
        "MesExportacion", "Mes_Exportacion",
        "FechaExportacion", "Fecha", "Periodo_Anio", "Periodo_Mes",
    ]

    print(f"エンティティ '{ENTITY}' のカラム探索中 ({len(candidates)} 候補)...")
    print("=" * 60)
    found = []
    not_found = []

    for col in candidates:
        try:
            payload = build_query([col])
            data = query_api(payload)
            if has_column_error(data):
                print(f"  ✗ {col}: カラム不存在")
                not_found.append(col)
            else:
                col_names, rows = parse_results(data)
                if rows:
                    print(f"  ✓ {col}: 例={rows[0].get(col)}")
                else:
                    print(f"  ✓ {col}: 存在（行なし or 別DSR構造）")
                found.append(col)
        except Exception as e:
            print(f"  ? {col}: 例外={e}")

    print("=" * 60)
    print(f"\n✓ 存在するカラム ({len(found)}件): {found}")
    print(f"✗ 存在しないカラム ({len(not_found)}件): {not_found}")

def dump_response(columns=None):
    """生レスポンスをフルダンプ（DSR構造確認用）"""
    cols = columns or CONFIRMED_COLUMNS
    print(f"カラム {cols} のAPIレスポンス:")
    payload = build_query(cols)
    data = query_api(payload)
    print(json.dumps(data, ensure_ascii=False, indent=2))

def fetch_data(country=None, output="stdout", columns=None):
    """データ取得（年・月・輸出量メジャー含む）"""
    dim_cols = columns or (CONFIRMED_COLUMNS + [YEAR_COLUMN, MONTH_COLUMN])
    measure_cols = [MEASURE_LITROS]

    filters = {}
    if country:
        filters[COUNTRY_COLUMN] = country

    print(f"クエリ: columns={dim_cols} measures={measure_cols} country={country}")
    payload = build_query(dim_cols, filters if filters else None, measure_cols)
    data = query_api(payload)

    if has_column_error(data):
        # 年月カラムが存在しない場合、それなしで再試行
        print(f"WARN: カラムエラー。年月({YEAR_COLUMN}/{MONTH_COLUMN})なしで再試行...")
        dim_cols = [c for c in dim_cols if c not in (YEAR_COLUMN, MONTH_COLUMN)]
        print(f"クエリ（再試行）: columns={dim_cols} measures={measure_cols}")
        payload = build_query(dim_cols, filters if filters else None, measure_cols)
        data = query_api(payload)

    if has_column_error(data):
        print("ERROR: カラム名が正しくありません")
        print(json.dumps(data, ensure_ascii=False, indent=2)[:2000])
        sys.exit(1)

    col_names, rows = parse_results(data)

    if not rows:
        print("データが取得できませんでした（DSR構造が異なる可能性あり）")
        print("--dump オプションで生レスポンスを確認してください")
        print(json.dumps(data, ensure_ascii=False, indent=2)[:3000])
        return

    print(f"\n取得件数: {len(rows)} 件")
    print(f"カラム: {col_names}")
    print()

    if output == "csv":
        fname = f"crt_export_{country or 'all'}.csv"
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
    parser.add_argument("--dump",     action="store_true", help="生レスポンスをダンプ（構造確認用）")
    parser.add_argument("--country",  help="国名フィルタ（Paisカラム）（例: Japón）")
    parser.add_argument("--output",   default="stdout", choices=["stdout", "csv"])
    parser.add_argument("--columns",  nargs="+", default=None,
                        help=f"取得するカラム（デフォルト: {' '.join(CONFIRMED_COLUMNS)}）")
    args = parser.parse_args()

    if args.discover:
        discover_columns()
    elif args.dump:
        dump_response(args.columns)
    else:
        fetch_data(
            country=args.country,
            output=args.output,
            columns=args.columns,
        )

"""
CRT (Consejo Regulador del Tequila) 輸出統計取得スクリプト
Power BI 公開レポートAPIを直接呼ぶ

確認済みカラム（discover実行結果）:
  Grupo     = 地域（Norte/Sur 等）
  Pais      = 国名（例: JAPON）
  Clase     = クラス（BLANCO/REPOSADO 等）
  Categoria = カテゴリ（TEQUILA / TEQUILA 100% DE AGAVE）
  Litros_40 = 輸出量（40%アルコール換算リットル）
  Fecha     = 日付（年月情報を含む）

使い方:
  # カラム一覧確認
  python3 crt_fetch.py --discover

  # 全データ取得（全年月・全カテゴリ・輸出量含む）
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

# discover で存在確認済みのカラム（全6列）
CONFIRMED_COLUMNS = ["Pais", "Clase", "Categoria", "Grupo", "Fecha", "Litros_40"]
COUNTRY_COLUMN    = "Pais"

HEADERS = {
    "Content-Type": "application/json;charset=UTF-8",
    "X-PowerBI-ResourceKey": RESOURCE_KEY,
    "Origin": "https://app.powerbi.com",
    "Referer": "https://app.powerbi.com/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
}

def build_query(columns, filters=None, measures=None, year_range=None):
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

    where_clauses = []

    if filters:
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

    if year_range:
        y_from, y_to = year_range
        where_clauses.append({
            "Condition": {
                "Between": {
                    "Expression": {"Column": {"Expression": {"SourceRef": {"Source": "v"}}, "Property": "Fecha"}},
                    "LowerBound": {"Literal": {"Value": f"datetime'{y_from}-01-01T00:00:00'"}},
                    "UpperBound": {"Literal": {"Value": f"datetime'{y_to}-12-31T23:59:59'"}}
                }
            }
        })

    if where_clauses:
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
                            "DataReduction": {"DataVolume": 4, "Primary": {"Window": {"Count": 500000}}},
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

def query_api_all_pages(payload):
    """全ページを取得してDM0行を結合して返す"""
    import copy
    all_rows_data = None
    ds = None
    page = 1

    while True:
        print(f"  ページ {page} 取得中...")
        data = query_api(payload)

        if all_rows_data is None:
            all_rows_data = data
            ds = data["results"][0]["result"]["data"]["dsr"]["DS"][0]
        else:
            ds_new = data["results"][0]["result"]["data"]["dsr"]["DS"][0]
            dm0_new = ds_new.get("PH", [{}])[0].get("DM0", [])
            if not dm0_new:
                break
            ds["PH"][0]["DM0"].extend(dm0_new)

        # Restartトークンを探索（PH[0]またはDS直下）
        restart = (ds.get("PH", [{}])[0].get("Restart")
                   or ds.get("Restart"))
        if not restart:
            # デバッグ: DSのトップレベルキーを表示
            print(f"  DS keys: {list(ds.keys())}")
            print(f"  PH[0] keys: {list(ds.get('PH', [{}])[0].keys())}")
            break

        print(f"  Restartトークン検出: 次ページへ")
        payload = copy.deepcopy(payload)
        cmd = payload["queries"][0]["Query"]["Commands"][0]["SemanticQueryDataShapeCommand"]
        cmd["Binding"]["Primary"]["Groupings"][0]["Restart"] = restart
        page += 1

    print(f"  合計 {page} ページ取得完了")
    return all_rows_data

def has_column_error(data):
    """カラム不存在エラーかどうかチェック"""
    raw = json.dumps(data, ensure_ascii=False)
    return ("CouldNotResolveSemanticQueryDefinition" in raw or
            "invalid Column" in raw or
            "Cannot find field" in raw)

import re as _re

def _clean_value(val, col_name=None):
    """DSRリテラル値をPythonネイティブ型に変換"""
    # Unixタイムスタンプ（ms）→ 日付文字列
    # 年1990〜2100の範囲: 631152000000 〜 4102444800000
    if isinstance(val, (int, float)) and 6.3e11 < val < 4.2e12:
        from datetime import datetime, timezone
        return datetime.fromtimestamp(val / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
    if not isinstance(val, str):
        return val
    # datetime'2012-01-01T00:00:00' → '2012-01-01'
    m = _re.match(r"datetime'(\d{4}-\d{2}-\d{2})T", val)
    if m:
        return m.group(1)
    # 73.5D / 12345L → 数値
    if val.endswith("D") or val.endswith("L"):
        try:
            return float(val[:-1])
        except ValueError:
            pass
    # 'ALEMANIA' → ALEMANIA（クォート除去）
    if val.startswith("'") and val.endswith("'"):
        return val[1:-1]
    return val

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

        # RT（参照行）がある場合は初期値として設定
        rt = ds.get("RT", [])
        if rt and len(rt) > 0:
            for i, v in enumerate(rt[0]):
                if i < n_cols:
                    prev[i] = _clean_value(v)

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
                    row_vals[i] = _clean_value(val)
                    c_idx += 1

            prev = row_vals
            rows.append(dict(zip(col_names, row_vals)))

        # Fecha列から Año・Mes列を追加、Litros_40の浮動小数点丸め
        if "Fecha" in col_names:
            for row in rows:
                fecha = str(row.get("Fecha") or "")
                # YYYY-MM-DD 形式を期待
                if len(fecha) >= 7 and fecha[4] == "-":
                    row["Año"] = int(fecha[:4])
                    row["Mes"] = int(fecha[5:7])
                else:
                    row["Año"] = None
                    row["Mes"] = None
                # 浮動小数点誤差を丸める（全float列）
                for k, v in row.items():
                    if isinstance(v, float):
                        row[k] = round(v, 4)
            col_names = col_names + ["Año", "Mes"]

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
    """データ取得（年単位で分割リクエスト、全期間を結合）"""
    cols = columns or CONFIRMED_COLUMNS
    filters = {COUNTRY_COLUMN: country} if country else None

    # CRTデータの開始年〜現在年
    current_year = datetime.utcnow().year
    years = list(range(2003, current_year + 1))

    all_rows = []
    col_names = None

    for year in years:
        print(f"  {year} 年取得中...")
        payload = build_query(cols, filters, year_range=(year, year))
        data = query_api(payload)
        if has_column_error(data):
            print(f"    スキップ（カラムエラー）")
            continue
        names, rows = parse_results(data)
        if rows:
            print(f"    {len(rows)} 件")
            if col_names is None:
                col_names = names
            all_rows.extend(rows)
        else:
            print(f"    0 件")

    if not all_rows:
        print("データが取得できませんでした")
        return

    print(f"\n取得件数（集計前）: {len(all_rows)} 件")

    # Litros_40をキー列でグループ集計
    group_keys = [c for c in col_names if c != "Litros_40"]
    agg = {}
    for row in all_rows:
        key = tuple(row.get(k) for k in group_keys)
        litros = row.get("Litros_40")
        try:
            litros = float(litros) if litros is not None else 0.0
        except (ValueError, TypeError):
            litros = 0.0
        agg[key] = agg.get(key, 0.0) + litros
    rows = [{**dict(zip(group_keys, k)), "Litros_40": round(v, 4)} for k, v in agg.items()]
    col_names = group_keys + ["Litros_40"]

    print(f"取得件数（集計後）: {len(rows)} 件")

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
        for row in rows[:5]:
            print(row)
        if len(rows) > 5:
            print(f"... 他 {len(rows)-5} 件")

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

"""
CRT 統計データ取得スクリプト（追加3種）
- 生産統計 (Producción)
- 輸出形態 (Exportaciones por Forma: Envasado/Granel)
- アガベ消費量 (Consumo de Agave)
- 蒸留所座標 (Fábricas NOM座標)

Power BI 公開レポートAPIを直接呼ぶ

使い方:
  python3 tools/crt_stats_fetch.py --discover           # エンティティ名探索
  python3 tools/crt_stats_fetch.py --dump --dataset produccion
  python3 tools/crt_stats_fetch.py --output sqlite      # 全データ取得
  python3 tools/crt_stats_fetch.py --output sqlite --year 2024 --month 1
  python3 tools/crt_stats_fetch.py --fabricas           # 蒸留所座標取得
"""

import requests, json, sys, argparse, re, sqlite3, os
from datetime import datetime, timezone

ENDPOINT    = "https://wabi-paas-1-scus-api.analysis.windows.net/public/reports/querydata"
RESOURCE_KEY = "56739c8d-5830-48ac-8185-932395973bb6"
DATASET_ID   = "939ce5cb-cbfd-4d83-979d-c0f07089f729"
REPORT_ID    = "c131a218-ef98-4513-a36b-afd7acb34575"
MODEL_ID     = 5590467

HEADERS = {
    "Content-Type": "application/json;charset=UTF-8",
    "X-PowerBI-ResourceKey": RESOURCE_KEY,
    "Origin": "https://app.powerbi.com",
    "Referer": "https://app.powerbi.com/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
}

DB_PATH = "data/crt_stats.db"

# 候補エンティティ名（--discover で総当たりテスト）
ENTITY_CANDIDATES = [
    # 確認済み
    "vEstPBIIntProduccionTequila",    # 生産統計（確認済み）
    "vEstPagWebExportacionesDestino", # 輸出先（確認済み）
    # 輸出形態候補（vEstPBIInt prefix）
    "vEstPBIIntExportacionesForma",
    "vEstPBIIntExportaciones",
    "vEstPBIIntExportacionesTipo",
    "vEstPBIIntExportacionesEnvase",
    # アガベ消費候補
    "vEstPBIIntConsumoAgave",
    "vEstPBIIntAgave",
    "vEstPBIIntConsumo",
    # 座標候補（より多くのパターン）
    "vEstPBIIntFabricas",
    "vEstPBIIntFabricasMapa",
    "vEstPBIIntEmpresas",
    "vEstPBIIntNOM",
    "vEstPBIIntMapa",
    "vEstPBIIntMapaFabricas",
    "vEstPBIIntDistillerias",
    "vEstPBIIntPlantasFabricantes",
    "vEstPBIIntCertificados",
    "vEstPBIIntPlantas",
    "vEstPagWebFabricas",
    "vEstPagWebMapa",
    # その他テーブル
    "Calendario",
    "Medidas",
    "Fabricas",
    "NOM",
    "Empresas",
    "Plantas",
]

DATASETS = {
    "produccion": {
        "entity": "vEstPBIIntProduccionTequila",
        "vol_col": "Producción Total",
        "dim_col": "Categoria",
        "cal_entity": "Calendario",
        "table": "produccion",
        "keys": ["Año", "Categoria"],
    },
    "forma": {
        "entity": "vEstPBIIntExportacionesForma",
        "vol_col": "Total Por Forma",
        "dim_col": "Forma",
        "cal_entity": "Calendario",
        "table": "exportaciones_forma",
        "keys": ["Forma", "Año"],
    },
    "agave": {
        "entity": "vEstPBIIntConsumoAgave",
        "vol_col": "Total Consumo Agave",
        "dim_col": "Categoria",
        "cal_entity": "Calendario",
        "table": "consumo_agave",
        "keys": ["Categoria", "Año"],
    },
    "fabricas": {
        "entity": "vEstPBIIntFabricas",            # エンティティ未確認
        "columns": ["NOM", "Empresa", "Municipio", "Estado", "Latitud", "Longitud"],
        "table": "fabricas",
        "keys": ["NOM"],
        "date_col": None,
    },
}

# 各データセット用に探索するカラム候補
COLUMN_CANDIDATES = {
    "produccion": [
        "Categoria", "Categoría", "Clase", "TipoProducto",
        "Fecha", "Año", "Ano", "Anio", "Mes",
        "Litros_40", "Litros", "LitrosTotal", "Produccion", "VolumenTotal",
        "Producción Total", "ProduccionTotal", "Total",
    ],
    "forma": [
        "Forma", "TipoEnvase", "Envase", "Tipo", "Presentacion",
        "Envasado", "Granel",
        "Fecha", "Año", "Mes",
        "Litros_40", "Litros", "LitrosEnvasados", "LitrosGranel",
        "Litros 40", "LitrosTotales", "VolumenTotal", "Volumen",
        "Exportaciones", "Total", "Cantidad",
        "Litros_40_Envasado", "Litros_40_Granel",
    ],
    "agave": [
        "Categoria", "Categoría", "Clase",
        "Fecha", "Año", "Mes",
        "TonelAzucar", "Toneladas", "Toneladas_Azucar", "KgAzucar",
        "Litros_40", "Litros",
        "ToneladasAzucar", "Toneladas Azucar", "Total",
        "Consumo", "ConsumoTotal", "Azucar", "Agave",
        "TonelAzúcar", "Toneladas de Azucar",
    ],
    "fabricas": [
        "NOM", "Nom", "CertificadoNOM", "NumNOM",
        "Empresa", "RazonSocial", "Nombre", "NombreEmpresa",
        "Municipio", "Ciudad", "Localidad",
        "Estado", "Region",
        "Latitud", "Lat", "Latitude", "lat",
        "Longitud", "Long", "Lng", "Longitude", "lon",
        "CP", "CodigoPostal",
        "X", "Y", "Coordenadas",
    ],
}


def _clean_value(val):
    if isinstance(val, (int, float)) and 6.3e11 < val < 4.2e12:
        return datetime.fromtimestamp(val / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
    if not isinstance(val, str):
        return val
    m = re.match(r"datetime'(\d{4}-\d{2}-\d{2})T", val)
    if m:
        return m.group(1)
    if val.endswith("D") or val.endswith("L"):
        try:
            return float(val[:-1])
        except ValueError:
            pass
    if val.startswith("'") and val.endswith("'"):
        return val[1:-1]
    return val


def has_error(data):
    raw = json.dumps(data, ensure_ascii=False)
    return ("CouldNotResolveSemanticQueryDefinition" in raw or
            "invalid Column" in raw or
            "Cannot find field" in raw or
            "InvalidEntity" in raw or
            "doesn't contain a table" in raw)


def build_produccion_query(year=None):
    """生産統計クエリ: vEstPBIIntProduccionTequila + Calendario 結合（フラット形式）"""
    return build_cal_join_query("vEstPBIIntProduccionTequila", "Categoria", "Producción Total", year, src="v1")


def build_cal_join_query(entity, dim_col, vol_col, year=None, src="v"):
    """Calendario結合クエリ（フラット形式）: Año × dim_col × Sum(vol_col) を行ごとに返す"""
    query = {
        "Version": 2,
        "From": [
            {"Name": src, "Entity": entity, "Type": 0},
            {"Name": "c", "Entity": "Calendario", "Type": 0},
        ],
        "Select": [
            {"Column": {"Expression": {"SourceRef": {"Source": "c"}}, "Property": "Año"},
             "Name": "Calendario.Año", "NativeReferenceName": "Año"},
            {"Column": {"Expression": {"SourceRef": {"Source": src}}, "Property": dim_col},
             "Name": f"{src}.{dim_col}", "NativeReferenceName": dim_col},
            {"Aggregation": {
                "Expression": {"Column": {"Expression": {"SourceRef": {"Source": src}}, "Property": vol_col}},
                "Function": 0},
             "Name": f"Sum({entity}.{vol_col})", "NativeReferenceName": "Total"},
        ],
    }
    if year:
        query["Where"] = [{
            "Condition": {
                "In": {
                    "Expressions": [{"Column": {"Expression": {"SourceRef": {"Source": "c"}}, "Property": "Año"}}],
                    "Values": [[{"Literal": {"Value": f"{year}L"}}]]
                }
            }
        }]
    return {
        "version": "1.0.0",
        "queries": [{
            "Query": {"Commands": [{"SemanticQueryDataShapeCommand": {
                "Query": query,
                "Binding": {
                    "Primary": {"Groupings": [{"Projections": [0, 1, 2]}]},
                    "DataReduction": {"DataVolume": 4, "Primary": {"Window": {"Count": 500}}},
                    "Version": 1
                },
                "ExecutionMetricsKind": 1
            }}]},
            "QueryId": "",
            "ApplicationContext": {"DatasetId": DATASET_ID, "Sources": [{"ReportId": REPORT_ID}]}
        }],
        "cancelQueries": [],
        "modelId": MODEL_ID
    }


def build_query(entity, columns, filters=None, date_range=None):
    from_clause = [{"Name": "v", "Entity": entity, "Type": 0}]
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

    n_total = len(columns)
    query = {
        "Version": 2,
        "From": from_clause,
        "Select": select_clause,
    }

    where_clauses = []
    if filters:
        for col, val in filters.items():
            where_clauses.append({
                "Condition": {
                    "In": {
                        "Expressions": [{"Column": {"Expression": {"SourceRef": {"Source": "v"}}, "Property": col}}],
                        "Values": [[{"Literal": {"Value": f"'{val}'"}}]]
                    }
                }
            })

    if date_range:
        y_from, y_to = date_range
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

    return {
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
    try:
        result_data = data["results"][0]["result"]["data"]
        col_names = []
        for sel in result_data.get("descriptor", {}).get("Select", []):
            name = sel.get("NativeReferenceName")
            if not name:
                gk = sel.get("GroupKeys", [])
                name = gk[0]["Source"]["Property"] if gk else sel.get("Name", f"col{len(col_names)}")
            col_names.append(name)

        if "dsr" not in result_data:
            return col_names, []

        ds = result_data["dsr"]["DS"][0]
        # DS.S contains short internal names — do NOT override col_names with them

        n_cols = len(col_names)
        value_dicts = ds.get("ValueDicts", {})
        dm0 = ds.get("PH", [{}])[0].get("DM0", [])
        prev = [None] * n_cols
        rows = []

        for vd in dm0:
            c_arr = vd.get("C", [])
            r_bits = vd.get("R", 0)
            row_vals = list(prev)
            c_idx = 0
            for i in range(n_cols):
                if r_bits & (1 << i):
                    pass
                else:
                    val = c_arr[c_idx] if c_idx < len(c_arr) else None
                    if isinstance(val, int):
                        d = value_dicts.get(f"D{i}", [])
                        val = d[val] if val < len(d) else val
                    row_vals[i] = _clean_value(val)
                    c_idx += 1
            prev = row_vals
            rows.append(dict(zip(col_names, row_vals)))

        return col_names, rows
    except (KeyError, IndexError) as e:
        print(f"  parse_results エラー: {e}", file=sys.stderr)
        return [], []


def add_year_month(rows, date_col="Fecha"):
    for row in rows:
        fecha = str(row.get(date_col) or "")
        if len(fecha) >= 7 and fecha[4] == "-":
            row["Año"] = int(fecha[:4])
            row["Mes"] = int(fecha[5:7])
        else:
            row["Año"] = None
            row["Mes"] = None
    return rows


# ── Discovery ──────────────────────────────────────────────────────────────────

def discover_entities():
    """エンティティ名候補を総当たりテスト"""
    print(f"エンティティ探索中 ({len(ENTITY_CANDIDATES)} 候補)...")
    print("=" * 60)
    found = []

    test_col = "Fecha"
    for entity in ENTITY_CANDIDATES:
        try:
            payload = build_query(entity, [test_col])
            data = query_api(payload)
            if has_error(data):
                # Fechaがないだけかもしれないので別カラムも試す
                payload2 = build_query(entity, ["NOM"])
                data2 = query_api(payload2)
                if has_error(data2):
                    print(f"  ✗ {entity}")
                else:
                    print(f"  ✓ {entity} (NOM存在)")
                    found.append(entity)
            else:
                _, rows = parse_results(data)
                ex = rows[0].get(test_col) if rows else "(行なし)"
                print(f"  ✓ {entity}: Fecha例={ex}")
                found.append(entity)
        except Exception as e:
            print(f"  ? {entity}: {e}")

    print("=" * 60)
    print(f"\n存在するエンティティ: {found}")
    return found


def discover_columns_for(entity, candidates):
    """指定エンティティのカラム名を探索"""
    print(f"\nエンティティ '{entity}' のカラム探索中...")
    found = []
    for col in candidates:
        try:
            payload = build_query(entity, [col])
            data = query_api(payload)
            if has_error(data):
                print(f"  ✗ {col}")
            else:
                _, rows = parse_results(data)
                ex = rows[0].get(col) if rows else "(行なし)"
                print(f"  ✓ {col}: 例={ex}")
                found.append(col)
        except Exception as e:
            print(f"  ? {col}: {e}")
    print(f"\n存在するカラム: {found}")
    return found


def dump_entity_raw(entity, dim_cols):
    """エンティティの生DSRレスポンスをダンプ（メジャー名発見用）"""
    print(f"\n=== {entity} 生レスポンス ===")
    payload = build_query(entity, dim_cols)
    data = query_api(payload)
    # descriptor.Select からカラム/メジャー名を抽出
    try:
        selects = data["results"][0]["result"]["data"].get("descriptor", {}).get("Select", [])
        print(f"descriptor.Select ({len(selects)} 項目):")
        for s in selects:
            print(f"  {json.dumps(s, ensure_ascii=False)}")
        ds = data["results"][0]["result"]["data"]["dsr"]["DS"][0]
        if "S" in ds:
            print(f"DS.S (列名): {[c['N'] for c in ds['S']]}")
        if "ValueDicts" in ds:
            print(f"DS.ValueDicts keys: {list(ds['ValueDicts'].keys())}")
    except Exception as e:
        print(f"パース失敗: {e}")
    print(json.dumps(data, ensure_ascii=False, indent=2)[:3000])


# ── Fetch by year ──────────────────────────────────────────────────────────────

def fetch_produccion_year(year):
    """生産統計1年分を Calendario 結合クエリで取得"""
    payload = build_produccion_query(year)
    data = query_api(payload)
    if has_error(data):
        return None
    _, rows = parse_results(data)
    # Año列を追加（クエリ結果に含まれているはず）
    for row in rows:
        if "Año" not in row or row["Año"] is None:
            row["Año"] = year
    return rows


def fetch_dataset_year(ds_cfg, year):
    """1年分のデータを取得（30k行制限回避のため年単位）"""
    entity = ds_cfg["entity"]
    columns = ds_cfg["columns"]
    date_col = ds_cfg.get("date_col")

    if date_col:
        payload = build_query(entity, columns, date_range=(year, year))
    else:
        payload = build_query(entity, columns)

    data = query_api(payload)
    if has_error(data):
        print(f"  エラー: {json.dumps(data)[:300]}", file=sys.stderr)
        return None

    _, rows = parse_results(data)
    if date_col and rows:
        rows = add_year_month(rows, date_col)
    return rows


def fetch_cal_join_year(ds_cfg, year):
    """forma/agave用: Calendario結合クエリで1年分取得"""
    payload = build_cal_join_query(
        ds_cfg["entity"], ds_cfg["dim_col"], ds_cfg["vol_col"], year
    )
    data = query_api(payload)
    if has_error(data):
        return None
    _, rows = parse_results(data)
    for row in rows:
        row.setdefault("Año", year)
    return rows


def fetch_all_years(ds_name, ds_cfg, year_from=2003):
    """全年分を順番に取得して結合"""
    current_year = datetime.now(timezone.utc).year
    all_rows = []
    for year in range(year_from, current_year + 1):
        print(f"  {year}年 取得中...", end=" ", flush=True)
        if "vol_col" in ds_cfg:
            rows = fetch_cal_join_year(ds_cfg, year)
        else:
            rows = fetch_dataset_year(ds_cfg, year)
        if rows is None:
            print(f"エラー（スキップ）")
            continue
        print(f"{len(rows)} 行")
        all_rows.extend(rows)
    return all_rows


def fetch_single_month(ds_cfg, year, month):
    import calendar
    entity = ds_cfg["entity"]
    columns = ds_cfg["columns"]
    last_day = calendar.monthrange(year, month)[1]

    payload = build_query(entity, columns)
    cmd = payload["queries"][0]["Query"]["Commands"][0]["SemanticQueryDataShapeCommand"]
    cmd["Query"].setdefault("Where", []).append({
        "Condition": {
            "Between": {
                "Expression": {"Column": {"Expression": {"SourceRef": {"Source": "v"}}, "Property": "Fecha"}},
                "LowerBound": {"Literal": {"Value": f"datetime'{year}-{month:02d}-01T00:00:00'"}},
                "UpperBound": {"Literal": {"Value": f"datetime'{year}-{month:02d}-{last_day:02d}T23:59:59'"}}
            }
        }
    })

    data = query_api(payload)
    if has_error(data):
        return None
    _, rows = parse_results(data)
    if rows:
        rows = add_year_month(rows, "Fecha")
    return rows


# ── SQLite storage ─────────────────────────────────────────────────────────────

def upsert_rows(conn, table, rows, keys, extra_cols=None):
    if not rows:
        return 0
    all_cols = list(rows[0].keys())
    if extra_cols:
        all_cols = [c for c in all_cols if c not in extra_cols] + extra_cols

    placeholders = ", ".join(["?"] * len(all_cols))
    col_list = ", ".join([f'"{c}"' for c in all_cols])
    sql = f'INSERT OR REPLACE INTO "{table}" ({col_list}) VALUES ({placeholders})'

    conn.execute(f'''CREATE TABLE IF NOT EXISTS "{table}" (
        {", ".join([f'"{c}" TEXT' for c in all_cols])},
        PRIMARY KEY ({", ".join([f'"{k}"' for k in keys])})
    )''')

    data = [[row.get(c) for c in all_cols] for row in rows]
    conn.executemany(sql, data)
    conn.commit()
    return len(rows)


def store_to_sqlite(ds_name, rows):
    ds_cfg = DATASETS[ds_name]
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    n = upsert_rows(conn, ds_cfg["table"], rows, ds_cfg["keys"])
    conn.close()
    print(f"  DB保存: {n} 行 → {DB_PATH} [{ds_cfg['table']}]")
    return n


# ── Fabricas (distillery coordinates) ─────────────────────────────────────────

def fetch_fabricas():
    """蒸留所座標を取得（エンティティは複数候補を試す）"""
    entity_candidates = [
        "vEstPBIIntFabricas",
        "vEstPagWebFabricas",
        "vEstPagWebFabricasMapa",
        "vEstPagWebEmpresas",
        "vEstPagWebNOM",
        "vEstPBIFabricas",
        "vEstPBIIntNOM",
        "vEstPBIIntEmpresas",
        "FabricasMapa",
        "Fabricas",
    ]
    col_candidates = [
        ["NOM", "Empresa", "Municipio", "Estado", "Latitud", "Longitud"],
        ["NOM", "Empresa", "Estado", "Latitud", "Longitud"],
        ["NOM", "Empresa", "Latitud", "Longitud"],
        ["NOM", "Latitud", "Longitud"],
        ["NOM", "Lat", "Long"],
        ["NOM", "Lat", "Lng"],
        ["NOM", "latitude", "longitude"],
    ]

    for entity in entity_candidates:
        for cols in col_candidates:
            try:
                print(f"  試行: {entity} {cols}")
                payload = build_query(entity, cols)
                data = query_api(payload)
                if not has_error(data):
                    _, rows = parse_results(data)
                    if rows:
                        print(f"  ✓ {entity}: {len(rows)} 行")
                        print(f"    例: {rows[0]}")
                        return entity, cols, rows
            except Exception as e:
                print(f"  ? {e}")
    return None, None, []


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="CRT統計データ取得")
    parser.add_argument("--discover", action="store_true", help="エンティティ・カラム探索")
    parser.add_argument("--discover-cols", metavar="ENTITY", help="指定エンティティのカラム探索")
    parser.add_argument("--dump", metavar="DATASET", help="生レスポンスダンプ (produccion/forma/agave/fabricas)")
    parser.add_argument("--output", choices=["sqlite", "csv", "print"], default="print")
    parser.add_argument("--dataset", choices=list(DATASETS.keys()), help="取得するデータセット（省略=全部）")
    parser.add_argument("--year", type=int, help="取得年（省略=全年）")
    parser.add_argument("--month", type=int, help="取得月（--yearと組み合わせ）")
    parser.add_argument("--fabricas", action="store_true", help="蒸留所座標取得")
    args = parser.parse_args()

    if args.discover:
        discover_entities()
        # 全データセットのカラムも探索
        for ds_name, ds_cfg in DATASETS.items():
            discover_columns_for(ds_cfg["entity"], COLUMN_CANDIDATES[ds_name])
        return

    if args.discover_cols:
        entity = args.discover_cols
        ds_name = next((k for k, v in DATASETS.items() if v["entity"] == entity), None)
        cands = COLUMN_CANDIDATES.get(ds_name, []) if ds_name else list(set(
            c for v in COLUMN_CANDIDATES.values() for c in v
        ))
        discover_columns_for(entity, cands)
        return

    if args.fabricas:
        entity, cols, rows = fetch_fabricas()
        if rows:
            print(f"\n取得完了: {len(rows)} 行")
            if args.output == "sqlite":
                DATASETS["fabricas"]["entity"] = entity
                DATASETS["fabricas"]["columns"] = cols
                store_to_sqlite("fabricas", rows)
            else:
                for r in rows[:20]:
                    print(r)
        else:
            print("蒸留所座標の取得に失敗しました")
        return

    if args.dump:
        ds_name = args.dump
        if ds_name not in DATASETS:
            # エンティティ名直接指定も許容
            dump_entity_raw(ds_name, ["Fecha"])
            return
        ds_cfg = DATASETS[ds_name]
        payload = build_query(ds_cfg["entity"], ds_cfg["columns"])
        data = query_api(payload)
        print(json.dumps(data, ensure_ascii=False, indent=2))
        # 生レスポンスも解析して列名を表示
        dump_entity_raw(ds_cfg["entity"], ds_cfg["columns"])
        return

    targets = [args.dataset] if args.dataset else list(DATASETS.keys())
    targets = [t for t in targets if t != "fabricas"]  # fabricas is separate

    for ds_name in targets:
        ds_cfg = DATASETS[ds_name]
        print(f"\n=== {ds_name} ({ds_cfg['entity']}) ===")

        if args.year and args.month:
            rows = fetch_single_month(ds_cfg, args.year, args.month)
            rows = rows or []
            print(f"  {args.year}/{args.month:02d}: {len(rows)} 行")
        elif args.year:
            if "vol_col" in ds_cfg:
                rows = fetch_cal_join_year(ds_cfg, args.year) or []
            else:
                rows = fetch_dataset_year(ds_cfg, args.year) or []
            print(f"  {args.year}: {len(rows)} 行")
        else:
            rows = fetch_all_years(ds_name, ds_cfg)

        if not rows:
            print(f"  データなし（エンティティ名確認が必要な可能性）")
            continue

        if args.output == "sqlite":
            store_to_sqlite(ds_name, rows)
        elif args.output == "csv":
            import csv
            out = f"data/crt_{ds_name}.csv"
            os.makedirs("data", exist_ok=True)
            with open(out, "w", newline="", encoding="utf-8") as f:
                w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
                w.writeheader()
                w.writerows(rows)
            print(f"  CSV保存: {out}")
        else:
            for r in rows[:10]:
                print(f"  {r}")
            if len(rows) > 10:
                print(f"  ... ({len(rows)} 行)")


if __name__ == "__main__":
    main()

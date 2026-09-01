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

import requests, json, sys, argparse, csv, os, re, base64
from urllib.parse import unquote
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

# ── Power BI リソースキーの動的解決 ─────────────────────────────
# CRT が公開レポートを再発行すると X-PowerBI-ResourceKey が変わり 401 になる。
# 実行時に CRT 統計ページから現在のキーを取得し、失敗時はハードコード値へフォールバック。
# 環境変数 CRT_RESOURCE_KEY があれば最優先で使用（手動上書き用）。
CRT_STATS_PAGES = [
    "https://www.crt.org.mx/EstadisticasCRTweb/",
    "https://www.crt.org.mx/estadisticascrtweb/",
]
_GUID_RE = re.compile(r'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}')

def _decode_pbi_token(tok):
    """app.powerbi.com/view?r=<token> の token を base64url デコードして JSON を返す"""
    tok = unquote(tok)
    s = tok.replace('-', '+').replace('_', '/')
    s += '=' * (-len(s) % 4)
    try:
        return json.loads(base64.b64decode(s).decode('utf-8', 'replace'))
    except Exception:
        return None

def _scan_html_for_key(html, verbose=False):
    """HTML から resourceKey / view?r トークンを探す。(key, meta) を返す。"""
    # 1) view?r=<token> → JSON.k がリソースキー
    for tok in re.findall(r'powerbi\.com/view\?r=([A-Za-z0-9%_\-\.]+)', html):
        j = _decode_pbi_token(tok)
        if j and j.get('k'):
            if verbose: print(f"[resolve] view?r トークンからキー取得: {j['k']}")
            return j['k'], j
    # 2) resourceKey / ctid 直書き
    m = re.search(r'(?:X-PowerBI-ResourceKey|resourceKey)"?\s*[:=]\s*"?(' + _GUID_RE.pattern + ')', html, re.I)
    if m:
        if verbose: print(f"[resolve] resourceKey 直接検出: {m.group(1)}")
        return m.group(1), None
    return None, None

def resolve_resource_key(verbose=False):
    """現在の Power BI リソースキーを解決して返す（見つからなければ既定値）。"""
    env = os.environ.get("CRT_RESOURCE_KEY", "").strip()
    if env:
        if verbose: print(f"[resolve] 環境変数 CRT_RESOURCE_KEY を使用: {env}")
        return env
    ua = {"User-Agent": HEADERS["User-Agent"]}
    sess = requests.Session()
    seen = set()
    queue = list(CRT_STATS_PAGES)
    while queue:
        url = queue.pop(0)
        if url in seen:
            continue
        seen.add(url)
        try:
            r = sess.get(url, headers=ua, timeout=30)
            html = r.text
        except Exception as e:
            if verbose: print(f"[resolve] {url} 取得失敗: {e}")
            continue
        key, meta = _scan_html_for_key(html, verbose)
        if key:
            return key
        # レポートを別ページ/iframe に埋め込んでいる場合は追う（同サイト+powerbiのみ）
        iframes = re.findall(r'<iframe[^>]+src="([^"]+)"', html, re.I)
        for u in iframes:
            if u.startswith('//'): u = 'https:' + u
            if 'powerbi.com' in u:
                key, meta = _scan_html_for_key(u, verbose)  # iframe src 自体に view?r が入る場合
                if key:
                    return key
        if verbose:
            pu = re.findall(r'https?://[^"\'\)\s]*powerbi[^"\'\)\s]*', html)
            print(f"[resolve] {url}: HTML {len(html)}B / powerbi参照 {len(pu)}件 / iframe {len(iframes)}件")
            for u in pu[:10]: print("   pbi:", u)
            for u in iframes[:10]: print("   iframe:", u)
    if verbose: print(f"[resolve] 解決できず。既定キーにフォールバック: {RESOURCE_KEY}")
    return RESOURCE_KEY

def apply_resource_key(verbose=False):
    key = resolve_resource_key(verbose)
    HEADERS["X-PowerBI-ResourceKey"] = key
    return key

def resolve_report_config(verbose=False):
    """resourceKey を解決し、modelsAndExploration から modelId/datasetId/reportId を取得。
    グローバル RESOURCE_KEY 相当(HEADERS) / DATASET_ID / REPORT_ID / MODEL_ID を更新する。
    取得できない項目は既定値を維持。"""
    global DATASET_ID, REPORT_ID, MODEL_ID
    key = apply_resource_key(verbose)
    host = ENDPOINT.split("/public/")[0]
    url = f"{host}/public/reports/{key}/modelsAndExploration?preferReadOnlySession=true"
    try:
        r = requests.get(url, headers=HEADERS, timeout=30)
        r.raise_for_status()
        data = r.json()
    except Exception as e:
        if verbose: print(f"[config] modelsAndExploration 取得失敗（既定IDを使用）: {e}")
        return key
    models = data.get("models") or []
    if models:
        m0 = models[0]
        if m0.get("id"): MODEL_ID = m0["id"]
        if m0.get("dbName"): DATASET_ID = m0["dbName"]
    # reportId は exploration 内の report.objectId、無ければ本文から GUID を探索
    rep = None
    expl = data.get("exploration") or {}
    if isinstance(expl, dict):
        rep = ((expl.get("report") or {}).get("objectId")
               or expl.get("reportObjectId") or expl.get("objectId"))
    if not rep:
        m = re.search(r'"(?:reportObjectId|reportId)"\s*:\s*"(' + _GUID_RE.pattern + ')"', r.text)
        if m: rep = m.group(1)
    if rep: REPORT_ID = rep
    if verbose:
        print(f"[config] modelId={MODEL_ID} datasetId={DATASET_ID} reportId={REPORT_ID}")
    return key

def probe_all():
    """CRTページ→Power BI公開レポートの現行 key/dataset/report/model を総当り診断"""
    host = ENDPOINT.split("/public/")[0]
    ua = {"User-Agent": HEADERS["User-Agent"]}
    sess = requests.Session()
    tokens = []
    for url in CRT_STATS_PAGES:
        try:
            html = sess.get(url, headers=ua, timeout=30).text
        except Exception as e:
            print(f"[probe] {url} 取得失敗: {e}"); continue
        found = re.findall(r'powerbi\.com/view\?r=([A-Za-z0-9%_\-\.]+)', html)
        print(f"[probe] {url}: HTML {len(html)}B / view?r トークン {len(found)}件")
        # サブページ/iframe候補
        for u in set(re.findall(r'(?:href|src)="([^"]+)"', html)):
            if re.search(r'(export|estad|powerbi|report)', u, re.I):
                print("   link:", u)
        tokens += found
    tokens = list(dict.fromkeys(tokens))
    print(f"[probe] トークン合計 {len(tokens)}件")
    for i, tok in enumerate(tokens):
        j = _decode_pbi_token(tok)
        print(f"\n[probe] === token#{i} decoded === {json.dumps(j, ensure_ascii=False) if j else '(decode不可)'}")
        if not (j and j.get('k')):
            continue
        key = j['k']
        h = dict(HEADERS); h["X-PowerBI-ResourceKey"] = key
        # a) view ページから ID を抽出
        try:
            vp = sess.get("https://app.powerbi.com/view?r=" + tok, headers=ua, timeout=30).text
            for label, pat in [("reportId", r'"reportId"\s*:\s*"([0-9a-fA-F-]{36})"'),
                               ("datasetId", r'"datasetId"\s*:\s*"([0-9a-fA-F-]{36})"'),
                               ("modelId", r'"modelId"\s*:\s*(\d+)'),
                               ("cluster", r'"(?:resolvedClusterUri|clusterUri|cluster)"\s*:\s*"([^"]+)"')]:
                vals = list(dict.fromkeys(re.findall(pat, vp)))
                if vals: print(f"   view.{label}: {vals[:5]}")
        except Exception as e:
            print("   view取得失敗:", e)
        # b) メタデータ endpoint
        for path in [f"/public/reports/{key}/modelsAndExploration?preferReadOnlySession=true"]:
            try:
                r = sess.get(host + path, headers=h, timeout=30)
                print(f"   GET {path} -> {r.status_code}")
                if r.status_code == 200:
                    print("   body[:1500]:", r.text[:1500])
            except Exception as e:
                print("   metadata取得失敗:", e)

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

def query_api(payload, retries=4):
    import time
    delay = 3
    for attempt in range(retries + 1):
        resp = requests.post(
            ENDPOINT + "?synchronous=true",
            headers=HEADERS,
            json=payload,
            timeout=30
        )
        # 429/5xx はレート制限・一時障害としてバックオフ再試行
        if resp.status_code in (429, 500, 502, 503, 504) and attempt < retries:
            wait = delay
            ra = resp.headers.get("Retry-After")
            if ra:
                try: wait = max(wait, int(float(ra)))
                except ValueError: pass
            print(f"  {resp.status_code} 応答。{wait}s 待機して再試行 ({attempt+1}/{retries})")
            time.sleep(wait)
            delay = min(delay * 2, 30)
            continue
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

DB_PATH = "data/crt_exports.db"
DB_KEYS = ["Pais", "Clase", "Categoria", "Grupo", "Fecha"]

def _fetch_month(year, month, country=None, columns=None):
    """指定年月のデータを取得して集計済み行リストを返す"""
    cols = columns or CONFIRMED_COLUMNS
    filters = {COUNTRY_COLUMN: country} if country else None

    # 月の初日〜末日でFechaをフィルタ
    import calendar
    last_day = calendar.monthrange(year, month)[1]
    y_from = f"{year}-{month:02d}-01"
    y_to   = f"{year}-{month:02d}-{last_day:02d}"

    payload = build_query(cols, filters, year_range=None)
    # Fechaフィルタ（Between）を直接追加
    cmd = payload["queries"][0]["Query"]["Commands"][0]["SemanticQueryDataShapeCommand"]
    cmd["Query"].setdefault("Where", []).append({
        "Condition": {
            "Between": {
                "Expression": {"Column": {"Expression": {"SourceRef": {"Source": "v"}}, "Property": "Fecha"}},
                "LowerBound": {"Literal": {"Value": f"datetime'{y_from}T00:00:00'"}},
                "UpperBound": {"Literal": {"Value": f"datetime'{y_to}T23:59:59'"}}
            }
        }
    })

    data = query_api(payload)
    if has_column_error(data):
        return None, None
    col_names, raw_rows = parse_results(data)
    if not raw_rows:
        return col_names, []

    # Litros_40をキー列でグループ集計
    group_keys = [c for c in col_names if c != "Litros_40"]
    agg = {}
    for row in raw_rows:
        key = tuple(row.get(k) for k in group_keys)
        litros = row.get("Litros_40")
        try:
            litros = float(litros) if litros is not None else 0.0
        except (ValueError, TypeError):
            litros = 0.0
        agg[key] = agg.get(key, 0.0) + litros
    rows = [{**dict(zip(group_keys, k)), "Litros_40": round(v, 4)} for k, v in agg.items()]
    return col_names, rows

def _init_db(con, col_names):
    """テーブルが存在しない場合のみ作成（主キー付き）"""
    col_defs = []
    for c in col_names:
        if c in ("Litros_40",):
            col_defs.append(f'"{c}" REAL')
        elif c in ("Año", "Mes"):
            col_defs.append(f'"{c}" INTEGER')
        else:
            col_defs.append(f'"{c}" TEXT')
    pk = ", ".join(f'"{k}"' for k in DB_KEYS)
    con.execute(f"""
        CREATE TABLE IF NOT EXISTS exports (
            {', '.join(col_defs)},
            PRIMARY KEY ({pk})
        )
    """)
    con.commit()

def upsert_month(year, month, rows, col_names, compare_only=False):
    """指定年月のデータをDBにUPSERT。compare_only=Trueなら差分表示のみ"""
    import sqlite3, os
    os.makedirs("data", exist_ok=True)
    con = sqlite3.connect(DB_PATH)
    _init_db(con, col_names)

    month_prefix = f"{year}-{month:02d}-"
    key_cols = ", ".join('"' + k + '"' for k in DB_KEYS)
    existing = {
        tuple(r[:len(DB_KEYS)]): r[len(DB_KEYS)]  # キー → Litros_40
        for r in con.execute(
            f'SELECT {key_cols}, "Litros_40" FROM exports WHERE Fecha LIKE ?',
            (month_prefix + "%",)
        )
    }

    new_map = {
        tuple(row.get(k) for k in DB_KEYS): row.get("Litros_40", 0.0)
        for row in rows
    }

    added = {k: v for k, v in new_map.items() if k not in existing}
    changed = {k: (existing[k], new_map[k]) for k in new_map if k in existing and existing[k] != new_map[k]}
    removed = {k: v for k, v in existing.items() if k not in new_map}

    print(f"\n{year}/{month:02d} 差分:")
    print(f"  新規: {len(added)} 件")
    print(f"  変更: {len(changed)} 件")
    print(f"  削除: {len(removed)} 件")

    for k, (old, new) in list(changed.items())[:10]:
        print(f"  変更例: {dict(zip(DB_KEYS, k))} {old} → {new}")

    if compare_only:
        con.close()
        return len(changed)

    # UPSERT（INSERT OR REPLACE）
    placeholders = ",".join(["?"] * len(col_names))
    col_list = ", ".join('"' + c + '"' for c in col_names)
    con.executemany(
        f"INSERT OR REPLACE INTO exports ({col_list}) VALUES ({placeholders})",
        [tuple(row.get(c) for c in col_names) for row in rows]
    )
    con.commit()
    size_kb = os.path.getsize(DB_PATH) // 1024
    print(f"DB更新完了: {DB_PATH} ({size_kb} KB)")
    con.close()
    return len(changed)

def fetch_data(country=None, output="stdout", columns=None, year=None, month=None):
    """データ取得。year/month指定時は単月、未指定時は全期間（初回構築用）"""
    import sqlite3, os

    if year and month:
        # 単月取得
        print(f"{year}/{month:02d} 取得中...")
        col_names, rows = _fetch_month(year, month, country, columns)
        if not rows:
            print("データなし")
            return
        print(f"  集計後 {len(rows)} 件")
        if output == "sqlite":
            upsert_month(year, month, rows, col_names)
        elif output == "csv":
            fname = f"crt_export_{year}{month:02d}.csv"
            with open(fname, "w", newline="", encoding="utf-8-sig") as f:
                csv.DictWriter(f, fieldnames=col_names).writeheader()
                csv.DictWriter(f, fieldnames=col_names).writerows(rows)
            print(f"CSV保存: {fname}")
        else:
            for row in rows[:5]:
                print(row)
        return

    # 全期間（初回構築）: 年単位でループ
    cols = columns or CONFIRMED_COLUMNS
    filters = {COUNTRY_COLUMN: country} if country else None
    current_year = datetime.utcnow().year
    all_rows = []
    col_names = None

    for y in range(2003, current_year + 1):
        print(f"  {y} 年取得中...")
        payload = build_query(cols, filters, year_range=(y, y))
        data = query_api(payload)
        if has_column_error(data):
            continue
        names, rows = parse_results(data)
        if rows:
            print(f"    {len(rows)} 件（集計前）")
            if col_names is None:
                col_names = names
            all_rows.extend(rows)

    if not all_rows:
        print("データが取得できませんでした")
        return

    print(f"\n取得件数（集計前）: {len(all_rows)} 件")
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

    if output in ("csv", "sqlite"):
        fname = f"crt_export_{country or 'all'}.csv"
        with open(fname, "w", newline="", encoding="utf-8-sig") as f:
            writer = csv.DictWriter(f, fieldnames=col_names)
            writer.writeheader()
            writer.writerows(rows)
        print(f"CSV保存: {fname}")

    if output == "sqlite":
        os.makedirs("data", exist_ok=True)
        con = sqlite3.connect(DB_PATH)
        _init_db(con, col_names)
        placeholders = ",".join(["?"] * len(col_names))
        col_list = ", ".join('"' + c + '"' for c in col_names)
        con.executemany(
            f"INSERT OR REPLACE INTO exports ({col_list}) VALUES ({placeholders})",
            [tuple(row.get(c) for c in col_names) for row in rows]
        )
        con.commit()
        size_kb = os.path.getsize(DB_PATH) // 1024
        print(f"SQLite保存: {DB_PATH} ({size_kb} KB)")
        con.close()
    elif output == "stdout":
        for row in rows[:5]:
            print(row)
        if len(rows) > 5:
            print(f"... 他 {len(rows)-5} 件")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--discover",     action="store_true")
    parser.add_argument("--dump",         action="store_true")
    parser.add_argument("--country",      help="国名フィルタ（例: JAPON）")
    parser.add_argument("--output",       default="stdout", choices=["stdout", "csv", "sqlite"])
    parser.add_argument("--columns",      nargs="+", default=None)
    parser.add_argument("--year",         type=int, help="取得年（--monthと併用）")
    parser.add_argument("--month",        type=int, help="取得月（--yearと併用）")
    parser.add_argument("--compare-month", type=int, help="比較・更新する月（N ヶ月前）",
                        dest="compare_month")
    parser.add_argument("--probe", action="store_true", help="リソースキー解決のみ実行（デバッグ）")
    args = parser.parse_args()

    if args.probe:
        probe_all()
        sys.exit(0)

    # 実行時に現在の Power BI リソース構成（key/dataset/report/model）を解決（401対策）
    key = resolve_report_config(verbose=True)
    print(f"[resolve] 使用するリソースキー: {key}")

    if args.discover:
        discover_columns()
    elif args.dump:
        dump_response(args.columns)
    else:
        fetch_data(
            country=args.country,
            output=args.output,
            columns=args.columns,
            year=args.year,
            month=args.month,
        )

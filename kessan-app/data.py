"""決算スケジュールアプリ データ取得・キャッシュ層

取得元(すべて環境変数で差し替え可能。テストでは tests/mock-upstream.py を指す):
    KESSAN_JPX_PAGE     JPX「決算発表予定日」ページ(xlsxリンクを拾う)
    KESSAN_JPX_MASTER   JPX上場銘柄一覧 data_j.xls(市場区分・東証33業種の補完)
    KESSAN_TDNET_BASE   yanoshin TDnet API ベースURL
    KESSAN_KABUTAN_BASE 株探 開示一覧URL(TDnet API不通時のフォールバック)
    KESSAN_SKIP_YFINANCE=1 で時価総額取得をスキップ(オフライン動作用)
    KESSAN_DATA_DIR     cache/ downloads/ の親ディレクトリ(既定: このファイルの場所)

xlsxパースはopenpyxlではなく標準ライブラリ(zipfile+ElementTree)で行う。
tools/kessan_helper.py で実運用済みのロジックの流用で、JPXの実ファイル
(sharedStrings/inlineStr混在)での動作実績がある。
"""

from __future__ import annotations

import io
import json
import os
import re
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Callable
from urllib.parse import urljoin
from xml.etree import ElementTree
from zoneinfo import ZoneInfo

import pandas as pd
import requests

JST = ZoneInfo("Asia/Tokyo")
BASE_DIR = Path(__file__).resolve().parent
DATA_ROOT = Path(os.environ.get("KESSAN_DATA_DIR", str(BASE_DIR)))
CACHE_DIR = DATA_ROOT / "cache"
DOWNLOAD_DIR = DATA_ROOT / "downloads"
SCHEDULE_CACHE = CACHE_DIR / "schedule.parquet"
META_PATH = CACHE_DIR / "meta.json"
CACHE_TTL = timedelta(hours=24)

JPX_PAGE = os.environ.get(
    "KESSAN_JPX_PAGE",
    "https://www.jpx.co.jp/listing/event-schedules/financial-announcement/index.html",
)
JPX_MASTER_URL = os.environ.get(
    "KESSAN_JPX_MASTER",
    "https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xls",
)
TDNET_API = os.environ.get("KESSAN_TDNET_BASE", "https://webapi.yanoshin.jp/webapi/tdnet")
KABUTAN_URL = os.environ.get("KESSAN_KABUTAN_BASE", "https://kabutan.jp/disclosures/?code={code}")

UA = "Mozilla/5.0 (compatible; KessanScheduleApp/1.0; personal use)"

SCHEDULE_COLUMNS = ["code", "name", "announce_date", "quarter", "market", "sector", "market_cap"]


def _http_get(url: str, timeout: int = 30) -> requests.Response:
    res = requests.get(url, headers={"User-Agent": UA}, timeout=timeout)
    res.raise_for_status()
    return res


def _decode_html(res: requests.Response) -> str:
    # charset未指定だとrequestsはISO-8859-1にフォールバックし日本語が化けるため、UTF-8を優先する
    if res.encoding and res.encoding.lower() not in ("iso-8859-1", "latin-1"):
        return res.text
    return res.content.decode("utf-8", "replace")


# ---------------------------------------------------------------------------
# JPX「決算発表予定日」xlsx → スケジュールDataFrame
# ---------------------------------------------------------------------------

def _parse_xlsx_rows(data: bytes) -> list[list[str]]:
    """xlsxの1シート目を2次元リストで返す(sharedStrings+inlineStr対応)"""
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            root = ElementTree.fromstring(z.read("xl/sharedStrings.xml"))
            for si in root.findall("m:si", ns):
                shared.append("".join(t.text or "" for t in si.iter(f"{{{ns['m']}}}t")))
        sheet_name = next(n for n in z.namelist() if re.match(r"xl/worksheets/sheet1\.xml$", n))
        root = ElementTree.fromstring(z.read(sheet_name))
        rows = []
        for row in root.iter(f"{{{ns['m']}}}row"):
            cells = []
            for c in row.findall("m:c", ns):
                t = c.get("t")
                v = c.find("m:v", ns)
                if t == "s" and v is not None:
                    cells.append(shared[int(v.text)])
                elif t == "inlineStr":
                    cells.append("".join(x.text or "" for x in c.iter(f"{{{ns['m']}}}t")))
                else:
                    cells.append(v.text if v is not None else "")
            rows.append(cells)
        return rows


def _to_iso_date(v) -> str | None:
    v = str(v).strip()
    if not v:
        return None
    m = re.match(r"(\d{4})[/\-年](\d{1,2})[/\-月](\d{1,2})", v)
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    # Excelシリアル値
    if re.fullmatch(r"\d{4,6}(\.0+)?", v):
        base = date(1899, 12, 30)
        return (base + timedelta(days=int(float(v)))).isoformat()
    return None


HEADER_ALIASES = {
    "date": ["発表予定日", "決算発表予定日", "発表日"],
    "code": ["コード", "銘柄コード", "証券コード"],
    "name": ["会社名", "銘柄名", "銘柄略称"],
    "market": ["市場区分", "市場"],
    "kind": ["種別", "決算種別", "四半期"],
    "sector": ["業種"],
}


def _norm_market(s: str) -> str:
    if "プライム" in s:
        return "プライム"
    if "スタンダード" in s:
        return "スタンダード"
    if "グロース" in s:
        return "グロース"
    return s.strip()


def _kind_to_quarter(kind: str) -> str:
    m = re.search(r"第([1-3])", kind)
    if m:
        return f"{m.group(1)}Q"
    if re.search(r"本決算|通期|期末", kind):
        return "本"
    return ""


def fetch_schedule() -> pd.DataFrame:
    """JPX決算発表予定日Excelをダウンロード→パースしてDataFrame化。
    market_cap列はこの時点ではNaN。sector/marketはdata_j.xlsで補完(失敗時はスキップ)"""
    html = _decode_html(_http_get(JPX_PAGE))
    links = re.findall(r'href="([^"]+\.xlsx)"', html)
    if not links:
        raise RuntimeError("JPXページにxlsxリンクが見つかりません")
    records = []
    for link in links[:6]:
        url = urljoin(JPX_PAGE, link)
        rows = _parse_xlsx_rows(_http_get(url).content)
        header_idx, colmap = None, {}
        for i, row in enumerate(rows[:20]):
            joined = "".join(str(c) for c in row)
            if any(a in joined for a in HEADER_ALIASES["code"]) and any(
                a in joined for a in HEADER_ALIASES["date"]
            ):
                header_idx = i
                for j, cell in enumerate(row):
                    for key, aliases in HEADER_ALIASES.items():
                        if key not in colmap and any(a in str(cell) for a in aliases):
                            colmap[key] = j
                break
        if header_idx is None:
            continue
        for row in rows[header_idx + 1:]:
            def col(key):
                j = colmap.get(key)
                return str(row[j]).strip() if j is not None and j < len(row) else ""

            code = re.sub(r"\D", "", col("code"))[:4]
            d = _to_iso_date(col("date"))
            if not re.fullmatch(r"\d{4}", code) or not d:
                continue
            records.append(
                {
                    "code": code,
                    "name": col("name") or code,
                    "announce_date": d,
                    "quarter": _kind_to_quarter(col("kind")),
                    "market": _norm_market(col("market")),
                    "sector": col("sector"),
                }
            )
    df = pd.DataFrame(records, columns=SCHEDULE_COLUMNS[:6])
    if df.empty:
        raise RuntimeError("JPX Excelから予定を1件も読み取れませんでした(フォーマット変更の可能性)")
    df["announce_date"] = pd.to_datetime(df["announce_date"])
    df = df.drop_duplicates(subset=["code", "announce_date"]).reset_index(drop=True)
    df["market_cap"] = float("nan")
    return _merge_master(df)


def _merge_master(df: pd.DataFrame) -> pd.DataFrame:
    """JPX上場銘柄一覧(data_j.xls)から市場区分・東証33業種を補完。失敗しても続行"""
    try:
        raw = _http_get(JPX_MASTER_URL, timeout=60).content
        master = pd.read_excel(io.BytesIO(raw), dtype=str)
    except Exception:
        return df
    cols = {c: str(c) for c in master.columns}
    code_col = next((c for c in cols if "コード" in str(c)), None)
    sector_col = next((c for c in cols if "33業種区分" in str(c)), None)
    market_col = next((c for c in cols if "市場" in str(c)), None)
    if code_col is None:
        return df
    master = master.assign(
        code=master[code_col].map(lambda v: re.sub(r"\D", "", str(v))[:4]),
        _sector=master[sector_col].fillna("") if sector_col else "",
        _market=master[market_col].fillna("").map(_norm_market) if market_col else "",
    ).drop_duplicates(subset=["code"])
    lookup = master.set_index("code")[["_sector", "_market"]]
    df = df.join(lookup, on="code")
    df["sector"] = df["sector"].where(df["sector"] != "", df["_sector"].fillna(""))
    df["market"] = df["market"].where(df["market"] != "", df["_market"].fillna(""))
    return df.drop(columns=["_sector", "_market"])


# ---------------------------------------------------------------------------
# yfinance 時価総額
# ---------------------------------------------------------------------------

def enrich_market_caps(df: pd.DataFrame) -> pd.DataFrame:
    """yfinanceで {code}.T の時価総額を並列取得しマージ。失敗銘柄はNaNのまま続行"""
    if df.empty or os.environ.get("KESSAN_SKIP_YFINANCE"):
        return df
    try:
        import yfinance as yf
    except ImportError:
        return df

    def one(code: str) -> tuple[str, float | None]:
        try:
            v = yf.Ticker(f"{code}.T").fast_info["market_cap"]
            return code, float(v) if v else None
        except Exception:
            return code, None

    codes = df["code"].unique().tolist()
    with ThreadPoolExecutor(max_workers=8) as ex:
        caps = dict(ex.map(one, codes))
    df = df.copy()
    df["market_cap"] = pd.to_numeric(df["code"].map(caps), errors="coerce")
    return df


# ---------------------------------------------------------------------------
# キャッシュ
# ---------------------------------------------------------------------------

def _read_meta() -> dict:
    try:
        return json.loads(META_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def load_cached_schedule() -> tuple[pd.DataFrame, datetime] | None:
    """キャッシュがあればTTLに関係なく返す(取得失敗時のフォールバック用)"""
    if not SCHEDULE_CACHE.exists():
        return None
    fetched_at_s = _read_meta().get("schedule_fetched_at")
    if not fetched_at_s:
        return None
    try:
        df = pd.read_parquet(SCHEDULE_CACHE)
        return df, datetime.fromisoformat(fetched_at_s)
    except Exception:
        return None


def load_or_fetch_schedule(force: bool = False) -> tuple[pd.DataFrame, datetime]:
    """cache/schedule.parquetがあり24h以内ならそれを返す。
    force=True または期限切れなら fetch→enrich→保存。戻り値: (df, 取得日時)"""
    if not force:
        cached = load_cached_schedule()
        if cached is not None and datetime.now(JST) - cached[1] < CACHE_TTL:
            return cached
    df = enrich_market_caps(fetch_schedule())
    # meta.jsonへの保存はisoformat(秒精度)なので、往復で値が変わらないよう丸めておく
    fetched_at = datetime.now(JST).replace(microsecond=0)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    df.to_parquet(SCHEDULE_CACHE, index=False)
    meta = _read_meta()
    meta["schedule_fetched_at"] = fetched_at.isoformat(timespec="seconds")
    META_PATH.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return df, fetched_at


# ---------------------------------------------------------------------------
# 短信PDF取得
# ---------------------------------------------------------------------------

PDF_LINK_RE = re.compile(
    r'<a[^>]+href="(?P<url>[^"]+\.pdf[^"]*)"[^>]*>(?P<label>[^<]{0,200})</a>', re.I
)


def _tanshin_from_tdnet_api(code: str, since: date | None) -> dict | None:
    url = f"{TDNET_API}/list/{code}.json?limit=30"
    data = _http_get(url, timeout=15).json()
    candidates = []
    for item in data.get("items", []):
        t = item.get("Tdnet", item)
        title = str(t.get("title", ""))
        if "決算短信" not in title or "訂正" in title:
            continue
        pub = _to_iso_date(str(t.get("pubdate", ""))[:10])
        if since and pub and date.fromisoformat(pub) < since:
            continue
        pdf_url = t.get("document_url") or t.get("url")
        if pdf_url:
            candidates.append({"title": title, "pdf_url": pdf_url, "pubdate": pub})
    if not candidates:
        return None
    candidates.sort(key=lambda c: c["pubdate"] or "", reverse=True)
    return candidates[0]


def _tanshin_from_kabutan(code: str, since: date | None) -> dict | None:
    url = KABUTAN_URL.format(code=code)
    html = _decode_html(_http_get(url))
    for m in PDF_LINK_RE.finditer(html):
        label = re.sub(r"\s+", " ", m.group("label")).strip()
        if "決算短信" not in label or "訂正" in label:
            continue
        # リンク周辺から開示日を拾い、since より古い短信(前期分)を弾く
        ctx = html[max(0, m.start() - 300): m.end() + 100]
        dm = re.search(r"(\d{4})[/\-年](\d{1,2})[/\-月](\d{1,2})", ctx)
        pub = f"{dm.group(1)}-{int(dm.group(2)):02d}-{int(dm.group(3)):02d}" if dm else None
        if since and pub and date.fromisoformat(pub) < since:
            continue
        return {"title": label, "pdf_url": urljoin(url, m.group("url")), "pubdate": pub}
    return None


def fetch_tanshin_url(code: str, since: date | None = None) -> dict | None:
    """当該銘柄の直近開示から決算短信(訂正を除く)の最新1件を返す。

    yanoshin TDnet API → 不通時は株探の開示一覧にフォールバック。
    since を渡すと、それより前に開示された短信(=前期分)を除外する。
    戻り値: {"title", "pdf_url", "pubdate"} / 見つからなければ None(未発表)
    両系統とも通信に失敗した場合は例外を送出する。
    """
    try:
        return _tanshin_from_tdnet_api(code, since)
    except Exception:
        return _tanshin_from_kabutan(code, since)


def _sanitize_filename(s: str) -> str:
    return re.sub(r'[\\/:*?"<>|\s]+', "", s)[:40]


def download_tanshin_batch(
    rows: list[dict],
    out_dir: Path,
    progress_cb: Callable[[int, str], None] = lambda i, msg: None,
) -> list[dict]:
    """チェック銘柄を順次処理し、PDF保存とmanifest.json書き出しを行う。

    rows: [{"code", "name", "quarter", "announce_date"(ISO文字列またはdate)}]
    1件ごとに time.sleep(1.0)(サーバー負荷配慮)。例外は握って status="error" で続行。
    同日のmanifest.jsonが既にあれば、今回対象外の銘柄のitemは残してマージする。
    """
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    items = []
    for i, row in enumerate(rows):
        code, name = str(row["code"]), str(row.get("name", ""))
        quarter = str(row.get("quarter", "")) or "短信"
        announce = row.get("announce_date")
        if isinstance(announce, str) and announce:
            announce = date.fromisoformat(announce[:10])
        elif isinstance(announce, datetime):
            announce = announce.date()
        since = announce - timedelta(days=3) if isinstance(announce, date) else None
        progress_cb(i, f"{code} {name} の決算短信を検索中…")
        item = {
            "code": code,
            "name": name,
            "quarter": str(row.get("quarter", "")),
            "announce_date": announce.isoformat() if isinstance(announce, date) else None,
            "pdf_path": None,
            "tdnet_title": None,
            "downloaded_at": None,
            "status": "error",
            "error": None,
        }
        try:
            found = fetch_tanshin_url(code, since=since)
            if found is None:
                item["status"] = "not_published"
            else:
                res = _http_get(found["pdf_url"], timeout=60)
                body = res.content
                ctype = res.headers.get("Content-Type", "")
                if b"%PDF" not in body[:1024] and "pdf" not in ctype.lower():
                    raise RuntimeError(f"PDFではないレスポンス(Content-Type: {ctype})")
                fname = f"{code}_{_sanitize_filename(name) or code}_{_sanitize_filename(quarter)}.pdf"
                (out_dir / fname).write_bytes(body)
                item.update(
                    pdf_path=fname,
                    tdnet_title=found["title"],
                    downloaded_at=datetime.now(JST).isoformat(timespec="seconds"),
                    status="success",
                )
        except Exception as e:  # noqa: BLE001 - 個別失敗はスキップして続行
            item["status"] = "error"
            item["error"] = str(e)
        items.append(item)
        if i < len(rows) - 1:
            time.sleep(1.0)
    _write_manifest(out_dir, items)
    progress_cb(len(rows), "完了")
    return items


def _write_manifest(out_dir: Path, new_items: list[dict]) -> None:
    manifest_path = out_dir / "manifest.json"
    old_items = []
    if manifest_path.exists():
        try:
            old_items = json.loads(manifest_path.read_text(encoding="utf-8")).get("items", [])
        except Exception:
            old_items = []
    new_codes = {it["code"] for it in new_items}
    merged = [it for it in old_items if it.get("code") not in new_codes] + new_items
    manifest = {
        "created_at": datetime.now(JST).isoformat(timespec="seconds"),
        "items": merged,
    }
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )

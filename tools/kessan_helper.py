#!/usr/bin/env python3
"""Kessan Board ローカルヘルパー

静的Webアプリ(Kessan Board)はブラウザのCORS制約により、TDnet・株探(kabutan)等から
PDFやスケジュールを直接取得できない。このヘルパーをPCで起動しておくと、
アプリが localhost 経由で以下を行えるようになる。

    python3 tools/kessan_helper.py          # http://localhost:8787 で起動

エンドポイント(すべて Access-Control-Allow-Origin: * 付きで応答):
    GET /status                     稼働確認
    GET /schedule                   決算スケジュール(過去=TDnet API / 未来=JPX発表予定xlsx)
    GET /kabutan?code=7203          株探の開示ページからPDFリンク一覧を取得
    GET /pdf?url=https://...pdf     PDFを代理取得して返す(CORS回避)

依存: Python 3.9+ 標準ライブラリのみ。
外部サイトのHTML構造変更で /schedule /kabutan が壊れた場合は、
下の URL・正規表現を調整する(いずれもbest-effort。PDFの手動アップロードは常に可能)。
"""

import io
import json
import os
import re
import sys
import urllib.parse
import urllib.request
import zipfile
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from xml.etree import ElementTree

PORT = int(os.environ.get("KESSAN_HELPER_PORT", "8787"))

# 取得元(環境変数で差し替え可能。テストではモックサーバーを指す)
TDNET_API = os.environ.get("KESSAN_TDNET_BASE", "https://webapi.yanoshin.jp/webapi/tdnet")
JPX_PAGE = os.environ.get(
    "KESSAN_JPX_PAGE",
    "https://www.jpx.co.jp/listing/event-schedules/financial-announcement/index.html",
)
KABUTAN_URL = os.environ.get("KESSAN_KABUTAN_BASE", "https://kabutan.jp/disclosures/?code={code}")

UA = "Mozilla/5.0 (compatible; KessanBoardHelper/1.0; personal use)"


def http_get(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read(), res.headers.get("Content-Type", "")


# ---------------------------------------------------------------------------
# 過去分: TDnet API(yanoshin互換)から決算短信・説明資料の開示一覧
# ---------------------------------------------------------------------------

TITLE_PERIOD_RE = re.compile(r"(\d{4})年(\d{1,2})月期(?:.{0,6}?第([1-3])四半期)?")


def tdnet_past(days=7):
    today = date.today()
    frm = (today - timedelta(days=days)).strftime("%Y%m%d")
    to = today.strftime("%Y%m%d")
    url = f"{TDNET_API}/list/{frm}-{to}.json?limit=500"
    body, _ = http_get(url)
    data = json.loads(body)
    rows = {}
    for item in data.get("items", []):
        t = item.get("Tdnet", item)
        title = t.get("title", "")
        is_tanshin = "決算短信" in title
        is_setsumei = bool(re.search(r"決算説明|決算補足", title))
        if not (is_tanshin or is_setsumei):
            continue
        code = str(t.get("company_code", ""))
        code = re.sub(r"0$", "", code)[:4]
        if not re.fullmatch(r"\d{4}", code):
            continue
        pub = str(t.get("pubdate", ""))[:10]
        if not pub:
            continue
        m = TITLE_PERIOD_RE.search(title)
        fy = int(m.group(1)) if m else None
        q = (int(m.group(3)) if m.group(3) else 4) if m else None
        key = f"{code}_{pub}"
        row = rows.setdefault(
            key,
            {
                "date": pub,
                "code": code,
                "name": t.get("company_name", code),
                "market": "",
                "sector": "",
                "marketCap": None,
                "fiscalYear": fy,
                "quarter": q,
                "announced": True,
                "tanshinUrl": None,
                "setsumeiUrl": None,
            },
        )
        doc_url = t.get("document_url") or t.get("url")
        if is_tanshin and doc_url:
            row["tanshinUrl"] = doc_url
            row["fiscalYear"] = row["fiscalYear"] or fy
            row["quarter"] = row["quarter"] or q
        if is_setsumei and doc_url:
            row["setsumeiUrl"] = doc_url
    return list(rows.values())


# ---------------------------------------------------------------------------
# 未来分: JPX「決算発表予定日」xlsx
# ---------------------------------------------------------------------------

def parse_xlsx_rows(data):
    """xlsxを標準ライブラリで読む(sharedStrings+inlineStr対応、1シート目)"""
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


def to_iso_date(v):
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
    "fiscalEnd": ["決算期末", "決算期", "期末"],
    "kind": ["種別", "決算種別", "四半期"],
    "sector": ["業種"],
}


def jpx_future():
    page, _ = http_get(JPX_PAGE)
    html = page.decode("utf-8", "replace")
    links = re.findall(r'href="([^"]+\.xlsx)"', html)
    if not links:
        raise RuntimeError("JPXページにxlsxリンクが見つかりません")
    out = []
    base = JPX_PAGE
    for link in links[:4]:
        url = urllib.parse.urljoin(base, link)
        data, _ = http_get(url)
        rows = parse_xlsx_rows(data)
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
            d = to_iso_date(col("date"))
            if not re.fullmatch(r"\d{4}", code) or not d:
                continue
            kind = col("kind")
            q = None
            m = re.search(r"第([1-3])", kind)
            if m:
                q = int(m.group(1))
            elif re.search(r"本決算|通期|期末", kind):
                q = 4
            fy = None
            m = re.search(r"(\d{4})", col("fiscalEnd"))
            if m:
                fy = int(m.group(1))
            out.append(
                {
                    "date": d,
                    "code": code,
                    "name": col("name") or code,
                    "market": col("market"),
                    "sector": col("sector"),
                    "marketCap": None,
                    "fiscalYear": fy,
                    "quarter": q,
                    "announced": False,
                    "tanshinUrl": None,
                    "setsumeiUrl": None,
                }
            )
    return out


# ---------------------------------------------------------------------------
# 株探: 銘柄の開示ページからPDFリンク一覧
# ---------------------------------------------------------------------------

PDF_LINK_RE = re.compile(
    r'<a[^>]+href="(?P<url>[^"]+\.pdf[^"]*)"[^>]*>(?P<label>[^<]{0,200})</a>', re.I
)


def kabutan_pdfs(code):
    url = KABUTAN_URL.format(code=code)
    page, _ = http_get(url)
    html = page.decode("utf-8", "replace")
    pdfs = []
    seen = set()
    for m in PDF_LINK_RE.finditer(html):
        href = urllib.parse.urljoin(url, m.group("url"))
        if href in seen:
            continue
        seen.add(href)
        label = re.sub(r"\s+", " ", m.group("label")).strip()
        # リンク周辺から日付を拾う(YYYY/MM/DD or YYYY-MM-DD or YYYY年M月D日)
        ctx = html[max(0, m.start() - 300): m.end() + 100]
        dm = re.search(r"(\d{4})[/\-年](\d{1,2})[/\-月](\d{1,2})", ctx)
        d = f"{dm.group(1)}-{int(dm.group(2)):02d}-{int(dm.group(3)):02d}" if dm else None
        if re.search(r"説明|補足", label):
            kind = "setsumei"
        elif "短信" in label:
            kind = "tanshin"
        else:
            kind = "other"
        pdfs.append({"title": label or href.rsplit("/", 1)[-1], "url": href, "date": d, "kind": kind})
        if len(pdfs) >= 40:
            break
    return pdfs


# ---------------------------------------------------------------------------
# HTTPサーバー
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("[helper] %s\n" % (fmt % args))

    def send_cors(self, status, ctype):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_cors(status, "application/json; charset=utf-8")
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_cors(204, "text/plain")

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        try:
            if parsed.path == "/status":
                self.send_json({"ok": True, "service": "kessan-helper", "version": 1})
            elif parsed.path == "/schedule":
                past, future, errors = [], [], []
                try:
                    past = tdnet_past(int(qs.get("days_past", ["7"])[0]))
                except Exception as e:  # noqa: BLE001 - 片系の失敗でも他方は返す
                    errors.append(f"tdnet: {e}")
                try:
                    future = jpx_future()
                except Exception as e:  # noqa: BLE001
                    errors.append(f"jpx: {e}")
                self.send_json({"past": past, "future": future, "errors": errors})
            elif parsed.path == "/kabutan":
                code = qs.get("code", [""])[0]
                if not re.fullmatch(r"\d{4}[0-9A-Z]?", code):
                    self.send_json({"error": "codeパラメータが不正です"}, 400)
                    return
                self.send_json({"code": code, "pdfs": kabutan_pdfs(code)})
            elif parsed.path == "/pdf":
                url = qs.get("url", [""])[0]
                if not re.match(r"^https?://", url):
                    self.send_json({"error": "urlパラメータが不正です"}, 400)
                    return
                data, ctype = http_get(url, timeout=60)
                if b"%PDF" not in data[:1024]:
                    self.send_json({"error": f"PDFではありません({ctype})"}, 502)
                    return
                self.send_cors(200, "application/pdf")
                self.wfile.write(data)
            else:
                self.send_json({"error": "not found"}, 404)
        except Exception as e:  # noqa: BLE001
            try:
                self.send_json({"error": str(e)}, 502)
            except Exception:  # noqa: BLE001 - クライアント切断等
                pass


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Kessan Board ヘルパー起動: http://localhost:{PORT}")
    print("アプリの設定画面でこのURLが「ローカルヘルパー」に設定されていることを確認してください。")
    print("停止: Ctrl+C")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

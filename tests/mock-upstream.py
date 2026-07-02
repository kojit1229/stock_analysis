#!/usr/bin/env python3
"""E2Eテスト用の外部サイトモック(TDnet API / JPXページ+xlsx / 株探 / PDFホスト)

kessan_helper.py を以下の環境変数で起動すると、このモックを取得元として使う:
    KESSAN_TDNET_BASE=http://localhost:8788/webapi/tdnet \
    KESSAN_JPX_PAGE=http://localhost:8788/jpx/index.html \
    KESSAN_KABUTAN_BASE="http://localhost:8788/kabutan/disclosures/?code={code}" \
    python3 tools/kessan_helper.py

/nocors/ 配下のPDFはCORSヘッダなしで応答する(ブラウザ直接fetchの失敗を再現)。
"""

import io
import json
import os
import sys
import zipfile
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

PORT = int(os.environ.get("MOCK_PORT", "8788"))
FIXTURE = os.path.join(os.path.dirname(__file__), "fixture-tanshin.pdf")
FIXTURE_SETSUMEI = os.path.join(os.path.dirname(__file__), "fixture-setsumei.pdf")


def make_xlsx():
    """JPX決算発表予定を模したxlsx(sharedStrings使用)"""
    future = (date.today() + timedelta(days=14)).strftime("%Y/%m/%d")
    header = ["発表予定日", "コード", "会社名", "市場区分", "業種", "決算期末", "種別"]
    row = [future, "7777", "モック精密", "プライム", "精密機器", "2027年3月", "第1四半期"]
    strings = []

    def sref(s):
        if s not in strings:
            strings.append(s)
        return strings.index(s)

    def row_xml(r, idx):
        cells = "".join(
            f'<c r="{chr(65+j)}{idx}" t="s"><v>{sref(v)}</v></c>' for j, v in enumerate(r)
        )
        return f'<row r="{idx}">{cells}</row>'

    rows_xml = row_xml(header, 1) + row_xml(row, 2)
    sheet = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f"<sheetData>{rows_xml}</sheetData></worksheet>"
    )
    sst = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        + "".join(f"<si><t>{s}</t></si>" for s in strings)
        + "</sst>"
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="xml" ContentType="application/xml"/></Types>',
        )
        z.writestr("xl/worksheets/sheet1.xml", sheet)
        z.writestr("xl/sharedStrings.xml", sst)
    return buf.getvalue()


XLSX = make_xlsx()
PDF = open(FIXTURE, "rb").read()
PDF_SETSUMEI = open(FIXTURE_SETSUMEI, "rb").read()
YESTERDAY = (date.today() - timedelta(days=1)).isoformat()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("[mock] %s\n" % (fmt % args))

    def reply(self, body, ctype, cors=True):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        if cors:
            self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path.startswith("/webapi/tdnet/list/"):
            items = [
                {
                    "Tdnet": {
                        "company_code": "65010",
                        "company_name": "テスト電機",
                        "pubdate": f"{YESTERDAY} 15:00:00",
                        "title": "2027年3月期 第1四半期決算短信〔日本基準〕(連結)",
                        "document_url": f"http://localhost:{PORT}/nocors/6501_tanshin.pdf",
                    }
                },
                {
                    "Tdnet": {
                        "company_code": "65010",
                        "company_name": "テスト電機",
                        "pubdate": f"{YESTERDAY} 15:05:00",
                        "title": "2027年3月期 第1四半期 決算説明資料",
                        "document_url": f"http://localhost:{PORT}/nocors/6501_setsumei.pdf",
                    }
                },
            ]
            self.reply(json.dumps({"items": items}).encode(), "application/json")
        elif path == "/jpx/index.html":
            self.reply(
                '<html><body><a href="data/schedule1.xlsx">3月期第1四半期</a></body></html>'.encode(),
                "text/html",
            )
        elif path == "/jpx/data/schedule1.xlsx":
            self.reply(XLSX, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        elif path == "/kabutan/disclosures/":
            html = f"""<html><body><table>
              <tr><td>2026/07/01</td><td><a href="http://localhost:{PORT}/nocors/6501_tanshin.pdf">
                2027年3月期 第1四半期決算短信〔日本基準〕(連結)</a></td></tr>
              <tr><td>2026/07/01</td><td><a href="/nocors/6501_setsumei.pdf">決算説明資料</a></td></tr>
            </table></body></html>"""
            self.reply(html.encode(), "text/html")
        elif path.startswith("/nocors/") and path.endswith(".pdf"):
            # CORSヘッダなし → ブラウザからの直接fetchは失敗し、ヘルパー経由のみ成功する
            body = PDF_SETSUMEI if "setsumei" in path else PDF
            self.reply(body, "application/pdf", cors=False)
        else:
            self.send_response(404)
            self.end_headers()


if __name__ == "__main__":
    print(f"mock upstream: http://localhost:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()

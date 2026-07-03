"""data.py / app.py の動作確認(外部サイト不要、tests/mock-upstream.py を使用)

実行: cd kessan-app && python -m pytest test_data.py -v
"""

import importlib
import json
import os
import subprocess
import sys
import time
from datetime import date, timedelta
from pathlib import Path

import pytest
import requests

APP_DIR = Path(__file__).resolve().parent
REPO = APP_DIR.parent
MOCK = REPO / "tests" / "mock-upstream.py"
MOCK_PORT = os.environ.get("MOCK_PORT", "8788")
MOCK_BASE = f"http://localhost:{MOCK_PORT}"


@pytest.fixture(scope="session")
def mock_server():
    proc = subprocess.Popen(
        [sys.executable, str(MOCK)],
        env={**os.environ, "MOCK_PORT": MOCK_PORT},
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        for _ in range(50):
            try:
                requests.get(f"{MOCK_BASE}/jpx/index.html", timeout=1)
                break
            except Exception:
                time.sleep(0.2)
        else:
            raise RuntimeError("mock-upstream が起動しません")
        yield MOCK_BASE
    finally:
        proc.terminate()
        proc.wait(timeout=5)


@pytest.fixture()
def data_mod(mock_server, tmp_path, monkeypatch):
    """モックを向いたdataモジュール(キャッシュはtmp_path配下)"""
    monkeypatch.setenv("NO_PROXY", "localhost,127.0.0.1")
    monkeypatch.setenv("no_proxy", "localhost,127.0.0.1")
    monkeypatch.setenv("KESSAN_TDNET_BASE", f"{mock_server}/webapi/tdnet")
    monkeypatch.setenv("KESSAN_JPX_PAGE", f"{mock_server}/jpx/index.html")
    monkeypatch.setenv("KESSAN_JPX_MASTER", f"{mock_server}/nonexistent.xls")
    monkeypatch.setenv("KESSAN_KABUTAN_BASE", mock_server + "/kabutan/disclosures/?code={code}")
    monkeypatch.setenv("KESSAN_SKIP_YFINANCE", "1")
    monkeypatch.setenv("KESSAN_DATA_DIR", str(tmp_path))
    sys.path.insert(0, str(APP_DIR))
    import data
    importlib.reload(data)
    yield data


def test_fetch_schedule(data_mod):
    df = data_mod.fetch_schedule()
    assert list(df.columns) == data_mod.SCHEDULE_COLUMNS
    row = df[df["code"] == "7777"].iloc[0]
    assert row["name"] == "モック精密"
    assert row["quarter"] == "1Q"
    assert row["market"] == "プライム"
    assert row["sector"] == "精密機器"
    assert row.announce_date.date() == date.today() + timedelta(days=14)


def test_schedule_cache_roundtrip(data_mod, monkeypatch):
    df1, ts1 = data_mod.load_or_fetch_schedule()
    assert data_mod.SCHEDULE_CACHE.exists()
    # 取得元を壊しても24h以内はキャッシュから返る
    monkeypatch.setattr(data_mod, "JPX_PAGE", f"{MOCK_BASE}/broken.html")
    df2, ts2 = data_mod.load_or_fetch_schedule()
    assert ts2 == ts1
    assert df2["code"].tolist() == df1["code"].tolist()
    # force=True は再取得を試み、失敗すれば例外(アプリ側でキャッシュへフォールバック)
    with pytest.raises(Exception):
        data_mod.load_or_fetch_schedule(force=True)
    cached = data_mod.load_cached_schedule()
    assert cached is not None and cached[1] == ts1


def test_fetch_tanshin_url(data_mod):
    found = data_mod.fetch_tanshin_url("6501")
    assert found is not None
    assert "決算短信" in found["title"]
    assert found["pdf_url"].endswith("6501_tanshin.pdf")
    assert found["pubdate"] == (date.today() - timedelta(days=1)).isoformat()


def test_fetch_tanshin_url_since_filters_old(data_mod):
    # モックの開示は昨日付 → sinceが今日なら「未発表」扱い(前期短信の誤取得防止)
    assert data_mod.fetch_tanshin_url("6501", since=date.today()) is None


def test_kabutan_fallback(data_mod, monkeypatch):
    monkeypatch.setattr(data_mod, "TDNET_API", f"{MOCK_BASE}/bad-api")
    found = data_mod.fetch_tanshin_url("6501")
    assert found is not None
    assert "決算短信" in found["title"]
    assert found["pdf_url"].endswith("6501_tanshin.pdf")


def test_download_tanshin_batch(data_mod, tmp_path, monkeypatch):
    monkeypatch.setattr(data_mod.time, "sleep", lambda s: None)
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    future = (date.today() + timedelta(days=10)).isoformat()
    rows = [
        {"code": "6501", "name": "テスト電機", "quarter": "1Q", "announce_date": yesterday},
        {"code": "9999", "name": "未来商事", "quarter": "2Q", "announce_date": future},
    ]
    out_dir = tmp_path / "downloads" / date.today().isoformat()
    progress = []
    items = data_mod.download_tanshin_batch(rows, out_dir, lambda i, msg: progress.append(i))
    by_code = {it["code"]: it for it in items}
    assert by_code["6501"]["status"] == "success"
    assert by_code["6501"]["pdf_path"] == "6501_テスト電機_1Q.pdf"
    pdf = (out_dir / "6501_テスト電機_1Q.pdf").read_bytes()
    assert pdf.startswith(b"%PDF")
    # 発表予定日が未来 → モックの昨日付短信はsinceで弾かれ「未発表」
    assert by_code["9999"]["status"] == "not_published"
    assert by_code["9999"]["pdf_path"] is None
    assert progress[-1] == len(rows)

    manifest = json.loads((out_dir / "manifest.json").read_text(encoding="utf-8"))
    assert {it["code"] for it in manifest["items"]} == {"6501", "9999"}
    assert manifest["items"][0]["announce_date"] == yesterday

    # 同日2回目の実行は銘柄単位でマージされる(既存itemを消さない)
    items2 = data_mod.download_tanshin_batch(
        [{"code": "9999", "name": "未来商事", "quarter": "2Q", "announce_date": yesterday}],
        out_dir,
    )
    assert items2[0]["status"] == "success"
    manifest = json.loads((out_dir / "manifest.json").read_text(encoding="utf-8"))
    by_code = {it["code"]: it for it in manifest["items"]}
    assert by_code["6501"]["status"] == "success"
    assert by_code["9999"]["status"] == "success"


def test_download_batch_error_does_not_stop(data_mod, tmp_path, monkeypatch):
    monkeypatch.setattr(data_mod.time, "sleep", lambda s: None)
    calls = {"n": 0}
    orig = data_mod.fetch_tanshin_url

    def flaky(code, since=None):
        calls["n"] += 1
        if code == "1111":
            raise RuntimeError("boom")
        return orig(code, since=since)

    monkeypatch.setattr(data_mod, "fetch_tanshin_url", flaky)
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    rows = [
        {"code": "1111", "name": "壊れる", "quarter": "1Q", "announce_date": yesterday},
        {"code": "6501", "name": "テスト電機", "quarter": "1Q", "announce_date": yesterday},
    ]
    items = data_mod.download_tanshin_batch(rows, tmp_path / "dl")
    assert items[0]["status"] == "error" and "boom" in items[0]["error"]
    assert items[1]["status"] == "success"
    assert calls["n"] == 2


def test_app_smoke(data_mod):
    from streamlit.testing.v1 import AppTest

    data_mod.load_or_fetch_schedule()  # キャッシュを温めてapp側はオフラインで読む
    at = AppTest.from_file(str(APP_DIR / "app.py"), default_timeout=60)
    at.run()
    assert not at.exception
    # 既定の「今週」ではモック銘柄(today+14)は表示されない
    assert any("一致する銘柄がありません" in str(el.value) for el in at.info)
    # 任意期間(既定 today〜today+14)に切り替えるとテーブルが出る
    at.sidebar.selectbox[0].select("任意期間").run()
    assert not at.exception
    assert not at.info

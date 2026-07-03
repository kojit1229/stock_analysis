# 決算スケジュール確認・短信PDF一括取得アプリ

決算発表スケジュールを確認し、注目銘柄の決算短信PDFをTDnetから一括取得する
ローカル専用Streamlitアプリ。取得したPDFとmanifest.jsonはStep2(短信分析ダッシュボード)への入力になる。

要件定義・設計書はチャット共有のv1に基づく(`Docs/` 配下の資料はStep2側のもの)。

## 起動

```sh
cd kessan-app
pip install -r requirements.txt
streamlit run app.py
```

## 機能

- **スケジュール一覧**: JPX「決算発表予定日」xlsxから取得。銘柄コード / 社名 / 発表予定日 / 決算期 / 時価総額 / 市場区分 / 業種
- **フィルタ**: 期間(今日/今週/来週/任意)、時価総額(プリセット+任意、不明銘柄の表示トグルあり)、市場区分、東証33業種、コード・社名検索
- **PDF一括取得**: チェックした銘柄の最新決算短信PDFをyanoshin TDnet APIから取得
  (API不通時は株探の開示一覧にフォールバック)。1件ごとに1秒ウェイト
- **Step2連携**: `downloads/{取得日}/manifest.json` を出力。同日内の再実行は銘柄単位でマージ

## データの流れとキャッシュ

| データ | 保存先 | TTL |
|---|---|---|
| スケジュール+時価総額(yfinance)+市場・業種(JPX data_j.xls) | `cache/schedule.parquet` | 24h(サイドバー「データ更新」で強制再取得) |
| 短信PDF + manifest.json | `downloads/{YYYY-MM-DD}/` | 永続 |

- 取得失敗時は古いキャッシュを警告付きで表示(キャッシュもなければエラー停止)
- yfinance失敗銘柄の時価総額は「—」表示になり、フィルタで除外するかはトグルで選べる

## manifest.json 仕様(Step2向け)

```json
{
  "created_at": "2026-07-03T09:30:00+09:00",
  "items": [
    {
      "code": "6146",
      "name": "ディスコ",
      "quarter": "1Q",
      "announce_date": "2026-07-09",
      "pdf_path": "6146_ディスコ_1Q.pdf",
      "tdnet_title": "2027年3月期 第1四半期決算短信〔IFRS〕(連結)",
      "downloaded_at": "2026-07-03T09:30:12+09:00",
      "status": "success",
      "error": null
    }
  ]
}
```

- `status`: `success` / `not_published`(未発表)/ `error`
- `pdf_path` はmanifest.jsonからの相対パス。`not_published` / `error` 時は `null`

## 設計書からの変更点

- **xlsxパース**: openpyxlではなく標準ライブラリ(`tools/kessan_helper.py` で実運用済みのパーサを流用)。
  JPX実ファイルのsharedStrings/inlineStr混在に対応済みのため
- **フォールバック**: TDnet公式検索のスクレイピングではなく、同じくヘルパーで実績のある株探開示一覧を使用
  (beautifulsoup4/lxml不要になった)
- **業種・市場区分の補完**: JPX上場銘柄一覧 `data_j.xls` を使用(東証33業種はyfinanceでは取れないため)
- 前期短信の誤取得防止のため、発表予定日-3日より前に開示された短信は「未発表」扱いにする

## テスト

外部サイトに接続せず、リポジトリ既存のモック(`tests/mock-upstream.py`)で動作確認できる:

```sh
pip install pytest
cd kessan-app && python -m pytest test_data.py -v
```

## 環境変数(通常は設定不要)

| 変数 | 用途 |
|---|---|
| `KESSAN_JPX_PAGE` / `KESSAN_JPX_MASTER` / `KESSAN_TDNET_BASE` / `KESSAN_KABUTAN_BASE` | 取得元URLの差し替え(テスト用) |
| `KESSAN_SKIP_YFINANCE=1` | 時価総額取得をスキップ(オフライン・高速確認用) |
| `KESSAN_DATA_DIR` | `cache/` `downloads/` の親ディレクトリ |

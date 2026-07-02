# E2Eテスト

Playwright(Chromium)によるE2Eテスト。外部API(TDnet)とPDFホストは `page.route` でモックし、
決算短信を模したフィクスチャPDFで抽出〜保存の全フローを検証する。

## 実行方法

```sh
npm install playwright          # 初回のみ(chromiumも取得される)
python3 -m http.server 8123 &   # リポジトリルートで静的サーバーを起動

node tests/make-fixtures.mjs    # フィクスチャPDF生成(初回のみ)
node tests/e2e-v2.mjs           # v2全機能(PDF抽出/スケジュール/コメント/株価/一覧)
node tests/e2e-manual-flow.mjs  # 手動入力フローの回帰テスト
```

`--- ALL PASSED ---` が出れば成功。

## 構成

| ファイル | 内容 |
|---|---|
| `make-fixtures.mjs` | 東証様式を模した決算短信PDF・決算説明資料PDFを生成 |
| `e2e-v2.mjs` | PDFアップロード→抽出→確認→保存、分析画面(KPI/タブ/PDFビューア)、コメント・株価・バリュエーション、スケジュール(TDnetモック・CSVインポート・時価総額フィルタ)、PDF取得の成功/失敗、保存済み一覧、エクスポート、v1→v2マイグレーション |
| `e2e-manual-flow.mjs` | 銘柄手動登録→8期入力→ダッシュボード(M1由来の回帰) |

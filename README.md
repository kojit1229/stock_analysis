# Kessan Board — 決算書分析Webアプリ

四半期決算を「さっと入力 → すぐ分析」するための個人利用向けWebアプリ。
Vanilla JS + Chart.js(同梱)+ localStorage で動作し、サーバー・ビルド工程は不要。

## 使い方(ローカル起動)

```sh
python3 -m http.server 8000
# → http://localhost:8000 を開く
```

ES Modules を使用しているため `file://` 直接オープンでは動きません。
GitHub Pages などの静的ホスティングにそのまま置けます。

## ドキュメント

仕様書一式は [Docs/FinancialAnalysisApp/](Docs/FinancialAnalysisApp/) を参照。

| ファイル | 内容 |
|---|---|
| [01_実装方針.md](Docs/FinancialAnalysisApp/01_実装方針.md) | 技術スタック、機能リスト、マイルストーン |
| [02_質問リスト.md](Docs/FinancialAnalysisApp/02_質問リスト.md) | 設計判断の記録(Q1〜Q8決定済み) |
| [03_仕様書.md](Docs/FinancialAnalysisApp/03_仕様書.md) | データ構造、画面構成、指標定義式 |
| [04_運用ガイド.md](Docs/FinancialAnalysisApp/04_運用ガイド.md) | 四半期の運用チェックリスト |

## 実装状況

- **M1(完了)**: 銘柄登録・編集・削除 / 四半期データ入力フォーム(累計入力→単Q自動算出)/
  銘柄詳細ダッシュボード(KPIカード+推移チャート+期次テーブル)/
  ホーム一覧(YoYヒートマップ・入力待ち表示)/ JSONエクスポート・インポート
- **M2(未着手)**: 決算短信PDFアップロード→自動抽出→フォームプリフィル(`parser.js`)
- **M3(未着手)**: 赤信号の自動検出、CSVエクスポート、PWA対応 ほかP1一式

## ファイル構成

```
├── index.html
├── styles.css
├── app.js              # 状態管理・画面描画
├── metrics.js          # 指標定義レジストリ(単Q/TTM/YoY導出+指標追加はここに1エントリ)
├── vendor/chart.umd.js # Chart.js 4.4.9(同梱)
└── Docs/FinancialAnalysisApp/
```

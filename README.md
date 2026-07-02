# Kessan Board — 決算書分析Webアプリ

日本株の決算短信PDF・決算説明資料PDFをもとに、決算内容をグラフィカルに分析する個人利用向けWebアプリ。
Vanilla JS + Chart.js + pdf.js(いずれも同梱)+ localStorage/IndexedDB で動作し、サーバー・ビルド工程・ログインは不要。

## 主な機能(要求仕様v2対応)

- **PDF取り込み**: 決算短信PDFをアップロード → サマリー(PL/BS/CF/配当/通期予想)・株式数・セグメント情報を自動抽出 → 確認フォームで保存。銘柄は自動登録。決算説明資料PDFも同じ期に紐づけ可能
- **分析メイン画面**: KPIカード8枚(YoY/QoQ/予想比つき)、PL/BS/CF/セグメントの推移チャート、期次テーブル、PDFビューア(ページ送り・拡大縮小・テキスト検索・セクションジャンプ)
- **コメント・株価**: 1銘柄×1決算期×1四半期ごとにコメント(自由記述+補助項目+投資判断)と株価4種(分析時/決算前/決算後/目標)を保存。分析時株価から実績PER・予想PER・PBR・配当利回り・時価総額を自動計算
- **決算スケジュール**: 過去1週間/未来1ヶ月の切替、時価総額帯・各種フィルタ、銘柄チェック、PDF一括取得(TDnet互換API+CSVインポート+手動追加)
- **保存済み分析一覧**: 全銘柄・全期の横断一覧。コメント内容でも検索可能
- **バックアップ**: JSONエクスポート/インポート(全置換)

## 使い方(ローカル起動)

```sh
python3 -m http.server 8000
# → http://localhost:8000 を開く
```

ES Modules を使用しているため `file://` 直接オープンでは動きません。
GitHub Pages などの静的ホスティングにそのまま置けます。

### ヘルパー(スケジュール取得・株探/TDnetからのPDF取得に必要)

静的アプリのため、TDnet・株探(kabutan.jp)等からの直接取得はブラウザのCORS制約で失敗します。
ヘルパーを経由すると、スケジュール更新(過去=TDnet、未来=JPX発表予定)・
株探の開示一覧からのPDF取込・PDF一括取得がすべて動きます。**使う端末に応じて2種類**あります:

**iPhone / iPad から使う場合(推奨: クラウド版)** — 無料のCloudflare Workerを1回デプロイ:

1. [dash.cloudflare.com](https://dash.cloudflare.com) で無料アカウント作成
2. Workers & Pages → Create → Worker → Deploy → 「Edit code」
3. [`tools/kessan-helper-worker.js`](tools/kessan-helper-worker.js) の内容を全部貼り付けて Deploy
4. 発行URL(`https://〜.workers.dev`)をアプリの設定画面「ヘルパーURL」に貼り、「接続確認」で✅を確認

**PCから使う場合(ローカル版)**:

```sh
python3 tools/kessan_helper.py   # http://localhost:8787(標準ライブラリのみ、依存なし)
```

※ `localhost` はアプリを開いている端末自身を指すため、iPhone/iPadからは使えません。

- ヘルパーなしでも全機能は動作します(スケジュールはCSV/手動追加、PDFは手動アップロード)
- 銘柄詳細の「株探PDF」ボタン、またはスケジュール各行の「株探」ボタンから、
  株探に上がっている決算短信・説明資料PDFを選んで取り込めます
- 詳細設計は [05_v2設計書](Docs/FinancialAnalysisApp/05_v2設計書.md) §7 を参照

## ドキュメント

仕様書一式は [Docs/FinancialAnalysisApp/](Docs/FinancialAnalysisApp/) を参照。

| ファイル | 内容 |
|---|---|
| [01_実装方針.md](Docs/FinancialAnalysisApp/01_実装方針.md) | 技術スタック、機能リスト、マイルストーン(v1) |
| [02_質問リスト.md](Docs/FinancialAnalysisApp/02_質問リスト.md) | 設計判断の記録(Q1〜Q8決定済み) |
| [03_仕様書.md](Docs/FinancialAnalysisApp/03_仕様書.md) | データ構造、画面構成、指標定義式(v1) |
| [04_運用ガイド.md](Docs/FinancialAnalysisApp/04_運用ガイド.md) | 四半期の運用チェックリスト |
| [05_v2設計書.md](Docs/FinancialAnalysisApp/05_v2設計書.md) | 要求仕様v2の設計(スケジュール/PDF取得/ビューア/コメント・株価) |

## テスト

Playwright による E2E テストを同梱([tests/](tests/) 参照)。外部APIはモックし、
決算短信を模したフィクスチャPDFで抽出〜保存の全フローを検証している。

## ファイル構成

```
├── index.html
├── styles.css
├── app.js          # 状態管理・ルーティング・全画面描画
├── metrics.js      # 指標定義レジストリ(単Q/TTM/YoY/QoQ導出・バリュエーション)
├── parser.js       # 決算短信PDF抽出(サマリー+BS/CF/セグメント)
├── viewer.js       # PDFビューア
├── db.js           # IndexedDB(PDF格納)
├── vendor/         # chart.umd.js / pdf.min.js / pdf.worker.min.js(同梱)
├── tests/          # Playwright E2E
└── Docs/FinancialAnalysisApp/
```

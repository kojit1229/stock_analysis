import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://localhost:8123/';
const errors = [];
const dialogs = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('console', (m) => {
  // broken.pdf は取得失敗パスの検証用に意図的にabortしている
  if (m.type() === 'error' && !/ERR_FAILED|Failed to load resource/.test(m.text())) errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));
page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

const today = new Date();
const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(today); d.setDate(d.getDate() - n); return iso(d); };
const daysAhead = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return iso(d); };

// ---- 外部API/PDFホストのモック ----
const tanshinBytes = fs.readFileSync(path.join(DIR, 'fixture-tanshin.pdf'));
await page.route('**/webapi.example.test/tdnet/list/recent.json*', (route) => {
  route.fulfill({ json: { items: [
    { Tdnet: { company_code: '65010', company_name: 'テスト電機', pubdate: `${daysAgo(2)} 15:00:00`,
      title: '2027年3月期 第1四半期決算短信〔日本基準〕(連結)',
      document_url: 'https://pdfhost.example.test/6501_tanshin.pdf' } },
    { Tdnet: { company_code: '67580', company_name: 'モックソニー', pubdate: `${daysAgo(1)} 15:00:00`,
      title: '2027年3月期 第1四半期決算短信〔日本基準〕(連結)',
      document_url: 'https://pdfhost.example.test/broken.pdf' } },
  ] } });
});
await page.route('**/pdfhost.example.test/6501_tanshin.pdf', (route) => {
  route.fulfill({ body: tanshinBytes, contentType: 'application/pdf' });
});
await page.route('**/pdfhost.example.test/broken.pdf', (route) => route.abort()); // CORS失敗を模擬

await page.goto(BASE);
await page.evaluate(() => { localStorage.clear(); indexedDB.deleteDatabase('kessan-board-pdfs'); });
await page.reload();

// ============ 1. ナビと空状態 ============
assert((await page.locator('.nav-tab').count()) === 4, 'nav has 4 tabs');
assert((await page.locator('.empty-state').count()) === 1, 'empty state shown');

// ============ 2. 短信PDF手動アップロード→抽出→確認フォーム→保存 ============
const [chooser] = await Promise.all([
  page.waitForEvent('filechooser'),
  page.click('.empty-state [data-action="upload-any"]'),
]);
await chooser.setFiles(path.join(DIR, 'fixture-tanshin.pdf'));
await page.waitForSelector('#record-form', { timeout: 15000 });
assert(true, 'PDF upload opens prefilled record form');
assert((await page.inputValue('input[data-path="pl.sales"]')) === '11,000', 'sales prefilled 11,000');
assert((await page.inputValue('input[data-path="cf.investingCF"]')) === '-800', 'investing CF prefilled -800');
assert((await page.inputValue('input[data-path="shares.outstanding"]')) === '10,000,000', 'shares prefilled (treasury deducted)');
assert(await page.locator('input[data-path="pl.sales"]').evaluate((el) => el.readOnly), 'extracted field locked by default');
// 手動上書きモード(仕様8.4)
await page.check('#unlock-extracted');
assert(!(await page.locator('input[data-path="pl.sales"]').evaluate((el) => el.readOnly)), 'unlock toggle enables editing');
await page.uncheck('#unlock-extracted');
// セグメント抽出行
assert((await page.locator('.segment-row').count()) === 3, 'segment rows prefilled (3)');
// FY/Q自動判定
assert((await page.locator('select[name="fy"]').inputValue()) === '2027', 'FY auto-detected 2027');
assert((await page.locator('select[name="q"]').inputValue()) === '1', 'Q auto-detected Q1');
await page.click('[data-action="save-record"]');

// ============ 3. 分析メイン画面 ============
await page.waitForSelector('.info-bar');
assert((await page.locator('#topbar').textContent()).includes('テスト電機株式会社'), 'company auto-registered from PDF');
const infoText = await page.locator('.info-bar').textContent();
assert(infoText.includes('第1四半期'), 'info bar shows 決算種別');
assert(infoText.includes('決算短信'), 'info bar shows 対象資料=決算短信');
assert(infoText.includes('2026-08-05'), 'info bar shows 決算発表日');
assert((await page.locator('.kpi-card').count()) === 8, '8 KPI cards');
const kpis = await page.locator('.kpi-card').allTextContents();
assert(kpis[0].includes('11,000'), `KPI 売上 11,000 (got ${kpis[0]})`);
assert(kpis[3].includes('85'), `KPI EPS 85円 (got ${kpis[3]})`);
assert(kpis[4].includes('11.4%'), `KPI 営利率 11.4% (got ${kpis[4]})`);
assert(kpis[5].includes('24%') && kpis[5].includes('▲1pt'), `KPI 進捗率 24% vs基準25% (got ${kpis[5]})`);
assert(kpis[6].includes('43.7%'), `KPI 自己資本比率 43.7% (got ${kpis[6]})`);
assert(kpis[7].includes('400'), `KPI FCF 400 (got ${kpis[7]})`);

// タブ切替: BS/CF/セグメント
await page.click('#detail-tabs button[data-tab="bs"]');
assert((await page.locator('#tab-content canvas').count()) === 3, 'BS tab: 3 charts');
await page.click('#detail-tabs button[data-tab="cf"]');
assert((await page.locator('#tab-content canvas').count()) === 1, 'CF tab: 1 chart');
const cfData = await page.evaluate(() => {
  const c = window.Chart.getChart(document.getElementById('ch1'));
  return c.data.datasets.map((d) => [d.label, d.data[0]]);
});
assert(cfData.some(([l, v]) => l.includes('営業CF') && v === 1200), `CF chart 営業CF 1,200 (got ${JSON.stringify(cfData)})`);
assert(cfData.some(([l, v]) => l.includes('フリーCF') && v === 400), 'CF chart フリーCF 400');
await page.click('#detail-tabs button[data-tab="seg"]');
const segTable = await page.locator('#seg-table').textContent();
assert(segTable.includes('半導体') && segTable.includes('6,000'), 'segment table shows 半導体 6,000');
assert(segTable.includes('54.5%'), `segment 構成比 54.5% (got ${segTable})`);

// PDFタブ: ビューア
await page.click('#detail-tabs button[data-tab="pdf"]');
await page.waitForSelector('.pdf-canvas-wrap canvas', { timeout: 15000 });
assert(true, 'PDF viewer renders canvas');
await page.click('[data-pdf="next"]');
assert((await page.inputValue('.pdf-pageinput')) === '2', 'page next works');
await page.fill('.pdf-search', 'セグメント情報');
await page.press('.pdf-search', 'Enter');
await page.waitForFunction(() => document.querySelector('.pdf-status')?.textContent.includes('ページ'));
assert(true, 'text search jumps to page');
await page.selectOption('.pdf-jump', '業績予想');
await page.waitForFunction(() => document.querySelector('.pdf-status')?.textContent.includes('業績予想'));
assert(true, 'section jump works');

// ============ 4. 説明資料PDFの紐づけ ============
await page.setInputFiles('#attach-setsumei', path.join(DIR, 'fixture-setsumei.pdf'));
await page.waitForFunction(() => document.querySelector('.info-bar')?.textContent.includes('両方あり'), { timeout: 15000 });
assert(true, '説明資料added → 対象資料=両方あり');
assert((await page.locator('#pdf-doc-seg button[data-doc="setsumei"]').count()) === 1, 'PDF tab has doc switcher');
await page.click('#pdf-doc-seg button[data-doc="tanshin"]');
await page.waitForSelector('.pdf-canvas-wrap canvas');

// ============ 5. コメント・株価保存(仕様8章・9章) ============
await page.fill('#comment-form textarea[name="text"]', '増収増益。半導体が好調。');
await page.fill('#comment-form input[name="good"]', 'セグメント利益率改善');
await page.selectOption('#comment-form select[name="judgment"]', 'やや強気');
await page.fill('#comment-form input[name="p_analysis"]', '5000');
await page.fill('#comment-form input[name="p_target"]', '6000');
await page.click('[data-action="save-comment"]');
await page.waitForSelector('.valuation');
const valText = await page.locator('.valuation').textContent();
assert(valText.includes('予想PER') && valText.includes('14.3倍'), `予想PER 14.3倍 (5000/350) (got ${valText})`);
assert(valText.includes('PBR') && valText.includes('1.85'), 'PBR 1.85 (5000/2700)');
assert(valText.includes('1.14%'), '配当利回り 1.14% (57/5000)');
assert(valText.includes('実績PER') && /実績PER\s*—/.test(valText.replace(/ /g, ' ')), '実績PER — (TTM不足)');
// 保存後にコメントが残っている
assert((await page.inputValue('#comment-form textarea[name="text"]')) === '増収増益。半導体が好調。', 'comment persisted');

// ============ 6. スケジュール画面: TDnet更新(モック) ============
await page.click('.nav-tab[data-action="nav"][data-id="schedule"]');
await page.evaluate(() => {
  const st = JSON.parse(localStorage.getItem('kessan-board-state-v1'));
  st.settings.scheduleApiBase = 'https://webapi.example.test/tdnet';
  st.settings.helperBase = '';  // ヘルパー無効 → TDnet直接fetchへのフォールバックを検証
  localStorage.setItem('kessan-board-state-v1', JSON.stringify(st));
});
await page.reload();
await page.click('.nav-tab[data-id="schedule"]');
await page.click('[data-action="schedule-update"]');
await page.waitForFunction(() => document.querySelectorAll('.schedule-table tbody tr[data-schedule-id]').length >= 2);
assert(dialogs.some((d) => d.includes('TDnet更新完了')), 'TDnet update completes');
const schedText = await page.locator('.schedule-table').textContent();
assert(schedText.includes('テスト電機') && schedText.includes('モックソニー'), 'both mocked rows appear (past week)');
assert(schedText.includes('発表済み'), 'announced status shown');

// フィルタ: 検索
await page.fill('#sched-search', '6758');
assert(!(await page.locator('.schedule-table').textContent()).includes('テスト電機'), 'search filter works');
await page.fill('#sched-search', '');

// ============ 7. チェック→PDF取得(成功/失敗) ============
await page.check('.sched-check[data-id="s_6501_' + daysAgo(2) + '"]');
await page.check('.sched-check[data-id="s_6758_' + daysAgo(1) + '"]');
// 個別取得: 6501(成功→確認モーダル)
await page.click(`[data-action="fetch-pdf"][data-id="s_6501_${daysAgo(2)}"]`);
await page.waitForSelector('#record-form', { timeout: 15000 });
assert(true, 'individual fetch success opens confirm form');
await page.click('[data-action="save-record"]');
await page.waitForSelector('.info-bar');
assert((await page.locator('.info-bar').textContent()).includes('TDnet'), '取得元 = TDnet after fetched save');
// スケジュールに戻って6758取得(失敗を模擬)
await page.click('.nav-tab[data-id="schedule"]');
await page.click(`[data-action="fetch-pdf"][data-id="s_6758_${daysAgo(1)}"]`);
await page.waitForFunction((id) =>
  document.querySelector(`tr[data-schedule-id="${id}"]`)?.textContent.includes('取得失敗'),
  `s_6758_${daysAgo(1)}`);
assert(true, 'fetch failure → 取得失敗 status');
assert((await page.locator(`tr[data-schedule-id="s_6758_${daysAgo(1)}"] .open-link`).count()) === 1, 'failed row has 開く fallback link');
assert((await page.locator(`tr[data-schedule-id="s_6758_${daysAgo(1)}"]`).textContent()).match(/再取得/), 'failed row shows 再取得');
// 6501行は取得済み+分析済み
const row6501 = await page.locator(`tr[data-schedule-id="s_6501_${daysAgo(2)}"]`).textContent();
assert(row6501.includes('取得済み'), '6501 tanshin status 取得済み');
assert(row6501.includes('✅'), '6501 分析済み');
assert(row6501.includes('💬'), '6501 コメント済み');

// ============ 8. チェック銘柄画面 ============
await page.click('.nav-tab[data-id="checked"]');
assert((await page.locator('.schedule-table tbody tr[data-schedule-id]').count()) === 2, 'checked list shows 2 rows');
assert((await page.locator('[data-action="fetch-retry"]').textContent()).includes('(1)'), 'retry button counts 1 failed');

// ============ 9. CSVインポート+時価総額フィルタ+未来1ヶ月 ============
await page.click('.nav-tab[data-id="schedule"]');
await page.click('[data-action="schedule-add"]'); // 手動追加モーダル
await page.fill('#sched-add-form input[name="date"]', daysAhead(10));
await page.fill('#sched-add-form input[name="code"]', '9999');
await page.fill('#sched-add-form input[name="name"]', '未来商事');
await page.fill('#sched-add-form input[name="cap"]', '12000000');
await page.click('#sched-add-save');
// CSVインポート
await page.click('[data-action="schedule-import"]');
await page.fill('#sched-csv-text', `${daysAhead(20)},8888,巨大重工,プライム,機械,15000000,2027,2`);
await page.click('#sched-csv-import');
assert(dialogs.some((d) => d.includes('1件を取り込みました')), 'CSV import 1 row');
// 過去1週間ビューには未来行が出ない
let t = await page.locator('.schedule-table').textContent();
assert(!t.includes('未来商事'), 'future rows hidden in past-week view');
await page.click('#sched-period-seg button[data-period="future"]');
t = await page.locator('.schedule-table').textContent();
assert(t.includes('未来商事') && t.includes('巨大重工'), 'future month view shows future rows');
assert(t.includes('未発表'), 'future rows are 未発表');
// 時価総額フィルタ: 10兆円以上
await page.selectOption('#sched-cap', 'b5');
t = await page.locator('.schedule-table').textContent();
assert(t.includes('未来商事') && t.includes('巨大重工'), 'cap band b5 keeps 12兆/15兆 rows');
await page.selectOption('#sched-cap', 'b1');
t = await page.locator('.schedule-table').textContent();
assert(!t.includes('未来商事'), 'cap band b1 hides them');
await page.selectOption('#sched-cap', '');

// ============ 10. 保存済み分析一覧 ============
await page.click('.nav-tab[data-id="saved"]');
let savedText = await page.locator('tbody').textContent();
assert(savedText.includes('6501') && savedText.includes('第1四半期'), 'saved list shows 6501 Q1');
assert(savedText.includes('5,000円'), 'saved list shows 入力株価');
assert(savedText.includes('💬'), 'saved list shows comment mark');
// コメント内容で検索(仕様14.3)
await page.fill('#saved-search', '半導体が好調');
savedText = await page.locator('tbody').textContent();
assert(savedText.includes('6501'), 'search by comment content hits');
await page.fill('#saved-search', '存在しないワード');
savedText = await page.locator('tbody').textContent();
assert(savedText.includes('保存済みの分析がありません'), 'search miss shows empty');
await page.fill('#saved-search', '');
// 行タップ→分析画面へ
await page.click('tbody tr[data-action="open-saved"]');
await page.waitForSelector('.info-bar');
assert(true, 'saved row opens analysis view');

// ============ 11. 再保存=更新(仕様10.3) ============
await page.fill('#comment-form textarea[name="text"]', '更新後コメント');
await page.click('[data-action="save-comment"]');
const recCount = await page.evaluate(() => JSON.parse(localStorage.getItem('kessan-board-state-v1')).records.length);
assert(recCount === 1, `re-save updates, no duplicate (records=${recCount})`);

// ============ 12. エクスポート(version 2 + schedule) ============
await page.click('[data-action="go-home"]');
await page.click('[data-action="settings"]');
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.click('[data-action="export-json"]'),
]);
const exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
assert(exported.version === 2, 'export version 2');
assert(exported.schedule.length === 4, `export contains schedule (${exported.schedule.length})`);
assert(exported.records[0].comment.text === '更新後コメント', 'export contains comment');
assert(exported.records[0].prices.analysis === 5000, 'export contains price');
assert(exported.records[0].extracted.length > 10, 'export tracks extracted fields');
await page.click('[data-action="close-modal"]');

// ============ 13. v1→v2マイグレーション ============
await page.evaluate(() => {
  const v1 = {
    version: 1,
    settings: { theme: 'dark', defaultPeriods: 8 },
    companies: [{ id: 'c_7203', code: '7203', name: 'トヨタ自動車', sector: '', market: '', tags: [], fiscalYearEnd: 3, nextEarningsDate: null, memo: '', createdAt: '2026-01-01T00:00:00Z' }],
    records: [{ id: 'r_7203_2027Q1', companyId: 'c_7203', fiscalYear: 2027, quarter: 1,
      pl: { sales: 10000, operatingIncome: 1000, ordinaryIncome: null, netIncome: 700 },
      cf: { operatingCF: null }, bs: { totalAssets: 60000, equity: 24000, interestBearingDebt: null },
      shares: { outstanding: 1000000000 },
      forecast: { sales: null, operatingIncome: null, netIncome: null, dividend: null, revised: false },
      market: { price: null, priceDate: null }, note: '', updatedAt: '2026-08-06T00:00:00Z' }],
  };
  localStorage.setItem('kessan-board-state-v1', JSON.stringify(v1));
});
await page.reload();
await page.click('tbody tr[data-action="open-company"]');
await page.waitForSelector('.info-bar');
assert((await page.locator('.kpi-card').count()) === 8, 'v1 state migrates and renders v2 detail');
assert((await page.locator('#comment-form').count()) === 1, 'migrated record has comment form');

assert(errors.length === 0, `no console/page errors (got: ${errors.slice(0, 5).join(' | ')})`);
await browser.close();
console.log(process.exitCode ? '--- FAILED ---' : '--- ALL PASSED ---');

import { chromium } from 'playwright';

const BASE = 'http://localhost:8123/';
const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

await page.goto(BASE);
assert(await page.locator('h1').textContent() === 'Kessan Board', 'home renders');
assert((await page.locator('.empty-state').count()) === 1, 'empty state shown');

// --- 銘柄追加(UI経由) ---
await page.click('[data-action="add-company"]');
await page.fill('input[name="code"]', '7203');
await page.fill('input[name="name"]', 'トヨタ自動車');
await page.fill('input[name="sector"]', '輸送用機器');
await page.fill('input[name="tags"]', '保有');
await page.fill('input[name="nextEarningsDate"]', '2026-06-01');
await page.click('[data-action="save-company"]');
assert((await page.locator('tbody tr').count()) === 1, 'company row appears');
assert((await page.locator('.pending-banner').count()) === 1, 'pending banner (nextEarningsDate <= today)');

// --- 決算入力フォーム(UI経由で1期入力: FY2026 Q1) ---
await page.click('[data-action="input-pending"]');
await page.selectOption('select[name="fy"]', '2026');
await page.selectOption('select[name="q"]', '1');
const fill = async (path, v) => page.fill(`input[data-path="${path}"]`, String(v));
await fill('pl.sales', 10000);
await fill('pl.operatingIncome', 1000);
await fill('pl.netIncome', 700);
await fill('bs.totalAssets', 60000);
await fill('bs.equity', 24000);
await fill('shares.outstanding', 1000000000);
// カンマ整形の確認
await page.locator('input[data-path="pl.sales"]').blur();
const salesVal = await page.inputValue('input[data-path="pl.sales"]');
assert(salesVal === '10,000', `comma formatting on blur (got ${salesVal})`);
await page.click('[data-action="save-record"]');
assert((await page.locator('.kpi-card').count()) === 8, 'saved -> detail dashboard with 8 KPI cards');

// --- 残り7期をlocalStorageへ注入して8期分にする ---
await page.evaluate(() => {
  const st = JSON.parse(localStorage.getItem('kessan-board-state-v1'));
  const cid = st.companies[0].id;
  const mk = (fy, q, sales, oi, ni, ta, eq, ocf, fc) => ({
    id: `r_7203_${fy}Q${q}`, companyId: cid, fiscalYear: fy, quarter: q,
    pl: { sales, operatingIncome: oi, ordinaryIncome: null, netIncome: ni },
    cf: { operatingCF: ocf },
    bs: { totalAssets: ta, equity: eq, interestBearingDebt: 8000 },
    shares: { outstanding: 1000000000 },
    forecast: fc || { sales: null, operatingIncome: null, netIncome: null, dividend: null, revised: false },
    market: { price: null, priceDate: null }, note: '',
    updatedAt: new Date().toISOString(),
  });
  const fc27 = { sales: 47000, operatingIncome: 5200, netIncome: 3500, dividend: 100, revised: false };
  st.records.push(
    mk(2026, 2, 21000, 2200, 1500, 60500, 24500, 1800),
    mk(2026, 3, 33000, 3400, 2300, 61000, 25000, null),
    mk(2026, 4, 45000, 4800, 3200, 61500, 26000, 4000),
    mk(2027, 1, 11000, 1250, 850, 61800, 27000, null, fc27),
    mk(2027, 2, 23000, 2600, 1750, 62000, 28000, 2000, fc27),
    mk(2027, 3, 36300, 4000, 2650, 62200, 29000, null, fc27),
    mk(2027, 4, 48000, 5500, 3600, 62000, 30000, 4400, fc27),
  );
  localStorage.setItem('kessan-board-state-v1', JSON.stringify(st));
});
await page.reload();
await page.click('tbody tr[data-action="open-company"]');

// --- ダッシュボード検証(最新期 = 27Q4) ---
const kpiTexts = await page.locator('.kpi-card').allTextContents();
assert(kpiTexts[0].includes('11,700') && kpiTexts[0].includes('▲2.5%'), `KPI 売上単Q 11,700 / YoY ▲2.5% (got: ${kpiTexts[0]})`);
assert(kpiTexts[1].includes('1,500') && kpiTexts[1].includes('+7.1%'), `KPI 営利単Q 1,500 / YoY +7.1% (got: ${kpiTexts[1]})`);
assert(kpiTexts[4].includes('12.8%'), `KPI 営利率 12.8% (got: ${kpiTexts[4]})`);
assert(kpiTexts[6].includes('48.4%'), `KPI 自己資本比率 48.4% (got: ${kpiTexts[6]})`);

assert((await page.locator('.dashboard tbody tr').count()) === 8, 'period table has 8 rows');
const firstRow = await page.locator('.dashboard tbody tr').first().textContent();
assert(firstRow.trim().startsWith('27Q4'), `newest period first (got: ${firstRow.slice(0, 10)})`);
assert(firstRow.includes('103%'), `progress 103% shown (got: ${firstRow})`);

// 単Q/累計切替
await page.click('#table-mode-seg button[data-mode="cum"]');
const cumRow = await page.locator('.dashboard tbody tr').first().textContent();
assert(cumRow.includes('48,000'), `cumulative mode shows 48,000 (got: ${cumRow})`);
await page.click('#table-mode-seg button[data-mode="sq"]');

// チャートが描画されている(Chart.jsインスタンスがcanvasに載っている)
const chartCount = await page.evaluate(() => document.querySelectorAll('canvas').length);
assert(chartCount === 3, 'PL tab: three chart canvases');
const mainChartData = await page.evaluate(() => {
  const c = window.Chart.getChart(document.getElementById('ch1'));
  return c ? { labels: c.data.labels.length, sales: c.data.datasets[0].data } : null;
});
assert(mainChartData && mainChartData.labels === 8, `main chart shows 8 periods (got ${mainChartData?.labels})`);
assert(mainChartData.sales[7] === 11700 && mainChartData.sales[0] === 10000, `chart single-Q sales derived (got ${mainChartData.sales})`);

// 期数切替
await page.click('#periods-seg button[data-periods="12"]');
const labels12 = await page.evaluate(() => window.Chart.getChart(document.getElementById('ch1')).data.labels.length);
assert(labels12 === 8, '12期切替でも全8期(データが8期しかない)');

// --- 編集フロー: 行タップ→値修正→保存 ---
await page.click('.dashboard tbody tr[data-fy="2027"][data-q="4"]');
assert((await page.locator('#record-form').count()) === 1, 'row tap opens edit form');
const prevText = await page.locator('input[data-path="pl.sales"] ~ .prev-value').textContent();
assert(prevText.includes('45,000'), `前年同期値表示 (got: ${prevText})`);
await fill('pl.sales', 48500);
await page.click('[data-action="save-record"]');
const kpiAfter = await page.locator('.kpi-card').first().textContent();
assert(kpiAfter.includes('12,200'), `edit recalculates KPI (48,500-36,300=12,200; got: ${kpiAfter})`);

// ±50%注意ハイライト
await page.click('.dashboard tbody tr[data-fy="2027"][data-q="4"]');
await fill('pl.sales', 200000);
await page.locator('input[data-path="pl.sales"]').blur();
assert((await page.locator('input[data-path="pl.sales"].attention').count()) === 1, 'attention highlight on ±50% deviation');
await page.click('[data-action="close-modal"]');

// --- エクスポート ---
await page.click('[data-action="go-home"]');
await page.click('[data-action="settings"]');
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.click('[data-action="export-json"]'),
]);
const path = await download.path();
const fs = await import('fs');
const exported = JSON.parse(fs.readFileSync(path, 'utf8'));
assert(exported.version === 2 && exported.records.length === 8, 'export JSON has version 2 + 8 records');
assert(/kessan-board_\d{4}-\d{2}-\d{2}\.json/.test(download.suggestedFilename()), `export filename (got ${download.suggestedFilename()})`);
await page.click('[data-action="close-modal"]');

// --- ホームのヒートマップ列 ---
const homeRow = await page.locator('tbody tr[data-action="open-company"]').first().innerHTML();
assert(homeRow.includes('heat-'), 'home YoY cell has heatmap class');

assert(errors.length === 0, `no console/page errors (got: ${errors.join(' | ')})`);
await browser.close();
console.log(process.exitCode ? '--- FAILED ---' : '--- ALL PASSED ---');

// ローカルヘルパー(tools/kessan_helper.py)経由のスケジュール取得・株探PDF取込・
// CORS失敗時のヘルパーフォールバックを検証する。
// 前提: mock-upstream.py(:8788)と kessan_helper.py(:8787、環境変数でモックを向く)が起動済み。
// 起動方法は tests/README.md を参照。
import { chromium } from 'playwright';

const BASE = process.env.APP_BASE || 'http://localhost:8123/';
const HELPER = 'http://localhost:8787';
const errors = [];
const dialogs = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('console', (m) => {
  // /nocors/ PDFへの直接fetchは意図的にCORSで失敗させている
  if (m.type() === 'error' && !/ERR_FAILED|Failed to load resource|CORS/.test(m.text())) errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));
page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

// ヘルパー自体の疎通(サーバーサイド)
const status = await (await fetch(`${HELPER}/status`)).json();
assert(status.ok === true, 'helper /status ok');
const sched = await (await fetch(`${HELPER}/schedule`)).json();
assert(sched.errors.length === 0, `helper /schedule no errors (got ${JSON.stringify(sched.errors)})`);
assert(sched.past.length === 1 && sched.past[0].code === '6501', 'helper past: 6501 merged (tanshin+setsumei)');
assert(!!sched.past[0].tanshinUrl && !!sched.past[0].setsumeiUrl, 'helper past row has both PDF urls');
assert(sched.future.length === 1 && sched.future[0].code === '7777', 'helper future: JPX xlsx row 7777');
assert(sched.future[0].quarter === 1 && sched.future[0].fiscalYear === 2027, 'helper future: FY/Q parsed from xlsx');
const kabutan = await (await fetch(`${HELPER}/kabutan?code=6501`)).json();
assert(kabutan.pdfs.length === 2, `helper /kabutan returns 2 pdf links (got ${kabutan.pdfs.length})`);
assert(kabutan.pdfs[0].kind === 'tanshin', 'kabutan pdf kind detected as tanshin');

// ---- アプリ統合 ----
await page.goto(BASE);
await page.evaluate(() => { localStorage.clear(); indexedDB.deleteDatabase('kessan-board-pdfs'); });
await page.reload();

// スケジュール更新(ヘルパー経由)
await page.click('.nav-tab[data-id="schedule"]');
await page.click('[data-action="schedule-update"]');
await page.waitForFunction(() => document.querySelectorAll('tr[data-schedule-id]').length >= 1);
assert(dialogs.some((d) => d.includes('ヘルパー経由で更新しました')), 'schedule update via helper');
let t = await page.locator('.schedule-table').textContent();
assert(t.includes('テスト電機'), 'past row (TDnet mock) shown in past week');
await page.click('#sched-period-seg button[data-period="future"]');
t = await page.locator('.schedule-table').textContent();
assert(t.includes('モック精密') && t.includes('未発表'), 'future row (JPX mock) shown in future month');
await page.click('#sched-period-seg button[data-period="past"]');

// PDF取得: 直接fetchはCORSで失敗 → ヘルパー経由で成功するはず
const rowId = await page.locator('tr[data-schedule-id]').first().getAttribute('data-schedule-id');
await page.click(`[data-action="fetch-pdf"][data-id="${rowId}"]`);
await page.waitForSelector('#record-form', { timeout: 20000 });
assert(true, 'PDF fetch falls back to helper proxy and opens confirm form');
assert((await page.inputValue('input[data-path="pl.sales"]')) === '11,000', 'extracted values prefilled via helper-fetched PDF');
await page.click('[data-action="save-record"]');
await page.waitForSelector('.info-bar');
await page.click('.nav-tab[data-id="schedule"]');
const rowText = await page.locator(`tr[data-schedule-id="${rowId}"]`).textContent();
assert(rowText.includes('取得済み'), 'row status 取得済み after helper fetch');

// 株探からのPDF取込(銘柄詳細から)
await page.click('.nav-tab[data-id="home"]');
await page.click('tbody tr[data-action="open-company"]');
await page.click('[data-action="kabutan-company"]');
await page.waitForSelector('#kabutan-list table', { timeout: 15000 });
assert((await page.locator('#kabutan-list tbody tr').count()) === 2, 'kabutan modal lists 2 PDFs');
await page.click('#kabutan-list button[data-kind="setsumei"]');
await page.waitForFunction(() => document.querySelector('.info-bar')?.textContent.includes('両方あり'), { timeout: 20000 });
assert(true, 'kabutan 説明資料取込 → 対象資料=両方あり');

// 設定画面のヘルパー接続確認
await page.click('.nav-tab[data-id="home"]');
await page.click('[data-action="settings"]');
await page.click('#setting-helper-check');
await page.waitForFunction(() => document.getElementById('helper-check-result')?.textContent.includes('接続OK'));
assert(true, 'settings helper check shows 接続OK');

assert(errors.length === 0, `no console/page errors (got: ${errors.slice(0, 5).join(' | ')})`);
await browser.close();
console.log(process.exitCode ? '--- FAILED ---' : '--- ALL PASSED ---');

// クラウド版ヘルパー(tools/kessan-helper-worker.js)のロジック検証。
// Cloudflare WorkerのfetchハンドラをNode上で直接呼び、mock-upstream.py(:8788)を上流に使う。
// 前提: python3 tests/mock-upstream.py が起動済み。
import worker from '../tools/kessan-helper-worker.js';

const env = {
  TDNET_BASE: 'http://localhost:8788/webapi/tdnet',
  JPX_PAGE: 'http://localhost:8788/jpx/index.html',
  KABUTAN_BASE: 'http://localhost:8788/kabutan/disclosures/?code={code}',
};

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('ok:', msg);
}

const call = (path) => worker.fetch(new Request(`https://worker.test${path}`), env);

// /status
const status = await (await call('/status')).json();
assert(status.ok === true, 'worker /status ok');

// CORSヘッダ
const res = await call('/status');
assert(res.headers.get('Access-Control-Allow-Origin') === '*', 'worker sends CORS header');

// /schedule
const sched = await (await call('/schedule')).json();
assert(sched.errors.length === 0, `worker /schedule no errors (got ${JSON.stringify(sched.errors)})`);
assert(sched.past.length === 1 && sched.past[0].code === '6501', 'worker past: 6501 merged');
assert(!!sched.past[0].tanshinUrl && !!sched.past[0].setsumeiUrl, 'worker past row has both PDF urls');
assert(sched.past[0].fiscalYear === 2027 && sched.past[0].quarter === 1, 'worker past FY/Q from title');
assert(sched.future.length === 1 && sched.future[0].code === '7777', 'worker future: JPX xlsx row (zip+XML parsed in JS)');
assert(sched.future[0].quarter === 1 && sched.future[0].fiscalYear === 2027, 'worker future FY/Q parsed');
assert(sched.future[0].name === 'モック精密' && sched.future[0].market === 'プライム', 'worker future name/market');

// /kabutan
const kabutan = await (await call('/kabutan?code=6501')).json();
assert(kabutan.pdfs.length === 2, `worker /kabutan 2 links (got ${kabutan.pdfs.length})`);
assert(kabutan.pdfs[0].kind === 'tanshin' && kabutan.pdfs[1].kind === 'setsumei', 'worker kabutan kinds');
assert(kabutan.pdfs[1].url.startsWith('http://localhost:8788/'), 'worker resolves relative pdf url');

// /pdf プロキシ
const pdfRes = await call(`/pdf?url=${encodeURIComponent('http://localhost:8788/nocors/6501_tanshin.pdf')}`);
assert(pdfRes.status === 200 && pdfRes.headers.get('Content-Type') === 'application/pdf', 'worker /pdf proxies PDF');
assert(pdfRes.headers.get('Access-Control-Allow-Origin') === '*', 'worker /pdf has CORS');
const buf = await pdfRes.arrayBuffer();
assert(buf.byteLength > 10000, `worker /pdf body size (${buf.byteLength})`);

// 不正入力
assert((await call('/kabutan?code=abc')).status === 400, 'worker rejects bad code');
assert((await call('/pdf?url=file:///etc/passwd')).status === 400, 'worker rejects non-http url');
assert((await call('/nope')).status === 404, 'worker 404');

console.log(process.exitCode ? '--- FAILED ---' : '--- ALL PASSED ---');

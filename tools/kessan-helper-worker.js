// Kessan Board クラウド版ヘルパー(Cloudflare Worker)
//
// iPhone/iPad など「PCでローカルヘルパーを起動できない環境」から使うための、
// tools/kessan_helper.py と同じAPIを持つサーバーレス版。無料枠で動く。
//
// ── デプロイ手順(1回だけ、ブラウザで完結)──────────────────────────
// 1. https://dash.cloudflare.com で無料アカウントを作成
// 2. Workers & Pages → Create → Worker(名前は任意、例: kessan-helper)→ Deploy
// 3. 「Edit code」でこのファイルの内容を全部貼り付けて Deploy
// 4. 発行されたURL(https://kessan-helper.xxxx.workers.dev)をコピー
// 5. アプリの設定画面「ローカルヘルパーURL」に貼り付けて「接続確認」→ ✅接続OK
// ────────────────────────────────────────────────────────────────
//
// エンドポイント(すべて Access-Control-Allow-Origin: * 付き):
//   GET /status                稼働確認
//   GET /schedule              決算スケジュール(過去=TDnet API / 未来=JPX発表予定xlsx)
//   GET /kabutan?code=7203     株探の開示ページからPDFリンク一覧
//   GET /pdf?url=https://...   PDFの代理取得(CORS回避)

const DEFAULTS = {
  TDNET_BASE: "https://webapi.yanoshin.jp/webapi/tdnet",
  JPX_PAGE: "https://www.jpx.co.jp/listing/event-schedules/financial-announcement/index.html",
  KABUTAN_BASE: "https://kabutan.jp/disclosures/?code={code}",
};

const UA = "Mozilla/5.0 (compatible; KessanBoardHelper/1.0; personal use)";

function cfg(env, key) {
  return (env && env[key]) || DEFAULTS[key];
}

async function get(url, asText = true) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} (${url})`);
  return asText ? res.text() : res.arrayBuffer();
}

function cors(body, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Cache-Control", "no-store");
  return new Response(body, { ...init, headers });
}

function json(obj, status = 200) {
  return cors(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

// ---------------------------------------------------------------------------
// 過去分: TDnet API(yanoshin互換)
// ---------------------------------------------------------------------------

const TITLE_PERIOD_RE = /(\d{4})年(\d{1,2})月期(?:.{0,6}?第([1-3])四半期)?/;

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

async function tdnetPast(env, days = 7) {
  const now = new Date();
  const from = new Date(now.getTime() - days * 86400e3);
  const fmt = (d) => isoDate(d).replace(/-/g, "");
  const url = `${cfg(env, "TDNET_BASE")}/list/${fmt(from)}-${fmt(now)}.json?limit=500`;
  const data = JSON.parse(await get(url));
  const rows = new Map();
  for (const item of data.items || []) {
    const t = item.Tdnet || item;
    const title = t.title || "";
    const isTanshin = title.includes("決算短信");
    const isSetsumei = /決算説明|決算補足/.test(title);
    if (!isTanshin && !isSetsumei) continue;
    const code = String(t.company_code || "").replace(/0$/, "").slice(0, 4);
    if (!/^\d{4}$/.test(code)) continue;
    const date = String(t.pubdate || "").slice(0, 10);
    if (!date) continue;
    const m = title.match(TITLE_PERIOD_RE);
    const fy = m ? Number(m[1]) : null;
    const q = m ? (m[3] ? Number(m[3]) : 4) : null;
    const key = `${code}_${date}`;
    if (!rows.has(key)) {
      rows.set(key, {
        date, code, name: t.company_name || code,
        market: "", sector: "", marketCap: null,
        fiscalYear: fy, quarter: q, announced: true,
        tanshinUrl: null, setsumeiUrl: null,
      });
    }
    const row = rows.get(key);
    const docUrl = t.document_url || t.url || null;
    if (isTanshin && docUrl) {
      row.tanshinUrl = docUrl;
      row.fiscalYear = row.fiscalYear ?? fy;
      row.quarter = row.quarter ?? q;
    }
    if (isSetsumei && docUrl) row.setsumeiUrl = docUrl;
  }
  return [...rows.values()];
}

// ---------------------------------------------------------------------------
// 未来分: JPX「決算発表予定日」xlsx(zip+XMLを依存なしで読む)
// ---------------------------------------------------------------------------

async function inflateRaw(bytes) {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// 最小限のzipリーダー: セントラルディレクトリを走査してエントリ名→展開バイト列
async function unzip(buf) {
  const b = new Uint8Array(buf);
  const dv = new DataView(buf);
  // End of Central Directory(0x06054b50)を末尾から探す
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65558); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("zip: EOCDが見つかりません");
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const entries = {};
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const compSize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    const name = dec.decode(b.subarray(off + 46, off + 46 + nameLen));
    // ローカルヘッダから実データ位置を求める
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    entries[name] = { method, data: b.subarray(dataStart, dataStart + compSize) };
    off += 46 + nameLen + extraLen + commentLen;
  }
  const out = {};
  for (const [name, e] of Object.entries(entries)) {
    out[name] = e.method === 8 ? await inflateRaw(e.data) : e.data;
  }
  return out;
}

function xmlText(s) {
  return s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
}

function parseXlsxRows(files) {
  const dec = new TextDecoder();
  const shared = [];
  if (files["xl/sharedStrings.xml"]) {
    const sst = dec.decode(files["xl/sharedStrings.xml"]);
    for (const m of sst.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      const ts = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => xmlText(x[1]));
      shared.push(ts.join(""));
    }
  }
  const sheetName = Object.keys(files).find((n) => /^xl\/worksheets\/sheet1\.xml$/.test(n));
  if (!sheetName) throw new Error("xlsx: sheet1が見つかりません");
  const sheet = dec.decode(files[sheetName]);
  const rows = [];
  for (const rm of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cm of rm[1].matchAll(/<c([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1] || "";
      const inner = cm[2] || "";
      const tAttr = (attrs.match(/t="([^"]+)"/) || [])[1];
      const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1] ?? "";
      if (tAttr === "s") cells.push(shared[Number(v)] ?? "");
      else if (tAttr === "inlineStr") {
        cells.push([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => xmlText(x[1])).join(""));
      } else cells.push(xmlText(v));
    }
    rows.push(cells);
  }
  return rows;
}

function toIsoDate(v) {
  v = String(v).trim();
  if (!v) return null;
  const m = v.match(/(\d{4})[/\-年](\d{1,2})[/\-月](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
  if (/^\d{4,6}(\.0+)?$/.test(v)) {
    // Excelシリアル値(1899-12-30起点)
    const base = Date.UTC(1899, 11, 30);
    return isoDate(new Date(base + Math.floor(Number(v)) * 86400e3));
  }
  return null;
}

const HEADER_ALIASES = {
  date: ["発表予定日", "決算発表予定日", "発表日"],
  code: ["コード", "銘柄コード", "証券コード"],
  name: ["会社名", "銘柄名", "銘柄略称"],
  market: ["市場区分", "市場"],
  fiscalEnd: ["決算期末", "決算期", "期末"],
  kind: ["種別", "決算種別", "四半期"],
  sector: ["業種"],
};

async function jpxFuture(env) {
  const pageUrl = cfg(env, "JPX_PAGE");
  const html = await get(pageUrl);
  const links = [...html.matchAll(/href="([^"]+\.xlsx)"/g)].map((m) => m[1]);
  if (!links.length) throw new Error("JPXページにxlsxリンクが見つかりません");
  const out = [];
  for (const link of links.slice(0, 4)) {
    const url = new URL(link, pageUrl).href;
    const files = await unzip(await get(url, false));
    const rows = parseXlsxRows(files);
    let headerIdx = null;
    const colmap = {};
    for (let i = 0; i < Math.min(20, rows.length); i++) {
      const joined = rows[i].join("");
      if (HEADER_ALIASES.code.some((a) => joined.includes(a)) &&
          HEADER_ALIASES.date.some((a) => joined.includes(a))) {
        headerIdx = i;
        rows[i].forEach((cell, j) => {
          for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
            if (!(key in colmap) && aliases.some((a) => String(cell).includes(a))) colmap[key] = j;
          }
        });
        break;
      }
    }
    if (headerIdx === null) continue;
    for (const row of rows.slice(headerIdx + 1)) {
      const col = (key) => (colmap[key] != null && colmap[key] < row.length ? String(row[colmap[key]]).trim() : "");
      const code = col("code").replace(/\D/g, "").slice(0, 4);
      const d = toIsoDate(col("date"));
      if (!/^\d{4}$/.test(code) || !d) continue;
      const kind = col("kind");
      let q = null;
      const qm = kind.match(/第([1-3])/);
      if (qm) q = Number(qm[1]);
      else if (/本決算|通期|期末/.test(kind)) q = 4;
      const fym = col("fiscalEnd").match(/(\d{4})/);
      out.push({
        date: d, code, name: col("name") || code,
        market: col("market"), sector: col("sector"), marketCap: null,
        fiscalYear: fym ? Number(fym[1]) : null, quarter: q,
        announced: false, tanshinUrl: null, setsumeiUrl: null,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 株探: 開示ページからPDFリンク一覧
// ---------------------------------------------------------------------------

async function kabutanPdfs(env, code) {
  const url = cfg(env, "KABUTAN_BASE").replace("{code}", code);
  const html = await get(url);
  const pdfs = [];
  const seen = new Set();
  for (const m of html.matchAll(/<a[^>]+href="([^"]+\.pdf[^"]*)"[^>]*>([^<]{0,200})<\/a>/gi)) {
    const href = new URL(m[1], url).href;
    if (seen.has(href)) continue;
    seen.add(href);
    const label = m[2].replace(/\s+/g, " ").trim();
    const ctx = html.slice(Math.max(0, m.index - 300), m.index + m[0].length + 100);
    const dm = ctx.match(/(\d{4})[/\-年](\d{1,2})[/\-月](\d{1,2})/);
    const d = dm ? `${dm[1]}-${String(dm[2]).padStart(2, "0")}-${String(dm[3]).padStart(2, "0")}` : null;
    const kind = /説明|補足/.test(label) ? "setsumei" : label.includes("短信") ? "tanshin" : "other";
    pdfs.push({ title: label || href.split("/").pop(), url: href, date: d, kind });
    if (pdfs.length >= 40) break;
  }
  return pdfs;
}

// ---------------------------------------------------------------------------
// ルーティング
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return cors(null, { status: 204 });
    try {
      if (url.pathname === "/status") {
        return json({ ok: true, service: "kessan-helper-worker", version: 1 });
      }
      if (url.pathname === "/schedule") {
        const errors = [];
        let past = [], future = [];
        try {
          past = await tdnetPast(env, Number(url.searchParams.get("days_past") || 7));
        } catch (e) { errors.push(`tdnet: ${e.message}`); }
        try {
          future = await jpxFuture(env);
        } catch (e) { errors.push(`jpx: ${e.message}`); }
        return json({ past, future, errors });
      }
      if (url.pathname === "/kabutan") {
        const code = url.searchParams.get("code") || "";
        if (!/^\d{4}[0-9A-Z]?$/.test(code)) return json({ error: "codeパラメータが不正です" }, 400);
        return json({ code, pdfs: await kabutanPdfs(env, code) });
      }
      if (url.pathname === "/pdf") {
        const target = url.searchParams.get("url") || "";
        if (!/^https?:\/\//.test(target)) return json({ error: "urlパラメータが不正です" }, 400);
        const res = await fetch(target, { headers: { "User-Agent": UA } });
        if (!res.ok) return json({ error: `HTTP ${res.status}` }, 502);
        const buf = await res.arrayBuffer();
        const head = new TextDecoder("latin1").decode(new Uint8Array(buf, 0, Math.min(1024, buf.byteLength)));
        if (!head.includes("%PDF")) return json({ error: "PDFではありません" }, 502);
        return cors(buf, { headers: { "Content-Type": "application/pdf" } });
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: e.message }, 502);
    }
  },
};

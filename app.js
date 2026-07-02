// app.js — 状態管理・画面描画(Kessan Board v2)
// 画面: 銘柄(ポートフォリオ) / スケジュール / チェック銘柄 / 保存済み分析 / 分析メイン(銘柄詳細)
import {
  METRICS,
  HOME_COLUMNS,
  metric,
  computeMetric,
  fmtMetric,
  fmtValue,
  heatClass,
  deriveCompany,
  valuation,
  ratio,
  periodKey,
  periodLabel,
} from "./metrics.js";
import { parsePdf } from "./parser.js";
import { PdfViewer } from "./viewer.js";
import { putPdf, getPdf, deletePdf } from "./db.js";

const STORAGE_KEY = "kessan-board-state-v1";
const CURRENT_VERSION = 2;

// ---------------------------------------------------------------------------
// 状態管理(バージョン付き単一ステート+マイグレーション)
// ---------------------------------------------------------------------------

function defaultState() {
  return {
    version: CURRENT_VERSION,
    settings: {
      theme: "dark",
      defaultPeriods: 8,
      scheduleApiBase: "https://webapi.yanoshin.jp/webapi/tdnet",
    },
    companies: [],
    records: [],
    schedule: [],
  };
}

function emptyComment() {
  return { text: "", firstImpression: "", good: "", bad: "", next: "", judgment: "", priceReaction: "", updatedAt: null };
}

function emptyDocs() {
  return {
    announcedDate: null,
    tanshin: { pdfId: null, fileName: "", source: "", fetchedAt: null },
    setsumei: { pdfId: null, fileName: "", source: "", fetchedAt: null },
  };
}

function migrateRecord(r) {
  r.pl = { sales: null, operatingIncome: null, ordinaryIncome: null, netIncome: null, eps: null, ...r.pl };
  r.bs = { totalAssets: null, netAssets: null, equity: null, interestBearingDebt: null, cash: null, inventory: null, receivables: null, payables: null, ...r.bs };
  r.cf = { operatingCF: null, investingCF: null, financingCF: null, cashEnd: null, ...r.cf };
  r.forecast = { sales: null, operatingIncome: null, netIncome: null, eps: null, dividend: null, revised: false, ...r.forecast };
  r.dividend = { perShareQ: null, annualForecast: null, payoutRatio: null, buyback: false, buybackAmount: null, buybackShares: null, ...r.dividend };
  r.segments = Array.isArray(r.segments) ? r.segments : [];
  r.docs = { ...emptyDocs(), ...r.docs };
  r.extracted = Array.isArray(r.extracted) ? r.extracted : [];
  r.comment = { ...emptyComment(), ...r.comment };
  r.prices = { analysis: null, preEarnings: null, postEarnings: null, target: null, ...r.prices };
  return r;
}

function migrate(raw) {
  if (raw.version === 1) {
    raw.version = 2;
    raw.settings.scheduleApiBase ??= defaultState().settings.scheduleApiBase;
    raw.schedule = raw.schedule || [];
  }
  raw.records = (raw.records || []).map(migrateRecord);
  raw.schedule = raw.schedule || [];
  return raw;
}

function loadState() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!raw || typeof raw.version !== "number") return defaultState();
    return migrate(raw);
  } catch {
    return defaultState();
  }
}

let state = loadState();

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// 画面ローカルの一時状態(保存しない)
const ui = {
  view: "home", // "home" | "schedule" | "checked" | "saved" | "detail"
  companyId: null,
  search: "",
  tag: "",
  sort: "code",
  periods: state.settings.defaultPeriods,
  tableMode: "sq",
  detailTab: "pl", // "pl" | "bs" | "cf" | "seg" | "pdf"
  detailPeriodKey: null, // 分析対象の期(null=最新)
  pdfDocType: "tanshin",
  schedulePeriod: "past", // "past"(過去1週間) | "future"(未来1ヶ月)
  scheduleCap: "", // 時価総額帯
  scheduleFilter: "", // "" | "announced" | "unannounced" | "unanalyzed" | "checked" | "uncommented"
  scheduleSearch: "",
  savedSearch: "",
  savedQuarter: "",
  savedComment: "",
};

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function todayISO() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addDays(iso, days) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + days);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function parseNum(s) {
  if (s == null) return null;
  s = String(s).trim().replace(/,/g, "").replace(/[△▲]/g, "-");
  const paren = s.match(/^\((.+)\)$/);
  if (paren) s = "-" + paren[1];
  if (s === "" || s === "-") return null;
  const v = Number(s);
  return isFinite(v) ? v : null;
}

function fmtInputNum(v) {
  if (v == null) return "";
  return v.toLocaleString("ja-JP");
}

function companyById(id) {
  return state.companies.find((c) => c.id === id) || null;
}

function companyByCode(code) {
  return state.companies.find((c) => c.code === code) || null;
}

function derivedFor(company) {
  return deriveCompany(company, state.records);
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const QUARTER_LABEL = { 1: "第1四半期", 2: "第2四半期", 3: "第3四半期", 4: "本決算" };

// 時価総額帯(百万円ベース)。1,000億円 = 100,000百万円
const CAP_BANDS = [
  { id: "b1", label: "1,000億円未満", min: 0, max: 1e5 },
  { id: "b2", label: "1,000億〜5,000億円", min: 1e5, max: 5e5 },
  { id: "b3", label: "5,000億〜1兆円", min: 5e5, max: 1e6 },
  { id: "b4", label: "1兆〜10兆円", min: 1e6, max: 1e7 },
  { id: "b5", label: "10兆円以上", min: 1e7, max: Infinity },
];

function fmtCap(mm) {
  if (mm == null) return "—";
  if (mm >= 1e6) return (mm / 1e6).toFixed(1) + "兆円";
  return Math.round(mm / 100).toLocaleString("ja-JP") + "億円";
}

const STATUS_LABEL = {
  none: "未取得", pending: "取得待ち", fetching: "取得中",
  done: "取得済み", failed: "取得失敗", unpublished: "未公開",
};

// ---------------------------------------------------------------------------
// テーマ
// ---------------------------------------------------------------------------

function applyTheme() {
  let theme = state.settings.theme;
  if (theme === "auto") {
    theme = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  document.documentElement.dataset.theme = theme;
}

matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
  if (state.settings.theme === "auto") { applyTheme(); render(); }
});

// ---------------------------------------------------------------------------
// レコード操作
// ---------------------------------------------------------------------------

function emptyRecord(companyId, fy, q) {
  const c = companyById(companyId);
  return migrateRecord({
    id: `r_${c.code}_${periodKey(fy, q)}`,
    companyId,
    fiscalYear: fy,
    quarter: q,
    pl: {}, cf: {}, bs: {}, shares: { outstanding: null },
    forecast: {}, market: { price: null, priceDate: null },
    note: "",
    updatedAt: new Date().toISOString(),
  });
}

function findRecord(companyId, fy, q) {
  return state.records.find(
    (r) => r.companyId === companyId && r.fiscalYear === fy && r.quarter === q
  ) || null;
}

function suggestNextPeriod(company) {
  const rows = derivedFor(company);
  if (rows.length > 0) {
    const last = rows[rows.length - 1];
    return last.q === 4 ? { fy: last.fy + 1, q: 1 } : { fy: last.fy, q: last.q + 1 };
  }
  const now = new Date();
  const fyEnd = company.fiscalYearEnd || 3;
  const fy = now.getMonth() + 1 <= fyEnd ? now.getFullYear() : now.getFullYear() + 1;
  const monthsIntoFY = ((now.getMonth() + 1 - fyEnd - 1) + 12) % 12;
  const q = Math.min(4, Math.floor(monthsIntoFY / 3) + 1);
  return { fy, q };
}

// 「分析済み」= その銘柄・期のrecordに主要数値が入っている
function recordAnalyzed(r) {
  return r && (r.pl.sales != null || r.pl.operatingIncome != null || r.pl.netIncome != null);
}

function recordCommented(r) {
  return r && !!(r.comment && (r.comment.text || r.comment.firstImpression || r.comment.judgment));
}

// スケジュール行に対応するrecordを探す(コード+期、なければ発表日)
function recordForScheduleRow(row) {
  const c = companyByCode(row.code);
  if (!c) return null;
  if (row.fiscalYear && row.quarter) return findRecord(c.id, row.fiscalYear, row.quarter);
  return state.records.find((r) => r.companyId === c.id && r.docs?.announcedDate === row.date) || null;
}

// ---------------------------------------------------------------------------
// レンダリング
// ---------------------------------------------------------------------------

const $topbar = document.getElementById("topbar");
const $nav = document.getElementById("nav");
const $view = document.getElementById("view");
const $modalRoot = document.getElementById("modal-root");
let charts = [];
let pdfViewer = null;

function destroyCharts() {
  for (const ch of charts) ch.destroy();
  charts = [];
  if (pdfViewer) { pdfViewer.destroy(); pdfViewer = null; }
}

const NAV_ITEMS = [
  ["home", "銘柄"],
  ["schedule", "スケジュール"],
  ["checked", "チェック銘柄"],
  ["saved", "保存済み分析"],
];

function renderNav() {
  const active = ui.view === "detail" ? "home" : ui.view;
  $nav.innerHTML = NAV_ITEMS.map(([v, label]) =>
    `<button class="nav-tab ${active === v ? "active" : ""}" data-action="nav" data-id="${v}">${label}</button>`
  ).join("");
}

function render() {
  destroyCharts();
  renderNav();
  if (ui.view === "detail" && companyById(ui.companyId)) renderDetail();
  else if (ui.view === "schedule") renderSchedule();
  else if (ui.view === "checked") renderChecked();
  else if (ui.view === "saved") renderSaved();
  else { ui.view = "home"; renderHome(); }
}

// ---- ホーム(ポートフォリオ一覧) ----

function allTags() {
  const set = new Set();
  for (const c of state.companies) (c.tags || []).forEach((t) => set.add(t));
  return [...set];
}

function pendingCompanies() {
  const today = todayISO();
  return state.companies.filter((c) => c.nextEarningsDate && c.nextEarningsDate <= today);
}

function renderHome() {
  const tags = allTags();
  $topbar.innerHTML = `
    <h1>Kessan Board</h1>
    <input type="search" id="search" placeholder="銘柄名・コード" value="${esc(ui.search)}">
    <select id="tag-filter">
      <option value="">全タグ</option>
      ${tags.map((t) => `<option value="${esc(t)}" ${ui.tag === t ? "selected" : ""}>${esc(t)}</option>`).join("")}
    </select>
    <select id="sort">
      <option value="code" ${ui.sort === "code" ? "selected" : ""}>コード順</option>
      <option value="recent" ${ui.sort === "recent" ? "selected" : ""}>直近入力順</option>
    </select>
    <button class="primary" data-action="add-company">＋銘柄追加</button>
    <button data-action="settings" title="設定">⚙</button>
  `;

  const pending = pendingCompanies();
  const pendingHtml = pending.length
    ? `<div class="pending-banner">⏳ 入力待ち:
        ${pending.map((c) => `<button data-action="input-pending" data-id="${c.id}">${esc(c.name)}(${esc(c.nextEarningsDate)})</button>`).join("")}
      </div>`
    : "";

  let list = state.companies.filter((c) => {
    if (ui.search && !(c.name.includes(ui.search) || c.code.includes(ui.search))) return false;
    if (ui.tag && !(c.tags || []).includes(ui.tag)) return false;
    return true;
  });

  const latestByCompany = new Map();
  for (const c of list) {
    const rows = derivedFor(c);
    latestByCompany.set(c.id, rows.length ? rows[rows.length - 1] : null);
  }

  if (ui.sort === "code") {
    list = list.slice().sort((a, b) => a.code.localeCompare(b.code));
  } else {
    list = list.slice().sort((a, b) => {
      const ua = latestByCompany.get(a.id)?.record.updatedAt || "";
      const ub = latestByCompany.get(b.id)?.record.updatedAt || "";
      return ub.localeCompare(ua);
    });
  }

  if (state.companies.length === 0) {
    $view.innerHTML = `${pendingHtml}
      <div class="empty-state">
        <p>銘柄が未登録です。「＋銘柄追加」またはPDFアップロード(スケジュール画面)から始めてください。</p>
        <button class="primary" data-action="upload-any">短信PDFをアップロードして分析</button>
      </div>`;
    return;
  }

  const cols = HOME_COLUMNS.map((id) => metric(id));
  const rowsHtml = list.map((c) => {
    const latest = latestByCompany.get(c.id);
    const cells = cols.map((m) => {
      const v = latest ? computeMetric(m.id, latest) : null;
      const heat = m.heat ? heatClass(v) : "";
      return `<td class="${heat}">${latest ? fmtValue(m.format, v) : "—"}</td>`;
    }).join("");
    return `<tr class="clickable" data-action="open-company" data-id="${c.id}">
      <td>${esc(c.code)} ${esc(c.name)} ${(c.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</td>
      <td>${latest ? latest.label : "—"}</td>
      ${cells}
    </tr>`;
  }).join("");

  $view.innerHTML = `${pendingHtml}
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>銘柄</th><th>期</th>
          ${cols.map((m) => `<th>${esc(m.label)}</th>`).join("")}
        </tr></thead>
        <tbody>${rowsHtml || `<tr><td colspan="${cols.length + 2}" class="dim">該当なし</td></tr>`}</tbody>
      </table>
    </div>
    <p class="toolbar-note"><button class="ghost" data-action="upload-any">＋短信PDFをアップロードして分析(銘柄は自動登録)</button></p>`;

  document.getElementById("search").addEventListener("input", (e) => {
    ui.search = e.target.value;
    render();
    const el = document.getElementById("search");
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  });
  document.getElementById("tag-filter").addEventListener("change", (e) => { ui.tag = e.target.value; render(); });
  document.getElementById("sort").addEventListener("change", (e) => { ui.sort = e.target.value; render(); });
}

// ---------------------------------------------------------------------------
// 分析メイン画面(銘柄詳細)
// ---------------------------------------------------------------------------

const KPI_CARDS_V2 = [
  { valueId: "salesQ", label: "売上高(単Q)", unit: "百万円", yoyId: "yoySales", qoqId: "qoqSales" },
  { valueId: "opIncomeQ", label: "営業利益(単Q)", unit: "百万円", yoyId: "yoyOpIncome", qoqId: "qoqOpIncome" },
  { valueId: "netIncomeQ", label: "純利益(単Q)", unit: "百万円", yoyId: "yoyNetIncome", qoqId: "qoqNetIncome" },
  { valueId: "epsActual", label: "EPS", unit: "" },
  { valueId: "opMargin", label: "営業利益率", unit: "" },
  { valueId: "progressNI", label: "通期進捗率(純利)", unit: "", baseline: true },
  { valueId: "equityRatio", label: "自己資本比率", unit: "" },
  { valueId: "fcfQ", label: "フリーCF(単Q)", unit: "百万円" },
];

function detailCtx(rows) {
  if (!rows.length) return null;
  if (ui.detailPeriodKey) {
    const found = rows.find((r) => r.key === ui.detailPeriodKey);
    if (found) return found;
  }
  return rows[rows.length - 1];
}

function docBadge(record) {
  if (!record) return "—";
  const t = record.docs?.tanshin?.pdfId, s = record.docs?.setsumei?.pdfId;
  if (t && s) return "両方あり";
  if (t) return "決算短信";
  if (s) return "決算説明資料";
  return "—";
}

function renderDetail() {
  const company = companyById(ui.companyId);
  const rows = derivedFor(company);
  const ctx = detailCtx(rows);

  $topbar.innerHTML = `
    <button class="ghost back" data-action="go-home">←</button>
    <div class="company-title">
      <span class="code">${esc(company.code)}</span>
      <h1>${esc(company.name)}</h1>
      ${(company.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}
    </div>
    <label class="pdf-attach-btn">短信PDF<input type="file" id="attach-tanshin" accept="application/pdf" hidden></label>
    <label class="pdf-attach-btn">説明資料PDF<input type="file" id="attach-setsumei" accept="application/pdf" hidden></label>
    <button class="primary" data-action="input-record" data-id="${company.id}">＋当期入力</button>
    <button data-action="edit-company" data-id="${company.id}" title="銘柄情報を編集">✎</button>
  `;
  document.getElementById("attach-tanshin").addEventListener("change", (e) => handleAttach(e, "tanshin"));
  document.getElementById("attach-setsumei").addEventListener("change", (e) => handleAttach(e, "setsumei"));

  if (!ctx) {
    $view.innerHTML = `<div class="empty-state">
      <p>まだ決算データがありません。「短信PDF」を添付するか「＋当期入力」から入力してください。</p>
    </div>`;
    return;
  }

  const r = ctx.record;
  const doc = r.docs?.tanshin?.pdfId ? r.docs.tanshin : r.docs?.setsumei?.pdfId ? r.docs.setsumei : null;

  // 基本情報バー(仕様4.3)
  const infoBar = `
    <div class="info-bar">
      <span><b>市場</b> ${esc(company.market || "—")}</span>
      <span><b>業種</b> ${esc(company.sector || "—")}</span>
      <span><b>決算発表日</b> ${esc(r.docs?.announcedDate || "—")}</span>
      <span><b>決算期</b> ${ctx.fy}年${company.fiscalYearEnd}月期</span>
      <span><b>決算種別</b> ${QUARTER_LABEL[ctx.q]}</span>
      <span><b>対象資料</b> ${docBadge(r)}</span>
      <span><b>取得元</b> ${doc ? esc(doc.source === "tdnet" ? "TDnet" : "手動アップロード") : "—"}</span>
      <span><b>取得日時</b> ${doc?.fetchedAt ? esc(doc.fetchedAt.slice(0, 16).replace("T", " ")) : "—"}</span>
      <span class="spacer"></span>
      <select id="period-select">
        ${rows.map((x) => `<option value="${x.key}" ${x.key === ctx.key ? "selected" : ""}>${x.fy}年${company.fiscalYearEnd}月期 ${QUARTER_LABEL[x.q]}</option>`).join("")}
      </select>
    </div>`;

  // KPIカード(仕様6.1)
  const kpiHtml = KPI_CARDS_V2.map((card) => {
    const m = metric(card.valueId);
    const v = computeMetric(card.valueId, ctx);
    const subs = [];
    if (card.yoyId) {
      const y = computeMetric(card.yoyId, ctx);
      if (y != null) subs.push(`<span class="${y >= 0 ? "up" : "down"}">YoY ${fmtValue("percent1signed", y)}</span>`);
    }
    if (card.qoqId) {
      const qv = computeMetric(card.qoqId, ctx);
      if (qv != null) subs.push(`<span class="${qv >= 0 ? "up" : "down"}">QoQ ${fmtValue("percent1signed", qv)}</span>`);
    }
    if (card.baseline && v != null) {
      const base = ctx.q * 0.25;
      const diff = v - base;
      subs.push(`<span class="${diff >= 0 ? "up" : "down"}">基準${fmtValue("percent0", base)}比 ${diff >= 0 ? "+" : "▲"}${Math.abs(diff * 100).toFixed(0)}pt</span>`);
    }
    return `<div class="kpi-card">
      <div class="kpi-label">${esc(card.label)}</div>
      <div class="kpi-value">${fmtValue(m.format, v)}${card.unit ? ` <span class="kpi-unit">${card.unit}</span>` : ""}</div>
      <div class="kpi-sub">${subs.join(" ") || "&nbsp;"}</div>
    </div>`;
  }).join("");

  const tabs = [["pl", "PL"], ["bs", "BS"], ["cf", "CF"], ["seg", "セグメント"], ["pdf", "PDF"]];
  const tabBar = `<div class="seg" id="detail-tabs">
    ${tabs.map(([v, l]) => `<button data-tab="${v}" class="${ui.detailTab === v ? "active" : ""}">${l}</button>`).join("")}
  </div>`;

  const mode = ui.tableMode;
  const tableRows = rows.slice().reverse().map((c) => {
    const src = mode === "sq" ? c.sq : c.cum;
    const ySales = c.yoy.sales.value;
    const yOI = c.yoy.operatingIncome.value;
    return `<tr class="clickable ${c.key === ctx.key ? "current-row" : ""}" data-action="edit-record" data-company="${company.id}" data-fy="${c.fy}" data-q="${c.q}">
      <td>${c.label}${recordCommented(c.record) ? " 💬" : ""}</td>
      <td>${fmtValue("mm", src.sales ?? (mode === "sq" ? c.cum.sales : null))}</td>
      <td>${fmtValue("mm", src.operatingIncome ?? (mode === "sq" ? c.cum.operatingIncome : null))}</td>
      <td>${fmtValue("mm", src.netIncome ?? (mode === "sq" ? c.cum.netIncome : null))}</td>
      <td class="${heatClass(ySales)}">${fmtValue("percent1signed", ySales)}</td>
      <td class="${heatClass(yOI)}">${fmtValue("percent1signed", yOI)}</td>
      <td>${fmtMetric("opMargin", c)}</td>
      <td>${fmtMetric("progressNI", c)}</td>
    </tr>`;
  }).join("");

  const val = valuation(ctx, r.prices?.analysis);
  const cm = r.comment || emptyComment();

  $view.innerHTML = `
    ${infoBar}
    <div class="kpi-grid kpi-grid-8">${kpiHtml}</div>
    <div class="dashboard">
      <div class="panel">
        <div class="panel-head">
          ${tabBar}
          <span class="spacer"></span>
          <div class="seg" id="periods-seg" ${ui.detailTab === "pdf" ? "hidden" : ""}>
            ${[[8, "8期"], [12, "12期"], [0, "全期間"]].map(([v, l]) =>
              `<button data-periods="${v}" class="${ui.periods === v ? "active" : ""}">${l}</button>`).join("")}
          </div>
        </div>
        <div id="tab-content"></div>
      </div>
      <div class="panel">
        <div class="panel-head">
          <h2>期次テーブル</h2>
          <div class="seg" id="table-mode-seg">
            <button data-mode="sq" class="${mode === "sq" ? "active" : ""}">単Q</button>
            <button data-mode="cum" class="${mode === "cum" ? "active" : ""}">累計</button>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>期</th><th>売上</th><th>営利</th><th>純利</th><th>売上YoY</th><th>営利YoY</th><th>営利率</th><th>進捗</th></tr></thead>
            <tbody>${tableRows}</tbody>
          </table>
        </div>
        <p class="toolbar-note">単位: 百万円。行タップで数値編集。</p>

        <div class="comment-panel">
          <h2>コメント・株価(${ctx.fy}年${company.fiscalYearEnd}月期 ${QUARTER_LABEL[ctx.q]})</h2>
          <form id="comment-form">
            <div class="form-grid">
              <div class="field span2">
                <label>コメント(自由記述)</label>
                <textarea name="text" rows="3" placeholder="今回の決算の所感">${esc(cm.text)}</textarea>
              </div>
              <div class="field"><label>決算の第一印象</label><input name="firstImpression" value="${esc(cm.firstImpression)}"></div>
              <div class="field">
                <label>投資判断</label>
                <select name="judgment">
                  <option value="">—</option>
                  ${["強気", "やや強気", "中立", "やや弱気", "弱気", "保留", "監視継続", "買い候補", "見送り"].map((j) =>
                    `<option ${cm.judgment === j ? "selected" : ""}>${j}</option>`).join("")}
                </select>
              </div>
              <div class="field"><label>良かった点</label><input name="good" value="${esc(cm.good)}"></div>
              <div class="field"><label>悪かった点</label><input name="bad" value="${esc(cm.bad)}"></div>
              <div class="field"><label>次回確認したい点</label><input name="next" value="${esc(cm.next)}"></div>
              <div class="field"><label>株価反応メモ</label><input name="priceReaction" value="${esc(cm.priceReaction)}"></div>
              <div class="form-section">株価入力(円)— バリュエーションは「分析時」で計算</div>
              <div class="field"><label>分析時株価</label><input name="p_analysis" inputmode="decimal" value="${esc(fmtInputNum(r.prices?.analysis))}"></div>
              <div class="field"><label>決算前株価</label><input name="p_preEarnings" inputmode="decimal" value="${esc(fmtInputNum(r.prices?.preEarnings))}"></div>
              <div class="field"><label>決算後株価</label><input name="p_postEarnings" inputmode="decimal" value="${esc(fmtInputNum(r.prices?.postEarnings))}"></div>
              <div class="field"><label>目標株価</label><input name="p_target" inputmode="decimal" value="${esc(fmtInputNum(r.prices?.target))}"></div>
            </div>
            <div class="modal-actions">
              <span class="toolbar-note">${cm.updatedAt ? "更新: " + esc(cm.updatedAt.slice(0, 16).replace("T", " ")) : ""}</span>
              <span class="spacer"></span>
              <button type="button" class="primary" data-action="save-comment" data-company="${company.id}" data-fy="${ctx.fy}" data-q="${ctx.q}">コメント・株価を保存</button>
            </div>
          </form>
          <div class="valuation" id="valuation-box">
            ${val ? `
              <span><b>実績PER</b> ${val.perActual ? val.perActual.toFixed(1) + "倍" : "—"}</span>
              <span><b>予想PER</b> ${val.perForecast ? val.perForecast.toFixed(1) + "倍" : "—"}</span>
              <span><b>PBR</b> ${val.pbr ? val.pbr.toFixed(2) + "倍" : "—"}</span>
              <span><b>配当利回り</b> ${val.dividendYield != null ? (val.dividendYield * 100).toFixed(2) + "%" : "—"}</span>
              <span><b>時価総額</b> ${fmtCap(val.marketCap)}</span>
              <span><b>EPS(TTM)</b> ${val.epsTTM ? val.epsTTM.toFixed(1) + "円" : "—"}</span>
              <span><b>BPS</b> ${val.bps ? val.bps.toFixed(0) + "円" : "—"}</span>
            ` : `<span class="dim">分析時株価を入力するとPER/PBR/配当利回りを計算します</span>`}
          </div>
        </div>
      </div>
    </div>`;

  document.getElementById("period-select").addEventListener("change", (e) => {
    ui.detailPeriodKey = e.target.value;
    render();
  });
  document.getElementById("detail-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (b) { ui.detailTab = b.dataset.tab; render(); }
  });
  const periodsSeg = document.getElementById("periods-seg");
  if (periodsSeg) periodsSeg.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-periods]");
    if (b) { ui.periods = Number(b.dataset.periods); render(); }
  });
  document.getElementById("table-mode-seg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-mode]");
    if (b) { ui.tableMode = b.dataset.mode; render(); }
  });

  renderDetailTab(rows, ctx, r);
}

// ---- タブ別コンテンツ(チャート/PDFビューア) ----

function chartTooltip() {
  return {
    callbacks: {
      label: (item) => {
        const v = item.raw;
        if (v == null) return `${item.dataset.label}: —`;
        return item.dataset.yAxisID === "y2"
          ? `${item.dataset.label}: ${fmtValue("percent1", v)}`
          : `${item.dataset.label}: ${fmtValue("mm", v)} 百万円`;
      },
    },
  };
}

function baseChartOpts() {
  const gridColor = cssVar("--border");
  const textColor = cssVar("--text-dim");
  Chart.defaults.color = textColor;
  Chart.defaults.borderColor = gridColor;
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: { legend: { labels: { boxWidth: 12 } }, tooltip: chartTooltip() },
  };
}

function pctAxis(extra = {}) {
  return {
    position: "right",
    grid: { drawOnChartArea: false },
    ticks: { callback: (v) => (v * 100).toFixed(0) + "%" },
    ...extra,
  };
}

function addChart(canvasId, config) {
  const el = document.getElementById(canvasId);
  if (el) charts.push(new Chart(el, config));
}

function metricSeries(view, id) {
  return view.map((c) => computeMetric(id, c));
}

const PALETTE = ["#4d9fff", "#2eb872", "#e0a52e", "#e05252", "#9d6fe0", "#4dc4c4", "#c47f4d", "#8b93a6"];

function renderDetailTab(rows, ctx) {
  const box = document.getElementById("tab-content");
  const view = ui.periods === 0 ? rows : rows.slice(-ui.periods);
  const labels = view.map((c) => c.label);
  const opts = baseChartOpts();

  if (ui.detailTab === "pl") {
    box.innerHTML = `
      <div class="chart-box"><canvas id="ch1"></canvas></div>
      <div class="chart-box"><canvas id="ch2"></canvas></div>
      <div class="chart-box"><canvas id="ch3"></canvas></div>`;
    addChart("ch1", {
      data: { labels, datasets: [
        { type: "bar", label: "売上高(単Q)", yAxisID: "y", data: metricSeries(view, "salesQ"), backgroundColor: "rgba(77,159,255,0.55)" },
        { type: "bar", label: "営業利益(単Q)", yAxisID: "y", data: metricSeries(view, "opIncomeQ"), backgroundColor: "rgba(46,184,114,0.6)" },
        { type: "bar", label: "純利益(単Q)", yAxisID: "y", data: metricSeries(view, "netIncomeQ"), backgroundColor: "rgba(157,111,224,0.6)" },
        { type: "line", label: "営業利益率", yAxisID: "y2", data: metricSeries(view, "opMargin"), borderColor: "#e0a52e", backgroundColor: "#e0a52e", tension: 0.25, spanGaps: true },
        { type: "line", label: "純利益率", yAxisID: "y2", data: metricSeries(view, "netMargin"), borderColor: "#e05252", backgroundColor: "#e05252", tension: 0.25, spanGaps: true },
      ]},
      options: { ...opts, scales: { y: { title: { display: true, text: "百万円" } }, y2: pctAxis() } },
    });
    addChart("ch2", {
      data: { labels, datasets: [
        { type: "line", label: "売上YoY", yAxisID: "y2", data: metricSeries(view, "yoySales"), borderColor: "#4d9fff", backgroundColor: "#4d9fff", tension: 0.25, spanGaps: true },
        { type: "line", label: "営利YoY", yAxisID: "y2", data: metricSeries(view, "yoyOpIncome"), borderColor: "#2eb872", backgroundColor: "#2eb872", tension: 0.25, spanGaps: true },
        { type: "line", label: "純利YoY", yAxisID: "y2", data: metricSeries(view, "yoyNetIncome"), borderColor: "#9d6fe0", backgroundColor: "#9d6fe0", tension: 0.25, spanGaps: true },
      ]},
      options: { ...opts, scales: { y: { display: false }, y2: pctAxis({ position: "left", grid: { drawOnChartArea: true } }) } },
    });
    addChart("ch3", {
      data: { labels, datasets: [
        { type: "bar", label: "進捗率(純利)", yAxisID: "y2", data: metricSeries(view, "progressNI"), backgroundColor: "rgba(77,159,255,0.5)" },
        { type: "line", label: "基準線(Q×25%)", yAxisID: "y2", data: view.map((c) => c.q * 0.25), borderColor: "#8b93a6", borderDash: [6, 4], pointRadius: 0 },
      ]},
      options: { ...opts, scales: { y: { display: false }, y2: pctAxis({ position: "left", grid: { drawOnChartArea: true }, suggestedMax: 1.1 }) } },
    });
  } else if (ui.detailTab === "bs") {
    box.innerHTML = `
      <div class="chart-box"><canvas id="ch1"></canvas></div>
      <div class="chart-box"><canvas id="ch2"></canvas></div>
      <div class="chart-box"><canvas id="ch3"></canvas></div>`;
    addChart("ch1", {
      data: { labels, datasets: [
        { type: "bar", label: "総資産", yAxisID: "y", data: view.map((c) => c.bs.totalAssets), backgroundColor: "rgba(77,159,255,0.45)" },
        { type: "bar", label: "純資産", yAxisID: "y", data: view.map((c) => c.bs.netAssets ?? c.bs.equity), backgroundColor: "rgba(46,184,114,0.55)" },
        { type: "line", label: "自己資本比率", yAxisID: "y2", data: metricSeries(view, "equityRatio"), borderColor: "#e0a52e", backgroundColor: "#e0a52e", tension: 0.25, spanGaps: true },
      ]},
      options: { ...opts, scales: { y: { title: { display: true, text: "百万円" } }, y2: pctAxis({ suggestedMin: 0 }) } },
    });
    addChart("ch2", {
      data: { labels, datasets: [
        { type: "bar", label: "現金", yAxisID: "y", data: metricSeries(view, "cashAndDebt"), backgroundColor: "rgba(46,184,114,0.55)" },
        { type: "bar", label: "有利子負債", yAxisID: "y", data: view.map((c) => c.bs.interestBearingDebt), backgroundColor: "rgba(224,82,82,0.55)" },
      ]},
      options: { ...opts, scales: { y: { title: { display: true, text: "百万円" } } } },
    });
    addChart("ch3", {
      data: { labels, datasets: [
        { type: "bar", label: "棚卸資産", yAxisID: "y", data: view.map((c) => c.bs.inventory), backgroundColor: "rgba(224,165,46,0.55)" },
      ]},
      options: { ...opts, scales: { y: { title: { display: true, text: "百万円" } } } },
    });
  } else if (ui.detailTab === "cf") {
    box.innerHTML = `<div class="chart-box chart-tall"><canvas id="ch1"></canvas></div>`;
    addChart("ch1", {
      data: { labels, datasets: [
        { type: "bar", label: "営業CF(単Q)", yAxisID: "y", data: metricSeries(view, "operatingCFQ"), backgroundColor: "rgba(46,184,114,0.6)" },
        { type: "bar", label: "投資CF(単Q)", yAxisID: "y", data: metricSeries(view, "investingCFQ"), backgroundColor: "rgba(224,82,82,0.55)" },
        { type: "bar", label: "財務CF(単Q)", yAxisID: "y", data: metricSeries(view, "financingCFQ"), backgroundColor: "rgba(139,147,166,0.5)" },
        { type: "line", label: "フリーCF(単Q)", yAxisID: "y", data: metricSeries(view, "fcfQ"), borderColor: "#e0a52e", backgroundColor: "#e0a52e", tension: 0.25, spanGaps: true },
      ]},
      options: { ...opts, scales: { y: { title: { display: true, text: "百万円" } } } },
    });
  } else if (ui.detailTab === "seg") {
    renderSegmentTab(box, view, labels, opts, ctx);
  } else if (ui.detailTab === "pdf") {
    renderPdfTab(box, ctx);
  }
}

function segName(s) {
  return (s.name || "").trim();
}

function renderSegmentTab(box, view, labels, opts, ctx) {
  const names = [...new Set(view.flatMap((c) => c.segments.map(segName)).filter(Boolean))];
  if (!names.length) {
    box.innerHTML = `<div class="empty-state"><p>セグメント情報がありません。<br>短信PDFの抽出で取得できなかった場合は、期次入力フォームのセグメント欄から手動で追加できます。</p></div>`;
    return;
  }
  box.innerHTML = `
    <div class="chart-box"><canvas id="ch1"></canvas></div>
    <div class="chart-box"><canvas id="ch2"></canvas></div>
    <div class="table-wrap" id="seg-table"></div>`;
  const segOf = (c, name) => c.segments.find((s) => segName(s) === name);
  addChart("ch1", {
    data: { labels, datasets: names.map((name, i) => ({
      type: "bar", label: name, yAxisID: "y",
      data: view.map((c) => segOf(c, name)?.sales ?? null),
      backgroundColor: PALETTE[i % PALETTE.length] + "99", stack: "sales",
    })) },
    options: { ...opts, plugins: { ...opts.plugins, title: { display: true, text: "セグメント別売上(累計)" } }, scales: { x: { stacked: true }, y: { stacked: true, title: { display: true, text: "百万円" } } } },
  });
  addChart("ch2", {
    data: { labels, datasets: names.map((name, i) => ({
      type: "line", label: name, yAxisID: "y2",
      data: view.map((c) => {
        const s = segOf(c, name);
        return s ? ratio(s.profit, s.sales) : null;
      }),
      borderColor: PALETTE[i % PALETTE.length], backgroundColor: PALETTE[i % PALETTE.length], tension: 0.25, spanGaps: true,
    })) },
    options: { ...opts, plugins: { ...opts.plugins, title: { display: true, text: "セグメント別利益率" } }, scales: { y: { display: false }, y2: pctAxis({ position: "left", grid: { drawOnChartArea: true } }) } },
  });

  // 最新期のセグメントテーブル(構成比・YoY)
  const totalSales = ctx.segments.reduce((a, s) => a + (s.sales || 0), 0);
  const rowsHtml = ctx.segments.map((s) => {
    const prev = ctx.prevYearSegments.find((p) => segName(p) === segName(s));
    const yoy = prev && prev.sales ? (s.sales - prev.sales) / Math.abs(prev.sales) : null;
    return `<tr>
      <td>${esc(s.name)}</td>
      <td>${fmtValue("mm", s.sales)}</td>
      <td>${fmtValue("mm", s.profit)}</td>
      <td>${fmtValue("percent1", ratio(s.profit, s.sales))}</td>
      <td class="${heatClass(yoy)}">${fmtValue("percent1signed", yoy)}</td>
      <td>${totalSales ? fmtValue("percent1", (s.sales || 0) / totalSales) : "—"}</td>
    </tr>`;
  }).join("");
  document.getElementById("seg-table").innerHTML = `
    <table>
      <thead><tr><th>セグメント(${ctx.label})</th><th>売上高</th><th>利益</th><th>利益率</th><th>売上YoY</th><th>構成比</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>`;
}

async function renderPdfTab(box, ctx) {
  const r = ctx.record;
  const hasTanshin = !!r.docs?.tanshin?.pdfId;
  const hasSetsumei = !!r.docs?.setsumei?.pdfId;
  if (!hasTanshin && !hasSetsumei) {
    box.innerHTML = `<div class="empty-state"><p>この期に紐づくPDFがありません。上部の「短信PDF」「説明資料PDF」から添付してください。</p></div>`;
    return;
  }
  if (ui.pdfDocType === "tanshin" && !hasTanshin) ui.pdfDocType = "setsumei";
  if (ui.pdfDocType === "setsumei" && !hasSetsumei) ui.pdfDocType = "tanshin";

  box.innerHTML = `
    <div class="seg" id="pdf-doc-seg">
      <button data-doc="tanshin" ${hasTanshin ? "" : "disabled"} class="${ui.pdfDocType === "tanshin" ? "active" : ""}">決算短信</button>
      <button data-doc="setsumei" ${hasSetsumei ? "" : "disabled"} class="${ui.pdfDocType === "setsumei" ? "active" : ""}">決算説明資料</button>
    </div>
    <div id="pdf-viewer"></div>`;
  document.getElementById("pdf-doc-seg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-doc]");
    if (b && !b.disabled) { ui.pdfDocType = b.dataset.doc; render(); }
  });

  const pdfId = r.docs[ui.pdfDocType].pdfId;
  const entry = await getPdf(pdfId);
  const container = document.getElementById("pdf-viewer");
  if (!container) return;
  if (!entry) {
    container.innerHTML = `<p class="dim">PDFデータが見つかりません(IndexedDBから削除された可能性)</p>`;
    return;
  }
  pdfViewer = new PdfViewer(container);
  await pdfViewer.load(await entry.blob.arrayBuffer());
}

// ---------------------------------------------------------------------------
// PDF取り込み(手動アップロード/スケジュール取得の共通パイプライン)
// ---------------------------------------------------------------------------

async function handleAttach(e, docTypeHint) {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  // 詳細画面からの添付は表示中の期を既定とする(PDF側で期が判定できればそちらを優先)
  let fy = null, q = null;
  const company = companyById(ui.companyId);
  if (company) {
    const rows = derivedFor(company);
    const ctx = detailCtx(rows);
    if (ctx) { fy = ctx.fy; q = ctx.q; }
  }
  await importPdfFile(file, { docTypeHint, source: "manual", companyId: ui.companyId, fy, q });
}

// silent=true: 確認モーダルを開かず抽出値を直接保存(一括取得用。抽出値はextractedとして記録され、後から確認できる)
async function importPdfFile(file, { docTypeHint, source, companyId, scheduleRow, silent = false, fy: fyHint = null, q: qHint = null }) {
  let parsed;
  try {
    parsed = await parsePdf(await file.arrayBuffer());
  } catch (err) {
    alert(`PDFの解析に失敗しました: ${err.message}\n手動入力で続行できます。`);
    parsed = { meta: { docType: docTypeHint || "unknown" }, fields: {}, segments: [] };
  }
  const meta = parsed.meta;
  const docType = meta.docType === "unknown" ? (docTypeHint || "setsumei") : meta.docType;

  // 銘柄の解決(添付先指定 > コード一致 > 自動登録)
  let company = companyId ? companyById(companyId) : null;
  if (!company && meta.code) company = companyByCode(meta.code);
  if (!company && scheduleRow) company = companyByCode(scheduleRow.code);
  if (!company) {
    const code = meta.code || scheduleRow?.code;
    if (!code) {
      alert("PDFから証券コードを特定できませんでした。先に銘柄を登録し、銘柄詳細画面から添付してください。");
      return;
    }
    company = {
      id: `c_${code}`, code,
      name: meta.companyName || scheduleRow?.name || code,
      sector: scheduleRow?.sector || "", market: scheduleRow?.market || "",
      tags: [], fiscalYearEnd: meta.fiscalYearEnd || 3,
      nextEarningsDate: null, memo: "",
      marketCap: scheduleRow?.marketCap ?? null,
      createdAt: new Date().toISOString(),
    };
    state.companies.push(company);
  }
  if (meta.fiscalYearEnd && company.fiscalYearEnd !== meta.fiscalYearEnd) {
    company.fiscalYearEnd = meta.fiscalYearEnd;
  }

  // 期の解決(PDFの自動判定 > 添付元の指定 > スケジュール行)
  let fy = meta.fiscalYear ?? fyHint ?? scheduleRow?.fiscalYear;
  let q = meta.quarter ?? qHint ?? scheduleRow?.quarter;
  if (fy == null || q == null) {
    const next = suggestNextPeriod(company);
    fy ??= next.fy;
    q ??= next.q;
  }

  // PDF本体をIndexedDBへ
  const pdfId = `pdf_${company.code}_${periodKey(fy, q)}_${docType}`;
  await putPdf(pdfId, file, { fileName: file.name, docType });
  const docInfo = { pdfId, fileName: file.name, source, fetchedAt: new Date().toISOString() };

  if (docType === "setsumei") {
    // 説明資料: 数値抽出せず紐づけのみ(05_v2設計書 §4.3)
    let record = findRecord(company.id, fy, q);
    if (!record) {
      record = emptyRecord(company.id, fy, q);
      state.records.push(record);
    }
    record.docs.setsumei = docInfo;
    if (meta.announcedDate) record.docs.announcedDate ??= meta.announcedDate;
    record.updatedAt = new Date().toISOString();
    saveState();
    ui.view = "detail";
    ui.companyId = company.id;
    ui.detailPeriodKey = periodKey(fy, q);
    ui.detailTab = "pdf";
    ui.pdfDocType = "setsumei";
    render();
    return;
  }

  if (silent) {
    // 一括取得: 抽出値を直接保存(後から期次テーブル→編集で確認できる)
    let record = findRecord(company.id, fy, q);
    if (!record) {
      record = emptyRecord(company.id, fy, q);
      state.records.push(record);
    }
    for (const [path, ex] of Object.entries(parsed.fields)) {
      setPath(record, path, ex.value);
    }
    if (parsed.segments.length) record.segments = parsed.segments;
    record.extracted = Object.keys(parsed.fields);
    record.docs.tanshin = docInfo;
    if (meta.announcedDate) record.docs.announcedDate = meta.announcedDate;
    record.updatedAt = new Date().toISOString();
    if (scheduleRow) {
      scheduleRow.tanshinStatus = "done";
      scheduleRow.fiscalYear ??= fy;
      scheduleRow.quarter ??= q;
    }
    saveState();
    render();
    return;
  }

  // 短信: 抽出値をフォームへプリフィル→確認・保存
  saveState();
  openRecordModal(company.id, fy, q, {
    fields: parsed.fields,
    segments: parsed.segments,
    docInfo,
    announcedDate: meta.announcedDate,
    scheduleRow,
  });
}

// 汎用アップロード(ホーム空状態などから)
function openUploadAny() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/pdf";
  input.onchange = () => {
    if (input.files[0]) importPdfFile(input.files[0], { docTypeHint: "tanshin", source: "manual" });
  };
  input.click();
}

// ---------------------------------------------------------------------------
// モーダル共通
// ---------------------------------------------------------------------------

function openModal(html, wide = false) {
  $modalRoot.innerHTML = `<div class="modal-overlay"><div class="modal ${wide ? "modal-wide" : ""}">${html}</div></div>`;
  $modalRoot.querySelector(".modal-overlay").addEventListener("mousedown", (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
}

function closeModal() {
  $modalRoot.innerHTML = "";
}

// ---- 銘柄登録・編集モーダル ----

function openCompanyModal(companyId) {
  const c = companyId ? companyById(companyId) : null;
  openModal(`
    <h2>${c ? "銘柄を編集" : "銘柄を追加"}</h2>
    <form id="company-form" class="form-grid">
      <div class="field">
        <label>証券コード *</label>
        <input name="code" required value="${esc(c?.code || "")}" ${c ? "readonly" : ""} inputmode="numeric" placeholder="7203">
      </div>
      <div class="field">
        <label>銘柄名 *</label>
        <input name="name" required value="${esc(c?.name || "")}" placeholder="トヨタ自動車">
      </div>
      <div class="field">
        <label>セクタ(業種)</label>
        <input name="sector" value="${esc(c?.sector || "")}" list="sector-list" placeholder="輸送用機器">
        <datalist id="sector-list">
          ${[...new Set(state.companies.map((x) => x.sector).filter(Boolean))].map((s) => `<option value="${esc(s)}">`).join("")}
        </datalist>
      </div>
      <div class="field">
        <label>市場区分</label>
        <input name="market" value="${esc(c?.market || "")}" placeholder="プライム">
      </div>
      <div class="field">
        <label>タグ(カンマ区切り)</label>
        <input name="tags" value="${esc((c?.tags || []).join(", "))}" placeholder="保有, 監視">
      </div>
      <div class="field">
        <label>決算月</label>
        <select name="fiscalYearEnd">
          ${Array.from({ length: 12 }, (_, i) => i + 1).map((m) =>
            `<option value="${m}" ${(c?.fiscalYearEnd || 3) === m ? "selected" : ""}>${m}月</option>`).join("")}
        </select>
      </div>
      <div class="field">
        <label>次回決算予定日</label>
        <input name="nextEarningsDate" type="date" value="${esc(c?.nextEarningsDate || "")}">
      </div>
      <div class="field">
        <label>時価総額(百万円、スナップショット)</label>
        <input name="marketCap" inputmode="numeric" value="${esc(fmtInputNum(c?.marketCap))}">
      </div>
      <div class="field span2">
        <label>メモ</label>
        <textarea name="memo" rows="2">${esc(c?.memo || "")}</textarea>
      </div>
    </form>
    <div class="modal-actions">
      ${c ? `<button class="danger" data-action="delete-company" data-id="${c.id}">削除</button>` : ""}
      <span class="spacer"></span>
      <button data-action="close-modal">キャンセル</button>
      <button class="primary" data-action="save-company" data-id="${c?.id || ""}">保存</button>
    </div>
  `);
}

function saveCompany(companyId) {
  const form = document.getElementById("company-form");
  const f = new FormData(form);
  const code = String(f.get("code")).trim();
  const name = String(f.get("name")).trim();
  if (!code || !name) { alert("証券コードと銘柄名は必須です"); return; }
  if (!companyId && state.companies.some((c) => c.code === code)) {
    alert(`コード ${code} は登録済みです`);
    return;
  }
  const tags = String(f.get("tags")).split(/[,、]/).map((t) => t.trim()).filter(Boolean);
  const data = {
    code, name,
    sector: String(f.get("sector")).trim(),
    market: String(f.get("market")).trim(),
    tags,
    fiscalYearEnd: Number(f.get("fiscalYearEnd")),
    nextEarningsDate: f.get("nextEarningsDate") || null,
    marketCap: parseNum(f.get("marketCap")),
    memo: String(f.get("memo")),
  };
  if (companyId) {
    Object.assign(companyById(companyId), data);
  } else {
    state.companies.push({ id: `c_${code}`, ...data, createdAt: new Date().toISOString() });
  }
  saveState();
  closeModal();
  render();
}

async function deleteCompany(companyId) {
  const c = companyById(companyId);
  const recs = state.records.filter((r) => r.companyId === companyId);
  if (!confirm(`「${c.name}」を削除しますか?\n決算データ ${recs.length} 期分と添付PDFも削除されます。`)) return;
  for (const r of recs) {
    if (r.docs?.tanshin?.pdfId) await deletePdf(r.docs.tanshin.pdfId).catch(() => {});
    if (r.docs?.setsumei?.pdfId) await deletePdf(r.docs.setsumei.pdfId).catch(() => {});
  }
  state.companies = state.companies.filter((x) => x.id !== companyId);
  state.records = state.records.filter((r) => r.companyId !== companyId);
  saveState();
  closeModal();
  ui.view = "home";
  render();
}

// ---- 決算入力フォーム(PDF抽出プリフィル対応) ----

const RECORD_FIELDS = [
  { section: "PL(累計、百万円)" },
  { path: "pl.sales", label: "売上高" },
  { path: "pl.operatingIncome", label: "営業利益" },
  { path: "pl.ordinaryIncome", label: "経常利益(任意)" },
  { path: "pl.netIncome", label: "親会社株主に帰属する純利益" },
  { path: "pl.eps", label: "EPS(円、短信記載値)" },
  { section: "BS(百万円)" },
  { path: "bs.totalAssets", label: "総資産" },
  { path: "bs.netAssets", label: "純資産" },
  { path: "bs.equity", label: "自己資本" },
  { path: "bs.cash", label: "現金及び預金(任意)" },
  { path: "bs.interestBearingDebt", label: "有利子負債(任意)" },
  { path: "bs.inventory", label: "棚卸資産(任意)" },
  { path: "bs.receivables", label: "売上債権(任意)" },
  { path: "bs.payables", label: "仕入債務(任意)" },
  { section: "CF(累計、百万円)・株式数" },
  { path: "cf.operatingCF", label: "営業CF" },
  { path: "cf.investingCF", label: "投資CF" },
  { path: "cf.financingCF", label: "財務CF" },
  { path: "cf.cashEnd", label: "現金及び現金同等物期末残高" },
  { path: "shares.outstanding", label: "期末発行済株式数(自己株控除後、株)" },
  { section: "通期予想(百万円)・配当" },
  { path: "forecast.sales", label: "売上高(通期予想)" },
  { path: "forecast.operatingIncome", label: "営業利益(通期予想)" },
  { path: "forecast.netIncome", label: "純利益(通期予想)" },
  { path: "forecast.eps", label: "予想EPS(円)" },
  { path: "dividend.annualForecast", label: "年間配当予想(円)" },
];

function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? null : o[k]), obj);
}

function setPath(obj, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  const target = keys.reduce((o, k) => (o[k] ??= {}), obj);
  target[last] = value;
}

// prefill: { fields: {path: {value, sourceText, page}}, segments, docInfo, announcedDate, scheduleRow }
function openRecordModal(companyId, fy, q, prefill = null) {
  const company = companyById(companyId);
  const editing = fy != null && q != null ? findRecord(companyId, fy, q) : null;
  if (fy == null) {
    const next = suggestNextPeriod(company);
    fy = next.fy;
    q = next.q;
  }
  const record = editing || emptyRecord(companyId, fy, q);
  const prevYear = findRecord(companyId, fy - 1, q);
  const extractedPaths = prefill ? Object.keys(prefill.fields) : [];

  const fieldsHtml = RECORD_FIELDS.map((f) => {
    if (f.section) return `<div class="form-section">${esc(f.section)}</div>`;
    const ex = prefill?.fields[f.path];
    const value = ex ? ex.value : getPath(record, f.path);
    const prev = prevYear ? getPath(prevYear, f.path) : null;
    const isLocked = !!ex;
    return `<div class="field">
      <label>${esc(f.label)}${isLocked ? ' <span class="lock-mark" title="PDF抽出値(原則編集不可)">🔒抽出</span>' : ""}</label>
      <input data-path="${f.path}" inputmode="numeric" autocomplete="off"
        value="${esc(fmtInputNum(value))}" placeholder="—"
        ${isLocked ? `readonly data-locked="1" title="${esc(ex.sourceText || "")}"` : ""}>
      <span class="prev-value" data-prev="${prev ?? ""}">${prev != null ? `前年同期: ${fmtInputNum(prev)}` : "前年同期: —"}</span>
    </div>`;
  }).join("");

  const segments = prefill?.segments?.length ? prefill.segments : (record.segments || []);
  const segmentsHtml = `
    <div class="form-section">セグメント(累計、百万円)${prefill?.segments?.length ? " — PDF抽出" : ""}</div>
    <div class="field span2">
      <div id="segment-rows">
        ${segments.map((s) => segmentRowHtml(s)).join("")}
      </div>
      <button type="button" class="ghost" id="add-segment">＋セグメント行を追加</button>
    </div>`;

  const fyOptions = Array.from({ length: 12 }, (_, i) => fy - 8 + i);
  openModal(`
    <h2>${esc(company.name)} — 決算入力${editing ? "(編集)" : ""}${prefill ? "(PDF抽出結果の確認)" : ""}</h2>
    ${prefill ? `<p class="toolbar-note">🔒付きはPDF抽出値です(仕様上原則編集不可)。誤抽出の修正が必要な場合のみ下のトグルで解除してください。</p>
    <div class="check-row" style="margin-bottom:10px">
      <input type="checkbox" id="unlock-extracted">
      <label for="unlock-extracted">抽出値の編集を許可する(手動上書きモード)</label>
    </div>` : ""}
    <form id="record-form" class="form-grid">
      <div class="field">
        <label>会計年度(${company.fiscalYearEnd}月期)</label>
        <select name="fy" ${editing ? "disabled" : ""}>
          ${fyOptions.map((y) => `<option value="${y}" ${y === fy ? "selected" : ""}>${y}年${company.fiscalYearEnd}月期</option>`).join("")}
        </select>
      </div>
      <div class="field">
        <label>四半期</label>
        <select name="q" ${editing ? "disabled" : ""}>
          ${[1, 2, 3, 4].map((x) => `<option value="${x}" ${x === q ? "selected" : ""}>${QUARTER_LABEL[x]}</option>`).join("")}
        </select>
      </div>
      ${prefill?.announcedDate || record.docs?.announcedDate ? `
      <div class="field">
        <label>決算発表日</label>
        <input name="announcedDate" type="date" value="${esc(prefill?.announcedDate || record.docs?.announcedDate || "")}">
      </div>` : `
      <div class="field">
        <label>決算発表日(任意)</label>
        <input name="announcedDate" type="date" value="">
      </div>`}
      ${fieldsHtml}
      ${segmentsHtml}
      <div class="field span2 check-row">
        <input type="checkbox" id="forecast-revised" ${record.forecast.revised ? "checked" : ""}>
        <label for="forecast-revised">今回開示で通期予想の修正あり</label>
      </div>
      <div class="field span2 check-row">
        <input type="checkbox" id="buyback" ${record.dividend?.buyback ? "checked" : ""}>
        <label for="buyback">自社株買いあり</label>
        <input name="buybackAmount" inputmode="numeric" placeholder="金額(百万円)" style="max-width:140px" value="${esc(fmtInputNum(record.dividend?.buybackAmount))}">
        <input name="buybackShares" inputmode="numeric" placeholder="株数" style="max-width:140px" value="${esc(fmtInputNum(record.dividend?.buybackShares))}">
      </div>
      <div class="field span2">
        <label>メモ</label>
        <textarea name="note" rows="2">${esc(record.note || "")}</textarea>
      </div>
    </form>
    <div class="modal-actions">
      ${editing ? `<button class="danger" data-action="delete-record" data-id="${record.id}">この期を削除</button>` : ""}
      <span class="spacer"></span>
      <button data-action="close-modal">キャンセル</button>
      <button class="primary" data-action="save-record"
        data-company="${companyId}" data-editing="${editing ? "1" : ""}">確認して保存</button>
    </div>
  `, true);

  // プリフィル情報を保存処理へ引き継ぐ
  $modalRoot.querySelector(".modal").dataset.hasPrefill = prefill ? "1" : "";
  pendingPrefill = prefill;
  pendingExtractedPaths = extractedPaths;

  const unlock = document.getElementById("unlock-extracted");
  if (unlock) unlock.addEventListener("change", () => {
    for (const input of $modalRoot.querySelectorAll('input[data-locked="1"]')) {
      input.readOnly = !unlock.checked;
      input.classList.toggle("unlocked", unlock.checked);
    }
  });

  const addSeg = document.getElementById("add-segment");
  if (addSeg) addSeg.addEventListener("click", () => {
    document.getElementById("segment-rows").insertAdjacentHTML("beforeend", segmentRowHtml({}));
  });
  document.getElementById("segment-rows").addEventListener("click", (e) => {
    if (e.target.matches(".seg-del")) e.target.closest(".segment-row").remove();
  });

  const inputs = [...$modalRoot.querySelectorAll("input[data-path]")];
  inputs.forEach((input, idx) => {
    const check = () => {
      const v = parseNum(input.value);
      input.value = fmtInputNum(v);
      const prevRaw = input.parentElement.querySelector(".prev-value").dataset.prev;
      const prev = prevRaw === "" ? null : Number(prevRaw);
      const note = input.parentElement.querySelector(".attention-note");
      if (note) note.remove();
      input.classList.remove("attention");
      if (v != null && prev != null && prev !== 0 && Math.abs((v - prev) / Math.abs(prev)) > 0.5) {
        input.classList.add("attention");
        input.insertAdjacentHTML("afterend", `<span class="attention-note">前年同期比±50%超。原文と突合してください</span>`);
      }
    };
    input.addEventListener("blur", check);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        check();
        const next = inputs[idx + 1];
        if (next) next.focus();
        else $modalRoot.querySelector('[data-action="save-record"]').focus();
      }
    });
    check();
  });
}

function segmentRowHtml(s) {
  return `<div class="segment-row">
    <input class="seg-name" placeholder="セグメント名" value="${esc(s.name || "")}">
    <input class="seg-sales" inputmode="numeric" placeholder="売上高" value="${esc(fmtInputNum(s.sales))}">
    <input class="seg-profit" inputmode="numeric" placeholder="利益" value="${esc(fmtInputNum(s.profit))}">
    <button type="button" class="ghost seg-del">✕</button>
  </div>`;
}

let pendingPrefill = null;
let pendingExtractedPaths = [];

function saveRecord(companyId, isEditing) {
  const form = document.getElementById("record-form");
  const fy = Number(form.elements.fy.value);
  const q = Number(form.elements.q.value);

  let record = findRecord(companyId, fy, q);
  if (record && !isEditing && !pendingPrefill) {
    if (!confirm(`${periodLabel(fy, q)} は入力済みです。上書きしますか?`)) return;
  }
  if (!record) {
    record = emptyRecord(companyId, fy, q);
    state.records.push(record);
  }

  for (const input of form.querySelectorAll("input[data-path]")) {
    setPath(record, input.dataset.path, parseNum(input.value));
  }
  record.forecast.revised = document.getElementById("forecast-revised").checked;
  record.dividend.buyback = document.getElementById("buyback").checked;
  record.dividend.buybackAmount = parseNum(form.elements.buybackAmount.value);
  record.dividend.buybackShares = parseNum(form.elements.buybackShares.value);
  record.note = form.elements.note.value;

  record.segments = [...form.querySelectorAll(".segment-row")].map((row) => ({
    name: row.querySelector(".seg-name").value.trim(),
    sales: parseNum(row.querySelector(".seg-sales").value),
    profit: parseNum(row.querySelector(".seg-profit").value),
  })).filter((s) => s.name);

  const announced = form.elements.announcedDate?.value || null;
  if (announced) record.docs.announcedDate = announced;

  if (pendingPrefill) {
    record.extracted = pendingExtractedPaths;
    if (pendingPrefill.docInfo) record.docs.tanshin = pendingPrefill.docInfo;
    if (pendingPrefill.scheduleRow) {
      pendingPrefill.scheduleRow.tanshinStatus = "done";
      pendingPrefill.scheduleRow.fiscalYear ??= fy;
      pendingPrefill.scheduleRow.quarter ??= q;
    }
  }
  record.updatedAt = new Date().toISOString();
  pendingPrefill = null;
  pendingExtractedPaths = [];

  saveState();
  closeModal();
  ui.view = "detail";
  ui.companyId = companyId;
  ui.detailPeriodKey = periodKey(fy, q);
  render();
}

async function deleteRecord(recordId) {
  const r = state.records.find((x) => x.id === recordId);
  if (!r) return;
  if (!confirm(`${periodLabel(r.fiscalYear, r.quarter)} のデータを削除しますか?(添付PDFも削除)`)) return;
  if (r.docs?.tanshin?.pdfId) await deletePdf(r.docs.tanshin.pdfId).catch(() => {});
  if (r.docs?.setsumei?.pdfId) await deletePdf(r.docs.setsumei.pdfId).catch(() => {});
  state.records = state.records.filter((x) => x.id !== recordId);
  ui.detailPeriodKey = null;
  saveState();
  closeModal();
  render();
}

// ---- コメント・株価の保存(仕様8章・9章) ----

function saveComment(companyId, fy, q) {
  const form = document.getElementById("comment-form");
  let record = findRecord(companyId, fy, q);
  if (!record) {
    record = emptyRecord(companyId, fy, q);
    state.records.push(record);
  }
  const f = new FormData(form);
  record.comment = {
    text: String(f.get("text")),
    firstImpression: String(f.get("firstImpression")),
    good: String(f.get("good")),
    bad: String(f.get("bad")),
    next: String(f.get("next")),
    judgment: String(f.get("judgment")),
    priceReaction: String(f.get("priceReaction")),
    updatedAt: new Date().toISOString(),
  };
  record.prices = {
    analysis: parseNum(f.get("p_analysis")),
    preEarnings: parseNum(f.get("p_preEarnings")),
    postEarnings: parseNum(f.get("p_postEarnings")),
    target: parseNum(f.get("p_target")),
  };
  record.updatedAt = new Date().toISOString();
  saveState();
  render();
}

// ---------------------------------------------------------------------------
// 決算スケジュール(仕様11章〜13章)
// ---------------------------------------------------------------------------

function scheduleRowById(id) {
  return state.schedule.find((s) => s.id === id) || null;
}

function scheduleInPeriod(row) {
  const today = todayISO();
  if (ui.schedulePeriod === "past") {
    return row.date >= addDays(today, -7) && row.date <= today;
  }
  return row.date > today && row.date <= addDays(today, 31);
}

function scheduleAnnounced(row) {
  return row.announced || row.date < todayISO();
}

function filteredSchedule() {
  return state.schedule.filter((row) => {
    if (!scheduleInPeriod(row)) return false;
    if (ui.scheduleCap) {
      const band = CAP_BANDS.find((b) => b.id === ui.scheduleCap);
      if (!band) return true;
      if (row.marketCap == null) return false;
      if (!(row.marketCap >= band.min && row.marketCap < band.max)) return false;
    }
    if (ui.scheduleSearch) {
      const s = ui.scheduleSearch;
      if (!(row.code.includes(s) || (row.name || "").includes(s) || (row.sector || "").includes(s))) return false;
    }
    const rec = recordForScheduleRow(row);
    switch (ui.scheduleFilter) {
      case "announced": return scheduleAnnounced(row);
      case "unannounced": return !scheduleAnnounced(row);
      case "unanalyzed": return !recordAnalyzed(rec);
      case "uncommented": return !recordCommented(rec);
      case "checked": return row.checked;
      default: return true;
    }
  }).sort((a, b) => a.date.localeCompare(b.date) || a.code.localeCompare(b.code));
}

function statusBadge(status) {
  return `<span class="status status-${status}">${STATUS_LABEL[status] || status}</span>`;
}

function scheduleRowHtml(row, { withCheckbox = true } = {}) {
  const rec = recordForScheduleRow(row);
  const announced = scheduleAnnounced(row);
  const canFetch = announced && (row.tanshinUrl || row.setsumeiUrl);
  return `<tr data-schedule-id="${esc(row.id)}">
    ${withCheckbox ? `<td><input type="checkbox" class="sched-check" data-id="${esc(row.id)}" ${row.checked ? "checked" : ""}></td>` : ""}
    <td>${esc(row.date)}</td>
    <td>${announced ? '<span class="up">発表済み</span>' : '<span class="dim">未発表</span>'}</td>
    <td>${esc(row.code)}</td>
    <td class="cell-left">${esc(row.name)}</td>
    <td>${esc(row.market || "—")}</td>
    <td>${esc(row.sector || "—")}</td>
    <td>${fmtCap(row.marketCap)}</td>
    <td>${row.quarter ? QUARTER_LABEL[row.quarter] : "—"}</td>
    <td>${row.fiscalYear ? `${row.fiscalYear}年期` : "—"}</td>
    <td>${statusBadge(row.tanshinStatus)}</td>
    <td>${statusBadge(row.setsumeiStatus)}</td>
    <td>${recordAnalyzed(rec) ? "✅" : '<span class="dim">未</span>'}</td>
    <td>${recordCommented(rec) ? "💬" : '<span class="dim">未</span>'}</td>
    <td class="cell-actions">
      ${canFetch ? `<button data-action="fetch-pdf" data-id="${esc(row.id)}" ${row.tanshinStatus === "fetching" ? "disabled" : ""}>${row.tanshinStatus === "failed" ? "再取得" : "取得"}</button>` : ""}
      ${row.tanshinUrl ? `<a href="${esc(row.tanshinUrl)}" target="_blank" rel="noopener" class="open-link">開く</a>` : ""}
      ${rec ? `<button data-action="open-schedule-analysis" data-id="${esc(row.id)}">分析</button>` : ""}
    </td>
  </tr>`;
}

const SCHEDULE_HEADERS = `<th>発表日</th><th>状態</th><th>コード</th><th>会社名</th><th>市場</th><th>業種</th><th>時価総額</th><th>種別</th><th>決算期</th><th>短信</th><th>説明資料</th><th>分析</th><th>ｺﾒﾝﾄ</th><th></th>`;

function renderSchedule() {
  $topbar.innerHTML = `
    <h1>決算スケジュール</h1>
    <div class="seg" id="sched-period-seg">
      <button data-period="past" class="${ui.schedulePeriod === "past" ? "active" : ""}">過去1週間</button>
      <button data-period="future" class="${ui.schedulePeriod === "future" ? "active" : ""}">未来1ヶ月</button>
    </div>
    <button data-action="tdnet-update">TDnetから更新</button>
    <button data-action="schedule-import">CSVインポート</button>
    <button data-action="schedule-add">＋手動追加</button>
    <button data-action="settings" title="設定">⚙</button>
  `;
  document.getElementById("sched-period-seg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-period]");
    if (b) { ui.schedulePeriod = b.dataset.period; render(); }
  });

  const rows = filteredSchedule();
  $view.innerHTML = `
    <div class="filter-bar">
      <input type="search" id="sched-search" placeholder="コード・会社名・業種" value="${esc(ui.scheduleSearch)}">
      <select id="sched-cap">
        <option value="">時価総額: 全て</option>
        ${CAP_BANDS.map((b) => `<option value="${b.id}" ${ui.scheduleCap === b.id ? "selected" : ""}>${b.label}</option>`).join("")}
      </select>
      <select id="sched-filter">
        <option value="">絞り込みなし</option>
        <option value="announced" ${ui.scheduleFilter === "announced" ? "selected" : ""}>発表済みのみ</option>
        <option value="unannounced" ${ui.scheduleFilter === "unannounced" ? "selected" : ""}>未発表のみ</option>
        <option value="unanalyzed" ${ui.scheduleFilter === "unanalyzed" ? "selected" : ""}>未分析のみ</option>
        <option value="uncommented" ${ui.scheduleFilter === "uncommented" ? "selected" : ""}>コメント未保存のみ</option>
        <option value="checked" ${ui.scheduleFilter === "checked" ? "selected" : ""}>チェック済みのみ</option>
      </select>
      <span class="toolbar-note">${rows.length}件</span>
    </div>
    <div class="table-wrap">
      <table class="schedule-table">
        <thead><tr><th></th>${SCHEDULE_HEADERS}</tr></thead>
        <tbody>
          ${rows.map((r) => scheduleRowHtml(r)).join("") || `<tr><td colspan="16" class="dim">該当なし。「TDnetから更新」「CSVインポート」「＋手動追加」でスケジュールを取り込めます。</td></tr>`}
        </tbody>
      </table>
    </div>`;

  document.getElementById("sched-search").addEventListener("input", (e) => {
    ui.scheduleSearch = e.target.value;
    render();
    const el = document.getElementById("sched-search");
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  });
  document.getElementById("sched-cap").addEventListener("change", (e) => { ui.scheduleCap = e.target.value; render(); });
  document.getElementById("sched-filter").addEventListener("change", (e) => { ui.scheduleFilter = e.target.value; render(); });
  bindScheduleChecks();
}

function bindScheduleChecks() {
  for (const cb of $view.querySelectorAll(".sched-check")) {
    cb.addEventListener("change", () => {
      const row = scheduleRowById(cb.dataset.id);
      if (row) {
        row.checked = cb.checked;
        if (row.checked && row.tanshinStatus === "none") row.tanshinStatus = "pending";
        if (!row.checked && row.tanshinStatus === "pending") row.tanshinStatus = "none";
        saveState();
        render();
      }
    });
  }
}

// ---- チェック銘柄一覧(仕様12章) ----

function renderChecked() {
  const rows = state.schedule.filter((r) => r.checked)
    .sort((a, b) => a.date.localeCompare(b.date) || a.code.localeCompare(b.code));
  const failed = rows.filter((r) => r.tanshinStatus === "failed" || r.setsumeiStatus === "failed");
  $topbar.innerHTML = `
    <h1>チェック銘柄</h1>
    <span class="toolbar-note">${rows.length}銘柄</span>
    <button class="primary" data-action="fetch-all" ${rows.length ? "" : "disabled"}>チェック銘柄のPDFを一括取得</button>
    <button data-action="fetch-retry" ${failed.length ? "" : "disabled"}>取得失敗の再取得(${failed.length})</button>
    <button data-action="settings" title="設定">⚙</button>
  `;
  $view.innerHTML = `
    <div class="table-wrap">
      <table class="schedule-table">
        <thead><tr><th></th>${SCHEDULE_HEADERS}</tr></thead>
        <tbody>
          ${rows.map((r) => scheduleRowHtml(r)).join("") || `<tr><td colspan="16" class="dim">チェック済み銘柄がありません。スケジュール画面でチェックを付けてください。</td></tr>`}
        </tbody>
      </table>
    </div>
    <p class="toolbar-note">※PDFの直接取得は配信元のCORS設定により失敗する場合があります。その場合は「開く」でPDFを開き、ダウンロードして銘柄詳細画面から添付してください。</p>`;
  bindScheduleChecks();
}

// ---- TDnet API取得 ----

// yanoshin TDnet API形式( {items:[{Tdnet:{...}}]} )を想定。設定でベースURL変更可
async function tdnetUpdate() {
  const base = state.settings.scheduleApiBase;
  if (!base) { alert("設定でスケジュールAPIのURLを設定してください"); return; }
  const url = `${base.replace(/\/$/, "")}/list/recent.json?limit=300`;
  let data;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    alert(`TDnetからの取得に失敗しました: ${err.message}\n(ブラウザから到達できない場合はCSVインポートを利用してください)`);
    return;
  }
  const items = (data.items || []).map((i) => i.Tdnet || i);
  let added = 0, updated = 0;
  for (const item of items) {
    const title = item.title || "";
    const isTanshin = /決算短信/.test(title);
    const isSetsumei = /決算説明|決算補足/.test(title);
    if (!isTanshin && !isSetsumei) continue;
    const code = String(item.company_code || "").replace(/0$/, "").slice(0, 4);
    if (!/^\d{4}$/.test(code)) continue;
    const date = (item.pubdate || "").slice(0, 10);
    if (!date) continue;
    const m = title.match(/(\d{4})年(\d{1,2})月期(?:\s*第([1-3])四半期)?/);
    const fy = m ? Number(m[1]) : null;
    const q = m ? (m[3] ? Number(m[3]) : 4) : null;
    const id = `s_${code}_${date}`;
    let row = scheduleRowById(id);
    if (!row) {
      row = {
        id, code, name: item.company_name || code, date,
        sector: "", market: "", marketCap: null,
        fiscalYear: fy, quarter: q,
        announced: true, checked: false,
        tanshinUrl: null, setsumeiUrl: null,
        tanshinStatus: "unpublished", setsumeiStatus: "unpublished",
        source: "tdnet",
      };
      state.schedule.push(row);
      added++;
    } else {
      row.announced = true;
      updated++;
    }
    if (fy) { row.fiscalYear ??= fy; row.quarter ??= q; }
    const docUrl = item.document_url || item.url || null;
    if (isTanshin && docUrl) {
      row.tanshinUrl = docUrl;
      if (row.tanshinStatus === "unpublished" || row.tanshinStatus === "none") row.tanshinStatus = "none";
    }
    if (isSetsumei && docUrl) {
      row.setsumeiUrl = docUrl;
      if (row.setsumeiStatus === "unpublished") row.setsumeiStatus = "none";
    }
  }
  saveState();
  render();
  alert(`TDnet更新完了: 追加 ${added}件 / 更新 ${updated}件`);
}

// ---- PDF取得(fetch試行→失敗時フォールバック) ----

async function fetchSchedulePdf(row, silent = false) {
  const targets = [];
  if (row.tanshinUrl && row.tanshinStatus !== "done") targets.push(["tanshin", row.tanshinUrl]);
  if (row.setsumeiUrl && row.setsumeiStatus !== "done") targets.push(["setsumei", row.setsumeiUrl]);
  if (!targets.length) return;

  for (const [docType, url] of targets) {
    const statusKey = docType + "Status";
    row[statusKey] = "fetching";
    saveState();
    render();
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const file = new File([blob], url.split("/").pop() || `${row.code}_${docType}.pdf`, { type: "application/pdf" });
      row[statusKey] = "done";
      saveState();
      await importPdfFile(file, { docTypeHint: docType, source: "tdnet", scheduleRow: row, silent });
    } catch {
      row[statusKey] = "failed";
      saveState();
      render();
    }
  }
}

async function fetchAllChecked(onlyFailed = false) {
  const rows = state.schedule.filter((r) => {
    if (!r.checked || !scheduleAnnounced(r)) return false;
    const hasTarget = (r.tanshinUrl && r.tanshinStatus !== "done") || (r.setsumeiUrl && r.setsumeiStatus !== "done");
    if (!hasTarget) return false;
    if (onlyFailed) return r.tanshinStatus === "failed" || r.setsumeiStatus === "failed";
    return true;
  });
  if (!rows.length) { alert("取得対象がありません(未発表・URL不明・取得済みを除く)"); return; }
  for (const row of rows) {
    await fetchSchedulePdf(row, true);
  }
}

// ---- スケジュールCSVインポート / 手動追加 ----

// CSV形式: 日付,コード,会社名,市場,業種,時価総額(百万円),決算期(年),四半期(1-4)
function importScheduleCsv(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let count = 0;
  for (const line of lines) {
    const cols = line.split(",").map((c) => c.trim());
    if (cols.length < 3) continue;
    const [date, code, name, market, sector, cap, fy, q] = cols;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{4}$/.test(code)) continue;
    const id = `s_${code}_${date}`;
    let row = scheduleRowById(id);
    if (!row) {
      row = {
        id, code, name: name || code, date,
        sector: sector || "", market: market || "",
        marketCap: parseNum(cap),
        fiscalYear: parseNum(fy), quarter: parseNum(q),
        announced: date <= todayISO(), checked: false,
        tanshinUrl: null, setsumeiUrl: null,
        tanshinStatus: "none", setsumeiStatus: "none",
        source: "import",
      };
      state.schedule.push(row);
    } else {
      Object.assign(row, {
        name: name || row.name, market: market || row.market, sector: sector || row.sector,
        marketCap: parseNum(cap) ?? row.marketCap,
        fiscalYear: parseNum(fy) ?? row.fiscalYear, quarter: parseNum(q) ?? row.quarter,
      });
    }
    count++;
  }
  saveState();
  render();
  alert(`${count}件を取り込みました`);
}

function openScheduleImportModal() {
  openModal(`
    <h2>スケジュールCSVインポート</h2>
    <p class="toolbar-note">形式: 日付(YYYY-MM-DD),コード,会社名,市場,業種,時価総額(百万円),決算期(年),四半期(1-4)<br>
    例: 2026-08-05,7203,トヨタ自動車,プライム,輸送用機器,45000000,2027,1</p>
    <div class="field">
      <input type="file" id="sched-csv-file" accept=".csv,text/csv">
    </div>
    <div class="field" style="margin-top:10px">
      <label>またはテキストを貼り付け</label>
      <textarea id="sched-csv-text" rows="6" placeholder="2026-08-05,7203,トヨタ自動車,プライム,輸送用機器,45000000,2027,1"></textarea>
    </div>
    <div class="modal-actions">
      <span class="spacer"></span>
      <button data-action="close-modal">キャンセル</button>
      <button class="primary" id="sched-csv-import">インポート</button>
    </div>
  `);
  document.getElementById("sched-csv-import").addEventListener("click", async () => {
    const file = document.getElementById("sched-csv-file").files[0];
    const text = file ? await file.text() : document.getElementById("sched-csv-text").value;
    if (!text.trim()) { alert("CSVファイルまたはテキストを入力してください"); return; }
    closeModal();
    importScheduleCsv(text);
  });
}

function openScheduleAddModal() {
  openModal(`
    <h2>スケジュールを手動追加</h2>
    <form id="sched-add-form" class="form-grid">
      <div class="field"><label>発表予定日 *</label><input name="date" type="date" required value="${todayISO()}"></div>
      <div class="field"><label>証券コード *</label><input name="code" required inputmode="numeric" placeholder="7203"></div>
      <div class="field"><label>会社名 *</label><input name="name" required></div>
      <div class="field"><label>市場区分</label><input name="market" placeholder="プライム"></div>
      <div class="field"><label>業種</label><input name="sector"></div>
      <div class="field"><label>時価総額(百万円)</label><input name="cap" inputmode="numeric"></div>
      <div class="field"><label>決算期(年)</label><input name="fy" inputmode="numeric" placeholder="2027"></div>
      <div class="field"><label>四半期</label>
        <select name="q"><option value="">—</option>${[1, 2, 3, 4].map((x) => `<option value="${x}">${QUARTER_LABEL[x]}</option>`).join("")}</select>
      </div>
      <div class="field span2"><label>短信PDFのURL(任意)</label><input name="url" type="url" placeholder="https://..."></div>
    </form>
    <div class="modal-actions">
      <span class="spacer"></span>
      <button data-action="close-modal">キャンセル</button>
      <button class="primary" id="sched-add-save">追加</button>
    </div>
  `);
  document.getElementById("sched-add-save").addEventListener("click", () => {
    const f = new FormData(document.getElementById("sched-add-form"));
    const date = f.get("date"), code = String(f.get("code")).trim(), name = String(f.get("name")).trim();
    if (!date || !code || !name) { alert("発表予定日・コード・会社名は必須です"); return; }
    const id = `s_${code}_${date}`;
    if (scheduleRowById(id)) { alert("同じ銘柄・日付の行が既にあります"); return; }
    state.schedule.push({
      id, code, name, date,
      market: String(f.get("market")).trim(), sector: String(f.get("sector")).trim(),
      marketCap: parseNum(f.get("cap")),
      fiscalYear: parseNum(f.get("fy")), quarter: parseNum(f.get("q")),
      announced: date <= todayISO(), checked: false,
      tanshinUrl: String(f.get("url")).trim() || null, setsumeiUrl: null,
      tanshinStatus: "none", setsumeiStatus: "none",
      source: "manual",
    });
    saveState();
    closeModal();
    render();
  });
}

// ---------------------------------------------------------------------------
// 保存済み分析一覧(仕様14章)
// ---------------------------------------------------------------------------

function renderSaved() {
  $topbar.innerHTML = `
    <h1>保存済み分析</h1>
    <input type="search" id="saved-search" placeholder="コード・会社名・コメント内容" value="${esc(ui.savedSearch)}">
    <select id="saved-quarter">
      <option value="">全種別</option>
      ${[1, 2, 3, 4].map((x) => `<option value="${x}" ${ui.savedQuarter === String(x) ? "selected" : ""}>${QUARTER_LABEL[x]}</option>`).join("")}
    </select>
    <select id="saved-comment">
      <option value="">コメント: 全て</option>
      <option value="yes" ${ui.savedComment === "yes" ? "selected" : ""}>あり</option>
      <option value="no" ${ui.savedComment === "no" ? "selected" : ""}>なし</option>
    </select>
    <button data-action="settings" title="設定">⚙</button>
  `;

  const derivedCache = new Map();
  const ctxOf = (r) => {
    const c = companyById(r.companyId);
    if (!c) return null;
    if (!derivedCache.has(c.id)) derivedCache.set(c.id, derivedFor(c));
    return derivedCache.get(c.id).find((x) => x.key === periodKey(r.fiscalYear, r.quarter)) || null;
  };

  let rows = state.records.slice();
  rows = rows.filter((r) => {
    const c = companyById(r.companyId);
    if (!c) return false;
    if (ui.savedQuarter && String(r.quarter) !== ui.savedQuarter) return false;
    if (ui.savedComment === "yes" && !recordCommented(r)) return false;
    if (ui.savedComment === "no" && recordCommented(r)) return false;
    if (ui.savedSearch) {
      const s = ui.savedSearch;
      const commentText = Object.values(r.comment || {}).filter((v) => typeof v === "string").join(" ");
      if (!(c.code.includes(s) || c.name.includes(s) || commentText.includes(s) || `${r.fiscalYear}`.includes(s))) return false;
    }
    return true;
  });
  rows.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));

  const rowsHtml = rows.map((r) => {
    const c = companyById(r.companyId);
    const ctx = ctxOf(r);
    const val = ctx ? valuation(ctx, r.prices?.analysis) : null;
    return `<tr class="clickable" data-action="open-saved" data-company="${c.id}" data-fy="${r.fiscalYear}" data-q="${r.quarter}">
      <td>${esc(c.code)}</td>
      <td class="cell-left">${esc(c.name)}</td>
      <td>${r.fiscalYear}年${c.fiscalYearEnd}月期</td>
      <td>${QUARTER_LABEL[r.quarter]}</td>
      <td>${esc(r.docs?.announcedDate || "—")}</td>
      <td>${fmtValue("mm", r.pl.sales)}</td>
      <td>${fmtValue("mm", r.pl.operatingIncome)}</td>
      <td>${fmtValue("mm", r.pl.netIncome)}</td>
      <td>${ctx ? fmtMetric("epsActual", ctx) : "—"}</td>
      <td>${r.prices?.analysis != null ? fmtInputNum(r.prices.analysis) + "円" : "—"}</td>
      <td>${val?.perActual ? val.perActual.toFixed(1) + "倍" : "—"}</td>
      <td>${val?.dividendYield != null ? (val.dividendYield * 100).toFixed(2) + "%" : "—"}</td>
      <td>${recordCommented(r) ? "💬" : '<span class="dim">—</span>'}</td>
      <td>${esc((r.updatedAt || "").slice(0, 10))}</td>
    </tr>`;
  }).join("");

  $view.innerHTML = `
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>コード</th><th>会社名</th><th>決算期</th><th>種別</th><th>発表日</th>
          <th>売上高</th><th>営利</th><th>純利</th><th>EPS</th><th>入力株価</th><th>PER</th><th>利回り</th><th>ｺﾒﾝﾄ</th><th>更新日</th>
        </tr></thead>
        <tbody>${rowsHtml || `<tr><td colspan="14" class="dim">保存済みの分析がありません</td></tr>`}</tbody>
      </table>
    </div>`;

  document.getElementById("saved-search").addEventListener("input", (e) => {
    ui.savedSearch = e.target.value;
    render();
    const el = document.getElementById("saved-search");
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  });
  document.getElementById("saved-quarter").addEventListener("change", (e) => { ui.savedQuarter = e.target.value; render(); });
  document.getElementById("saved-comment").addEventListener("change", (e) => { ui.savedComment = e.target.value; render(); });
}

// ---------------------------------------------------------------------------
// 設定(エクスポート / インポート)
// ---------------------------------------------------------------------------

function openSettingsModal() {
  openModal(`
    <h2>設定</h2>
    <div class="settings-block">
      <h3>表示</h3>
      <div class="form-grid">
        <div class="field">
          <label>テーマ</label>
          <select id="setting-theme">
            ${[["dark", "ダーク"], ["light", "ライト"], ["auto", "自動"]].map(([v, l]) =>
              `<option value="${v}" ${state.settings.theme === v ? "selected" : ""}>${l}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label>標準表示期数</label>
          <select id="setting-periods">
            ${[[8, "8期"], [12, "12期"], [0, "全期間"]].map(([v, l]) =>
              `<option value="${v}" ${state.settings.defaultPeriods === v ? "selected" : ""}>${l}</option>`).join("")}
          </select>
        </div>
        <div class="field span2">
          <label>スケジュールAPI ベースURL(TDnet互換)</label>
          <input id="setting-api" value="${esc(state.settings.scheduleApiBase || "")}">
        </div>
      </div>
    </div>
    <div class="settings-block">
      <h3>バックアップ</h3>
      <p>localStorageはブラウザデータ消去で消えます。エクスポートJSONが唯一の正式バックアップです(四半期ごとの取得を推奨)。※PDF本体は含まれません。</p>
      <button class="primary" data-action="export-json">JSONエクスポート</button>
    </div>
    <div class="settings-block">
      <h3>インポート(全置換)</h3>
      <p>現在のデータはすべて置き換えられます。実行前にエクスポートを取ってください。</p>
      <input type="file" id="import-file" accept=".json,application/json">
    </div>
    <div class="settings-block">
      <p>登録: ${state.companies.length} 銘柄 / ${state.records.length} 期分 / スケジュール ${state.schedule.length} 件</p>
    </div>
    <div class="modal-actions">
      <span class="spacer"></span>
      <button data-action="close-modal">閉じる</button>
    </div>
  `);

  document.getElementById("setting-theme").addEventListener("change", (e) => {
    state.settings.theme = e.target.value;
    saveState();
    applyTheme();
    render();
  });
  document.getElementById("setting-periods").addEventListener("change", (e) => {
    state.settings.defaultPeriods = Number(e.target.value);
    ui.periods = state.settings.defaultPeriods;
    saveState();
  });
  document.getElementById("setting-api").addEventListener("change", (e) => {
    state.settings.scheduleApiBase = e.target.value.trim();
    saveState();
  });
  document.getElementById("import-file").addEventListener("change", handleImport);
}

function exportJSON() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `kessan-board_${todayISO()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function handleImport(e) {
  const file = e.target.files[0];
  if (!file) return;
  let imported;
  try {
    imported = JSON.parse(await file.text());
  } catch {
    alert("JSONの読み込みに失敗しました");
    return;
  }
  if (typeof imported?.version !== "number" || !Array.isArray(imported.companies) || !Array.isArray(imported.records)) {
    alert("Kessan BoardのエクスポートJSONではありません(version / companies / records が必要)");
    return;
  }
  if (imported.version > CURRENT_VERSION) {
    alert(`このファイルは新しいバージョン(v${imported.version})のデータです。アプリを更新してください`);
    return;
  }
  if (!confirm(`インポートして全置換しますか?\n現在: ${state.companies.length}銘柄/${state.records.length}期 → ファイル: ${imported.companies.length}銘柄/${imported.records.length}期\n\n※現在のデータのバックアップが必要なら先にエクスポートしてください`)) {
    e.target.value = "";
    return;
  }
  state = migrate(imported);
  saveState();
  applyTheme();
  ui.view = "home";
  ui.companyId = null;
  ui.periods = state.settings.defaultPeriods;
  closeModal();
  render();
}

// ---------------------------------------------------------------------------
// イベントディスパッチ(data-action)
// ---------------------------------------------------------------------------

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const { action, id } = el.dataset;
  switch (action) {
    case "nav":
      ui.view = id;
      ui.companyId = null;
      render();
      break;
    case "go-home":
      ui.view = "home";
      ui.companyId = null;
      ui.detailPeriodKey = null;
      render();
      break;
    case "open-company":
      ui.view = "detail";
      ui.companyId = id;
      ui.tableMode = "sq";
      ui.detailTab = "pl";
      ui.detailPeriodKey = null;
      ui.periods = state.settings.defaultPeriods;
      render();
      break;
    case "add-company":
      openCompanyModal(null);
      break;
    case "edit-company":
      openCompanyModal(id);
      break;
    case "save-company":
      saveCompany(id || null);
      break;
    case "delete-company":
      deleteCompany(id);
      break;
    case "input-pending":
    case "input-record":
      openRecordModal(id, null, null);
      break;
    case "edit-record":
      openRecordModal(el.dataset.company, Number(el.dataset.fy), Number(el.dataset.q));
      break;
    case "save-record":
      saveRecord(el.dataset.company, el.dataset.editing === "1");
      break;
    case "delete-record":
      deleteRecord(id);
      break;
    case "save-comment":
      saveComment(el.dataset.company, Number(el.dataset.fy), Number(el.dataset.q));
      break;
    case "upload-any":
      openUploadAny();
      break;
    case "tdnet-update":
      tdnetUpdate();
      break;
    case "schedule-import":
      openScheduleImportModal();
      break;
    case "schedule-add":
      openScheduleAddModal();
      break;
    case "fetch-pdf": {
      const row = scheduleRowById(id);
      if (row) fetchSchedulePdf(row);
      break;
    }
    case "fetch-all":
      fetchAllChecked(false);
      break;
    case "fetch-retry":
      fetchAllChecked(true);
      break;
    case "open-schedule-analysis": {
      const row = scheduleRowById(id);
      const rec = row && recordForScheduleRow(row);
      if (rec) {
        ui.view = "detail";
        ui.companyId = rec.companyId;
        ui.detailPeriodKey = periodKey(rec.fiscalYear, rec.quarter);
        ui.detailTab = "pl";
        render();
      }
      break;
    }
    case "open-saved":
      ui.view = "detail";
      ui.companyId = el.dataset.company;
      ui.detailPeriodKey = periodKey(Number(el.dataset.fy), Number(el.dataset.q));
      ui.detailTab = "pl";
      render();
      break;
    case "settings":
      openSettingsModal();
      break;
    case "export-json":
      exportJSON();
      break;
    case "close-modal":
      pendingPrefill = null;
      pendingExtractedPaths = [];
      closeModal();
      break;
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});

// ---------------------------------------------------------------------------

applyTheme();
render();

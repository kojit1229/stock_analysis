// app.js — 状態管理・画面描画(Kessan Board M1: 手動入力フォーム+ダッシュボード)
import {
  METRICS,
  HOME_COLUMNS,
  metric,
  computeMetric,
  fmtMetric,
  fmtValue,
  heatClass,
  deriveCompany,
  periodKey,
  periodLabel,
} from "./metrics.js";

const STORAGE_KEY = "kessan-board-state-v1";
const CURRENT_VERSION = 1;

// ---------------------------------------------------------------------------
// 状態管理(バージョン付き単一ステート+マイグレーション)
// ---------------------------------------------------------------------------

function defaultState() {
  return {
    version: CURRENT_VERSION,
    settings: { theme: "dark", defaultPeriods: 8 },
    companies: [],
    records: [],
  };
}

function migrate(raw) {
  // 将来 version を上げる際はここに旧→新変換を追加する
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
  view: "home", // "home" | "detail"
  companyId: null,
  search: "",
  tag: "",
  sort: "code", // "code" | "recent"
  periods: state.settings.defaultPeriods,
  tableMode: "sq", // "sq" | "cum"
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

// "1,234" "▲123" "△123" "(123)" "-123" → number / 空 → null
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

function derivedFor(company) {
  return deriveCompany(company, state.records);
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

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
  return {
    id: `r_${c.code}_${periodKey(fy, q)}`,
    companyId,
    fiscalYear: fy,
    quarter: q,
    pl: { sales: null, operatingIncome: null, ordinaryIncome: null, netIncome: null },
    cf: { operatingCF: null },
    bs: { totalAssets: null, equity: null, interestBearingDebt: null },
    shares: { outstanding: null },
    forecast: { sales: null, operatingIncome: null, netIncome: null, dividend: null, revised: false },
    market: { price: null, priceDate: null },
    note: "",
    updatedAt: new Date().toISOString(),
  };
}

function findRecord(companyId, fy, q) {
  return state.records.find(
    (r) => r.companyId === companyId && r.fiscalYear === fy && r.quarter === q
  ) || null;
}

// 次に入力すべき期の提案: 最新入力期の翌Q。未入力なら決算月から当期を推定
function suggestNextPeriod(company) {
  const rows = derivedFor(company);
  if (rows.length > 0) {
    const last = rows[rows.length - 1];
    return last.q === 4 ? { fy: last.fy + 1, q: 1 } : { fy: last.fy, q: last.q + 1 };
  }
  const now = new Date();
  const fyEnd = company.fiscalYearEnd || 3;
  // 会計年度: 決算月で終わる12ヶ月。例: 3月期なら 2026-07 → 2027年3月期Q1
  const fy = now.getMonth() + 1 <= fyEnd ? now.getFullYear() : now.getFullYear() + 1;
  const monthsIntoFY = ((now.getMonth() + 1 - fyEnd - 1) + 12) % 12; // 期首からの経過月(0始まり)
  const q = Math.min(4, Math.floor(monthsIntoFY / 3) + 1);
  return { fy, q };
}

// ---------------------------------------------------------------------------
// レンダリング
// ---------------------------------------------------------------------------

const $topbar = document.getElementById("topbar");
const $view = document.getElementById("view");
const $modalRoot = document.getElementById("modal-root");
let charts = [];

function destroyCharts() {
  for (const ch of charts) ch.destroy();
  charts = [];
}

function render() {
  destroyCharts();
  if (ui.view === "detail" && companyById(ui.companyId)) {
    renderDetail();
  } else {
    ui.view = "home";
    renderHome();
  }
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
        <p>銘柄が未登録です。「＋銘柄追加」から始めてください。</p>
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
    </div>`;

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

// ---- 銘柄詳細ダッシュボード ----

const KPI_CARDS = [
  { valueId: "salesQ", yoyId: "yoySales", label: "売上高(単Q)", unit: "百万円" },
  { valueId: "opIncomeQ", yoyId: "yoyOpIncome", label: "営業利益(単Q)", unit: "百万円" },
  { valueId: "opMargin", yoyId: null, label: "営業利益率", unit: "" },
  { valueId: "roe", yoyId: null, label: "ROE(TTM)", unit: "" },
];

const TABLE_VALUE_COLS = [
  ["sales", "売上"],
  ["operatingIncome", "営利"],
  ["netIncome", "純利"],
  ["operatingCF", "営CF"],
];

function renderDetail() {
  const company = companyById(ui.companyId);
  const rows = derivedFor(company);
  const latest = rows.length ? rows[rows.length - 1] : null;

  $topbar.innerHTML = `
    <button class="ghost back" data-action="go-home">←</button>
    <div class="company-title">
      <span class="code">${esc(company.code)}</span>
      <h1>${esc(company.name)}</h1>
      ${(company.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}
      <span class="meta">${company.fiscalYearEnd}月期${company.sector ? " / " + esc(company.sector) : ""}</span>
    </div>
    <button class="primary" data-action="input-record" data-id="${company.id}">＋当期入力</button>
    <button data-action="edit-company" data-id="${company.id}" title="銘柄情報を編集">✎</button>
  `;

  if (!latest) {
    $view.innerHTML = `<div class="empty-state">
      <p>まだ決算データがありません。「＋当期入力」から入力してください。</p>
    </div>`;
    return;
  }

  const kpiHtml = KPI_CARDS.map((card) => {
    const value = fmtMetric(card.valueId, latest);
    let sub = "";
    if (card.yoyId) {
      const y = computeMetric(card.yoyId, latest);
      const cls = y == null ? "dim" : y >= 0 ? "up" : "down";
      const arrow = y == null ? "" : y >= 0 ? "↑" : "↓";
      sub = `<div class="kpi-sub ${cls}">${arrow} YoY ${fmtValue("percent1signed", y)}</div>`;
    }
    return `<div class="kpi-card">
      <div class="kpi-label">${esc(card.label)}</div>
      <div class="kpi-value">${value}${card.unit ? ` <span class="kpi-unit">${card.unit}</span>` : ""}</div>
      ${sub}
    </div>`;
  }).join("");

  const mode = ui.tableMode;
  const tableRows = rows.slice().reverse().map((c) => {
    const src = mode === "sq" ? c.sq : c.cum;
    const valueCells = TABLE_VALUE_COLS.map(([f]) =>
      `<td>${fmtValue("mm", src[f] ?? (mode === "sq" ? c.cum[f] : null))}</td>`
    ).join("");
    const ySales = c.yoy.sales.value;
    const yOI = c.yoy.operatingIncome.value;
    return `<tr class="clickable" data-action="edit-record" data-company="${company.id}" data-fy="${c.fy}" data-q="${c.q}">
      <td>${c.label}</td>
      ${valueCells}
      <td class="${heatClass(ySales)}">${fmtValue("percent1signed", ySales)}</td>
      <td class="${heatClass(yOI)}">${fmtValue("percent1signed", yOI)}</td>
      <td>${fmtMetric("opMargin", c)}</td>
      <td>${fmtMetric("progressNI", c)}</td>
    </tr>`;
  }).join("");

  $view.innerHTML = `
    <div class="kpi-grid">${kpiHtml}</div>
    <div class="dashboard">
      <div class="panel">
        <div class="panel-head">
          <h2>推移チャート</h2>
          <div class="seg" id="periods-seg">
            ${[[8, "8期"], [12, "12期"], [0, "全期間"]].map(([v, l]) =>
              `<button data-periods="${v}" class="${ui.periods === v ? "active" : ""}">${l}</button>`).join("")}
          </div>
        </div>
        <div class="chart-box"><canvas id="chart-main"></canvas></div>
        <div class="chart-box"><canvas id="chart-sub"></canvas></div>
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
            <thead><tr>
              <th>期</th>
              ${TABLE_VALUE_COLS.map(([, l]) => `<th>${l}</th>`).join("")}
              <th>売上YoY</th><th>営利YoY</th><th>営利率</th><th>進捗</th>
            </tr></thead>
            <tbody>${tableRows}</tbody>
          </table>
        </div>
        <p class="toolbar-note">単位: 百万円。行タップで編集。</p>
      </div>
    </div>`;

  document.getElementById("periods-seg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-periods]");
    if (b) { ui.periods = Number(b.dataset.periods); render(); }
  });
  document.getElementById("table-mode-seg").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-mode]");
    if (b) { ui.tableMode = b.dataset.mode; render(); }
  });

  renderCharts(rows);
}

function renderCharts(rows) {
  const view = ui.periods === 0 ? rows : rows.slice(-ui.periods);
  const labels = view.map((c) => c.label);
  const gridColor = cssVar("--border");
  const textColor = cssVar("--text-dim");
  Chart.defaults.color = textColor;
  Chart.defaults.borderColor = gridColor;
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;

  const commonOpts = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: { legend: { labels: { boxWidth: 12 } } },
  };

  const pctAxis = {
    position: "right",
    grid: { drawOnChartArea: false },
    ticks: { callback: (v) => (v * 100).toFixed(0) + "%" },
  };

  charts.push(new Chart(document.getElementById("chart-main"), {
    data: {
      labels,
      datasets: [
        {
          type: "bar", label: "売上高(単Q)", yAxisID: "y",
          data: view.map((c) => computeMetric("salesQ", c)),
          backgroundColor: "rgba(77, 159, 255, 0.55)",
        },
        {
          type: "bar", label: "営業利益(単Q)", yAxisID: "y",
          data: view.map((c) => computeMetric("opIncomeQ", c)),
          backgroundColor: "rgba(46, 184, 114, 0.6)",
        },
        {
          type: "line", label: "営業利益率", yAxisID: "y2",
          data: view.map((c) => computeMetric("opMargin", c)),
          borderColor: "#e0a52e", backgroundColor: "#e0a52e",
          tension: 0.25, spanGaps: true,
        },
      ],
    },
    options: {
      ...commonOpts,
      scales: {
        y: { title: { display: true, text: "百万円" } },
        y2: pctAxis,
      },
      plugins: {
        ...commonOpts.plugins,
        tooltip: {
          callbacks: {
            label: (item) => {
              const v = item.raw;
              if (v == null) return `${item.dataset.label}: —`;
              return item.dataset.yAxisID === "y2"
                ? `${item.dataset.label}: ${fmtValue("percent1", v)}`
                : `${item.dataset.label}: ${fmtValue("mm", v)} 百万円`;
            },
          },
        },
      },
    },
  }));

  charts.push(new Chart(document.getElementById("chart-sub"), {
    data: {
      labels,
      datasets: [
        {
          type: "bar", label: "営業CF(TTM)", yAxisID: "y",
          data: view.map((c) => computeMetric("ocfTTM", c)),
          backgroundColor: "rgba(139, 147, 166, 0.45)",
        },
        {
          type: "line", label: "自己資本比率", yAxisID: "y2",
          data: view.map((c) => computeMetric("equityRatio", c)),
          borderColor: "#4d9fff", backgroundColor: "#4d9fff",
          tension: 0.25, spanGaps: true,
        },
      ],
    },
    options: {
      ...commonOpts,
      scales: {
        y: { title: { display: true, text: "百万円" } },
        y2: { ...pctAxis, suggestedMin: 0 },
      },
      plugins: {
        ...commonOpts.plugins,
        tooltip: {
          callbacks: {
            label: (item) => {
              const v = item.raw;
              if (v == null) return `${item.dataset.label}: —`;
              return item.dataset.yAxisID === "y2"
                ? `${item.dataset.label}: ${fmtValue("percent1", v)}`
                : `${item.dataset.label}: ${fmtValue("mm", v)} 百万円`;
            },
          },
        },
      },
    },
  }));
}

// ---------------------------------------------------------------------------
// モーダル共通
// ---------------------------------------------------------------------------

function openModal(html) {
  $modalRoot.innerHTML = `<div class="modal-overlay"><div class="modal">${html}</div></div>`;
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
        <label>セクタ</label>
        <input name="sector" value="${esc(c?.sector || "")}" list="sector-list" placeholder="輸送用機器">
        <datalist id="sector-list">
          ${[...new Set(state.companies.map((x) => x.sector).filter(Boolean))].map((s) => `<option value="${esc(s)}">`).join("")}
        </datalist>
      </div>
      <div class="field">
        <label>市場</label>
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
    code,
    name,
    sector: String(f.get("sector")).trim(),
    market: String(f.get("market")).trim(),
    tags,
    fiscalYearEnd: Number(f.get("fiscalYearEnd")),
    nextEarningsDate: f.get("nextEarningsDate") || null,
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

function deleteCompany(companyId) {
  const c = companyById(companyId);
  const count = state.records.filter((r) => r.companyId === companyId).length;
  if (!confirm(`「${c.name}」を削除しますか?\n決算データ ${count} 期分も削除されます。`)) return;
  state.companies = state.companies.filter((x) => x.id !== companyId);
  state.records = state.records.filter((r) => r.companyId !== companyId);
  saveState();
  closeModal();
  ui.view = "home";
  render();
}

// ---- 決算入力フォーム(累計値入力、仕様書 §3.4 ステップ2相当) ----
// M1では手動入力のみ。M2でPDF抽出(ステップ1)をこのフォームへのプリフィルとして追加する。

const RECORD_FIELDS = [
  { section: "PL(累計、百万円)" },
  { path: "pl.sales", label: "売上高" },
  { path: "pl.operatingIncome", label: "営業利益" },
  { path: "pl.ordinaryIncome", label: "経常利益(任意)" },
  { path: "pl.netIncome", label: "親会社株主に帰属する純利益" },
  { section: "BS(百万円)" },
  { path: "bs.totalAssets", label: "総資産" },
  { path: "bs.equity", label: "自己資本" },
  { path: "bs.interestBearingDebt", label: "有利子負債(任意)" },
  { section: "CF・株式数" },
  { path: "cf.operatingCF", label: "営業CF(累計、百万円)" },
  { path: "shares.outstanding", label: "期末発行済株式数(自己株控除後、株)" },
  { section: "通期予想(百万円)" },
  { path: "forecast.sales", label: "売上高(通期予想)" },
  { path: "forecast.operatingIncome", label: "営業利益(通期予想)" },
  { path: "forecast.netIncome", label: "純利益(通期予想)" },
  { path: "forecast.dividend", label: "年間配当(円)" },
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

function openRecordModal(companyId, fy, q) {
  const company = companyById(companyId);
  const editing = fy != null && q != null ? findRecord(companyId, fy, q) : null;
  if (fy == null) {
    const next = suggestNextPeriod(company);
    fy = next.fy;
    q = next.q;
  }
  const record = editing || emptyRecord(companyId, fy, q);
  const prevYear = findRecord(companyId, fy - 1, q);

  const fieldsHtml = RECORD_FIELDS.map((f) => {
    if (f.section) return `<div class="form-section">${esc(f.section)}</div>`;
    const value = getPath(record, f.path);
    const prev = prevYear ? getPath(prevYear, f.path) : null;
    return `<div class="field">
      <label>${esc(f.label)}</label>
      <input data-path="${f.path}" inputmode="numeric" autocomplete="off"
        value="${esc(fmtInputNum(value))}" placeholder="—">
      <span class="prev-value" data-prev="${prev ?? ""}">${prev != null ? `前年同期: ${fmtInputNum(prev)}` : "前年同期: —"}</span>
    </div>`;
  }).join("");

  const fyOptions = Array.from({ length: 12 }, (_, i) => fy - 8 + i);
  openModal(`
    <h2>${esc(company.name)} — 決算入力${editing ? "(編集)" : ""}</h2>
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
          ${[1, 2, 3, 4].map((x) => `<option value="${x}" ${x === q ? "selected" : ""}>${x === 4 ? "Q4(本決算)" : "Q" + x}</option>`).join("")}
        </select>
      </div>
      ${fieldsHtml}
      <div class="field span2 check-row">
        <input type="checkbox" id="forecast-revised" ${record.forecast.revised ? "checked" : ""}>
        <label for="forecast-revised">今回開示で通期予想の修正あり</label>
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
  `);

  const inputs = [...$modalRoot.querySelectorAll("input[data-path]")];
  inputs.forEach((input, idx) => {
    // 桁区切り整形+前年同期比±50%超の注意ハイライト(仕様書 §3.4)
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

function saveRecord(companyId, isEditing) {
  const form = document.getElementById("record-form");
  const fy = Number(form.elements.fy.value);
  const q = Number(form.elements.q.value);

  let record = findRecord(companyId, fy, q);
  if (record && !isEditing) {
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
  record.note = form.elements.note.value;
  record.updatedAt = new Date().toISOString();

  saveState();
  closeModal();
  ui.view = "detail";
  ui.companyId = companyId;
  render();
}

function deleteRecord(recordId) {
  const r = state.records.find((x) => x.id === recordId);
  if (!r) return;
  if (!confirm(`${periodLabel(r.fiscalYear, r.quarter)} のデータを削除しますか?`)) return;
  state.records = state.records.filter((x) => x.id !== recordId);
  saveState();
  closeModal();
  render();
}

// ---- 設定(エクスポート / インポート、仕様書 §6.1) ----

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
      </div>
    </div>
    <div class="settings-block">
      <h3>バックアップ</h3>
      <p>localStorageはブラウザデータ消去で消えます。エクスポートJSONが唯一の正式バックアップです(四半期ごとの取得を推奨)。</p>
      <button class="primary" data-action="export-json">JSONエクスポート</button>
    </div>
    <div class="settings-block">
      <h3>インポート(全置換)</h3>
      <p>現在のデータはすべて置き換えられます。実行前にエクスポートを取ってください。</p>
      <input type="file" id="import-file" accept=".json,application/json">
    </div>
    <div class="settings-block">
      <p>登録: ${state.companies.length} 銘柄 / ${state.records.length} 期分</p>
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
    case "go-home":
      ui.view = "home";
      ui.companyId = null;
      render();
      break;
    case "open-company":
      ui.view = "detail";
      ui.companyId = id;
      ui.tableMode = "sq";
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
    case "settings":
      openSettingsModal();
      break;
    case "export-json":
      exportJSON();
      break;
    case "close-modal":
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

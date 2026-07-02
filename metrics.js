// metrics.js — 指標定義レジストリと期次データの導出(03_仕様書 §2, §4)
// 入力は累計値のみ(Q6-A)。単Q・TTM・全指標は表示のたびにここで算出し、保存しない。

// ---------------------------------------------------------------------------
// 基本ヘルパー
// ---------------------------------------------------------------------------

export function periodKey(fy, q) {
  return `${fy}Q${q}`;
}

export function periodLabel(fy, q) {
  return `${String(fy).slice(-2)}Q${q}`;
}

function n(v) {
  return typeof v === "number" && isFinite(v) ? v : null;
}

function sub(a, b) {
  a = n(a); b = n(b);
  return a === null || b === null ? null : a - b;
}

export function ratio(a, b) {
  a = n(a); b = n(b);
  return a === null || b === null || b === 0 ? null : a / b;
}

// YoY: 分母は絶対値(前年同期が赤字でも符号が反転しない)。前年同期が0/nullは算出不能
function yoy(cur, prev) {
  cur = n(cur); prev = n(prev);
  return cur === null || prev === null || prev === 0 ? null : (cur - prev) / Math.abs(prev);
}

// record から累計値をフラットに取り出す
const CUM_FIELDS = ["sales", "operatingIncome", "ordinaryIncome", "netIncome", "operatingCF"];

function cumOf(r) {
  if (!r) return {};
  return {
    sales: n(r.pl.sales),
    operatingIncome: n(r.pl.operatingIncome),
    ordinaryIncome: n(r.pl.ordinaryIncome),
    netIncome: n(r.pl.netIncome),
    operatingCF: n(r.cf.operatingCF),
  };
}

// ---------------------------------------------------------------------------
// 期次データの導出(仕様書 §1「単四半期値の導出」)
//   単Q(FY, q) = 累計(FY, q) − 累計(FY, q−1)   (q≥2。q=1 は累計そのもの)
//   TTM(FY, q) = 累計(FY, q) + 通期(FY−1) − 累計(FY−1, q)   (q=4 は通期そのもの)
// ---------------------------------------------------------------------------

export function deriveCompany(company, allRecords) {
  const rows = allRecords
    .filter((r) => r.companyId === company.id)
    .slice()
    .sort((a, b) => a.fiscalYear - b.fiscalYear || a.quarter - b.quarter);
  const byKey = new Map(rows.map((r) => [periodKey(r.fiscalYear, r.quarter), r]));

  const cumAt = (fy, q) => cumOf(byKey.get(periodKey(fy, q)));

  const sqAt = (fy, q) => {
    const cur = cumAt(fy, q);
    if (q === 1) return { ...cur };
    const prev = cumAt(fy, q - 1);
    const out = {};
    for (const f of CUM_FIELDS) out[f] = sub(cur[f], prev[f]);
    return out;
  };

  const ttmAt = (fy, q, field) => {
    const cur = cumAt(fy, q)[field];
    if (q === 4) return cur;
    const fyPrev = cumAt(fy - 1, 4)[field];
    const samePrev = cumAt(fy - 1, q)[field];
    if (cur === null || fyPrev === null || samePrev === null) return null;
    return cur + fyPrev - samePrev;
  };

  return rows.map((r) => {
    const { fiscalYear: fy, quarter: q } = r;
    const cum = cumAt(fy, q);
    const sq = sqAt(fy, q);
    const prevYearCum = cumAt(fy - 1, q);
    const prevYearSq = sqAt(fy - 1, q);

    // YoY: 単Qどうしで算出。単Qが揃わない期は累計どうしにフォールバック(basis で区別)
    const yoyOf = (field) => {
      const bySq = yoy(sq[field], prevYearSq[field]);
      if (bySq !== null) return { value: bySq, basis: "sq" };
      const byCum = yoy(cum[field], prevYearCum[field]);
      if (byCum !== null) return { value: byCum, basis: "cum" };
      return { value: null, basis: null };
    };

    return {
      record: r,
      fy,
      q,
      key: periodKey(fy, q),
      label: periodLabel(fy, q),
      cum,
      sq,
      prevYearCum,
      prevYearSq,
      ttm: {
        netIncome: ttmAt(fy, q, "netIncome"),
        operatingCF: ttmAt(fy, q, "operatingCF"),
        sales: ttmAt(fy, q, "sales"),
      },
      yoy: {
        sales: yoyOf("sales"),
        operatingIncome: yoyOf("operatingIncome"),
        netIncome: yoyOf("netIncome"),
      },
      bs: {
        totalAssets: n(r.bs.totalAssets),
        equity: n(r.bs.equity),
        interestBearingDebt: n(r.bs.interestBearingDebt),
      },
      shares: n(r.shares.outstanding),
      forecast: r.forecast,
      company,
    };
  });
}

// ---------------------------------------------------------------------------
// 表示フォーマット
// ---------------------------------------------------------------------------

const NEG = "▲";

function withComma(v) {
  return Math.abs(v).toLocaleString("ja-JP");
}

export function fmtValue(format, v) {
  v = n(v);
  if (v === null) return "—";
  switch (format) {
    case "mm": // 百万円
      return (v < 0 ? NEG : "") + withComma(Math.round(v));
    case "percent1": {
      const p = v * 100;
      return (p < 0 ? NEG : "") + Math.abs(p).toFixed(1) + "%";
    }
    case "percent1signed": {
      const p = v * 100;
      return (p < 0 ? NEG : "+") + Math.abs(p).toFixed(1) + "%";
    }
    case "percent0":
      return (v < 0 ? NEG : "") + Math.abs(v * 100).toFixed(0) + "%";
    case "x2":
      return (v < 0 ? NEG : "") + Math.abs(v).toFixed(2) + "倍";
    case "yen":
      return (v < 0 ? NEG : "") + withComma(Math.round(v * 100) / 100) + "円";
    default:
      return String(v);
  }
}

// YoYヒートマップの背景色クラス(±5/15/30%で3段階)
export function heatClass(v) {
  v = n(v);
  if (v === null) return "";
  const p = Math.abs(v * 100);
  const level = p >= 30 ? 3 : p >= 15 ? 2 : p >= 5 ? 1 : 0;
  if (level === 0) return "";
  return (v > 0 ? "heat-pos-" : "heat-neg-") + level;
}

// ---------------------------------------------------------------------------
// 指標レジストリ(仕様書 §4)— 一覧・ダッシュボード・テーブルはここを走査して描画する
// compute(ctx): deriveCompany が返す期次オブジェクトを受け取る
// ---------------------------------------------------------------------------

export const METRICS = [
  {
    id: "salesQ",
    label: "売上高(単Q)",
    group: "scale",
    format: "mm",
    compute: (c) => c.sq.sales ?? c.cum.sales,
  },
  {
    id: "opIncomeQ",
    label: "営業利益(単Q)",
    group: "scale",
    format: "mm",
    compute: (c) => c.sq.operatingIncome ?? c.cum.operatingIncome,
  },
  {
    id: "netIncomeQ",
    label: "純利益(単Q)",
    group: "scale",
    format: "mm",
    compute: (c) => c.sq.netIncome ?? c.cum.netIncome,
  },
  {
    id: "yoySales",
    label: "売上YoY",
    group: "growth",
    format: "percent1signed",
    heat: true,
    compute: (c) => c.yoy.sales.value,
  },
  {
    id: "yoyOpIncome",
    label: "営利YoY",
    group: "growth",
    format: "percent1signed",
    heat: true,
    compute: (c) => c.yoy.operatingIncome.value,
  },
  {
    id: "yoyNetIncome",
    label: "純利YoY",
    group: "growth",
    format: "percent1signed",
    heat: true,
    compute: (c) => c.yoy.netIncome.value,
  },
  {
    id: "opMargin",
    label: "営業利益率",
    group: "profitability",
    format: "percent1",
    compute: (c) =>
      ratio(c.sq.operatingIncome, c.sq.sales) ?? ratio(c.cum.operatingIncome, c.cum.sales),
  },
  {
    id: "netMargin",
    label: "純利益率",
    group: "profitability",
    format: "percent1",
    compute: (c) => ratio(c.sq.netIncome, c.sq.sales) ?? ratio(c.cum.netIncome, c.cum.sales),
  },
  {
    id: "roe",
    label: "ROE(TTM)",
    group: "profitability",
    format: "percent1",
    compute: (c) => ratio(c.ttm.netIncome, c.bs.equity),
  },
  {
    id: "epsTTM",
    label: "EPS(TTM)",
    group: "profitability",
    format: "yen",
    compute: (c) => {
      const eps = ratio(c.ttm.netIncome, c.shares);
      return eps === null ? null : eps * 1e6; // 百万円→円
    },
  },
  {
    id: "equityRatio",
    label: "自己資本比率",
    group: "soundness",
    format: "percent1",
    compute: (c) => ratio(c.bs.equity, c.bs.totalAssets),
  },
  {
    id: "de",
    label: "D/E",
    group: "soundness",
    format: "x2",
    compute: (c) => ratio(c.bs.interestBearingDebt, c.bs.equity),
  },
  {
    id: "ocfTTM",
    label: "営業CF(TTM)",
    group: "soundness",
    format: "mm",
    compute: (c) => c.ttm.operatingCF,
  },
  {
    id: "cfRatio",
    label: "CF/利益",
    group: "soundness",
    format: "x2",
    compute: (c) => ratio(c.ttm.operatingCF, c.ttm.netIncome),
  },
  {
    id: "progressNI",
    label: "進捗(純利)",
    group: "forecast",
    format: "percent0",
    compute: (c) => ratio(c.cum.netIncome, n(c.forecast?.netIncome)),
  },
  {
    id: "progressOI",
    label: "進捗(営利)",
    group: "forecast",
    format: "percent0",
    compute: (c) => ratio(c.cum.operatingIncome, n(c.forecast?.operatingIncome)),
  },
];

const byId = new Map(METRICS.map((m) => [m.id, m]));

export function metric(id) {
  return byId.get(id);
}

export function computeMetric(id, ctx) {
  const m = byId.get(id);
  return m ? m.compute(ctx) : null;
}

export function fmtMetric(id, ctx) {
  const m = byId.get(id);
  if (!m || !ctx) return "—";
  return fmtValue(m.format, m.compute(ctx));
}

// ホーム一覧の表示指標(5列固定、仕様書 §3.2)
export const HOME_COLUMNS = ["yoySales", "yoyOpIncome", "opMargin", "roe", "progressNI"];

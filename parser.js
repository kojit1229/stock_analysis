// parser.js — 決算短信PDFからの数値抽出(05_v2設計書 §4.3)
// pdf.js(vendor同梱)でテキスト+座標を取り出し、行復元→セクション判定→
// 単位行ベースの列マッピングでサマリーの値を抽出する。
// 抽出値は直接保存せず、必ず入力フォームでの確認を通す(03_仕様書 §3.5)。

const pdfjs = window.pdfjsLib;
pdfjs.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";

// ---------------------------------------------------------------------------
// テキスト行の復元
// ---------------------------------------------------------------------------

async function extractLines(doc, maxPages) {
  const pages = [];
  const count = Math.min(doc.numPages, maxPages);
  for (let p = 1; p <= count; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const rows = new Map(); // y(丸め) → items
    for (const item of content.items) {
      if (!item.str.trim()) continue;
      const y = Math.round(item.transform[5] / 3) * 3; // 3pt刻みでグルーピング
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push({ x: item.transform[4], w: item.width || 0, str: item.str.trim() });
    }
    const lines = [...rows.entries()]
      .sort((a, b) => b[0] - a[0]) // PDF座標は下が0、上から順に
      .map(([, items]) => {
        items.sort((a, b) => a.x - b.x);
        // pdf.jsは1文字ずつ別アイテムで返すことがあるため、x座標の間隔で語間を判定する
        let text = "";
        let prevEnd = null;
        for (const it of items) {
          if (prevEnd !== null && it.x - prevEnd > 1.5) text += " ";
          text += it.str;
          prevEnd = it.x + it.w;
        }
        return { text, items, page: p };
      });
    pages.push(lines);
  }
  return pages;
}

// ---------------------------------------------------------------------------
// 数値処理
// ---------------------------------------------------------------------------

const NUM_RE = /(?:△|▲|-)?\d[\d,]*(?:\.\d+)?/g;

function parseNum(tok) {
  const neg = /^[△▲-]/.test(tok);
  const v = Number(tok.replace(/^[△▲-]/, "").replace(/,/g, ""));
  if (!isFinite(v)) return null;
  return neg ? -v : v;
}

function numbersIn(text) {
  return (text.match(NUM_RE) || []).map((t) => ({ raw: t, value: parseNum(t) }));
}

// 単位行("百万円 % 百万円 % ..."など)から列タイプの並びを得る
function unitSequence(text) {
  const units = [];
  const re = /百万円|千円|円\s*銭|円銭|%|％|株/g;
  let m;
  while ((m = re.exec(text))) {
    const u = m[0].replace(/\s/g, "");
    units.push(u === "％" ? "%" : u === "円銭" ? "円" : u === "千円" ? "千円" : u);
  }
  return units;
}

// 行頭の期ラベル("2027年3月期第1四半期"等)を除去(内部の数字を値と誤認しないため)
function stripPeriodPrefix(text) {
  return text.replace(/^\s*\d{4}\s*年\s*\d{1,2}\s*月期\s*(?:第\s*[1-4]\s*四半期)?\s*(?:[((]?予想[))]?)?/, "");
}

// データ行の数値トークンを単位列に割り当て、金額単位の列だけをラベル順に返す
function pickByUnits(line, units, wanted) {
  const nums = numbersIn(stripPeriodPrefix(line.text));
  const out = [];
  for (let i = 0; i < units.length && i < nums.length; i++) {
    if (units[i] === wanted || (wanted === "百万円" && units[i] === "千円")) {
      let v = nums[i].value;
      if (v !== null && units[i] === "千円") v = v / 1000;
      out.push(v);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// メタ情報(表紙)
// ---------------------------------------------------------------------------

const TITLE_RE = /(\d{4})\s*年\s*(\d{1,2})\s*月期(?:\s*第\s*([1-3])\s*四半期)?\s*決算短信/;

function detectMeta(pages) {
  const meta = { docType: "unknown", code: null, fiscalYear: null, quarter: null, fiscalYearEnd: null, announcedDate: null, companyName: null };
  const flat = pages.flat();
  for (const line of flat.slice(0, 40)) {
    const t = line.text;
    const title = t.match(TITLE_RE);
    if (title && meta.fiscalYear === null) {
      meta.docType = "tanshin";
      meta.fiscalYear = Number(title[1]);
      meta.fiscalYearEnd = Number(title[2]);
      meta.quarter = title[3] ? Number(title[3]) : 4;
    }
    if (/決算説明|決算補足|決算プレゼン/.test(t) && meta.docType === "unknown") meta.docType = "setsumei";
    const code = t.match(/コード番号[^\d]*(\d{4}[0-9A-Z]?)/);
    if (code) meta.code = code[1];
    const name = t.match(/上場会社名\s*(.+?)(?:\s+上場取引所|$)/);
    if (name) meta.companyName = name[1].trim();
    const date = t.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
    if (date && !meta.announcedDate && meta.docType === "tanshin") {
      meta.announcedDate = `${date[1]}-${String(date[2]).padStart(2, "0")}-${String(date[3]).padStart(2, "0")}`;
    }
  }
  return meta;
}

// ---------------------------------------------------------------------------
// サマリーページのセクション抽出
// ---------------------------------------------------------------------------

// 現期のデータ行か("2027年3月期第1四半期" / 本決算・予想行は "2027年3月期" "通期")
function isCurrentPeriodRow(text, meta) {
  const { fiscalYear: fy, fiscalYearEnd: m, quarter: q } = meta;
  const t = text.replace(/\s/g, "");
  if (q === 4) return new RegExp(`^${fy}年${m}月期(?!.*(第[1-3]四半期|予想))`).test(t);
  return new RegExp(`^${fy}年${m}月期第${q}四半期`).test(t);
}

function findSection(lines, startRe, endRe) {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (startRe.test(lines[i].text.replace(/\s/g, ""))) { start = i; break; }
  }
  if (start < 0) return [];
  const out = [];
  for (let i = start; i < lines.length; i++) {
    if (i > start && endRe && endRe.test(lines[i].text.replace(/\s/g, ""))) break;
    out.push(lines[i]);
  }
  return out;
}

// セクション内で: ヘッダラベル行→単位行→現期データ行、の順に見つけて値を列順に返す
function extractTableValues(section, labelRe, meta, wanted = "百万円") {
  for (let i = 0; i < section.length; i++) {
    if (!labelRe.test(section[i].text.replace(/\s/g, ""))) continue;
    // ラベル行の直後にある単位行を探す
    for (let j = i + 1; j < Math.min(i + 3, section.length); j++) {
      const units = unitSequence(section[j].text);
      if (units.length === 0) continue;
      // 単位行以降の現期データ行
      for (let k = j + 1; k < Math.min(j + 4, section.length); k++) {
        if (isCurrentPeriodRow(section[k].text, meta) || /^通期/.test(section[k].text.replace(/\s/g, ""))) {
          return { values: pickByUnits(section[k], units, wanted), line: section[k] };
        }
      }
    }
  }
  return { values: [], line: null };
}

function field(value, line) {
  return value == null ? null : { value, sourceText: line ? line.text.slice(0, 120) : "", page: line ? line.page : null };
}

function extractSummary(pages, meta) {
  const lines = pages.slice(0, 2).flat();
  const fields = {};

  // (1) 連結経営成績: 売上高/営業利益/経常利益/純利益(百万円列)
  {
    const sec = findSection(lines, /経営成績/, /財政状態|配当の状況/);
    const { values, line } = extractTableValues(sec, /売上高.*営業利益/, meta);
    const [sales, oi, ord, ni] = values;
    if (sales != null) fields["pl.sales"] = field(sales, line);
    if (oi != null) fields["pl.operatingIncome"] = field(oi, line);
    if (ord != null) fields["pl.ordinaryIncome"] = field(ord, line);
    if (ni != null) fields["pl.netIncome"] = field(ni, line);
    // EPS行(円銭列)
    const eps = extractTableValues(sec, /1株当たり.*純利益/, meta, "円");
    if (eps.values[0] != null) fields["pl.eps"] = field(eps.values[0], eps.line);
  }

  // (2) 連結財政状態: 総資産/純資産(百万円)+自己資本比率(%)
  {
    const sec = findSection(lines, /財政状態/, /キャッシュ・?フロー|配当の状況/);
    const { values, line } = extractTableValues(sec, /総資産.*純資産/, meta);
    const [ta, na] = values;
    if (ta != null) fields["bs.totalAssets"] = field(ta, line);
    if (na != null) fields["bs.netAssets"] = field(na, line);
    // (参考)自己資本
    for (const l of sec) {
      const m = l.text.replace(/\s/g, "").match(/自己資本(?!比率).*?((?:△|▲)?\d[\d,]*)百万円/);
      if (m) { fields["bs.equity"] = field(parseNum(m[1]), l); break; }
    }
  }

  // (3) 連結キャッシュ・フロー: 営業/投資/財務/現金期末残高
  {
    const sec = findSection(lines, /キャッシュ・?フローの状況/, /配当の状況|業績予想/);
    const { values, line } = extractTableValues(sec, /営業活動.*投資活動/, meta);
    const [ocf, icf, fcf2, cash] = values;
    if (ocf != null) fields["cf.operatingCF"] = field(ocf, line);
    if (icf != null) fields["cf.investingCF"] = field(icf, line);
    if (fcf2 != null) fields["cf.financingCF"] = field(fcf2, line);
    if (cash != null) fields["cf.cashEnd"] = field(cash, line);
  }

  // 2. 配当の状況: (予想)行の合計(最終数値)を年間配当予想として取る
  {
    const sec = findSection(lines, /配当の状況/, /業績予想/);
    for (const l of sec) {
      if (/予想/.test(l.text) && new RegExp(`${meta.fiscalYear}`).test(l.text)) {
        const nums = numbersIn(l.text);
        if (nums.length) fields["dividend.annualForecast"] = field(nums[nums.length - 1].value, l);
        break;
      }
    }
    for (const l of sec) {
      const m = l.text.replace(/\s/g, "").match(/配当性向.*?(\d[\d.]*)[%％]/);
      if (m) { fields["dividend.payoutRatio"] = field(Number(m[1]) / 100, l); break; }
    }
  }

  // 3. 業績予想: 通期行(百万円列 + EPSは円銭列)
  {
    const sec = findSection(lines, /業績予想/, /注記事項|$^/);
    const { values, line } = extractTableValues(sec, /売上高.*営業利益/, meta);
    const [sales, oi, , ni] = values;
    if (sales != null) fields["forecast.sales"] = field(sales, line);
    if (oi != null) fields["forecast.operatingIncome"] = field(oi, line);
    if (ni != null) fields["forecast.netIncome"] = field(ni, line);
    const eps = extractTableValues(sec, /売上高.*営業利益/, meta, "円");
    if (eps.values[0] != null) fields["forecast.eps"] = field(eps.values[0], eps.line);
  }

  // 期末発行済株式数(自己株式を含む)− 期末自己株式数
  {
    let issued = null, treasury = null, srcLine = null;
    for (const l of pages.flat()) {
      const t = l.text.replace(/\s/g, "");
      if (/期末発行済株式数/.test(t)) {
        const m = t.match(/([\d,]+)株/);
        if (m) { issued = parseNum(m[1]); srcLine = l; }
      } else if (/期末自己株式数/.test(t)) {
        const m = t.match(/([\d,]+)株/);
        if (m) treasury = parseNum(m[1]);
      }
    }
    if (issued != null) {
      fields["shares.outstanding"] = field(issued - (treasury || 0), srcLine);
    }
  }

  return fields;
}

// ---------------------------------------------------------------------------
// BS本表(best-effort): ラベルにマッチした行の最終数値(当期末列)を取る
// ---------------------------------------------------------------------------

const BS_DETAIL_LABELS = [
  { path: "bs.cash", re: /^現金及び預金/ },
  { path: "bs.inventory", re: /^(棚卸資産|商品及び製品)/ },
  { path: "bs.receivables", re: /^(受取手形|売掛金|受取手形、売掛金及び契約資産|売上債権)/ },
  { path: "bs.payables", re: /^(支払手形|買掛金|支払手形及び買掛金|仕入債務)/ },
];

const DEBT_RE = /^(短期借入金|長期借入金|社債|1年内償還予定の社債|1年内返済予定の長期借入金|コマーシャル・ペーパー|リース債務)/;

function extractBsDetail(pages, fields) {
  let debtSum = null, debtLine = null;
  for (const lines of pages) {
    for (const l of lines) {
      const t = l.text.replace(/\s/g, "");
      for (const def of BS_DETAIL_LABELS) {
        if (fields[def.path]) continue;
        if (def.re.test(t)) {
          const nums = numbersIn(l.text);
          if (nums.length) fields[def.path] = field(nums[nums.length - 1].value, l);
        }
      }
      if (DEBT_RE.test(t)) {
        const nums = numbersIn(l.text);
        if (nums.length) {
          debtSum = (debtSum || 0) + (nums[nums.length - 1].value || 0);
          debtLine = l;
        }
      }
    }
  }
  if (debtSum != null && !fields["bs.interestBearingDebt"]) {
    fields["bs.interestBearingDebt"] = field(debtSum, debtLine);
  }
}

// ---------------------------------------------------------------------------
// セグメント情報(best-effort): 「セグメント情報」見出し以降の表から
// 名称+売上高+利益を行単位で拾う。「計/合計/調整額」は除外
// ---------------------------------------------------------------------------

const SEGMENT_STOP = /^(報告セグメント計|計|合計|調整額|セグメント間|その他の収益|顧客との契約)/;

function extractSegments(pages) {
  const segments = [];
  let inSection = false, headerSeen = false;
  for (const lines of pages) {
    for (const l of lines) {
      const t = l.text.replace(/\s/g, "");
      if (/セグメント情報/.test(t)) { inSection = true; headerSeen = false; continue; }
      if (!inSection) continue;
      if (/売上高/.test(t) && /(利益|損失)/.test(t)) { headerSeen = true; continue; }
      if (!headerSeen) continue;
      if (SEGMENT_STOP.test(t)) { inSection = false; continue; }
      // 名称(非数値)で始まり数値が2つ以上の行をセグメント行とみなす
      const m = l.text.match(/^([^\d△▲(]+?)\s+((?:△|▲)?\d[\d,]*.*)$/);
      if (!m) continue;
      const name = m[1].trim();
      if (name.length > 12 || /百万円|年|月期|注/.test(name)) continue;
      const nums = numbersIn(m[2]);
      if (nums.length < 2) continue;
      segments.push({ name, sales: nums[0].value, profit: nums[nums.length - 1].value });
      if (segments.length >= 10) return segments;
    }
  }
  return segments;
}

// ---------------------------------------------------------------------------
// エントリポイント
// ---------------------------------------------------------------------------

export async function parsePdf(arrayBuffer) {
  const doc = await pdfjs.getDocument({ data: arrayBuffer }).promise;
  const pages = await extractLines(doc, 30);
  const meta = detectMeta(pages);
  const result = { meta, fields: {}, segments: [], numPages: doc.numPages };

  if (meta.docType === "tanshin") {
    result.fields = extractSummary(pages, meta);
    extractBsDetail(pages.slice(2), result.fields);
    result.segments = extractSegments(pages.slice(2));
  }
  await doc.destroy();
  return result;
}

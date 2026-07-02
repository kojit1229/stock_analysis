// viewer.js — PDFビューア(仕様7章: プレビュー/ページ送り/拡大縮小/検索/ジャンプ)

const pdfjs = window.pdfjsLib;

// セクションジャンプ(仕様7.2): キーワード検索ベース
export const SECTION_JUMPS = [
  { label: "経営成績", keyword: "経営成績" },
  { label: "財政状態", keyword: "財政状態" },
  { label: "キャッシュ・フロー", keyword: "キャッシュ・フロー" },
  { label: "業績予想", keyword: "業績予想" },
  { label: "配当予想", keyword: "配当の状況" },
  { label: "セグメント", keyword: "セグメント情報" },
];

export class PdfViewer {
  constructor(container) {
    this.container = container;
    this.doc = null;
    this.pageNum = 1;
    this.scale = 1.2;
    this.textCache = new Map(); // page → text
    this.renderToken = 0;
  }

  async load(arrayBuffer) {
    if (this.doc) await this.doc.destroy();
    this.textCache.clear();
    this.doc = await pdfjs.getDocument({ data: arrayBuffer }).promise;
    this.pageNum = 1;
    this.renderUI();
    await this.renderPage();
  }

  destroy() {
    if (this.doc) this.doc.destroy();
    this.doc = null;
    this.container.innerHTML = "";
  }

  renderUI() {
    this.container.innerHTML = `
      <div class="pdf-toolbar">
        <button data-pdf="prev">←</button>
        <span class="pdf-pageinfo">
          <input type="number" class="pdf-pageinput" min="1" max="${this.doc.numPages}" value="${this.pageNum}">
          / ${this.doc.numPages}
        </span>
        <button data-pdf="next">→</button>
        <button data-pdf="zoom-out">−</button>
        <button data-pdf="zoom-in">＋</button>
        <input type="search" class="pdf-search" placeholder="テキスト検索">
        <select class="pdf-jump">
          <option value="">セクションへ移動…</option>
          ${SECTION_JUMPS.map((s) => `<option value="${s.keyword}">${s.label}</option>`).join("")}
        </select>
      </div>
      <div class="pdf-canvas-wrap"><canvas></canvas></div>
      <div class="pdf-status"></div>
    `;
    this.container.querySelector('[data-pdf="prev"]').onclick = () => this.goto(this.pageNum - 1);
    this.container.querySelector('[data-pdf="next"]').onclick = () => this.goto(this.pageNum + 1);
    this.container.querySelector('[data-pdf="zoom-in"]').onclick = () => this.zoom(1.25);
    this.container.querySelector('[data-pdf="zoom-out"]').onclick = () => this.zoom(0.8);
    this.container.querySelector(".pdf-pageinput").onchange = (e) => this.goto(Number(e.target.value));
    this.container.querySelector(".pdf-search").onkeydown = (e) => {
      if (e.key === "Enter") this.search(e.target.value);
    };
    this.container.querySelector(".pdf-jump").onchange = (e) => {
      if (e.target.value) this.search(e.target.value, true);
      e.target.value = "";
    };
  }

  status(msg) {
    const el = this.container.querySelector(".pdf-status");
    if (el) el.textContent = msg;
  }

  async goto(page) {
    if (!this.doc) return;
    this.pageNum = Math.max(1, Math.min(this.doc.numPages, page));
    const input = this.container.querySelector(".pdf-pageinput");
    if (input) input.value = this.pageNum;
    await this.renderPage();
  }

  async zoom(factor) {
    this.scale = Math.max(0.4, Math.min(4, this.scale * factor));
    await this.renderPage();
  }

  async renderPage() {
    if (!this.doc) return;
    const token = ++this.renderToken;
    const page = await this.doc.getPage(this.pageNum);
    if (token !== this.renderToken) return;
    const viewport = page.getViewport({ scale: this.scale });
    const canvas = this.container.querySelector("canvas");
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = viewport.width * ratio;
    canvas.height = viewport.height * ratio;
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    await page.render({ canvasContext: ctx, viewport }).promise;
  }

  async pageText(p) {
    if (!this.textCache.has(p)) {
      const page = await this.doc.getPage(p);
      const content = await page.getTextContent();
      this.textCache.set(p, content.items.map((i) => i.str).join(" ").replace(/\s/g, ""));
    }
    return this.textCache.get(p);
  }

  // 現在ページの次から検索してジャンプ(fromStart=trueで先頭から)
  async search(query, fromStart = false) {
    if (!this.doc || !query) return;
    const q = query.replace(/\s/g, "");
    const start = fromStart ? 1 : this.pageNum + 1;
    for (let i = 0; i < this.doc.numPages; i++) {
      const p = ((start - 1 + i) % this.doc.numPages) + 1;
      if ((await this.pageText(p)).includes(q)) {
        await this.goto(p);
        this.status(`「${query}」: ${p}ページ`);
        return;
      }
    }
    this.status(`「${query}」は見つかりませんでした`);
  }
}

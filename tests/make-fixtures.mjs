import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

const tanshinHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{font-family:sans-serif;font-size:11px;line-height:1.7;margin:24px}
h1{font-size:15px} .r{white-space:pre}
.pb{page-break-before:always}
</style></head><body>
<h1>2027年3月期 第1四半期決算短信〔日本基準〕(連結)</h1>
<p>2026年8月5日</p>
<p>上場会社名 テスト電機株式会社 上場取引所 東</p>
<p>コード番号 6501 URL https://example.com/ir</p>
<p>代表者 (役職名) 代表取締役社長 (氏名) 試験 太郎</p>
<p>1.2027年3月期第1四半期の連結業績(2026年4月1日〜2026年6月30日)</p>
<p>(1)連結経営成績(累計) (%表示は、対前年同四半期増減率)</p>
<p class="r">売上高 営業利益 経常利益 親会社株主に帰属する四半期純利益</p>
<p class="r">百万円 % 百万円 % 百万円 % 百万円 %</p>
<p class="r">2027年3月期第1四半期 11,000 10.0 1,250 25.0 1,180 20.4 850 21.4</p>
<p class="r">2026年3月期第1四半期 10,000 5.0 1,000 3.0 980 2.0 700 1.0</p>
<p class="r">1株当たり四半期純利益 潜在株式調整後1株当たり四半期純利益</p>
<p class="r">円銭 円銭</p>
<p class="r">2027年3月期第1四半期 85.00 -</p>
<p class="r">2026年3月期第1四半期 70.00 -</p>
<p>(2)連結財政状態</p>
<p class="r">総資産 純資産 自己資本比率</p>
<p class="r">百万円 百万円 %</p>
<p class="r">2027年3月期第1四半期 61,800 27,500 43.7</p>
<p class="r">2026年3月期 61,500 26,500 42.3</p>
<p class="r">(参考)自己資本 2027年3月期第1四半期 27,000百万円 2026年3月期 26,000百万円</p>
<p>(3)連結キャッシュ・フローの状況</p>
<p class="r">営業活動によるキャッシュ・フロー 投資活動によるキャッシュ・フロー 財務活動によるキャッシュ・フロー 現金及び現金同等物四半期末残高</p>
<p class="r">百万円 百万円 百万円 百万円</p>
<p class="r">2027年3月期第1四半期 1,200 △800 △200 5,300</p>
<p class="r">2026年3月期第1四半期 1,100 △700 △300 4,800</p>
<p>2.配当の状況</p>
<p class="r">年間配当金</p>
<p class="r">第1四半期末 第2四半期末 第3四半期末 期末 合計</p>
<p class="r">円銭 円銭 円銭 円銭 円銭</p>
<p class="r">2026年3月期 - 25.00 - 30.00 55.00</p>
<p class="r">2027年3月期 -</p>
<p class="r">2027年3月期(予想) 27.00 - 30.00 57.00</p>
<p>3.2027年3月期の連結業績予想(2026年4月1日〜2027年3月31日)</p>
<p class="r">(%表示は、対前期増減率)</p>
<p class="r">売上高 営業利益 経常利益 親会社株主に帰属する当期純利益 1株当たり当期純利益</p>
<p class="r">百万円 % 百万円 % 百万円 % 百万円 % 円銭</p>
<p class="r">通期 47,000 4.4 5,200 8.3 4,900 6.0 3,500 9.4 350.00</p>

<div class="pb"></div>
<p>※注記事項</p>
<p>(3)発行済株式数(普通株式)</p>
<p class="r">①期末発行済株式数(自己株式を含む) 2027年3月期1Q 10,000,500株 2026年3月期 10,000,500株</p>
<p class="r">②期末自己株式数 2027年3月期1Q 500株 2026年3月期 500株</p>

<div class="pb"></div>
<p>2.四半期連結財務諸表及び主な注記</p>
<p>(1)四半期連結貸借対照表 (単位:百万円)</p>
<p class="r">資産の部</p>
<p class="r">現金及び預金 4,800 5,300</p>
<p class="r">受取手形、売掛金及び契約資産 3,000 3,200</p>
<p class="r">商品及び製品 1,900 2,000</p>
<p class="r">資産合計 61,500 61,800</p>
<p class="r">負債の部</p>
<p class="r">支払手形及び買掛金 2,400 2,500</p>
<p class="r">短期借入金 1,000 1,100</p>
<p class="r">長期借入金 6,500 6,900</p>
<p class="r">負債合計 34,300 34,300</p>

<div class="pb"></div>
<p>(セグメント情報)</p>
<p>Ⅰ 当第1四半期連結累計期間 報告セグメントごとの売上高及び利益の金額に関する情報</p>
<p class="r">売上高 セグメント利益</p>
<p class="r">百万円 百万円</p>
<p class="r">半導体 6,000 800</p>
<p class="r">産業機器 3,500 350</p>
<p class="r">その他 1,500 100</p>
<p class="r">合計 11,000 1,250</p>
</body></html>`;

const setsumeiHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif;font-size:20px;margin:40px}</style></head><body>
<h1>2027年3月期 第1四半期 決算説明資料</h1>
<p>テスト電機株式会社 (6501)</p>
<p>2026年8月5日</p>
<h2>ハイライト</h2><p>増収増益を達成しました。</p>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(tanshinHtml);
await page.pdf({ path: path.join(DIR, 'fixture-tanshin.pdf'), format: 'A4' });
await page.setContent(setsumeiHtml);
await page.pdf({ path: path.join(DIR, 'fixture-setsumei.pdf'), format: 'A4' });
await browser.close();
console.log('fixtures written', fs.statSync(path.join(DIR, 'fixture-tanshin.pdf')).size, fs.statSync(path.join(DIR, 'fixture-setsumei.pdf')).size);

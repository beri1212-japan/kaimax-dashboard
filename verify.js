/**
 * kaimax 見た目確認スクリプト
 *   node verify.js            → PC(1300px) と スマホ(390px) を撮る
 *   node verify.js report     → 実績集計タブ
 *   node verify.js cases      → 案件一覧タブ
 * 出力先: ./shots/
 * 前提: npm i -D playwright  （初回は npx playwright install chromium）
 */
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');

const PAGE = process.argv[2] || 'dashboard';
const CSV  = fs.readFileSync(path.join(__dirname, 'sample-master.csv'), 'utf8');
const OUT  = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });

const stub = async (p) => {
  await p.route('**/*', async r => {
    const u = r.request().url();
    if (u.includes('docs.google.com'))   return r.fulfill({ status:200, contentType:'text/csv; charset=utf-8', body: CSV });
    if (u.includes('script.google.com')) return r.fulfill({ status:200, contentType:'application/json', body:'{}' });
    return r.continue();
  });
};

(async () => {
  const errs = [];
  const browser = await chromium.launch(
    process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}
  );
  const url = 'file://' + path.join(__dirname, 'index.html');

  // --- PC ---
  const pc = await browser.newPage({ viewport:{width:1300,height:1000}, deviceScaleFactor:2 });
  pc.on('pageerror', e => errs.push('PC: ' + e.message));
  await stub(pc);
  await pc.goto(url); await pc.waitForTimeout(2600);
  if (PAGE !== 'dashboard') { await pc.click(`.page-tab[data-page="${PAGE}"]`); await pc.waitForTimeout(1600); }
  await pc.screenshot({ path: path.join(OUT, `pc-${PAGE}.png`) });

  // --- スマホ（サイドバーは #navToggle を押してから）---
  const sp = await browser.newPage({ viewport:{width:390,height:844}, deviceScaleFactor:3, isMobile:true });
  sp.on('pageerror', e => errs.push('SP: ' + e.message));
  await stub(sp);
  await sp.goto(url); await sp.waitForTimeout(2600);
  if (PAGE !== 'dashboard') {
    await sp.click('#navToggle').catch(()=>{}); await sp.waitForTimeout(500);
    await sp.click(`.page-tab[data-page="${PAGE}"]`); await sp.waitForTimeout(1600);
  }
  await sp.screenshot({ path: path.join(OUT, `sp-${PAGE}.png`) });

  const n = await pc.evaluate(() => (typeof allCases !== 'undefined' && allCases) ? allCases.length : null);
  console.log(`読み込み件数: ${n}`);
  console.log(errs.length ? 'JSエラー:\n  ' + errs.join('\n  ') : 'JSエラー: なし');
  console.log('出力: ' + OUT);
  await browser.close();
})();

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

// ---- 合成CSV(sample-master.csv) → データベース(kaimax_cases/kaimax_calls)の形に変換してスタブで返す ----
function parseCSV(t) { const rows = []; let r = [], f = '', q = false; for (let i = 0; i < t.length; i++) { const c = t[i]; if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; } else if (c === '"') q = true; else if (c === ',') { r.push(f); f = ''; } else if (c === '\n') { r.push(f); rows.push(r); r = []; f = ''; } else if (c !== '\r') f += c; } if (f || r.length) { r.push(f); rows.push(r); } return rows; }
const SRC = parseCSV(CSV); const H = SRC[0].map(x => String(x || '').trim());
const hi = n => H.indexOf(n);
const CALLC = [[9, -1], [10, 11], [12, 13], [14, 15], [16, 17], [hi('⑥結果'), hi('⑥日付')], [hi('⑦結果'), hi('⑦日付')], [hi('⑧結果'), hi('⑧日付')]];
const DB_CASES = [], DB_CALLS = [];
SRC.slice(1).forEach((r, i) => {
  if (!r[0]) return; const g = k => (k >= 0 && r[k] != null && String(r[k]).trim() !== '') ? String(r[k]).trim() : null;
  DB_CASES.push({ id: i + 1, case_no: +r[0], media: g(1), received_on: null, received_raw: g(2), customer_name: g(3), tel: g(4), car_name: g(5), bid: g(6), bid_result: g(7), rival_memo: g(8),
    assess: g(18), result: g(19), followup_raw: g(20), assignee: g(21), note: g(22), desired_raw: g(23), offered_raw: g(24), deal_raw: g(25),
    address: g(26), email: g(27), model_year: g(28), mileage: g(29), call_memo: g(31), reply_status: g(hi('回答')) });
  CALLC.forEach(([rc, dc], n) => { if (rc >= 0 && g(rc)) DB_CALLS.push({ case_id: i + 1, seq: n + 1, result: g(rc), called_raw: g(dc) }); });
});
const FAKE_SESSION = JSON.stringify({ access_token: 'verify-token', refresh_token: 'x', token_type: 'bearer', expires_in: 3600, expires_at: 4102444800,
  user: { id: '00000000-0000-0000-0000-000000000000', email: 'verify@example.com', aud: 'authenticated', role: 'authenticated' } });

const stub = async (p) => {
  await p.addInitScript(s => { try { localStorage.setItem('kaimax-auth', s); } catch (e) {} }, FAKE_SESSION);
  await p.route('**/*', async r => {
    const u = r.request().url();
    const j = (o) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(o) });
    if (u.includes('cdn.jsdelivr.net/npm/@supabase/supabase-js')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(require.resolve('@supabase/supabase-js/dist/umd/supabase.js'), 'utf8') });
    if (u.includes('.supabase.co/rest/v1/rpc/kaimax_can_access')) return j(true);
    if (u.includes('.supabase.co/rest/v1/kaimax_cases')) return j(DB_CASES);
    if (u.includes('.supabase.co/rest/v1/kaimax_calls')) return j(DB_CALLS);
    if (u.includes('.supabase.co/rest/v1/kaimax_replies')) return j([]);
    if (u.includes('.supabase.co/rest/v1/kaimax_insmart_cars')) return j([{ car_id: '2607101000001', vin: 'DJ3AS-000001', maker: 'マツダ', car: 'デミオ', grade: '13C', first_reg: '2009/04/01', mileage: 75000, assessor: '前田 峻哉', status: '成約', registered_at: '2026-07-11T10:00:00+09:00', deal_on: '2026-07-15', deal_yen: 120000 }]);
    if (u.includes('.supabase.co/rest/v1/kaimax_outcomes')) { const ds = DB_CASES.filter(c => /成約|入庫/.test(c.result || '')); return j([
      ds[0] && { case_id: ds[0].id, route: '商品→成約', cost_yen: 80000, cost_memo: '板金 5万 / タイヤ 3万', auctions: [], sold_on: '2026-08-20', sold_yen: 980000, sold_to: '山田様', memo: '', updated_by: 'cs@indio.co.jp', updated_at: '2026-10-19T07:00:00Z' },
      ds[1] && { case_id: ds[1].id, route: 'AA', cost_yen: null, auctions: [{ date: '2026-08-05', venue: 'USS名古屋', listingFee: 11000, successFee: null, transportFee: 15000, result: '流札', price: null }, { date: '2026-08-12', venue: 'USS名古屋', listingFee: 11000, successFee: 16500, transportFee: null, result: '成約', price: 520000 }], sold_on: '2026-08-12', sold_yen: 520000, sold_to: 'USS名古屋', memo: '' },
      ds[2] && { case_id: ds[2].id, route: '商品', cost_yen: 120000, auctions: [] },
      ds[3] && { case_id: ds[3].id, route: '商品→AA', auctions: [{ date: '2026-10-10', venue: 'TAA中部', listingFee: 9900, transportFee: 12000, result: '流札' }] },
      ds[4] && { case_id: ds[4].id, route: '廃車', auctions: [] },
    ].filter(Boolean)); }
    if (u.includes('.supabase.co/rest/v1/kaimax_staff')) return j([{ name: '前田', status: 'active' }, { name: '金木', status: 'archived' }]);
    if (u.includes('.supabase.co/rest/v1/kaimax_costs')) return j([{ ym: '2026-07', kind: 'media', item: 'mota', amount: 150000 }, { ym: '2026-07', kind: 'media', item: 'carsensor', amount: 80000 }, { ym: '2026-07', kind: 'other', item: '人件費', amount: 300000 }, { ym: '2026-10', kind: 'media', item: 'mota', amount: 6000000 }]);
    if (u.includes('.supabase.co/rest/v1/kaimax_targets')) return j([{ ym: '2026-10', assignee: '前田', target: 16 }, { ym: '2026-10', assignee: '高木', target: 2 }]);
    if (u.includes('.supabase.co/functions/'))  return j({ status: 'success', message: 'stub' });
    if (u.includes('.supabase.co/auth/'))       return j({});
    if (u.includes('docs.google.com'))   return r.fulfill({ status:200, contentType:'text/csv; charset=utf-8', body: '' });
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
  // EVAL=... で撮影前に画面内のJSを実行できる（モーダルを開く等）。TAG=... で出力名を変える
  const TAG = process.env.TAG ? '-' + process.env.TAG : '';
  if (process.env.EVAL) { await pc.evaluate(process.env.EVAL); await pc.waitForTimeout(600); }
  await pc.screenshot({ path: path.join(OUT, `pc-${PAGE}${TAG}.png`), fullPage: !!process.env.FULL });

  // --- スマホ（サイドバーは #navToggle を押してから）---
  const sp = await browser.newPage({ viewport:{width:390,height:844}, deviceScaleFactor:3, isMobile:true });
  sp.on('pageerror', e => errs.push('SP: ' + e.message));
  await stub(sp);
  await sp.goto(url); await sp.waitForTimeout(2600);
  if (PAGE !== 'dashboard') {
    await sp.click('#navToggle').catch(()=>{}); await sp.waitForTimeout(500);
    await sp.click(`.page-tab[data-page="${PAGE}"]`); await sp.waitForTimeout(1600);
  }
  if (process.env.EVAL) { await sp.evaluate(process.env.EVAL); await sp.waitForTimeout(600); }
  await sp.screenshot({ path: path.join(OUT, `sp-${PAGE}${TAG}.png`), fullPage: !!process.env.FULL });

  const n = await pc.evaluate(() => (typeof allCases !== 'undefined' && allCases) ? allCases.length : null);
  console.log(`読み込み件数: ${n}`);
  console.log(errs.length ? 'JSエラー:\n  ' + errs.join('\n  ') : 'JSエラー: なし');
  console.log('出力: ' + OUT);
  await browser.close();
})();

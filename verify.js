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
    if (u.includes('.supabase.co/rest/v1/kaimax_contracts')) return j([
      { contract_no: '2607156000001', contract_on: '2026-07-15', status: '契約済', customer_name: 'サンプル40', maker: 'マツダ', car: 'デミオ', grade: '13C', vin: 'DJ3AS-000001', first_reg: '2009/04/01', mileage: 75000, amount: 120000, trade_in_yen: 0, assignee: '前田 峻哉' },
      { contract_no: '2610186000002', contract_on: '2026-10-18', status: '契約済', customer_name: '店頭 太郎', maker: 'ホンダ', car: 'N BOX', grade: 'G Lパッケージ', vin: 'JF1-0000002', first_reg: '2014/03/01', mileage: 116557, amount: 70000, trade_in_yen: 0, assignee: '野村 昂祐' },
      { contract_no: '2607096000005', contract_on: '2026-07-09', status: '契約済', customer_name: '株式会社サンプル', maker: 'トヨタ', car: 'プロボックス', grade: '', vin: 'NCP160-0000005', first_reg: '2020/04/01', mileage: 80000, amount: 33420, trade_in_yen: 0, assignee: '前田 峻哉', auto_kind: 'リース', synced_at: '2026-10-19T08:47:00Z' },
      { contract_no: '2610176000003', contract_on: '2026-10-17', status: '契約済', customer_name: '下取 花子', maker: '日産', car: 'エクストレイル', grade: '20X', vin: 'HNT32-0000003', first_reg: '2015/10/01', mileage: 74000, amount: 350000, trade_in_yen: 36800, assignee: '高木 光嗣', auto_kind: '下取り' },
      { contract_no: '2609206000004', contract_on: '2026-09-20', status: 'キャンセル', customer_name: '取消 一郎', maker: 'トヨタ', car: 'クラウン', grade: '', vin: 'AWS210-0000004', first_reg: '2017/06/01', mileage: 50000, amount: 1300000, trade_in_yen: 0, assignee: '野村 昂祐' }]);
    if (u.includes('.supabase.co/rest/v1/kaimax_outcomes')) { const ds = DB_CASES.filter(c => /成約|入庫/.test(c.result || '')); return j([
      ds[0] && { case_id: ds[0].id, route: '商品→成約', cost_yen: 80000, cost_memo: '板金 5万 / タイヤ 3万', auctions: [], sold_on: '2026-08-20', sold_yen: 980000, sold_to: '山田様', memo: '', updated_by: 'cs@indio.co.jp', updated_at: '2026-10-19T07:00:00Z' },
      ds[1] && { case_id: ds[1].id, route: 'AA', cost_yen: null, auctions: [{ date: '2026-08-05', venue: 'USS名古屋', listingFee: 11000, successFee: null, transportFee: 15000, result: '流札', price: null }, { date: '2026-08-12', venue: 'USS名古屋', listingFee: 11000, successFee: 16500, transportFee: null, result: '成約', price: 520000 }], sold_on: '2026-08-12', sold_yen: 520000, sold_to: 'USS名古屋', memo: '' },
      ds[2] && { case_id: ds[2].id, route: '商品', cost_yen: 120000, est_body_yen: 1360000, est_recycle_yen: 12000, est_listing_fee: 11000, est_success_fee: 16500, est_transport_fee: 15000, auctions: [] },
      ds[3] && { case_id: ds[3].id, route: '商品→AA', est_body_yen: 380000, est_recycle_yen: 9000, auctions: [{ date: '2026-10-10', venue: 'TAA中部', listingFee: 9900, transportFee: 12000, result: '流札' }] },
      ds[4] && { case_id: ds[4].id, route: '廃車', auctions: [] },
    ].filter(Boolean)); }
    if (u.includes('.supabase.co/rest/v1/kaitori_voices')) return j([
      { id: 2, case_id: null, contract_no: null, photo_path: 'voices/2026-10/x.webp', deal_on: '2026-10-12', maker: 'ホンダ', car: 'N-BOX', grade: 'G Lパッケージ', model_year: 2018, city: '富山市', customer_label: 'T様', price_label: '45万円台', consent: true, visible: true },
      { id: 1, case_id: null, contract_no: null, photo_path: 'voices/2026-10/y.webp', deal_on: '2026-10-05', maker: 'トヨタ', car: 'プリウス', grade: 'S', model_year: 2016, city: '高岡市', customer_label: 'K様', price_label: null, consent: false, visible: true }]);
    if (u.includes('.supabase.co/rest/v1/kaitori_models')) return j([
      { id: '11111111-1111-1111-1111-111111111111', slug: 'n-box', maker: 'ホンダ', name: 'N-BOX', body_type: 'kei', visible: true, is_featured: true, headline: '軽の人気No.1。年式が古くても高く買い取ります', intro: '## N-BOXの買取について\nN-BOXは中古車でも人気です。\n\n・カスタムは特に高評価\n・走行10万km超えでもOK', match_keys: ['N BOX', 'N-BOX'], image_path: null, sort: 10 },
      { id: '22222222-2222-2222-2222-222222222222', slug: 'tanto', maker: 'ダイハツ', name: 'タント', body_type: 'kei', visible: false, is_featured: false, headline: null, intro: null, match_keys: ['タント'], image_path: null, sort: 20 }]);
    if (u.includes('.supabase.co/rest/v1/kaitori_news')) return j([{ id: '33333333-3333-3333-3333-333333333333', slug: '2026-11-4wd-kei', kind: '相場情報', title: '冬前は4WDの軽が高い', lead: '11月は4WDの軽自動車の相場が上がります', body: '## 相場の目安\nN-BOX 4WDは50〜70万円台が中心です。', image_path: null, model_ids: ['11111111-1111-1111-1111-111111111111'], published_on: '2026-11-01', visible: true }]);
    if (u.includes('.supabase.co/rest/v1/kaitori_faqs')) return j([{ id: '44444444-4444-4444-4444-444444444444', scope: 'all', q: 'ローンが残っていても売れますか？', a: 'はい、残債の精算もこちらで手続きします。', sort: 10, visible: true }]);
    if (u.includes('.supabase.co/rest/v1/kaitori_car_master')) return j([{ id: 1, maker: 'トヨタ', name: 'プリウス', maker_sort: 1, sort: 10, visible: true }, { id: 2, maker: 'トヨタ', name: 'アクア', maker_sort: 1, sort: 20, visible: true }, { id: 3, maker: 'マツダ', name: 'デミオ', maker_sort: 5, sort: 10, visible: true }, { id: 4, maker: 'ホンダ', name: 'N-BOX', maker_sort: 2, sort: 10, visible: true }]);
    if (u.includes('.supabase.co/rest/v1/kaitori_requests')) return j([]);
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
  const pc = await browser.newPage({ viewport:{width:+(process.env.PC_W||1300),height:1000}, deviceScaleFactor:(process.env.PC_W?1:2) });
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

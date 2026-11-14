// ==UserScript==
// @name         kaimax MOTA取込（12:15/18:15）
// @namespace    https://kaimax-indio.vercel.app/
// @version      1.1.0
// @description  MOTA加盟店マイページから、受付中（新規・明細）・受付終了（入札結果）・権利獲得（お客様情報）を kaimax へ送る。ログインはID/パスワードを入れて、ロボット確認が通ったらログインボタンを押す（確認のチェックが出たら人が押す）
// @match        https://autoc-one.jp/ullo/shop/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      artkjsyyrmwagmqitiaz.supabase.co
// @run-at       document-idle
// @noframes
// ==/UserScript==
// 2026/11/14〜 MOTAがログインにロボット判定(Cloudflare Turnstile)を入れたため、AIPCの毎時収集(Playwright)の代わりに使う。
// 起動: AIPC の run.bat が 12:05/18:05 に mota-sync-launch.bat を起こし、10分後に Chrome で
//       https://autoc-one.jp/ullo/shop/mypage/assessment/carList/accepting/?limit=100#kaimax-sync を開く。
//       手動なら Tampermonkey のメニュー「今すぐ kaimax へ取込」。
// 鍵・ID・パスワードは Tampermonkey の保存領域に置く（このファイルには書かない）。メニューから登録する。
// MOTA への負荷は従来どおり: 詳細ページの間は4秒、結果の送信は1.2秒あける。一覧は ?limit=100 まで。
(function () {
  'use strict';
  const API = 'https://artkjsyyrmwagmqitiaz.supabase.co/functions/v1/kaimax-api';
  const BASE = 'https://autoc-one.jp/ullo/shop/mypage/assessment';
  const ACCEPTING = BASE + '/carList/accepting/?limit=100';
  const CLOSED = BASE + '/carList/closed/?limit=100';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t === '－' || t === '-' || t === '—' ? '' : t; };

  // ---------- 設定（メニューから） ----------
  GM_registerMenuCommand('今すぐ kaimax へ取込', () => { GM_setValue('pendingUntil', Date.now() + 30 * 60000); location.href = ACCEPTING + '#kaimax-sync'; });
  GM_registerMenuCommand('kaimax の鍵を登録', () => { const v = prompt('kaimax のワーカー鍵（Claudeが渡したもの）'); if (v) GM_setValue('kaimaxKey', v.trim()); });
  GM_registerMenuCommand('MOTA の ID/パスワードを登録', () => {
    const id = prompt('MOTA ログインID（メールアドレス）', GM_getValue('motaId', '')); if (id == null) return;
    const pw = prompt('MOTA パスワード（画面には残りません）'); if (pw == null) return;
    GM_setValue('motaId', id.trim()); GM_setValue('motaPw', pw);
    alert('登録しました');
  });

  // ---------- 画面右下の表示 ----------
  let box;
  function show(msg, color) {
    if (!box) {
      box = document.createElement('div');
      box.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;max-width:360px;padding:10px 12px;border-radius:8px;background:#202124;color:#fff;font:13px/1.5 sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3);white-space:pre-wrap';
      document.body.appendChild(box);
    }
    box.style.background = color || '#202124';
    box.textContent = 'kaimax 取込\n' + msg;
  }

  // ---------- kaimax API ----------
  function api(method, url, body) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method, url, headers: { 'Content-Type': 'application/json' }, data: body ? JSON.stringify(body) : undefined, timeout: 30000,
        onload: (r) => { try { resolve(JSON.parse(r.responseText)); } catch { resolve({ status: 'error', message: r.responseText.slice(0, 120) }); } },
        onerror: () => resolve({ status: 'error', message: '通信エラー' }), ontimeout: () => resolve({ status: 'error', message: 'タイムアウト' }),
      });
    });
  }
  const key = () => GM_getValue('kaimaxKey', '');
  const post = async (action, payload) => {
    for (let i = 0; i < 3; i++) { const r = await api('POST', API, { secret: key(), action, payload }); if (r.status !== 'error' || i === 2) return r; await sleep(2000); }
  };

  // ---------- 同じタブ内の iframe でページを読む（ログイン状態をそのまま使う） ----------
  function loadDoc(url, ready, maxMs) {
    return new Promise((resolve) => {
      const f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;left:-9999px;top:0;width:1200px;height:900px;visibility:hidden';
      f.src = url;
      let done = false;
      const finish = (doc) => { if (done) return; done = true; resolve(doc); setTimeout(() => f.remove(), 100); };
      f.onload = async () => {
        const t0 = Date.now();
        while (Date.now() - t0 < (maxMs || 15000)) {
          let doc = null; try { doc = f.contentDocument; } catch { doc = null; }
          if (doc && /login/.test(doc.location.pathname)) return finish({ loginRequired: true });
          if (doc && ready(doc)) { await sleep(300); return finish(doc); }
          await sleep(700);
        }
        let doc = null; try { doc = f.contentDocument; } catch { doc = null; }
        finish(doc);
      };
      document.body.appendChild(f);
      setTimeout(() => finish(null), (maxMs || 15000) + 30000);
    });
  }

  // 一覧（受付中・受付終了）: AIPC の収集と同じ読み方
  function readList(doc) {
    return [...doc.querySelectorAll('#carBidList > li, li.p-carlist-item')].map((li) => {
      const link = li.querySelector('.p-carlist-item__link, .p-carlist-list__link, a[href*="/car/"]'); const href = link?.getAttribute('href') || '';
      let status = clean(li.querySelector('.c-carlist-status, .p-carlist-item__status, .p-carlist-list__status')?.textContent);
      if (!status) {
        const WS = ['入札済み', '現車確認', '他社決定', '未入札', '権利獲得', '落札', '成約', 'キャンセル', '辞退', '取消'];
        for (const el of li.querySelectorAll('*')) { if (el.children.length) continue; const t = (el.textContent || '').replace(/\s+/g, ''); const hit = WS.find((w) => t.includes(w)); if (hit) { status = hit; break; } }
      }
      // 受信日の推定: 締切が12時台→前日の受信 / 18時台→当日の受信（MOTAメールの受信時刻と締切の関係から）
      let receivedOn = '';
      const dl = (li.textContent || '').match(/締切[：:\s]*(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):/);
      if (dl) { const d = new Date(Date.UTC(+dl[1], +dl[2] - 1, +dl[3])); if (+dl[4] < 15) d.setUTCDate(d.getUTCDate() - 1); receivedOn = d.toISOString().slice(0, 10); }
      return { receivedOn, assessNo: (href.match(/\/car\/(\d+)\//) || [])[1] || '', car: clean((li.querySelector('.p-carlist-item__carname, .p-carlist-list__carname')?.textContent || link?.getAttribute('aria-label') || link?.textContent || '').replace(/\s*の詳細へ\s*$/, '')), status };
    }).filter((c) => c.assessNo);
  }
  const listReady = (doc) => !!doc.querySelector('#carBidList > li, li.p-carlist-item, .p-carlist-empty, .c-empty') || /該当する車両はありません|ありません/.test(doc.body?.innerText || '');

  // 詳細ページ: ラベル→値
  function readDetail(doc) {
    const m = {};
    doc.querySelectorAll('dl').forEach((dl) => { const dts = dl.querySelectorAll('dt'), dds = dl.querySelectorAll('dd'); dts.forEach((dt, i) => { const k = dt.textContent.replace(/\s+/g, '').trim(); if (k && m[k] === undefined) m[k] = clean(dds[i]?.textContent); }); });
    doc.querySelectorAll('.p-detail-alert__user li').forEach((li) => { const k = [...li.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join('').replace(/\s+/g, '').trim(); const v = clean(li.querySelector('span')?.textContent); if (k && m[k] === undefined) m[k] = v; });
    doc.querySelectorAll('tr').forEach((tr) => { const th = tr.querySelector('th'), td = tr.querySelector('td'); if (th && td) { const k = th.textContent.replace(/\s+/g, '').trim(); if (k && m[k] === undefined) m[k] = clean(td.textContent); } });
    return m;
  }
  const detailReady = (doc) => { const m = readDetail(doc); const ks = Object.keys(m); return ['排気量', '燃料', 'ミッション', 'ハンドル', '車検期限'].some((k) => m[k]) && ks.some((k) => /売却|乗り換え|乗換/.test(k)); };
  function pickTiming(d) {
    for (const k of ['売却希望時期', '売却予定時期', '売却時期', 'ご売却時期', 'ご売却予定時期', '売却のご希望時期', '希望売却時期', '売却希望', '売却予定']) if (d[k]) return d[k];
    for (const k of Object.keys(d)) if (k.includes('売却') && k.includes('時期')) return d[k];
    for (const k of Object.keys(d)) if (/(ヶ月以内|か月以内|ヵ月以内|以内|即時|すぐ|未定|検討中)/.test(String(d[k] || '')) && /(時期|売却|予定)/.test(k)) return d[k];
    return '';
  }
  function toPayload(no, d) {
    return {
      assessNo: no, source: 'mota_tm',
      car: clean(d['車種'] || d['車名'] || d['車種名'] || d['車両名'] || d['メーカー・車種'] || d['メーカー/車種'] || d['メーカー'] || ''),
      year: (String(d['年式'] || '').match(/(19|20)\d{2}/) || [clean(d['年式'])])[0],
      mileage: clean(d['走行距離']), modelCode: clean(d['型式']), bodyNo: clean(d['車台番号']), displacement: clean(d['排気量']),
      repair: clean(d['修復歴']), color: clean(d['車体色']), inspection: clean(d['車検期限']), fuel: clean(d['燃料']),
      transmission: clean(d['ミッション']), handle: clean(d['ハンドル']), timing: clean(pickTiming(d)), replacement: clean(d['乗り換え検討']),
    };
  }
  const NAME_KEYS = ['お名前', '氏名', 'お客様名', 'お客様氏名', 'ご担当者名', '担当者名', '名前', '出品者名', 'ご出品者名', '契約者名', 'ご契約者名', 'オーナー名'];
  const TEL_KEYS = ['電話番号', 'TEL', 'お電話番号', '携帯電話', '携帯番号', '連絡先', 'ご連絡先', 'お客様電話番号', '電話'];
  const ADDR_KEYS = ['住所', 'ご住所', '現住所', 'お客様住所'];
  const MAIL_KEYS = ['メールアドレス', 'メール', 'Eメール', 'E-mail', 'Email', 'mail'];
  function pick(map, keys) {
    for (const k of keys) if (map[k] !== undefined && clean(map[k])) return clean(map[k]);
    for (const mk of Object.keys(map)) for (const k of keys) if (mk.includes(k) && clean(map[mk])) return clean(map[mk]);
    return '';
  }
  const gValue = (s) => (s === '入札済み' || s === '現車確認' || s === '他社決定') ? '〇' : '';
  const hValue = (s) => s === '現車確認' ? '権利獲得' : s;

  // ---------- 取込本体 ----------
  async function runSync() {
    if (!key()) { show('kaimax の鍵が未登録です（Tampermonkeyのメニュー「kaimax の鍵を登録」）', '#c5221f'); return; }
    GM_setValue('pendingUntil', 0);
    const sum = { created: 0, linked: 0, refilled: 0, results: 0, won: 0, errors: 0 };
    try {
      show('登録済みの一覧を確認中…');
      const reg = await api('GET', API + '/w/' + encodeURIComponent(key()) + '?action=list_assess_nos');
      if (reg.status !== 'success') throw new Error('kaimax の一覧が取れません: ' + (reg.message || ''));
      const byNo = new Map(reg.items.map((x) => [String(x.assessNo), x]));

      // ① 受付中: 未登録は新規、登録済みで明細が無いもの（メールから入った案件）は明細を補う
      show('受付中の一覧を読込中…');
      const acc = await loadDoc(ACCEPTING, listReady);
      if (!acc || acc.loginRequired) throw new Error('ログインが切れています');
      const accList = readList(acc);
      const accTargets = accList.filter((c) => { const r = byNo.get(c.assessNo); return !r || !r.detail; });
      let i = 0;
      for (const c of accTargets) {
        i++; show(`受付中 ${i}/${accTargets.length}：${c.car}`);
        const doc = await loadDoc(`${BASE}/car/${c.assessNo}/`, detailReady);
        const d = doc && !doc.loginRequired ? readDetail(doc) : {};
        const p = toPayload(c.assessNo, d); if (!p.car) p.car = c.car; if (c.receivedOn) p.receivedOn = c.receivedOn;
        const r = byNo.has(c.assessNo) ? await post('mota_refill', p) : await post('mota_create', p);
        if (r.status === 'success') sum.created++; else if (r.status === 'linked') sum.linked++; else if (r.status === 'updated') sum.refilled++;
        else if (!['duplicate', 'nochange'].includes(r.status)) { sum.errors++; console.warn('[kaimax]', c.assessNo, r); }
        if (r.no) byNo.set(c.assessNo, { assessNo: c.assessNo, named: false, detail: true });
        await sleep(4000);
      }

      // ② 受付終了: 入札結果（入札済み・状態不明は送らない＝AIPC版と同じ安全装置）
      show('受付終了の一覧を読込中…');
      const cl = await loadDoc(CLOSED, listReady);
      if (!cl || cl.loginRequired) throw new Error('ログインが切れています');
      const clList = readList(cl);
      const resTargets = clList.filter((c) => c.status && c.status !== '入札済み' && byNo.has(c.assessNo));
      i = 0;
      for (const c of resTargets) {
        i++; show(`入札結果 ${i}/${resTargets.length}`);
        const r = await post('mota_result', { assessNo: c.assessNo, bid: gValue(c.status), bidResult: hValue(c.status) });
        if (r.status === 'success') sum.results++; else if (!['unchanged', 'skipped', 'not_found'].includes(r.status)) { sum.errors++; console.warn('[kaimax]', c.assessNo, r); }
        await sleep(1200);
      }

      // ③ 権利獲得（現車確認）でお客様情報がまだ入っていないもの
      const wonTargets = clList.filter((c) => c.status === '現車確認' && !(byNo.get(c.assessNo) || {}).named);
      i = 0;
      for (const c of wonTargets) {
        i++; show(`権利獲得 ${i}/${wonTargets.length}：${c.car}`);
        const doc = await loadDoc(`${BASE}/car/${c.assessNo}/`, (d) => !!pick(readDetail(d), TEL_KEYS) || !!pick(readDetail(d), NAME_KEYS));
        const d = doc && !doc.loginRequired ? readDetail(doc) : {};
        const customer = pick(d, NAME_KEYS);
        const tel = ((t) => /^0[5789]0\d{8}$/.test(t) ? `${t.slice(0, 3)}-${t.slice(3, 7)}-${t.slice(7)}` : t)(pick(d, TEL_KEYS).replace(/[^\d-]/g, ''));
        const address = pick(d, ADDR_KEYS);
        const email = ((pick(d, MAIL_KEYS) || '').match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/) || [''])[0];
        if (!customer && !tel) { sum.errors++; console.warn('[kaimax] 顧客情報が読めない', c.assessNo); await sleep(4000); continue; }
        if (!byNo.has(c.assessNo)) { const p = toPayload(c.assessNo, d); if (!p.car) p.car = c.car; if (c.receivedOn) p.receivedOn = c.receivedOn; await post('mota_create', p); }
        const r = await post('mota_won', { assessNo: c.assessNo, customer, tel, address, email, car: c.car });
        if (r.status === 'success') sum.won++; else if (r.status !== 'duplicate') { sum.errors++; console.warn('[kaimax]', c.assessNo, r); }
        await sleep(4000);
      }

      await post('mota_sync', { source: 'mota_tm', summary: { ...sum, accepting: accList.length, closed: clList.length } });
      show(`完了 ${new Date().toLocaleTimeString('ja-JP')}\n新規 ${sum.created}・手入力に紐づけ ${sum.linked}・明細補完 ${sum.refilled}\n入札結果 ${sum.results}・権利獲得 ${sum.won}` + (sum.errors ? `\n失敗 ${sum.errors}件（コンソール参照）` : ''), sum.errors ? '#b06000' : '#137333');
    } catch (e) {
      await post('mota_sync', { source: 'mota_tm', summary: sum, error: String(e.message || e) });
      show('止まりました：' + (e.message || e), '#c5221f');
    }
  }

  // ---------- ログイン画面 ----------
  async function onLogin() {
    const id = GM_getValue('motaId', ''), pw = GM_getValue('motaPw', '');
    if (!id || !pw) { show('MOTA の ID/パスワードが未登録です（Tampermonkeyのメニューから登録）', '#c5221f'); return; }
    const mail = document.querySelector('input[name=mail4Shop]'), pass = document.querySelector('input[name=password4Shop]'), btn = document.querySelector('#shopLoginButton');
    if (!mail || !pass || !btn) { show('ログイン画面の形が変わっています', '#c5221f'); return; }
    const setVal = (el, v) => { const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
    setVal(mail, id); setVal(pass, pw);
    // ロボット確認（Turnstile）が通るのを待つ。チェックが出たら人が押す。通ったらログインを押す
    const t0 = Date.now();
    while (Date.now() - t0 < 10 * 60000) {
      const tok = document.querySelector('input[name="cf-turnstile-response"]');
      if (!tok || tok.value) { show('ログインします…'); await sleep(800); btn.click(); return; }
      show(Date.now() - t0 > 15000 ? 'ロボット確認のチェックを押してください（押せば自動で続きます）' : 'ロボット確認を待っています…', Date.now() - t0 > 15000 ? '#b06000' : undefined);
      await sleep(1000);
    }
    show('ロボット確認が通りませんでした', '#c5221f');
  }

  // ---------- 入口 ----------
  if (location.hash === '#kaimax-sync') GM_setValue('pendingUntil', Date.now() + 30 * 60000);
  const pending = GM_getValue('pendingUntil', 0) > Date.now();
  if (!pending) return;
  if (/\/login/.test(location.pathname)) { onLogin(); return; }
  if (/\/mypage/.test(location.pathname)) { setTimeout(runSync, 1500); }
})();

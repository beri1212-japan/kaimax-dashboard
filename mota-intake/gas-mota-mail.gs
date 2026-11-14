/**
 * kaimax MOTAメール取込（cs@indio.co.jp の Apps Script・10分ごと）
 * 2026/11/14〜 MOTA がログインにロボット判定を入れ、AIPC の毎時収集が止まったための代わり。
 * 「入札依頼申込みがありました【MOTA車買取】」メールから査定番号・車種などを読み、kaimax-api の mota_create に送る。
 *  - 取り込めたメール（登録・登録済み・手入力の案件に紐づけ）は「kaimax取込済」ラベルを付けて次から読まない
 *  - 失敗したものはラベルを付けず、次の回にもう一度送る
 *  - 鍵はスクリプトのプロパティ KAIMAX_KEY（kaimax_worker_keys id=3）。コードには書かない
 * 細かい明細（色・車検など）と入札結果・お客様情報は、AIPC の Tampermonkey（12:15/18:15）が補う。
 */
const KAIMAX_API = 'https://artkjsyyrmwagmqitiaz.supabase.co/functions/v1/kaimax-api';
const DONE_LABEL = 'kaimax取込済';

function pollMotaMail() {
  const key = PropertiesService.getScriptProperties().getProperty('KAIMAX_KEY');
  if (!key) throw new Error('KAIMAX_KEY が未設定です');
  const label = GmailApp.getUserLabelByName(DONE_LABEL) || GmailApp.createLabel(DONE_LABEL);
  const threads = GmailApp.search('from:kaitori-buyer@mota.inc subject:入札依頼申込み newer_than:7d -label:' + DONE_LABEL, 0, 50);
  const log = [];
  threads.forEach(function (th) {
    let allOk = true;
    th.getMessages().forEach(function (m) {
      if (!/入札依頼申込み/.test(m.getSubject())) return;
      const p = parseMotaMail_(m.getPlainBody());
      if (!p.assessNo) { log.push('査定番号なし: ' + m.getSubject()); return; }
      p.receivedOn = Utilities.formatDate(m.getDate(), 'Asia/Tokyo', 'yyyy-MM-dd');
      p.source = 'mota_mail';
      const r = postKaimax_(key, 'mota_create', p);
      log.push(p.assessNo + ' ' + r.status + ' ' + (r.message || ''));
      if (['success', 'duplicate', 'linked'].indexOf(r.status) < 0) allOk = false;
    });
    if (allOk) th.addLabel(label);
  });
  if (log.length) console.log(log.join('\n'));
  return log;
}

function parseMotaMail_(body) {
  const get = function (k) { const m = body.match(new RegExp(k + '[\\s　]*：\\s*([^\\r\\n]*)')); return m ? m[1].trim() : ''; };
  const makerCar = get('メーカー・車種');
  const grade = get('グレード');
  const car = (makerCar.replace(/[\s　]+/, '') + (grade ? grade : '')).trim(); // AIPC 収集と同じ「メーカー車種グレード」の形
  const year = (get('年式').match(/(19|20)\d{2}/) || [''])[0];
  return {
    assessNo: (get('査定番号').match(/\d+/) || [''])[0],
    car: car,
    year: year,
    mileage: get('走行距離'),
    timing: get('売却時期'),
    zip: get('郵便番号'),
    area: get('住所'),
  };
}

function postKaimax_(key, action, payload) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = UrlFetchApp.fetch(KAIMAX_API, { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        payload: JSON.stringify({ secret: key, action: action, payload: payload }) });
      return JSON.parse(res.getContentText());
    } catch (e) { if (i === 2) return { status: 'error', message: String(e) }; Utilities.sleep(2000); }
  }
}

/** 初回に1回だけ実行：10分ごとのトリガーを作る（重複しないよう既存を消してから） */
function setupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'pollMotaMail') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('pollMotaMail').timeBased().everyMinutes(10).create();
}

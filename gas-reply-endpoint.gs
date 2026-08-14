/**
 * kaimax / インディオ富山 回答ページ用エンドポイント（gas-reply-endpoint.gs）
 * ------------------------------------------------------------------
 * reply.html（お客様の回答ページ）から送信された内容を「顧客回答」シートに記録し、
 * 任意で Chatwork に通知します。案件シートから 顧客名・TEL・車名 を id で照合して補完します。
 *
 * ■ 既存の kaimax GAS に追記する場合（推奨）
 *   1) 既存 doPost の【いちばん上・secretチェックより前】に、次の1行を足してください:
 *        if (data.action === 'reply') return handleReply(data);
 *      ※ reply.html は認証キーを `key` で送るため、既存の `secret` チェックより前に置き、
 *        handleReply 内で `key` を検証します（他アクションの secret 認証と競合しません）。
 *   2) 下の handleReply / findCaseRow_ / replySheet_ / notifyChatwork_ / _replyJson を
 *      GASの末尾にそのまま貼り付けてください（重複しない関数名にしてあります）。
 *   3) SECRET_KEY が既存と同名で二重定義になる場合は、下の宣言を削除してください（値は同じ indio9700）。
 *   4) 追記後、「デプロイを管理」→ 既存デプロイを編集 →「新バージョン」で再デプロイ（URLは変わりません）。
 *      アクセスできるユーザーが「全員」であることを確認してください。
 *
 * ■ doPost がまだ無い場合は、このファイルをそのまま貼り付ければ動きます。
 * ------------------------------------------------------------------
 */

// ===== 定数（環境に合わせて確認）=====
var SECRET_KEY  = 'indio9700';     // reply.html の KEY と一致させる
var SHEET_CASE  = 'マスタ案件';     // 案件シートの実際の名前に合わせる（顧客名/TEL/車名 照合用）
var SHEET_REPLY = '顧客回答';       // 回答の保存先（無ければ自動作成）

// 案件シートの列位置（0始まり）: A=案件NO, D=顧客名, E=TEL, F=車名
var CASE_COL = { id: 0, customer: 3, tel: 4, car: 5 };

// ===== doPost（既存が無い場合はこれを使用）=====
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    if (data.action === 'reply') return handleReply(data);   // ← 既存doPostには「この1行だけ」を先頭に足す
    if (data.secret !== SECRET_KEY) return _replyJson({ status: 'error', message: '認証エラー' });
    return _replyJson({ status: 'error', message: '不明なアクション: ' + data.action });
  } catch (err) {
    return _replyJson({ status: 'error', message: String(err) });
  }
}

// ===== 回答を保存 =====
// reply.html の payload:
//   { key, action:'reply', id, status, method, date, time, contact, memo, ua, at }
//   status  : '検討中' | '他社商談中' | '売却済み' | '売却中止'
//   method  : '出張査定' | '来店査定'（検討中/他社商談中のときのみ）
function handleReply(p) {
  if (p.key !== SECRET_KEY) return _replyJson({ status: 'error', message: '認証エラー' });

  var id     = String(p.id || '').trim();
  var status = String(p.status || '').trim();
  if (!status) return _replyJson({ status: 'error', message: '状況が空です' });

  // 案件シートから 顧客名・TEL・車名 を照合（見つからなくても続行）
  var info = findCaseRow_(id);

  var sh  = replySheet_();
  var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');

  // 受信日時 / 案件ID / 顧客名 / 車種 / 状況 / 査定方法 / 希望日 / 時間帯 / 連絡方法 / ご要望 / TEL / 端末
  sh.appendRow([
    now, id, info.customer, info.car,
    status,
    String(p.method || ''),
    String(p.date || ''),
    String(p.time || ''),
    String(p.contact || ''),
    String(p.memo || ''),
    info.tel,
    String(p.ua || '')
  ]);

  notifyChatwork_(now, id, info, status, p);

  return _replyJson({ status: 'success', message: 'ご回答ありがとうございました' });
}

// ===== 案件シートから id で行を探し、顧客名/TEL/車名 を返す =====
function findCaseRow_(id) {
  var out = { customer: '', tel: '', car: '' };
  if (!id) return out;
  try {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_CASE);
    if (!sh) return out;
    var last = sh.getLastRow();
    if (last < 2) return out;
    var vals = sh.getRange(2, 1, last - 1, Math.max(CASE_COL.car + 1, 6)).getValues();
    for (var i = 0; i < vals.length; i++) {
      if (String(vals[i][CASE_COL.id]).trim() === id) {
        out.customer = String(vals[i][CASE_COL.customer] || '');
        out.tel      = String(vals[i][CASE_COL.tel] || '');
        out.car      = String(vals[i][CASE_COL.car] || '');
        break;
      }
    }
  } catch (e) { /* 照合失敗は無視 */ }
  return out;
}

// ===== 顧客回答シート（無ければ作成）=====
function replySheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_REPLY);
  if (!sh) {
    sh = ss.insertSheet(SHEET_REPLY);
    sh.appendRow(['受信日時', '案件ID', '顧客名', '車種', '状況', '査定方法', '希望日', '時間帯', '連絡方法', 'ご要望', 'TEL', '端末']);
    sh.setFrozenRows(1);
  }
  return sh;
}

// ===== Chatwork 通知（スクリプトプロパティ未設定ならスキップ）=====
function notifyChatwork_(now, id, info, status, p) {
  try {
    var props = PropertiesService.getScriptProperties();
    var token = props.getProperty('CHATWORK_TOKEN');
    var room  = props.getProperty('CHATWORK_ROOM');
    if (!token || !room) return; // 未設定なら通知しない（記録は正常）

    var L = [];
    L.push('[info][title]お客様から回答がありました[/title]');
    L.push('案件ID: ' + id + (info.customer ? '（' + info.customer + ' 様）' : ''));
    if (info.car) L.push('車種: ' + info.car);
    L.push('状況: ' + status);
    if (p.method) L.push('査定方法: ' + p.method + (p.date ? ' / ' + p.date : '') + (p.time ? ' ' + p.time : ''));
    if (p.contact) L.push('連絡希望: ' + p.contact);
    if (p.memo) L.push('ご要望: ' + p.memo);
    if (info.tel) L.push('TEL: ' + info.tel);
    L.push('受信: ' + now);
    L.push('[/info]');

    UrlFetchApp.fetch('https://api.chatwork.com/v2/rooms/' + room + '/messages', {
      method: 'post',
      headers: { 'X-ChatWorkToken': token },
      contentType: 'application/x-www-form-urlencoded',
      payload: 'body=' + encodeURIComponent(L.join('\n')),
      muteHttpExceptions: true
    });
  } catch (e) { /* 通知失敗は記録に影響させない */ }
}

// ===== JSONレスポンス（既存に jsonResponse があればそれを使ってもOK）=====
function _replyJson(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

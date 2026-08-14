/**
 * kaimax 顧客回答ページ用エンドポイント（gas-reply-endpoint.gs）
 * ------------------------------------------------------------------
 * お客様の回答ページ(reply.html)から送信された内容を「顧客回答」シートに記録し、
 * 任意で Chatwork に通知します。案件シートから顧客名・TEL・車名を照合して補完します。
 *
 * ■ 既に doPost がある場合（kaimax の既存GASに追記する場合）
 *   1) 既存 doPost の中に、次の1行だけを足してください（変数名は既存に合わせる。多くは data）:
 *        if (data.action === 'reply') return handleReply(data);
 *   2) 下の handleReply / notifyChatwork_ / findCaseRow_ / replySheet_ / _replyJson を
 *      GASの末尾にそのまま貼り付けてください（重複しない関数名にしてあります）。
 *   3) 定数 SECRET_KEY は既存と同じ値なので、二重定義になる場合は下の宣言を削除してください。
 *
 * ■ doPost がまだ無い場合
 *   このファイルをそのまま貼り付ければ動きます。
 * ------------------------------------------------------------------
 */

// ===== 定数（環境に合わせて確認）=====
var SECRET_KEY  = 'indio9700';     // reply.html の KEY と一致させる
var SHEET_CASE  = 'マスタ案件';     // 案件シートの実際の名前に合わせる（顧客名/TEL照合用）
var SHEET_REPLY = '顧客回答';       // 回答の保存先（無ければ自動作成）

// 案件シートの列位置（0始まり）: A=案件NO, D=顧客名, E=TEL, F=車名
var CASE_COL = { id: 0, customer: 3, tel: 4, car: 5 };

// ===== doPost（既存が無い場合はこれを使用）=====
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    if (data.secret !== SECRET_KEY) return _replyJson({ status: 'error', message: '認証エラー' });

    if (data.action === 'reply') return handleReply(data);   // ← 既存doPostにはこの1行を足す

    return _replyJson({ status: 'error', message: '不明なアクション: ' + data.action });
  } catch (err) {
    return _replyJson({ status: 'error', message: String(err) });
  }
}

// ===== 回答を保存 =====
// payload: { id, car, answer('検討中'|'売却済'|'売却中止'), visit(bool), date('YYYY-MM-DD'|''), ua }
function handleReply(p) {
  var id     = String(p.id || '').trim();
  var answer = String(p.answer || '').trim();
  if (!answer) return _replyJson({ status: 'error', message: '回答が空です' });

  // 案件シートから顧客名・TEL・車名を照合（見つからなくても続行）
  var info = findCaseRow_(id);

  var sh = replySheet_();
  var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
  var visit = p.visit ? '希望' : '';
  var date  = String(p.date || '');
  var car   = String(p.car || info.car || '');

  // 受信日時 / 案件ID / 顧客名 / 車種 / 回答 / 出張査定 / 希望日 / TEL / 端末
  sh.appendRow([now, id, info.customer, car, answer, visit, date, info.tel, String(p.ua || '')]);

  notifyChatwork_(now, id, info.customer, car, answer, visit, date, info.tel);

  return _replyJson({ status: 'success', message: 'ご回答ありがとうございました' });
}

// ===== 案件シートから id で行を探し、顧客名/TEL/車名を返す =====
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
    sh.appendRow(['受信日時', '案件ID', '顧客名', '車種', '回答', '出張査定', '希望日', 'TEL', '端末']);
    sh.setFrozenRows(1);
  }
  return sh;
}

// ===== Chatwork 通知（スクリプトプロパティ未設定ならスキップ）=====
function notifyChatwork_(now, id, customer, car, answer, visit, date, tel) {
  try {
    var props = PropertiesService.getScriptProperties();
    var token = props.getProperty('CHATWORK_TOKEN');
    var room  = props.getProperty('CHATWORK_ROOM');
    if (!token || !room) return; // 未設定なら通知しない（記録は正常）

    var lines = [];
    lines.push('[info][title]お客様から回答がありました[/title]');
    lines.push('案件ID: ' + id + (customer ? '（' + customer + ' 様）' : ''));
    if (car) lines.push('車種: ' + car);
    lines.push('回答: ' + answer);
    if (visit) lines.push('出張査定: ' + visit + (date ? ' / 希望日 ' + date : ''));
    if (tel) lines.push('TEL: ' + tel);
    lines.push('受信: ' + now);
    lines.push('[/info]');

    var body = 'body=' + encodeURIComponent(lines.join('\n'));
    UrlFetchApp.fetch('https://api.chatwork.com/v2/rooms/' + room + '/messages', {
      method: 'post',
      headers: { 'X-ChatWorkToken': token },
      contentType: 'application/x-www-form-urlencoded',
      payload: body,
      muteHttpExceptions: true
    });
  } catch (e) { /* 通知失敗は記録に影響させない */ }
}

// ===== JSONレスポンス（既存に jsonResponse があればそちらを使ってもOK）=====
function _replyJson(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

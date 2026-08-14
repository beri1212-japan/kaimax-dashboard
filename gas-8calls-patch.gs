/**
 * 架電①〜⑧対応パッチ（gas-8calls-patch.gs）
 * ------------------------------------------------------------------
 * 既存GAS（kaimaxのメインGAS）の handleUpdateCalls を下の内容で「置き換え」、
 * さらに findHeaderCol_ / ensureHeaderCol_ の2つを末尾に「追記」してください。
 * その後「デプロイを管理」→ 既存デプロイを編集 →「新バージョン」で再デプロイ（URLは変わりません）。
 *
 * 方式: ①〜⑤は従来どおり J〜R（固定）。⑥⑦⑧は「マスタ案件」シートの右端に
 *       見出し（⑥結果/⑥日付/⑦結果/⑦日付/⑧結果/⑧日付）を自動作成して書き込みます。
 *       既存の列位置は一切ずらさないので、他の機能に影響しません。
 * ------------------------------------------------------------------
 */

// ▼ 既存の handleUpdateCalls を「この関数」で置き換える
function handleUpdateCalls(payload) {
  const sheet = getSheet();
  const targetNo = payload.no;
  if (!targetNo) return jsonResponse({ status: 'error', message: '案件NOが指定されていません' });
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return jsonResponse({ status: 'error', message: 'データがありません' });
  const noColumn = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  let targetRow = -1;
  for (let i = 0; i < noColumn.length; i++) {
    if (noColumn[i][0] == targetNo) { targetRow = i + 2; break; }
  }
  if (targetRow === -1) return jsonResponse({ status: 'error', message: `案件NO ${targetNo} が見つかりません` });
  // 実シート構造: J=①結果, K=②結果, L=②日付, M=③結果, N=③日付,
  //               O=④結果, P=④日付, Q=⑤結果, R=⑤日付 （①は日付列なし）
  sheet.getRange(targetRow, 10, 1, 9).setValues([[
    payload.call1 || '',
    payload.call2 || '', payload.call2Date || '',
    payload.call3 || '', payload.call3Date || '',
    payload.call4 || '', payload.call4Date || '',
    payload.call5 || '', payload.call5Date || ''
  ]]);
  // ★⑥⑦⑧: 右端に見出し付きで追記（既存列はずらさない）。値が入るか列が既にある時だけ書く
  [['call6', 'call6Date', '⑥結果', '⑥日付'],
   ['call7', 'call7Date', '⑦結果', '⑦日付'],
   ['call8', 'call8Date', '⑧結果', '⑧日付']].forEach(function (e) {
    var val = payload[e[0]] || '';
    var dat = payload[e[1]] || '';
    var rc = findHeaderCol_(sheet, e[2]);
    if (val || rc > 0) {
      if (rc < 0) rc = ensureHeaderCol_(sheet, e[2]);
      var dc = findHeaderCol_(sheet, e[3]); if (dc < 0) dc = ensureHeaderCol_(sheet, e[3]);
      sheet.getRange(targetRow, rc).setValue(val);
      sheet.getRange(targetRow, dc).setValue(dat);
    }
  });
  // 任意: 結果(T=20)・次回後追日(U=21) も指定があれば更新（未指定なら触らない）
  if (payload.followup !== undefined) sheet.getRange(targetRow, 21).setValue(payload.followup || '');
  if (payload.result !== undefined) sheet.getRange(targetRow, 20).setValue(payload.result || '');
  return jsonResponse({ status: 'success', message: `案件NO ${targetNo} のコール結果を更新しました`, no: targetNo });
}

// ▼ 以下2つを末尾に「追記」（既に同名があれば不要）
// 見出し名で列番号を返す（無ければ-1）
function findHeaderCol_(sheet, label) {
  var head = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  for (var i = 0; i < head.length; i++) { if (String(head[i]).trim() === label) return i + 1; }
  return -1;
}
// 見出し列が無ければ右端に作成して列番号を返す
function ensureHeaderCol_(sheet, label) {
  var c = findHeaderCol_(sheet, label);
  if (c > 0) return c;
  var col = sheet.getLastColumn() + 1;
  sheet.getRange(1, col).setValue(label);
  return col;
}

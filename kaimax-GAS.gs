/**
 * 買取案件管理ダッシュボード - 書き込み用Webhook
 * v4:MOTA自動収集ワーカー連携（入札結果の自動反映 mota_result 追加）
 *
 * 【変更点(v3→v4)】
 *  1) action='mota_result' を追加：受付終了案件のG列(入札)/H列(入札結果)を自動更新
 *  2) handleMotaResult() を追加：査定番号(備考X列)で行を探し、G/Hを更新（未登録はスキップ）
 *  3) filterCallTargets の勝ち判定に「現車確認」を追加（拡張機能の代替）
 *
 * 列構成(実シート準拠 / ①は結果のみで日付列なし):
 * A=案件NO, B=媒体, C=受信日, D=顧客名, E=TEL, F=車名,
 * G=入札, H=入札結果, I=ライバル社,
 * J=①結果, K=②結果, L=②日付, M=③結果, N=③日付,
 * O=④結果, P=④日付, Q=⑤結果, R=⑤日付,
 * S=査定, T=結果, U=次回後追日, V=担当者, W=備考,
 * X=顧客希望額, Y=査定提示額, Z=成約額,
 * AA=住所, AB=メール, AC=年式, AD=走行距離, （AF=32列目:通話メモ）
 */

const SECRET_KEY = 'indio9700';
const SHEET_NAME = 'マスタ案件';

// ============================================================
// メインエントリ
// ============================================================
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    if (data.secret !== SECRET_KEY) {
      return jsonResponse({ status: 'error', message: '認証エラー' });
    }
    const action = data.action;
    const payload = data.payload;

    if (action === 'create') return handleCreate(payload);
    if (action === 'update') return handleUpdate(payload);
    if (action === 'delete') return handleDelete(payload);

    // MOTA自動収集ワーカー用エンドポイント
    if (action === 'mota_create') return handleMotaCreate(payload);
    if (action === 'mota_won') return handleMotaWon(payload);
    if (action === 'mota_result') return handleMotaResult(payload);   // ★v4 追加

    if (action === 'update_calls') return handleUpdateCalls(payload); // ★一覧から①〜⑤コール結果だけ安全に更新
    if (action === 'update_memo') return handleUpdateMemo(payload);   // ★通話メモ(AF列)だけ安全に更新

    return jsonResponse({ status: 'error', message: '不明なアクション: ' + action });
  } catch (err) {
    return jsonResponse({ status: 'error', message: err.toString() });
  }
}

function doGet(e) {
  // GET ?action=list_assess_nos で登録済み査定番号一覧を返す
  if (e && e.parameter && e.parameter.action === 'list_assess_nos') {
    return jsonResponse(getAssessNoList());
  }

  return jsonResponse({
    status: 'ok',
    message: 'Carriage Dashboard Webhook v4 (MOTA連携強化版)',
    timestamp: new Date().toISOString()
  });
}

// 登録済み査定番号の一覧を返す(ワーカーがチェック用に呼ぶ)
function getAssessNoList() {
  try {
    const sheet = getSheet();
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { status: 'success', items: [] };

    // A列(案件NO)とX列(備考)を取得
    const noColumn = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    const noteColumn = sheet.getRange(2, 23, lastRow - 1, 1).getValues();

    const items = [];
    for (let i = 0; i < noColumn.length; i++) {
      const no = noColumn[i][0];
      const note = String(noteColumn[i][0] || '');
      // 査定番号を備考から抽出
      const match = note.match(/査定番号:\s*(\d+)/);
      if (match) {
        items.push({
          no: no,
          assessNo: match[1],
          row: i + 2
        });
      }
    }

    return { status: 'success', items: items };
  } catch (err) {
    return { status: 'error', message: err.toString() };
  }
}

// ============================================================
// 通常の新規追加(ダッシュボードから)
// ============================================================
function handleCreate(payload) {
  const sheet = getSheet();
  const newNo = getNextNo(sheet);
  const row = buildRow(payload, newNo);
  sheet.appendRow(row);
  return jsonResponse({ status: 'success', message: `案件NO ${newNo} を追加しました`, no: newNo });
}

// ============================================================
// MOTA:車両情報の取込(受信時)
// 重複チェック:査定番号が既に備考にあれば追加しない
// ============================================================
function handleMotaCreate(payload) {
  const sheet = getSheet();

  // 査定番号で重複チェック
  const assessNo = payload.assessNo ? String(payload.assessNo).trim() : '';

  // 空または不正な査定番号は弾く
  if (!assessNo || assessNo === ':' || !/^\d+$/.test(assessNo)) {
    return jsonResponse({
      status: 'error',
      message: '査定番号が取得できませんでした(MOTAページ構造を確認してください)'
    });
  }

  if (assessNo) {
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      const noteRange = sheet.getRange(2, 23, lastRow - 1, 1).getValues();
      for (let i = 0; i < noteRange.length; i++) {
        const note = String(noteRange[i][0] || '');
        if (note.includes('査定番号:' + assessNo)) {
          return jsonResponse({
            status: 'duplicate',
            message: `査定番号 ${assessNo} は既に登録済みです`,
            existingRow: i + 2
          });
        }
      }
    }
  }

  const newNo = getNextNo(sheet);

  // 受信日(今日)
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/M/d');

  // 備考に集約する情報
  const noteFields = [];
  if (assessNo) noteFields.push('査定番号:' + assessNo);
  if (payload.modelCode) noteFields.push('型式:' + payload.modelCode);
  if (payload.bodyNo) noteFields.push('車台:' + payload.bodyNo);
  if (payload.displacement) noteFields.push('排気量:' + payload.displacement);
  if (payload.repair) noteFields.push('修復歴:' + payload.repair);
  if (payload.color) noteFields.push('色:' + payload.color);
  if (payload.inspection) noteFields.push('車検:' + payload.inspection);
  if (payload.fuel) noteFields.push('燃料:' + payload.fuel);
  if (payload.transmission) noteFields.push('MT/AT:' + payload.transmission);
  if (payload.handle) noteFields.push('ハンドル:' + payload.handle);
  if (payload.timing) noteFields.push('売却希望:' + payload.timing);
  if (payload.replacement) noteFields.push('乗換検討:' + payload.replacement);

  const row = [
    newNo,                       // A:案件NO
    'MOTA',                      // B:媒体
    today,                       // C:受信日
    '',                          // D:顧客名(まだ不明)
    '',                          // E:TEL(まだ不明)
    payload.car || '',           // F:車名
    '',                          // G:入札(現場で判断)
    '',                          // H:入札結果
    '',                          // I:ライバル社
    '',                          // J:①結果(日付列なし)
    '', '',                      // K,L:②結果,日付
    '', '',                      // M,N:③結果,日付
    '', '',                      // O,P:④結果,日付
    '', '',                      // Q,R:⑤結果,日付
    '',                          // S:査定
    '',                          // T:結果
    '',                          // U:次回後追日
    '',                          // V:担当者
    noteFields.join(' / '),      // W:備考(集約)
    '',                          // Y:顧客希望額
    '',                          // Z:査定提示額
    '',                          // AA:成約額
    '',                          // AB:住所
    '',                          // AC:メール
    payload.year || '',          // AD:年式
    payload.mileage || '',       // AE:走行距離
  ];

  sheet.appendRow(row);
  return jsonResponse({
    status: 'success',
    message: `MOTA案件NO ${newNo} を追加(${payload.car || '車種不明'})`,
    no: newNo
  });
}

// ============================================================
// ★v4追加:MOTA 入札結果の自動反映（受付終了一覧のG列/H列）
// 査定番号(備考X列)で該当行を探し、G=入札(〇/×)、H=入札結果 を更新。
// ・未登録(査定番号が備考に無い)行はスキップ → 手入力行と競合しない
// ・H列が「権利獲得」の行は勝ち状態のため保持（現車確認で上書きしない）
// ・同じ値なら書き込まない（冪等・毎時実行しても無駄書き込みなし）
// payload: { assessNo, bid('〇' or '×'), bidResult('未入札'/'他社決定'/'現車確認'/'入札見送り'/'キャンセル') }
// ============================================================
function handleMotaResult(payload) {
  const sheet = getSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return jsonResponse({ status: 'error', message: 'データがありません' });

  const assessNo = payload.assessNo ? String(payload.assessNo).trim() : '';
  if (!assessNo || !/^\d+$/.test(assessNo)) {
    return jsonResponse({ status: 'error', message: '査定番号が不正です' });
  }
  const bid = payload.bid || '';
  const bidResult = payload.bidResult || '';

  // 査定番号で該当行を検索(備考列X=24)
  const noteRange = sheet.getRange(2, 23, lastRow - 1, 1).getValues();
  let targetRow = -1;
  for (let i = 0; i < noteRange.length; i++) {
    if (String(noteRange[i][0] || '').includes('査定番号:' + assessNo)) {
      targetRow = i + 2;
      break;
    }
  }
  if (targetRow === -1) {
    return jsonResponse({ status: 'not_found', message: `査定番号 ${assessNo} は未登録(スキップ)` });
  }

  const curG = String(sheet.getRange(targetRow, 7).getValue() || '').trim();
  const curH = String(sheet.getRange(targetRow, 8).getValue() || '').trim();

  // 旧Chrome拡張が付けた「権利獲得」は勝ち状態なので保持（現車確認で後退させない）
  if (curH === '権利獲得') {
    let g2 = false;
    if (curG !== '〇') { sheet.getRange(targetRow, 7).setValue('〇'); g2 = true; }
    return jsonResponse({
      status: g2 ? 'success' : 'skipped',
      message: `案件NO ${sheet.getRange(targetRow, 1).getValue()} は権利獲得を保持`,
      row: targetRow
    });
  }

  let changed = false;
  if (curG !== bid) { sheet.getRange(targetRow, 7).setValue(bid); changed = true; }
  if (curH !== bidResult) { sheet.getRange(targetRow, 8).setValue(bidResult); changed = true; }

  return jsonResponse({
    status: changed ? 'success' : 'unchanged',
    message: `案件NO ${sheet.getRange(targetRow, 1).getValue()} G:${bid}/H:${bidResult}`,
    row: targetRow
  });
}

// ============================================================
// MOTA:権利獲得後の情報更新（※旧Chrome拡張用。使わなくても残して問題なし）
// 査定番号から該当行を見つけて、顧客情報・ライバル社情報を上書き
// ============================================================
function handleMotaWon(payload) {
  const sheet = getSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return jsonResponse({ status: 'error', message: 'データがありません' });

  const assessNo = payload.assessNo;
  if (!assessNo) {
    return jsonResponse({ status: 'error', message: '査定番号が指定されていません' });
  }

  // 査定番号で該当行を検索(備考列X)
  const noteRange = sheet.getRange(2, 23, lastRow - 1, 1).getValues();
  let targetRow = -1;
  for (let i = 0; i < noteRange.length; i++) {
    const note = String(noteRange[i][0] || '');
    if (note.includes('査定番号:' + assessNo)) {
      targetRow = i + 2;
      break;
    }
  }

  if (targetRow === -1) {
    return handleMotaCreateAndWon(payload);
  }

  // 既に「権利獲得」がH列に入っていて、かつD列(顧客名)も入っていれば「反映済み」と判断
  const existingResult = String(sheet.getRange(targetRow, 8).getValue() || '');
  const existingCustomer = String(sheet.getRange(targetRow, 4).getValue() || '');
  if (existingResult === '権利獲得' && existingCustomer) {
    return jsonResponse({
      status: 'duplicate',
      message: `既に権利獲得情報が反映済みです(案件NO ${sheet.getRange(targetRow, 1).getValue()})`,
      row: targetRow
    });
  }

  // 既存の備考を取得
  const existingNote = String(sheet.getRange(targetRow, 23).getValue() || '');

  // 権利獲得情報を備考に追記
  const wonNoteFields = [];
  if (payload.rivals && payload.rivals.length > 0) {
    const rivalSummary = payload.rivals.map((r, i) =>
      `${i+1}位:${r.name}(${r.amount})`
    ).join(' / ');
    wonNoteFields.push('ライバル詳細:' + rivalSummary);
  }
  if (payload.ourRank) wonNoteFields.push('自社順位:' + payload.ourRank + '位');

  const updatedNote = existingNote + (wonNoteFields.length > 0 ? '\n' + wonNoteFields.join(' / ') : '');

  // ライバル社の名前リスト(I列用)
  const rivalNames = (payload.rivals || []).map(r => r.name).filter(n => n).join('、');

  // 該当行を更新
  // D=顧客名、E=TEL、H=入札結果、I=ライバル社、X=備考、AB=住所、AC=メール
  sheet.getRange(targetRow, 4).setValue(payload.customer || '');     // D
  sheet.getRange(targetRow, 5).setValue(payload.tel || '');           // E
  sheet.getRange(targetRow, 7).setValue('〇');                         // G:入札 → 入札したから権獲できた
  sheet.getRange(targetRow, 8).setValue('権利獲得');                    // H:入札結果
  if (rivalNames) {
    sheet.getRange(targetRow, 9).setValue(rivalNames);                  // I:ライバル社
  }
  sheet.getRange(targetRow, 23).setValue(updatedNote);                  // X:備考
  if (payload.address) sheet.getRange(targetRow, 27).setValue(payload.address);  // AA:住所
  if (payload.email) sheet.getRange(targetRow, 28).setValue(payload.email);      // AB:メール

  return jsonResponse({
    status: 'success',
    message: `案件NO ${sheet.getRange(targetRow, 1).getValue()} を権利獲得情報で更新しました`,
    row: targetRow
  });
}

// 権利獲得後だが、まだスプシに該当行がない場合の処理
function handleMotaCreateAndWon(payload) {
  const sheet = getSheet();
  const newNo = getNextNo(sheet);
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/M/d');

  const noteFields = [];
  if (payload.assessNo) noteFields.push('査定番号:' + payload.assessNo);
  if (payload.modelCode) noteFields.push('型式:' + payload.modelCode);
  if (payload.bodyNo) noteFields.push('車台:' + payload.bodyNo);
  if (payload.repair) noteFields.push('修復歴:' + payload.repair);
  if (payload.rivals && payload.rivals.length > 0) {
    const rivalSummary = payload.rivals.map((r, i) =>
      `${i+1}位:${r.name}(${r.amount})`
    ).join(' / ');
    noteFields.push('ライバル詳細:' + rivalSummary);
  }
  if (payload.ourRank) noteFields.push('自社順位:' + payload.ourRank + '位');

  const rivalNames = (payload.rivals || []).map(r => r.name).filter(n => n).join('、');

  const row = [
    newNo, 'MOTA', today,
    payload.customer || '',
    payload.tel || '',
    payload.car || '',
    '〇', '権利獲得', rivalNames,
    '',                          // J:①結果(日付なし)
    '', '', '', '', '', '', '', '',  // K〜R:②〜⑤(結果+日付)
    '', '', '', '',              // S,T,U,V:査定,結果,次回後追日,担当者
    noteFields.join(' / '),      // W:備考
    '', '', '',                  // X,Y,Z:顧客希望額,査定提示額,成約額
    payload.address || '',       // AA:住所
    payload.email || '',         // AB:メール
    payload.year || '',          // AC:年式
    payload.mileage || '',       // AD:走行距離
  ];

  sheet.appendRow(row);
  return jsonResponse({
    status: 'success',
    message: `MOTA権獲案件NO ${newNo} を新規追加しました`,
    no: newNo
  });
}

// ============================================================
// 通常更新
// ============================================================
function handleUpdate(payload) {
  const sheet = getSheet();
  const targetNo = payload.no;
  if (!targetNo) return jsonResponse({ status: 'error', message: '案件NOが指定されていません' });

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return jsonResponse({ status: 'error', message: 'データがありません' });

  const noColumn = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  let targetRow = -1;
  for (let i = 0; i < noColumn.length; i++) {
    if (noColumn[i][0] == targetNo) {
      targetRow = i + 2;
      break;
    }
  }

  if (targetRow === -1) {
    return jsonResponse({ status: 'error', message: `案件NO ${targetNo} が見つかりません` });
  }

  const row = buildRow(payload, targetNo);
  sheet.getRange(targetRow, 1, 1, row.length).setValues([row]);
  return jsonResponse({ status: 'success', message: `案件NO ${targetNo} を更新しました`, no: targetNo });
}

// ============================================================
// 一覧画面から①〜⑤のコール結果だけを安全に更新（他の列には一切触れない）
// payload: { no, call1..call5, call1Date..call5Date, (任意) followup, result }
// ============================================================
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
  // 任意: 結果(T=20)・次回後追日(U=21) も指定があれば更新（未指定なら触らない）
  if (payload.followup !== undefined) sheet.getRange(targetRow, 21).setValue(payload.followup || '');
  if (payload.result !== undefined) sheet.getRange(targetRow, 20).setValue(payload.result || '');
  return jsonResponse({ status: 'success', message: `案件NO ${targetNo} のコール結果を更新しました`, no: targetNo });
}

// ============================================================
// 通話メモだけ安全に更新（AF列=32）。他のデータは一切触らない
// ============================================================
function handleUpdateMemo(payload) {
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
  // 見出しが未設定なら AF1 に「通話メモ」を入れておく（初回のみ）
  if (!sheet.getRange(1, 32).getValue()) sheet.getRange(1, 32).setValue('通話メモ');
  sheet.getRange(targetRow, 32).setValue(payload.memo || ''); // AF列:通話メモ
  return jsonResponse({ status: 'success', message: `案件NO ${targetNo} の通話メモを保存しました`, no: targetNo });
}

// ============================================================
// 削除
// ============================================================
function handleDelete(payload) {
  const sheet = getSheet();
  const targetNo = payload.no;
  if (!targetNo) return jsonResponse({ status: 'error', message: '案件NOが指定されていません' });

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return jsonResponse({ status: 'error', message: 'データがありません' });

  const noColumn = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < noColumn.length; i++) {
    if (noColumn[i][0] == targetNo) {
      sheet.deleteRow(i + 2);
      return jsonResponse({ status: 'success', message: `案件NO ${targetNo} を削除しました` });
    }
  }
  return jsonResponse({ status: 'error', message: `案件NO ${targetNo} が見つかりません` });
}

// ============================================================
// ヘルパー
// ============================================================
function buildRow(p, no) {
  return [
    no,
    p.media || '',
    p.date || '',
    p.customer || '',
    p.tel || '',
    p.car || '',
    p.bid || '',
    p.bidResult || '',
    p.rival || '',
    p.call1 || '',                    // J:①結果(日付列なし)
    p.call2 || '',  p.call2Date || '', // K,L:②結果,日付
    p.call3 || '',  p.call3Date || '', // M,N:③結果,日付
    p.call4 || '',  p.call4Date || '', // O,P:④結果,日付
    p.call5 || '',  p.call5Date || '', // Q,R:⑤結果,日付
    p.assess || '',
    p.result || '',
    p.followup || '',
    p.assignee || '',
    p.note || '',
    p.desired || '',
    p.offered || '',
    p.deal || '',
    p.address || '',
    p.email || '',
    p.year || '',
    p.mileage || '',
  ];
}

function getNextNo(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 1;
  const noColumn = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  const nos = noColumn.flat().filter(x => typeof x === 'number');
  return nos.length > 0 ? Math.max(...nos) + 1 : 1;
}

function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error(`シート「${SHEET_NAME}」が見つかりません`);
  return sheet;
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// スプシにカスタムメニューを追加
// ============================================================
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('🔧 kaimax')
    .addItem('📞 要コール案件のみ表示', 'filterCallTargets')
    .addItem('📋 全表示(フィルタ解除)', 'clearFilter')
    .addSeparator()
    .addItem('ℹ 使い方', 'showHelp')
    .addToUi();
}

// ============================================================
// 要コール案件のみ表示
// ============================================================
function filterCallTargets() {
  const sheet = getSheet();
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2) {
    SpreadsheetApp.getUi().alert('データがありません');
    return;
  }

  // 既存フィルタを削除
  const existingFilter = sheet.getFilter();
  if (existingFilter) existingFilter.remove();

  // データ範囲全体にフィルタを設定(ヘッダー行 + データ行)
  const range = sheet.getRange(1, 1, lastRow, lastCol);
  const filter = range.createFilter();

  // 結果(T列=20列目)で除外する値
  const excludeResults = [
    '成約', '自社代替', '他社売却',
    '売らない', '売却しない', 'しない', '売りたくない',
    '検討(長期)', '検討(長期)',  // 半角・全角両対応
    '5コール完', '5コール完了'
  ];

  // T列のフィルタ条件:除外リストに「ない」値のみ表示
  const resultCriteria = SpreadsheetApp.newFilterCriteria()
    .setHiddenValues(excludeResults)
    .build();
  filter.setColumnFilterCriteria(20, resultCriteria);  // T列 = 20列目(結果)

  // データを取得して、各行で「要コール」かどうか判定
  // MOTA案件は勝ち(権利獲得/現車確認)のみ、それ以外は無条件
  const data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const rowsToHide = [];

  data.forEach((row, idx) => {
    const media = String(row[1] || '').trim();   // B列
    const bid = String(row[6] || '').trim();      // G列
    const bidResult = String(row[7] || '').trim(); // H列

    if (media === 'MOTA') {
      // MOTA:入札〇 かつ 入札結果が「権利獲得」「現車確認」「〇」「落札」 でなければ非表示
      const bidOK = (bid === '〇' || bid === '入札');
      const wonOK = ['〇', '落札', '権利獲得', '現車確認'].includes(bidResult);  // ★v4:現車確認を追加
      if (!bidOK || !wonOK) {
        rowsToHide.push(idx + 2);  // 実際の行番号(2行目から始まる)
      }
    }
    // MOTA以外は条件なし(全て表示対象)
  });

  // 連続する非表示行をまとめて hide することで処理を高速化
  if (rowsToHide.length > 0) {
    let start = rowsToHide[0];
    let count = 1;
    for (let i = 1; i < rowsToHide.length; i++) {
      if (rowsToHide[i] === rowsToHide[i-1] + 1) {
        count++;
      } else {
        sheet.hideRows(start, count);
        start = rowsToHide[i];
        count = 1;
      }
    }
    sheet.hideRows(start, count);
  }

  SpreadsheetApp.getActiveSpreadsheet().toast(
    `要コール案件を表示中(${data.length - rowsToHide.length}件中、結果フィルタ適用後の件数を確認)`,
    '🔧 kaimax フィルタ',
    5
  );
}

// ============================================================
// 全表示(フィルタ解除)
// ============================================================
function clearFilter() {
  const sheet = getSheet();
  const lastRow = sheet.getLastRow();

  // フィルタを削除
  const existingFilter = sheet.getFilter();
  if (existingFilter) existingFilter.remove();

  // 非表示行をすべて表示
  if (lastRow > 1) {
    sheet.showRows(2, lastRow - 1);
  }

  SpreadsheetApp.getActiveSpreadsheet().toast(
    '全案件を表示しています',
    '🔧 kaimax フィルタ',
    3
  );
}

// ============================================================
// 使い方ヘルプ
// ============================================================
function showHelp() {
  const message = `🔧 kaimax フィルタの使い方

【📞 要コール案件のみ表示】
以下の条件を満たす案件のみ表示します:
・MOTA案件は「入札〇 かつ 権利獲得/現車確認」のみ
・MOTA以外の媒体は全て対象
・結果(U列)が以下以外:
  - 成約 / 自社代替 / 他社売却
  - 売らない / 売却しない / しない / 売りたくない
  - 検討(長期) / 5コール完

【📋 全表示】
すべての案件を表示します(フィルタ解除)`;
  SpreadsheetApp.getUi().alert('kaimax フィルタの使い方', message, SpreadsheetApp.getUi().ButtonSet.OK);
}

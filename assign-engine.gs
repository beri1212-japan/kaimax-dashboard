/**
 * kaimax 自動割り振りエンジン  assign-engine.gs
 * ------------------------------------------------------------------
 * 目的: マスタ案件シートで「担当者(V列)」が空の“稼働中”案件に、担当者を自動割当。
 *       一案件一担当。前田70% / 残り30%を7名で均等（負荷を見て目標比率に寄せる）。
 * 安全: 既存の担当者は絶対に上書きしない。完了/対象外/MOTA未落札は割り当てない。
 *       まず「配分状況を表示」で確認 → 「未割当を自動割り振り」を手動実行、が推奨運用。
 *
 * 【インストール】
 *  1) Apps Scriptプロジェクトに本ファイルの内容を新規ファイルとして貼り付け → 保存
 *  2) 既存の onOpen に下記2行を追加（メニューから使えるようにする。任意）
 *       .addItem('未割当を自動割り振り', 'assignUnassigned')
 *       .addItem('担当配分の状況を表示', 'showAssignBalance')
 *     ※ onOはプロジェクトに1つだけ。別途 onOpen は作らないこと。
 *  3) まずはエディタで showAssignBalance を実行して権限承認 → 動作確認
 *  4) 自動実行したい場合のみ enableAssignTrigger() を1回実行（1時間ごと）。停止は disableAssignTrigger()
 * ------------------------------------------------------------------
 */

const AE_SHEET = 'マスタ案件';
// 列（1始まり）: A案件NO / B媒体 / G入札 / H入札結果 / T結果 / V担当者
const AE_COL = { no: 1, media: 2, bid: 7, bidResult: 8, result: 20, assignee: 22 };

// 担当者と目標比率。前田=0.70固定、その他(null)は残り0.30を均等配分。
const AE_TARGET_MAEDA = 0.70;
const AE_MEMBERS = ['前田', '川縁', '高木', '上野', '野村', '馬塚', '諸田', '石川'];
// 割当対象から外す担当者（退職など）。ここに名前を入れるとその人には割り当てない。
const AE_EXCLUDE = [];

// 目標比率テーブル {名前: 比率}
function ae_targets_() {
  const members = AE_MEMBERS.filter(function (n) { return AE_EXCLUDE.indexOf(n) < 0; });
  const t = {};
  const hasMaeda = members.indexOf('前田') >= 0;
  const others = members.filter(function (n) { return n !== '前田'; });
  if (hasMaeda && others.length > 0) {
    t['前田'] = AE_TARGET_MAEDA;
    const each = (1 - AE_TARGET_MAEDA) / others.length;
    others.forEach(function (n) { t[n] = each; });
  } else {
    // 前田不在などのフォールバック: 全員均等
    const each = 1 / members.length;
    members.forEach(function (n) { t[n] = each; });
  }
  return t;
}

function ae_sheet_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AE_SHEET);
  if (!sh) throw new Error('シート「' + AE_SHEET + '」が見つかりません');
  return sh;
}

// 稼働中(=割当対象)か。完了/対象外/MOTA未落札を除外
function ae_isActive_(row) {
  const result = String(row[AE_COL.result - 1] || '').trim();
  if (/(成約|入庫|他社売却|自社代替|売らない|売却しない|しない|着拒|着信拒否|失注|対象外|重複|媒体重複|キャンセル|見送)/.test(result)) return false;
  const media = String(row[AE_COL.media - 1] || '').trim();
  if (media === 'MOTA') {
    const bid = String(row[AE_COL.bid - 1] || '').trim();
    const wr = String(row[AE_COL.bidResult - 1] || '').trim();
    const bidOK = (bid === '〇' || bid === '入札');
    const wonOK = ['〇', '落札', '権利獲得'].indexOf(wr) >= 0;
    if (!(bidOK && wonOK)) return false; // MOTAで未落札は割当しない
  }
  return true;
}

// 現状の担当件数（稼働案件のみ）と未割当行を収集
function ae_scan_() {
  const sh = ae_sheet_();
  const last = sh.getLastRow();
  const width = Math.max(AE_COL.assignee, 22);
  const load = {}; AE_MEMBERS.forEach(function (n) { load[n] = 0; });
  const unassigned = []; // {rowNum}
  let activeTotal = 0, otherAssignee = 0;
  if (last >= 2) {
    const values = sh.getRange(2, 1, last - 1, width).getValues();
    values.forEach(function (row, i) {
      if (!ae_isActive_(row)) return;
      activeTotal++;
      const cur = String(row[AE_COL.assignee - 1] || '').trim();
      if (cur) {
        if (load[cur] !== undefined) load[cur]++; else otherAssignee++;
      } else {
        unassigned.push(i + 2);
      }
    });
  }
  return { sheet: sh, load: load, unassigned: unassigned, activeTotal: activeTotal, otherAssignee: otherAssignee };
}

// ★未割当を自動割り振り（既存担当は上書きしない）
function assignUnassigned() {
  const sc = ae_scan_();
  if (sc.unassigned.length === 0) {
    SpreadsheetApp.getActiveSpreadsheet().toast('未割当の稼働案件はありません', '🔧 kaimax割り振り', 5);
    return { status: 'nochange', assigned: 0 };
  }
  const targets = ae_targets_();
  const names = Object.keys(targets);
  const load = {}; names.forEach(function (n) { load[n] = sc.load[n] || 0; });
  const detail = {}; names.forEach(function (n) { detail[n] = 0; });

  sc.unassigned.forEach(function (rowNum) {
    // 目標(比率×総数)との差が最大の人へ1件割当（負荷分散）
    let totalAfter = 1; names.forEach(function (n) { totalAfter += load[n]; });
    let best = names[0], bestDef = -Infinity;
    names.forEach(function (n) {
      const def = targets[n] * totalAfter - load[n];
      if (def > bestDef) { bestDef = def; best = n; }
    });
    load[best]++; detail[best]++;
    sc.sheet.getRange(rowNum, AE_COL.assignee).setValue(best);
  });

  const msg = Object.keys(detail).filter(function (n) { return detail[n] > 0; })
    .map(function (n) { return n + ':' + detail[n]; }).join(' / ');
  SpreadsheetApp.getActiveSpreadsheet().toast('割当 ' + sc.unassigned.length + '件 → ' + msg, '🔧 kaimax割り振り', 8);
  return { status: 'success', assigned: sc.unassigned.length, detail: detail };
}

// 配分状況（現状の担当件数・比率・目標）をダイアログ表示
function showAssignBalance() {
  const sc = ae_scan_();
  const targets = ae_targets_();
  const names = Object.keys(targets);
  const assignedTotal = names.reduce(function (a, n) { return a + (sc.load[n] || 0); }, 0);
  let lines = ['稼働案件: ' + sc.activeTotal + '件（割当済 ' + assignedTotal + ' / 未割当 ' + sc.unassigned.length + '）', ''];
  names.forEach(function (n) {
    const cnt = sc.load[n] || 0;
    const pct = assignedTotal ? Math.round(cnt / assignedTotal * 1000) / 10 : 0;
    const tpct = Math.round(targets[n] * 1000) / 10;
    lines.push(n + ': ' + cnt + '件 (' + pct + '%) / 目標 ' + tpct + '%');
  });
  if (sc.otherAssignee > 0) lines.push('', '※ ロースター外の担当: ' + sc.otherAssignee + '件');
  SpreadsheetApp.getUi().alert('担当配分の状況', lines.join('\n'), SpreadsheetApp.getUi().ButtonSet.OK);
}

// 1時間ごとの自動割り振りをON（重複作成を防止）
function enableAssignTrigger() {
  disableAssignTrigger();
  ScriptApp.newTrigger('assignUnassigned').timeBased().everyHours(1).create();
  SpreadsheetApp.getActiveSpreadsheet().toast('自動割り振りを1時間ごとに実行します', '🔧 kaimax割り振り', 6);
}
// 自動割り振りをOFF
function disableAssignTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'assignUnassigned') ScriptApp.deleteTrigger(t);
  });
}

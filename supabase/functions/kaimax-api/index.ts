// kaimax-api: 旧 GAS Web App と同じ受け渡し形式 { secret?, action, payload } で kaimax_* テーブルを読み書きする。
//  - ワーカー(AIPC): URL末尾 /w/<鍵> または body.secret の鍵（SHA-256 が kaimax_worker_keys に登録されたもの）
//      許可: mota_create / mota_result / mota_won / mota_refill / GET ?action=list_assess_nos
//  - スタッフ(ダッシュボード): Authorization: Bearer <Supabaseのアクセストークン>
//      team_members に在籍し admin/車両販売部門の人、または kaimax_allowed_emails に登録されたメール。
//      許可: create / update / delete(論理削除) / update_calls / update_memo / update_meta / set_target(月別目標) / set_cost(月別コスト) / set_staff(担当者の追加・退職) / link_contract・unlink_contract(成約案件とsmart-sign買取契約の紐づけ) / set_outcome(成約車の成果管理。AA暫定価格=est_aa_yen も) / create_from_contract(契約から成約案件を新規作成) / import_contracts(smart-signの契約一覧を取り込み。ワーカーからも可) / set_contract_scope(契約を買取の成果に含める/含めない)
//      自社サイト買取ページ: voice_save・voice_flags(お客様の声) / model_save・model_flags(車種ページ) / news_save(買取ニュース) / faq_save(よくある質問) / carmaster_save(査定フォームの車種マスタ)
// 返り値は常に HTTP 200 + JSON（GAS と同じく status で成否を返す）
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { ...cors, "content-type": "application/json; charset=utf-8" } });

const WORKER_ACTIONS = new Set(["mota_create", "mota_result", "mota_won", "mota_refill", "import_contracts"]);
const MEDIA_KEYS = new Set(["mota", "carsensor", "navikuru", "line", "yahoo", "self", "shop", "other"]);
const STAFF_ACTIONS = new Set(["create", "update", "delete", "update_calls", "update_memo", "update_meta", "set_target", "set_cost", "set_staff", "link_contract", "unlink_contract", "set_outcome", "create_from_contract", "import_contracts", "set_contract_scope",
  "voice_save", "voice_flags", "model_save", "model_flags", "news_save", "faq_save", "carmaster_save"]);

// ---------- 共通ユーティリティ ----------
const t = (v: unknown) => String(v ?? "").trim();
const nz = (v: unknown) => { const s = t(v); return s === "" ? null : s; };
function ymd(y: number, m: number, d: number): string | null {
  if (!(y > 2000 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 ? dt.toISOString().slice(0, 10) : null;
}
function fullDate(s: string): string | null { const m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/); return m ? ymd(+m[1], +m[2], +m[3]) : null; }
function monthDay(s: string, base: string | null): string | null {
  const f = fullDate(s); if (f) return f;
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})(?!\d)/); if (!m) return null;
  const b = base || todayISO(); const by = +b.slice(0, 4);
  let d = ymd(by, +m[1], +m[2]);
  if (d && d < new Date(Date.parse(b) - 60 * 86400000).toISOString().slice(0, 10)) d = ymd(by + 1, +m[1], +m[2]);
  return d;
}
function todayISO() { return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10); }
function todaySheet() { const d = todayISO(); return `${+d.slice(0, 4)}/${+d.slice(5, 7)}/${+d.slice(8, 10)}`; }
function formatTel(raw: unknown): string | null {
  let d = t(raw).replace(/[^\d]/g, ""); if (!d) return null;
  if (d.length === 10 && /^[5789]/.test(d)) d = "0" + d;
  return d.length === 11 && d[0] === "0" ? `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}` : d;
}
const yen = (s: unknown) => { const n = parseInt(t(s).replace(/[^\d]/g, "")); return Number.isFinite(n) && n > 0 && n < 2_000_000_000 ? n : null; };
const normResult = (s: string) => s.replace(/（/g, "(").replace(/）/g, ")").replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
async function sha256(s: string) { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join(""); }

async function audit(actor: string, action: string, case_no: number | null, payload: unknown) {
  await sb.from("kaimax_audit").insert({ actor, action, case_no, payload });
}
async function byNo(no: number) {
  const { data } = await sb.from("kaimax_cases").select("*").eq("case_no", no).is("deleted_at", null).maybeSingle();
  return data;
}
async function byAssess(assessNo: number) {
  const { data } = await sb.from("kaimax_cases").select("*").eq("mota_assess_no", assessNo).maybeSingle();
  return data;
}
async function insertCase(row: Record<string, unknown>) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: mx } = await sb.from("kaimax_cases").select("case_no").order("case_no", { ascending: false }).limit(1).maybeSingle();
    const next = ((mx?.case_no as number) || 0) + 1;
    const { data, error } = await sb.from("kaimax_cases").insert({ ...row, case_no: next }).select("id, case_no").single();
    if (!error) return data;
    if (!String(error.message).includes("duplicate")) throw new Error(error.message);
  }
  throw new Error("案件NOの採番に失敗しました");
}
// payload の callN / callNDate を位置(seq=N)どおりに反映。キーが無い位置は触らない
async function applyCalls(caseId: number, receivedOn: string | null, p: Record<string, unknown>, actor: string) {
  for (let n = 1; n <= 8; n++) {
    if (!(`call${n}` in p)) continue;
    const result = t(p[`call${n}`]);
    if (!result) { await sb.from("kaimax_calls").delete().eq("case_id", caseId).eq("seq", n); continue; }
    const raw = n === 1 ? "" : t(p[`call${n}Date`]);
    const { error } = await sb.from("kaimax_calls").upsert(
      { case_id: caseId, seq: n, result, called_raw: raw || null, called_on: raw ? monthDay(raw, receivedOn) : null },
      { onConflict: "case_id,seq" });
    if (error) throw new Error(error.message);
  }
  void actor;
}
// ダッシュボードの詳細パネル（旧 buildRow）→ 列
function detailFields(p: Record<string, unknown>) {
  const o: Record<string, unknown> = {};
  const set = (k: string, v: unknown) => { o[k] = v; };
  if ("media" in p) set("media", t(p.media) || "その他");
  if ("date" in p) { const d = t(p.date); set("received_raw", d || null); set("received_on", d ? fullDate(d) : null); }
  if ("customer" in p) set("customer_name", nz(p.customer));
  if ("tel" in p) set("tel", formatTel(p.tel));
  if ("car" in p) set("car_name", nz(p.car));
  if ("bid" in p) set("bid", nz(p.bid));
  if ("bidResult" in p) set("bid_result", nz(p.bidResult));
  if ("rival" in p) set("rival_memo", nz(p.rival));
  if ("assess" in p) { const a = t(p.assess); set("assess", a === "〇" || a === "×" ? a : null); }
  if ("result" in p) set("result", t(p.result) ? normResult(t(p.result)) : null);
  if ("followup" in p) { const f = t(p.followup); set("followup_raw", f || null); set("followup_on", f ? monthDay(f, null) : null); }
  if ("assignee" in p) set("assignee", nz(p.assignee));
  if ("note" in p) set("note", nz(p.note));
  if ("desired" in p) { set("desired_raw", nz(p.desired)); set("desired_yen", yen(p.desired)); }
  if ("offered" in p) { set("offered_raw", nz(p.offered)); set("offered_yen", yen(p.offered)); }
  if ("deal" in p) { set("deal_raw", nz(p.deal)); set("deal_yen", yen(p.deal)); }
  if ("address" in p) set("address", nz(p.address));
  if ("email" in p) set("email", nz(p.email));
  if ("year" in p) set("model_year", nz(p.year));
  if ("mileage" in p) set("mileage", nz(p.mileage));
  return o;
}
const MOTA_NOTE_FIELDS: [string, string][] = [["modelCode", "型式"], ["bodyNo", "車台"], ["displacement", "排気量"], ["repair", "修復歴"], ["color", "色"],
  ["inspection", "車検"], ["fuel", "燃料"], ["transmission", "MT/AT"], ["handle", "ハンドル"], ["timing", "売却希望"], ["replacement", "乗換検討"]];

// ---------- ワーカー用 ----------
async function motaCreate(p: Record<string, unknown>) {
  const assessNo = t(p.assessNo);
  if (!/^\d+$/.test(assessNo)) return { status: "error", message: "査定番号が取得できませんでした(MOTAページ構造を確認してください)" };
  const ex = await byAssess(+assessNo);
  if (ex) return { status: "duplicate", message: `査定番号 ${assessNo} は既に登録済みです`, no: ex.case_no };
  const note = ["査定番号:" + assessNo, ...MOTA_NOTE_FIELDS.filter(([k]) => t(p[k])).map(([k, l]) => `${l}:${t(p[k])}`)].join(" / ");
  const row = await insertCase({
    media: "MOTA", received_on: todayISO(), received_raw: todaySheet(), car_name: nz(p.car), note,
    model_year: nz(p.year), mileage: nz(p.mileage), sale_timing: nz(p.timing), mota_assess_no: +assessNo, source: "mota_worker",
  });
  await audit("worker", "mota_create", row.case_no, { assessNo });
  return { status: "success", message: `MOTA案件NO ${row.case_no} を追加(${t(p.car) || "車種不明"})`, no: row.case_no };
}
async function motaResult(p: Record<string, unknown>) {
  const assessNo = t(p.assessNo);
  if (!/^\d+$/.test(assessNo)) return { status: "error", message: "査定番号が不正です" };
  const c = await byAssess(+assessNo);
  if (!c || c.deleted_at) return { status: "not_found", message: `査定番号 ${assessNo} は未登録(スキップ)` };
  const bid = t(p.bid), bidResult = t(p.bidResult);
  if (c.bid_result === "権利獲得") {
    if (c.bid !== "〇") { await sb.from("kaimax_cases").update({ bid: "〇" }).eq("id", c.id); return { status: "success", message: `案件NO ${c.case_no} は権利獲得を保持` }; }
    return { status: "skipped", message: `案件NO ${c.case_no} は権利獲得を保持` };
  }
  if ((c.bid || "") === bid && (c.bid_result || "") === bidResult) return { status: "unchanged", message: `案件NO ${c.case_no} G:${bid}/H:${bidResult}` };
  await sb.from("kaimax_cases").update({ bid: bid || null, bid_result: bidResult || null }).eq("id", c.id);
  await audit("worker", "mota_result", c.case_no, { assessNo, bid, bidResult });
  return { status: "success", message: `案件NO ${c.case_no} G:${bid}/H:${bidResult}` };
}
async function motaWon(p: Record<string, unknown>) {
  const assessNo = t(p.assessNo);
  if (!/^\d+$/.test(assessNo)) return { status: "error", message: "査定番号が指定されていません" };
  const c = await byAssess(+assessNo);
  if (!c || c.deleted_at) {
    if (c?.deleted_at) return { status: "not_found", message: `査定番号 ${assessNo} は削除済み` };
    const row = await insertCase({
      media: "MOTA", received_on: todayISO(), received_raw: todaySheet(), customer_name: nz(p.customer), tel: formatTel(p.tel),
      car_name: nz(p.car), bid: "〇", bid_result: "権利獲得", note: "査定番号:" + assessNo, address: nz(p.address), email: nz(p.email),
      mota_assess_no: +assessNo, source: "mota_worker",
    });
    await audit("worker", "mota_won_create", row.case_no, { assessNo });
    return { status: "success", message: `MOTA権獲案件NO ${row.case_no} を新規追加しました`, no: row.case_no };
  }
  if (c.bid_result === "権利獲得" && c.customer_name) return { status: "duplicate", message: `既に権利獲得情報が反映済みです(案件NO ${c.case_no})` };
  const upd: Record<string, unknown> = { customer_name: nz(p.customer) ?? c.customer_name, tel: formatTel(p.tel) ?? c.tel, bid: "〇", bid_result: "権利獲得" };
  if (t(p.address) && !c.address) upd.address = t(p.address);
  if (t(p.email) && !c.email) upd.email = t(p.email);
  await sb.from("kaimax_cases").update(upd).eq("id", c.id);
  await audit("worker", "mota_won", c.case_no, { assessNo });
  return { status: "success", message: `案件NO ${c.case_no} を権利獲得情報で更新しました` };
}
async function motaRefill(p: Record<string, unknown>) {
  const assessNo = t(p.assessNo);
  const c = /^\d+$/.test(assessNo) ? await byAssess(+assessNo) : null;
  if (!c || c.deleted_at) return { status: "not_found", message: "対象行なし" };
  const note = t(c.note);
  const add = MOTA_NOTE_FIELDS.filter(([k, l]) => t(p[k]) && !note.includes(l + ":")).map(([k, l]) => `${l}:${t(p[k])}`);
  const upd: Record<string, unknown> = {};
  if (add.length) upd.note = (note ? note + " / " : "") + add.join(" / ");
  if (!c.sale_timing && t(p.timing)) upd.sale_timing = t(p.timing);
  if (!Object.keys(upd).length) return { status: "nochange", message: "変更なし" };
  await sb.from("kaimax_cases").update(upd).eq("id", c.id);
  await audit("worker", "mota_refill", c.case_no, { assessNo, added: add.length });
  return { status: "updated", message: `案件NO ${c.case_no} に ${add.length} 項目を補完` };
}
async function listAssessNos() {
  const items: { no: number; assessNo: string }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("kaimax_cases").select("case_no, mota_assess_no").not("mota_assess_no", "is", null).range(from, from + 999);
    if (error) return { status: "error", message: error.message };
    (data ?? []).forEach((r) => items.push({ no: r.case_no, assessNo: String(r.mota_assess_no) }));
    if (!data || data.length < 1000) break;
  }
  return { status: "success", items };
}

// ---------- スタッフ用 ----------
async function staffAction(action: string, p: Record<string, unknown>, actor: string) {
  if (action === "create") {
    const f = detailFields(p);
    const row = await insertCase({ ...f, media: f.media ?? "その他", source: "manual" });
    const { data: c } = await sb.from("kaimax_cases").select("id, received_on").eq("case_no", row.case_no).single();
    await applyCalls(c!.id, c!.received_on, p, actor);
    await audit(actor, "create", row.case_no, p);
    return { status: "success", message: `案件NO ${row.case_no} を追加しました`, no: row.case_no };
  }
  if (action === "set_target") {
    // 月別目標（担当者×月）。target が空・0 なら削除
    const ym = t(p.ym), name = t(p.name);
    if (!/^\d{4}-\d{2}$/.test(ym) || !name || name.length > 30) return { status: "error", message: "月または担当者が不正です" };
    const n = parseInt(t(p.target).replace(/[^\d]/g, ""));
    if (!n || n <= 0) {
      await sb.from("kaimax_targets").delete().eq("ym", ym).eq("assignee", name);
    } else {
      if (n >= 10000) return { status: "error", message: "目標が大きすぎます" };
      const { error } = await sb.from("kaimax_targets").upsert({ ym, assignee: name, target: n, updated_by: actor, updated_at: new Date().toISOString() }, { onConflict: "ym,assignee" });
      if (error) return { status: "error", message: error.message };
    }
    await audit(actor, "set_target", null, { ym, name, target: n || 0 });
    return { status: "success", message: `${ym} ${name} の目標を保存しました` };
  }
  if (action === "set_cost") {
    // 月別コスト（円）。kind=media は item に媒体キー、kind=other は費目名。金額が空なら削除（0は0円として保存）
    const ym = t(p.ym), kind = t(p.kind), item = t(p.item);
    if (!/^\d{4}-\d{2}$/.test(ym) || !["media", "other"].includes(kind) || !item || item.length > 40) return { status: "error", message: "月・区分・費目が不正です" };
    if (kind === "media" && !MEDIA_KEYS.has(item)) return { status: "error", message: "媒体が不正です" };
    const raw = t(p.amount).replace(/[^\d]/g, "");
    if (raw === "") {
      await sb.from("kaimax_costs").delete().eq("ym", ym).eq("kind", kind).eq("item", item);
    } else {
      const n = Number(raw);
      if (!Number.isSafeInteger(n) || n >= 100_000_000_000) return { status: "error", message: "金額が大きすぎます" };
      const { error } = await sb.from("kaimax_costs").upsert({ ym, kind, item, amount: n, updated_by: actor, updated_at: new Date().toISOString() }, { onConflict: "ym,kind,item" });
      if (error) return { status: "error", message: error.message };
    }
    await audit(actor, "set_cost", null, { ym, kind, item, amount: raw === "" ? null : Number(raw) });
    return { status: "success", message: `${ym} ${item} のコストを保存しました` };
  }
  if (action === "set_staff") {
    // 担当者名簿。status: active(在籍) / archived(退職)
    const name = t(p.name), st = t(p.status) || "active";
    if (!name || name.length > 30 || !["active", "archived"].includes(st)) return { status: "error", message: "担当者名または状態が不正です" };
    const { error } = await sb.from("kaimax_staff").upsert({ name, status: st, updated_by: actor, updated_at: new Date().toISOString() }, { onConflict: "name" });
    if (error) return { status: "error", message: error.message };
    await audit(actor, "set_staff", null, { name, status: st });
    return { status: "success", message: `担当者「${name}」を${st === "archived" ? "退職" : "在籍"}にしました` };
  }
  if (action === "import_contracts") {
    // smart-sign 買取契約一覧（ダウンロードしたExcel）を画面で読み、必要な列だけ送ってくる。契約番号で上書き
    const src = Array.isArray(p.rows) ? p.rows : [];
    if (!src.length || src.length > 2000) return { status: "error", message: "取り込む行がありません（または多すぎます）" };
    const day = (v: unknown) => { const m = t(v).match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/); return m ? ymd(+m[1], +m[2], +m[3]) : null; };
    const int = (v: unknown) => { const r = t(v).replace(/[,円\s]/g, ""); return /^-?\d+$/.test(r) && Math.abs(Number(r)) < 2_000_000_000 ? Number(r) : null; };
    const s100 = (v: unknown) => { const r = t(v).normalize("NFKC").replace(/\u3000/g, " ").trim(); return r ? r.slice(0, 100) : null; };
    const recs = [];
    for (const r0 of src) {
      const r = (r0 || {}) as Record<string, unknown>;
      const no = t(r.contract_no), on = day(r.contract_on), st = s100(r.status);
      if (!/^\d{6,20}$/.test(no) || !on || !st) continue;
      recs.push({ contract_no: no, contract_on: on, status: st, cancel_on: day(r.cancel_on), customer_name: s100(r.customer_name), maker: s100(r.maker), car: s100(r.car), grade: s100(r.grade),
        vin: s100(r.vin), first_reg: s100(r.first_reg), mileage: int(r.mileage), insmart_car_id: s100(r.insmart_car_id), amount: int(r.amount), trade_in_yen: int(r.trade_in_yen),
        assignee: s100(r.assignee), car_received_on: day(r.car_received_on), paid_on: day(r.paid_on),
        auto_kind: ["下取り", "リース"].includes(t(r.auto_kind)) ? t(r.auto_kind) : null, source: "smart-sign", synced_at: new Date().toISOString() });
    }
    if (!recs.length) return { status: "error", message: "契約番号・契約日・ステータスが読めませんでした（smart-signの買取契約一覧のファイルか確認してください）" };
    const nos = recs.map((r) => r.contract_no);
    const { data: before } = await sb.from("kaimax_contracts").select("contract_no").in("contract_no", nos);
    const { error } = await sb.from("kaimax_contracts").upsert(recs, { onConflict: "contract_no" });
    if (error) return { status: "error", message: error.message };
    const added = recs.length - (before?.length ?? 0);
    await audit(actor, "import_contracts", null, { rows: recs.length, added, from: recs.reduce((m, r) => r.contract_on < m ? r.contract_on : m, "9999"), to: recs.reduce((m, r) => r.contract_on > m ? r.contract_on : m, "0000") });
    return { status: "success", message: `契約 ${recs.length}件を取り込みました（新規 ${added}件・更新 ${recs.length - added}件）`, rows: recs.length, added };
  }
  if (["voice_save", "voice_flags", "model_save", "model_flags", "news_save", "faq_save", "carmaster_save"].includes(action)) return await siteAction(action, p, actor);
  if (action === "set_contract_scope") {
    // 契約を買取事業の成果に含めるか（下取り・リース満了の手続き上の契約などを外す）。excluded=null で自動判定に戻す
    const contractNo = t(p.contractNo), reason = t(p.reason).slice(0, 50);
    const ex = p.excluded === true ? true : p.excluded === false ? false : null;
    const { data: k } = await sb.from("kaimax_contracts").select("contract_no, excluded, exclude_reason").eq("contract_no", contractNo).maybeSingle();
    if (!k) return { status: "error", message: "契約が見つかりません" };
    const { error } = await sb.from("kaimax_contracts").update({ excluded: ex, exclude_reason: ex ? (reason || "その他") : null, scope_by: actor, scope_at: new Date().toISOString() }).eq("contract_no", contractNo);
    if (error) return { status: "error", message: error.message };
    await audit(actor, "set_contract_scope", null, { contractNo, excluded: ex, reason, prev: { excluded: k.excluded, reason: k.exclude_reason } });
    return { status: "success", message: ex ? `契約 ${contractNo} を成果の対象外にしました` : `契約 ${contractNo} を成果の対象に戻しました` };
  }
  if (action === "create_from_contract") {
    // 店頭即決などで kaimax に案件が無い成約を、smart-sign の契約から作る（結果=成約・紐づけ済みで作成）
    const MEDIA_LABELS = ["MOTA", "カーセンサー", "ナビクル", "LINE", "Yahoo!", "自社サイト", "店頭", "その他"];
    const contractNo = t(p.contractNo), media = t(p.media) || "店頭", assignee = t(p.assignee);
    if (!MEDIA_LABELS.includes(media)) return { status: "error", message: "媒体が不正です" };
    if (assignee.length > 30) return { status: "error", message: "担当者名が長すぎます" };
    const { data: k } = await sb.from("kaimax_contracts").select("*").eq("contract_no", contractNo).maybeSingle();
    if (!k) return { status: "error", message: "契約が見つかりません" };
    if (k.status !== "契約済") return { status: "error", message: `この契約は「${k.status}」です` };
    const { data: other } = await sb.from("kaimax_cases").select("case_no").eq("contract_no", contractNo).is("deleted_at", null).maybeSingle();
    if (other) return { status: "error", message: `この契約は案件NO ${other.case_no} に紐づけ済みです` };
    const on = k.contract_on as string, y = String(k.first_reg || "").slice(0, 4);
    const row = await insertCase({
      media, received_on: on, received_raw: `${+on.slice(0, 4)}/${+on.slice(5, 7)}/${+on.slice(8, 10)}`,
      customer_name: k.customer_name, car_name: [k.maker, k.car, k.grade].filter(Boolean).join(" ") || null,
      result: "成約", assignee: assignee || null, model_year: /^\d{4}$/.test(y) ? y + "年" : null,
      mileage: k.mileage ? `${Number(k.mileage).toLocaleString("ja-JP")}km` : null,
      deal_yen: k.amount || null, deal_raw: k.amount ? `${Number(k.amount).toLocaleString("ja-JP")}円` : null,
      vin: k.vin, contract_no: k.contract_no, deal_on: on, note: `smart-sign契約から作成（契約番号:${k.contract_no}）`, source: "smart-sign",
    });
    await audit(actor, "create_from_contract", row.case_no, { contractNo, media, assignee });
    return { status: "success", message: `案件NO ${row.case_no} を作成しました`, no: row.case_no };
  }
  const no = parseInt(t(p.no));
  if (!no) return { status: "error", message: "案件NOが指定されていません" };
  const c = await byNo(no);
  if (!c) return { status: "error", message: `案件NO ${no} が見つかりません` };

  if (action === "link_contract") {
    // smart-sign の契約と紐づけ: 契約番号・車台番号・成約日(=契約日)を入れ、成約額が空なら契約金額で埋める
    const contractNo = t(p.contractNo);
    const { data: k } = await sb.from("kaimax_contracts").select("*").eq("contract_no", contractNo).maybeSingle();
    if (!k) return { status: "error", message: "契約が見つかりません" };
    if (k.status !== "契約済") return { status: "error", message: `この契約は「${k.status}」です` };
    const { data: other } = await sb.from("kaimax_cases").select("case_no").eq("contract_no", contractNo).is("deleted_at", null).neq("id", c.id).maybeSingle();
    if (other) return { status: "error", message: `この契約は案件NO ${other.case_no} に紐づけ済みです` };
    const upd: Record<string, unknown> = { vin: k.vin, contract_no: k.contract_no, deal_on: k.contract_on };
    const filled = !c.deal_yen && k.amount;
    if (filled) { upd.deal_yen = k.amount; upd.deal_raw = `${Number(k.amount).toLocaleString("ja-JP")}円`; }
    const { error } = await sb.from("kaimax_cases").update(upd).eq("id", c.id);
    if (error) return { status: "error", message: error.message };
    await audit(actor, "link_contract", no, { contractNo, vin: k.vin, prevContract: c.contract_no ?? null, prevDeal: c.deal_raw ?? null, filledDeal: !!filled });
    return { status: "success", message: `案件NO ${no} を契約 ${contractNo} と紐づけました`, no };
  }
  if (action === "unlink_contract") {
    await sb.from("kaimax_cases").update({ vin: null, contract_no: null, insmart_car_id: null, deal_on: null }).eq("id", c.id);
    await audit(actor, "unlink_contract", no, { contractNo: c.contract_no, vin: c.vin });
    return { status: "success", message: `案件NO ${no} の紐づけを外しました`, no };
  }
  if (action === "set_outcome") {
    // 成約車の成果管理: 出口・原価・AA出品(最大5回)・売却。金額は円の整数、空は null
    const ROUTES = ["未定", "廃車", "商品", "AA", "商品→AA", "商品→成約"];
    const route = t(p.route) || "未定";
    if (!ROUTES.includes(route)) return { status: "error", message: "出口が不正です" };
    const amt = (v: unknown): number | null | "bad" => { const r = t(v).replace(/[,，円¥\s]/g, ""); if (r === "") return null; if (!/^\d+$/.test(r)) return "bad"; const n = Number(r); return n < 100_000_000 ? n : "bad"; };
    const day = (v: unknown): string | null | "bad" => { const r = t(v); if (!r) return null; return /^\d{4}-\d{2}-\d{2}$/.test(r) && !isNaN(Date.parse(r)) ? r : "bad"; };
    const txt = (v: unknown, max: number) => { const r = t(v); return r ? r.slice(0, max) : null; };
    const cost = amt(p.cost), soldYen = amt(p.soldYen), soldOn = day(p.soldOn), estAa = amt(p.estAaYen);
    if (cost === "bad" || soldYen === "bad" || soldOn === "bad" || estAa === "bad") return { status: "error", message: "原価・売却額・売却日・AA暫定価格の形式が不正です" };
    const src = Array.isArray(p.auctions) ? p.auctions : [];
    if (src.length > 5) return { status: "error", message: "AA出品は5回までです" };
    const auctions = [];
    for (const a0 of src) {
      const a = (a0 || {}) as Record<string, unknown>;
      const row = { date: day(a.date), venue: txt(a.venue, 40), listingFee: amt(a.listingFee), successFee: amt(a.successFee), transportFee: amt(a.transportFee), result: t(a.result) || null, price: amt(a.price) };
      if ([row.date, row.listingFee, row.successFee, row.transportFee, row.price].includes("bad")) return { status: "error", message: "AA出品の日付・金額の形式が不正です" };
      if (row.result && !["流札", "成約"].includes(row.result)) return { status: "error", message: "AAの結果が不正です" };
      if (row.date || row.venue || row.listingFee != null || row.successFee != null || row.transportFee != null || row.result || row.price != null) auctions.push(row);
    }
    const rec = { case_id: c.id, route, cost_yen: cost, est_aa_yen: estAa, cost_memo: txt(p.costMemo, 300), auctions, sold_on: soldOn, sold_yen: soldYen, sold_to: txt(p.soldTo, 100), memo: txt(p.memo, 1000), updated_by: actor, updated_at: new Date().toISOString() };
    const { data: prev } = await sb.from("kaimax_outcomes").select("*").eq("case_id", c.id).maybeSingle();
    const { error } = await sb.from("kaimax_outcomes").upsert(rec, { onConflict: "case_id" });
    if (error) return { status: "error", message: error.message };
    await audit(actor, "set_outcome", no, { prev: prev ?? null, next: rec });
    return { status: "success", message: `案件NO ${no} の成果を保存しました`, no };
  }
  if (action === "delete") {
    await sb.from("kaimax_cases").update({ deleted_at: new Date().toISOString() }).eq("id", c.id);
    await audit(actor, "delete", no, p);
    return { status: "success", message: `案件NO ${no} を削除しました` };
  }
  if (action === "update") {
    const f = detailFields(p);
    const { error } = await sb.from("kaimax_cases").update(f).eq("id", c.id);
    if (error) return { status: "error", message: error.message };
    await applyCalls(c.id, (f.received_on as string) ?? c.received_on, p, actor);
    await audit(actor, "update", no, p);
    return { status: "success", message: `案件NO ${no} を更新しました`, no };
  }
  if (action === "update_calls") {
    await applyCalls(c.id, c.received_on, p, actor);
    const f = detailFields({ ...("followup" in p ? { followup: p.followup } : {}), ...("result" in p ? { result: p.result } : {}) });
    if (Object.keys(f).length) await sb.from("kaimax_cases").update(f).eq("id", c.id);
    else await sb.from("kaimax_cases").update({ updated_at: new Date().toISOString() }).eq("id", c.id);
    await audit(actor, "update_calls", no, p);
    return { status: "success", message: `案件NO ${no} のコール結果を更新しました`, no };
  }
  if (action === "update_memo") {
    await sb.from("kaimax_cases").update({ call_memo: nz(p.memo) }).eq("id", c.id);
    await audit(actor, "update_memo", no, null);
    return { status: "success", message: `案件NO ${no} の通話メモを保存しました`, no };
  }
  if (action === "update_meta") {
    const pick: Record<string, unknown> = {};
    for (const k of ["result", "assignee", "followup"]) if (k in p) pick[k] = p[k];
    const f = detailFields(pick);
    if (Object.keys(f).length) await sb.from("kaimax_cases").update(f).eq("id", c.id);
    await audit(actor, "update_meta", no, pick);
    return { status: "success", message: `案件NO ${no} を更新しました`, no };
  }
  return { status: "error", message: "不明なアクション: " + action };
}


// ---------- 自社サイト買取ページ（indio.co.jp/satei/）の掲載内容 ----------
// 画像は公開バケット kaitori-public に置く。画面側で縮小・EXIF除去（Canvasで描き直し）済みの WebP/JPEG/PNG を base64 で受け取る
const SITE_BUCKET = "kaitori-public";
const RESERVED_SLUGS = new Set(["news", "form", "thanks", "page", "feed", "jisseki"]);
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const BODY_TYPES = new Set(["kei", "compact", "minivan", "suv", "sedan", "wagon", "sports", "truck", "import", "other"]);
const NEWS_KINDS = new Set(["相場情報", "強化買取", "お知らせ", "コラム"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function siteDay(v: unknown): string | null { const r = t(v); return /^\d{4}-\d{2}-\d{2}$/.test(r) && !isNaN(Date.parse(r)) ? r : null; }
function siteTxt(v: unknown, max: number): string | null { const r = t(v); return r ? r.slice(0, max) : null; }
function siteBool(v: unknown, def: boolean): boolean { return v === true ? true : v === false ? false : def; }
function siteInt(v: unknown): number | null { const r = t(v); return /^-?\d+$/.test(r) ? Number(r) : null; }
async function siteUpload(b64: unknown, mime: unknown, base: string): Promise<{ path?: string; error?: string }> {
  const m = t(mime);
  const ext = m === "image/webp" ? "webp" : m === "image/jpeg" ? "jpg" : m === "image/png" ? "png" : "";
  if (!ext) return { error: "画像の形式が不正です（WebP/JPEG/PNG）" };
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(t(b64).replace(/^data:[^,]+,/, "")), (c) => c.charCodeAt(0)); } catch { return { error: "画像データが読めません" }; }
  if (bytes.length < 1000 || bytes.length > 5 * 1024 * 1024) return { error: "画像の大きさが不正です（5MBまで）" };
  const path = `${base}.${ext}`;
  const { error } = await sb.storage.from(SITE_BUCKET).upload(path, bytes, { contentType: m, upsert: true, cacheControl: "604800" });
  return error ? { error: "画像を保存できませんでした: " + error.message } : { path };
}
const stamp = () => new Date(Date.now() + 9 * 3600000).toISOString().replace(/[-:T]/g, "").slice(0, 14);

async function siteAction(action: string, p: Record<string, unknown>, actor: string) {
  const now = new Date().toISOString();
  if (action === "voice_save") {
    // お客様の声。顧客名はイニシャル＋様のみ、金額は「◯万円台」などの目安のみ（正確な金額・フルネームは保存しない）
    const id = siteInt(p.id);
    const dealOn = siteDay(p.dealOn), maker = siteTxt(p.maker, 30), car = siteTxt(p.car, 40);
    if (!dealOn || !maker || !car) return { status: "error", message: "お引き渡し日・メーカー・車名は必須です" };
    const label = t(p.customerLabel).normalize("NFKC").replace(/\s/g, "");
    if (label && !/^[A-Za-z](\.?[A-Za-z])?\.?様$/.test(label)) return { status: "error", message: "お客様の表記はイニシャル＋様にしてください（例：T様）" };
    const price = t(p.priceLabel).normalize("NFKC").replace(/\s/g, "");
    if (price && (/\d{1,3},\d{3}/.test(price) || /\d{5,}/.test(price) || !/万円/.test(price))) return { status: "error", message: "金額は「45万円台」のような目安にしてください（正確な金額は載せない）" };
    const year = siteInt(p.modelYear);
    if (year != null && (year < 1950 || year > 2100)) return { status: "error", message: "年式が不正です" };
    let caseId: number | null = null;
    const caseNo = siteInt(p.caseNo);
    if (caseNo) { const c = await byNo(caseNo); if (!c) return { status: "error", message: `案件NO ${caseNo} が見つかりません` }; caseId = c.id; }
    const rec: Record<string, unknown> = { deal_on: dealOn, maker, car, grade: siteTxt(p.grade, 60),
      model_year: year, city: siteTxt(p.city, 20), customer_label: label || null, price_label: price || null,
      consent: siteBool(p.consent, false), visible: siteBool(p.visible, true), updated_by: actor, updated_at: now };
    // 案件・契約番号は、指定があるとき（と新規のとき）だけ入れる。編集で空のまま保存しても消さない
    if (caseId || !id) rec.case_id = caseId;
    if (t(p.contractNo) || !id) rec.contract_no = siteTxt(p.contractNo, 30);
    if (p.photoB64) {
      const up = await siteUpload(p.photoB64, p.photoMime, `voices/${dealOn.slice(0, 7)}/${crypto.randomUUID()}`);
      if (up.error) return { status: "error", message: up.error };
      rec.photo_path = up.path;
    } else if (!id) return { status: "error", message: "写真を選んでください" };
    if (id) {
      const { data: prev } = await sb.from("kaitori_voices").select("*").eq("id", id).is("deleted_at", null).maybeSingle();
      if (!prev) return { status: "error", message: "お客様の声が見つかりません" };
      const { error } = await sb.from("kaitori_voices").update(rec).eq("id", id);
      if (error) return { status: "error", message: error.message };
      await audit(actor, "voice_save", caseNo, { id, prev, next: rec });
      return { status: "success", message: "お客様の声を更新しました", id };
    }
    const { data, error } = await sb.from("kaitori_voices").insert({ ...rec, created_by: actor }).select("id").single();
    if (error) return { status: "error", message: error.message };
    await audit(actor, "voice_save", caseNo, { id: data.id, next: rec });
    return { status: "success", message: rec.consent ? "お客様の声を登録しました（最大10分でサイトに出ます）" : "登録しました（掲載同意が無いのでサイトには出ません）", id: data.id };
  }
  if (action === "voice_flags") {
    // 表示のオン/オフ・掲載同意・削除（論理削除）
    const id = siteInt(p.id); if (!id) return { status: "error", message: "IDが不正です" };
    const upd: Record<string, unknown> = { updated_by: actor, updated_at: now };
    if ("visible" in p) upd.visible = siteBool(p.visible, true);
    if ("consent" in p) upd.consent = siteBool(p.consent, false);
    if (p.delete === true) upd.deleted_at = now;
    const { error } = await sb.from("kaitori_voices").update(upd).eq("id", id).is("deleted_at", null);
    if (error) return { status: "error", message: error.message };
    await audit(actor, "voice_flags", null, { id, ...upd });
    return { status: "success", message: p.delete === true ? "削除しました" : "保存しました" };
  }
  if (action === "model_save" || action === "model_flags") {
    const id = t(p.id);
    if (id && !UUID_RE.test(id)) return { status: "error", message: "IDが不正です" };
    const upd: Record<string, unknown> = { updated_by: actor, updated_at: now };
    if ("visible" in p) upd.visible = siteBool(p.visible, false);
    if ("isFeatured" in p) upd.is_featured = siteBool(p.isFeatured, false);
    if (action === "model_save") {
      if ("headline" in p) upd.headline = siteTxt(p.headline, 120);
      if ("intro" in p) upd.intro = siteTxt(p.intro, 20000);
      if ("sort" in p) upd.sort = siteInt(p.sort) ?? 100;
      if ("seoTitle" in p) upd.seo_title = siteTxt(p.seoTitle, 120);
      if ("seoDesc" in p) upd.seo_desc = siteTxt(p.seoDesc, 300);
      if ("matchKeys" in p) upd.match_keys = [...new Set(t(p.matchKeys).split(/[,、\n]/).map((x) => x.trim()).filter(Boolean))].slice(0, 30);
    }
    let slug = "";
    if (!id) {
      if (action !== "model_save") return { status: "error", message: "IDが不正です" };
      slug = t(p.slug);
      if (!SLUG_RE.test(slug) || RESERVED_SLUGS.has(slug)) return { status: "error", message: "URL（slug）は英小文字・数字・ハイフンで。news / form / jisseki などは使えません" };
      const maker = siteTxt(p.maker, 30), name = siteTxt(p.name, 40), bt = t(p.bodyType) || "other";
      if (!maker || !name) return { status: "error", message: "メーカーと車名は必須です" };
      if (!BODY_TYPES.has(bt)) return { status: "error", message: "ボディタイプが不正です" };
      Object.assign(upd, { slug, maker, name, body_type: bt });
    } else {
      const { data: m } = await sb.from("kaitori_models").select("slug").eq("id", id).maybeSingle();
      if (!m) return { status: "error", message: "車種が見つかりません" };
      slug = m.slug;
    }
    if (action === "model_save" && p.imageB64) {
      const up = await siteUpload(p.imageB64, p.imageMime, `models/${slug}-${stamp()}`);
      if (up.error) return { status: "error", message: up.error };
      upd.image_path = up.path;
    }
    const q = id ? sb.from("kaitori_models").update(upd).eq("id", id).select("id").single() : sb.from("kaitori_models").insert(upd).select("id").single();
    const { data, error } = await q;
    if (error) return { status: "error", message: /duplicate|unique/i.test(error.message) ? "そのURL（slug）はもう使われています" : error.message };
    await audit(actor, action, null, { id: data.id, ...upd, intro: upd.intro ? `(${String(upd.intro).length}字)` : undefined });
    return { status: "success", message: "車種を保存しました（最大10分でサイトに反映）", id: data.id };
  }
  if (action === "news_save") {
    const id = t(p.id);
    if (id && !UUID_RE.test(id)) return { status: "error", message: "IDが不正です" };
    const kind = t(p.kind), title = siteTxt(p.title, 120), slug = t(p.slug), pub = siteDay(p.publishedOn);
    if (!NEWS_KINDS.has(kind)) return { status: "error", message: "種類が不正です" };
    if (!title) return { status: "error", message: "見出しは必須です" };
    if (!SLUG_RE.test(slug)) return { status: "error", message: "URL（slug）は英小文字・数字・ハイフンで入力してください" };
    if (!pub) return { status: "error", message: "公開日が不正です" };
    const ids = (Array.isArray(p.modelIds) ? p.modelIds : []).map((x) => t(x)).filter((x) => UUID_RE.test(x)).slice(0, 30);
    const upd: Record<string, unknown> = { kind, title, slug, lead: siteTxt(p.lead, 200), body: siteTxt(p.body, 50000), model_ids: ids, published_on: pub,
      visible: siteBool(p.visible, false), updated_by: actor, updated_at: now };
    if (p.imageB64) {
      const up = await siteUpload(p.imageB64, p.imageMime, `news/${slug}-${stamp()}`);
      if (up.error) return { status: "error", message: up.error };
      upd.image_path = up.path;
    } else if (p.removeImage === true) upd.image_path = null;
    const q = id ? sb.from("kaitori_news").update(upd).eq("id", id).select("id").single() : sb.from("kaitori_news").insert(upd).select("id").single();
    const { data, error } = await q;
    if (error) return { status: "error", message: /duplicate|unique/i.test(error.message) ? "そのURL（slug）はもう使われています" : error.message };
    await audit(actor, "news_save", null, { id: data.id, kind, title, slug, published_on: pub, visible: upd.visible });
    return { status: "success", message: "ニュースを保存しました", id: data.id };
  }
  if (action === "faq_save") {
    const id = t(p.id);
    if (id && !UUID_RE.test(id)) return { status: "error", message: "IDが不正です" };
    const scope = t(p.scope) || "all", q = siteTxt(p.q, 300), a = siteTxt(p.a, 5000);
    if (scope !== "all" && !SLUG_RE.test(scope)) return { status: "error", message: "表示する場所が不正です" };
    if (!q || !a) return { status: "error", message: "質問と回答は必須です" };
    const upd = { scope, q, a, sort: siteInt(p.sort) ?? 100, visible: siteBool(p.visible, true), updated_at: now };
    const r = id ? await sb.from("kaitori_faqs").update(upd).eq("id", id).select("id").single() : await sb.from("kaitori_faqs").insert(upd).select("id").single();
    if (r.error) return { status: "error", message: r.error.message };
    await audit(actor, "faq_save", null, { id: r.data.id, ...upd, a: `(${a.length}字)` });
    return { status: "success", message: "よくある質問を保存しました", id: r.data.id };
  }
  if (action === "carmaster_save") {
    const id = siteInt(p.id);
    const upd: Record<string, unknown> = {};
    if ("sort" in p) upd.sort = siteInt(p.sort) ?? 100;
    if ("makerSort" in p) upd.maker_sort = siteInt(p.makerSort) ?? 100;
    if ("visible" in p) upd.visible = siteBool(p.visible, true);
    if (!id) {
      const maker = siteTxt(p.maker, 30), name = siteTxt(p.name, 40);
      if (!maker || !name) return { status: "error", message: "メーカーと車名は必須です" };
      Object.assign(upd, { maker, name });
    } else if ("name" in p) { const name = siteTxt(p.name, 40); if (!name) return { status: "error", message: "車名は必須です" }; upd.name = name; }
    const r = id ? await sb.from("kaitori_car_master").update(upd).eq("id", id).select("id").single() : await sb.from("kaitori_car_master").insert(upd).select("id").single();
    if (r.error) return { status: "error", message: /duplicate|unique/i.test(r.error.message) ? "同じメーカー・車名がもうあります" : r.error.message };
    await audit(actor, "carmaster_save", null, { id: r.data.id, ...upd });
    return { status: "success", message: "車種マスタを保存しました", id: r.data.id };
  }
  return { status: "error", message: "不明なアクション: " + action };
}

// ---------- お客様（reply.html）用：認証なし。受け付けるのは決まった状況だけ ----------
const REPLY_STATUSES = new Set(["査定を行いたい", "まだ検討中", "すでに売却した", "売却をやめた", "検討中", "他社商談中", "売却済み", "売却中止"]);
async function customerReply(p: Record<string, unknown>) {
  const status = t(p.status);
  if (!REPLY_STATUSES.has(status)) return { status: "error", message: "状況が不正です" };
  const no = parseInt(t(p.id));
  const c = Number.isFinite(no) ? await byNo(no) : null;
  const jst = new Date(Date.now() + 9 * 3600000).toISOString();
  const raw = `${jst.slice(0, 4)}/${jst.slice(5, 7)}/${jst.slice(8, 10)} ${jst.slice(11, 16)}`;
  const cut = (v: unknown, n: number) => { const s = t(v); return s ? s.slice(0, n) : null; };
  const { error } = await sb.from("kaimax_replies").insert({
    received_at: new Date().toISOString(), received_raw: raw, case_no: Number.isFinite(no) ? no : null,
    customer_name: c?.customer_name ?? null, car_name: c?.car_name ?? cut(p.car, 100), status,
    method: cut(p.method, 50), wish_date: cut(p.date, 300), time_slot: cut(p.time, 100), contact: cut(p.contact, 50),
    email: cut(p.email, 200), memo: cut(p.memo, 2000), tel: c?.tel ?? null, ua: cut(p.ua, 300), source: "reply_form",
  });
  if (error) return { status: "error", message: "保存に失敗しました" };
  if (c) await sb.from("kaimax_cases").update({ reply_status: `${status}（${+raw.slice(5, 7)}/${+raw.slice(8, 10)}）` }).eq("id", c.id);
  await audit("customer", "reply", Number.isFinite(no) ? no : null, { status });
  return { status: "success", message: "ご回答ありがとうございました" };
}

async function staffActor(req: Request): Promise<string | null> {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data.user) return null;
  const { data: m } = await sb.from("team_members").select("email, role, division, divisions, active").eq("id", data.user.id).maybeSingle();
  if (m && m.active && (m.role === "admin" || m.division === "vehicle_sales" || (m.divisions || []).includes("vehicle_sales"))) {
    return m.email || data.user.email || data.user.id;
  }
  // kaimax 専用の許可リスト（HUBの team_members に居ない人・共用アカウント）
  const email = (data.user.email || "").toLowerCase();
  if (!email || !data.user.email_confirmed_at) return null;
  const { data: a } = await sb.from("kaimax_allowed_emails").select("email").eq("email", email).eq("active", true).maybeSingle();
  return a ? email : null;
}
async function isWorker(key: string) {
  if (!key) return false;
  const { data } = await sb.from("kaimax_worker_keys").select("id").eq("key_sha256", await sha256(key)).eq("active", true).maybeSingle();
  return !!data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = new URL(req.url);
    const pathKey = (url.pathname.match(/\/w\/([^/?#]+)/) || [])[1] || "";
    if (req.method === "GET") {
      if (url.searchParams.get("action") === "list_assess_nos") {
        if (!(await isWorker(decodeURIComponent(pathKey)))) return json({ status: "error", message: "認証エラー" });
        const r = await listAssessNos();
        // 生存確認用の記録（毎時の収集が動いているかを後から確認できるように）
        await audit("worker", "list_assess_nos", null, { count: (r as { items?: unknown[] }).items?.length ?? null });
        return json(r);
      }
      return json({ status: "ok", message: "kaimax-api (Supabase)", timestamp: new Date().toISOString() });
    }
    let body: { secret?: string; action?: string; payload?: Record<string, unknown> } = {};
    try { body = JSON.parse(await req.text()); } catch { return json({ status: "error", message: "JSONが不正です" }); }
    const action = t(body.action), p = body.payload || {};
    if (WORKER_ACTIONS.has(action)) {
      if (!(await isWorker(decodeURIComponent(pathKey) || t(body.secret)))) {
        // import_contracts はスタッフ（画面からの取込）も使うので、ワーカー鍵が無ければスタッフ認証へ回す
        if (!STAFF_ACTIONS.has(action)) return json({ status: "error", message: "認証エラー" });
      } else {
        if (action === "mota_create") return json(await motaCreate(p));
        if (action === "mota_result") return json(await motaResult(p));
        if (action === "mota_won") return json(await motaWon(p));
        if (action === "import_contracts") return json(await staffAction("import_contracts", p, "worker")); // 夜間の自動取込（smart-sign）
        return json(await motaRefill(p));
      }
    }
    if (action === "reply") return json(await customerReply(p));
    if (STAFF_ACTIONS.has(action)) {
      const actor = await staffActor(req);
      if (!actor) return json({ status: "error", message: "認証エラー（ログインし直してください）" });
      return json(await staffAction(action, p, actor));
    }
    return json({ status: "error", message: "不明なアクション: " + action });
  } catch (e) {
    return json({ status: "error", message: String((e as Error).message || e) });
  }
});

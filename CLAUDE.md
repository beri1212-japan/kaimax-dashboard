# kaimax — 買取案件管理ダッシュボード

株式会社インディオ富山の中古車買取案件を管理するツール。
公開先: https://beri1212-japan.github.io/kaimax-dashboard/

---

## ⚠ 最初に読むこと

### 1. テスト環境が無い。書き込みは即本番

`WEBHOOK_URL` は本番のひとつだけで、環境の切り替え機構が無い。
`postWebhook()` を通る操作（新規作成・更新・削除・コール結果・メモ・担当者）は
**すべて即座に本番の432件シートへ書き込まれる。**

見た目の確認は `node verify.js` でスタブして行う（本番に一切通信しない）。
書き込み系を触る作業に入る前に、テスト用スプレッドシートを作ること。

### 2. 公開CSVに顧客の個人情報が含まれている（未解決）

スプレッドシートを「ウェブに公開」しているため、CSV URL を知っていれば
**誰でも432件分の顧客名・TEL・住所・メールを取得できる。**
その URL は `index.html` に平文で書かれており、`index.html` は GitHub Pages で公開されている。
リポジトリも Public。

`SECRET_KEY = 'indio9700'` も同様に `index.html` に載っているため、
**鍵を読めば誰でも `delete` を含む書き込みができる。** 鍵の変更では直らない（新しい鍵も公開される）。

→ 認証改修で解決する。「認証設計」の節を参照。

### 3. リポジトリと稼働中GASがドリフトしている

**稼働中のApps Scriptが正で、リポジトリの `.gs` は古い写し。**
稼働中にしか無いもの:

- 関数: `handleMotaRefill` / `handleMotaCreateAndWon` / `fixTelColumn`
- アクション: `mota_refill`
- `onOpen` のメニュー: 電話番号の頭0補完 / 未割当を自動割り振り / 担当配分の状況を表示

稼働中プロジェクトはファイル2つ構成（`コード.gs` 919行 = リポジトリの3ファイル統合、`assign-engine.gs` 172行）。
**リポジトリの `.gs` を読んで判断しないこと。** 書き戻しが完了するまでは稼働エディタを見る。

---

## 構成

| ファイル | 役割 |
|---|---|
| `index.html` | アプリ本体。**1ファイル完結**（inline CSS + 2つの `<script>`）。約5,700行 / 287KB |
| `sw.js` | PWA用サービスワーカー。**fetchイベントは実装しない**（後述の事故参照） |
| `manifest.webmanifest` | PWAマニフェスト |
| `reply.html` | 顧客回答フォーム。**認証なし・連番IDで列挙可能（脆弱性）** |
| `status.html` | 放置監視ページ。公開CSVを読む |
| `verify.js` | Playwright でスクリーンショットを撮る検証スクリプト |
| `sample-master.csv` | 検証用の合成データ60行。**実データは1セルも含まない** |
| `kaimax-GAS.gs` | Apps Script 本体の**古い写し**（稼働中とは差分あり） |
| `assign-engine.gs` | 担当者の自動割り振り（写し） |
| `gas-reply-endpoint.gs` | 顧客回答の受け口（写し） |
| `gas-8calls-patch.gs` | コール⑥⑦⑧の追加パッチ（写し・貼り付け手順書の体裁） |

`index.html` は分割しない。1ファイルであることが前提の運用。

**存在しないもの**（過去のメモに記載があったが実在しない）:
`sms-endpoint.gs` / `SMS実装メモ.md` / `.gitignore` / `shots/`
SMS は「index.html で文面とURLをコピーして手動送信」の運用のみ。

---

## システム全体

```
[MOTA (autoc-one.jp)]
        │ Playwright でスクレイピング（ログイン必須）
        ▼
[ワーカー] 事務所の Windows PC 常駐・毎時
        │ POST { secret, action, payload }
        ▼
[GAS Web App /exec] ──► [スプレッドシート 買取案件管理表]
        ▲                        │ ウェブに公開
        │ postWebhook()          ▼
[index.html / status.html] ◄── 公開CSV
        GitHub Pages
```

- スプレッドシート: `買取案件管理表` / シート名 `マスタ案件` / 432行
  https://docs.google.com/spreadsheets/d/1V1xWTjdin_zbEjyjOJh-3TymkOreFzaN18_iCZnCinI/edit
- **所有者: `kawaberi@gmail.com`（個人Gmail）** ← Workspace `indio.co.jp` ではない
- GAS Web App: `https://script.google.com/macros/s/AKfycbyfvacDa_So-347Il4KpSPEDjQjWwdD5wuEw6Un8v9MAyxJX_i0XQUW_onu_Fs1oEQU/exec`
  - `index.html:2734` = `WEBHOOK_URL` / `reply.html:288` = `ENDPOINT`（**変更時は両方直す**）
  - デプロイは**既存を上書き**（デプロイを管理 → 編集 → 新バージョン）。新規作成するとURLが変わる

### 公開CSV（4本・同一の公開キー）

| 定数 | 場所 | gid | 用途 |
|---|---|---|---|
| `CSV_URL` | index.html:2733 | （先頭シート） | マスタ案件 |
| `SHEET_TARGETS_CSV` | index.html:3084 | 1140486118 | 月別目標 |
| `REPLY_CSV_URL` | index.html:4232 | 1266986413 | 顧客回答 |
| `CSV_URL` | status.html:110 | （先頭シート） | 放置監視 |

新しいシートを追加しても公開設定は自動では付かない。個別に「ファイル → 共有 → ウェブに公開」が必要。

---

## ワーカー（MOTA自動収集）

**事務所の Windows PC に常駐。止まると新規案件が入らなくなる = 業務停止。**

| 項目 | 内容 |
|---|---|
| 実行環境 | Windows PC 常駐 / Node.js + Playwright (chromium) |
| 起動 | Windows タスクスケジューラから `run.bat` を**毎時** |
| 処理順 | ① `mota-collect.mjs`（受付中→登録）→ ② `mota-result.mjs`（受付終了→G/H反映） |
| 別運用 | `mota-won.mjs`（落札時の顧客情報取得）は `run.bat` に未組込。手動 |
| 秘密情報 | `mota-collector/.env.local` に**平文**。`MOTA_ID` / `MOTA_PW` / `KAIMAX_WEBHOOK_URL` / `KAIMAX_SECRET_KEY` |
| リトライ | GAS POST は3回・2秒間隔。失敗時 Chatwork 通知（`.env.local` に設定がある場合のみ） |
| 間隔 | 案件間 sleep（collect 4秒 / result 1.2秒） |

MOTA 側:
- ログイン必須。`input[name=mail4Shop]` / `input[name=password4Shop]` → `#shopLoginButton`
- `BASE=https://autoc-one.jp/ullo/shop/mypage/assessment`
  受付中 `/carList/accepting/?limit=100` / 受付終了 `/carList/closed/?limit=100` / 明細 `/car/{査定番号}/`
- 一覧は `#carBidList > li`、リンク `.p-carlist-list__link`、状態 `.p-carlist-list__status` に依存

**重要な性質:**
- **Sheets API を直接使っていない。** 書き込みは全て GAS Webhook 経由
- **通常収集は公開CSVを読まない**（登録済み判定は `list_assess_nos` の GAS GET を使用）。
  公開CSVを読むのは `--repair` モードのみ → **公開CSVを止めても毎時の収集は影響を受けない**
- `KAIMAX_SECRET_KEY` は**ファイルから読んでいる**（ハードコードではない）。
  → **認証改修時の変更は `.env.local` の1行だけ。コード変更・再デプロイ不要**

### 規約とAPIの確認結果（2026/08/17・本人確認済み）

- **MOTA は加盟店向けのAPI／データ連携を提供していない。** スクレイピング以外の取得手段が無い
- **加盟店規約に自動取得の禁止条項は無い。**

→ **ワーカーは恒久的な基幹設備として扱う。** 廃止・代替の選択肢は無い。

ただし「規約に記載が無い」は「許可されている」ではない。一般条項（過度な負荷・不正アクセス等）に
触れないよう、**現在の控えめな設定を維持すること**:

- 実行は**毎時まで**。頻度を上げない
- 案件間の sleep（collect 4秒 / result 1.2秒）を短縮しない
- 一覧の取得は `?limit=100` の範囲に留める

### 3年運用のための注意点

- **サイレント障害が最大の実務リスク。** MOTA がページ構造を変えると、依存しているセレクタ
  （`#carBidList > li` / `.p-carlist-list__link` / `.p-carlist-list__status`）が外れて取得が止まる。
  **止まったことに誰も気づかない状態を作らないこと。**
  Chatwork 通知は `.env.local` に設定がある場合のみ動くため、設定の有無を必ず確認する
- **単一障害点**: 事務所の Windows PC 1台。故障・Windows Update の再起動・ネットワーク断で停止する。
  再構築手順を文書化しておくこと（Node + `npm i` + `npx playwright install chromium` + `.env.local` 配置）
- ワーカーのソースをバージョン管理下に置く（**`.env.local` は必ず `.gitignore` で除外**）

---

## データの流れ

```
読み: 公開CSV (CSV_URL) → parseCSV() → rowsToCases() → allCases
書き: postWebhook(action, payload) → GAS /exec → スプレッドシート
```

### 列構成（実シート準拠・全35列 A〜AI）

```
A=案件NO      B=媒体        C=受信日      D=顧客名      E=TEL番号
F=車名        G=入札        H=入札結果    I=(無名・自由記述メモ)
J=①TEL結果   K=②TEL結果   L=②日付
M=③TEL結果   N=③日付      O=④TEL結果   P=④日付
Q=⑤TEL結果   R=⑤日付
S=査定        T=結果        U=次回後追日  V=担当者      W=備考
X=顧客希望額  Y=査定提示額  Z=成約額
AA=住所       AB=メール     AC=年式       AD=走行距離
AE=(無名・走行距離レンジ)    AF=通話メモ   AG=回答
AH=⑥結果     AI=⑥日付
```

- **⑦⑧の列はまだ存在しない。** 値が入った時点で `ensureHeaderCol_` が右端に自動生成する
- ⑥⑦⑧のヘッダーは `⑥結果` / `⑥日付`。①〜⑤の `①TEL結果` とは命名規則が違う（不整合だが実態）
- **AE は見出しの無い列**で、走行距離のレンジ（`～2万キロ` 等）が入る。AD とは別の値
- 異物が混在: AE に `40000000000` `50.000km` `63000km`、長文コメント1件

### AA〜AE の1列ズレについて

**過去データ158行がヘッダーより1列右にズレている。**

```
ヘッダー通り : AA=住所  AB=メール  AC=年式  AD=走行距離  AE=(空)
ズレた行     : AA=(空)  AB=住所    AC=メール AD=年式     AE=走行距離
```

`rowsToCases()` がメール形式・「年式」「キロ/km」の有無をスコアリングして判定している。
**ここを単純化しないこと。**

**原因は特定済み。過去のGASバージョンによるもので、既に修正されている。**

- 稼働中GASの書き込み3経路（`handleMotaCreate` / `handleMotaWon` / `handleMotaCreateAndWon`）は
  すべてヘッダー通りの位置に書く。無罪
- ワーカーは Sheets API を使っていない。無罪
- 受信日の書式と完全に相関する: ゼロ埋め（`2026/05`）の行にズレが集中し、
  現行GASの `yyyy/M/d`（`2026/8/17`・ゼロ埋めなし）の76行は**ズレ0件**
- 発生期間は 2026/05〜07 の3ヶ月に限定。4月以前と8月は0件 = **既に止まっている**
- ズレ158行のうち155行がMOTA

→ **新しいズレは発生しない。残る作業は過去158行の一括補正のみ。**

### 実データの値（432行時点）

**B列 媒体** — `ナビクル` は実データに0件だが、**現在も契約中で再開の可能性あり**（本人確認済み）のため残してある

| 値 | 件数 |
|---|---|
| MOTA | 300 |
| カーセンサー | 95 |
| 店頭 | 27 |
| LINE | 4 |
| Yahoo! | 3 |
| 自社サイト | 1 |
| その他 | 1 |

**①〜⑥結果** — 表記ゆれあり: `アポ`/`アポ確定`、`留守`/`不在`、選択肢に無い `OFF` が3件

**T列 結果** — 「検討」系が**カッコの全角/半角で3種に分裂**している。集計時は正規化必須
`他社売却180 / 成約67 / 着拒47 / 売らない38 / 検討（長期）9 / ★近日返事4 / 媒体重複3 / 検討(１ヶ月以内)1 / 検討(直近)1`

**S列 査定** — `〇`125 のみ。`×` は0件。実質フラグ列
**G列 入札 / H列 入札結果** — `〇`251 と `権利獲得`250 + `×`1 が対応

**V列 担当者** — `前田294 / 石川19 / 高木13 / 川縁6 / 野村5 / 馬塚5 / 諸田4 / 上野3 / 金木2 / 空81`
名簿は `assign-engine.gs:26` と `status.html:111` に8名。**`金木` が両方の名簿に漏れている。**
割り振り比率は前田70% / 残り30%を7名で均等（`AE_TARGET_MAEDA = 0.70`）

**U列 次回後追日** — **自動計算は無い。完全に手入力。**
書式がバラバラ（`6/18` / `2026/08/13` / `7/15~` / `8月以降~`）で、
`一旦乗り続ける` のような日付でない値も3件ある。`parseDateFlexible()` は後2者を解釈できず null を返す

### GAS のアクション（稼働中12種）

`create` / `update` / `delete` / `mota_create` / `mota_won` / `mota_result` /
**`mota_refill`** / `update_calls` / `update_memo` / `update_meta` / `reply` /
`list_assess_nos`（GET）

`mota_refill` は既存行の備考へ不足明細を追記補完する。W列(23)しか触らない。

### status.html の放置判定

`staleHours()` で2段階。**24時間以上**→「滞留24h+」（黄）/ **48時間以上**→「滞留48h+」（赤）

- `lastUpdate(c)` = 受信日と各コール日付のうち最も新しいもの（更新日時ではない）
- 対象は稼働案件かつ `unresolved(c)` = `callStatus` が `apo`/`excluded`/`done` のいずれでもないもの
- **時刻情報を持たないため実質「日単位の粗い判定」**

---

## 触るときの必須知識（過去に事故ったところ）

1. **`buildRow()` は A〜AD を丸ごと書く。部分更新には使わない。**
   一覧やパネルからの更新は必ず `update_calls` / `update_memo` / `update_meta` を使う。
   守らないと査定明細や住所が消える。
   さらに **MOTA のズレた行に `update` を打つとデータが1列左に動き、走行距離が AE に取り残される。**

2. **`handleMotaCreate` のコメントは1つズレている。**
   `W:備考` の次を `Y:顧客希望額` と書いて X を飛ばしているため、以降のラベルが全部ずれている。
   **配列自体は詰まっているので値の着地は正しい**（年式→AC、走行距離→AD）。
   ここに項目を追加するときはコメントを信じないこと。`buildRow()` 本体のコメントは正確。

3. **X〜Z列には「1,800,000円」やMOTAの査定明細テキストが生で入っている行がある。**
   数値化した値を書き戻すと明細が消える。`desiredRaw`/`offeredRaw`/`dealRaw` に生文字列を
   保持して、編集・保存はそちらを使う。

4. **`sw.js` に fetch ハンドラを書かない。**
   `e.respondWith(fetch(e.request))` を入れていた時期、公開CSVの取得が無応答のまま止まり、
   画面が「読み込み中...」のままサンプルデータ (`fallbackCases`) を表示し続ける事故が起きた
   （2026/08/14 に混入、2026/08/17 に `e9011fa` で修正）。
   ブラウザ標準の通信に任せる。PWAのインストールは fetch ハンドラ無しでも可能
   （Chrome mobile 108 / desktop 112 以降）。ただし自動のインストール案内バナーは出なくなる。

5. **CSV取得には必ずタイムアウトを付ける。** `fetchWithTimeout(url, 8000)` を使う。
   失敗時は赤帯＋「再読み込み」ボタンを出し、右上を「読み込み失敗」に変える。
   サンプルデータを本物の数字と誤認させないこと。

---

## セキュリティ上の既知の問題

| # | 内容 | 状態 |
|---|---|---|
| 1 | 公開CSVに432件分の顧客名・TEL・住所・メール。URLは公開HTMLに平文 | **未解決** |
| 2 | `SECRET_KEY='indio9700'` が公開HTMLに載っており、誰でも `delete` を叩ける | **未解決** |
| 3 | `reply.html` が案件NO（1からの連番）をURLに載せている。`?id=1,2,3...` で**他人の回答フォームを開き、なりすまして送信できる** | **未解決** |
| 4 | `doGet` に認証が無い。`?action=list_assess_nos` で誰でも査定番号一覧を取得できる | **未解決** |
| 5 | ワーカーの `.env.local` に MOTA のID/パスワードが平文。`.gitignore` 未作成 | **未解決** |
| 6 | 基幹データの所有者が個人Gmail。3年運用の継続性リスク | **未解決** |
| 7 | 2026/08/17 に検証用CSVへ実メール19件を含めて約1時間 public 公開（`f5ed52b`）。force-push で除去済み | 除去済 / GitHub Support への purge 依頼が未実施 |

**2は1と原因が同じ**（静的な公開ページに秘密は置けない）。認証改修で同時に解決する。
**3と4は認証と独立して直せる。**

### 認証設計（方針）

PWA が必須（スマホでコール活動を行う）ため、GAS の HTML Service 配信は採らない。
**GitHub Pages を維持し、Google Identity Services でログイン → GAS 側でトークン検証。**

```
GAS の判定
  idToken あり           → 検証して人間の経路（create/update/delete/update_*）
  secret === WORKER_KEY  → ワーカー経路（mota_* と list_assess_nos のみ。delete は不可）
  どちらでもない          → 拒否
```

外せない実装上の注意:

- **Web App のアクセス権限は「全員」のままにする。** 「組織内の全員」にすると
  ブラウザからの `fetch` が Google のセッションCookieを要求されて通らない。認証はアプリ層で行う
- **IDトークンは POST ボディに入れる。** `Authorization` ヘッダーはプリフライトを誘発し、
  GAS は OPTIONS に応答できない。`Content-Type: text/plain` でボディに載せる
- **`hd` の検証は必ずサーバー側で。** クライアント側の `hd` 指定は迂回できる
- **所有者が個人Gmailのため、`hd === 'indio.co.jp'` だけでは所有者が弾かれる。**
  所有権を Workspace へ移すか、許可リストを併用する
- IDトークンは1時間で失効する。PWA再開時に自動サインインで再取得する設計にしないと
  「開くたびログイン画面」になって現場で使われなくなる

**移行順（ワーカーを止めないために厳守）:**

1. GAS に `WORKER_KEY` 経路を**追加**（`SECRET_KEY` は残す）
2. ワーカーの `.env.local` を新しい鍵に差し替え → 動作確認
3. ダッシュボード側の認証を実装・切り替え
4. 公開CSVの公開を解除（`index.html` / `status.html` を GAS 経由の取得に変更済みであること）
5. **最後に** `SECRET_KEY` を削除

順番を誤って先に `SECRET_KEY` を消すとワーカーが即死する。

---

## デザインの決まり

Google Analytics 風。奇抜な色は使わない。

```
面 #f8f9fa / カード #fff / 罫線 #dadce0
文字 #202124 / #3c4043 / #5f6368
アクセント #1a73e8（濃 #1557b0 / 淡 #e8f0fe）
```

- 媒体タグだけは色分け可（淡い背景＋濃い文字、コントラスト4.5:1以上、色覚多様性検証済み）
  MOTA `#f7e9e1`/`#9c4a21` ・ カーセンサー `#e5ebf5`/`#2f5c93` ・ ナビクル `#e9f3eb`/`#2c7a3f`
  LINE `#e2f0ed`/`#0d6b5f` ・ Yahoo! `#fbe9eb`/`#a52a3d`
  自社サイト `#eee7f3`/`#63408a` ・ 店頭 `#faf6eb`/`#8c6a00` ・ その他 `#eaecee`/`#4e555c`
  - CSS変数は `--media-line` / `--media-yahoo`。**`--line` は罫線色 `#dadce0` として103箇所で使われているので絶対に流用しないこと**（2026/08/18 に一度衝突させた）
  - **8媒体は色だけでは識別しきれない。** `dataviz` で検証した結果、この明度帯で
    無彩色の「その他」を含む8色をCVD安全にするのは不可能。**タグは必ず媒体名の文字を伴う**
    ことで識別を担保している。色だけで区別させる表示（凡例なしのグラフ等）を作らないこと
  - 媒体を追加するときの修正箇所は **13箇所**（CSS変数 / `.media-tab[data-media=]` の indicator /
    `.m-tag.*` 2種 / `.media-compare .dot-*` / `bar-fill` 3種 / タブHTML / チップHTML /
    `MEDIA_MAP` / `mediaLabels` / `renderMediaView` の分岐 / `allMedias` / `dotClass`+`fillClass` /
    `updateMediaTabCounts` / `MEDIA_REVERSE` / `OPT_MEDIA`）
- グラフ系列: 案件数 `#c4cbd3`(棒) / アポ `#2a78d6` / 査定 `#1baf7a` / 成約 `#eb6834`
- 色を追加・変更するときは `dataviz` スキルの `validate_palette.js` で必ず検証する
- **表は左詰め・列幅は内容に合わせる**。密度は在庫HUBに合わせて
  見出し11px / 本文12px / セル余白 3px 8px / 行高26px
- アイコンは `<symbol>` スプライト（Lucide風の線画）。絵文字は使わない
- ナビは左サイドバー。下部に「リンク」欄（スプレッドシート / ユーズドカーハイパー / アイオーク / データラインPRO）

---

## 見た目の確認方法

**必ず画像を見てから完了とする。**

```bash
node verify.js            # ダッシュボード
node verify.js report     # 実績集計
node verify.js cases      # 案件一覧
```

- PC 1300px と スマホ 390px を自動で両方撮る。スマホは `#navToggle` を押してからタブ切り替え
- `docs.google.com` / `script.google.com` をスタブするので**本番には一切通信しない**
- `sample-master.csv`（合成データ60行）を読み込む。読み込み件数とJSエラーをコンソールに出す
- Chromium のパスを指定する場合は `CHROME_PATH=... node verify.js`

初回は `npm i && npx playwright install chromium` が必要（`package.json` はリポジトリに含めてある）。

**スマホの作り込みは特に厳しくチェックされる。** 現場のコール活動がスマホで行われるため。

---

## リリース手順

1. `index.html` の `APP_BUILD` を上げる（現在 `ver 0817b` / `index.html:4024`）
2. コミット＆プッシュ
3. GitHub Pages のビルドに1〜3分かかる。`?cb=xxxx` を付けて確認
4. 本番で `APP_BUILD` の表示・`allCases.length`・エラー赤帯の有無を確認する

Pages 設定: Deploy from a branch / `main` / `(root)`。Custom domain 未設定。

**リポジトリへの push は必ず一箇所からに絞ること。** 複数のセッションが同時に push すると
履歴の衝突や上書きが起きる（2026/08/17 に実際に発生）。

---

## 残っている作業

優先順:

1. ワーカーの `.gitignore` 作成（`.env.local` の漏洩防止）とバージョン管理下への移行
2. ワーカーの停止検知（Chatwork通知の設定確認）と再構築手順の文書化 ← サイレント障害対策
3. **稼働中GASをリポジトリへ書き戻す**（3関数＋`onOpen`＋`mota_refill`）。以後リポジトリ→GASの一方向に
4. `reply.html` を推測不可能なトークン方式に変更（連番IDの列挙を塞ぐ）
5. テスト用スプレッドシート＋テスト用デプロイの作成
6. 認証改修 → 公開CSVの公開解除 → `SECRET_KEY` 廃止
7. スプレッドシート／GASの所有権を `@indio.co.jp` へ移管 ← `/exec` URL が変わらないか要検証
8. 過去158行の列ズレを一括補正
9. GitHub Support へ `f5ed52b` の purge を依頼
10. `assign-engine.gs` / `status.html` の名簿に `金木` を追加するか判断
12. 独自ドメイン `satei.indio.co.jp`（業者のDNS CNAME待ち）→ Pages設定 + `REPLY_URL_BASE` 変更
13. 1時間ごとの自動割り振りトリガー（`enableAssignTrigger()`）— 保留中
14. Chatwork通知（`CHATWORK_TOKEN` / `CHATWORK_ROOM` が空）— 保留中

---

## 進め方

- ユーザーは日本語。技術的な説明は求められたら丁寧に、普段は結論から短く
- **技術的な詳細の判断は任される。** 選択肢を並べるより、根拠を示して推奨を出すこと。
  ただし本人にしかできないこと（契約確認・所有権・費用）は明確に切り分けて渡す
- 判断の軸は本人の言葉で「**3年は必ず運用する / このシステムで実績を伸ばす / 情報漏洩リスク**」。
  場当たり的な修正より、ドリフトを解消して土台を固めることを優先する
- 「整頓してほしい」「詰めてほしい」のような感覚的な指示が多い。
  実際にレンダリングして数値（幅・余白・行高）で確認し、before/after を示すと話が早い
- 詰めすぎると「若干の余裕は欲しい」と戻される。中間を狙う
- 大きく変える前に選択肢を出して確認を取る
- **調査結果を鵜呑みにしない。** 別セッションの報告に事実誤認が複数あった
  （存在しないファイルの引用、匿名化漏れ、読んでいないコードの推測）。
  重要な判断の前にコードと実データで裏を取ること

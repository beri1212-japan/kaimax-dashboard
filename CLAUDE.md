# kaimax — 買取案件管理ダッシュボード

株式会社インディオ富山の中古車買取案件を管理するツール。
公開先: https://beri1212-japan.github.io/kaimax-dashboard/

## 構成

| ファイル | 役割 |
|---|---|
| `index.html` | アプリ本体。**1ファイル完結**（inline CSS + 2つの `<script>`）。約5,700行 |
| `sw.js` | PWA用サービスワーカー。**fetchイベントは実装しない**（後述の事故参照） |
| `manifest.webmanifest` | PWAマニフェスト |
| `reply.html` / `status.html` | 顧客回答フォーム / 放置監視ページ |
| `kaimax-GAS.gs` | Apps Script 本体（書き込みWebhook） |
| `assign-engine.gs` | 担当者の自動割り振り |
| `gas-reply-endpoint.gs` | 顧客回答の受け口 |
| `gas-8calls-patch.gs` | コール⑥⑦⑧の追加パッチ |
| `sms-endpoint.gs` | SMS送信（メディアSMS想定・未接続。★要差し替え箇所あり） |

`index.html` は分割しない。ユーザーはGitHubのアップロード画面から差し替える運用なので、1ファイルであることが前提。

## データの流れ

```
読み: 公開CSV (CSV_URL) → parseCSV() → rowsToCases() → allCases
書き: postWebhook(action, payload) → GAS /exec → スプレッドシート
```

- スプレッドシート: `買取案件管理表`
  https://docs.google.com/spreadsheets/d/1V1xWTjdin_zbEjyjOJh-3TymkOreFzaN18_iCZnCinI/edit
- シート名 `マスタ案件`、約360件

### 列構成（実シート準拠）

```
A=案件NO B=媒体 C=受信日 D=顧客名 E=TEL F=車名
G=入札 H=入札結果 I=ライバル社
J=①結果 K=②結果 L=②日付 M=③結果 N=③日付
O=④結果 P=④日付 Q=⑤結果 R=⑤日付
S=査定 T=結果 U=次回後追日 V=担当者 W=備考
X=顧客希望額 Y=査定提示額 Z=成約額
AA=住所 AB=メール AC=年式 AD=走行距離  AF=通話メモ
⑥⑦⑧は findHeaderCol_/ensureHeaderCol_ で右端に自動作成
```

### GAS のアクション

`create` / `update` / `delete` / `mota_create` / `mota_won` / `mota_result` /
`update_calls` / `update_memo` / `update_meta` / `reply`

## 触るときの必須知識（過去に事故ったところ）

1. **`buildRow()` は A〜AD を丸ごと書く。** 部分更新には使わない。
   一覧やパネルからの更新は必ず `update_calls` / `update_memo` / `update_meta` を使うこと。
   これを守らないと査定明細や住所が消える。

2. **X〜Z列には「1,800,000円」やMOTAの査定明細テキストが生で入っている行がある。**
   数値化した値を書き戻すと明細が消えるので、`desiredRaw`/`offeredRaw`/`dealRaw` に
   生文字列を保持して編集・保存はそちらを使う。

3. **AA〜AD が1列ズレている行が混在する。** `rowsToCases()` の中で
   メール形式・「年式」「キロ/km」の有無をスコアリングしてどちらの配置か判定している。
   ここを単純化しないこと。

4. **`sw.js` に fetch ハンドラを書かない。**
   `e.respondWith(fetch(e.request))` を入れていた時期、公開CSVの取得が
   無応答のまま止まり、画面が「読み込み中...」のままサンプルデータ
   (`fallbackCases`) を表示し続ける事故が起きた（2026/08/17 に修正）。
   ブラウザ標準の通信に任せる。PWAのインストールは fetch ハンドラ無しでも可能
   （Chrome mobile 108 / desktop 112 以降）。

5. **CSV取得には必ずタイムアウトを付ける。** `fetchWithTimeout(url, 8000)` を使う。
   失敗時は赤帯＋「再読み込み」ボタンを出し、右上を「読み込み失敗」に変える。
   サンプルデータを本物の数字と誤認させないこと。

## デザインの決まり

Google Analytics 風。奇抜な色は使わない。

```
面 #f8f9fa / カード #fff / 罫線 #dadce0
文字 #202124 / #3c4043 / #5f6368
アクセント #1a73e8（濃 #1557b0 / 淡 #e8f0fe）
```

- 媒体タグだけは色分け可（淡い背景＋濃い文字、コントラスト4.5:1以上、色覚多様性検証済み）
  MOTA `#f7e9e1`/`#9c4a21` ・ カーセンサー `#e5ebf5`/`#2f5c93` ・ ナビクル `#e9f3eb`/`#2c7a3f`
  自社サイト `#eee7f3`/`#63408a` ・ 店頭 `#faf6eb`/`#8c6a00` ・ その他 `#eaecee`/`#4e555c`
- グラフ系列: 案件数 `#c4cbd3`(棒) / アポ `#2a78d6` / 査定 `#1baf7a` / 成約 `#eb6834`
- 色を追加・変更するときは `dataviz` スキルの `validate_palette.js` で必ず検証する
- **表は左詰め・列幅は内容に合わせる**。密度は在庫HUBに合わせて
  見出し11px / 本文12px / セル余白 3px 8px / 行高26px
- アイコンは `<symbol>` スプライト（Lucide風の線画）。絵文字は使わない
- ナビは左サイドバー。下部に「リンク」欄（スプレッドシート / ユーズドカーハイパー / アイオーク / データラインPRO）

## 見た目の確認方法

Playwright でスタブしてレンダリングし、**必ず画像を見てから**完了とする。

```js
await page.route('**/*', r => {
  const u = r.request().url();
  if (u.includes('docs.google.com')) return r.fulfill({status:200, contentType:'text/csv', body:csv});
  if (u.includes('script.google.com')) return r.fulfill({status:200, contentType:'application/json', body:'{}'});
  return r.continue();
});
```

PC 1300px と スマホ 390px の両方を見る。スマホはサイドバーが隠れるので
`#navToggle` を押してから。**スマホの作り込みは特に厳しくチェックされる。**

## リリース手順

1. `index.html` の `APP_BUILD` を上げる（例 `ver 0817b`）
2. コミット＆プッシュ
3. GitHub Pages のビルドに1〜3分かかる。`?cb=xxxx` を付けて確認
4. 本番で `APP_BUILD` の表示・`allCases.length`・エラー赤帯の有無を確認する

## 残っている作業

- **SMS API連携**（メディアSMS / Aurora SMS）。NDA手続き中。
  仕様書入手後に `sms-endpoint.gs` の `sendViaMediaSms_()` の★3箇所を差し替え。
  画面側の送信ボタンは未実装。`SMS実装メモ.md` 参照
- 独自ドメイン `satei.indio.co.jp`（業者のDNS CNAME待ち）→ Pages設定 + `REPLY_URL_BASE` 変更
- 1時間ごとの自動割り振りトリガー（`enableAssignTrigger()`）— ユーザー判断で保留中
- Chatwork通知（`CHATWORK_TOKEN` / `CHATWORK_ROOM` が空）— 保留中

## 進め方

- ユーザーは日本語。技術的な説明は求められたら丁寧に、普段は結論から短く
- 「整頓してほしい」「詰めてほしい」のような感覚的な指示が多い。
  実際にレンダリングして数値（幅・余白・行高）で確認し、before/after を示すと話が早い
- 詰めすぎると「若干の余裕は欲しい」と戻される。中間を狙う
- 大きく変える前に選択肢を出して確認を取る

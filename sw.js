// kaimax PWA サービスワーカー（最小構成） build:0817a
// 方針: fetchイベントを一切ハンドルしない。
//   以前は e.respondWith(fetch(e.request)) で全通信をSW経由にしていたが、
//   これが原因で公開CSVの取得が応答を返さないまま止まり、
//   画面が「読み込み中...」のままサンプルデータを表示する事故が起きた。
//   fetchハンドラを持たなければブラウザが直接通信するので、この経路の事故は起きない。
//   キャッシュもしないため、常に最新のindex.html/CSV/GASレスポンスを取得する。
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // 旧バージョンが作ったキャッシュが残っていたら消す
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});
// fetchイベントは意図的に未実装（ブラウザ標準の通信に任せる）

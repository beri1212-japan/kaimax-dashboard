// kaimax PWA サービスワーカー（最小構成） build:0810h
// 方針: データ鮮度を最優先するため一切キャッシュしない（常にネットワーク）。
// これによりインストール可能にしつつ、古いindex.htmlやCSV/GASレスポンスを
// 掴んでしまう事故を完全に防ぐ。オフライン動作は非対応（常時オンライン前提の業務ツール）。
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (e) => {
  // ネットワークをそのまま通す（キャッシュしない）
  e.respondWith(fetch(e.request));
});

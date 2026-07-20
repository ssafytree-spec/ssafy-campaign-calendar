// 최소 서비스워커: PWA 설치 가능 요건 충족용 (오프라인 캐싱은 하지 않음)
self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => self.clients.claim());
self.addEventListener("fetch", (e) => {
  // 그대로 네트워크로 통과 (캐싱 없이 항상 최신 데이터)
  e.respondWith(fetch(e.request));
});

// 서비스 워커: 홈 화면 앱 설치(PWA)용.
// 같은 사이트(GitHub Pages) 파일만 "네트워크 우선, 실패 시 캐시"로 처리한다.
// → 배포하면 항상 최신 화면을 받고, 통신이 끊겼을 때만 마지막 화면을 보여줌.
// Supabase·CDN 등 외부 요청은 건드리지 않음 (데이터/로그인은 항상 서버에서 직접).
const CACHE = "defect-report-v1";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icons/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match("./index.html"))),
  );
});

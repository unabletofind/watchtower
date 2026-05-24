// watchtower — minimal service worker
// Required for PWA install + share-target on Android.
// Caches the shell so the app loads offline.

const CACHE = "watchtower-v1";
const SHELL = [
  "./",
  "./index.html",
  "./assets/style.css",
  "./assets/app.js",
  "./manifest.json"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never cache data/* — we want fresh jobs every time
  if (url.pathname.includes("/data/")) {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
    return;
  }

  // Shell: network-first, fall back to cache
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res && res.ok && event.request.method === "GET") {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});

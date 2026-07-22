/**
 * Service worker: caches the static app shell for offline use. Never touches
 * IndexedDB — the actual entries/tags/conditions are never part of what this
 * file caches or serves, only the code/assets that make up the app itself.
 *
 * Bump CACHE_NAME whenever a file is *removed* from APP_SHELL (not just
 * edited) — content edits are picked up automatically on the next deploy
 * because `install` re-fetches every URL in the list below, but a stale
 * cached entry for a since-removed URL would otherwise never get evicted.
 */
const CACHE_NAME = "symptom-tracker-v2";

const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/style.css",
  "./vendor/chart.umd.min.js",
  "./js/db.js",
  "./js/date-utils.js",
  "./js/pickers.js",
  "./js/importer.js",
  "./js/log.js",
  "./js/timeline.js",
  "./js/trends.js",
  "./js/data.js",
  "./js/app.js",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

// Pre-cache the app shell, then activate this worker immediately instead of
// waiting for all open tabs to close.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

// Drop any cache left over from a previous CACHE_NAME, and take control of
// already-open tabs right away.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

// Cache-first: serve from cache when possible (works offline), otherwise
// fetch from the network and cache that response for next time.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok && response.type === "basic") {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});

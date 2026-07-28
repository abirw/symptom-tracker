/**
 * Service worker: caches the static app shell for offline use. Never touches
 * IndexedDB — the actual entries/tags/conditions are never part of what this
 * file caches or serves, only the code/assets that make up the app itself.
 *
 * Network-first, not cache-first: a browser only re-installs a service
 * worker when THIS FILE'S OWN BYTES change, so a cache-first strategy
 * silently freezes every cached JS/CSS file at whatever was live the last
 * time sw.js itself was edited - editing app.js/trends.js/etc. alone never
 * triggers a re-install, so a stale install would otherwise never notice
 * dozens of later deploys. Fetching from the network first (falling back to
 * cache only when offline) means a deploy is visible immediately to anyone
 * online, while offline use still works from whatever was last cached.
 *
 * Bump CACHE_NAME whenever a file is *removed* from APP_SHELL (not just
 * edited) — a stale cached entry for a since-removed URL would otherwise
 * never get evicted.
 */
const CACHE_NAME = "symptom-tracker-v3";

const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/style.css",
  "./vendor/chart.umd.min.js",
  "./js/db.js",
  "./js/settings.js",
  "./js/date-utils.js",
  "./js/pickers.js",
  "./js/tag-picker-field.js",
  "./js/importer.js",
  "./js/bucketing.js",
  "./js/heatmap.js",
  "./js/analysis.js",
  "./js/log.js",
  "./js/timeline.js",
  "./js/trends.js",
  "./js/reports.js",
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

// Network-first: always try the network so a new deploy is picked up right
// away, caching the fresh response for next time; fall back to whatever's
// cached only when the network fetch fails (offline).
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok && response.type === "basic") {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

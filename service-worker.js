const CACHE_NAME = "jva-score-static-v64";
const APP_FILES = [
  "./",
  "./index.html",
  "./style.css?v=49",
  "./app.js",
  "./score.js",
  "./storage.js",
  "./components.js",
  "./manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys
      .filter((key) => key.startsWith("jva-score-static-") && key !== CACHE_NAME)
      .map((key) => caches.delete(key)))),
  );
  self.clients.claim();
});

async function fetchWithCacheFallback(cache, key, request) {
  let response;
  try {
    response = await fetch(request);
  } catch (error) {
    const cached = await cache.match(key);
    if (cached) return cached;
    throw error;
  }
  if (response.ok) {
    try {
      await cache.put(key, response.clone());
    } catch (error) {
      console.warn("Service Worker cache update failed:", error);
    }
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    event.respondWith(caches.open(CACHE_NAME)
      .then((cache) => fetchWithCacheFallback(cache, "./index.html", request)));
    return;
  }
  event.respondWith(caches.open(CACHE_NAME)
    .then((cache) => fetchWithCacheFallback(cache, request)));
});

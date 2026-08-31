// Bumped with the caching rules below: entries written by v2 predate the
// `Cache-Control` check, so anything the server marked uncacheable is still
// sitting in that cache. `activate` deletes every cache that is not this one.
const CACHE_NAME = "macro-tracker-v3";
const APP_SHELL = [
  "/manifest.webmanifest",
  "/icon.svg",
  "/icon-maskable.svg",
  "/apple-touch-icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      ),
  );
  self.clients.claim();
});

const CACHEABLE_DESTINATIONS = ["script", "style", "image", "font"];

/**
 * The origin server gets the final say. Without this a response marked
 * `no-store` or `private` was still written to the cache purely because its
 * destination was a script/style/image/font, and nothing ever evicted it.
 */
function isCacheable(request, response) {
  if (
    !response.ok ||
    response.redirected ||
    !CACHEABLE_DESTINATIONS.includes(request.destination)
  ) {
    return false;
  }

  const cacheControl = (response.headers.get("cache-control") ?? "").toLowerCase();

  return !/(^|,)\s*(no-store|no-cache|private)\s*(,|;|$)/.test(cacheControl);
}

/**
 * Content-hashed bundles cannot change under the same URL, so revalidating them
 * would spend a request per asset per page load for a guaranteed 304.
 */
function isImmutable(response) {
  return (response.headers.get("cache-control") ?? "")
    .toLowerCase()
    .includes("immutable");
}

function putInCache(request, response) {
  const responseClone = response.clone();

  return caches
    .open(CACHE_NAME)
    .then((cache) => cache.put(request, responseClone))
    // A quota or storage failure must not surface to the page: the network
    // response has already been handed back by this point.
    .catch(() => {});
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }

  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) {
    return;
  }

  if (event.request.mode === "navigate") {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const revalidate = () =>
        fetch(event.request).then((networkResponse) => {
          if (isCacheable(event.request, networkResponse)) {
            putInCache(event.request, networkResponse);
          }

          return networkResponse;
        });

      if (!cachedResponse) {
        return revalidate();
      }

      if (isImmutable(cachedResponse)) {
        return cachedResponse;
      }

      // Stale-while-revalidate: answer from the cache immediately, then let the
      // background fetch refresh the entry so a cached asset cannot be pinned
      // forever. `waitUntil` keeps the worker alive for it, and a failed
      // revalidation just leaves the cached copy in place.
      event.waitUntil(revalidate().catch(() => {}));
      return cachedResponse;
    }),
  );
});

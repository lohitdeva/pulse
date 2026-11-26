import {
  installPushWorkerHandlers,
  type PushWorkerScope,
} from "./push";

interface PrecacheEntry {
  url: string;
  revision: string | null;
}

declare global {
  interface Window {
    __WB_MANIFEST: PrecacheEntry[];
  }
}

interface ServiceWorkerRuntime extends PushWorkerScope {
  __WB_MANIFEST: PrecacheEntry[];
  skipWaiting(): Promise<void>;
  caches: CacheStorage;
  clients: PushWorkerScope["clients"] & { claim(): Promise<void> };
  addEventListener(
    type: string,
    listener: (event: unknown) => void,
  ): void;
}

interface ExtendableEventLike {
  waitUntil(promise: Promise<unknown>): void;
}

interface FetchEventLike extends ExtendableEventLike {
  request: Request;
  respondWith(response: Promise<Response> | Response): void;
}

const serviceWorker = globalThis as unknown as ServiceWorkerRuntime;
const precacheName = "pulse-precache-v1";
const precacheEntries = self.__WB_MANIFEST;
const precacheUrls = new Set(
  precacheEntries.map((entry) => new URL(entry.url, serviceWorker.location.origin).href),
);

serviceWorker.addEventListener("install", (rawEvent) => {
  const event = rawEvent as ExtendableEventLike;
  event.waitUntil(
    (async () => {
      const cache = await serviceWorker.caches.open(precacheName);
      await cache.addAll([...precacheUrls]);
      await serviceWorker.skipWaiting();
    })(),
  );
});

serviceWorker.addEventListener("activate", (rawEvent) => {
  const event = rawEvent as ExtendableEventLike;
  event.waitUntil(
    (async () => {
      const cacheNames = await serviceWorker.caches.keys();
      await Promise.all(
        cacheNames
          .filter(
            (cacheName) =>
              cacheName.startsWith("pulse-precache-") &&
              cacheName !== precacheName,
          )
          .map((cacheName) => serviceWorker.caches.delete(cacheName)),
      );
      await serviceWorker.clients.claim();
    })(),
  );
});

serviceWorker.addEventListener("fetch", (rawEvent) => {
  const event = rawEvent as FetchEventLike;
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== serviceWorker.location.origin) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await serviceWorker.caches.open(precacheName);
        const shell = await cache.match(
          new URL("/index.html", serviceWorker.location.origin).href,
        );
        if (shell) return shell;
        throw new Error("Pulse app shell is not cached");
      }),
    );
    return;
  }

  if (precacheUrls.has(url.href)) {
    event.respondWith(
      serviceWorker.caches.open(precacheName).then(async (cache) => {
        const cached = await cache.match(request);
        return cached ?? fetch(request);
      }),
    );
  }
});

installPushWorkerHandlers(serviceWorker);

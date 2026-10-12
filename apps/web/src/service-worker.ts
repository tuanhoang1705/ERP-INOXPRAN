/// <reference lib="webworker" />
import { build, files, version } from '$service-worker';

const worker = self as unknown as ServiceWorkerGlobalScope;
const cacheName = `inoxpran-shell-${version}`;
const shell = [...build, ...files];

worker.addEventListener('install', (event) => {
  event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll(shell)));
});

worker.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== cacheName).map((key) => caches.delete(key)))),
  );
});

worker.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || new URL(event.request.url).pathname.startsWith('/api/')) return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request).then((response) => response ?? Response.error())));
});

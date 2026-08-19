/**
 * オフラインでも使えるようにするための Service Worker。
 *
 * あわせて、他アプリの「共有」からこのアプリへ写真を渡す導線
 * （Web Share Target）も受け持つ。
 */

const CACHE = 'syashin-syukusyou-v4';
const SHARE_CACHE = 'syashin-syukusyou-shared';

const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './src/app.js',
  './src/compress.js',
  './src/exif.js',
  './src/fastvideo.js',
  './src/format.js',
  './src/mp4.js',
  './src/mp4demux.js',
  './src/video.js',
  './src/videocommon.js',
  './src/zip.js',
  './icons/icon.svg',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE && key !== SHARE_CACHE).map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 他アプリから共有された写真を受け取る
  if (request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(receiveSharedPhotos(request));
    return;
  }
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith(cacheFirst(request));
});

/** キャッシュを優先しつつ、裏で新しいものを取りに行く */
async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  const network = fetch(request)
    .then((response) => {
      if (response.ok && response.type === 'basic') cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  const response = cached ?? (await network);
  if (response) return response;
  return (await cache.match('./index.html')) ?? Response.error();
}

/**
 * 共有された写真を一時キャッシュに預け、アプリ本体へリダイレクトする。
 * Service Worker は随時停止しうるので、メモリではなく Cache Storage に置く。
 */
async function receiveSharedPhotos(request) {
  const target = new URL('./?shared=1', self.registration.scope);
  try {
    const form = await request.formData();
    const files = form.getAll('photos').filter((entry) => entry instanceof File);
    await caches.delete(SHARE_CACHE);
    if (files.length > 0) {
      const cache = await caches.open(SHARE_CACHE);
      await Promise.all(files.map((file, index) => {
        const key = new URL(`./shared/${index}?name=${encodeURIComponent(file.name)}`, self.registration.scope);
        return cache.put(key, new Response(file, {
          headers: { 'content-type': file.type || 'application/octet-stream' },
        }));
      }));
    }
  } catch {
    // 受け取りに失敗しても、アプリは通常どおり開く
  }
  return Response.redirect(target, 303);
}

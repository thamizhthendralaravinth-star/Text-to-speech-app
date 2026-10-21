// Stores the whole app (including the OCR engine and language data) so it runs with no internet.
const CACHE = 'thendral-v7';
const FILES = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon.png',
  'vendor/tesseract.min.js',
  'vendor/worker.min.js',
  'vendor/core/tesseract-core-lstm.wasm.js',
  'vendor/core/tesseract-core-simd-lstm.wasm.js',
  'lang/eng.traineddata.gz',
  'lang/tam.traineddata.gz',
  'voices/bella.mp3',
  'voices/sarah.mp3',
  'voices/michael.mp3',
  'voices/george.mp3',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)),
  );
});

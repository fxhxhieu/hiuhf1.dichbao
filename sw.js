/* hiuhf1 - service worker: lưu sẵn giao diện, thư viện và font để mở được khi mất mạng */
// Đổi file trong vendor/ hoặc fonts/ thì tăng VERSION, vì các file đó được lấy từ bộ nhớ trước.
const VERSION = 'hiuhf1-v1';
const CORE = [
  './', 'index.html', 'css/style.css', 'manifest.webmanifest', 'icon.svg',
  'js/core.js', 'js/translate.js', 'js/storage.js', 'js/export.js', 'js/ocr.js', 'js/app.js',
  'vendor/pdf.min.js', 'vendor/pdf.worker.min.js', 'vendor/pdf-lib.min.js', 'vendor/fontkit.umd.min.js', 'vendor/docx.umd.js',
  'fonts/NotoSans-Regular.ttf', 'fonts/NotoSans-Bold.ttf', 'fonts/NotoSerif-Regular.ttf', 'fonts/NotoSerif-Bold.ttf', 'fonts/NotoSansMath-Regular.ttf',
];
// file lớn và không đổi: lấy từ bộ nhớ trước, không có mới tải
const IMMUTABLE = /\/(?:vendor|fonts)\//;
// Tesseract.js (OCR) và font dự phòng trên CDN: phiên bản cố định nên cũng lấy từ bộ nhớ trước
const CDN = /^https:\/\/cdn\.jsdelivr\.net\/(?:npm\/(?:tesseract\.js|tesseract\.js-core|@tesseract\.js-data)|gh\/notofonts)/;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('hiuhf1-') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    e.respondWith(IMMUTABLE.test(url.pathname) ? cacheFirst(req) : networkFirst(req));
  } else if (CDN.test(req.url)) {
    e.respondWith(cacheFirst(req));
  }
  // còn lại (các dịch vụ dịch) đi thẳng ra mạng
});

async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) (await caches.open(VERSION)).put(req, res.clone());
  return res;
}

// Giao diện và mã của app: luôn lấy bản mới khi có mạng, mất mạng thì dùng bản đã lưu.
// no-cache: hỏi lại máy chủ thay vì dùng bộ nhớ đệm HTTP, để vừa cập nhật web là người dùng nhận bản mới.
async function networkFirst(req) {
  try {
    const fresh = req.mode === 'navigate'
      ? new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' })
      : new Request(req, { cache: 'no-cache' });
    const res = await fetch(fresh);
    if (res.ok) (await caches.open(VERSION)).put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}

/* hiuhf1 - lưu bản dịch, file PDF và bộ nhớ dịch vào IndexedDB */
window.HV = window.HV || {};

(function (HV) {
  // Các kho dữ liệu:
  //  docs  - thông tin từng bài đã mở (tên, số trang, số trang đã dịch, lần mở cuối)
  //  files - nội dung file PDF, để mở lại từ danh sách "Bài đã mở gần đây"
  //  pages - bản dịch theo trang: { items: [{ h: hash văn bản gốc, t: bản dịch, e: engine }] }
  //  tm    - bộ nhớ dịch dùng chung mọi bài: hash văn bản gốc -> { 'engine|...': bản dịch }
  //  ocr   - chữ nhận dạng được (OCR) của trang scan
  //  trans - dữ liệu phiên bản cũ (lưu theo chỉ số khối), chỉ đọc để chuyển sang kho mới
  const STORES = ['docs', 'files', 'pages', 'tm', 'ocr', 'trans'];
  const mem = {}; // dự phòng khi IndexedDB không dùng được (vd. chế độ riêng tư của vài trình duyệt)
  STORES.forEach((s) => { mem[s] = new Map(); });
  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve) => {
        try {
          const req = indexedDB.open('hiuhf1', 2);
          req.onupgradeneeded = () => {
            const db = req.result;
            STORES.forEach((s) => { if (!db.objectStoreNames.contains(s)) db.createObjectStore(s); });
          };
          req.onsuccess = () => {
            const db = req.result;
            db.onversionchange = () => db.close(); // để tab mới nâng cấp CSDL không bị chặn
            resolve(db);
          };
          req.onerror = () => resolve(null);
          req.onblocked = () => resolve(null);
        } catch (e) { resolve(null); }
      });
    }
    return dbPromise;
  }

  // Chạy fn(store) trong một giao dịch; fn trả về request hoặc mảng request, kết quả lấy khi giao dịch xong.
  // Trả về undefined nếu giao dịch lỗi.
  function run(db, name, mode, fn) {
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(name, mode);
        const r = fn(tx.objectStore(name));
        tx.oncomplete = () => resolve(Array.isArray(r) ? r.map((x) => x.result) : r ? r.result : null);
        tx.onerror = tx.onabort = () => resolve(undefined);
      } catch (e) { resolve(undefined); }
    });
  }

  async function getMany(name, keys) {
    const db = await open();
    const res = db && keys.length ? await run(db, name, 'readonly', (s) => keys.map((k) => s.get(k))) : undefined;
    return keys.map((k, i) => {
      const v = res && res[i];
      return v != null ? v : mem[name].has(k) ? mem[name].get(k) : null;
    });
  }
  async function get(name, key) { return (await getMany(name, [key]))[0]; }

  async function putMany(name, entries) {
    if (!entries.length) return;
    const db = await open();
    const ok = db ? await run(db, name, 'readwrite', (s) => { entries.forEach(([k, v]) => s.put(v, k)); return null; }) : undefined;
    // ghi không được (hết dung lượng, không có IndexedDB) thì giữ tạm trong bộ nhớ của tab
    entries.forEach(([k, v]) => { if (ok === undefined) mem[name].set(k, v); else mem[name].delete(k); });
  }
  const put = (name, key, val) => putMany(name, [[key, val]]);

  async function del(name, keys) {
    keys.forEach((k) => mem[name].delete(k));
    const db = await open();
    if (db && keys.length) await run(db, name, 'readwrite', (s) => { keys.forEach((k) => s.delete(k)); return null; });
  }

  async function values(name) {
    const db = await open();
    const v = db ? await run(db, name, 'readonly', (s) => s.getAll()) : null;
    return (v || []).concat([...mem[name].values()]);
  }

  async function count(name) {
    const db = await open();
    const n = db ? await run(db, name, 'readonly', (s) => s.count()) : 0;
    return (n || 0) + mem[name].size;
  }

  async function clear(name) {
    mem[name].clear();
    const db = await open();
    if (db) await run(db, name, 'readwrite', (s) => s.clear());
  }

  const pageKeys = (doc, n) => Array.from({ length: n }, (_, i) => doc + '|' + i);

  HV.store = {
    /* bản dịch theo trang */
    getPage: (doc, i) => get('pages', doc + '|' + i),
    putPage: (doc, i, v) => put('pages', doc + '|' + i, v),
    clearPages: (doc, n) => del('pages', pageKeys(doc, n)),

    /* thông tin bài và file PDF */
    getDoc: (id) => get('docs', id),
    putDoc: (meta) => put('docs', meta.id, meta),
    listDocs: async () => (await values('docs')).sort((a, b) => (b.opened || 0) - (a.opened || 0)),
    getFile: (id) => get('files', id),
    putFile: (id, bytes) => put('files', id, bytes),
    async deleteDoc(id, n) {
      await del('docs', [id]);
      await del('files', [id]);
      await del('pages', pageKeys(id, n));
      await del('ocr', pageKeys(id, n));
    },

    /* chữ nhận dạng (OCR) */
    getOcr: (doc, i) => get('ocr', doc + '|' + i),
    putOcr: (doc, i, v) => put('ocr', doc + '|' + i, v),

    /* bộ nhớ dịch: tra theo hash văn bản gốc, mỗi engine (kèm bảng thuật ngữ) một bản dịch */
    tmGet: (hashes) => getMany('tm', hashes),
    async tmPut(entries) { // [{ h, k, t }]
      if (!entries.length) return;
      const cur = await getMany('tm', entries.map((x) => x.h));
      const merged = new Map();
      entries.forEach((x, i) => {
        const v = merged.get(x.h) || Object.assign({}, cur[i] || {});
        v[x.k] = x.t;
        merged.set(x.h, v);
      });
      await putMany('tm', [...merged]);
    },
    tmDelete: (hashes) => del('tm', hashes),
    tmCount: () => count('tm'),
    tmClear: () => clear('tm'),

    /* dữ liệu phiên bản cũ */
    legacyGet: (key) => get('trans', key),
    legacyDelete: (key) => del('trans', [key]),

    async clearAll() { for (const s of STORES) await clear(s); },
    async usage() {
      try { return (await navigator.storage.estimate()).usage || 0; } catch (e) { return 0; }
    },
    // xin trình duyệt không tự xoá dữ liệu khi thiếu chỗ
    persist() {
      try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch (e) { /* bỏ qua */ }
    },
  };
})(window.HV);

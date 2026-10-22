/* hiuhf1 - lưu bản dịch vào IndexedDB để dịch tiếp khi mở lại */
window.HV = window.HV || {};

(function (HV) {
  const mem = new Map(); // dự phòng khi IndexedDB không dùng được
  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve) => {
        try {
          const req = indexedDB.open('hiuhf1', 1);
          req.onupgradeneeded = () => req.result.createObjectStore('trans');
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        } catch (e) { resolve(null); }
      });
    }
    return dbPromise;
  }

  function run(mode, fn) {
    return open().then((db) => {
      if (!db) return null;
      return new Promise((resolve) => {
        try {
          const tx = db.transaction('trans', mode);
          const req = fn(tx.objectStore('trans'));
          tx.oncomplete = () => resolve(req ? req.result : null);
          tx.onerror = () => resolve(null);
        } catch (e) { resolve(null); }
      });
    });
  }

  HV.store = {
    async get(docId, page) {
      const key = docId + '|' + page;
      const v = await run('readonly', (s) => s.get(key));
      return v != null ? v : mem.get(key) || null;
    },
    async put(docId, page, value) {
      const key = docId + '|' + page;
      mem.set(key, value);
      await run('readwrite', (s) => s.put(value, key));
    },
    async clear(docId, pages) {
      for (let i = 0; i < pages; i++) {
        const key = docId + '|' + i;
        mem.delete(key);
        await run('readwrite', (s) => s.delete(key));
      }
    },
  };
})(window.HV);

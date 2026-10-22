/* hiuhf1 - các engine dịch miễn phí và cơ chế tự chuyển dự phòng */
window.HV = window.HV || {};

(function (HV) {
  const TARGET = 'vi';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Chạy fn trên mảng với tối đa `limit` tác vụ song song, giữ nguyên thứ tự kết quả
  async function pool(items, limit, fn, signal) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        if (signal.aborted) throw new DOMException('Đã dừng', 'AbortError');
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
  }

  // Cắt văn bản dài theo câu để không vượt giới hạn của từng dịch vụ
  function splitText(text, max) {
    if (text.length <= max) return [text];
    const parts = text.split(/(?<=[.!?;])\s+/);
    const chunks = [];
    let cur = '';
    for (let p of parts) {
      while (p.length > max) {
        if (cur) { chunks.push(cur); cur = ''; }
        chunks.push(p.slice(0, max));
        p = p.slice(max);
      }
      if (cur && (cur + ' ' + p).length > max) { chunks.push(cur); cur = p; }
      else cur = cur ? cur + ' ' + p : p;
    }
    if (cur) chunks.push(cur);
    return chunks;
  }

  /* ---------- Google Translate (không chính thức) ---------- */
  // Endpoint /t nhận nhiều tham số q trong một lần gọi, nên ít bị giới hạn tốc độ hơn gọi từng đoạn.
  async function gtxBatch(texts, src, signal) {
    const url = 'https://translate.googleapis.com/translate_a/t?client=gtx&dt=t&sl=' + src + '&tl=' + TARGET;
    const body = new URLSearchParams();
    texts.forEach((t) => body.append('q', t));
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal,
    });
    if (!res.ok) throw new Error('Google trả về HTTP ' + res.status);
    const data = await res.json();
    if (!Array.isArray(data) || data.length !== texts.length) throw new Error('Google trả về sai số đoạn');
    // sl=auto trả [bản dịch, ngôn ngữ nguồn], sl cụ thể trả thẳng chuỗi
    return data.map((x) => (Array.isArray(x) ? x[0] : x));
  }

  async function googleBatch(texts, src, signal) {
    const pieces = [];
    texts.forEach((t, idx) => splitText(t, 3500).forEach((c) => pieces.push({ idx, c })));
    const groups = [];
    let g = [], n = 0;
    for (const p of pieces) {
      if (g.length && (n + p.c.length > 4500 || g.length >= 40)) { groups.push(g); g = []; n = 0; }
      g.push(p); n += p.c.length;
    }
    if (g.length) groups.push(g);
    const results = await pool(groups, 2, (grp) => gtxBatch(grp.map((p) => p.c), src, signal), signal);
    const out = texts.map(() => []);
    groups.forEach((grp, gi) => grp.forEach((p, k) => out[p.idx].push(results[gi][k])));
    return out.map((a) => a.join(' '));
  }

  /* ---------- MyMemory ---------- */
  async function mymemory(text, src, email, signal) {
    const lp = (src === 'auto' ? 'Autodetect' : src) + '|' + TARGET;
    let url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) + '&langpair=' + encodeURIComponent(lp);
    if (email) url += '&de=' + encodeURIComponent(email);
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error('MyMemory trả về HTTP ' + res.status);
    const data = await res.json();
    const t = data.responseData && data.responseData.translatedText;
    if (data.quotaFinished || /MYMEMORY WARNING/i.test(t || '')) throw new Error('MyMemory đã hết hạn mức trong ngày');
    if (Number(data.responseStatus) !== 200 || !t) throw new Error('MyMemory lỗi: ' + (data.responseDetails || data.responseStatus));
    return t;
  }

  /* ---------- Translator tích hợp trong Chrome ---------- */
  const chromeCache = new Map();
  async function chromeTranslator(src) {
    if (!('Translator' in self)) throw new Error('Trình duyệt không hỗ trợ Translator API (cần Chrome 138+)');
    const sourceLanguage = src === 'auto' ? 'en' : src;
    if (chromeCache.has(sourceLanguage)) return chromeCache.get(sourceLanguage);
    const opts = { sourceLanguage, targetLanguage: TARGET };
    const av = await Translator.availability(opts);
    if (av === 'unavailable') throw new Error('Chrome chưa hỗ trợ cặp ngôn ngữ ' + sourceLanguage + ' → vi');
    const t = await Translator.create(opts);
    chromeCache.set(sourceLanguage, t);
    return t;
  }

  /* ---------- Gemini (cần key miễn phí) ---------- */
  async function geminiBatch(texts, st, signal) {
    const out = [];
    let group = [], size = 0;
    const groups = [];
    for (const t of texts) {
      if (group.length && size + t.length > 7000) { groups.push(group); group = []; size = 0; }
      group.push(t); size += t.length;
    }
    if (group.length) groups.push(group);
    for (const g of groups) {
      const prompt =
        'Bạn là dịch giả học thuật. Dịch từng đoạn trong mảng JSON sau sang tiếng Việt, văn phong khoa học, tự nhiên, ' +
        'giữ nguyên thuật ngữ chuyên ngành thông dụng, tên riêng, công thức, ký hiệu và số liệu. ' +
        'Chỉ trả về một mảng JSON các chuỗi, đúng số phần tử và đúng thứ tự.\n' + JSON.stringify(g);
      const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(st.geminiModel) + ':generateContent?key=' + encodeURIComponent(st.geminiKey);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
        }),
        signal,
      });
      if (!res.ok) throw new Error('Gemini trả về HTTP ' + res.status);
      const data = await res.json();
      const raw = data.candidates && data.candidates[0].content.parts[0].text;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr) || arr.length !== g.length) throw new Error('Gemini trả về sai số đoạn');
      out.push(...arr.map(String));
    }
    return out;
  }

  /* ---------- Danh sách engine ---------- */
  HV.engines = {
    google: {
      label: 'Google Translate',
      available: () => true,
      batch: (texts, st, signal) => googleBatch(texts, st.src, signal),
    },
    chrome: {
      label: 'Chrome (trên máy)',
      available: () => 'Translator' in self,
      batch: async (texts, st, signal) => {
        const tr = await chromeTranslator(st.src);
        const out = [];
        for (const t of texts) {
          if (signal.aborted) throw new DOMException('Đã dừng', 'AbortError');
          out.push(await tr.translate(t));
        }
        return out;
      },
    },
    mymemory: {
      label: 'MyMemory',
      available: () => true,
      batch: (texts, st, signal) =>
        pool(texts, 2, async (t) => (await pool(splitText(t, 450), 1, (c) => mymemory(c, st.src, st.email, signal), signal)).join(' '), signal),
    },
    gemini: {
      label: 'Gemini (API key)',
      available: (st) => !!(st && st.geminiKey),
      batch: geminiBatch,
    },
  };

  /* ---------- Bộ dịch có thử lại và tự chuyển engine ---------- */
  HV.Translator = class {
    constructor(settings, onSwitch) {
      this.st = settings;
      this.onSwitch = onSwitch || (() => {});
      const rest = ['google', 'chrome', 'mymemory'].filter((e) => e !== settings.engine);
      this.order = [settings.engine, ...rest];
      this.cur = 0;
    }
    get name() { return this.order[this.cur]; }
    get label() { return HV.engines[this.name].label; }

    async translate(texts, signal) {
      for (;;) {
        const eng = HV.engines[this.name];
        let lastErr;
        if (eng.available(this.st)) {
          for (let attempt = 0; attempt < 3; attempt++) {
            try { return await eng.batch(texts, this.st, signal); }
            catch (e) {
              if (e.name === 'AbortError' || signal.aborted) throw e;
              lastErr = e;
              if (attempt < 2) await sleep([2000, 8000][attempt]);
            }
          }
        } else {
          lastErr = new Error('Engine chưa sẵn sàng');
        }
        // chuyển sang engine kế tiếp còn dùng được
        let moved = false;
        while (this.cur + 1 < this.order.length) {
          this.cur++;
          if (HV.engines[this.name].available(this.st)) { moved = true; break; }
        }
        if (!moved) throw lastErr;
        this.onSwitch(this.label, lastErr);
      }
    }
  };
})(window.HV);

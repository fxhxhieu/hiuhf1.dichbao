/* hiuhf1 - các engine dịch, che phần không cần dịch, bộ nhớ dịch và cơ chế tự chuyển dự phòng */
window.HV = window.HV || {};

(function (HV) {
  const TARGET = 'vi';
  const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/';
  const abortError = () => new DOMException('Đã dừng', 'AbortError');

  // Chờ ms mili giây; bấm Dừng thì thôi chờ ngay
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) { reject(abortError()); return; }
      const onAbort = () => { clearTimeout(t); reject(abortError()); };
      const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  // Chạy fn trên mảng với tối đa `limit` tác vụ song song, giữ nguyên thứ tự kết quả
  async function pool(items, limit, fn, signal) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        if (signal.aborted) throw abortError();
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

  // Chuẩn hoá bản dịch: bỏ ký tự độ rộng 0 (Google hay chèn U+200B, làm PDF xuất ra bị hở chữ)
  const clean = (s) => String(s == null ? '' : s).normalize('NFC').replace(/[​-‏⁠﻿­]/g, '').replace(/\s+/g, ' ').trim();

  /* ---------- Che phần không cần dịch bằng mã giữ chỗ ⟦n⟧ ---------- */
  // Google, Chrome, MyMemory giữ nguyên ⟦n⟧, nên dùng để bảo vệ thuật ngữ, trích dẫn, URL và công thức.
  // (⟦ ⟧ là U+27E6/U+27E7, cố ý để ngoài dải ký hiệu toán bên dưới.)
  const MATH_CH = /[²³¹Ͱ-Ͽᴬ-ᵪ′-‷⁰-₟←-⇿∀-⋿⌀-⏿⟀-⟥⟨-⟯⦀-⫿\u{1d400}-\u{1d7ff}]|[A-Za-z0-9)\]][_^=]|[_^=][A-Za-z0-9(]/u;
  const MATH_WEAK = /^(?:[A-Za-z]|\d+(?:[.,]\d+)?|[-+=<>×·*/|:,;]+|[A-Za-z]?\(\S*\))$/;
  const PH = /⟦\s*(\d+)\s*⟧/g;

  // 2 = chắc chắn là công thức, 1 = có thể thuộc công thức (biến 1 chữ cái, số, toán tử), 0 = chữ thường
  function mathKind(tok) {
    if (!tok || /⟦/.test(tok)) return 0;
    const t = tok.replace(/[.,;:!?]+$/, '');
    if (MATH_CH.test(t)) return 2;
    const core = t.replace(/^[([{]+|[)\]}]+$/g, '');
    if (/^[aAI]$/.test(core)) return 0; // "a", "I" là từ tiếng Anh
    return !core || MATH_WEAK.test(t) || MATH_WEAK.test(core) ? 1 : 0;
  }

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // glossary: [{ src, dst }] (dst null = giữ nguyên). Trả về { text, slots, translatable }
  HV.mask = function (text, glossary) {
    const slots = [];
    const add = (val) => { slots.push(val); return '⟦' + (slots.length - 1) + '⟧'; };
    let t = text;
    // URL, email
    t = t.replace(/\b(?:https?:\/\/|www\.)[^\s]+[^\s.,;:)\]]|[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, (m) => add(m));
    // trích dẫn dạng số: [4], [4, 7], [12–15]
    t = t.replace(/\[\d+(?:\s*[,–-]\s*\d+)*\]/g, (m) => add(m));
    // thuật ngữ do người dùng nhập (dài trước, không phân biệt hoa thường, nhận cả số nhiều -s/-es)
    const terms = (glossary || []).slice().sort((a, b) => b.src.length - a.src.length);
    for (const g of terms) {
      const re = new RegExp('(?<![\\p{L}\\p{N}_⟦])' + escapeRe(g.src) + '(?:e?s)?(?![\\p{L}\\p{N}_])', 'giu');
      t = t.replace(re, (m) => add(g.dst || m));
    }
    // công thức nằm giữa câu: cụm token liền nhau có ít nhất một ký hiệu toán
    const toks = t.split(/(\s+)/);
    let res = '';
    for (let i = 0; i < toks.length;) {
      if (i % 2 || !mathKind(toks[i])) { res += toks[i++]; continue; }
      let j = i, strong = false;
      while (j < toks.length && mathKind(toks[j])) { if (mathKind(toks[j]) === 2) strong = true; j += 2; }
      const run = toks.slice(i, j - 1).join('');
      if (strong) {
        const tail = (run.match(/[.,;:!?]+$/) || [''])[0]; // dấu câu cuối cụm để ngoài
        res += add(run.slice(0, run.length - tail.length)) + tail;
      } else res += run;
      i = j - 1;
    }
    const letters = (res.replace(PH, '').match(/\p{L}/gu) || []).length;
    return { text: res, slots, translatable: letters >= 3 };
  };

  // Trả mã giữ chỗ về nội dung cũ. ok = false nếu engine làm mất hoặc nhân đôi mã
  HV.unmask = function (out, slots) {
    const seen = new Set();
    let dup = false;
    const text = out.replace(PH, (m, d) => {
      const s = slots[+d];
      if (s === undefined) return m;
      if (seen.has(+d)) dup = true;
      seen.add(+d);
      return s;
    });
    return { text, ok: !dup && seen.size === slots.length && !/[⟦⟧]/.test(text) };
  };

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
    if (!res.ok) {
      const e = new Error('Google trả về HTTP ' + res.status);
      const ra = Number(res.headers.get('Retry-After'));
      if (ra) e.retryAfter = ra * 1000;
      throw e;
    }
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
    if (data.quotaFinished || /MYMEMORY WARNING/i.test(t || '')) throw fatal('MyMemory đã hết hạn mức trong ngày');
    if (Number(data.responseStatus) !== 200 || !t) throw new Error('MyMemory lỗi: ' + (data.responseDetails || data.responseStatus));
    return t;
  }

  /* ---------- Translator tích hợp trong Chrome ---------- */
  const chromeCache = new Map();
  const fatal = (msg) => Object.assign(new Error(msg), { fatal: true }); // lỗi không đáng thử lại

  // Chrome chỉ cho tải gói ngôn ngữ khi có thao tác người dùng, nên hàm này phải được gọi
  // ngay trong lúc xử lý cú bấm nút (trước các bước chờ khác). Sau khi tạo xong, bộ dịch được giữ lại để dùng tiếp.
  async function chromeTranslator(src, onProgress) {
    if (!('Translator' in self)) throw fatal('Trình duyệt không hỗ trợ Translator API (cần Chrome 138 trở lên, bản máy tính)');
    const sourceLanguage = src === 'auto' ? 'en' : src;
    if (chromeCache.has(sourceLanguage)) return chromeCache.get(sourceLanguage);
    const opts = { sourceLanguage, targetLanguage: TARGET };
    const av = await Translator.availability(opts);
    if (av === 'unavailable') throw fatal('Chrome chưa hỗ trợ cặp ngôn ngữ ' + sourceLanguage + ' → vi');
    try {
      const t = await Translator.create(Object.assign({}, opts, {
        monitor(m) { m.addEventListener('downloadprogress', (e) => onProgress && onProgress(e.loaded)); },
      }));
      chromeCache.set(sourceLanguage, t);
      return t;
    } catch (e) {
      if (e && e.name === 'NotAllowedError') throw fatal('Chrome cần bạn bấm nút "Dịch" để tải gói ngôn ngữ (' + av + ')');
      throw e;
    }
  }
  HV.prepareChrome = chromeTranslator;

  /* ---------- Gemini (cần key miễn phí) ---------- */
  async function geminiError(res) {
    let msg = '', retry = 0;
    try {
      const j = await res.json();
      msg = (j.error && j.error.message) || '';
      for (const d of (j.error && j.error.details) || []) if (d.retryDelay) retry = parseFloat(d.retryDelay) * 1000;
    } catch (e) { /* thân lỗi không phải JSON */ }
    const ra = Number(res.headers.get('Retry-After'));
    if (ra) retry = ra * 1000;
    const e = new Error('Gemini trả về HTTP ' + res.status + (msg ? ': ' + msg.slice(0, 160) : ''));
    // key sai, không có quyền, model không tồn tại: thử lại cũng vô ích
    if (res.status === 401 || res.status === 403 || res.status === 404 || (res.status === 400 && /api key/i.test(msg))) e.fatal = true;
    if (retry) e.retryAfter = retry;
    return e;
  }

  async function geminiCall(g, st, signal, opts) {
    const gl = (opts.glossary || []).map((x) => '- ' + x.src + ' → ' + (x.dst || x.src + ' (giữ nguyên)')).join('\n');
    const prompt =
      'Bạn là dịch giả học thuật. Dịch từng đoạn trong mảng JSON sau sang tiếng Việt, văn phong khoa học, tự nhiên, ' +
      'giữ nguyên thuật ngữ chuyên ngành thông dụng, tên riêng, công thức, ký hiệu, trích dẫn và số liệu.' +
      (opts.context ? '\nNgữ cảnh - bài báo đang dịch:\n' + opts.context : '') +
      (gl ? '\nBảng thuật ngữ bắt buộc dùng:\n' + gl : '') +
      '\nChỉ trả về một mảng JSON các chuỗi, đúng số phần tử và đúng thứ tự.\n' + JSON.stringify(g);
    const res = await fetch(GEMINI + 'models/' + encodeURIComponent(st.geminiModel) + ':generateContent', {
      method: 'POST',
      // key để trong header thay vì URL để không lọt vào lịch sử/nhật ký
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': st.geminiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
      }),
      signal,
    });
    if (!res.ok) throw await geminiError(res);
    const data = await res.json();
    if (data.promptFeedback && data.promptFeedback.blockReason) throw fatal('Gemini từ chối nội dung (' + data.promptFeedback.blockReason + ')');
    const c = data.candidates && data.candidates[0];
    const why = (c && c.finishReason) || '';
    const raw = c && c.content && Array.isArray(c.content.parts) ? c.content.parts.filter((p) => !p.thought).map((p) => p.text || '').join('') : '';
    if (!raw) {
      throw Object.assign(new Error('Gemini không trả về nội dung' + (why ? ' (' + why + ')' : '')), {
        split: why === 'MAX_TOKENS',
        fatal: /SAFETY|RECITATION|PROHIBITED|BLOCKLIST|SPII/.test(why),
      });
    }
    let arr;
    try { arr = JSON.parse(raw.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '')); }
    catch (e) { throw Object.assign(new Error('Gemini trả về JSON lỗi' + (why === 'MAX_TOKENS' ? ' (hết token)' : '')), { split: true }); }
    if (!Array.isArray(arr) || arr.length !== g.length) throw Object.assign(new Error('Gemini trả về sai số đoạn'), { split: true });
    return arr.map((x) => String(x == null ? '' : x));
  }

  async function geminiBatch(texts, st, signal, opts) {
    const groups = [];
    let group = [], size = 0;
    for (const t of texts) {
      if (group.length && size + t.length > 7000) { groups.push(group); group = []; size = 0; }
      group.push(t); size += t.length;
    }
    if (group.length) groups.push(group);
    // nhóm trả về hỏng (thiếu đoạn, JSON cụt) thì chia đôi rồi gửi lại
    const runGroup = async (g) => {
      try { return await geminiCall(g, st, signal, opts || {}); }
      catch (e) {
        if (!e.split || g.length < 2 || signal.aborted) throw e;
        const h = Math.ceil(g.length / 2);
        return (await runGroup(g.slice(0, h))).concat(await runGroup(g.slice(h)));
      }
    };
    const out = [];
    for (const g of groups) out.push(...await runGroup(g));
    return out;
  }

  // Danh sách model Gemini dùng được với key này (cho ô chọn model trong Cài đặt)
  HV.geminiModels = async function (key) {
    const res = await fetch(GEMINI + 'models?pageSize=200', { headers: { 'x-goog-api-key': key } });
    if (!res.ok) throw await geminiError(res);
    const data = await res.json();
    return (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent') && /gemini/i.test(m.name))
      .map((m) => m.name.replace(/^models\//, ''));
  };

  /* ---------- Danh sách engine ---------- */
  HV.engines = {
    google: {
      label: 'Google Translate',
      available: () => true,
      batch: (texts, st, signal) => googleBatch(texts, st.src, signal),
    },
    chrome: {
      label: 'Chrome (trên máy)',
      // chỉ dùng được khi đã tạo sẵn bộ dịch lúc bấm nút (xem HV.prepareChrome)
      available: () => 'Translator' in self && chromeCache.size > 0,
      batch: async (texts, st, signal) => {
        const tr = await chromeTranslator(st.src);
        const out = [];
        for (const t of texts) {
          if (signal.aborted) throw abortError();
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
      llm: true, // tự hiểu bảng thuật ngữ và ngữ cảnh, không cần che mã giữ chỗ
    },
  };

  /* ---------- Bộ dịch: bộ nhớ dịch, che mã giữ chỗ, thử lại và tự chuyển engine ---------- */
  // opts: { glossary: [{ src, dst }], context: 'tiêu đề + tóm tắt bài', fallback: true }
  HV.Translator = class {
    constructor(settings, onSwitch, opts) {
      this.st = settings;
      this.onSwitch = onSwitch || (() => {});
      this.opts = opts || {};
      const rest = ['google', 'chrome', 'mymemory'].filter((e) => e !== settings.engine);
      this.order = this.opts.fallback === false ? [settings.engine] : [settings.engine, ...rest];
      this.cur = 0;
      // bảng thuật ngữ đổi thì bản dịch cũ trong bộ nhớ dịch không còn đúng
      this.gsig = (this.opts.glossary || []).length ? HV.hash(JSON.stringify(this.opts.glossary)) : '';
    }
    get name() { return this.order[this.cur]; }
    get label() { return HV.engines[this.name].label; }
    tmKey(name) { return name + '|' + this.gsig + (name === 'gemini' ? '|' + this.st.geminiModel : ''); }

    // Dịch mảng văn bản. opts.fresh: bỏ qua bộ nhớ dịch (dịch lại thật).
    // Trả về { out: [bản dịch], eng: [engine đã dịch từng đoạn] }
    async translate(texts, signal, opts) {
      opts = opts || {};
      const out = new Array(texts.length).fill(null), eng = new Array(texts.length).fill(null);
      const hs = texts.map((t) => HV.hash(t));
      if (!opts.fresh && texts.length) {
        const key = this.tmKey(this.name);
        (await HV.store.tmGet(hs)).forEach((v, i) => { if (v && typeof v[key] === 'string') { out[i] = v[key]; eng[i] = this.name; } });
      }
      const miss = [];
      out.forEach((v, i) => { if (v === null) miss.push(i); });
      if (miss.length) {
        const res = await this.run(miss.map((i) => texts[i]), signal);
        miss.forEach((i, j) => { out[i] = res.out[j]; eng[i] = res.name; });
        await HV.store.tmPut(miss.map((i) => ({ h: hs[i], k: this.tmKey(res.name), t: out[i] })));
      }
      return { out, eng };
    }

    // Gọi engine hiện tại, có thử lại; lỗi mãi thì chuyển engine kế tiếp
    async run(texts, signal) {
      for (;;) {
        const name = this.name;
        let lastErr;
        if (HV.engines[name].available(this.st)) {
          for (let attempt = 0; attempt < 3; attempt++) {
            try { return { out: await this.call(name, texts, signal), name }; }
            catch (e) {
              if (e.name === 'AbortError' || signal.aborted) throw e;
              lastErr = e;
              if (e.fatal) break;
              if (attempt < 2) {
                const wait = e.retryAfter ? Math.min(e.retryAfter, 60000) : [2000, 8000][attempt] * (0.8 + Math.random() * 0.4);
                await sleep(wait, signal);
              }
            }
          }
        } else {
          lastErr = new Error('Engine chưa sẵn sàng');
        }
        let moved = false;
        while (this.cur + 1 < this.order.length) {
          this.cur++;
          if (HV.engines[this.name].available(this.st)) { moved = true; break; }
        }
        if (!moved) throw lastErr;
        this.onSwitch(this.label, lastErr);
      }
    }

    async call(name, texts, signal) {
      const eng = HV.engines[name];
      if (eng.llm) return (await eng.batch(texts, this.st, signal, this.opts)).map(clean);
      const masked = texts.map((t) => HV.mask(t, this.opts.glossary));
      const out = masked.map((m) => HV.unmask(m.text, m.slots).text); // đoạn chỉ toàn mã giữ chỗ: không cần gửi
      const at = [];
      masked.forEach((m, i) => { if (m.translatable) at.push(i); });
      const res = at.length ? await eng.batch(at.map((i) => masked[i].text), this.st, signal) : [];
      const redo = [];
      at.forEach((i, j) => {
        const u = HV.unmask(String(res[j] == null ? '' : res[j]), masked[i].slots);
        if (u.ok) out[i] = u.text; else redo.push(i);
      });
      // engine làm mất mã giữ chỗ: dịch lại các đoạn đó, không che
      if (redo.length) {
        const r2 = await eng.batch(redo.map((i) => texts[i]), this.st, signal);
        redo.forEach((i, j) => { out[i] = r2[j]; });
      }
      return out.map(clean);
    }
  };
})(window.HV);

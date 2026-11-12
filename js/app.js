/* hiuhf1 - giao diện và luồng chính */
(function (HV) {
  const $ = (id) => document.getElementById(id);
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

  /* ---------- Cài đặt ---------- */
  const DEFAULTS = {
    engine: 'google', src: 'auto', geminiKey: '', geminiModel: 'gemini-2.5-flash', email: '',
    glossary: '', skipRefs: true, fontStyle: 'auto',
  };
  function loadSettings() {
    try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('hiuhf1.settings') || '{}')); }
    catch (e) { return Object.assign({}, DEFAULTS); }
  }
  function saveSettings() {
    try { localStorage.setItem('hiuhf1.settings', JSON.stringify(settings)); } catch (e) { /* bỏ qua */ }
  }
  const settings = loadSettings();
  HV.prefs.fontStyle = settings.fontStyle;

  const engineSettings = () => ({
    engine: settings.engine, src: settings.src, geminiKey: settings.geminiKey,
    geminiModel: settings.geminiModel || DEFAULTS.geminiModel, email: settings.email,
  });

  // "attention = cơ chế chú ý" -> { src: 'attention', dst: 'cơ chế chú ý' }; chỉ có từ gốc thì giữ nguyên
  function parseGlossary(text) {
    return String(text || '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => {
      const m = l.split(/\s*(?:=>|→|=)\s*/);
      return { src: m[0], dst: m.length > 1 && m.slice(1).join(' ').trim() ? m.slice(1).join(' ').trim() : null };
    }).filter((g) => g.src.length >= 2);
  }

  /* ---------- Trạng thái ---------- */
  const state = {
    doc: null,          // xem newDoc()
    mode: 'split',
    zoom: 1,
    pageW: 600,
    running: false,
    abort: null,
  };
  const views = { orig: [], trans: [] };
  const scrolls = { orig: $('scrollOrig'), trans: $('scrollTrans') };
  const hosts = { orig: $('pagesOrig'), trans: $('pagesTrans') };
  const narrow = () => innerWidth < 700;

  /* ---------- Tiện ích UI ---------- */
  function toast(msg, type, ms) {
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), ms || 4500);
  }
  function setProgress(done, total, extra) {
    $('progress').hidden = false;
    $('bar').style.width = (total ? (done / total) * 100 : 0) + '%';
    $('ptext').textContent = 'Đã dịch ' + done + '/' + total + ' trang' + (extra ? ' · ' + extra : '');
  }
  function fmtSize(b) {
    if (!b) return '0 KB';
    return b < 1048576 ? Math.max(1, Math.round(b / 1024)) + ' KB' : (b / 1048576).toLocaleString('vi-VN', { maximumFractionDigits: 1 }) + ' MB';
  }
  function closeMenus() { document.querySelectorAll('.menu-list').forEach((m) => { m.hidden = true; }); }
  function toggleMenu(id) {
    const m = $(id), show = m.hidden;
    closeMenus();
    m.hidden = !show;
    return show;
  }
  document.addEventListener('click', closeMenus);

  /* ---------- Trạng thái dịch của trang ---------- */
  const needs = (b) => b.translatable && !b.skip;
  function hasTrans(doc, i) { const tr = doc.trans[i]; return !!tr && tr.some((t) => t); }
  function pageDone(doc, i) {
    const bl = doc.blocks[i], tr = doc.trans[i];
    if (!bl || !tr) return false;
    if (doc.scanned && doc.noText[i]) return false; // trang ảnh chưa nhận dạng chữ
    return bl.every((b, k) => !needs(b) || tr[k] != null);
  }
  function countDone(doc) { let c = 0; for (let i = 0; i < doc.n; i++) if (pageDone(doc, i)) c++; return c; }
  // số trang và số ký tự còn phải dịch (để ước lượng hạn mức)
  function remaining(doc) {
    let pages = 0, chars = 0;
    for (let i = 0; i < doc.n; i++) {
      const bl = doc.blocks[i], tr = doc.trans[i];
      if (!bl || !tr || pageDone(doc, i)) continue;
      pages++;
      bl.forEach((b, k) => { if (needs(b) && tr[k] == null) chars += b.text.length; });
    }
    return { pages, chars };
  }

  /* ---------- Giao diện sáng/tối ---------- */
  function applyTheme(t) { document.documentElement.dataset.theme = t; try { localStorage.setItem('hiuhf1.theme', t); } catch (e) { /* bỏ qua */ } }
  (function initTheme() {
    let t = null;
    try { t = localStorage.getItem('hiuhf1.theme'); } catch (e) { /* bỏ qua */ }
    if (!t) t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    applyTheme(t);
  })();
  // trang PDF luôn nền trắng nên không cần vẽ lại khi đổi giao diện
  $('btnTheme').onclick = () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');

  /* ---------- Mở file ---------- */
  const drop = $('drop'), fileInput = $('fileInput');
  fileInput.onchange = () => fileInput.files[0] && openFile(fileInput.files[0]);
  ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || e.target === document.documentElement) drop.classList.remove('over'); }));
  document.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (f) openFile(f);
  });
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
  $('btnNew').onclick = () => {
    stopTranslate(); resetViewer();
    $('hero').hidden = false; $('viewer').hidden = true; $('tools').hidden = true; $('btnNew').hidden = true; $('progress').hidden = true;
    fileInput.value = '';
    renderRecent();
  };

  async function openFile(file) {
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { toast('Vui lòng chọn file PDF.', 'err'); return; }
    let bytes;
    try { bytes = await file.arrayBuffer(); } catch (e) { toast('Không đọc được file: ' + (e.message || e), 'err'); return; }
    openBytes(bytes, { name: file.name, size: file.size, lm: file.lastModified });
  }

  function newDoc(id, info, bytes, pdf) {
    const n = pdf.numPages, arr = (v) => new Array(n).fill(v);
    const doc = {
      id, name: info.name, bytes, pdf, n,
      // khoá lưu của phiên bản cũ (theo tên/kích thước/ngày sửa), để chuyển bản dịch cũ sang
      legacyKey: info.lm ? 'v4|' + info.name + '|' + info.size + '|' + info.lm : null,
      sizes: [], views: [],
      blocks: arr(null), blockP: arr(null), bver: arr(0),   // khối chữ của trang (có nhớ) và phiên bản
      trans: arr(null), eng: arr(null), tver: arr(0),       // bản dịch theo khối, engine đã dịch, phiên bản
      noText: arr(false), ocr: arr(false), anaP: arr(null), overflow: arr(null),
      scanned: false, ocrOk: false, loaded: false, ready: null, context: '', meta: null,
    };
    doc.getBlocks = (i) => getBlocks(doc, i);
    doc.analyze = (i) => analyze(doc, i);
    doc.hasTrans = (i) => hasTrans(doc, i);
    doc.getPage = (i) => pdf.getPage(i + 1);
    return doc;
  }

  async function openBytes(bytes, info) {
    stopTranslate();
    resetViewer();
    try {
      const id = 'f|' + HV.hashBytes(bytes); // nhận diện theo nội dung: tải lại cùng file vẫn khớp bản dịch cũ
      // isEvalSupported: false - chặn lỗ hổng CVE-2024-4367 (PDF độc hại chạy được JavaScript qua font)
      const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(bytes.slice(0)), isEvalSupported: false }).promise;
      const doc = newDoc(id, info, bytes, pdf);
      for (let i = 0; i < doc.n; i++) {
        const pg = await pdf.getPage(i + 1);
        const vp = pg.getViewport({ scale: 1 });
        doc.sizes.push({ w: vp.width, h: vp.height });
        doc.views.push(pg.view);
      }
      state.doc = doc;
      $('hero').hidden = true; $('viewer').hidden = false; $('tools').hidden = false; $('btnNew').hidden = false;
      $('pageTotal').textContent = doc.n; $('pageInput').max = doc.n; $('pageInput').value = 1;
      if (narrow() && state.mode === 'split') setMode('orig', true);
      buildPages();
      loadAll(doc); // gán doc.ready ngay, trước mọi bước chờ khác (bấm Dịch sớm vẫn chờ đúng)
      updateTranslateButton();
      $('progress').hidden = true;

      // lưu file vào trình duyệt để mở lại từ danh sách
      const meta = Object.assign((await HV.store.getDoc(id)) || { id, added: Date.now() },
        { name: info.name, size: bytes.byteLength, n: doc.n, opened: Date.now(), lm: info.lm || null });
      doc.meta = meta;
      HV.store.putDoc(meta);
      HV.store.putFile(id, bytes);
      HV.store.persist();
      saveMeta(doc);
    } catch (e) {
      console.error(e);
      toast('Không mở được PDF: ' + (e.message || e), 'err', 7000);
    }
  }

  // Đọc chữ của mọi trang ở chế độ nền và ghép bản dịch đã lưu
  async function loadAll(doc) {
    let restored = 0;
    doc.ready = (async () => {
      for (let i = 0; i < doc.n; i++) {
        if (state.doc !== doc) return;
        try { await getBlocks(doc, i); }
        catch (e) { console.error(e); doc.blocks[i] = []; } // trang lỗi coi như không có chữ
        if (await restorePage(doc, i)) restored++;
        if (i % 4 === 3) { updatePageStatus(); updateTranslateButton(); }
      }
      const nt = doc.noText.filter(Boolean).length;
      doc.scanned = nt > 0 && nt >= doc.n * 0.5;
      computeSkips(doc);
      doc.context = docContext(doc);
      doc.loaded = true;
    })();
    await doc.ready;
    if (state.doc !== doc) return;
    updatePageStatus();
    updateTranslateButton();
    if (restored) {
      setProgress(countDone(doc), doc.n);
      toast('Đã khôi phục bản dịch của ' + restored + ' trang từ lần trước.', 'ok');
      if (narrow() && state.mode === 'orig') setMode('trans');
    }
    if (doc.scanned) toast('PDF này là bản scan (ảnh), chưa có chữ. Bấm Dịch để nhận dạng chữ (OCR) rồi dịch.', null, 9000);
    saveMeta(doc);
  }

  function resetViewer() {
    state.doc = null;
    clearHover();
    clearSearch();
    views.orig = []; views.trans = [];
    hosts.orig.innerHTML = ''; hosts.trans.innerHTML = '';
    scrolls.orig.scrollTop = scrolls.trans.scrollTop = 0;
    observers.forEach((o) => o.disconnect()); observers.length = 0;
  }

  /* ---------- Khối chữ, bản dịch đã lưu ---------- */
  function getBlocks(doc, i) {
    if (doc.blocks[i]) return Promise.resolve(doc.blocks[i]);
    if (!doc.blockP[i]) {
      doc.blockP[i] = (async () => {
        const page = await doc.pdf.getPage(i + 1);
        const items = await HV.pageItems(page);
        let raw = null, ocr = false;
        if (!items.length) {
          // trang không có chữ: dùng chữ đã nhận dạng (OCR) nếu có
          const saved = await HV.store.getOcr(doc.id, i);
          if (saved && Array.isArray(saved.paras)) { raw = HV.ocrBlocks(saved.paras, page.view); ocr = true; }
          else doc.noText[i] = true;
        }
        const blocks = HV.markHeadings(raw || HV.buildBlocks(items, page.view));
        blocks.forEach((b) => { b.h = HV.hash(b.text); });
        doc.ocr[i] = ocr;
        doc.blocks[i] = blocks;
        return blocks;
      })().catch((e) => { doc.blockP[i] = null; throw e; });
    }
    return doc.blockP[i];
  }

  // Ghép bản dịch đã lưu vào khối theo hash văn bản gốc, nên đổi cách tách đoạn vẫn giữ được các đoạn không đổi
  async function restorePage(doc, i) {
    const blocks = doc.blocks[i];
    const tr = new Array(blocks.length).fill(null), en = new Array(blocks.length).fill(null);
    let saved = await HV.store.getPage(doc.id, i);
    if (!saved && doc.legacyKey) saved = await migrateLegacy(doc, i, blocks);
    let found = 0;
    if (saved && Array.isArray(saved.items)) {
      const map = new Map(saved.items.map((it) => [it.h, it]));
      blocks.forEach((b, k) => {
        const it = map.get(b.h);
        if (it) { tr[k] = it.t; en[k] = it.e || ''; found++; }
      });
    }
    doc.trans[i] = tr; doc.eng[i] = en;
    if (found) {
      doc.tver[i]++;
      if (state.doc === doc && views.trans[i] && views.trans[i].rendered) renderPage('trans', i, true);
    }
    return found > 0;
  }

  // Bản dịch của phiên bản cũ lưu theo chỉ số khối; cách tách đoạn chưa đổi nên chỉ số vẫn khớp
  async function migrateLegacy(doc, i, blocks) {
    const key = doc.legacyKey + '|' + i;
    const old = await HV.store.legacyGet(key);
    if (!old || !Array.isArray(old.texts) || old.texts.length !== blocks.length) return null;
    const items = [];
    old.texts.forEach((t, k) => { if (t != null) items.push({ h: blocks[k].h, t, e: old.engine || '' }); });
    const v = { items };
    await HV.store.putPage(doc.id, i, v);
    await HV.store.legacyDelete(key);
    return v;
  }

  async function savePage(doc, i) {
    const blocks = doc.blocks[i], tr = doc.trans[i], en = doc.eng[i];
    const items = [];
    blocks.forEach((b, k) => { if (tr[k] != null) items.push({ h: b.h, t: tr[k], e: en[k] || '' }); });
    await HV.store.putPage(doc.id, i, { items });
  }
  function saveMeta(doc) {
    if (!doc.meta || !doc.loaded) return;
    doc.meta.done = countDone(doc);
    HV.store.putDoc(doc.meta);
  }

  // Phân tích màu nền/màu chữ/khoảng trống của trang (một lần cho mỗi trang)
  function analyze(doc, i) {
    if (!doc.anaP[i]) {
      doc.anaP[i] = (async () => {
        const blocks = await getBlocks(doc, i);
        const page = await doc.pdf.getPage(i + 1);
        await HV.analyzePage(page, blocks);
      })().catch((e) => console.error(e)); // lỗi thì dùng mặc định: nền trắng, chữ đen
    }
    return doc.anaP[i];
  }

  /* ---------- Phần Tài liệu tham khảo và ngữ cảnh bài ---------- */
  const REF_RE = /^(?:[\dIVX]{1,4}\.?\s+)?(?:references|bibliography|works cited|literature cited|reference list|tài liệu tham khảo)\.?$/i;
  const isAppendix = (t) => /^(?:appendix|appendices|supplementary|supplemental)\b/i.test(t) || /^[A-Z](?:\.\d{1,2})*\.?\s+\p{Lu}/u.test(t);

  // Đánh dấu b.skip cho các khối sau tiêu đề "References" (tới phụ lục nếu có), theo thứ tự đọc
  function computeSkips(doc) {
    let skipping = false;
    for (let i = 0; i < doc.n; i++) {
      const blocks = doc.blocks[i];
      if (!blocks) continue;
      for (const k of HV.readingOrder(blocks, doc.views[i])) {
        const b = blocks[k], t = b.text.trim();
        if (b.nlines <= 2 && REF_RE.test(t)) { skipping = true; b.skip = false; continue; }
        if (skipping && b.heading && b.nlines <= 2 && isAppendix(t)) skipping = false;
        b.skip = skipping && settings.skipRefs;
      }
    }
  }

  // Tiêu đề và tóm tắt của bài, gửi kèm cho Gemini để dịch thuật ngữ nhất quán
  function docContext(doc) {
    const b0 = doc.blocks[0] || [];
    if (!b0.length) return '';
    const title = b0.filter((b) => b.translatable).sort((a, b) => b.size - a.size)[0];
    let abs = b0.find((b) => /^abstract\b/i.test(b.text) && b.text.length > 80);
    if (!abs) {
      const order = HV.readingOrder(b0, doc.views[0]);
      const at = order.findIndex((k) => /^abstract\.?$/i.test(b0[k].text.trim()));
      if (at >= 0 && at + 1 < order.length) abs = b0[order[at + 1]];
    }
    return [title && 'Tiêu đề: ' + title.text, abs && 'Tóm tắt: ' + abs.text.slice(0, 1200)].filter(Boolean).join('\n');
  }

  /* ---------- Dựng khung trang ---------- */
  const observers = [];
  function buildPages() {
    const doc = state.doc;
    ['orig', 'trans'].forEach((kind) => {
      const host = hosts[kind];
      host.innerHTML = '';
      views[kind] = [];
      for (let i = 0; i < doc.n; i++) {
        const el = document.createElement('div');
        el.className = 'page';
        el.dataset.i = i;
        el.innerHTML = '<span class="num">Trang ' + (i + 1) + '</span>';
        host.appendChild(el);
        views[kind].push({ el, token: 0, task: null, rendered: false, key: '' });
      }
      const obs = new IntersectionObserver((entries) => {
        for (const en of entries) {
          const i = Number(en.target.dataset.i);
          if (en.isIntersecting) renderPage(kind, i);
          else releasePage(kind, i);
        }
      }, { root: scrolls[kind], rootMargin: '1400px 0px' });
      views[kind].forEach((v) => obs.observe(v.el));
      observers.push(obs);
    });
    layoutPages();
    updatePageStatus();
  }

  function layoutPages() {
    if (!state.doc) return;
    clearHover();
    const host = state.mode === 'trans' ? scrolls.trans : scrolls.orig;
    const avail = Math.max(200, host.clientWidth - 34);
    state.pageW = Math.round(avail * state.zoom);
    $('zoomLabel').textContent = Math.round(state.zoom * 100) + '%';
    for (const kind of ['orig', 'trans']) {
      views[kind].forEach((v, i) => {
        const s = state.doc.sizes[i];
        v.el.style.width = state.pageW + 'px';
        v.el.style.height = Math.round(state.pageW * (s.h / s.w)) + 'px';
      });
    }
    refreshAllVisible();
  }

  function refreshAllVisible() {
    ['orig', 'trans'].forEach((kind) => views[kind].forEach((v, i) => { if (v.rendered) renderPage(kind, i, true); }));
  }

  function releasePage(kind, i) {
    const v = views[kind][i];
    if (!v) return;
    v.token++;
    if (v.task) { try { v.task.cancel(); } catch (e) { /* bỏ qua */ } v.task = null; }
    v.el.querySelectorAll('canvas, .textLayer, .tlayer').forEach((c) => c.remove());
    v.rendered = false; v.key = '';
  }

  async function renderPage(kind, i, force) {
    const doc = state.doc;
    const v = views[kind][i];
    if (!doc || !v) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const withTr = kind === 'trans' && hasTrans(doc, i);
    const key = [state.pageW, dpr, kind === 'trans' ? doc.tver[i] : doc.bver[i], withTr ? 1 : 0, HV.prefs.fontStyle].join('|');
    if (v.rendered && v.key === key && !force) return;
    const token = ++v.token;
    if (v.task) { try { v.task.cancel(); } catch (e) { /* bỏ qua */ } v.task = null; }
    try {
      await getBlocks(doc, i).catch(() => null); // cần sẵn cho rê chuột và lớp chữ; lỗi vẫn vẽ trang
      const page = await doc.pdf.getPage(i + 1);
      if (token !== v.token) return;
      const base = page.getViewport({ scale: 1 });
      const cssScale = state.pageW / base.width;
      const vp = page.getViewport({ scale: cssScale * dpr });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
      canvas.style.width = state.pageW + 'px';
      canvas.style.height = Math.round(vp.height / dpr) + 'px';
      const ctx = canvas.getContext('2d');
      v.task = page.render({ canvasContext: ctx, viewport: vp });
      await v.task.promise;
      v.task = null;
      if (token !== v.token) return;
      let lays = null;
      if (withTr) {
        await analyze(doc, i);
        if (token !== v.token) return;
        lays = await drawTranslation(ctx, doc, i, cssScale * dpr);
      }
      if (token !== v.token) return;
      // lớp chữ trong suốt phủ trên ảnh trang: bôi đen, copy được
      const layer = kind === 'orig' && !doc.ocr[i] ? await pdfTextLayer(page, cssScale) : blockLayer(doc, i, lays, cssScale);
      if (token !== v.token) return;
      v.el.querySelectorAll('canvas, .textLayer, .tlayer').forEach((c) => c.remove());
      v.el.insertBefore(canvas, v.el.firstChild);
      if (layer) canvas.after(layer);
      v.rendered = true; v.key = key;
    } catch (e) {
      if (e && e.name === 'RenderingCancelledException') return;
      console.error(e);
    }
  }

  const css = (c, d) => { const v = c || d; return 'rgb(' + v[0] + ',' + v[1] + ',' + v[2] + ')'; };

  // Vẽ bản dịch lên ảnh trang. Trả về Map(chỉ số khối -> cách dàn chữ) cho lớp chữ.
  async function drawTranslation(ctx, doc, i, scale) {
    try { await HV.loadFonts(); } catch (e) { toast('Không tải được font tiếng Việt: ' + e.message, 'err'); return null; }
    const blocks = await getBlocks(doc, i);
    const tr = doc.trans[i];
    const view = doc.views[i];
    const X = (x) => (x - view[0]) * scale, Y = (y) => (view[3] - y) * scale;
    const lays = new Map(), over = new Set();
    // phủ hết các khối trước rồi mới viết chữ, để chữ lấn xuống không bị khối sau phủ mất
    for (let k = 0; k < blocks.length; k++) {
      if (!tr[k]) continue;
      const r = HV.coverRect(blocks[k]);
      ctx.fillStyle = css(blocks[k].bg, [255, 255, 255]);
      ctx.fillRect(X(r.x), Y(r.y + r.h), r.w * scale, r.h * scale);
    }
    ctx.textBaseline = 'alphabetic';
    for (let k = 0; k < blocks.length; k++) {
      const b = blocks[k];
      if (!tr[k]) continue;
      const lay = HV.layoutBlock(b, tr[k], HV.canvasMeasure(b));
      ctx.fillStyle = css(b.fg, [13, 13, 20]);
      ctx.font = HV.canvasFont(b, lay.size * scale);
      for (const ln of lay.lines) ctx.fillText(ln.text, X(ln.x), Y(ln.y));
      if (lay.overflow) {
        // chữ dịch dài hơn khung: góc cam để báo, rê chuột vào xem đủ chữ
        over.add(k);
        const mx = X(b.x1) + 2 * scale, my = Y(b.top) - 2 * scale, s = 7 * scale;
        ctx.fillStyle = '#f59e0b';
        ctx.beginPath(); ctx.moveTo(mx - s, my); ctx.lineTo(mx, my); ctx.lineTo(mx, my + s); ctx.closePath(); ctx.fill();
      }
      lays.set(k, lay);
    }
    doc.overflow[i] = over;
    return lays;
  }

  // Lớp chữ của PDF.js cho bản gốc (đúng vị trí từng chữ)
  async function pdfTextLayer(page, cssScale) {
    const div = document.createElement('div');
    div.className = 'textLayer';
    div.style.setProperty('--scale-factor', cssScale);
    try {
      const tc = await page.getTextContent();
      await pdfjsLib.renderTextLayer({ textContentSource: tc, container: div, viewport: page.getViewport({ scale: cssScale }), textDivs: [] }).promise;
    } catch (e) { return null; }
    return div;
  }

  // Lớp chữ dựng từ các khối: dòng tiếng Việt đã dàn cho khối đã dịch, dòng gốc cho khối còn lại (và trang OCR)
  const lctx = document.createElement('canvas').getContext('2d');
  function blockLayer(doc, i, lays, cssScale) {
    const blocks = doc.blocks[i];
    if (!blocks || !blocks.length) return null;
    const div = document.createElement('div');
    div.className = 'tlayer';
    const view = doc.views[i];
    const X = (x) => (x - view[0]) * cssScale, Y = (y) => (view[3] - y) * cssScale;
    const span = (text, left, top, px) => {
      const s = document.createElement('span');
      s.textContent = text;
      s.style.left = left.toFixed(1) + 'px';
      s.style.top = top.toFixed(1) + 'px';
      s.style.fontSize = px.toFixed(2) + 'px';
      return s;
    };
    blocks.forEach((b, k) => {
      const box = document.createElement('div');
      const lay = lays && lays.get(k);
      if (lay) {
        const px = lay.size * cssScale;
        for (const ln of lay.lines) {
          const s = span(ln.text, X(ln.x), Y(ln.y) - 0.89 * px, px);
          s.style.fontFamily = HV.fontFamily(b);
          s.style.fontWeight = b.heading ? '700' : '400';
          box.appendChild(s);
        }
      } else {
        for (const r of b.rows || []) {
          const px = r.size * cssScale;
          const s = span(r.text, X(r.x0), Y(r.y) - 0.86 * px, px);
          lctx.font = px + 'px sans-serif';
          const w = lctx.measureText(r.text).width;
          if (w > 0) s.style.transform = 'scaleX(' + (((r.x1 - r.x0) * cssScale) / w).toFixed(4) + ')';
          box.appendChild(s);
        }
      }
      if (box.childNodes.length) div.appendChild(box);
    });
    return div;
  }

  function updatePageStatus() {
    const doc = state.doc;
    if (!doc) return;
    views.trans.forEach((v, i) => {
      const el = v.el, working = el.classList.contains('working'), loaded = !!doc.trans[i];
      const done = pageDone(doc, i);
      el.classList.toggle('pending', loaded && !done && !working);
      let txt = '';
      if (working) txt = 'Đang dịch…';
      else if (loaded && doc.scanned && doc.noText[i]) txt = 'Trang ảnh · cần OCR';
      else if (loaded && !done) txt = hasTrans(doc, i) ? 'Dịch một phần' : 'Chưa dịch';
      let badge = el.querySelector('.badge');
      if (txt) {
        if (!badge) { badge = document.createElement('span'); badge.className = 'badge'; el.appendChild(badge); }
        badge.textContent = txt;
      } else if (badge) badge.remove();
    });
  }
  function setWorking(i, on) {
    const el = views.trans[i] && views.trans[i].el;
    if (!el) return;
    el.classList.toggle('working', on);
    updatePageStatus();
  }

  /* ---------- Chế độ xem, thu phóng, cuộn đồng bộ ---------- */
  function setMode(mode, now) {
    const from = state.doc ? currentPage() : 0;
    state.mode = mode;
    $('viewer').dataset.mode = mode;
    [...$('viewSeg').children].forEach((c) => c.classList.toggle('on', c.dataset.mode === mode));
    if (now) return;
    requestAnimationFrame(() => { layoutPages(); gotoPage(from); });
  }
  $('viewSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (b) setMode(b.dataset.mode);
  });

  const clampZoom = (z) => Math.min(3, Math.max(0.4, z));
  function setZoom(z) {
    const from = currentPage();
    state.zoom = clampZoom(z);
    layoutPages();
    gotoPage(from);
  }
  $('zoomIn').onclick = () => setZoom(state.zoom + 0.1);
  $('zoomOut').onclick = () => setZoom(state.zoom - 0.1);
  let rt;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(layoutPages, 150); });

  // Phóng to bằng hình: co giãn tạm bằng CSS trong lúc thao tác, thả tay mới vẽ lại trang
  function previewZoom(z) {
    const r = clampZoom(z) / state.zoom;
    for (const h of Object.values(hosts)) { h.style.transformOrigin = 'top center'; h.style.transform = r === 1 ? '' : 'scale(' + r + ')'; }
    $('zoomLabel').textContent = Math.round(clampZoom(z) * 100) + '%';
  }
  function endPreviewZoom(z) {
    for (const h of Object.values(hosts)) h.style.transform = '';
    setZoom(z);
  }
  // Ctrl + cuộn chuột (và chụm hai ngón trên touchpad)
  let wheelZ = null, wheelT = 0;
  Object.values(scrolls).forEach((sc) => sc.addEventListener('wheel', (e) => {
    if (!e.ctrlKey || !state.doc) return;
    e.preventDefault();
    wheelZ = clampZoom((wheelZ == null ? state.zoom : wheelZ) * Math.exp(-e.deltaY * 0.0015));
    previewZoom(wheelZ);
    clearTimeout(wheelT);
    wheelT = setTimeout(() => { const z = wheelZ; wheelZ = null; endPreviewZoom(z); }, 160);
  }, { passive: false }));
  // chụm hai ngón trên màn hình cảm ứng
  const touchDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  Object.values(scrolls).forEach((sc) => {
    let pinch = null;
    sc.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2 && state.doc) pinch = { d: touchDist(e.touches), z: state.zoom, cur: state.zoom };
    }, { passive: true });
    sc.addEventListener('touchmove', (e) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      pinch.cur = clampZoom(pinch.z * (touchDist(e.touches) / pinch.d));
      previewZoom(pinch.cur);
    }, { passive: false });
    sc.addEventListener('touchend', (e) => {
      if (!pinch || e.touches.length >= 2) return;
      const z = pinch.cur;
      pinch = null;
      endPreviewZoom(z);
    });
  });

  function link(a, b) {
    a.addEventListener('scroll', () => {
      if (state.mode === 'split') {
        if (Math.abs(b.scrollTop - a.scrollTop) > 0.5) b.scrollTop = a.scrollTop;
        if (Math.abs(b.scrollLeft - a.scrollLeft) > 0.5) b.scrollLeft = a.scrollLeft;
      }
      updatePageInput();
    });
  }
  link(scrolls.orig, scrolls.trans);
  link(scrolls.trans, scrolls.orig);

  function activeScroll() { return state.mode === 'trans' ? scrolls.trans : scrolls.orig; }
  function activeViews() { return state.mode === 'trans' ? views.trans : views.orig; }
  function currentPage() {
    if (!state.doc) return 0;
    const top = activeScroll().scrollTop + 40, vs = activeViews();
    let cur = 0;
    for (let i = 0; i < vs.length; i++) { if (vs[i].el.offsetTop <= top) cur = i; else break; }
    return cur;
  }
  function gotoPage(i) {
    const vs = activeViews();
    if (!vs[i]) return;
    activeScroll().scrollTop = vs[i].el.offsetTop - 12;
  }
  let pinRaf = 0;
  function updatePageInput() {
    if (pinRaf || !state.doc) return;
    pinRaf = requestAnimationFrame(() => { pinRaf = 0; if (document.activeElement !== $('pageInput')) $('pageInput').value = currentPage() + 1; });
  }
  $('pageInput').addEventListener('change', () => {
    if (!state.doc) return;
    const n = Math.min(state.doc.n, Math.max(1, Number($('pageInput').value) || 1));
    gotoPage(n - 1);
  });

  /* ---------- Rê chuột / chạm: đoạn gốc <-> đoạn dịch ---------- */
  const tip = $('tip');
  const hl = { orig: document.createElement('div'), trans: document.createElement('div') };
  hl.orig.className = hl.trans.className = 'hl';
  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'edit-btn';
  editBtn.textContent = '✎ Sửa';
  editBtn.title = 'Sửa hoặc dịch lại đoạn này';
  let hover = null, pinned = false, lastPointer = 'mouse';

  function hitBlock(i, ev, pageEl) {
    const doc = state.doc, blocks = doc.blocks[i];
    if (!blocks) return -1;
    const r = pageEl.getBoundingClientRect();
    const s = r.width / doc.sizes[i].w, view = doc.views[i];
    const x = view[0] + (ev.clientX - r.left) / s, y = view[3] - (ev.clientY - r.top) / s;
    let best = -1, bestArea = Infinity;
    blocks.forEach((b, k) => {
      if (!b.translatable) return;
      if (x < b.x0 - 2 || x > b.x1 + 2 || y > b.top + 2 || y < b.bottom - 2) return;
      const area = (b.x1 - b.x0) * (b.top - b.bottom);
      if (area < bestArea) { best = k; bestArea = area; }
    });
    return best;
  }

  function showHover(i, k) {
    if (hover && hover.i === i && hover.k === k) return;
    hover = { i, k };
    const doc = state.doc, b = doc.blocks[i][k], view = doc.views[i], s = state.pageW / doc.sizes[i].w;
    for (const kind of ['orig', 'trans']) {
      const el = views[kind][i].el, h = hl[kind];
      if (h.parentNode !== el) el.appendChild(h);
      h.style.left = ((b.x0 - view[0]) * s - 3) + 'px';
      h.style.top = ((view[3] - b.top) * s - 3) + 'px';
      h.style.width = ((b.x1 - b.x0) * s + 6) + 'px';
      h.style.height = ((b.top - b.bottom) * s + 6) + 'px';
    }
    // nút Sửa ở góc trên bên phải đoạn, trên bản dịch
    if (state.mode !== 'orig') {
      const el = views.trans[i].el;
      if (editBtn.parentNode !== el) el.appendChild(editBtn);
      const top = (view[3] - b.top) * s - 4;
      editBtn.style.left = ((b.x1 - view[0]) * s + 3) + 'px';
      editBtn.style.top = top + 'px';
      editBtn.style.transform = top > 26 ? 'translate(-100%, -100%)' : 'translate(-100%, 0)';
    } else editBtn.remove();
  }

  function clearHover() {
    hover = null; pinned = false;
    hl.orig.remove(); hl.trans.remove(); editBtn.remove();
    hl.orig.classList.remove('flash'); hl.trans.classList.remove('flash');
    tip.hidden = true;
  }

  // Khi chỉ xem một bên, khung nổi hiện nội dung bên còn lại; chữ dịch bị tràn khung thì hiện đủ
  function updateTip(i, k, e) {
    const doc = state.doc, b = doc.blocks[i][k];
    const tr = doc.trans[i] && doc.trans[i][k];
    const over = tr && doc.overflow[i] && doc.overflow[i].has(k);
    let text = '';
    if (state.mode === 'orig') text = tr || '';
    else if (state.mode === 'trans') text = b.text + (over ? '\n\nBản dịch đầy đủ (dài hơn khung):\n' + tr : '');
    else if (over) text = 'Bản dịch đầy đủ (dài hơn khung):\n' + tr;
    if (!text) { tip.hidden = true; return; }
    tip.textContent = text;
    tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.max(8, Math.min(e.clientX + 16, innerWidth - w - 12)) + 'px';
    tip.style.top = (e.clientY + 20 + h > innerHeight - 8 ? Math.max(8, e.clientY - h - 14) : e.clientY + 20) + 'px';
  }

  Object.values(hosts).forEach((host) => {
    host.addEventListener('pointerdown', (e) => { lastPointer = e.pointerType; });
    host.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse' || !state.doc) return;
      lastPointer = 'mouse';
      if (e.buttons) return; // đang bôi đen chữ
      if (e.target === editBtn) return;
      pinned = false;
      const pageEl = e.target.closest('.page');
      if (!pageEl) { clearHover(); return; }
      const i = Number(pageEl.dataset.i), k = hitBlock(i, e, pageEl);
      if (k < 0) { clearHover(); return; }
      showHover(i, k);
      updateTip(i, k, e);
    });
    // chạm (điện thoại, máy tính bảng): chạm vào đoạn để hiện đoạn tương ứng, chạm chỗ khác để tắt
    host.addEventListener('click', (e) => {
      if (lastPointer === 'mouse' || !state.doc || e.target === editBtn) return;
      const pageEl = e.target.closest('.page');
      const k = pageEl ? hitBlock(Number(pageEl.dataset.i), e, pageEl) : -1;
      if (k < 0) { clearHover(); return; }
      const i = Number(pageEl.dataset.i);
      hover = null;
      showHover(i, k);
      updateTip(i, k, e);
    });
    host.addEventListener('mouseleave', () => { if (!pinned && lastPointer === 'mouse') clearHover(); });
  });
  Object.values(scrolls).forEach((s) => s.addEventListener('scroll', () => { if (!pinned) clearHover(); else tip.hidden = true; }, { passive: true }));
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (hover) openEditor(hover.i, hover.k);
  });

  /* ---------- Tìm trong bài ---------- */
  const norm = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
  const search = { q: '', hits: [], at: -1 };
  let searchT = 0;
  function clearSearch() {
    search.q = ''; search.hits = []; search.at = -1;
    $('searchInput').value = ''; $('searchInfo').textContent = '';
  }
  function runSearch() {
    const doc = state.doc, q = norm($('searchInput').value.trim());
    search.q = q; search.hits = []; search.at = -1;
    if (doc && q.length >= 2) {
      for (let i = 0; i < doc.n; i++) {
        const bl = doc.blocks[i];
        if (!bl) continue;
        for (const k of HV.readingOrder(bl, doc.views[i])) {
          const tr = doc.trans[i] && doc.trans[i][k];
          if (norm(bl[k].text).includes(q) || (tr && norm(tr).includes(q))) search.hits.push({ i, k });
        }
      }
    }
    $('searchInfo').textContent = q.length >= 2 ? (search.hits.length ? '0/' + search.hits.length : 'không thấy') : '';
  }
  function stepSearch(dir) {
    if (!search.hits.length) return;
    const n = search.hits.length;
    search.at = (search.at + dir + n) % n;
    $('searchInfo').textContent = (search.at + 1) + '/' + n;
    const { i, k } = search.hits[search.at];
    gotoBlock(i, k);
  }
  function gotoBlock(i, k) {
    const doc = state.doc, b = doc.blocks[i][k], s = state.pageW / doc.sizes[i].w;
    const sc = activeScroll(), el = activeViews()[i].el;
    sc.scrollTop = el.offsetTop + (doc.views[i][3] - b.top) * s - sc.clientHeight / 3;
    hover = null;
    showHover(i, k);
    pinned = true; // giữ khung sáng sau khi cuộn tới
    for (const h of Object.values(hl)) { h.classList.remove('flash'); void h.offsetWidth; h.classList.add('flash'); }
  }
  $('searchInput').addEventListener('input', () => { clearTimeout(searchT); searchT = setTimeout(runSearch, 200); });
  $('searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (norm($('searchInput').value.trim()) !== search.q) runSearch();
      stepSearch(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') { clearSearch(); clearHover(); $('searchInput').blur(); }
  });

  /* ---------- Dịch ---------- */
  function updateTranslateButton() {
    const doc = state.doc;
    const done = doc && doc.loaded ? countDone(doc) : 0, n = doc ? doc.n : 0;
    const started = doc && doc.trans.some((t, i) => t && hasTrans(doc, i));
    $('btnTranslate').textContent = state.running ? 'Đang dịch…' : doc && doc.loaded && done >= n ? 'Dịch lại' : started ? 'Tiếp tục dịch' : 'Dịch';
    $('btnTranslate').disabled = state.running;
    $('btnTransMenu').disabled = state.running;
    $('btnStop').hidden = !state.running;
  }

  $('btnTranslate').onclick = () => {
    const doc = state.doc;
    if (!doc || state.running) return;
    if (doc.loaded && countDone(doc) >= doc.n) {
      if (!confirm('File đã dịch xong. Dịch lại từ đầu?')) return;
      startTranslate({ clear: true, fresh: true });
    } else startTranslate({});
  };
  $('btnStop').onclick = () => stopTranslate();
  $('btnTransMenu').onclick = (e) => {
    e.stopPropagation();
    if (!toggleMenu('transMenu')) return;
    const doc = state.doc;
    if (!doc) return;
    if (!doc.loaded) { $('transInfo').textContent = 'Đang đọc file…'; return; }
    const r = remaining(doc);
    $('transInfo').textContent = r.pages ? 'Còn ' + r.pages + ' trang, khoảng ' + r.chars.toLocaleString('vi-VN') + ' ký tự chưa dịch' : 'Đã dịch hết các trang';
  };
  $('transMenu').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tr]');
    const doc = state.doc;
    if (!b || !doc || state.running) return;
    const cur = currentPage();
    if (b.dataset.tr === 'current') startTranslate({ pages: [cur] });
    else if (b.dataset.tr === 'redo') startTranslate({ pages: [cur], clear: true, fresh: true });
    else if (b.dataset.tr === 'range') {
      const s = prompt('Nhập các trang cần dịch, ví dụ: 1-5, 8', (cur + 1) + '-' + Math.min(doc.n, cur + 5));
      if (s == null) return;
      const pages = parseRange(s, doc.n);
      if (!pages.length) { toast('Khoảng trang không hợp lệ.', 'err'); return; }
      startTranslate({ pages });
    }
  });

  // "1-5, 8" -> [0,1,2,3,4,7]
  function parseRange(s, n) {
    const set = new Set();
    for (const part of String(s).split(/[,;\s]+/)) {
      const m = part.match(/^(\d+)(?:\s*[-–]\s*(\d+))?$/);
      if (!m) continue;
      let a = +m[1], b = m[2] ? +m[2] : a;
      if (a > b) [a, b] = [b, a];
      for (let p = Math.max(1, a); p <= Math.min(n, b); p++) set.add(p - 1);
    }
    return [...set].sort((x, y) => x - y);
  }

  function stopTranslate() {
    if (state.abort) state.abort.abort();
  }

  // Trang dịch tiếp theo: trang chưa xong đầu tiên kể từ trang đang xem, hết thì quay lại đầu
  function nextPage(doc, targets, skip) {
    const cur = currentPage();
    let first = -1;
    for (const p of targets) {
      if (skip.has(p) || pageDone(doc, p)) continue;
      if (p >= cur) return p;
      if (first < 0) first = p;
    }
    return first;
  }

  const OCR_STATUS = {
    'loading tesseract core': 'đang tải bộ nhận dạng chữ',
    'initializing tesseract': 'đang khởi động bộ nhận dạng',
    'loading language traineddata': 'đang tải dữ liệu ngôn ngữ',
    'initializing api': 'đang khởi động bộ nhận dạng',
    'recognizing text': 'đang nhận dạng chữ',
  };
  async function runOcr(doc, p, signal) {
    const page = await doc.pdf.getPage(p + 1);
    const paras = await HV.ocrPage(page, HV.ocrLang(settings.src), (m) => {
      if (state.doc !== doc || !m || !m.status) return;
      $('ptext').textContent = 'Trang ' + (p + 1) + ' (OCR): ' + (OCR_STATUS[m.status] || m.status) + (m.progress ? ' ' + Math.round(m.progress * 100) + '%' : '');
    });
    if (signal.aborted) throw new DOMException('Đã dừng', 'AbortError');
    await HV.store.putOcr(doc.id, p, { paras });
    doc.blocks[p] = null; doc.blockP[p] = null; doc.anaP[p] = null; doc.noText[p] = false;
    const blocks = await getBlocks(doc, p);
    doc.trans[p] = new Array(blocks.length).fill(null);
    doc.eng[p] = new Array(blocks.length).fill(null);
    doc.bver[p]++; doc.tver[p]++;
    computeSkips(doc);
    if (p === 0) doc.context = docContext(doc);
    renderPage('orig', p, true);
  }

  // opts: { pages: [chỉ số trang] (mặc định tất cả), clear: xoá bản dịch cũ của các trang đó,
  //         fresh: bỏ qua bộ nhớ dịch, engine: dùng engine này (không tự chuyển) }
  async function startTranslate(opts) {
    const doc = state.doc;
    if (!doc || state.running) return;
    state.running = true;
    state.abort = new AbortController();
    const signal = state.abort.signal;
    const st = Object.assign(engineSettings(), opts.engine ? { engine: opts.engine } : {});
    // Chrome chỉ cho tải gói ngôn ngữ ngay sau thao tác người dùng, nên phải tạo bộ dịch trước mọi bước chờ khác
    let chromePrep = null;
    if (st.engine === 'chrome') {
      chromePrep = HV.prepareChrome(st.src, (p) => {
        $('progress').hidden = false;
        $('ptext').textContent = 'Đang tải gói ngôn ngữ của Chrome… ' + Math.round(p * 100) + '%';
      });
    }
    updateTranslateButton();
    $('progress').hidden = false;
    $('ptext').textContent = 'Đang chuẩn bị…';
    const skip = new Set();
    let skippedScan = 0;
    // các bước chuẩn bị (tải font, đọc file) cũng phải dừng được ngay khi bấm Dừng
    const aborted = new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('Đã dừng', 'AbortError')), { once: true }));
    aborted.catch(() => {});
    const until = (p) => Promise.race([p, aborted]);
    try {
      try { await until(HV.loadFonts()); } catch (e) { if (e.name === 'AbortError') throw e; toast('Chưa tải được font tiếng Việt, xem bản dịch có thể lỗi dấu: ' + e.message, 'err'); }
      if (chromePrep) {
        try { await until(chromePrep); } catch (e) { if (e.name === 'AbortError') throw e; toast('Chrome Translator không dùng được: ' + (e.message || e) + '. Sẽ dùng engine khác.', 'err', 8000); }
      }
      if (!doc.loaded) $('ptext').textContent = 'Đang đọc chữ trong file…';
      await until(doc.ready);
      if (state.doc !== doc) return;
      const targets = opts.pages || Array.from({ length: doc.n }, (_, i) => i);
      if (opts.clear) {
        for (const p of targets) {
          doc.trans[p].fill(null); doc.eng[p].fill(null); doc.tver[p]++;
          await savePage(doc, p);
          renderPage('trans', p, true);
        }
        updatePageStatus();
      }
      // trang scan: hỏi trước khi tải bộ nhận dạng chữ (nặng)
      let useOcr = false;
      if (doc.scanned && targets.some((p) => doc.noText[p])) {
        useOcr = doc.ocrOk || confirm('PDF này là bản scan (ảnh) nên chưa có chữ để dịch.\nNhận dạng chữ (OCR) rồi dịch? Lần đầu cần tải khoảng 10–20 MB dữ liệu nhận dạng.');
        doc.ocrOk = useOcr;
      }
      if (state.mode === 'orig') setMode(narrow() ? 'trans' : 'split');
      const tr = new HV.Translator(st,
        (label, err) => toast('Chuyển sang ' + label + ' vì engine trước bị lỗi (' + (err && err.message) + ')', null, 6000),
        { glossary: parseGlossary(settings.glossary), context: doc.context, fallback: !opts.engine });

      for (;;) {
        if (signal.aborted) break;
        const p = nextPage(doc, targets, skip);
        if (p < 0) break;
        if (doc.scanned && doc.noText[p] && !useOcr) { skip.add(p); skippedScan++; continue; }
        setWorking(p, true);
        if (doc.scanned && doc.noText[p]) await until(runOcr(doc, p, signal));
        setProgress(countDone(doc), doc.n, 'đang dịch trang ' + (p + 1) + ' · ' + tr.label);
        const blocks = await getBlocks(doc, p);
        const idx = [];
        blocks.forEach((b, k) => { if (needs(b) && doc.trans[p][k] == null) idx.push(k); });
        if (idx.length) {
          const res = await tr.translate(idx.map((k) => blocks[k].text), signal, { fresh: !!opts.fresh });
          if (state.doc !== doc) return;
          idx.forEach((k, j) => { doc.trans[p][k] = res.out[j] || ''; doc.eng[p][k] = res.eng[j]; });
          doc.tver[p]++;
          await savePage(doc, p);
        }
        setWorking(p, false);
        if (!pageDone(doc, p)) skip.add(p); // phòng lặp mãi
        renderPage('trans', p, true);
        saveMeta(doc);
      }
      if (state.doc !== doc) return;
      if (signal.aborted) toast('Đã dừng. Bấm "Tiếp tục dịch" để dịch tiếp.');
      else if (skippedScan) toast('Bỏ qua ' + skippedScan + ' trang ảnh chưa nhận dạng chữ.', null, 6000);
      else toast(opts.pages ? 'Đã dịch xong ' + opts.pages.length + ' trang đã chọn.' : 'Đã dịch xong ' + doc.n + ' trang.', 'ok');
    } catch (e) {
      if (state.doc !== doc) { /* đã đóng file */ }
      else if (e.name === 'AbortError') toast('Đã dừng. Bấm "Tiếp tục dịch" để dịch tiếp.');
      else { console.error(e); toast('Dịch lỗi: ' + (e.message || e) + '. Bản dịch đã có được giữ lại, bấm "Tiếp tục dịch" để thử lại.', 'err', 9000); }
    } finally {
      state.running = false;
      state.abort = null;
      if (state.doc === doc) {
        views.trans.forEach((v) => v.el.classList.remove('working'));
        updatePageStatus();
        setProgress(countDone(doc), doc.n);
        saveMeta(doc);
      }
      updateTranslateButton();
    }
  }

  /* ---------- Sửa / dịch lại từng đoạn ---------- */
  const edlg = $('editDlg');
  let editing = null;
  function openEditor(i, k) {
    const doc = state.doc;
    if (!doc || !doc.trans[i]) return;
    editing = { doc, i, k, out: null, eng: null };
    $('editWhere').textContent = 'Trang ' + (i + 1);
    $('editOrig').textContent = doc.blocks[i][k].text;
    $('editText').value = doc.trans[i][k] || '';
    $('editEngine').value = settings.engine;
    edlg.returnValue = '';
    clearHover();
    edlg.showModal();
  }
  async function setBlock(ed, text, eng) {
    const { doc, i, k } = ed;
    if (state.doc !== doc) return;
    doc.trans[i][k] = text; doc.eng[i][k] = eng;
    doc.tver[i]++;
    await savePage(doc, i);
    renderPage('trans', i, true);
    updatePageStatus(); updateTranslateButton(); saveMeta(doc);
  }
  edlg.addEventListener('close', () => {
    const ed = editing;
    editing = null;
    if (!ed || edlg.returnValue !== 'ok') return;
    const text = $('editText').value.normalize('NFC').replace(/\s+/g, ' ').trim();
    setBlock(ed, text, ed.out !== null && text === ed.out ? ed.eng : 'manual');
  });
  $('editKeep').onclick = () => {
    const ed = editing;
    editing = null;
    edlg.close();
    if (ed) setBlock(ed, '', 'manual'); // chuỗi rỗng = đã xử lý, hiện chữ gốc
  };
  $('editRetrans').onclick = async () => {
    const ed = editing;
    if (!ed) return;
    const st = Object.assign(engineSettings(), { engine: $('editEngine').value });
    const prep = st.engine === 'chrome' ? HV.prepareChrome(st.src) : null; // phải gọi ngay trong cú bấm
    const btn = $('editRetrans');
    btn.disabled = true; btn.textContent = 'Đang dịch…';
    try {
      if (prep) await prep;
      const tr = new HV.Translator(st, null, { glossary: parseGlossary(settings.glossary), context: ed.doc.context, fallback: false });
      const res = await tr.translate([ed.doc.blocks[ed.i][ed.k].text], new AbortController().signal, { fresh: true });
      if (editing === ed) { $('editText').value = res.out[0]; ed.out = res.out[0]; ed.eng = res.eng[0]; }
    } catch (e) {
      toast('Dịch lỗi: ' + (e.message || e), 'err', 7000);
    } finally {
      btn.disabled = false; btn.textContent = 'Dịch lại đoạn này';
    }
  };
  $('editRetransPage').onclick = () => {
    const ed = editing;
    if (!ed) return;
    const engine = $('editEngine').value;
    editing = null;
    edlg.close();
    if (state.running) { toast('Đang dịch, hãy bấm Dừng trước.', 'err'); return; }
    startTranslate({ pages: [ed.i], clear: true, fresh: true, engine });
  };

  /* ---------- Tải về và nhập bản dịch ---------- */
  $('btnDownload').onclick = (e) => { e.stopPropagation(); toggleMenu('downloadMenu'); };
  $('downloadMenu').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-dl]');
    const doc = state.doc;
    if (!b || !doc) return;
    const kind = b.dataset.dl;
    if (kind === 'import') { $('jsonInput').click(); return; }
    await doc.ready;
    if (!doc.trans.some((_, i) => hasTrans(doc, i))) { toast('Chưa có trang nào được dịch.', 'err'); return; }
    const done = countDone(doc);
    if (kind !== 'json' && done < doc.n && !confirm('Mới dịch ' + done + '/' + doc.n + ' trang. Vẫn tải phần đã dịch?')) return;
    const base = doc.name.replace(/\.pdf$/i, '');
    const names = {
      docx: base + '_vi.docx', docx2: base + '_song-ngu.docx', pdf: base + '_vi.pdf',
      pdfi: base + '_song-ngu.pdf', pdfs: base + '_song-ngu-ngang.pdf', json: base + '_ban-dich.json',
    };
    const label = /^pdf/.test(kind) ? 'PDF' : /^docx/.test(kind) ? 'DOCX' : 'JSON';
    const prog = (i, n) => setProgress(done, doc.n, 'đang xuất ' + label + ' ' + i + '/' + n);
    try {
      toast('Đang tạo file ' + label + '…');
      let blob;
      if (kind === 'pdf') blob = await HV.exportPdf(doc, prog, 'replace');
      else if (kind === 'pdfi') blob = await HV.exportPdf(doc, prog, 'interleave');
      else if (kind === 'pdfs') blob = await HV.exportPdf(doc, prog, 'side');
      else if (kind === 'docx') blob = await HV.exportDocx(doc, prog, false);
      else if (kind === 'docx2') blob = await HV.exportDocx(doc, prog, true);
      else blob = await HV.exportJson(doc);
      HV.download(blob, names[kind]);
      toast('Đã tạo ' + names[kind], 'ok');
    } catch (err) {
      console.error(err);
      toast('Xuất file lỗi: ' + (err.message || err), 'err', 8000);
    } finally { if (state.doc === doc) setProgress(countDone(doc), doc.n); }
  });

  $('jsonInput').onchange = async () => {
    const f = $('jsonInput').files[0];
    $('jsonInput').value = '';
    const doc = state.doc;
    if (!f || !doc) return;
    try {
      const map = HV.parseImport(JSON.parse(await f.text()));
      await doc.ready;
      let n = 0;
      for (let i = 0; i < doc.n; i++) {
        const blocks = doc.blocks[i];
        let changed = false;
        blocks.forEach((b, k) => {
          const it = map.get(b.h);
          if (it) { doc.trans[i][k] = it.t; doc.eng[i][k] = it.e; changed = true; n++; }
        });
        if (changed) { doc.tver[i]++; await savePage(doc, i); }
      }
      refreshAllVisible(); updatePageStatus(); updateTranslateButton(); setProgress(countDone(doc), doc.n); saveMeta(doc);
      toast(n ? 'Đã nhập ' + n + ' đoạn dịch.' : 'Không có đoạn nào khớp với bài đang mở.', n ? 'ok' : 'err');
    } catch (e) {
      toast('Không đọc được file bản dịch: ' + (e.message || e), 'err', 7000);
    }
  };

  /* ---------- Hộp thoại cài đặt ---------- */
  const dlg = $('settings');
  let modelT = 0;
  function loadModels() {
    const key = $('setKey').value.trim();
    if (!key) { $('modelInfo').textContent = ''; return; }
    clearTimeout(modelT);
    modelT = setTimeout(async () => {
      try {
        const list = await HV.geminiModels(key);
        const dl = $('geminiModels');
        dl.innerHTML = '';
        list.forEach((m) => { const o = document.createElement('option'); o.value = m; dl.appendChild(o); });
        $('modelInfo').textContent = '(key dùng được, ' + list.length + ' model)';
      } catch (e) {
        $('modelInfo').textContent = '(' + (e.fatal ? 'key không dùng được' : 'chưa kiểm tra được key') + ')';
      }
    }, 400);
  }
  $('setKey').addEventListener('change', loadModels);
  $('btnSettings').onclick = () => {
    $('setEngine').value = settings.engine; $('setSrc').value = settings.src;
    $('setKey').value = settings.geminiKey; $('setModel').value = settings.geminiModel; $('setEmail').value = settings.email;
    $('setGlossary').value = settings.glossary; $('setSkipRefs').checked = settings.skipRefs; $('setFont').value = settings.fontStyle;
    $('modelInfo').textContent = '';
    if (settings.geminiKey) loadModels();
    dlg.returnValue = '';
    dlg.showModal();
  };
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'ok') return;
    const prevSkip = settings.skipRefs, prevFont = settings.fontStyle;
    settings.engine = $('setEngine').value; settings.src = $('setSrc').value;
    settings.geminiKey = $('setKey').value.trim(); settings.geminiModel = $('setModel').value.trim() || DEFAULTS.geminiModel;
    settings.email = $('setEmail').value.trim();
    settings.glossary = $('setGlossary').value.trim();
    settings.skipRefs = $('setSkipRefs').checked;
    settings.fontStyle = $('setFont').value;
    saveSettings();
    HV.prefs.fontStyle = settings.fontStyle;
    const doc = state.doc;
    if (doc && (prevSkip !== settings.skipRefs || prevFont !== settings.fontStyle)) {
      if (doc.loaded) computeSkips(doc);
      refreshAllVisible(); updatePageStatus(); updateTranslateButton();
      if (doc.loaded) { setProgress(countDone(doc), doc.n); saveMeta(doc); }
    }
    if (settings.engine === 'gemini' && !settings.geminiKey) toast('Chưa nhập Gemini API key, sẽ dùng engine dự phòng.', 'err');
    else toast('Đã lưu cài đặt.', 'ok', 2000);
  });
  $('btnClearCache').onclick = async () => {
    const doc = state.doc;
    if (!doc) { toast('Hãy mở một file PDF trước.'); return; }
    if (!confirm('Xoá toàn bộ bản dịch đã lưu của file này?')) return;
    stopTranslate();
    await doc.ready;
    await HV.store.clearPages(doc.id, doc.n);
    // xoá cả bộ nhớ dịch của các đoạn trong bài, để dịch lại ra bản mới
    await HV.store.tmDelete(doc.blocks.flatMap((bl) => (bl || []).map((b) => b.h)));
    doc.trans.forEach((t, i) => { if (t) { t.fill(null); doc.eng[i].fill(null); } doc.tver[i]++; });
    updatePageStatus(); refreshAllVisible(); updateTranslateButton(); setProgress(0, doc.n); saveMeta(doc);
    dlg.close();
    toast('Đã xoá bản dịch đã lưu.', 'ok');
  };

  /* ---------- Bài đã mở gần đây ---------- */
  async function renderRecent() {
    const [docs, tm] = await Promise.all([HV.store.listDocs(), HV.store.tmCount()]);
    $('recent').hidden = !docs.length && !tm;
    const ul = $('recentList');
    ul.innerHTML = '';
    for (const d of docs.slice(0, 30)) {
      const li = document.createElement('li');
      const main = document.createElement('div');
      main.className = 'ri-main';
      const name = document.createElement('b');
      name.textContent = d.name; name.title = d.name;
      const sm = document.createElement('small');
      sm.textContent = (d.done || 0) + '/' + (d.n || '?') + ' trang đã dịch · ' + fmtSize(d.size) + ' · ' + new Date(d.opened || d.added).toLocaleDateString('vi-VN');
      main.append(name, sm);
      const open = document.createElement('button');
      open.type = 'button'; open.className = 'btn'; open.textContent = 'Mở';
      open.onclick = () => openRecent(d);
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'icon'; del.textContent = '✕'; del.title = 'Xoá bài này khỏi trình duyệt';
      del.onclick = async () => {
        if (!confirm('Xoá "' + d.name + '" cùng bản dịch đã lưu khỏi trình duyệt?')) return;
        await HV.store.deleteDoc(d.id, d.n || 0);
        renderRecent();
      };
      li.append(main, open, del);
      ul.appendChild(li);
    }
    const usage = await HV.store.usage();
    $('storageInfo').textContent = [usage ? 'Đang dùng ' + fmtSize(usage) : '', tm ? 'bộ nhớ dịch ' + tm.toLocaleString('vi-VN') + ' đoạn' : ''].filter(Boolean).join(' · ');
  }
  async function openRecent(d) {
    const bytes = await HV.store.getFile(d.id);
    if (!bytes) { toast('Không còn file PDF trong trình duyệt, hãy mở lại file từ máy.', 'err'); return; }
    openBytes(bytes, { name: d.name, size: d.size, lm: d.lm });
  }
  $('btnClearTm').onclick = async () => {
    if (!confirm('Xoá bộ nhớ dịch? Bản dịch của các bài đã mở vẫn giữ, chỉ những đoạn trùng ở bài mới sẽ phải dịch lại.')) return;
    await HV.store.tmClear();
    renderRecent();
  };
  $('btnClearAll').onclick = async () => {
    if (!confirm('Xoá toàn bộ bài, file PDF và bản dịch đã lưu trong trình duyệt này? Không hoàn tác được.')) return;
    await HV.store.clearAll();
    renderRecent();
    toast('Đã xoá dữ liệu đã lưu.', 'ok');
  };
  renderRecent();

  /* ---------- Phím tắt ---------- */
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f' && state.doc && !$('viewer').hidden && !document.querySelector('dialog[open]')) {
      e.preventDefault();
      $('searchInput').focus();
      $('searchInput').select();
    } else if (e.key === 'Escape') {
      closeMenus();
      clearHover();
    }
  });

  // để xem trạng thái từ console khi gỡ lỗi: HV.app.state.doc
  HV.app = { state, settings };

  /* ---------- Dùng được khi mất mạng (chỉ khi chạy qua http/https) ---------- */
  // (gắn manifest bằng JS để khỏi báo lỗi khi mở bằng file://)
  if (/^https?:$/.test(location.protocol)) {
    const m = document.createElement('link');
    m.rel = 'manifest'; m.href = 'manifest.webmanifest';
    document.head.appendChild(m);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Không đăng ký được service worker', e));
  }
})(window.HV);

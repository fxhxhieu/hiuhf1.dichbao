/* hiuhf1 - giao diện và luồng chính */
(function (HV) {
  const $ = (id) => document.getElementById(id);
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  /* ---------- Cài đặt ---------- */
  const DEFAULTS = { engine: 'google', src: 'auto', geminiKey: '', geminiModel: 'gemini-2.5-flash', email: '' };
  function loadSettings() {
    try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('hiuhf1.settings') || '{}')); }
    catch (e) { return Object.assign({}, DEFAULTS); }
  }
  function saveSettings() {
    try { localStorage.setItem('hiuhf1.settings', JSON.stringify(settings)); } catch (e) { /* bỏ qua */ }
  }
  const settings = loadSettings();

  /* ---------- Trạng thái ---------- */
  const state = {
    doc: null,          // { id, name, bytes, pdf, n, sizes[], blocks[], trans[], tver[] }
    mode: 'split',
    zoom: 1,
    pageW: 600,
    running: false,
    abort: null,
  };
  const views = { orig: [], trans: [] };
  const scrolls = { orig: $('scrollOrig'), trans: $('scrollTrans') };

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
  function countDone() { return state.doc.trans.filter(Boolean).length; }

  /* ---------- Giao diện sáng/tối ---------- */
  function applyTheme(t) { document.documentElement.dataset.theme = t; try { localStorage.setItem('hiuhf1.theme', t); } catch (e) { /* bỏ qua */ } }
  (function initTheme() {
    let t = null;
    try { t = localStorage.getItem('hiuhf1.theme'); } catch (e) { /* bỏ qua */ }
    if (!t) t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    applyTheme(t);
  })();
  $('btnTheme').onclick = () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    refreshAllVisible(true);
  };

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
  $('btnNew').onclick = () => { stopTranslate(); resetViewer(); $('hero').hidden = false; $('viewer').hidden = true; $('tools').hidden = true; $('btnNew').hidden = true; $('progress').hidden = true; fileInput.value = ''; };

  async function openFile(file) {
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { toast('Vui lòng chọn file PDF.', 'err'); return; }
    stopTranslate();
    resetViewer();
    try {
      const bytes = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(bytes.slice(0)) }).promise;
      const doc = {
        id: 'v3|' + file.name + '|' + file.size + '|' + file.lastModified, // v3: đổi cách chia đoạn, bỏ bản lưu cũ
        name: file.name, bytes, pdf, n: pdf.numPages,
        sizes: [], views: [], blocks: new Array(pdf.numPages), trans: new Array(pdf.numPages).fill(null), tver: new Array(pdf.numPages).fill(0),
        getBlocks, getPage: (i) => pdf.getPage(i + 1),
      };
      for (let i = 0; i < doc.n; i++) {
        const pg = await pdf.getPage(i + 1);
        const vp = pg.getViewport({ scale: 1 });
        doc.sizes.push({ w: vp.width, h: vp.height });
        doc.views.push(pg.view);
      }
      state.doc = doc;
      let cached = 0;
      for (let i = 0; i < doc.n; i++) {
        const v = await HV.store.get(doc.id, i);
        if (v) { doc.trans[i] = v.texts; cached++; }
      }
      $('hero').hidden = true; $('viewer').hidden = false; $('tools').hidden = false; $('btnNew').hidden = false;
      $('pageTotal').textContent = doc.n; $('pageInput').max = doc.n; $('pageInput').value = 1;
      buildPages();
      updateTranslateButton();
      if (cached) { setProgress(countDone(), doc.n); toast('Đã khôi phục ' + cached + ' trang dịch từ lần trước.', 'ok'); }
      checkScanned();
    } catch (e) {
      console.error(e);
      toast('Không mở được PDF: ' + (e.message || e), 'err', 7000);
    }
  }

  async function checkScanned() {
    const doc = state.doc;
    let total = 0;
    for (let i = 0; i < Math.min(3, doc.n); i++) total += (await getBlocks(i)).length;
    if (!total) toast('PDF này có vẻ là bản scan (ảnh), chưa có chữ để dịch. Chưa hỗ trợ OCR.', 'err', 9000);
  }

  function resetViewer() {
    state.doc = null;
    views.orig = []; views.trans = [];
    $('pagesOrig').innerHTML = ''; $('pagesTrans').innerHTML = '';
    scrolls.orig.scrollTop = scrolls.trans.scrollTop = 0;
    observers.forEach((o) => o.disconnect()); observers.length = 0;
  }

  /* ---------- Khối chữ của trang (có nhớ) ---------- */
  async function getBlocks(i) {
    const doc = state.doc;
    if (!doc.blocks[i]) {
      const page = await doc.pdf.getPage(i + 1);
      doc.blocks[i] = HV.markHeadings(await HV.extractBlocks(page));
    }
    return doc.blocks[i];
  }

  /* ---------- Dựng khung trang ---------- */
  const observers = [];
  function buildPages() {
    const doc = state.doc;
    ['orig', 'trans'].forEach((kind) => {
      const host = kind === 'orig' ? $('pagesOrig') : $('pagesTrans');
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
    refreshAllVisible(true);
  }

  function refreshAllVisible(force) {
    ['orig', 'trans'].forEach((kind) => views[kind].forEach((v, i) => { if (v.rendered) renderPage(kind, i, true); }));
  }

  function releasePage(kind, i) {
    const v = views[kind][i];
    if (!v) return;
    v.token++;
    if (v.task) { try { v.task.cancel(); } catch (e) { /* bỏ qua */ } v.task = null; }
    const c = v.el.querySelector('canvas');
    if (c) c.remove();
    v.rendered = false; v.key = '';
  }

  async function renderPage(kind, i, force) {
    const doc = state.doc;
    const v = views[kind][i];
    if (!doc || !v) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const key = [state.pageW, dpr, doc.tver[i], doc.trans[i] ? 1 : 0].join('|');
    if (v.rendered && v.key === key && !force) return;
    const token = ++v.token;
    if (v.task) { try { v.task.cancel(); } catch (e) { /* bỏ qua */ } v.task = null; }
    getBlocks(i).catch(() => {}); // cần sẵn cho tính năng rê chuột
    try {
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
      if (kind === 'trans' && doc.trans[i]) await drawTranslation(ctx, i, page, cssScale * dpr);
      if (token !== v.token) return;
      const old = v.el.querySelector('canvas');
      if (old) old.remove();
      v.el.insertBefore(canvas, v.el.firstChild);
      v.rendered = true; v.key = key;
    } catch (e) {
      if (e && e.name === 'RenderingCancelledException') return;
      console.error(e);
    }
  }

  async function drawTranslation(ctx, i, page, scale) {
    const doc = state.doc;
    try { await HV.loadFonts(); } catch (e) { toast('Không tải được font tiếng Việt: ' + e.message, 'err'); return; }
    const blocks = await getBlocks(i);
    const tr = doc.trans[i];
    const view = page.view;
    const X = (x) => (x - view[0]) * scale, Y = (y) => (view[3] - y) * scale;
    const measureReg = HV.canvasMeasure(false), measureBold = HV.canvasMeasure(true);
    ctx.textBaseline = 'alphabetic';
    for (let k = 0; k < blocks.length; k++) {
      const b = blocks[k];
      if (!tr[k]) continue;
      const r = HV.coverRect(b);
      ctx.fillStyle = '#fff';
      ctx.fillRect(X(r.x), Y(r.y + r.h), r.w * scale, r.h * scale);
      const lay = HV.layoutBlock(b, tr[k], b.heading ? measureBold : measureReg);
      ctx.fillStyle = '#0d0d14';
      ctx.font = (b.heading ? '700 ' : '400 ') + (lay.size * scale) + 'px HVSans, Arial, sans-serif';
      for (const ln of lay.lines) ctx.fillText(ln.text, X(ln.x), Y(ln.y));
    }
  }

  function updatePageStatus() {
    const doc = state.doc;
    if (!doc) return;
    views.trans.forEach((v, i) => {
      const el = v.el;
      el.classList.toggle('pending', !doc.trans[i] && !el.classList.contains('working'));
      let badge = el.querySelector('.badge');
      const txt = doc.trans[i] ? '' : (el.classList.contains('working') ? 'Đang dịch…' : 'Chưa dịch');
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
  $('viewSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    const from = currentPage();
    state.mode = b.dataset.mode;
    $('viewer').dataset.mode = state.mode;
    [...$('viewSeg').children].forEach((c) => c.classList.toggle('on', c === b));
    requestAnimationFrame(() => { layoutPages(); gotoPage(from); });
  });
  const setZoom = (z) => { const from = currentPage(); state.zoom = Math.min(2.5, Math.max(0.4, z)); layoutPages(); gotoPage(from); };
  $('zoomIn').onclick = () => setZoom(state.zoom + 0.1);
  $('zoomOut').onclick = () => setZoom(state.zoom - 0.1);
  let rt;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(layoutPages, 150); });

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
    const n = Math.min(state.doc.n, Math.max(1, Number($('pageInput').value) || 1));
    gotoPage(n - 1);
  });

  /* ---------- Rê chuột: đoạn gốc <-> đoạn dịch ---------- */
  const tip = $('tip');
  const hl = { orig: document.createElement('div'), trans: document.createElement('div') };
  hl.orig.className = hl.trans.className = 'hl';
  let hover = null;

  function hitBlock(i, ev, pageEl) {
    const doc = state.doc, blocks = doc.blocks[i];
    if (!blocks) return -1;
    const r = pageEl.getBoundingClientRect();
    const s = state.pageW / doc.sizes[i].w, view = doc.views[i];
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
  }

  function clearHover() {
    hover = null;
    hl.orig.remove(); hl.trans.remove();
    tip.hidden = true;
  }

  // Khi chỉ xem một bên, hiện khung nổi chứa nội dung bên còn lại
  function updateTip(i, k, e) {
    const doc = state.doc;
    let text = '';
    if (state.mode === 'orig') text = doc.trans[i] && doc.trans[i][k];
    else if (state.mode === 'trans') text = doc.blocks[i][k].text;
    if (!text) { tip.hidden = true; return; }
    tip.textContent = text;
    tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.max(8, Math.min(e.clientX + 16, innerWidth - w - 12)) + 'px';
    tip.style.top = (e.clientY + 20 + h > innerHeight - 8 ? Math.max(8, e.clientY - h - 14) : e.clientY + 20) + 'px';
  }

  ['pagesOrig', 'pagesTrans'].forEach((id) => {
    const host = $(id);
    host.addEventListener('mousemove', (e) => {
      if (!state.doc) return;
      const pageEl = e.target.closest('.page');
      if (!pageEl) { clearHover(); return; }
      const i = Number(pageEl.dataset.i), k = hitBlock(i, e, pageEl);
      if (k < 0) { clearHover(); return; }
      showHover(i, k);
      updateTip(i, k, e);
    });
    host.addEventListener('mouseleave', clearHover);
  });
  Object.values(scrolls).forEach((s) => s.addEventListener('scroll', clearHover, { passive: true }));

  /* ---------- Dịch ---------- */
  function updateTranslateButton() {
    const done = state.doc ? countDone() : 0, n = state.doc ? state.doc.n : 0;
    $('btnTranslate').textContent = state.running ? 'Đang dịch…' : done === 0 ? 'Dịch' : done >= n ? 'Dịch lại' : 'Tiếp tục dịch';
    $('btnTranslate').disabled = state.running;
    $('btnStop').hidden = !state.running;
  }

  $('btnTranslate').onclick = async () => {
    const doc = state.doc;
    if (!doc || state.running) return;
    if (countDone() >= doc.n) {
      if (!confirm('File đã dịch xong. Dịch lại từ đầu?')) return;
      await HV.store.clear(doc.id, doc.n);
      doc.trans.fill(null);
      doc.tver.forEach((_, i) => doc.tver[i]++);
      updatePageStatus();
      refreshAllVisible(true);
    }
    startTranslate();
  };
  $('btnStop').onclick = () => stopTranslate();

  function stopTranslate() {
    if (state.abort) state.abort.abort();
  }

  async function startTranslate() {
    const doc = state.doc;
    state.running = true;
    state.abort = new AbortController();
    const signal = state.abort.signal;
    updateTranslateButton();
    const st = { engine: settings.engine, src: settings.src, geminiKey: settings.geminiKey, geminiModel: settings.geminiModel || DEFAULTS.geminiModel, email: settings.email };
    const tr = new HV.Translator(st, (label, err) => toast('Chuyển sang ' + label + ' vì engine trước bị lỗi (' + (err && err.message) + ')', null, 6000));
    // Chrome chỉ cho tải gói ngôn ngữ ngay sau thao tác người dùng, nên phải tạo bộ dịch trước mọi bước chờ khác
    let chromePrep = null;
    if (st.engine === 'chrome') {
      chromePrep = HV.prepareChrome(st.src, (p) => {
        $('progress').hidden = false;
        $('ptext').textContent = 'Đang tải gói ngôn ngữ của Chrome… ' + Math.round(p * 100) + '%';
      });
    }
    try { await HV.loadFonts(); } catch (e) { toast('Chưa tải được font tiếng Việt, xem bản dịch có thể lỗi dấu: ' + e.message, 'err'); }
    if (chromePrep) {
      try { await chromePrep; } catch (e) { toast('Chrome Translator không dùng được: ' + (e.message || e) + '. Sẽ dùng engine khác.', 'err', 8000); }
    }
    if (state.mode === 'orig') $('viewSeg').querySelector('[data-mode="split"]').click();
    try {
      for (let i = 0; i < doc.n; i++) {
        if (signal.aborted) break;
        if (doc.trans[i]) continue;
        setWorking(i, true);
        setProgress(countDone(), doc.n, 'đang dịch trang ' + (i + 1) + ' · ' + tr.label);
        const blocks = await getBlocks(i);
        const idx = [];
        blocks.forEach((b, k) => { if (b.translatable) idx.push(k); });
        const out = idx.length ? await tr.translate(idx.map((k) => blocks[k].text), signal) : [];
        const arr = new Array(blocks.length).fill(null);
        idx.forEach((k, j) => { arr[k] = String(out[j] || '').normalize('NFC').replace(/[​-‏⁠﻿­]/g, '').replace(/\s+/g, ' ').trim(); });
        doc.trans[i] = arr;
        doc.tver[i]++;
        await HV.store.put(doc.id, i, { texts: arr, engine: tr.name });
        setWorking(i, false);
        renderPage('trans', i, true);
      }
      if (!signal.aborted) toast('Đã dịch xong ' + doc.n + ' trang.', 'ok');
      else toast('Đã dừng. Bấm "Tiếp tục dịch" để dịch tiếp.');
    } catch (e) {
      if (e.name === 'AbortError') toast('Đã dừng. Bấm "Tiếp tục dịch" để dịch tiếp.');
      else { console.error(e); toast('Dịch lỗi: ' + (e.message || e) + '. Bản dịch đã có được giữ lại, bấm "Tiếp tục dịch" để thử lại.', 'err', 9000); }
    } finally {
      for (let i = 0; i < doc.n; i++) views.trans[i] && views.trans[i].el.classList.remove('working');
      state.running = false;
      state.abort = null;
      updatePageStatus();
      updateTranslateButton();
      setProgress(countDone(), doc.n);
    }
  }

  /* ---------- Tải về ---------- */
  $('btnDownload').onclick = (e) => { e.stopPropagation(); $('downloadMenu').hidden = !$('downloadMenu').hidden; };
  document.addEventListener('click', () => { $('downloadMenu').hidden = true; });
  $('downloadMenu').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-dl]');
    if (!b) return;
    const doc = state.doc;
    const done = countDone();
    if (!done) { toast('Chưa có trang nào được dịch.', 'err'); return; }
    if (done < doc.n && !confirm('Mới dịch ' + done + '/' + doc.n + ' trang. Vẫn tải phần đã dịch?')) return;
    const kind = b.dataset.dl;
    const base = doc.name.replace(/\.pdf$/i, '');
    const prog = (i, n) => setProgress(done, doc.n, 'đang xuất ' + kind.toUpperCase() + ' ' + i + '/' + n);
    try {
      toast('Đang tạo file ' + kind.toUpperCase() + '…');
      const blob = kind === 'pdf' ? await HV.exportPdf(doc, prog) : await HV.exportDocx(doc, prog);
      HV.download(blob, base + '_vi.' + kind);
      toast('Đã tạo ' + base + '_vi.' + kind, 'ok');
    } catch (err) {
      console.error(err);
      toast('Xuất file lỗi: ' + (err.message || err), 'err', 8000);
    } finally { setProgress(countDone(), doc.n); }
  });

  /* ---------- Hộp thoại cài đặt ---------- */
  const dlg = $('settings');
  $('btnSettings').onclick = () => {
    $('setEngine').value = settings.engine; $('setSrc').value = settings.src;
    $('setKey').value = settings.geminiKey; $('setModel').value = settings.geminiModel; $('setEmail').value = settings.email;
    dlg.showModal();
  };
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'ok') return;
    settings.engine = $('setEngine').value; settings.src = $('setSrc').value;
    settings.geminiKey = $('setKey').value.trim(); settings.geminiModel = $('setModel').value.trim() || DEFAULTS.geminiModel;
    settings.email = $('setEmail').value.trim();
    saveSettings();
    if (settings.engine === 'gemini' && !settings.geminiKey) toast('Chưa nhập Gemini API key, sẽ dùng engine dự phòng.', 'err');
    else toast('Đã lưu cài đặt.', 'ok', 2000);
  });
  $('btnClearCache').onclick = async () => {
    if (!state.doc) { toast('Hãy mở một file PDF trước.'); return; }
    if (!confirm('Xoá toàn bộ bản dịch đã lưu của file này?')) return;
    stopTranslate();
    await HV.store.clear(state.doc.id, state.doc.n);
    state.doc.trans.fill(null);
    state.doc.tver.forEach((_, i) => state.doc.tver[i]++);
    updatePageStatus(); refreshAllVisible(true); updateTranslateButton(); setProgress(0, state.doc.n);
    dlg.close();
    toast('Đã xoá bản dịch đã lưu.', 'ok');
  };
})(window.HV);

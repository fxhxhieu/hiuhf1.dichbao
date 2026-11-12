/* hiuhf1 - trang kiểm tra cách tách đoạn: vẽ khung từng khối, lưu và so sánh snapshot */
(function (HV) {
  const $ = (id) => document.getElementById(id);
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  const st = { pdf: null, name: '', n: 0, page: 0, blocks: [], snap: null, diff: null, sel: -1 };
  const r1 = (v) => Math.round(v * 10) / 10;

  async function openPdf(bytes, name) {
    st.pdf = await pdfjsLib.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
    st.name = name; st.n = st.pdf.numPages; st.blocks = new Array(st.n).fill(null); st.page = 0; st.diff = null;
    $('btnSnap').disabled = false;
    if (st.snap) await compare();
    await show(0);
  }

  async function blocksOf(i) {
    if (!st.blocks[i]) {
      const page = await st.pdf.getPage(i + 1);
      st.blocks[i] = HV.markHeadings(await HV.extractBlocks(page));
    }
    return st.blocks[i];
  }

  // snapshot: văn bản và loại của từng khối, đủ để biết lần sửa thuật toán làm đổi trang nào
  async function makeSnapshot() {
    const pages = [];
    for (let i = 0; i < st.n; i++) {
      pages.push((await blocksOf(i)).map((b) => ({
        t: b.text, h: !!b.heading, c: !!b.center, tr: !!b.translatable, box: [r1(b.x0), r1(b.bottom), r1(b.x1), r1(b.top)],
      })));
    }
    return { app: 'hiuhf1-debug', name: st.name, pages: st.n, created: new Date().toISOString(), blocks: pages };
  }

  async function compare() {
    if (!st.pdf || !st.snap) return;
    const old = st.snap.blocks || [];
    st.diff = [];
    let changed = 0;
    for (let i = 0; i < st.n; i++) {
      const cur = await blocksOf(i), prev = old[i] || [];
      // ghép khối theo văn bản; trang có chữ trùng (nhãn trong hình...) thì ghép lần lượt theo thứ tự
      const queue = new Map();
      for (const b of prev) { if (!queue.has(b.t)) queue.set(b.t, []); queue.get(b.t).push(b); }
      const added = [], flags = [];
      cur.forEach((b, k) => {
        const q = queue.get(b.text);
        const p = q && q.shift();
        if (!p) added.push(k);
        else if (p.h !== !!b.heading || p.c !== !!b.center || p.tr !== !!b.translatable) flags.push(k);
      });
      const removed = [].concat(...[...queue.values()]).map((b) => b.t);
      const d = { added, removed, flags, before: prev.length, after: cur.length };
      if (added.length || removed.length || flags.length) changed++;
      st.diff.push(d);
    }
    renderSummary(changed);
  }

  function renderSummary(changed) {
    const box = $('summary');
    if (!st.diff) { box.innerHTML = '<span class="muted">Chưa có snapshot để so sánh.</span>'; return; }
    const sameName = st.snap.name === st.name ? '' : ' <span class="bad">(snapshot của file "' + esc(st.snap.name) + '")</span>';
    let html = '<b>So với snapshot ' + esc(String(st.snap.created || '').slice(0, 16)) + '</b>' + sameName + ': ';
    html += changed ? '<span class="bad">' + changed + ' trang khác</span>' : '<span class="ok">giống hệt</span>';
    if (changed) {
      html += '<table><tr><th>Trang</th><th>Khối cũ → mới</th><th>Mới / mất / đổi loại</th></tr>';
      st.diff.forEach((d, i) => {
        if (!d.added.length && !d.removed.length && !d.flags.length) return;
        html += '<tr data-p="' + i + '"><td>' + (i + 1) + '</td><td>' + d.before + ' → ' + d.after + '</td><td>' +
          d.added.length + ' / ' + d.removed.length + ' / ' + d.flags.length + '</td></tr>';
      });
      html += '</table>';
    }
    box.innerHTML = html;
  }
  $('summary').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-p]');
    if (tr) show(Number(tr.dataset.p));
  });

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  async function show(i) {
    if (!st.pdf) return;
    st.page = Math.max(0, Math.min(st.n - 1, i));
    st.sel = -1;
    $('pageLabel').textContent = 'Trang ' + (st.page + 1) + '/' + st.n;
    $('prev').disabled = st.page === 0; $('next').disabled = st.page >= st.n - 1;
    $('drop').hidden = true; $('wrap').hidden = false;
    const page = await st.pdf.getPage(st.page + 1);
    const blocks = await blocksOf(st.page);
    const width = Math.min(1000, $('stage').clientWidth - 40);
    const scale = width / page.getViewport({ scale: 1 }).width;
    const vp = page.getViewport({ scale });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cp = $('cPage'), co = $('cOver');
    for (const c of [cp, co]) {
      c.width = Math.floor(vp.width * dpr); c.height = Math.floor(vp.height * dpr);
      c.style.width = vp.width + 'px'; c.style.height = vp.height + 'px';
    }
    $('wrap').style.width = vp.width + 'px'; $('wrap').style.height = vp.height + 'px';
    await page.render({ canvasContext: cp.getContext('2d'), viewport: page.getViewport({ scale: scale * dpr }) }).promise;
    st.view = page.view; st.scale = scale; st.dpr = dpr;
    drawOverlay();
    renderList(blocks);
  }

  function drawOverlay() {
    const ctx = $('cOver').getContext('2d'), blocks = st.blocks[st.page], view = st.view, s = st.scale * st.dpr;
    const X = (x) => (x - view[0]) * s, Y = (y) => (view[3] - y) * s;
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    const d = st.diff && st.diff[st.page];
    const isNew = new Set(d ? d.added.concat(d.flags) : []);
    if ($('showGutters').checked) {
      ctx.setLineDash([6 * st.dpr, 4 * st.dpr]); ctx.strokeStyle = 'rgba(220,38,38,.8)'; ctx.lineWidth = 1.5 * st.dpr;
      for (const g of blocks.gutters || []) { ctx.beginPath(); ctx.moveTo(X(g), 0); ctx.lineTo(X(g), ctx.canvas.height); ctx.stroke(); }
    }
    blocks.forEach((b, k) => {
      const x = X(b.x0), y = Y(b.top), w = (b.x1 - b.x0) * s, h = (b.top - b.bottom) * s;
      ctx.setLineDash(b.center ? [5 * st.dpr, 3 * st.dpr] : []);
      ctx.lineWidth = (k === st.sel ? 3 : 1.5) * st.dpr;
      ctx.strokeStyle = !b.translatable ? '#9ca3af' : b.center ? '#7c3aed' : b.heading ? '#ea580c' : '#2563eb';
      if (isNew.has(k)) { ctx.fillStyle = 'rgba(220,38,38,.15)'; ctx.fillRect(x, y, w, h); ctx.strokeStyle = '#dc2626'; }
      if (k === st.sel) { ctx.fillStyle = 'rgba(79,70,229,.15)'; ctx.fillRect(x, y, w, h); }
      ctx.strokeRect(x, y, w, h);
      // số thứ tự khối
      ctx.setLineDash([]);
      const label = String(k);
      ctx.font = 600 + ' ' + 10 * st.dpr + 'px sans-serif';
      const lw = ctx.measureText(label).width + 6 * st.dpr;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fillRect(x, y - 13 * st.dpr, lw, 13 * st.dpr);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, x + 3 * st.dpr, y - 3 * st.dpr);
    });
  }

  function renderList(blocks) {
    const ol = $('list'), d = st.diff && st.diff[st.page];
    ol.innerHTML = '';
    blocks.forEach((b, k) => {
      const li = document.createElement('li');
      li.dataset.k = k;
      const tags = [];
      if (b.heading) tags.push('<span class="tag t-h">tiêu đề</span>');
      if (b.center) tags.push('<span class="tag t-c">giữa</span>');
      if (!b.translatable) tags.push('<span class="tag t-n">không dịch</span>');
      if (d && (d.added.includes(k) || d.flags.includes(k))) tags.push('<span class="tag t-new">khác</span>');
      li.innerHTML = '<b>#' + k + '</b> ' + tags.join('') + ' <span class="muted">' + b.nlines + ' dòng, cỡ ' + r1(b.size) + '</span><br>' + esc(b.text);
      ol.appendChild(li);
    });
    if (d && d.removed.length) {
      const li = document.createElement('li');
      li.innerHTML = '<span class="tag t-new">mất</span> Khối có trong snapshot nhưng không còn:<br>' + d.removed.map((t) => '• ' + esc(t)).join('<br>');
      ol.appendChild(li);
    }
  }
  $('list').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-k]');
    if (!li) return;
    st.sel = Number(li.dataset.k);
    document.querySelectorAll('#list li').forEach((x) => x.classList.toggle('sel', x === li));
    drawOverlay();
  });

  $('pdfInput').onchange = async () => {
    const f = $('pdfInput').files[0];
    if (f) openPdf(await f.arrayBuffer(), f.name).catch((e) => alert('Không mở được PDF: ' + e.message));
  };
  $('snapInput').onchange = async () => {
    const f = $('snapInput').files[0];
    if (!f) return;
    try { st.snap = JSON.parse(await f.text()); } catch (e) { alert('File snapshot lỗi: ' + e.message); return; }
    await compare();
    if (st.pdf) show(st.page);
  };
  $('btnSnap').onclick = async () => {
    const snap = await makeSnapshot();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(snap, null, 1)], { type: 'application/json' }));
    a.download = st.name.replace(/\.pdf$/i, '') + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };
  $('prev').onclick = () => show(st.page - 1);
  $('next').onclick = () => show(st.page + 1);
  $('showGutters').onchange = drawOverlay;
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'ArrowLeft') show(st.page - 1);
    if (e.key === 'ArrowRight') show(st.page + 1);
  });

  // debug.html?pdf=samples/bai.pdf&snap=samples/bai.json
  (async () => {
    const q = new URLSearchParams(location.search);
    try {
      if (q.get('snap')) st.snap = await (await fetch(q.get('snap'))).json();
      if (q.get('pdf')) await openPdf(await (await fetch(q.get('pdf'))).arrayBuffer(), q.get('pdf').split('/').pop());
    } catch (e) { alert('Không tải được file từ địa chỉ: ' + e.message); }
  })();
})(window.HV);

/* hiuhf1 - lõi: tách khối chữ từ PDF, dàn chữ dịch, tải font */
window.HV = window.HV || {};

(function (HV) {
  const FONT_URLS = {
    regular: 'https://cdn.jsdelivr.net/gh/notofonts/notofonts.github.io/fonts/NotoSans/hinted/ttf/NotoSans-Regular.ttf',
    bold: 'https://cdn.jsdelivr.net/gh/notofonts/notofonts.github.io/fonts/NotoSans/hinted/ttf/NotoSans-Bold.ttf',
  };

  /* ---------- Tách khối chữ ---------- */

  // Trả về các khối (đoạn văn) của một trang, toạ độ theo không gian PDF (gốc dưới-trái).
  HV.extractBlocks = async function (page) {
    const tc = await page.getTextContent();
    const view = page.view;
    const items = [];
    for (const it of tc.items) {
      if (typeof it.str !== 'string' || !it.str.trim()) continue;
      const t = it.transform;
      if (Math.abs(t[1]) > 0.2 * Math.abs(t[0])) continue; // bỏ chữ xoay (vd. dải bên lề arXiv)
      const size = Math.hypot(t[2], t[3]);
      if (size < 3) continue;
      items.push({ str: it.str, x: t[4], y: t[5], w: it.width, size });
    }
    items.sort((a, b) => b.y - a.y || a.x - b.x);

    // 1) gom thành dòng theo đường cơ sở
    const lines = [];
    for (const it of items) {
      let line = null;
      for (let k = lines.length - 1; k >= 0 && k >= lines.length - 8; k--) {
        if (Math.abs(lines[k].y - it.y) < 0.35 * it.size) { line = lines[k]; break; }
      }
      if (!line) { line = { y: it.y, items: [] }; lines.push(line); }
      line.items.push(it);
    }

    // 2) tách mỗi dòng thành các đoạn liền nhau (tránh nối 2 cột)
    const runs = [];
    for (const line of lines) {
      line.items.sort((a, b) => a.x - b.x);
      let run = null, prevEnd = 0;
      for (const it of line.items) {
        const gap = it.x - prevEnd;
        if (!run || gap > it.size * 1.6) {
          run = { x0: it.x, x1: it.x + it.w, y: line.y, size: it.size, text: it.str };
          runs.push(run);
        } else {
          const needSpace = gap > it.size * 0.15 && !/\s$/.test(run.text) && !/^\s/.test(it.str);
          run.text += (needSpace ? ' ' : '') + it.str;
          run.x1 = it.x + it.w;
        }
        prevEnd = it.x + it.w;
      }
    }

    // 3) gom các đoạn thành khối (đoạn văn)
    runs.sort((a, b) => b.y - a.y || a.x0 - b.x0);
    const blocks = [];
    for (const run of runs) {
      let best = null, bestGap = Infinity;
      for (let k = blocks.length - 1; k >= 0 && k >= blocks.length - 60; k--) {
        const b = blocks[k];
        const L = b.lines[b.lines.length - 1];
        const gap = L.y - run.y;
        if (gap < 0.5 * run.size || gap > 1.9 * run.size) continue;
        if (Math.abs(L.size - run.size) > 0.2 * run.size) continue;
        const overlap = Math.min(b.x1, run.x1) - Math.max(b.x0, run.x0);
        if (overlap < 0.4 * Math.min(b.x1 - b.x0, run.x1 - run.x0)) continue;
        // ngắt đoạn: giãn dòng lớn, thụt đầu dòng sau câu kết thúc, hoặc dòng trước ngắn hẳn
        const ended = /[.:?!]["')\]]?\s*$/.test(L.text);
        if (gap > 1.5 * run.size) continue;
        if (run.x0 - b.x0 > 1.0 * run.size && ended) continue;
        if (b.x1 - L.x1 > 3 * run.size && ended) continue;
        if (gap < bestGap) { best = b; bestGap = gap; }
      }
      if (best) {
        best.lines.push(run);
        best.x0 = Math.min(best.x0, run.x0);
        best.x1 = Math.max(best.x1, run.x1);
      } else {
        blocks.push({ lines: [run], x0: run.x0, x1: run.x1 });
      }
    }

    const pw = view[2] - view[0];
    return blocks.map((b) => {
      const first = b.lines[0], last = b.lines[b.lines.length - 1];
      const size = first.size;
      let text = b.lines[0].text.trim();
      for (let i = 1; i < b.lines.length; i++) {
        const nxt = b.lines[i].text.trim();
        if (/[A-Za-z]-$/.test(text) && /^[a-z]/.test(nxt)) text = text.slice(0, -1) + nxt;
        else text += ' ' + nxt;
      }
      text = text.normalize('NFKC').replace(/\s+/g, ' ').trim();
      const width = b.x1 - b.x0;
      const center = (b.x0 + b.x1) / 2 - view[0];
      return {
        x0: b.x0, x1: b.x1,
        top: first.y + size * 0.8,
        bottom: last.y - size * 0.22,
        size, text,
        nlines: b.lines.length,
        center: Math.abs(center - pw / 2) < pw * 0.02 && width < pw * 0.8,
        translatable: isTranslatable(text),
      };
    });
  };

  function isTranslatable(text) {
    const letters = (text.match(/\p{L}/gu) || []).length;
    if (letters < 3) return false;
    if (letters / text.length < 0.5) return false;
    if (/^(https?:\/\/|www\.)\S+$/.test(text)) return false;
    return true;
  }

  // Đặt tiêu đề đậm: khối có cỡ chữ lớn hơn hẳn cỡ chữ phổ biến của trang.
  HV.markHeadings = function (blocks) {
    const weights = new Map();
    for (const b of blocks) {
      const k = Math.round(b.size * 2) / 2;
      weights.set(k, (weights.get(k) || 0) + b.text.length);
    }
    let body = 10, max = 0;
    for (const [k, v] of weights) if (v > max) { max = v; body = k; }
    for (const b of blocks) {
      b.heading = b.size > body * 1.15 && b.nlines <= 3;
      b.level = b.size > body * 1.6 ? 1 : 2;
    }
    return blocks;
  };

  // Thứ tự đọc cho trang nhiều cột: khối rộng chia trang thành các đoạn, trong mỗi đoạn đọc cột trái rồi cột phải.
  HV.readingOrder = function (blocks, page) {
    const view = page.view, pw = view[2] - view[0], mid = view[0] + pw / 2;
    const idx = blocks.map((_, i) => i).sort((a, b) => blocks[b].top - blocks[a].top);
    const out = [];
    let left = [], right = [];
    const flush = () => {
      out.push(...left, ...right);
      left = []; right = [];
    };
    for (const i of idx) {
      const b = blocks[i];
      if (b.x1 - b.x0 > pw * 0.6) { flush(); out.push(i); }
      else if ((b.x0 + b.x1) / 2 < mid) left.push(i);
      else right.push(i);
    }
    flush();
    return out;
  };

  /* ---------- Dàn chữ dịch trong khung gốc ---------- */

  function wrap(text, width, size, measure) {
    const words = text.split(' ');
    const lines = [];
    let cur = '';
    for (const w of words) {
      const test = cur ? cur + ' ' + w : w;
      if (cur && measure(test, size) > width) { lines.push(cur); cur = w; }
      else cur = test;
    }
    if (cur) lines.push(cur);
    return lines;
  }

  // measure(text, size) -> độ rộng theo đơn vị PDF
  HV.layoutBlock = function (b, text, measure) {
    const width = b.x1 - b.x0;
    const availH = (b.top - b.bottom) + b.size * 0.45;
    const minSize = b.size * 0.55;
    const LH = 1.15;
    let size = b.size, lines;
    for (;;) {
      lines = wrap(text, width, size, measure);
      if (lines.length * size * LH <= availH || size <= minSize + 0.01) break;
      size = Math.max(minSize, size * 0.94);
    }
    const lh = size * LH;
    const placed = lines.map((t, i) => {
      let x = b.x0;
      if (b.center) x = b.x0 + (width - measure(t, size)) / 2;
      return { text: t, x, y: b.top - size * 0.85 - i * lh };
    });
    return { size, lines: placed };
  };

  // Hình chữ nhật cần phủ trắng để che chữ gốc
  HV.coverRect = function (b) {
    return { x: b.x0 - 1.5, y: b.bottom - 1.5, w: b.x1 - b.x0 + 3, h: b.top - b.bottom + 2.5 };
  };

  /* ---------- Font tiếng Việt ---------- */

  let fontPromise = null;
  HV.loadFonts = function () {
    if (!fontPromise) {
      fontPromise = (async () => {
        const [regular, bold] = await Promise.all(
          [FONT_URLS.regular, FONT_URLS.bold].map(async (u) => {
            const r = await fetch(u);
            if (!r.ok) throw new Error('Không tải được font (' + r.status + ')');
            return r.arrayBuffer();
          })
        );
        const f1 = new FontFace('HVSans', regular.slice(0), { weight: '400' });
        const f2 = new FontFace('HVSans', bold.slice(0), { weight: '700' });
        await Promise.all([f1.load(), f2.load()]);
        document.fonts.add(f1); document.fonts.add(f2);
        return { regular, bold };
      })().catch((e) => { fontPromise = null; throw e; });
    }
    return fontPromise;
  };

  // Đo chữ bằng canvas (dùng font HVSans đã nạp)
  const mctx = document.createElement('canvas').getContext('2d');
  HV.canvasMeasure = function (bold) {
    mctx.font = (bold ? '700' : '400') + ' 100px HVSans, Arial, sans-serif';
    return (t, size) => (mctx.measureText(t).width * size) / 100;
  };
})(window.HV);

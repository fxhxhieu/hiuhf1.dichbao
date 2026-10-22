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
    for (const line of lines) line.items.sort((a, b) => a.x - b.x);
    const gutters = findGutters(lines);

    // 2) tách mỗi dòng thành các đoạn liền nhau (tránh nối 2 cột)
    const runs = [];
    for (const line of lines) {
      let run = null, prevEnd = 0;
      for (const it of line.items) {
        const gap = it.x - prevEnd;
        const crossGutter = gutters.some((g) => prevEnd <= g + 0.5 && it.x >= g - 0.5);
        if (!run || crossGutter || gap > it.size * 1.6) {
          // y của đoạn lấy từ chính chữ của nó (hai cột có thể lệch đường cơ sở vài pt)
          run = { x0: it.x, x1: it.x + it.w, y: it.y, size: it.size, text: it.str };
          runs.push(run);
        } else {
          const needSpace = gap > it.size * 0.15 && !/\s$/.test(run.text) && !/^\s/.test(it.str);
          run.text += (needSpace ? ' ' : '') + it.str;
          run.x1 = it.x + it.w;
          if (it.size > run.size + 0.5) { run.size = it.size; run.y = it.y; } // chỉ số trên/dưới nhỏ không quyết định dòng
        }
        prevEnd = it.x + it.w;
      }
    }

    // 3) gom các đoạn thành khối (đoạn văn)
    runs.sort((a, b) => b.y - a.y || a.x0 - b.x0);

    // khoảng cách dòng điển hình của trang (tính theo cỡ chữ) để đặt ngưỡng ngắt đoạn
    const pitches = [];
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i];
      for (let j = i + 1; j < runs.length && j < i + 40; j++) {
        const n = runs[j], gap = r.y - n.y;
        if (gap < 0.9 * r.size || gap > 1.8 * r.size) continue;
        if (Math.min(r.x1, n.x1) - Math.max(r.x0, n.x0) < 0.5 * Math.min(r.x1 - r.x0, n.x1 - n.x0)) continue;
        if (Math.abs(n.size - r.size) > 0.2 * r.size) continue;
        pitches.push(gap / r.size);
        break;
      }
    }
    pitches.sort((a, b) => a - b);
    const pitch = pitches.length ? pitches[Math.floor(pitches.length / 2)] : 1.25;
    const breakGap = Math.max(1.5, pitch * 1.4);

    // mép trái/phải của cột chứa mỗi dòng (chỉ xét các dòng cùng cỡ chữ và không vượt qua khe cột)
    for (const r of runs) {
      let lo = r.x0, hi = r.x1;
      for (const o of runs) {
        if (o === r || Math.abs(o.size - r.size) > 0.2 * r.size) continue;
        if (Math.min(r.x1, o.x1) - Math.max(r.x0, o.x0) < 0.5 * Math.min(r.x1 - r.x0, o.x1 - o.x0)) continue;
        if (o.x1 > hi) hi = o.x1;
        if (o.x0 < lo) lo = o.x0;
      }
      const gr = gutters.filter((g) => g >= r.x1 - 1).sort((a, b) => a - b)[0];
      const gl = gutters.filter((g) => g <= r.x0 + 1).sort((a, b) => b - a)[0];
      if (gr !== undefined) hi = Math.min(hi, gr);
      if (gl !== undefined) lo = Math.max(lo, gl);
      r.cx0 = lo; r.cx1 = hi;
    }

    const blocks = [];
    for (const run of runs) {
      let best = null, bestGap = Infinity;
      for (let k = blocks.length - 1; k >= 0 && k >= blocks.length - 60; k--) {
        const b = blocks[k];
        if (b.closed) continue;
        const L = b.lines[b.lines.length - 1];
        const gap = L.y - run.y;
        const ended = /[.:?!]["')\]]?\s*$/.test(L.text);
        // câu đang dở (dòng sau bắt đầu bằng chữ thường) thì chấp nhận cả khi có dòng công thức chen giữa
        const unfinished = !ended && /^[a-z]/.test(run.text);
        if (gap < 0.5 * run.size || gap > (unfinished ? 2.8 : breakGap) * run.size) continue;
        if (Math.abs(L.size - run.size) > 0.2 * run.size) continue;
        if (STARTS_NEW.test(run.text)) continue;
        // dòng trước ngắn hẳn so với bề rộng cột nghĩa là hết đoạn (hội thoại, thơ, danh sách), trừ khi câu còn dở
        if (!unfinished && L.cx1 - L.x1 > Math.max(3 * L.size, 0.3 * (L.cx1 - L.cx0))) continue;
        const overlap = Math.min(b.x1, run.x1) - Math.max(b.x0, run.x0);
        if (overlap < 0.4 * Math.min(b.x1 - b.x0, run.x1 - run.x0)) continue;
        // ngắt đoạn: thụt đầu dòng sau câu kết thúc, hoặc dòng trước ngắn hẳn
        if (run.x0 - b.x0 > 1.0 * run.size && ended) continue;
        if (b.x1 - L.x1 > 3 * run.size && ended) continue;
        if (gap < bestGap) { best = b; bestGap = gap; }
      }
      if (best) {
        best.lines.push(run);
        best.x0 = Math.min(best.x0, run.x0);
        best.x1 = Math.max(best.x1, run.x1);
      } else {
        // tiêu đề mục đánh số ("3.5 Tên mục") đứng riêng một khối, không nhận thêm dòng
        blocks.push({ lines: [run], x0: run.x0, x1: run.x1, closed: HEADING_RE.test(run.text) });
      }
    }

    const pw = view[2] - view[0];
    const out = blocks.map((b) => {
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
      const mid = (b.x0 + b.x1) / 2 - view[0];
      const spread = (a) => Math.max(...a) - Math.min(...a);
      // căn giữa: một dòng ngắn nằm giữa trang hoặc giữa cột, hoặc vài dòng lệch hai mép nhưng cùng tâm
      let isCenter;
      if (b.lines.length === 1) {
        const colW = first.cx1 - first.cx0, colMid = (first.cx0 + first.cx1) / 2 - view[0];
        isCenter = width < 0.75 * Math.max(colW, width + 1) && (Math.abs(mid - pw / 2) < pw * 0.02 || Math.abs(mid - colMid) < pw * 0.02);
      } else {
        isCenter = b.lines.length <= 4 && spread(b.lines.map((l) => l.x0)) > 0.8 * size && spread(b.lines.map((l) => l.x1)) > 0.8 * size
          && spread(b.lines.map((l) => (l.x0 + l.x1) / 2)) < 1.2 * size;
      }
      return {
        x0: b.x0, x1: b.x1,
        top: first.y + size * 0.8,
        bottom: last.y - size * 0.22,
        size, text,
        nlines: b.lines.length,
        _lines: HV.debug ? b.lines : undefined,
        center: isCenter,
        translatable: isTranslatable(text),
      };
    });

    // mép phải của cột chứa khối, để dòng ngắn (tiêu đề mục...) được kéo rộng khi chữ Việt dài hơn
    for (const a of out) {
      let mx = a.x1;
      if (!a.center) {
        for (const o of out) {
          if (o === a || o.x1 <= mx) continue;
          const ov = Math.min(a.x1, o.x1) - Math.max(a.x0, o.x0);
          if (ov > 0.5 * Math.min(a.x1 - a.x0, o.x1 - o.x0)) mx = o.x1;
        }
        const g = gutters.filter((x) => x >= a.x1 - 1).sort((p, q) => p - q)[0];
        if (g !== undefined) mx = Math.min(mx, g - 3);
      }
      a.maxX1 = mx;
    }
    return out;
  };

  // Dòng bắt đầu bằng gạch đầu dòng, [1], 2), 2.1 Tiêu đề... luôn mở khối mới
  const STARTS_NEW = /^(?:[•▪◦●■‣∙·]|[-–—]\s|\(?\d{1,2}\)\s|\[\d+\]\s|\d{1,2}(?:\.\d{1,2})*\.?\s+\p{Lu})/u;

  const HEADING_RE = /^(?:\d{1,2}(?:\.\d{1,2})*|[A-Z](?:\.\d{1,2})+)\.?\s+\p{Lu}[^.:;?!]{0,90}$/u;

  // Tìm khe giữa các cột: khoảng trống giữa hai mục chữ liền nhau trên một dòng, lặp lại ở cùng vị trí x
  // trên nhiều dòng. Cách này không bị hình ảnh hay tiêu đề đi qua giữa trang làm nhiễu.
  function findGutters(lines) {
    const gaps = [];
    for (const line of lines) {
      const its = line.items;
      for (let i = 1; i < its.length; i++) {
        const prev = its[i - 1], it = its[i];
        const end = prev.x + prev.w, gap = it.x - end;
        if (gap > 4 && gap > 0.6 * Math.min(prev.size, it.size)) gaps.push((end + it.x) / 2);
      }
    }
    const need = Math.max(5, lines.length * 0.1);
    if (gaps.length < need) return [];
    gaps.sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i < gaps.length;) {
      let j = i;
      while (j + 1 < gaps.length && gaps[j + 1] - gaps[i] < 5) j++;
      if (j - i + 1 >= need) out.push(gaps[Math.floor((i + j) / 2)]);
      i = j + 1;
    }
    return out;
  }

  // "Yongkang Xiao, Sinian Zhang, Yi Dai, ..." - danh sách tên người, không dịch để khỏi sai tên
  function isNameList(text) {
    const parts = text.split(/\s*(?:,|;|\band\b|&)\s*/).filter(Boolean);
    if (parts.length < 3) return false;
    return parts.every((p) => /^\p{Lu}[\p{L}.'’-]*(?:\s+\p{Lu}[\p{L}.'’-]*){1,3}[*†‡∗\d]*$/u.test(p));
  }

  function isTranslatable(text) {
    const letters = (text.match(/\p{L}/gu) || []).length;
    if (letters < 3) return false;
    if (letters / text.length < 0.5) return false;
    if (/^(https?:\/\/|www\.)\S+$/.test(text)) return false;
    if (isNameList(text)) return false;
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
      b.heading = (b.size > body * 1.15 && b.nlines <= 3) || (b.nlines === 1 && HEADING_RE.test(b.text));
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
    const width = (b.center ? b.x1 : b.maxX1 || b.x1) - b.x0;
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

/* hiuhf1 - lõi: tách khối chữ từ PDF, dàn chữ dịch, phân tích ảnh trang, tải font */
window.HV = window.HV || {};

(function (HV) {
  // Font đặt sẵn trong repo (thư mục fonts/). Không đọc được (vd. mở bằng file://) thì lấy từ CDN.
  // Phải dùng bản "hinted": bản unhinted bị pdf-lib cắt font (subset) làm mất gần hết chữ trong PDF xuất ra.
  const FONT_CDN = 'https://cdn.jsdelivr.net/gh/notofonts/notofonts.github.io/fonts/';
  const FONTS = {
    sansRegular: { file: 'NotoSans-Regular.ttf', dir: 'NotoSans', family: 'HVSans', weight: '400' },
    sansBold: { file: 'NotoSans-Bold.ttf', dir: 'NotoSans', family: 'HVSans', weight: '700' },
    serifRegular: { file: 'NotoSerif-Regular.ttf', dir: 'NotoSerif', family: 'HVSerif', weight: '400' },
    serifBold: { file: 'NotoSerif-Bold.ttf', dir: 'NotoSerif', family: 'HVSerif', weight: '700' },
    math: { file: 'NotoSansMath-Regular.ttf', dir: 'NotoSansMath', family: 'HVMath', weight: '400' },
  };

  // Tuỳ chọn hiển thị, app.js cập nhật theo cài đặt. fontStyle: 'auto' | 'serif' | 'sans'
  HV.prefs = HV.prefs || { fontStyle: 'auto' };

  /* ---------- Băm (nhận diện file và đoạn văn) ---------- */

  // cyrb53: băm nhanh 53 bit. Chạy 2 lần với hạt khác nhau cho ra khoảng 106 bit, đủ để không trùng.
  function cyrbStr(s, seed) {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
    }
    return fin(h1, h2);
  }
  function cyrbBytes(u, seed) {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < u.length; i++) {
      const c = u[i];
      h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
    }
    return fin(h1, h2);
  }
  function fin(h1, h2) {
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507); h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507); h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }
  HV.hash = (s) => cyrbStr(s, 1) + '.' + cyrbStr(s, 7);
  HV.hashBytes = (buf) => { const u = new Uint8Array(buf); return cyrbBytes(u, 1) + '.' + cyrbBytes(u, 7); };

  /* ---------- Tách khối chữ ---------- */

  // Các mục chữ của trang (cụm chữ cùng font), toạ độ theo không gian PDF (gốc dưới-trái)
  HV.pageItems = async function (page) {
    const tc = await page.getTextContent();
    const items = [];
    for (const it of tc.items) {
      if (typeof it.str !== 'string' || !it.str.trim()) continue;
      const t = it.transform;
      if (Math.abs(t[1]) > 0.2 * Math.abs(t[0])) continue; // bỏ chữ xoay (vd. dải bên lề arXiv)
      const size = Math.hypot(t[2], t[3]);
      if (size < 3) continue;
      const st = tc.styles[it.fontName];
      // serif chỉ là phỏng đoán ban đầu (PDF.js hay báo sai với font nhúng); HV.analyzePage xét lại theo tên font
      items.push({ str: it.str, x: t[4], y: t[5], w: it.width, size, serif: !!st && st.fontFamily === 'serif', font: it.fontName });
    }
    return items;
  };

  HV.extractBlocks = async (page) => HV.buildBlocks(await HV.pageItems(page), page.view);

  // Gom các mục chữ thành khối (đoạn văn). Dùng chung cho chữ trong PDF và chữ nhận dạng bằng OCR.
  HV.buildBlocks = function (input, view) {
    const items = input.slice().sort((a, b) => b.y - a.y || a.x - b.x);

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
        const n = it.str.length;
        if (!run || crossGutter || gap > it.size * 1.6) {
          // y của đoạn lấy từ chính chữ của nó (hai cột có thể lệch đường cơ sở vài pt)
          run = { x0: it.x, x1: it.x + it.w, y: it.y, size: it.size, text: it.str, sn: it.serif ? n : 0, cn: n, fonts: {} };
          runs.push(run);
        } else {
          const needSpace = gap > it.size * 0.15 && !/\s$/.test(run.text) && !/^\s/.test(it.str);
          run.text += (needSpace ? ' ' : '') + it.str;
          run.x1 = it.x + it.w;
          run.cn += n; if (it.serif) run.sn += n;
          if (it.size > run.size + 0.5) { run.size = it.size; run.y = it.y; } // chỉ số trên/dưới nhỏ không quyết định dòng
        }
        if (it.font) run.fonts[it.font] = (run.fonts[it.font] || 0) + n;
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
      let sn = 0, cn = 0;
      const fonts = {};
      for (const l of b.lines) {
        sn += l.sn; cn += l.cn;
        for (const f in l.fonts) fonts[f] = (fonts[f] || 0) + l.fonts[f];
      }
      let font = null;
      for (const f in fonts) if (!font || fonts[f] > fonts[font]) font = f;
      return {
        x0: b.x0, x1: b.x1,
        top: first.y + size * 0.8,
        bottom: last.y - size * 0.22,
        size, text,
        nlines: b.lines.length,
        // từng dòng gốc (để dựng lớp chữ chọn/copy được cho phần chưa dịch)
        rows: b.lines.map((l) => ({ x0: l.x0, x1: l.x1, y: l.y, size: l.size, text: l.text })),
        _lines: HV.debug ? b.lines : undefined,
        center: isCenter,
        serif: cn > 0 && sn > 0.5 * cn,
        font, // font chiếm nhiều chữ nhất trong khối (tên nội bộ của PDF.js)
        translatable: isTranslatable(text),
      };
    });

    fillMaxX1(out, gutters);
    out.gutters = gutters; // cho trang debug
    return out;
  };

  // Mép phải của cột chứa khối, để dòng ngắn (tiêu đề mục...) được kéo rộng khi chữ Việt dài hơn
  function fillMaxX1(out, gutters) {
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
  }

  // Khối từ kết quả OCR. Tesseract đã tự chia đoạn và dòng (đáng tin hơn tự gom lại từ toạ độ từng từ,
  // vốn nhiễu hơn chữ thật trong PDF). paras: [{ lines: [{ x0, x1, y, top, bottom, size, text, serif }] }]
  HV.ocrBlocks = function (paras, view) {
    const pw = view[2] - view[0];
    const spread = (a) => Math.max(...a) - Math.min(...a);
    const out = [];
    for (const p of paras) {
      const lines = (p.lines || []).filter((l) => l.text && l.text.trim());
      if (!lines.length) continue;
      let text = lines[0].text.trim();
      for (let i = 1; i < lines.length; i++) {
        const nxt = lines[i].text.trim();
        if (/[A-Za-z]-$/.test(text) && /^[a-z]/.test(nxt)) text = text.slice(0, -1) + nxt;
        else text += ' ' + nxt;
      }
      text = text.normalize('NFKC').replace(/\s+/g, ' ').trim();
      const sizes = lines.map((l) => l.size).sort((a, b) => a - b);
      const size = sizes[Math.floor(sizes.length / 2)];
      const x0 = Math.min(...lines.map((l) => l.x0)), x1 = Math.max(...lines.map((l) => l.x1));
      const mid = (x0 + x1) / 2 - view[0];
      const center = lines.length === 1
        ? x1 - x0 < 0.6 * pw && Math.abs(mid - pw / 2) < pw * 0.03
        : lines.length <= 4 && spread(lines.map((l) => (l.x0 + l.x1) / 2)) < 1.2 * size && spread(lines.map((l) => l.x0)) > 0.8 * size;
      out.push({
        x0, x1,
        top: Math.max(...lines.map((l) => l.top)),
        bottom: Math.min(...lines.map((l) => l.bottom)),
        size, text,
        nlines: lines.length,
        rows: lines.map((l) => ({ x0: l.x0, x1: l.x1, y: l.y, size: l.size, text: l.text.trim() })),
        center,
        serif: lines.filter((l) => l.serif).length > lines.length / 2,
        font: null,
        translatable: isTranslatable(text),
        // không có khe cột để giới hạn nên không kéo rộng khối (dễ tràn sang cột bên cạnh)
        maxX1: x1,
      });
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
  // view: page.view của trang
  HV.readingOrder = function (blocks, view) {
    const pw = view[2] - view[0], mid = view[0] + pw / 2;
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

  /* ---------- Phân tích ảnh trang: màu nền, màu chữ, khoảng trống bên dưới khối ---------- */

  // Vẽ trang gốc ra ảnh tạm (tỉ lệ cố định để bản xem và file xuất cho kết quả như nhau), rồi với mỗi khối:
  //  b.bg   - màu nền quanh khối (để phủ đúng màu thay vì luôn phủ trắng)
  //  b.fg   - màu chữ gốc (chữ trắng trên hộp tối vẫn đọc được)
  //  b.room - khoảng trống chỉ toàn màu nền ngay dưới khối (pt), để chữ dịch dài lấn xuống thay vì thu nhỏ
  const ANALYZE_SCALE = 1.5;
  HV.analyzePage = async function (page, blocks) {
    const view = page.view, S = ANALYZE_SCALE;
    const vp = page.getViewport({ scale: S });
    const cv = document.createElement('canvas');
    cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const W = cv.width, H = cv.height;
    const px = ctx.getImageData(0, 0, W, H).data;
    cv.width = cv.height = 0;

    // vẽ xong thì PDF.js đã nạp font của trang, lúc này mới biết tên font thật để chọn chữ có chân hay không
    for (const b of blocks) {
      if (!b.font || !page.commonObjs.has(b.font)) continue;
      let name = '';
      try { name = page.commonObjs.get(b.font).name || ''; } catch (e) { /* font chưa nạp */ }
      if (SANS_FONT.test(name) && !/serif/i.test(name)) b.serif = false;
      else if (SERIF_FONT.test(name)) b.serif = true;
    }

    const at = (x, y) => {
      const o = (Math.min(H - 1, Math.max(0, Math.round(y))) * W + Math.min(W - 1, Math.max(0, Math.round(x)))) * 4;
      return [px[o], px[o + 1], px[o + 2]];
    };
    const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
    const lum = (c) => (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;
    const X = (x) => (x - view[0]) * S, Y = (y) => (view[3] - y) * S;
    const pageBottom = Y(view[1] + 24); // không lấn xuống lề dưới của trang

    for (const b of blocks) {
      const r = HV.coverRect(b);
      const L = X(r.x), R = X(r.x + r.w), T = Y(r.y + r.h), B = Y(r.y);

      // màu nền: màu gặp nhiều nhất trên viền ngay ngoài khung
      const ring = [];
      for (let x = L - 2; x <= R + 2; x += 3) ring.push(at(x, T - 2), at(x, B + 2));
      for (let y = T; y <= B; y += 3) ring.push(at(L - 2, y), at(R + 2, y));
      const bg = dominant(ring);

      // màu chữ: trung bình các điểm khác nền nhiều nhất bên trong khung
      const ink = [];
      for (let y = T; y <= B; y += 1.5) {
        for (let x = L; x <= R; x += 1.5) {
          const c = at(x, y), d = dist(c, bg);
          if (d > 120) ink.push([d, c]);
        }
      }
      let fg = null;
      if (ink.length >= 6) {
        ink.sort((p, q) => q[0] - p[0]);
        fg = average(ink.slice(0, Math.max(3, Math.floor(ink.length * 0.3))).map((p) => p[1]));
      }
      if (!fg || Math.abs(lum(fg) - lum(bg)) < 0.35) fg = lum(bg) < 0.5 ? [255, 255, 255] : [13, 13, 20];

      // khoảng trống bên dưới: các hàng chỉ có màu nền, tới khi gặp chữ/hình hoặc lề dưới
      const x1 = X(b.center ? b.x1 : (b.maxX1 || b.x1));
      const lim = Math.min(pageBottom, B + 40 * b.size * S);
      let blank = 0;
      for (let y = Math.ceil(B) + 1; y < lim; y++) {
        let ok = true;
        for (let x = L; x <= x1; x += 2) { if (dist(at(x, y), bg) > 40) { ok = false; break; } }
        if (!ok) break;
        blank++;
      }
      b.bg = bg; b.fg = fg;
      b.room = Math.max(0, blank / S - 0.6 * b.size); // chừa khoảng cách với thứ bên dưới
    }
  };

  // Nhận kiểu chữ theo tên font (vd. "DRMZXX+NimbusRomNo9L-Regu", "CMR10", "ArialMT")
  const SERIF_FONT = /times|roman|serif|nimbusrom|^(?:[A-Z]{6}\+)?(?:cmr|cmti|cmbx|cmsl|cmcsc|sfrm|sfti|sfbx|lmroman)|minion|palatino|garamond|georgia|cambria|baskerville|bookman|century|charter|utopia|libertin|stix|tinos|mincho|song|ming|txr|ptmr|pplr/i;
  const SANS_FONT = /sans|arial|helvetica|calibri|verdana|tahoma|segoe|roboto|lato|gothic|^(?:[A-Z]{6}\+)?(?:cmss|sfss)|myriad|frutiger|futura|gill|avenir|inter\b|nimbussan|arimo|dejavusans|phvr|uhvr/i;

  // Màu xuất hiện nhiều nhất (gom màu gần nhau theo 5 bit mỗi kênh)
  function dominant(colors) {
    if (!colors.length) return [255, 255, 255];
    const buckets = new Map();
    for (const c of colors) {
      const k = ((c[0] >> 3) << 10) | ((c[1] >> 3) << 5) | (c[2] >> 3);
      const v = buckets.get(k);
      if (v) v.push(c); else buckets.set(k, [c]);
    }
    let best = null;
    for (const v of buckets.values()) if (!best || v.length > best.length) best = v;
    return average(best);
  }
  function average(colors) {
    const s = [0, 0, 0];
    for (const c of colors) { s[0] += c[0]; s[1] += c[1]; s[2] += c[2]; }
    return s.map((v) => Math.round(v / colors.length));
  }

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

  // measure(text, size) -> độ rộng theo đơn vị PDF.
  // Ưu tiên giữ cỡ chữ gốc và lấn xuống khoảng trống bên dưới (b.room), hết chỗ mới thu nhỏ.
  // overflow = true khi đã thu nhỏ hết mức mà vẫn không vừa (chữ sẽ đè lên phần bên dưới).
  HV.layoutBlock = function (b, text, measure) {
    const width = (b.center ? b.x1 : b.maxX1 || b.x1) - b.x0;
    const availH = (b.top - b.bottom) + b.size * 0.45 + (b.room || 0);
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
    return { size, lines: placed, overflow: lines.length * size * LH > availH + 0.01 };
  };

  // Hình chữ nhật cần phủ để che chữ gốc
  HV.coverRect = function (b) {
    return { x: b.x0 - 1.5, y: b.bottom - 1.5, w: b.x1 - b.x0 + 3, h: b.top - b.bottom + 2.5 };
  };

  /* ---------- Font tiếng Việt ---------- */

  // Khối dùng chữ có chân hay không: theo cài đặt, hoặc theo font của bản gốc
  HV.useSerif = (b) => (HV.prefs.fontStyle === 'auto' ? !!b.serif : HV.prefs.fontStyle === 'serif');
  HV.fontKey = (b) => (HV.useSerif(b) ? 'serif' : 'sans') + (b.heading ? 'Bold' : 'Regular');
  // Chuỗi font cho canvas/CSS. HVMath đứng sau để trình duyệt tự lấy ký hiệu toán khi font chính thiếu.
  HV.fontFamily = (b) => (HV.useSerif(b) ? 'HVSerif, HVMath, "Times New Roman", serif' : 'HVSans, HVMath, Arial, sans-serif');
  HV.canvasFont = (b, px) => (b.heading ? '700 ' : '400 ') + px + 'px ' + HV.fontFamily(b);

  async function fetchFont(f) {
    // mở bằng file:// thì trình duyệt không cho đọc file bên cạnh, lấy thẳng từ CDN
    if (location.protocol !== 'file:') {
      try {
        const r = await fetch('fonts/' + f.file);
        if (r.ok) return await r.arrayBuffer();
      } catch (e) { /* thiếu file: dùng CDN */ }
    }
    const r = await fetch(FONT_CDN + f.dir + '/hinted/ttf/' + f.file);
    if (!r.ok) throw new Error('Không tải được font ' + f.file + ' (' + r.status + ')');
    return r.arrayBuffer();
  }

  // Trả về { sansRegular, sansBold, serifRegular, serifBold, math } dạng ArrayBuffer
  let fontPromise = null;
  HV.loadFonts = function () {
    if (!fontPromise) {
      fontPromise = (async () => {
        const keys = Object.keys(FONTS);
        const bufs = await Promise.all(keys.map((k) => fetchFont(FONTS[k])));
        const out = {};
        const faces = keys.map((k, i) => {
          out[k] = bufs[i];
          return new FontFace(FONTS[k].family, bufs[i].slice(0), { weight: FONTS[k].weight });
        });
        await Promise.all(faces.map((f) => f.load()));
        faces.forEach((f) => document.fonts.add(f));
        return out;
      })().catch((e) => { fontPromise = null; throw e; });
    }
    return fontPromise;
  };

  // Đo chữ bằng canvas với font của khối b (đã nạp font HV...)
  const mctx = document.createElement('canvas').getContext('2d');
  let mfont = '';
  HV.canvasMeasure = function (b) {
    const font = HV.canvasFont(b, 100);
    return (t, size) => {
      if (mfont !== font) { mctx.font = font; mfont = font; }
      return (mctx.measureText(t).width * size) / 100;
    };
  };
})(window.HV);

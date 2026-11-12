/* hiuhf1 - xuất bản dịch ra PDF (giữ bố cục / song ngữ), DOCX (thường / song ngữ) và JSON */
window.HV = window.HV || {};

(function (HV) {
  const tick = () => new Promise((r) => setTimeout(r, 0));

  // Ký tự không có trong cả font chính lẫn Noto Sans Math: thay bằng chữ thường để khỏi hiện ô vuông
  const SUBST = {
    '∈': ' thuộc ', '∉': ' không thuộc ', '∀': 'với mọi ', '∃': 'tồn tại ', '∅': '{}', '≤': '<=', '≥': '>=', '≠': '!=',
    '≈': '~', '→': '->', '←': '<-', '↔': '<->', '⇒': '=>', '⇔': '<=>', '∞': 'vô cùng', '√': 'căn ', '−': '-', '×': 'x', '⋅': '·',
    '∧': ' và ', '∨': ' hoặc ', '¬': 'không ', '⊕': '(+)', '⊗': '(x)', 'ℝ': 'R', 'ℕ': 'N', 'ℤ': 'Z', 'ℚ': 'Q',
    '❶': '(1)', '❷': '(2)', '❸': '(3)', '❹': '(4)', '❺': '(5)', '①': '(1)', '②': '(2)', '③': '(3)', '④': '(4)',
    '“': '"', '”': '"', '‘': "'", '’': "'", '–': '-', '—': '-', '…': '...', '•': '·',
  };

  function charset(font) {
    try { return new Set(font.getCharacterSet()); } catch (e) { return null; } // không đọc được thì coi như có đủ
  }

  // Một "mặt chữ" cho pdf-lib: font chính (sans/serif, thường/đậm) + Noto Sans Math cho ký hiệu toán.
  // pdf-lib không tự đổi font khi thiếu ký tự, nên chuỗi được cắt thành từng đoạn theo font có ký tự đó.
  // mathSet: tập ký tự của font toán; getMath(): nhúng font toán khi lần đầu cần.
  function makeFace(main, mathSet, getMath) {
    const set = charset(main);
    const inMain = (cp) => !set || set.has(cp);
    let math = null;
    const segs = (t) => {
      const out = [];
      for (const ch of t) {
        const f = inMain(ch.codePointAt(0)) || !math ? main : math;
        const last = out[out.length - 1];
        if (last && last.f === f) last.t += ch; else out.push({ f, t: ch });
      }
      return out;
    };
    return {
      // thay ký tự không font nào có
      prep: (t) => Array.from(t).map((ch) => {
        const cp = ch.codePointAt(0);
        if (cp < 32) return ' ';
        if (inMain(cp) || mathSet.has(cp)) return ch;
        const sub = SUBST[ch];
        if (sub !== undefined) return Array.from(sub).filter((c) => inMain(c.codePointAt(0)) || mathSet.has(c.codePointAt(0))).join('');
        return '?';
      }).join('').replace(/ {2,}/g, ' '),
      async ready(t) {
        if (!math && Array.from(t).some((ch) => !inMain(ch.codePointAt(0)))) math = await getMath();
      },
      measure: (t, s) => segs(t).reduce((w, g) => w + g.f.widthOfTextAtSize(g.t, s), 0),
      draw(page, t, x, y, size, color) {
        for (const g of segs(t)) {
          page.drawText(g.t, { x, y, size, font: g.f, color });
          x += g.f.widthOfTextAtSize(g.t, size);
        }
      },
    };
  }

  const toRgb = (c, dflt) => { const v = c || dflt; return PDFLib.rgb(v[0] / 255, v[1] / 255, v[2] / 255); };

  // doc: { bytes, n, trans[], views[], getBlocks(i), analyze(i), hasTrans(i) }
  // mode: 'replace' (thay chữ trên trang gốc), 'interleave' (trang gốc rồi trang dịch), 'side' (gốc | dịch trên một trang ngang)
  HV.exportPdf = async function (doc, onProgress, mode) {
    const { PDFDocument } = PDFLib;
    const fonts = await HV.loadFonts();
    const pdf = await PDFDocument.load(doc.bytes.slice(0), { ignoreEncryption: true });
    pdf.registerFontkit(fontkit);
    const mathSet = new Set(fontkit.create(new Uint8Array(fonts.math)).characterSet);
    const embedded = {};
    const embed = (k) => embedded[k] || (embedded[k] = pdf.embedFont(fonts[k], { subset: true }));
    const faces = {};
    const face = async (b) => {
      const k = HV.fontKey(b);
      return faces[k] || (faces[k] = makeFace(await embed(k), mathSet, () => embed('math')));
    };
    const pages = pdf.getPages();

    for (let i = 0; i < doc.n; i++) {
      onProgress && onProgress(i + 1, doc.n);
      const tr = doc.trans[i];
      if (!doc.hasTrans(i)) continue;
      const blocks = await doc.getBlocks(i);
      await doc.analyze(i);
      const page = pages[i];
      // phủ hết các khối trước rồi mới viết chữ (giống bản xem trước), để chữ lấn xuống không bị phủ mất
      for (let k = 0; k < blocks.length; k++) {
        if (!tr[k]) continue;
        const r = HV.coverRect(blocks[k]);
        page.drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, color: toRgb(blocks[k].bg, [255, 255, 255]) });
      }
      for (let k = 0; k < blocks.length; k++) {
        const b = blocks[k];
        if (!tr[k]) continue;
        const f = await face(b);
        const text = f.prep(tr[k]);
        await f.ready(text);
        const lay = HV.layoutBlock(b, text, f.measure);
        const color = toRgb(b.fg, [13, 13, 20]);
        for (const ln of lay.lines) f.draw(page, ln.text, ln.x, ln.y, lay.size, color);
      }
      await tick();
    }
    const translated = await pdf.save();
    if (mode !== 'interleave' && mode !== 'side') return new Blob([translated], { type: 'application/pdf' });

    // song ngữ: ghép trang gốc với trang đã dịch. Phải đọc lại bản dịch từ file đã lưu,
    // vì pdf-lib chỉ ghi font nhúng vào file lúc save(), chép trang trước đó sẽ mất font.
    const tdoc = await PDFDocument.load(translated);
    const orig = await PDFDocument.load(doc.bytes.slice(0), { ignoreEncryption: true });
    const out = await PDFDocument.create();
    const all = Array.from({ length: doc.n }, (_, i) => i);
    if (mode === 'interleave') {
      const po = await out.copyPages(orig, all);
      const done = all.filter((i) => doc.hasTrans(i));
      const pt = await out.copyPages(tdoc, done);
      let j = 0;
      for (const i of all) {
        out.addPage(po[i]);
        if (doc.hasTrans(i)) out.addPage(pt[j++]);
      }
    } else {
      const eo = await out.embedPages(orig.getPages());
      const et = await out.embedPages(tdoc.getPages());
      for (const i of all) {
        onProgress && onProgress(i + 1, doc.n);
        const a = eo[i], b = et[i], gap = 14;
        const p = out.addPage([a.width + b.width + gap, Math.max(a.height, b.height)]);
        p.drawPage(a, { x: 0, y: 0 });
        p.drawPage(b, { x: a.width + gap, y: 0 });
        if (i % 5 === 4) await tick();
      }
    }
    return new Blob([await out.save()], { type: 'application/pdf' });
  };

  // bilingual: bảng hai cột "Bản gốc | Bản dịch" cho từng trang
  HV.exportDocx = async function (doc, onProgress, bilingual) {
    const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell, WidthType } = docx;
    const children = [];
    const cell = (text, bold, shade) => new TableCell({
      width: { size: 50, type: WidthType.PERCENTAGE },
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      shading: shade ? { fill: 'EEF0F8' } : undefined,
      children: [new Paragraph({ children: [new TextRun({ text: text || '', bold })] })],
    });

    for (let i = 0; i < doc.n; i++) {
      onProgress && onProgress(i + 1, doc.n);
      const tr = doc.trans[i];
      if (!doc.hasTrans(i)) continue;
      const blocks = await doc.getBlocks(i);
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 240, after: 160 },
        children: [new TextRun({ text: '— Trang ' + (i + 1) + ' —', color: '9AA0A6', size: 18 })],
      }));
      const order = HV.readingOrder(blocks, doc.views[i]);
      if (bilingual) {
        const rows = [new TableRow({ tableHeader: true, children: [cell('Bản gốc', true, true), cell('Bản dịch', true, true)] })];
        for (const k of order) {
          const b = blocks[k];
          rows.push(new TableRow({ children: [cell(b.text, b.heading), cell(tr[k] || '', b.heading)] }));
        }
        children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, columnWidths: [4680, 4680], rows }));
      } else {
        for (const k of order) {
          const b = blocks[k];
          const text = tr[k] || b.text;
          if (b.heading) {
            children.push(new Paragraph({
              heading: b.level === 1 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2,
              alignment: b.center ? AlignmentType.CENTER : AlignmentType.LEFT,
              children: [new TextRun({ text })],
            }));
          } else {
            children.push(new Paragraph({
              alignment: b.center ? AlignmentType.CENTER : AlignmentType.JUSTIFIED,
              spacing: { after: 120, line: 300 },
              children: [new TextRun({ text })],
            }));
          }
        }
      }
      await tick();
    }

    const d = new Document({
      styles: { default: { document: { run: { font: 'Times New Roman', size: 24 } } } },
      sections: [{ children }],
    });
    return Packer.toBlob(d);
  };

  /* ---------- Bản dịch dạng JSON (chia sẻ cho người khác mở lại không cần dịch) ---------- */
  HV.exportJson = async function (doc) {
    const pages = [];
    for (let i = 0; i < doc.n; i++) {
      const tr = doc.trans[i];
      if (!tr) continue;
      const blocks = await doc.getBlocks(i);
      const items = [];
      blocks.forEach((b, k) => { if (tr[k] != null) items.push({ src: b.text, vi: tr[k], engine: doc.eng[i][k] || '' }); });
      if (items.length) pages.push({ page: i + 1, blocks: items });
    }
    const data = { app: 'hiuhf1', format: 1, name: doc.name, pages: doc.n, exported: new Date().toISOString(), translations: pages };
    return new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  };

  // Đọc file JSON đã xuất, trả về Map(hash văn bản gốc -> { t, e }) để ghép vào bài đang mở
  HV.parseImport = function (data) {
    if (!data || data.app !== 'hiuhf1' || !Array.isArray(data.translations)) throw new Error('File không phải bản dịch của hiuhf1');
    const map = new Map();
    for (const p of data.translations) {
      for (const it of p.blocks || []) {
        if (typeof it.src === 'string' && typeof it.vi === 'string') map.set(HV.hash(it.src), { t: it.vi, e: it.engine || 'import' });
      }
    }
    return map;
  };

  HV.download = function (blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };
})(window.HV);

/* hiuhf1 - xuất bản dịch ra PDF (giữ bố cục) và DOCX */
window.HV = window.HV || {};

(function (HV) {
  const tick = () => new Promise((r) => setTimeout(r, 0));

  // Ký hiệu toán/đặc biệt mà font Noto Sans không có glyph: thay bằng chữ thường để khỏi hiện ô vuông
  const SUBST = {
    '∈': ' thuộc ', '∉': ' không thuộc ', '∀': 'với mọi ', '∃': 'tồn tại ', '∅': '{}', '∪': ' ∪ ', '∩': ' ∩ ',
    '⊂': ' ⊂ ', '⊆': ' ⊆ ', '≤': '<=', '≥': '>=', '≠': '!=', '≈': '~', '→': '->', '←': '<-', '↔': '<->',
    '⇒': '=>', '⇔': '<=>', '∞': 'vô cùng', '√': 'căn ', '∑': 'Σ', '∏': 'Π', '∫': '∫', '−': '-', '×': 'x', '⋅': '·',
    '∧': ' và ', '∨': ' hoặc ', '¬': 'không ', '⊕': '(+)', '⊗': '(x)', 'ℝ': 'R', 'ℕ': 'N', 'ℤ': 'Z', 'ℚ': 'Q',
    '❶': '(1)', '❷': '(2)', '❸': '(3)', '❹': '(4)', '❺': '(5)', '①': '(1)', '②': '(2)', '③': '(3)', '④': '(4)',
    '“': '"', '”': '"', '‘': "'", '’': "'", '–': '-', '—': '-', '…': '...', '•': '·',
  };

  function makeSanitizer(font) {
    let set = null;
    try { set = new Set(font.getCharacterSet()); } catch (e) { /* không đọc được thì giữ nguyên */ }
    if (!set) return (t) => t;
    return (t) => Array.from(t).map((ch) => {
      const cp = ch.codePointAt(0);
      if (cp < 32 || set.has(cp)) return ch;
      const sub = SUBST[ch];
      if (sub !== undefined) return Array.from(sub).every((c) => set.has(c.codePointAt(0))) ? sub : sub.replace(/[^ -~\p{L}]/gu, '');
      return '?';
    }).join('').replace(/ {2,}/g, ' ');
  }

  // doc: { bytes, n, trans[], getBlocks(i), getPage(i) }
  HV.exportPdf = async function (doc, onProgress) {
    const { PDFDocument, rgb } = PDFLib;
    const fonts = await HV.loadFonts();
    const pdf = await PDFDocument.load(doc.bytes.slice(0), { ignoreEncryption: true });
    pdf.registerFontkit(fontkit);
    const fReg = await pdf.embedFont(fonts.regular, { subset: true });
    const fBold = await pdf.embedFont(fonts.bold, { subset: true });
    const sanR = makeSanitizer(fReg), sanB = makeSanitizer(fBold);
    const pages = pdf.getPages();

    for (let i = 0; i < doc.n; i++) {
      onProgress && onProgress(i + 1, doc.n);
      const tr = doc.trans[i];
      if (!tr) continue;
      const blocks = await doc.getBlocks(i);
      const page = pages[i];
      for (let k = 0; k < blocks.length; k++) {
        const b = blocks[k];
        if (!tr[k]) continue;
        const font = b.heading ? fBold : fReg;
        const sanitize = b.heading ? sanB : sanR;
        const measure = (t, s) => font.widthOfTextAtSize(t, s);
        const r = HV.coverRect(b);
        page.drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, color: rgb(1, 1, 1) });
        const lay = HV.layoutBlock(b, sanitize(tr[k]), measure);
        for (const ln of lay.lines) {
          page.drawText(ln.text, { x: ln.x, y: ln.y, size: lay.size, font, color: rgb(0.05, 0.05, 0.08) });
        }
      }
      await tick();
    }
    const out = await pdf.save();
    return new Blob([out], { type: 'application/pdf' });
  };

  HV.exportDocx = async function (doc, onProgress) {
    const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = docx;
    const children = [];

    for (let i = 0; i < doc.n; i++) {
      onProgress && onProgress(i + 1, doc.n);
      const tr = doc.trans[i];
      if (!tr) continue;
      const blocks = await doc.getBlocks(i);
      const page = await doc.getPage(i);
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 240, after: 160 },
        children: [new TextRun({ text: '— Trang ' + (i + 1) + ' —', color: '9AA0A6', size: 18 })],
      }));
      for (const k of HV.readingOrder(blocks, page)) {
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
      await tick();
    }

    const d = new Document({
      styles: { default: { document: { run: { font: 'Times New Roman', size: 24 } } } },
      sections: [{ children }],
    });
    return Packer.toBlob(d);
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

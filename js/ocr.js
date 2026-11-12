/* hiuhf1 - nhận dạng chữ (OCR) cho PDF scan bằng Tesseract.js, chỉ tải thư viện khi cần */
window.HV = window.HV || {};

(function (HV) {
  // Tesseract.js tự tải thêm worker, lõi WebAssembly và dữ liệu ngôn ngữ từ jsDelivr (khoảng 10-20 MB lần đầu,
  // sau đó trình duyệt giữ lại). integrity: chặn chạy file nếu CDN trả về nội dung bị sửa.
  const SRC = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  const SRI = 'sha384-GJqSu7vueQ9qN0E9yLPb3Wtpd7OrgK8KmYzC8T1IysG1bcvxvIO4qtYR/D3A991F';
  const LANGS = { auto: 'eng', en: 'eng', fr: 'fra', de: 'deu', es: 'spa', 'zh-CN': 'chi_sim', ja: 'jpn', ko: 'kor', ru: 'rus' };
  let libPromise = null;
  const workers = new Map();
  let logger = null;

  function loadLib() {
    if (!libPromise) {
      libPromise = new Promise((resolve, reject) => {
        if (window.Tesseract) { resolve(window.Tesseract); return; }
        const s = document.createElement('script');
        s.src = SRC; s.integrity = SRI; s.crossOrigin = 'anonymous';
        s.onload = () => resolve(window.Tesseract);
        s.onerror = () => { libPromise = null; s.remove(); reject(new Error('Không tải được Tesseract.js (cần mạng)')); };
        document.head.appendChild(s);
      });
    }
    return libPromise;
  }

  function getWorker(lang) {
    if (!workers.has(lang)) {
      const p = loadLib()
        .then(async (T) => {
          const w = await T.createWorker(lang, 1, { logger: (m) => logger && logger(m) });
          // Tesseract.js mặc định coi cả trang là một khối (PSM 6) nên không tách cột;
          // PSM 3 tự nhận bố cục: tách cột, đoạn, dòng như bài báo thật
          await w.setParameters({ tessedit_pageseg_mode: (T.PSM && T.PSM.AUTO) || '3' });
          return w;
        })
        .catch((e) => { workers.delete(lang); throw e; });
      workers.set(lang, p);
    }
    return workers.get(lang);
  }

  HV.ocrLang = (src) => LANGS[src] || 'eng';

  // Nhận dạng chữ một trang PDF. Trả về các đoạn theo cách Tesseract chia, toạ độ PDF (gốc dưới-trái):
  // [{ lines: [{ x0, x1, y: đường cơ sở, top, bottom, size, text, serif }] }] - dùng với HV.ocrBlocks.
  // onProgress({ status, progress }) - thông báo của Tesseract (tải dữ liệu, nhận dạng...)
  HV.ocrPage = async function (page, lang, onProgress) {
    logger = onProgress;
    const worker = await getWorker(lang);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(3, 3000 / Math.max(base.width, base.height)); // khoảng 300 dpi cho trang A4
    const vp = page.getViewport({ scale });
    const cv = document.createElement('canvas');
    cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const { data } = await worker.recognize(cv, {}, { text: true, blocks: true });
    cv.width = cv.height = 0;

    const view = page.view, X = (x) => view[0] + x / scale, Y = (y) => view[3] - y / scale;
    const paras = [];
    for (const bl of data.blocks || []) {
      for (const pa of bl.paragraphs || []) {
        const lines = [];
        for (const ln of pa.lines || []) {
          // giữ cả từ nhận dạng kém trong khung dòng để phủ kín chữ gốc, chỉ bỏ khỏi văn bản đem dịch
          const words = (ln.words || []).filter((w) => (w.text || '').trim());
          const text = words.filter((w) => w.confidence >= 20).map((w) => w.text.trim()).join(' ');
          if (!words.length || !text) continue;
          const lb = ln.bbox, bs = ln.baseline || {};
          const rowH = (ln.rowAttributes && ln.rowAttributes.row_height) || (lb.y1 - lb.y0);
          const cx = (lb.x0 + lb.x1) / 2;
          // đường cơ sở của dòng (có thể hơi nghiêng) tại giữa dòng
          let by = lb.y1 - rowH * 0.2;
          if (bs.has_baseline !== false && bs.x1 > bs.x0) by = bs.y0 + ((bs.y1 - bs.y0) * (cx - bs.x0)) / (bs.x1 - bs.x0);
          lines.push({
            x0: X(lb.x0), x1: X(lb.x1), y: Y(by), top: Y(lb.y0), bottom: Y(lb.y1),
            size: Math.max(4, (rowH / scale) * 0.9), text,
            serif: words.filter((w) => w.is_serif).length > words.length / 2,
          });
        }
        if (lines.length) paras.push({ lines });
      }
    }
    return paras;
  };
})(window.HV);

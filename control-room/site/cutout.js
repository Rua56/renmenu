// Bottiglie su fondo chiaro (foto dai siti delle cantine): lo sfondo diventa trasparente e la foto si ritaglia
// sulla bottiglia, così sulla scheda scura della Control Room non resta un riquadro bianco.
// Come nel menu Premium, ma il colore del fondo si ricava dai bordi (bianco, grigio chiaro o crema).
// La stessa funzione è copiata in blanch/assets/blanch.js per il menu di Trattoria Blanch.
const done = new Map();
export function cutout(img, { max = 640 } = {}) {
  if (!img || img.dataset.cut) return;
  img.dataset.cut = '1';
  const src = img.currentSrc || img.src;
  if (done.has(src)) { const out = done.get(src); if (out) img.src = out; return; }
  try {
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale)), h = Math.max(1, Math.round(img.naturalHeight * scale));
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h), px = data.data;
    const ring = [];
    for (let x = 0; x < w; x++) ring.push(x, (h - 1) * w + x);
    for (let y = 1; y < h - 1; y++) ring.push(y * w, y * w + w - 1);
    const light = ring.filter((p) => px[p * 4 + 3] > 200 && Math.min(px[p * 4], px[p * 4 + 1], px[p * 4 + 2]) > 185);
    // Fondo già trasparente, o bordi non uniformi (foto ambientata): la foto resta com'è.
    if (light.length / ring.length < 0.8) { done.set(src, null); return; }
    const bg = [0, 1, 2].map((c) => light.reduce((t, p) => t + px[p * 4 + c], 0) / light.length);
    const near = (p) => px[p * 4 + 3] > 0 && Math.abs(px[p * 4] - bg[0]) + Math.abs(px[p * 4 + 1] - bg[1]) + Math.abs(px[p * 4 + 2] - bg[2]) < 54;
    const seen = new Uint8Array(w * h), stack = ring.filter(near);
    stack.forEach((p) => { seen[p] = 1; });
    while (stack.length) {
      const p = stack.pop(), x = p % w, y = (p - x) / w;
      px[p * 4 + 3] = 0;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) if (q >= 0 && !seen[q] && near(q)) { seen[q] = 1; stack.push(q); }
    }
    // Bordo morbido: i pixel vicini al fondo tolto e simili al fondo diventano semitrasparenti (niente alone).
    const empty = (q) => px[q * 4 + 3] === 0;
    const soft = [];
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      if (empty(p) || !(empty(p - 1) || empty(p + 1) || empty(p - w) || empty(p + w))) continue;
      const d = Math.abs(px[p * 4] - bg[0]) + Math.abs(px[p * 4 + 1] - bg[1]) + Math.abs(px[p * 4 + 2] - bg[2]);
      soft.push([p, d < 120 ? Math.round(255 * Math.max(0.15, d / 120)) : 255]);
    }
    for (const [p, a] of soft) px[p * 4 + 3] = Math.min(px[p * 4 + 3], a);
    // Ritaglio sulla bottiglia: la miniatura la mostra grande, non persa in un riquadro vuoto.
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (px[(y * w + x) * 4 + 3] > 24) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0 || (x1 - x0) * (y1 - y0) < w * h * 0.02) { done.set(src, null); return; } // tolto quasi tutto: meglio la foto intera
    ctx.putImageData(data, 0, 0);
    const pad = 4, cx = Math.max(0, x0 - pad), cy = Math.max(0, y0 - pad), cw = Math.min(w, x1 + pad + 1) - cx, ch = Math.min(h, y1 + pad + 1) - cy;
    const out = document.createElement('canvas'); out.width = cw; out.height = ch;
    out.getContext('2d').drawImage(cv, cx, cy, cw, ch, 0, 0, cw, ch);
    const url = out.toDataURL('image/png');
    done.set(src, url);
    img.src = url;
  } catch { done.set(src, null); /* immagine di un altro sito senza permesso: resta com'è */ }
}
/** Scontorna le immagini indicate appena caricate. */
export function cutoutAll(root, selector) {
  (root || document).querySelectorAll(selector).forEach((img) => {
    if (img.complete && img.naturalWidth) cutout(img); else img.addEventListener('load', () => cutout(img), { once: true });
  });
}

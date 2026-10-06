// QR del menu pubblicato: Jarvis lo genera da solo dopo il SÌ di Riccardo e la verifica online.
// Standard: QR classico. Premium (e Annuale, che per listino ha il QR con logo): logo del locale al centro.
// Il QR usa la correzione d'errore massima (H) e il logo copre meno del 10% dell'area: resta leggibile.
// Nessun servizio esterno: il codice QR si calcola qui e il PNG si scrive a mano.
import qrcode from './vendor/qrcode.mjs';

export const PUBLIC_ORIGIN = 'https://renmenu.pages.dev';
export const menuLink = (slug) => `${PUBLIC_ORIGIN}/menu/?m=${encodeURIComponent(slug)}`;

export function qrModules(text) {
  const code = qrcode(0, 'H');
  code.addData(String(text), 'Byte');
  code.make();
  const n = code.getModuleCount();
  return { n, dark: (r, c) => code.isDark(r, c) };
}

const QUIET = 4;
// Riquadro del logo (in moduli): largo al massimo il 30% del QR e alto al massimo il 22%.
function logoBox(n, width, height) {
  let w = n * 0.3, h = (w * height) / width;
  if (h > n * 0.22) { h = n * 0.22; w = (h * width) / height; }
  return { w, h, pad: 1.2 };
}
const toBase64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };

/** SVG vettoriale (per la stampa). logo: { mime, bytes, width, height } */
export function qrSvg(url, { logo = null, title = 'QR del menu' } = {}) {
  const { n, dark } = qrModules(url);
  const size = n + QUIET * 2;
  let d = '';
  for (let r = 0; r < n; r += 1) for (let c = 0; c < n; c += 1) if (dark(r, c)) d += `M${c + QUIET} ${r + QUIET}h1v1h-1z`;
  let overlay = '';
  if (logo) {
    const { w, h, pad } = logoBox(n, logo.width, logo.height);
    const x = size / 2 - w / 2, y = size / 2 - h / 2;
    overlay = `<rect x="${(x - pad).toFixed(2)}" y="${(y - pad).toFixed(2)}" width="${(w + pad * 2).toFixed(2)}" height="${(h + pad * 2).toFixed(2)}" rx="1" fill="#fff"/>`
      + `<image x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" preserveAspectRatio="xMidYMid meet" href="data:${logo.mime};base64,${toBase64(logo.bytes)}"/>`;
  }
  const esc = String(title).replace(/[<>&"]/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="1000" height="1000" role="img" aria-label="${esc}"><title>${esc}</title><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/>${overlay}</svg>`;
}

/* ---------- PNG ---------- */
const CRC = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i += 1) { let c = i; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return t; })();
const crc32 = (bytes) => { let c = 0xffffffff; for (let i = 0; i < bytes.length; i += 1) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const u32 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const concat = (parts) => { const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
async function pipe(stream, bytes) { const w = stream.writable.getWriter(); w.write(bytes); w.close(); return new Uint8Array(await new Response(stream.readable).arrayBuffer()); }
const deflate = (bytes) => pipe(new CompressionStream('deflate'), bytes);
const inflate = (bytes) => pipe(new DecompressionStream('deflate'), bytes);
const chunk = (type, data) => { const t = new TextEncoder().encode(type); return concat([u32(data.length), t, data, u32(crc32(concat([t, data])))]); };

/** Scrive un PNG RGB a 8 bit. rgb: w*h*3 byte. */
export async function encodePng(width, height, rgb) {
  const rows = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) rows.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  const header = concat([u32(width), u32(height), new Uint8Array([8, 2, 0, 0, 0])]);
  return concat([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', await deflate(rows)), chunk('IEND', new Uint8Array(0))]);
}

/** Legge un PNG a 8 bit non interlacciato (RGB, RGBA, grigio, grigio+alfa, palette). Altro: null. */
export async function decodePng(bytes) {
  try {
    const sig = [137, 80, 78, 71, 13, 10, 26, 10];
    if (bytes.length < 40 || sig.some((b, i) => bytes[i] !== b)) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let o = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 1, palette = null, trns = null; const idat = [];
    while (o + 8 <= bytes.length) {
      const len = view.getUint32(o), name = String.fromCharCode(...bytes.subarray(o + 4, o + 8)), data = bytes.subarray(o + 8, o + 8 + len);
      if (name === 'IHDR') { width = view.getUint32(o + 8); height = view.getUint32(o + 12); depth = data[8]; type = data[9]; interlace = data[12]; }
      else if (name === 'PLTE') palette = data; else if (name === 'tRNS') trns = data; else if (name === 'IDAT') idat.push(data);
      else if (name === 'IEND') break;
      o += 12 + len;
    }
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
    if (!channels || depth !== 8 || interlace !== 0 || !width || !height || width * height > 16_000_000 || (type === 3 && !palette)) return null;
    const raw = await inflate(concat(idat)), stride = width * channels;
    if (raw.length < (stride + 1) * height) return null;
    const px = new Uint8Array(stride * height);
    for (let y = 0; y < height; y += 1) {
      const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
      for (let x = 0; x < stride; x += 1) {
        const a = x >= channels ? px[y * stride + x - channels] : 0, b = y ? px[(y - 1) * stride + x] : 0, c = x >= channels && y ? px[(y - 1) * stride + x - channels] : 0;
        let v = src[x];
        if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
        else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
        else if (f !== 0) return null;
        px[y * stride + x] = v & 255;
      }
    }
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i += 1) {
      let r, g, b, a = 255;
      if (type === 6) [r, g, b, a] = [px[i * 4], px[i * 4 + 1], px[i * 4 + 2], px[i * 4 + 3]];
      else if (type === 2) [r, g, b] = [px[i * 3], px[i * 3 + 1], px[i * 3 + 2]];
      else if (type === 0) r = g = b = px[i];
      else if (type === 4) { r = g = b = px[i * 2]; a = px[i * 2 + 1]; }
      else { const k = px[i]; [r, g, b] = [palette[k * 3], palette[k * 3 + 1], palette[k * 3 + 2]]; if (trns && k < trns.length) a = trns[k]; }
      rgba.set([r, g, b, a], i * 4);
    }
    return { width, height, rgba };
  } catch { return null; }
}

/** Riduce l'immagine a w×h (media di area) e compone la trasparenza sul bianco: RGB. */
function flatten(img, w, h, out = new Uint8Array(w * h * 3)) {
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const sx0 = Math.floor((x * img.width) / w), sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * img.width) / w));
    const sy0 = Math.floor((y * img.height) / h), sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * img.height) / h));
    let R = 0, G = 0, B = 0, count = 0;
    for (let sy = sy0; sy < sy1; sy += 1) for (let sx = sx0; sx < sx1; sx += 1) {
      const i = (sy * img.width + sx) * 4, a = img.rgba[i + 3] / 255;
      R += img.rgba[i] * a + 255 * (1 - a); G += img.rgba[i + 1] * a + 255 * (1 - a); B += img.rgba[i + 2] * a + 255 * (1 - a); count += 1;
    }
    out.set([Math.round(R / count), Math.round(G / count), Math.round(B / count)], (y * w + x) * 3);
  }
  return out;
}

/** PNG del QR (circa 1000 px). logo: { width, height, rgba } già decodificato. */
export async function qrPng(url, { logo = null } = {}) {
  const { n, dark } = qrModules(url);
  const scale = Math.max(8, Math.ceil(1000 / (n + QUIET * 2))), side = (n + QUIET * 2) * scale;
  const rgb = new Uint8Array(side * side * 3).fill(255);
  for (let r = 0; r < n; r += 1) for (let c = 0; c < n; c += 1) {
    if (!dark(r, c)) continue;
    for (let y = 0; y < scale; y += 1) { const row = ((r + QUIET) * scale + y) * side + (c + QUIET) * scale; rgb.fill(0, row * 3, (row + scale) * 3); }
  }
  if (logo) {
    const { w, h, pad } = logoBox(n, logo.width, logo.height);
    const bw = Math.max(1, Math.round(w * scale)), bh = Math.max(1, Math.round(h * scale)), p = Math.round(pad * scale);
    const x0 = Math.round(side / 2 - bw / 2), y0 = Math.round(side / 2 - bh / 2);
    for (let y = y0 - p; y < y0 + bh + p; y += 1) for (let x = x0 - p; x < x0 + bw + p; x += 1) rgb.fill(255, (y * side + x) * 3, (y * side + x) * 3 + 3);
    const small = flatten(logo, bw, bh);
    for (let y = 0; y < bh; y += 1) rgb.set(small.subarray(y * bw * 3, (y + 1) * bw * 3), ((y0 + y) * side + x0) * 3);
  }
  return encodePng(side, side, rgb);
}

const sniff = (bytes) => (bytes[0] === 137 && bytes[1] === 80 ? 'image/png' : bytes[0] === 255 && bytes[1] === 216 ? 'image/jpeg' : bytes[0] === 82 && bytes[1] === 73 ? 'image/webp' : '');
async function loadLogo(logoUrl, fetchImpl) {
  try {
    const url = new URL(logoUrl);
    if (url.protocol !== 'https:') return null;
    const response = await fetchImpl(url.href, { redirect: 'follow' });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 6_000_000) return null;
    return { bytes, mime: sniff(bytes) };
  } catch { return null; }
}

/** QR completo del menu: PNG e SVG, con il logo se richiesto e leggibile. */
export async function buildMenuQr({ slug, name = '', logoUrl = '', fetchImpl = globalThis.fetch }) {
  const link = menuLink(slug);
  const title = `QR del menu di ${name || slug}`;
  const loaded = logoUrl ? await loadLogo(logoUrl, fetchImpl) : null;
  const decoded = loaded?.mime === 'image/png' ? await decodePng(loaded.bytes) : null;
  // Nel file vettoriale il logo entra ridotto (400 px) e già composto sul bianco: pochi KB invece di megabyte.
  let svgLogo = null;
  if (decoded) {
    const w = Math.min(400, decoded.width), h = Math.max(1, Math.round((decoded.height * w) / decoded.width));
    svgLogo = { mime: 'image/png', bytes: await encodePng(w, h, flatten(decoded, w, h)), width: w, height: h };
  }
  const withLogo = Boolean(decoded);
  return {
    link, withLogo,
    // Logo chiesto ma non leggibile (formato non PNG, file mancante): il QR resta quello classico e Jarvis lo dice.
    logoProblem: logoUrl && !withLogo ? (loaded ? 'il logo non è un PNG leggibile' : 'non riesco a scaricare il logo') : '',
    png: await qrPng(link, { logo: decoded }),
    svg: qrSvg(link, { logo: svgLogo, title })
  };
}

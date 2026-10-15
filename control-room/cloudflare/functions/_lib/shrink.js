// Foto troppo pesanti per il menu pubblico (oltre 900 KB): Jarvis le riduce da solo, nel Worker,
// senza servizi esterni. JPEG e PNG senza trasparenza diventano un JPEG di al massimo 1600 px
// sul lato lungo, raddrizzato secondo l'orientamento EXIF del telefono. Un PNG trasparente (logo),
// un WebP o un file che non si decodifica restano a Riccardo, come prima.
import { decodeRGB } from './vendor/jpeg-decode.js';
import { encode as encodeJpeg } from './vendor/jpeg-encode.js';

const MAX_SOURCE_BYTES = 12_000_000;
// Memoria del Worker (128 MB): per una foto da 12 MP il decoder tiene ~37 MB di coefficienti e ~18 MB di piani;
// l'RGB nasce già ridotto (al massimo 3200 px). Oltre i 24 MP (es. 48 MP a piena risoluzione) resta a Riccardo.
const MAX_PIXELS = 24_500_000;

/** Orientamento EXIF (1–8) di un JPEG; 1 se manca. */
export function jpegOrientation(bytes) {
  let i = 2;
  while (i + 4 < bytes.length && bytes[i] === 0xff) {
    const marker = bytes[i + 1], size = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker === 0xe1 && String.fromCharCode(...bytes.subarray(i + 4, i + 8)) === 'Exif') {
      const t = i + 10, little = bytes[t] === 0x49;
      const u16 = (o) => (little ? bytes[o] | (bytes[o + 1] << 8) : (bytes[o] << 8) | bytes[o + 1]);
      const u32 = (o) => (little ? (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16)) + bytes[o + 3] * 2 ** 24 : bytes[o] * 2 ** 24 + ((bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]));
      const ifd = t + u32(t + 4);
      const count = ifd + 2 <= bytes.length ? u16(ifd) : 0;
      for (let n = 0; n < count; n += 1) {
        const e = ifd + 2 + n * 12;
        if (e + 10 > bytes.length) break;
        if (u16(e) === 0x0112) { const v = u16(e + 8); return v >= 1 && v <= 8 ? v : 1; }
      }
      return 1;
    }
    if (marker === 0xda) break;
    i += 2 + size;
  }
  return 1;
}

async function inflate(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** PNG 8 bit non interlacciato → RGBA; null se non gestito. `opaque` dice se è senza trasparenza. */
export async function decodePng(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0, palette = null, trns = null;
  const idat = [];
  while (i + 8 <= bytes.length) {
    const len = view.getUint32(i), name = String.fromCharCode(...bytes.subarray(i + 4, i + 8));
    const body = bytes.subarray(i + 8, i + 8 + len);
    if (name === 'IHDR') { width = view.getUint32(i + 8); height = view.getUint32(i + 12); depth = body[8]; type = body[9]; interlace = body[12]; }
    else if (name === 'PLTE') palette = body;
    else if (name === 'tRNS') trns = body;
    else if (name === 'IDAT') idat.push(body);
    else if (name === 'IEND') break;
    i += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!width || !height || depth !== 8 || interlace || !channels || width * height > MAX_PIXELS) return null;
  const joined = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let at = 0; for (const c of idat) { joined.set(c, at); at += c.length; }
  const raw = await inflate(joined);
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride, prev = row - stride;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? px[row + x - channels] : 0, b = y ? px[prev + x] : 0, c = y && x >= channels ? px[prev + x - channels] : 0;
      let v = raw[src + x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      else if (filter !== 0) return null;
      px[row + x] = v & 255;
    }
  }
  const data = new Uint8Array(width * height * 4);
  let opaque = true;
  for (let p = 0, q = 0; p < width * height; p += 1, q += channels) {
    let r, g, bl, al = 255;
    if (type === 0) { r = g = bl = px[q]; }
    else if (type === 4) { r = g = bl = px[q]; al = px[q + 1]; }
    else if (type === 2) { r = px[q]; g = px[q + 1]; bl = px[q + 2]; }
    else if (type === 6) { r = px[q]; g = px[q + 1]; bl = px[q + 2]; al = px[q + 3]; }
    else { const k = px[q]; if (!palette || k * 3 + 2 >= palette.length) return null; r = palette[k * 3]; g = palette[k * 3 + 1]; bl = palette[k * 3 + 2]; if (trns && k < trns.length) al = trns[k]; }
    if (al < 250) opaque = false;
    data[p * 4] = r; data[p * 4 + 1] = g; data[p * 4 + 2] = bl; data[p * 4 + 3] = 255;
  }
  return { width, height, data, opaque };
}

// Riduzione per media d'area (nitida e senza scalini), poi rotazione dell'immagine già piccola.
function boxResize(img, w, h) {
  const c = img.channels || 4, out = new Uint8Array(w * h * 4), sx = img.width / w, sy = img.height / h;
  for (let y = 0; y < h; y += 1) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x += 1) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy += 1) {
        let o = (yy * img.width + x0) * c;
        for (let xx = x0; xx < x1; xx += 1, o += c) { r += img.data[o]; g += img.data[o + 1]; b += img.data[o + 2]; n += 1; }
      }
      const d = (y * w + x) * 4;
      out[d] = r / n; out[d + 1] = g / n; out[d + 2] = b / n; out[d + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}
function orient(img, o) {
  if (o === 1 && (img.channels || 4) === 4) return img;
  const { width: w, height: h, data } = img, c = img.channels || 4, swap = o >= 5;
  const W = swap ? h : w, H = swap ? w : h, out = new Uint8Array(W * H * 4);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    let X, Y;
    switch (o) {
      case 1: X = x; Y = y; break;
      case 2: X = w - 1 - x; Y = y; break;
      case 3: X = w - 1 - x; Y = h - 1 - y; break;
      case 4: X = x; Y = h - 1 - y; break;
      case 5: X = y; Y = x; break;
      case 6: X = h - 1 - y; Y = x; break;
      case 7: X = h - 1 - y; Y = w - 1 - x; break;
      default: X = y; Y = w - 1 - x; // 8
    }
    const s = (y * w + x) * c, d = (Y * W + X) * 4;
    out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2]; out[d + 3] = 255;
  }
  return { width: W, height: H, data: out };
}

/**
 * Riduce una foto sotto maxBytes. Ritorna { bytes, mime:'image/jpeg', width, height } oppure
 * { ok:false, reason } se non si può fare da soli (trasparenza, formato, file rovinato).
 */
export async function shrinkPhoto(bytes, mime, { maxBytes = 900_000, maxSide = 1600 } = {}) {
  if (!bytes?.length || bytes.length > MAX_SOURCE_BYTES) return { ok: false, reason: 'file troppo grande anche da ridurre' };
  let img, orientation = 1;
  try {
    if (mime === 'image/jpeg') {
      // Il decoder campiona già al doppio della misura finale (meno memoria); la media d'area fa il resto.
      img = { ...decodeRGB(bytes, { maxSide: maxSide * 2, maxResolutionInMP: MAX_PIXELS / 1e6, maxMemoryUsageInMB: 120 }), channels: 3 };
      orientation = jpegOrientation(bytes);
    } else if (mime === 'image/png') {
      img = await decodePng(bytes);
      if (!img) return { ok: false, reason: 'PNG in un formato che non riduco da solo' };
      if (!img.opaque) return { ok: false, reason: 'PNG con trasparenza (es. logo): va ridotto senza perdere lo sfondo trasparente' };
    } else return { ok: false, reason: 'formato che non riduco da solo' };
  } catch { return { ok: false, reason: 'foto che non riesco a leggere' }; }
  for (const [side, quality] of [[maxSide, 82], [maxSide, 72], [Math.round(maxSide * 0.8), 72], [Math.round(maxSide * 0.6), 68]]) {
    const scale = Math.min(1, side / Math.max(img.width, img.height));
    const small = orient(scale < 1 ? boxResize(img, Math.max(1, Math.round(img.width * scale)), Math.max(1, Math.round(img.height * scale))) : img, orientation);
    const out = new Uint8Array(encodeJpeg(small, quality).data);
    if (out.length <= maxBytes) return { ok: true, bytes: out, mime: 'image/jpeg', width: small.width, height: small.height };
  }
  return { ok: false, reason: 'non scende sotto i 900 KB' };
}

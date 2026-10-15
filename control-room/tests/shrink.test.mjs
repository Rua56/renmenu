import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deflateSync } from 'node:zlib';
import { decodePng, jpegOrientation, shrinkPhoto } from '../cloudflare/functions/_lib/shrink.js';
import { decodeRGB } from '../cloudflare/functions/_lib/vendor/jpeg-decode.js';
import { encode as encodeJpeg } from '../cloudflare/functions/_lib/vendor/jpeg-encode.js';

// Immagine di prova: rumore (si comprime male) con un quadrato rosso in alto a sinistra.
function picture(w, h, alpha = 255) {
  const data = new Uint8Array(w * h * 4);
  let seed = 3;
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const i = (y * w + x) * 4;
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const red = x < w / 8 && y < h / 8;
    data[i] = red ? 255 : seed >> 23; data[i + 1] = red ? 0 : (seed >> 15) & 255; data[i + 2] = red ? 0 : (seed >> 7) & 255; data[i + 3] = alpha;
  }
  return { width: w, height: h, data };
}
// JPEG con l'orientamento EXIF scritto come fanno i telefoni (APP1 subito dopo SOI).
function withOrientation(jpeg, value) {
  const tiff = [0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, value, 0, 0, 0, 0, 0, 0];
  const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const app1 = [0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255, ...body];
  return new Uint8Array([...jpeg.subarray(0, 2), ...app1, ...jpeg.subarray(2)]);
}
function png(img) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (name, data) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(name, 4, 'ascii'); Buffer.from(data).copy(out, 8); out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length); return out; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(img.width, 0); ihdr.writeUInt32BE(img.height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((img.width * 4 + 1) * img.height);
  for (let y = 0; y < img.height; y += 1) { raw[y * (img.width * 4 + 1)] = y % 2 ? 2 : 1; for (let x = 0; x < img.width * 4; x += 1) {
    const v = img.data[y * img.width * 4 + x], left = x >= 4 ? img.data[y * img.width * 4 + x - 4] : 0, up = y ? img.data[(y - 1) * img.width * 4 + x] : 0;
    raw[y * (img.width * 4 + 1) + 1 + x] = (v - (y % 2 ? up : left)) & 255; } }
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

describe('Foto pesanti ridotte da Jarvis', () => {
  it('JPEG da telefono oltre 900 KB: sotto i 900 KB, lato lungo 1600 px, raddrizzato secondo l’EXIF', async () => {
    const source = withOrientation(new Uint8Array(encodeJpeg(picture(2400, 1800), 95).data), 6);
    assert.ok(source.length > 900_000);
    assert.equal(jpegOrientation(source), 6);
    const out = await shrinkPhoto(source, 'image/jpeg');
    assert.equal(out.ok, true, out.reason);
    assert.ok(out.bytes.length <= 900_000);
    assert.equal(out.mime, 'image/jpeg');
    assert.ok(Math.max(out.width, out.height) <= 1600);
    assert.ok(out.height > out.width, 'girata di 90°: ora è verticale');
    const back = decodeRGB(out.bytes);
    const at = (x, y) => back.data.subarray((y * back.width + x) * 3, (y * back.width + x) * 3 + 3);
    const [r, g] = at(back.width - 10, 10);
    assert.ok(r > 200 && g < 60, 'il quadrato rosso (in alto a sinistra nella foto originale) è in alto a destra');
  });
  it('PNG senza trasparenza diventa JPEG; PNG trasparente (logo) resta a Riccardo', async () => {
    const opaque = png(picture(700, 700));
    assert.ok((await decodePng(opaque)).opaque);
    const out = await shrinkPhoto(opaque, 'image/png', { maxBytes: 600_000 });
    assert.equal(out.ok, true, out.reason);
    assert.ok(out.bytes.length <= 600_000);
    assert.deepEqual([...out.bytes.subarray(0, 3)], [0xff, 0xd8, 0xff]);
    const logo = await shrinkPhoto(png(picture(300, 300, 0)), 'image/png');
    assert.equal(logo.ok, false);
    assert.match(logo.reason, /trasparenza/);
  });
  it('file rovinati o formati non gestiti: nessuna eccezione, solo il motivo', async () => {
    const broken = new Uint8Array(2000); broken.set([0xff, 0xd8, 0xff, 0xe0]);
    assert.equal((await shrinkPhoto(broken, 'image/jpeg')).ok, false);
    assert.match((await shrinkPhoto(new Uint8Array(10), 'image/webp')).reason, /formato/);
  });
});

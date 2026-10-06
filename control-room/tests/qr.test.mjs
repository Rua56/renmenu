import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMenuQr, decodePng, encodePng, menuLink, qrModules, qrPng, qrSvg } from '../cloudflare/functions/_lib/qr.js';

const rgbaLogo = async (w, h) => {
  const rgb = new Uint8Array(w * h * 3); for (let i = 0; i < w * h; i += 1) rgb.set([20, 90, 40], i * 3);
  return encodePng(w, h, rgb);
};
const asFetch = (bytes) => async () => ({ ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) });

test('il link del menu è quello stabile della pagina pubblica', () => {
  assert.equal(menuLink('osteria-codelli-23'), 'https://renmenu.pages.dev/menu/?m=osteria-codelli-23');
});

test('PNG scritto e riletto: stessi pixel', async () => {
  const rgb = new Uint8Array(4 * 3 * 3); rgb.set([255, 0, 0], 0); rgb.set([0, 255, 0], 3 * 5);
  const back = await decodePng(await encodePng(4, 3, rgb));
  assert.equal(back.width, 4); assert.equal(back.height, 3);
  assert.deepEqual([...back.rgba.subarray(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual([...back.rgba.subarray(5 * 4, 5 * 4 + 4)], [0, 255, 0, 255]);
  assert.equal(await decodePng(new Uint8Array([1, 2, 3])), null);
});

test('QR classico: nessun logo, tre angoli di riferimento e dimensione stabile', async () => {
  const { n, dark } = qrModules(menuLink('bakaro'));
  assert.ok(n >= 25 && n <= 45);
  for (const [r, c] of [[0, 0], [0, n - 1], [n - 1, 0]]) assert.equal(dark(r, c), true);
  const svg = qrSvg(menuLink('bakaro'));
  assert.doesNotMatch(svg, /<image/);
  const png = await decodePng(await qrPng(menuLink('bakaro')));
  assert.ok(png.width >= 900 && png.width === png.height);
});

test('QR con logo: logo PNG al centro, centro bianco intorno e angoli intatti', async () => {
  const logo = await rgbaLogo(200, 100);
  const out = await buildMenuQr({ slug: 'codelli', name: 'Codelli', logoUrl: 'https://x.test/logo.png', fetchImpl: asFetch(logo) });
  assert.equal(out.withLogo, true); assert.equal(out.logoProblem, '');
  assert.match(out.svg, /<image[^>]+href="data:image\/png;base64,/);
  const img = await decodePng(out.png), mid = Math.floor(img.width / 2);
  const at = (x, y) => [...img.rgba.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)];
  assert.deepEqual(at(mid, mid), [20, 90, 40]);
  // Appena fuori dal riquadro del logo ma dentro il margine bianco di sicurezza: bianco.
  const { n } = qrModules(menuLink('codelli'));
  assert.deepEqual(at(mid, Math.round(mid - ((0.15 * n) / 2 + 0.6) * (img.width / (n + 8)))), [255, 255, 255]);
  const plain = await decodePng((await buildMenuQr({ slug: 'codelli', name: 'Codelli' })).png);
  assert.deepEqual(at(3 * 30, 3 * 30), [...plain.rgba.subarray((90 * plain.width + 90) * 4, (90 * plain.width + 90) * 4 + 3)]);
});

test('logo che non si legge: QR classico e motivo dichiarato', async () => {
  const jpeg = new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70, 73, 70]);
  const a = await buildMenuQr({ slug: 's', name: 'S', logoUrl: 'https://x.test/l.jpg', fetchImpl: asFetch(jpeg) });
  assert.equal(a.withLogo, false); assert.match(a.logoProblem, /non è un PNG/);
  assert.doesNotMatch(a.svg, /<image/);
  const b = await buildMenuQr({ slug: 's', name: 'S', logoUrl: 'https://x.test/l.png', fetchImpl: async () => ({ ok: false }) });
  assert.equal(b.withLogo, false); assert.match(b.logoProblem, /non riesco a scaricare/);
  const c = await buildMenuQr({ slug: 's', name: 'S', logoUrl: 'http://x.test/l.png', fetchImpl: asFetch(jpeg) });
  assert.equal(c.withLogo, false);
});

// Foto delle bottiglie dai siti delle cantine: solo pagine trovate con la ricerca e solo la foto
// in cui il modello riconosce l'etichetta di quel vino.
import assert from 'node:assert/strict';
import test from 'node:test';
import { findBottle, imageCandidates, parseSourceNote, publicHttps, sourceNote, winesWithoutPhoto } from '../cloudflare/functions/_lib/bottle-search.js';
import { menuSlots, slotFrequencies } from '../cloudflare/functions/_lib/media.js';

const menu = { id: 'x', nome: 'X', premium: {}, sezioni: [
  { nome: { it: 'Vini bianchi' }, voci: [
    { nome: { it: 'Ribolla Gialla — Primosic' }, prezzo: '28,00' },
    { nome: { it: 'Friulano — Ronco dei Tassi' }, prezzo: '26,00', foto: '../menus/media/a.webp' }] },
  { nome: { it: 'Cicchetti' }, voci: [{ nome: { it: 'Frico' }, prezzo: '9,00' }] }] };

test('vini senza foto, già cercati esclusi', () => {
  assert.deepEqual(winesWithoutPhoto(menu).map((s) => s.name), ['Ribolla Gialla — Primosic']);
  assert.deepEqual(winesWithoutPhoto(menu, ['Ribolla Gialla — Primosic']), []);
});

test('solo indirizzi https pubblici', () => {
  assert.equal(publicHttps('https://www.primosic.com/vini/ribolla#x'), 'https://www.primosic.com/vini/ribolla');
  for (const bad of ['http://primosic.com', 'https://127.0.0.1/a.jpg', 'https://localhost/a', 'https://user:pw@x.com/', 'https://x.com:8443/', 'javascript:alert(1)', 'ftp://x.com']) assert.equal(publicHttps(bad), null, bad);
});

test('immagini candidate: og:image e immagini che nominano il vino, mai loghi o icone', () => {
  const html = `<html><head><meta property="og:image" content="/media/ribolla-gialla-bottiglia.png"></head><body>
    <img src="/img/logo-primosic.png" alt="Primosic"><img data-src="https://cdn.primosic.com/wp/ribolla-gialla-riserva.jpg?w=800" alt="Ribolla Gialla Riserva">
    <img src="/img/vigneto.jpg" alt="Le nostre vigne"><img src="data:image/png;base64,AAAA" alt="Ribolla"></body></html>`;
  const list = imageCandidates(html, 'https://www.primosic.com/vini/ribolla', 'Ribolla Gialla — Primosic');
  assert.deepEqual(list, ['https://www.primosic.com/media/ribolla-gialla-bottiglia.png', 'https://cdn.primosic.com/wp/ribolla-gialla-riserva.jpg?w=800']);
});

test('fonte salvata e riletta', () => {
  const [slot] = winesWithoutPhoto(menu);
  assert.deepEqual(parseSourceNote(sourceNote(slot, 'https://a.it/p', 'https://a.it/i.jpg')), { page: 'https://a.it/p', image: 'https://a.it/i.jpg', wine: 'Ribolla Gialla — Primosic' });
});

const jpeg = new Uint8Array(6000); jpeg.set([0xff, 0xd8, 0xff, 0xe0]);
const fakeWeb = (pages) => async (url, options = {}) => {
  url = String(url);
  if (url.startsWith('https://generativelanguage.googleapis.com/')) {
    const body = JSON.parse(options.body);
    assert.deepEqual(body.tools, [{ google_search: {} }]);
    return Response.json({ candidates: [{ content: { parts: [{ text: '{"pagine":["https://www.primosic.com/vini/ribolla"]}' }] }, groundingMetadata: { groundingChunks: [{ web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc' } }] } }] });
  }
  if (pages[url]) return new Response(pages[url], { headers: { 'content-type': 'text/html; charset=utf-8' } });
  if (/\.(?:jpe?g|png)/.test(url)) return new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } });
  return new Response('no', { status: 404 });
};

test('trova la bottiglia giusta e scarta quella di un altro vino', async () => {
  const pages = { 'https://www.primosic.com/vini/ribolla': '<meta property="og:image" content="https://www.primosic.com/foto/collio-bianco.jpg"><img src="https://www.primosic.com/foto/ribolla-gialla.jpg" alt="Ribolla Gialla">' };
  const labels = { 'collio-bianco': { nome: 'Collio Bianco', cantina: 'Primosic' }, 'ribolla-gialla': { nome: 'Ribolla Gialla', cantina: 'Primosic' } };
  let n = 0;
  const order = ['ribolla-gialla', 'collio-bianco'];
  const classify = async () => ({ ok: true, kind: 'bottiglia', description: 'bottiglia di vino bianco', label: labels[order[n++] || 'collio-bianco'] });
  const [slot] = winesWithoutPhoto(menu);
  const res = await findBottle({ key: 'k', models: ['gemini-2.5-flash'] }, slot, slotFrequencies(menuSlots(menu)), { classify, fetchImpl: fakeWeb(pages) });
  assert.ok(res.found, JSON.stringify(res));
  assert.equal(res.found.page, 'https://www.primosic.com/vini/ribolla');
  assert.equal(res.found.mime, 'image/jpeg');
  const wrong = await findBottle({ key: 'k', models: [] }, slot, slotFrequencies(menuSlots(menu)), { classify: async () => ({ ok: true, kind: 'bottiglia', label: { nome: 'Pinot Grigio', cantina: 'Altra' } }), fetchImpl: fakeWeb(pages) });
  assert.equal(wrong.found, undefined);
  assert.match(wrong.reason, /etichetta/);
  const notBottle = await findBottle({ key: 'k', models: [] }, slot, slotFrequencies(menuSlots(menu)), { classify: async () => ({ ok: true, kind: 'locale', label: {} }), fetchImpl: fakeWeb(pages) });
  assert.equal(notBottle.found, undefined);
  assert.deepEqual(await findBottle(null, slot, new Map(), { classify }), { reason: 'nessuna pagina trovata' });
});

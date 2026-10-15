// Foto delle bottiglie dai siti delle cantine: solo pagine trovate con la ricerca e solo la foto
// in cui il modello riconosce l'etichetta di quel vino.
import assert from 'node:assert/strict';
import test from 'node:test';
import { blanchProducers, findBottle, imageCandidates, producerMatch, parseSourceNote, publicHttps, sourceNote, winesWithoutPhoto } from '../cloudflare/functions/_lib/bottle-search.js';
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

test('un «%» non valido nell’indirizzo di un’immagine (siti veri) non fa cadere la ricerca', () => {
  const html = '<img src="/foto/ribolla-gialla-100%-collio.jpg" alt="Ribolla Gialla"><img src="/foto/%E0%A4%A.jpg" alt="Ribolla Gialla bottiglia">';
  const list = imageCandidates(html, 'https://www.primosic.com/vini/ribolla', 'Ribolla Gialla — Primosic');
  assert.equal(list.length, 2);
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
  assert.deepEqual(await findBottle(null, slot, new Map(), { classify }), { reason: 'nessuna pagina trovata (manca la chiave Gemini)' });
});

test('la ricerca usa prima i modelli che stanno rispondendo, senza «pensiero», e dice perché non trova', async () => {
  const [slot] = winesWithoutPhoto(menu);
  const asked = [];
  const fetchImpl = async (url, options = {}) => {
    const model = /models\/([^:]+):/.exec(String(url))[1];
    asked.push([model, JSON.parse(options.body).generationConfig]);
    return new Response('{}', { status: model === 'gemini-3.1-flash-lite' ? 429 : 404 });
  };
  const res = await findBottle({ key: 'k', models: ['gemini-3.1-flash-lite', 'gemini-2.5-flash'] }, slot, new Map(), { classify: async () => null, fetchImpl });
  assert.deepEqual(asked.map(([m]) => m), ['gemini-3.1-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']);
  assert.deepEqual(asked[1][1].thinkingConfig, { thinkingBudget: 0 }, 'il pensiero non consuma la risposta');
  assert.ok(asked[1][1].maxOutputTokens >= 2048);
  assert.equal(res.reason, 'nessuna pagina trovata (gemini-3.1-flash-lite 429, gemini-2.5-flash 404, gemini-2.5-flash-lite 404)');
});

test('Trattoria Blanch: un vitigno uguale di un\'altra cantina non vale', async () => {
  const slot = blanchProducers([{ wine: true, name: 'Friulano', descr: 'Borgo Trevisan · Gradisca d’Isonzo', key: 'Friulano · Borgo Trevisan · Gradisca d’Isonzo' }])[0];
  assert.equal(slot.producer, 'Borgo Trevisan');
  assert.equal(producerMatch(slot, { label: { nome: 'Friulano', cantina: 'Borgo Trevisan' } }), true);
  assert.equal(producerMatch(slot, { label: { nome: 'Friulano' }, page: 'https://www.borgotrevisan.it/vini/friulano' }), true);
  assert.equal(producerMatch(slot, { label: { nome: 'Friulano', cantina: 'Livio Felluga' }, page: 'https://www.liviofelluga.it/friulano' }), false);
  // «Borgo» da solo è di troppe cantine
  assert.equal(producerMatch(slot, { label: { nome: 'Friulano', cantina: 'Borgo San Daniele' } }), false);
  // Senza produttore separato (carte Premium) il controllo non si fa
  assert.equal(producerMatch({ wine: true, name: 'Friulano', descr: 'Uve friulano, acciaio' }, { label: { cantina: 'Altra' } }), true);

  const pages = { 'https://www.primosic.com/vini/ribolla': '<meta property="og:image" content="https://www.primosic.com/foto/friulano.jpg">' };
  const wrong = await findBottle({ key: 'k', models: [] }, slot, slotFrequencies([slot]), { classify: async () => ({ ok: true, kind: 'bottiglia', label: { nome: 'Friulano', cantina: 'Primosic' } }), fetchImpl: fakeWeb(pages) });
  assert.equal(wrong.found, undefined);
  assert.match(wrong.reason, /cantina/);
});

test('nomi scritti a modo loro nella carta: «Schioppetto» ritrova Schiopetto; le foto indicate dalla ricerca si provano per prime', async () => {
  const slot = blanchProducers([{ wine: true, name: 'Friulano', descr: 'Schioppetto · Capriva del Friuli', key: 'Friulano · Schioppetto · Capriva del Friuli' }])[0];
  assert.equal(producerMatch(slot, { label: { nome: 'Friulano', cantina: 'Schiopetto' } }), true);
  assert.equal(producerMatch(slot, { label: { nome: 'Friulano' }, page: 'https://www.schiopetto.it/vini/friulano' }), true);
  assert.equal(producerMatch(slot, { label: { nome: 'Friulano', cantina: 'Scolaris' } }), false);

  const fetchImpl = async (url) => {
    url = String(url);
    if (url.startsWith('https://generativelanguage.googleapis.com/')) return Response.json({ candidates: [{ content: { parts: [{ text: '{"pagine":["https://shop.example.com/friulano-schiopetto"],"immagini":["https://shop.example.com/img/p123.jpg"]}' }] } }] });
    if (url === 'https://shop.example.com/img/p123.jpg') return new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } });
    return new Response('no', { status: 403 });
  };
  const res = await findBottle({ key: 'k', models: [] }, slot, slotFrequencies([slot]), { classify: async () => ({ ok: true, kind: 'bottiglia', label: { nome: 'Friulano', cantina: 'Schiopetto' } }), fetchImpl });
  assert.ok(res.found, JSON.stringify(res));
  assert.equal(res.found.image, 'https://shop.example.com/img/p123.jpg');
  assert.equal(res.found.page, 'https://shop.example.com/friulano-schiopetto');
  // Pagine che non si aprono: lo dice chiaro.
  const closed = await findBottle({ key: 'k', models: [] }, slot, slotFrequencies([slot]), { classify: async () => null, fetchImpl: async (url) => String(url).startsWith('https://generativelanguage') ? Response.json({ candidates: [{ content: { parts: [{ text: '{"pagine":["https://a.example.com/x"]}' }] } }] }) : new Response('no', { status: 403 }) });
  assert.match(closed.reason, /non si aprono/);
});

test('sul sito della cantina vale anche una foto senza il nome del vino nel file', () => {
  const html = '<img src="/wp-content/uploads/IMG_4471.jpg" alt=""><img srcset="/a-300.jpg 300w, /a-900.jpg 900w">';
  assert.deepEqual(imageCandidates(html, 'https://www.schiopetto.it/friulano', 'Friulano Schioppetto'), []);
  assert.deepEqual(imageCandidates(html, 'https://www.schiopetto.it/friulano', 'Friulano Schioppetto', true).sort(), ['https://www.schiopetto.it/a-900.jpg', 'https://www.schiopetto.it/wp-content/uploads/IMG_4471.jpg']);
});

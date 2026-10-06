import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractVenueInfo, applyVenueInfo } from '../cloudflare/functions/_lib/venue-info.js';
import { prepareUpdate } from '../cloudflare/functions/_lib/update.js';
import { extractMenuFromText } from '../cloudflare/functions/_lib/menu.js';
import { reviewNotes, notesSummary } from '../cloudflare/functions/_lib/notes.js';
import { closestWord } from '../cloudflare/functions/_lib/typos.js';
import { guessIntent } from '../cloudflare/functions/_lib/understanding.js';

const val = (text) => Object.fromEntries(Object.entries(extractVenueInfo(text).found).map(([k, v]) => [k, v.doubt && !v.value ? `?${v.doubt}` : v.value]));
const FARO = readFileSync(new URL('./fixtures-faro.txt', import.meta.url), 'utf8');

test('refusi: parole chiave corrette, parole corte e numeri intatti', () => {
  assert.equal(closestWord('copreto', ['coperto']), 'coperto');
  assert.equal(closestWord('telfono', ['telefono']), 'telefono');
  assert.equal(closestWord('instgram', ['instagram']), 'instagram');
  assert.equal(closestWord('facebok', ['facebook']), 'facebook');
  assert.equal(closestWord('coppa', ['coperto']), null);
  assert.equal(closestWord('tel', ['telefono']), null);
});

test('email Al Faro: coperto, telefono, orari e Instagram inseriti', () => {
  const r = extractMenuFromText('Ristorante Al Faro', FARO);
  const info = applyVenueInfo(r.menu, extractVenueInfo(FARO));
  assert.equal(info.menu.coperto, '2,50');
  assert.equal(info.menu.telefono, '0431 123456');
  assert.equal(info.menu.instagram, 'alfarograd0');
  assert.deepEqual(info.menu.orari, { it: '12:00–14:30 e 19:00–22:30 · Chiuso il martedì', en: '12:00–14:30 and 19:00–22:30 · Closed on Tuesday' });
  assert.ok(!r.menu.sezioni.flatMap((s) => s.voci).some((v) => /coperto/i.test(v.nome.it)));
  const notes = reviewNotes({ sourceText: FARO, uncertain: r.uncertain, extracted: r.extracted, info });
  assert.equal(notes.filter((n) => n.kind === 'inserito').length, 2);
  assert.match(notesSummary(notes), /Ho inserito dal testo: Coperto 2,50 €/);
});

test('scritto male e tutto su una riga: capisce lo stesso', () => {
  const v = val('Il copreto è di 2 euro a persona.\nSiamo aperti dal martedì alla domenica 11.30-15 e 18.30-23, lunedì chiuso\nPer prenotare chiamate il 347 1234567 oppure seguiteci su instgram @bar.centrale e su facebok Bar Centrale Gorizia');
  assert.equal(v.coperto, '2,00'); assert.equal(v.telefono, '347 1234567'); assert.equal(v.instagram, 'bar.centrale');
  assert.equal(v.facebook, 'Bar Centrale Gorizia'); assert.equal(v.orari, '11:30–15:00 e 18:30–23:00 · Chiuso il lunedì');
  assert.equal(val('Orari: lun-ven 7-20, sab 8-13').orari, 'Lunedì–venerdì 07:00–20:00 · Sabato 08:00–13:00');
  assert.equal(val('facebook.com/osteriadamario, coperto 3€').facebook, 'https://facebook.com/osteriadamario');
});

test('nei dubbi non inserisce e chiede', () => {
  assert.match(val('Tel. 0431/80123 - cell. 333 9876543').telefono, /^\?.*quale/);
  assert.match(val('il coperto è 25 euro').coperto, /25,00/);
  assert.equal(applyVenueInfo({}, extractVenueInfo('il coperto è 25 euro')).applied.length, 0);
  assert.equal(applyVenueInfo({}, extractVenueInfo('instagram chiocciola al bakaro')).applied.length, 0);
  assert.match(applyVenueInfo({}, extractVenueInfo('instagram chiocciola al bakaro punto go')).warnings.join(' '), /@albakaro\.go/);
  assert.equal(Object.keys(val('Spaghetti alle vongole 16 €')).length, 0);
});

const LIVE = { id: 'bakaro', nome: 'Bakaro', lingue: ['it'], telefono: '0481 111111', sezioni: [{ nome: { it: 'Primi' }, voci: [{ nome: { it: 'Bigoli' }, prezzo: '12,00' }] }] };
test('aggiornamenti a voce o da email: info del locale insieme ai prezzi', () => {
  let u = prepareUpdate({ slug: 'bakaro', current: LIVE, sha: 'abc1234', sourceText: 'il nuovo numero di telefono è 0481 222333 e il copreto passa a 3 euro', subject: 'voce' });
  assert.ok(u.ok); assert.equal(u.extraction.menu.telefono, '0481 222333'); assert.equal(u.extraction.menu.coperto, '3,00');
  u = prepareUpdate({ slug: 'bakaro', current: LIVE, sha: 'abc1234', sourceText: 'i bigoli passano a 13 euro, orari nuovi: mar-dom 18-24, lunedì chiuso', subject: 'email' });
  assert.equal(u.extraction.menu.sezioni[0].voci[0].prezzo, '13,00'); assert.deepEqual(u.extraction.menu.orari, { it: '18:00–24:00 · Chiuso il lunedì', en: '18:00–24:00 · Closed on Monday' });
  u = prepareUpdate({ slug: 'bakaro', current: LIVE, sha: 'a', sourceText: 'aggiungete su instagram @bakaro.go e su facebook facebook.com/bakarogorizia', subject: 'email' });
  assert.equal(u.extraction.menu.instagram, 'bakaro.go'); assert.equal(u.extraction.menu.facebook, 'https://facebook.com/bakarogorizia');
  assert.deepEqual(u.extraction.menu.sezioni, LIVE.sezioni);
});

test('comandi con refusi: Jarvis capisce il compito', () => {
  const locales = [{ name: 'Bakaro', menu_id: 'bakaro' }];
  assert.equal(guessIntent('agiungi il copreto di 2 euro al bakaro', { locales }).intent, 'aggiorna_menu');
  assert.equal(guessIntent('il telfono del bakaro è 0481 301245', { locales }).intent, 'aggiorna_menu');
  assert.equal(guessIntent('pubblca il bakaro', { locales }).intent, 'pubblica');
  assert.equal(guessIntent('che orari ha il bakaro?', { locales }).intent, 'risposta');
});

test('Indirizzo scritto nel testo: via e città in qualsiasi ordine; frasi che non sono indirizzi ignorate', () => {
  const v = (t) => extractVenueInfo(t).found.indirizzo?.value || null;
  assert.equal(v("sono Marta, titolare dell'Enoteca Isonzo a Gorizia, in via Rastello 12. Vorremmo il Premium."), 'Via Rastello 12, Gorizia');
  assert.equal(v('Indirizzo: Via Roma 5, 34170 Gorizia'), 'Via Roma 5, Gorizia');
  assert.equal(v('Siamo in piazza della Vittoria 59 a Gorizia'), 'Piazza della Vittoria 59, Gorizia');
  assert.equal(v('Il risotto della via lattea 3 persone'), null);
  assert.equal(v('Frico con polenta — 12'), null);
});

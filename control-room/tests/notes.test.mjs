import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractMenuFromText, specialPriceRow, priceRow } from '../cloudflare/functions/_lib/menu.js';
import { reviewNotes, notesSummary } from '../cloudflare/functions/_lib/notes.js';
import { classifyRequest } from '../cloudflare/functions/_lib/autopilot.js';

const FARO = readFileSync(new URL('./fixtures-faro.txt', import.meta.url), 'utf8');

test('prezzi particolari: a persona con minimo, e prezzo secondo pescato', () => {
  const r = specialPriceRow('Risotto alla gradese (minimo 2 persone) 18 € a persona');
  assert.equal(r.name, 'Risotto alla gradese'); assert.equal(r.amount, '18'); assert.equal(r.note, 'Prezzo a persona, minimo 2 persone');
  assert.equal(specialPriceRow('Grigliata mista di pesce prezzo secondo pescato').note, 'Prezzo variabile secondo il pescato del giorno');
  assert.equal(specialPriceRow('Branzino al forno s.q.').note, 'Prezzo variabile, chiedere al personale');
  assert.equal(specialPriceRow('Coperto 2,50 € a persona.'), null);
  assert.equal(specialPriceRow('Fritto misto 18 €'), null);
});

test('«alle» nel nome di un piatto non blocca il prezzo (solo «alle 15» degli orari)', () => {
  assert.equal(priceRow('Spaghetti alle vongole 16 €').amount, '16');
  assert.equal(priceRow('Aperti dalle 12 alle 15'), null);
});

test('email complessa: sezioni giuste, note sui prezzi, niente inventato', () => {
  const r = extractMenuFromText('Ristorante Al Faro', FARO);
  assert.deepEqual(r.menu.sezioni.map((s) => s.nome.it), ['Antipasti', 'Primi', 'Secondi', 'Dolci', 'Bevande']);
  const all = r.menu.sezioni.flatMap((s) => s.voci);
  const risotto = all.find((v) => v.nome.it === 'Risotto alla gradese');
  assert.equal(risotto.prezzo, '18,00'); assert.equal(risotto.descrizione.it, 'Prezzo a persona, minimo 2 persone');
  const grigliata = all.find((v) => v.nome.it === 'Grigliata mista di pesce');
  assert.equal(grigliata.prezzo, undefined); assert.match(grigliata.descrizione.it, /pescato/);
  assert.equal(all.find((v) => /Fritto misto/.test(v.nome.it)).prezzo, '18,00'); // la correzione la decide Riccardo
  assert.ok(all.every((v) => !v.allergeni));
});

test('note di revisione: ogni riga non inserita è elencata e divisa per tipo', () => {
  const r = extractMenuFromText('Ristorante Al Faro', FARO);
  const notes = reviewNotes({ sourceText: FARO, uncertain: r.uncertain, extracted: r.extracted });
  assert.equal(notes.length, r.uncertain.length);
  const kind = (rx) => notes.find((n) => rx.test(n.text))?.kind;
  assert.equal(kind(/^Coperto/), 'coperto');
  assert.equal(kind(/fritto misto in realtà/), 'correzione');
  assert.equal(kind(/allergeni/), 'allergeni');
  assert.equal(kind(/Siamo aperti/), 'orari');
  assert.ok(notes.find((n) => /Siamo aperti/.test(n.text)).also.includes('contatti'));
  assert.equal(kind(/toni del blu/), 'tema');
  assert.equal(kind(/piano da 25/), 'piano');
  assert.equal(kind(/^Buongiorno/), 'testo');
  assert.match(notesSummary(notes), /Da sistemare o confermare \(6\)/);
});

test('piano citato ma non deciso: resta da confermare', () => {
  const c = classifyRequest('Menù digitale per il nostro ristorante – Grado', FARO);
  assert.equal(c.plan, null); assert.equal(c.explicitPlan, false); assert.equal(c.ambiguousPlan, true);
  assert.equal(classifyRequest('Nuovo menu', 'Locale: Bar X\nVorremmo il piano annuale.').plan, 'annuale');
});

import { criticalFields } from '../cloudflare/functions/_lib/editorial.js';
test('prezzo variabile dichiarato: non blocca la pubblicazione, un prezzo vuoto sì', () => {
  const menu = { lingue: ['it'], sezioni: [{ nome: { it: 'Secondi' }, voci: [{ nome: { it: 'Grigliata' }, descrizione: { it: 'Prezzo variabile secondo il pescato del giorno' } }, { nome: { it: 'Orata' } }] }] };
  assert.deepEqual(criticalFields(menu).pricesMissing, ['sezioni.0.voci.1.prezzo']);
});

test('email con a capo automatico: una frase spezzata su più righe è una nota sola', () => {
  const src = 'Oggetto ricevuto: Menu\n\nAvremmo bisogno del menù digitale anche in inglese perché d\'estate abbiamo\ntanti turisti austriaci e tedeschi.\n\n# Primi\nBigoli — 12,00\n';
  const r = extractMenuFromText('X', src);
  const notes = reviewNotes({ sourceText: src, uncertain: r.uncertain, extracted: r.extracted });
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /abbiamo tanti turisti/);
});

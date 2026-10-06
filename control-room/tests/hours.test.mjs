import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHours } from '../cloudflare/functions/_lib/hours.js';
import { validateOps, applyOps } from '../cloudflare/functions/_lib/draft-edit.js';

const TIDY = { it: '12:00–15:00 e 19:00–22:00 · Chiuso il mercoledì', en: '12:00–15:00 and 19:00–22:00 · Closed on Wednesday' };

test('le frasi dette il 6 ottobre al Chiostro danno tutte la stessa riga ordinata', () => {
  const said = [
    'Mercoledì chiuso, da giovedì a martedì aperti dalle 12 alle 15 e dalle 19 alle 22',
    'martedì 12-15 19-22, mercoledì chiuso, giovedì 12-15 19-22 e così via fino a lunedì',
    'Lunedì 12.00-15.00 19.00-22.00, Martedì 12.00-15.00 19.00-22.00, Mercoledì chiuso, Giovedì 12.00-15.00 19.00-22.00, Venerdì 12.00-15.00 19.00-22.00, Sabato 12.00-15.00 19.00-22.00, Domenica 12.00-15.00 19.00-22.00'
  ];
  for (const text of said) assert.deepEqual(normalizeHours({ text }), TIDY, text);
});

test('«12-15 e 19-22» senza giorni conserva i giorni già scritti nel menu', () => {
  assert.deepEqual(normalizeHours({ existing: TIDY.it, text: '12-15 e 19-22' }), TIDY);
  assert.deepEqual(normalizeHours({ existing: 'Mercoledì chiuso, da giovedì a martedì aperti dalle 12 alle 15', text: 'dalle 12 alle 15 e dalle 19 alle 22' }), TIDY);
});

test('il testo ordinato si rilegge: si può correggere un solo giorno', () => {
  const sat = normalizeHours({ existing: TIDY.it, text: 'sabato 12-23' });
  assert.equal(sat.it, 'Lunedì–martedì, giovedì–venerdì e domenica 12:00–15:00 e 19:00–22:00 · Sabato 12:00–23:00 · Chiuso il mercoledì');
});

test('gruppi di giorni, chiusure e formati diversi', () => {
  assert.deepEqual(normalizeHours({ text: 'lun-ven 7-20, sab 8-13' }), { it: 'Lunedì–venerdì 07:00–20:00 · Sabato 08:00–13:00', en: 'Monday–Friday 07:00–20:00 · Saturday 08:00–13:00' });
  assert.equal(normalizeHours({ text: 'Tutti i giorni 12-14:30 e 19-22:30, chiusi il martedì' }).it, '12:00–14:30 e 19:00–22:30 · Chiuso il martedì');
  assert.equal(normalizeHours({ text: 'Dal martedì alla domenica 11.30-15 e 18.30-23, lunedì chiuso' }).it, '11:30–15:00 e 18:30–23:00 · Chiuso il lunedì');
  assert.equal(normalizeHours({ text: 'lunedì e mercoledì chiuso, gli altri giorni 12-15' }).it, '12:00–15:00 · Chiuso il lunedì e il mercoledì');
  assert.equal(normalizeHours({ text: 'tutti i giorni 12-15 tranne il lunedì' }).it, '12:00–15:00 · Chiuso il lunedì');
  assert.equal(normalizeHours({ text: 'tutti i giorni 10-22' }).it, 'Tutti i giorni 10:00–22:00');
});

test('nel dubbio non inventa: null', () => {
  assert.equal(normalizeHours({ text: 'domani apriamo alle 9 e 30' }), null);
  assert.equal(normalizeHours({ text: 'lunedì martedì' }), null);
  assert.equal(normalizeHours({ text: 'siamo chiusi' }), null);
  // orari che il modello ha scritto ma Riccardo non ha detto
  assert.equal(normalizeHours({ text: 'lun-ven 12-15 e 19-23', utterance: 'lun-ven 12-15 e 19-22' }), null);
  // orari già nel menu che non so leggere: una frase a metà non li cancella
  assert.equal(normalizeHours({ existing: 'dalla colazione a notte fonda', text: 'sabato 12-23' }), null);
});

test('Telegram: la frase detta diventa una riga ordinata anche se il modello copia le parole', () => {
  const menu = { id: 'x', nome: 'Bistrot', lingue: ['it', 'en'], sezioni: [{ nome: { it: 'Primi' }, voci: [{ nome: { it: 'Gnocchi' }, prezzo: '10,00' }] }] };
  const first = 'orari: mercoledì chiuso, da giovedì a martedì aperti dalle 12 alle 15 e dalle 19 alle 22';
  const ops1 = validateOps([{ tipo: 'locale', campo: 'orari', nome: 'Mercoledì chiuso, da giovedì a martedì aperti dalle 12 alle 15 e dalle 19 alle 22' }], menu, first);
  assert.deepEqual(ops1.problems, []);
  const one = applyOps(menu, [], ops1.ops, 'Riccardo (Telegram)');
  assert.deepEqual(one.menu.orari, { it: TIDY.it, en: TIDY.en });
  assert.equal(one.needsEnglish, false);
  assert.deepEqual(one.provenance.filter((r) => r.path.startsWith('orari')).map((r) => r.path), ['orari.it', 'orari.en']);
  // Poi dice solo le fasce: i giorni restano e la provenienza vecchia non rimane.
  const said = 'metti gli orari 12-15 e 19-22';
  const ops2 = validateOps([{ tipo: 'locale', campo: 'orari', nome: '12-15 e 19-22' }], one.menu, said);
  const two = applyOps(one.menu, one.provenance, ops2.ops, 'Riccardo (Telegram)');
  assert.deepEqual(two.menu.orari, { it: TIDY.it, en: TIDY.en });
  assert.equal(two.provenance.filter((r) => r.path.startsWith('orari')).length, 2);
});

test('Telegram: se il modello non produce l’operazione, gli orari detti si leggono lo stesso', () => {
  const menu = { id: 'x', nome: 'Bistrot', lingue: ['it', 'en'], sezioni: [{ nome: { it: 'Primi' }, voci: [{ nome: { it: 'Gnocchi' }, prezzo: '10,00' }] }] };
  const out = validateOps([], menu, 'siamo aperti lunedì e martedì dalle 18 alle 23');
  assert.equal(out.ops.length, 1);
  assert.equal(out.ops[0].nome, 'Lunedì e martedì 18:00–23:00');
});

test('orari troppo lunghi e illeggibili non vengono tagliati in silenzio', () => {
  const menu = { id: 'x', nome: 'Bistrot', lingue: ['it'], sezioni: [{ nome: { it: 'Primi' }, voci: [{ nome: { it: 'Gnocchi' }, prezzo: '10,00' }] }] };
  const long = `orari ${'aperti quando capita '.repeat(14)}`;
  const out = validateOps([{ tipo: 'locale', campo: 'orari', nome: long.trim() }], menu, long);
  assert.equal(out.ops.length, 0);
  assert.match(out.problems[0], /troppo lungo/);
});

test('titoli di sezione scritti in minuscolo prendono l’iniziale maiuscola', async () => {
  const { sectionTitleCase } = await import('../cloudflare/functions/_lib/menu.js');
  assert.equal(sectionTitleCase('antipasti'), 'Antipasti');
  assert.equal(sectionTitleCase('PRIMI'), 'Primi');
  assert.equal(sectionTitleCase('Vini al calice'), 'Vini al calice');
});

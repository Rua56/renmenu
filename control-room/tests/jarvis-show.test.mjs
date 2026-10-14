import test from 'node:test';
import assert from 'node:assert/strict';
import { showFor } from '../site/jarvis-show.js';

const clients = [
  { id: 'c1', name: 'Al Bakaro', menuId: 'bakaro', plan: 'standard', createdAt: '2026-10-01T09:00:00Z' },
  { id: 'c2', name: 'Trattoria Blanch', plan: 'da_definire', createdAt: '2026-10-10T09:00:00Z' }
];
const info = (id, clientId, group, status, kind, updatedAt) => ({ request: { id, clientId, status, kind, subject: 'Menu', updatedAt }, client: clients.find((c) => c.id === clientId), group, headline: 'Stato', tone: 'info' });
const pratiche = [
  info('r1', 'c1', 'chiuse', 'completata', 'nuovo', '2026-10-02T10:00:00Z'),
  info('r2', 'c1', 'decidere', 'nuova', 'prezzo', '2026-10-14T07:00:00Z'),
  info('r3', 'c2', 'corso', 'in_revisione', 'nuovo', '2026-10-13T10:00:00Z')
];
const audit = [{ id: 'a1', requestId: 'r3', summary: 'Bozza pronta', createdAt: '2026-10-13T12:00:00Z' }];
const data = { pratiche, clients, audit, now: Date.parse('2026-10-14T10:00:00Z') };
const show = (text) => showFor(text, data);

test('mostrami: pratiche per stato, locale e periodo', () => {
  assert.deepEqual(show('mostrami le pratiche chiuse').rows.map((r) => r.id), ['r1']);
  assert.equal(show('mostrami le pratiche chiuse').say, 'Ecco 1 pratica chiusa. Al Bakaro.');
  assert.deepEqual(show('pratiche aperte').rows.map((r) => r.id), ['r2', 'r3']);
  assert.deepEqual(show('quante pratiche ci sono da decidere?').rows.map((r) => r.id), ['r2']);
  assert.deepEqual(show('pratiche in corso').rows.map((r) => r.id), ['r3']);
  assert.deepEqual(show('mostrami le pratiche del Bakaro').rows.map((r) => r.id), ['r2', 'r1']);
  assert.equal(show('mostrami le pratiche del Bakaro').title, 'Tutte le pratiche di Al Bakaro');
  assert.deepEqual(show('le modifiche di oggi').rows.map((r) => r.id), ['r2']);
});

test('mostrami: locali, menu online e attività', () => {
  const locali = show('quali locali sono registrati?');
  assert.equal(locali.rows.length, 2);
  assert.equal(locali.rows.find((r) => r.id === 'c2').sub, 'Menu non ancora online');
  assert.deepEqual(show('fammi vedere i menu online').rows.map((r) => r.id), ['c1']);
  const ieri = show('cosa è successo ieri');
  assert.equal(ieri.topic, 'attivita');
  assert.deepEqual(ieri.rows.map((r) => r.id), ['r3']);
  assert.match(show('pratiche chiuse di oggi').say, /^Nessun risultato/);
});

test('mostrami: le altre frasi restano a Jarvis', () => {
  for (const text of ['nella bozza del Bakaro metti il frico a 14', 'mostrami l’anteprima del Bakaro', 'com’è la situazione?', 'pubblica il menu del Bakaro', 'cambia le modifiche che ti ho mandato al menu del Bakaro', '']) {
    assert.equal(show(text), null, text);
  }
});

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

test('mostrami i numeri: grafici di 7 o 30 giorni, anche di un locale', () => {
  const p = [
    { ...info('n1', 'c1', 'chiuse', 'completata', 'nuovo', '2026-10-13T12:00:00Z'), request: { id: 'n1', clientId: 'c1', status: 'completata', subject: 'Menu', createdAt: '2026-10-12T12:00:00Z', updatedAt: '2026-10-13T12:00:00Z' } },
    { ...info('n2', 'c2', 'decidere', 'nuova', 'nuovo'), request: { id: 'n2', clientId: 'c2', status: 'nuova', subject: 'Menu', createdAt: '2026-10-14T09:00:00Z' } },
    { ...info('n3', 'c2', 'corso', 'nuova', 'nuovo'), request: { id: 'n3', clientId: 'c2', status: 'nuova', subject: 'Menu', createdAt: '2026-09-01T09:00:00Z' } }
  ];
  const a = [
    { id: 'm1', requestId: 'n1', action: 'github.pr.merged', createdAt: '2026-10-13T13:00:00Z' },
    { id: 'p1', requestId: null, action: 'jarvis.phone_call', createdAt: '2026-10-14T08:00:00Z' },
    { id: 'p2', requestId: null, action: 'jarvis.phone_call', createdAt: '2026-10-14T09:00:00Z' },
    { id: 'x', requestId: null, action: 'jarvis.chat', createdAt: '2026-10-14T09:00:00Z' }
  ];
  const d = { pratiche: p, clients, audit: a, now: Date.parse('2026-10-14T12:00:00Z') };
  const week = showFor('mostrami i numeri', d);
  assert.equal(week.topic, 'numeri');
  assert.equal(week.chart.days.length, 7);
  assert.equal(week.chart.days.at(-1).today, true);
  const total = (shown, key) => shown.chart.series.find((s) => s.key === key)?.total;
  assert.deepEqual(['nuove', 'chiuse', 'menu', 'chiamate'].map((k) => total(week, k)), [2, 1, 1, 2]);
  assert.deepEqual(week.chart.series.find((s) => s.key === 'chiamate').values.slice(-1), [2]);
  assert.equal(week.say, 'Negli ultimi 7 giorni: 2 richieste nuove, 1 pratica chiusa, 1 menu pubblicato, 2 chiamate. Un menu online in tutto.');
  assert.equal(showFor('grafici del mese', d).chart.days.length, 30);
  assert.equal(showFor('come stiamo andando?', d).topic, 'numeri');
  const bakaro = showFor('i numeri del Bakaro', d);
  assert.equal(bakaro.title, 'Numeri degli ultimi 7 giorni · Al Bakaro');
  assert.equal(total(bakaro, 'nuove'), 1);
  assert.equal(total(bakaro, 'chiamate'), undefined);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { CENTER, placeOf, toKm, townIn, venuesFor } from '../site/jarvis-places.js';

test('Mappa dei locali: il paese si riconosce dal nome o dalle richieste', () => {
  assert.equal(townIn('Enoteca Il Calice Storto Cormons')?.name, 'Cormons');
  assert.equal(townIn('Trattoria da Nives', 'Siamo a Gradisca d’Isonzo, via Roma')?.name, "Gradisca d'Isonzo");
  assert.equal(townIn('Osteria in Nova Gorica')?.name, 'Nova Gorica', 'Nova Gorica non diventa Gorizia');
  assert.equal(townIn('Bar Centrale'), null);
});

test('Mappa dei locali: posizioni stabili, vicino al paese, Gorizia al centro', () => {
  const a = placeOf('c1', null), b = placeOf('c1', null);
  assert.deepEqual(a, b);
  const center = toKm(CENTER.lat, CENTER.lon);
  assert.ok(Math.abs(center.x) < 1e-9 && Math.abs(center.y) < 1e-9);
  const cormons = toKm(...Object.values(placeOf('c2', townIn('Cormons'))));
  assert.ok(cormons.x < -9 && cormons.x > -14, `Cormons è a ovest di Gorizia (${cormons.x})`);
});

test('Mappa dei locali: stato di ogni locale per il colore', () => {
  const state = {
    clients: [{ id: 'a', name: 'Al Tralcio — demo', menuId: 'al-tralcio' }, { id: 'b', name: 'Calice Storto' }, { id: 'c', name: 'Nuovo Bar' }],
    requests: [{ id: 'r1', clientId: 'b', status: 'in_revisione', subject: 'Nuovo menu · Calice Storto Cormons' }]
  };
  const list = venuesFor(state, new Set(['a']));
  assert.deepEqual(list.map((v) => v.state), ['decide', 'lavoro', 'nuovo']);
  assert.equal(list[0].name, 'Al Tralcio');
  assert.equal(list[1].town, 'Cormons');
  assert.equal(list[1].open, 1);
});

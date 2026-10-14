// Visualizzatore Premium (menu/premium.js): abbinamenti tra le voci, temperatura e profumi della scheda.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('../../menu/premium.js', import.meta.url), 'utf8');
const window = {};
vm.runInNewContext(code, { window, document: { addEventListener() {} } });
// Oggetti creati in un altro contesto: si confrontano come JSON.
const plain = (fn) => (...a) => { const r = fn(...a); return r && typeof r === 'object' ? JSON.parse(JSON.stringify(r)) : r; };
const pairings = (items) => new Map([...window.RenMenuPremium.pairings(items)].map(([k, v]) => [k, [...v]]));
const servingTemp = plain(window.RenMenuPremium.servingTemp), aromi = plain(window.RenMenuPremium.aromi);

const menu = [
  { key: '0:0', nome: { it: 'Salmone, Philadelphia e Guacamole' }, vino: false },
  { key: '0:1', nome: { it: 'Burrata, melanzane e pomodorini' }, vino: false },
  { key: '0:2', nome: { it: 'Mortadella, burrata e pistacchio' }, vino: false },
  { key: '0:3', nome: 'Frico croccante con polenta', vino: false },
  { key: '1:0', nome: { it: 'Rosé' }, vino: true, abbinamenti: { it: 'Cicchetti, salmone, formaggi freschi', en: 'Cicchetti, salmon, fresh cheeses' } },
  { key: '1:1', nome: { it: 'Friulano' }, vino: true, abbinamenti: 'Frico croccante con polenta e salumi' },
  { key: '1:2', nome: { it: 'Refosco' }, vino: true, abbinamenti: 'Burrata e carni rosse' }
];

test('abbinamenti: solo piatti del menu nominati nella scheda, in entrambe le direzioni', () => {
  const p = pairings(menu);
  assert.deepEqual(p.get('1:0'), ['0:0']); // «salmone» è la prima parola di un solo piatto
  assert.deepEqual(p.get('0:0'), ['1:0']);
  assert.deepEqual(p.get('1:1'), ['0:3']); // nome intero del piatto
  assert.equal(p.get('1:2'), undefined); // «burrata» è in due piatti: troppo vago, nessun abbinamento
  assert.equal(p.get('0:1'), undefined);
});

test('abbinamenti: niente parole troppo corte o comuni', () => {
  const p = pairings([{ key: 'a', nome: 'Crema di zucca', vino: false }, { key: 'b', nome: 'Vino', vino: true, abbinamenti: 'crema catalana' }]);
  assert.equal(p.size, 0);
});

test('temperatura di servizio', () => {
  assert.deepEqual(servingTemp('7-9°C'), { min: 7, max: 9, media: 8 });
  assert.deepEqual(servingTemp('16–18 °C'), { min: 16, max: 18, media: 17 });
  assert.deepEqual(servingTemp('10°'), { min: 10, max: 10, media: 10 });
  assert.equal(servingTemp('fresco'), null);
  assert.equal(servingTemp('90°'), null);
});

test('profumi: al massimo 6 parole brevi', () => {
  assert.deepEqual(aromi('Agrumi, lampone, ribes, fragola selvatica, note di piccoli frutti rossi'), ['Agrumi', 'lampone', 'ribes', 'fragola selvatica', 'piccoli frutti rossi']);
  assert.equal(aromi('a, b, c, d, e, f, g, h').length, 6);
});

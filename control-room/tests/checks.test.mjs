import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyCheck, checkQuestion, normalizePrice } from '../cloudflare/functions/_lib/checks.js';
import { combineReadings } from '../cloudflare/functions/_lib/vision.js';

describe('Dubbi della foto chiusi da Riccardo', () => {
  const a = '# Primi piatti\nSpaghetti — 7,00\nRisotto — 8,00\n# Dolci\nStrudel — 5,00';
  const b = '# Primi piatti\nSpaghetti — 3,00\nRisotto — 8,00\n# Dolci\nStrudel — 5,00\nTiramisù — 5,00';
  const r = combineReadings(a, b);
  it('ogni prezzo in disaccordo diventa un dubbio con sezione e prezzi letti', () => {
    const spaghetti = r.checks.find((c) => c.name === 'Spaghetti');
    assert.deepEqual(spaghetti.options, ['7,00', '3,00']);
    assert.equal(spaghetti.section, 'Primi piatti');
    assert.ok(r.checks.find((c) => c.name === 'Tiramisù' && c.section === 'Dolci'), 'voce letta da una sola lettura');
  });
  it('il prezzo scelto entra sotto la sua sezione e la riga di dubbio sparisce', () => {
    const spaghetti = r.checks.find((c) => c.name === 'Spaghetti');
    const text = applyCheck(r.text, spaghetti, '7,00');
    assert.match(text, /# Primi piatti\nRisotto — 8,00\nSpaghetti — 7,00\n# Dolci/);
    assert.ok(!text.includes(spaghetti.line));
    const tolta = applyCheck(r.text, spaghetti, null);
    assert.doesNotMatch(tolta, /Spaghetti/);
  });
  it('prezzi scritti a mano: solo numeri veri', () => {
    assert.equal(normalizePrice('7'), '7,00');
    assert.equal(normalizePrice('7.5 €'), '7,50');
    assert.equal(normalizePrice('sette'), null);
    assert.equal(normalizePrice('7 piatti'), null);
  });
  it('la domanda ha un pulsante per prezzo, salta, non c’è e fai la bozza', () => {
    const q = checkQuestion(r.checks[0], 0, 2);
    assert.match(q.text, /Dubbio 1 di 2 · Primi piatti/);
    assert.deepEqual(q.buttons.map((b) => b[1]), ['chk:0:0', 'chk:0:1', 'chk:0:s', 'chk:0:n', 'chk:end']);
  });
});

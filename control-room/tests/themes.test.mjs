import test from 'node:test';
import assert from 'node:assert/strict';
import { proposeTheme, THEMES } from '../cloudflare/functions/_lib/themes.js';
import { validateMenu } from '../cloudflare/functions/_lib/menu.js';

test('temi: Jarvis propone il tema dal nome o da indizi espliciti, altrimenti bordeaux', () => {
  assert.equal(proposeTheme('Trattoria da Mario').tema, 'trattoria');
  assert.equal(proposeTheme('Al Porto Vecchio').tema, 'mare');
  assert.equal(proposeTheme('Caffè Centrale').tema, 'sole');
  assert.equal(proposeTheme('Pizzeria Napoli').tema, 'terracotta');
  assert.equal(proposeTheme('Lounge 21').tema, 'notte');
  assert.equal(proposeTheme('Da Gigi', 'Siamo un ristorante di pesce in centro').tema, 'mare');
  assert.equal(proposeTheme('Riccardo sei il migliore', '# Primi di Carne e Pesce').tema, 'bordeaux');
  assert.equal(Object.keys(THEMES).length, 6);
});

test('temi: il campo tema è pubblico ma accetta solo i temi previsti', () => {
  const base = { id: 'x', nome: 'X', lingue: ['it'], sezioni: [{ nome: { it: 'A' }, voci: [{ nome: { it: 'B' }, prezzo: '1,00' }] }] };
  assert.ok(!validateMenu({ ...base, tema: 'mare' }).errors.length);
  assert.match(validateMenu({ ...base, tema: 'arcobaleno' }).errors.join(' '), /menu\.tema/);
});

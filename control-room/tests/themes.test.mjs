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

import { themeFromText } from '../cloudflare/functions/_lib/themes.js';
import { prepareUpdate } from '../cloudflare/functions/_lib/update.js';
import { guessIntent } from '../cloudflare/functions/_lib/understanding.js';

test('temi: riconosce una richiesta esplicita di colori, non i piatti', () => {
  assert.equal(themeFromText('Vorremmo un menù sui toni del verde, più rustico')?.tema, 'trattoria');
  assert.equal(themeFromText('metti il tema blu mare al Bakaro')?.tema, 'mare');
  assert.equal(themeFromText('Per la grafica preferiremmo colori scuri ed eleganti')?.tema, 'notte');
  assert.equal(themeFromText('usa il tema sole')?.tema, 'sole');
  assert.equal(themeFromText('Tagliata con salsa verde 18 €'), null);
  assert.equal(themeFromText('Spaghetti al nero di seppia 14 €'), null);
});

const LIVE = { id: 'bar-x', nome: 'Bar X', lingue: ['it'], sezioni: [{ nome: { it: 'Primi' }, voci: [{ nome: { it: 'Carbonara' }, prezzo: '12,00' }, { nome: { it: 'Amatriciana' }, prezzo: '11,00' }] }] };

test('temi: aggiornamento solo grafico, piatti e prezzi invariati', () => {
  const out = prepareUpdate({ slug: 'bar-x', current: LIVE, sha: 'abc1234', sourceText: 'Metti il tema blu mare', subject: 'Richiesta a voce' });
  assert.ok(out.ok);
  assert.equal(out.extraction.menu.tema, 'mare');
  assert.deepEqual(out.extraction.menu.sezioni, LIVE.sezioni);
  assert.match(out.extraction.warnings[0], /Bordeaux classico → Blu mare/);
});

test('temi: prezzo e colori nella stessa richiesta', () => {
  const out = prepareUpdate({ slug: 'bar-x', current: LIVE, sha: 'abc1234', sourceText: 'La carbonara passa a 13 euro.\nE vorremmo i colori sul verde.', subject: 'Modifiche' });
  assert.ok(out.ok);
  assert.equal(out.extraction.menu.tema, 'trattoria');
  assert.equal(out.extraction.menu.sezioni[0].voci[0].prezzo, '13,00');
});

test('temi: stesso tema già online = nessuna modifica', () => {
  const out = prepareUpdate({ slug: 'bar-x', current: { ...LIVE, tema: 'mare' }, sha: 'a', sourceText: 'tema blu mare', subject: 's' });
  assert.equal(out.ok, false);
});

test('temi: a voce «metti il tema blu al Bar X» è un aggiornamento', () => {
  assert.equal(guessIntent('metti il tema blu al bar x', { locales: [{ name: 'Bar X', menu_id: 'bar-x' }] }).intent, 'aggiorna_menu');
});

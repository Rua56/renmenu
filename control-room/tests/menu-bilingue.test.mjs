import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { combineReadings } from '../cloudflare/functions/_lib/vision.js';
import { extractMenuFromText } from '../cloudflare/functions/_lib/menu.js';
import { bilingualTitle, englishGloss } from '../cloudflare/functions/_lib/menu-structure.js';

// Foto del 16 ottobre 2026 (pratica aperta da telefono): menu con l'inglese già stampato sotto ogni piatto.
const sezioni = (a, b) => extractMenuFromText('x', combineReadings(a, b).text, 'x').menu.sezioni;

describe('Menu già bilingue letto dalle foto', () => {
  it('l\'inglese tra parentesi diventa la traduzione del nome, non la descrizione italiana', () => {
    const a = '# CONTORNI / SIDE DISHES\n\nPatate in tecia — 6,00\n> (Potatoes with jowls pork) (3)\nInsalata mista — 5,00\n> (Mixed salad) (/)\nDolce — 7,00\n> (Dessert) (Variabile (Variable))';
    const [s] = sezioni(a, a);
    assert.deepEqual(s.nome, { it: 'Contorni', en: 'Side dishes' });
    assert.deepEqual(s.voci[0], { nome: { it: 'Patate in tecia', en: 'Potatoes with jowls pork' }, prezzo: '6,00', descrizione: { it: '(3)' } });
    assert.deepEqual(s.voci[1], { nome: { it: 'Insalata mista', en: 'Mixed salad' }, prezzo: '5,00' });
    assert.deepEqual(s.voci[2], { nome: { it: 'Dolce', en: 'Dessert' }, prezzo: '7,00', descrizione: { it: 'Variabile' } });
  });

  it('i numeri degli allergeni senza parentesi non diventano prezzi né piatti', () => {
    const a = "# ANTIPASTI / APETIZERS\n\nCrostini con olio all'aglio e San Daniele — 10,00\n> (Slice of bread with garlic oil and San Daniele raw ham) (9)\n\nKipfel — 7,00\n> (Fried potato dough) (1-9)\n\nArancine (carne o burro) SOLO SU PRENOTAZIONE (only by reservation) — 8,00\n> (Palermo arancine with meat or butter) (1-3)";
    const b = "# ANTIPASTI / APETIZERS\n\nCrostini con olio all'aglio e San Daniele — 10,00\n> (Slice of bread with garlic oil and San Daniele raw ham) 9\nKipfel — 7,00\n> (Fried potato dough) 1-9\nArancine (carne o burro) SOLO SU PRENOTAZIONE (only by reservation) — 8,00\n> (Palermo arancine with meat or butter) 1-3";
    const combined = combineReadings(a, b);
    assert.equal(combined.doubts, 0, combined.text);
    const [s] = extractMenuFromText('x', combined.text, 'x').menu.sezioni;
    assert.deepEqual(s.voci.map((v) => [v.nome.it, v.nome.en, v.prezzo, v.descrizione?.it]), [
      ["Crostini con olio all'aglio e San Daniele", 'Slice of bread with garlic oil and San Daniele raw ham', '10,00', '(9)'],
      ['Kipfel', 'Fried potato dough', '7,00', '(1-9)'],
      ['Arancine (carne o burro) SOLO SU PRENOTAZIONE', 'Palermo arancine with meat or butter', '8,00', '(1-3)']
    ]);
  });

  it('le descrizioni lunghe stampate sotto il piatto restano descrizioni, non «testo sulla foto»', () => {
    const a = "# PRIMI PIATTI\n\nRIGATONI \"ORO DEL BORGO\" — 17\n> Il nostro piatto firma: una crema vellutata di zafferano e Grana Padano che avvolge i rigatoni, arricchita dalla nota sapida e croccante del salame 'Zoratti' spadellato. A chiudere il cerchio, una granella di pistacchi tostati che dona una consistenza unica a ogni boccone. È un incontro tra il calore dell'oro dello zafferano e la tradizione del nostro borgo (2-3-9-13)";
    const combined = combineReadings(a, a);
    assert.equal(combined.doubts, 0, combined.text);
    const [s] = extractMenuFromText('x', combined.text, 'x').menu.sezioni;
    assert.match(s.voci[0].descrizione.it, /^Il nostro piatto firma: .* borgo \(2-3-9-13\)$/);
  });

  it('testi solo italiani restano come sono', () => {
    assert.equal(englishGloss('(solo su prenotazione)'), null);
    assert.equal(englishGloss('(1-7-13)'), null);
    assert.equal(bilingualTitle('Pizze / Focacce'), null);
    const [s] = sezioni('# Dolci\nStrudel — 5,00\n> (con panna) (7)', '# Dolci\nStrudel — 5,00\n> (con panna) (7)');
    assert.deepEqual(s.voci[0], { nome: { it: 'Strudel' }, prezzo: '5,00', descrizione: { it: '(con panna) (7)' } });
  });
});

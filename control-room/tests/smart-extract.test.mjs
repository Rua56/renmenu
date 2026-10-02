import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractMenuFromText } from '../cloudflare/functions/_lib/menu.js';
import { acceptProposal, assistExtraction } from '../cloudflare/functions/_lib/assist.js';

const RICHARD = `Buongiorno vorrei iniziare con un abbonamento standard.
Locale: pizzeria da Richard
Antipasti
Richard fritto 10
Richard bollito 15
Primi
Richard sbronzo 20
Dolci
Richard in glassa 10`;

describe('Lettura dei menu scritti in formato libero', () => {
  it('legge "Nome 10" con titoli di sezione semplici', () => {
    const r = extractMenuFromText('Pizzeria da Richard', RICHARD, 'pizzeria-da-richard');
    assert.deepEqual(r.menu.sezioni.map((s) => [s.nome.it, s.voci.map((v) => `${v.nome.it} ${v.prezzo}`)]), [
      ['Antipasti', ['Richard fritto 10,00', 'Richard bollito 15,00']], ['Primi', ['Richard sbronzo 20,00']], ['Dolci', ['Richard in glassa 10,00']]]);
    assert.ok(r.warnings.some((w) => /senza €/.test(w)));
  });
  it('accetta € ed euro, ma non quantità sotto 1 senza valuta né frasi', () => {
    const read = (row) => extractMenuFromText('x', row, 'x').extracted.map((i) => `${i.name}|${i.price}`);
    assert.deepEqual(read('Tiramisù 6€'), ['Tiramisù|6,00']);
    assert.deepEqual(read('Spritz € 4,5'), ['Spritz|4,50']);
    assert.deepEqual(read('Pizza 4 stagioni 8'), ['Pizza 4 stagioni|8,00']);
    assert.deepEqual(read('Birra 0,4'), []);
    assert.deepEqual(read('Vorrei aprire alle 18'), []);
  });
});

describe('Lettura assistita (il modello propone, il testo decide)', () => {
  it('accetta solo nome e prezzo presenti nella riga', () => {
    const line = 'il fritto misto lo facciamo a 12 euro';
    assert.deepEqual(acceptProposal(line, { kind: 'piatto', name: 'fritto misto', price: '12' }), { name: 'fritto misto', price: '12' });
    assert.equal(acceptProposal(line, { kind: 'piatto', name: 'fritto misto', price: '13' }), null, 'prezzo inventato');
    assert.equal(acceptProposal(line, { kind: 'piatto', name: 'fritto di pesce', price: '12' }), null, 'nome inventato');
    assert.equal(acceptProposal('margherita piccola 6 grande 9', { kind: 'piatto', name: 'margherita', price: '6' }), null, 'due prezzi: decide Riccardo');
    assert.deepEqual(acceptProposal('Pizze:', { kind: 'titolo', name: 'Pizze' }), { title: 'Pizze' });
  });
  it('riscrive solo le righe verificate e segna la provenienza', async () => {
    const source = 'Ciao, ecco il menu\nPizze\nla margherita costa 7,50\nla diavola invece 9 euro\nla bufala costa 13 euro, no scusa 12\nApriamo alle 18';
    const base = extractMenuFromText('Da Ugo', source, 'da-ugo');
    assert.equal(base.extracted.length, 0);
    const ai = { run: async (_model, payload) => {
      const rows = JSON.parse(payload.messages[1].content.split('\n').slice(1).join('\n'));
      const answer = rows.map(({ id, text }) => /^Pizze/.test(text) ? { id, kind: 'titolo', name: 'Pizze' }
        : /margherita/.test(text) ? { id, kind: 'piatto', name: 'margherita', price: '7,50' }
          : /diavola/.test(text) ? { id, kind: 'piatto', name: 'diavola', price: '8' } // prezzo sbagliato: scartato
            : /bufala/.test(text) ? { id, kind: 'piatto', name: 'bufala', price: '12' } // due importi: scartato
              : { id, kind: 'altro' });
      return { response: JSON.stringify({ lines: answer }) };
    } };
    const r = await assistExtraction(ai, 'Da Ugo', source, 'da-ugo', base);
    assert.deepEqual(r.menu.sezioni.map((s) => [s.nome.it, s.voci.map((v) => `${v.nome.it} ${v.prezzo}`)]), [['Pizze', ['margherita 7,50']]]);
    assert.ok(r.provenance.some((p) => p.source === 'riga 3 (letta da Jarvis)'));
    assert.ok(r.uncertain.includes('la diavola invece 9 euro'));
    assert.ok(r.warnings.some((w) => /letti da Jarvis/.test(w)));
  });
  it('senza modello o con errore lascia tutto com’era', async () => {
    const base = extractMenuFromText('x', 'la margherita costa 7', 'x');
    assert.equal(await assistExtraction(undefined, 'x', 'la margherita costa 7', 'x', base), base);
    assert.equal(await assistExtraction({ run: async () => { throw new Error('giù'); } }, 'x', 'la margherita costa 7', 'x', base), base);
  });
});

import { proposeReplyChanges } from '../cloudflare/functions/_lib/approvals.js';
describe('Risposta del locale: sezione indicata e coperto', () => {
  const menu = { sezioni: [{ nome: { it: 'Antipasti' }, voci: [{ nome: { it: 'Fritto' }, prezzo: '10,00' }] }, { nome: { it: 'Secondi' }, voci: [{ nome: { it: 'Tagliata' }, prezzo: '20,00' }] }, { nome: { it: 'Dolci' }, voci: [{ nome: { it: 'Tiramisù' }, prezzo: '6,00' }] }] };
  it('mette il piatto nella sezione scritta dal locale e legge il coperto nella stessa frase', () => {
    const out = proposeReplyChanges('Aggiungete il Richard arrosto a 35 euro nei secondi e il coperto 2 euro', menu);
    assert.deepEqual(out.map(({ type, name, price, section, value }) => ({ type, name, price, section, value })), [
      { type: 'aggiungi', name: 'Richard arrosto', price: '35,00', section: 1, value: undefined },
      { type: 'coperto', name: undefined, price: undefined, section: undefined, value: '2,00' }]);
  });
  it('coperto con verbo davanti sì, con due importi no', () => {
    assert.equal(proposeReplyChanges('Aggiungete il coperto di 3 euro', menu)[0].value, '3,00');
    assert.equal(proposeReplyChanges('Coperto e pane 2 o 3 euro', menu)[0].type, 'manuale');
  });
});

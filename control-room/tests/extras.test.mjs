import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyExtras, detectExtra, proposeSourceExtras } from '../cloudflare/functions/_lib/extras.js';
import { proposeReplyChanges } from '../cloudflare/functions/_lib/approvals.js';

const menu = () => ({ sezioni: [
  { nome: { it: 'Primi' }, voci: [{ nome: { it: 'Gnocchi di susine' }, prezzo: '10,00' }, { nome: { it: "Tagliolini all'uovo" }, prezzo: '12,00' }] },
  { nome: { it: 'Dolci' }, voci: [{ nome: { it: 'Gubana con grappa' }, prezzo: '6,00' }, { nome: { it: 'Strudel di mele' }, prezzo: '5,50' }] }] });

describe('Coperto e allergeni dichiarati dal locale', () => {
  it('propone solo ciò che il locale ha scritto, con la riga, e mai dal nome del piatto', () => {
    const source = "Primi\nGnocchi di susine — 10,00\nTagliolini all'uovo — 12,00\n\nCoperto 2,50 €\nGli gnocchi contengono glutine e uova.\nLo strudel non contiene glutine\nTutti i piatti possono contenere tracce di sesamo";
    const found = proposeSourceExtras(source, menu());
    assert.deepEqual(found.map((p) => [p.type, p.line, p.value ?? p.codes ?? null]), [
      ['coperto', 5, '2,50'], ['allergeni', 6, ['1', '3']], ['manuale', 7, null], ['manuale', 8, null]]);
    assert.equal(detectExtra("Tagliolini all'uovo — 12,00", menu()), null, 'nome del piatto: nessuna deduzione');
    assert.equal(detectExtra('I dolci contengono glutine', menu()).type, 'manuale', 'nessun piatto preciso');
  });
  it('applica con fonte e la risposta del locale può aggiungere allergeni e coperto', () => {
    const [cover, allergens] = proposeSourceExtras('Coperto 2 euro\nLa gubana contiene frutta a guscio e glutine', menu());
    const applied = applyExtras(menu(), [cover, allergens], (entry) => `riga ${entry.line}`);
    assert.equal(applied.menu.coperto, '2,00');
    assert.deepEqual(applied.menu.sezioni[1].voci[0].allergeni, ['1', '8']);
    assert.deepEqual(applied.provenance.map((row) => [row.path, row.value, row.source]), [['coperto', '2,00', 'riga 1'], ['sezioni.1.voci.0.allergeni', '1,8', 'riga 2']]);
    assert.deepEqual(proposeReplyChanges('Gli gnocchi contengono glutine. Il coperto è 3 euro.', menu()).map((p) => p.type), ['allergeni', 'coperto']);
  });
});

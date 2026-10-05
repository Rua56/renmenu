import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { combineReadings, readMenuPhoto, readMenuPdf } from '../cloudflare/functions/_lib/vision.js';
import { extractMenuFromText } from '../cloudflare/functions/_lib/menu.js';

const A = '# Primi\nGnocchi di susine — 12\nBlecs al ragù — 11\n# Dolci\nStrudel di mele — 6\nGubana — 5';
const B = '# PRIMI\nGnocchi di susine — 12\nBlecs al ragu — 14\n# DOLCI\nStrudel di mele — 6\nTiramisù — 7';

describe('Lettura delle foto: due letture, entrano solo le voci concordi', () => {
  it('voci concordi in formato canonico, il resto da verificare con entrambe le letture', () => {
    const r = combineReadings(A, B);
    assert.equal(r.agreed, 2);
    const menu = extractMenuFromText('X', r.text, 'x');
    assert.deepEqual(menu.menu.sezioni.map((s) => [s.nome.it, s.voci.map((v) => `${v.nome.it} ${v.prezzo}`)]), [['Primi', ['Gnocchi di susine 12,00']], ['Dolci', ['Strudel di mele 6,00']]]);
    assert.ok(menu.uncertain.some((row) => /Blecs al ragù: letto 11,00, seconda lettura 14,00/.test(row)), 'prezzo diverso: a Riccardo');
    assert.ok(menu.uncertain.some((row) => /Gubana: letto 5,00, non trovato/.test(row)));
    assert.ok(menu.uncertain.some((row) => /Tiramisù: letto 7,00 solo nella seconda lettura/.test(row)));
  });
  it('una sola lettura: nessuna voce confermata', () => {
    const r = combineReadings(A, '');
    assert.equal(r.agreed, 0);
    assert.equal(extractMenuFromText('X', r.text, 'x').extracted.length, 0);
  });
  it('chiama due modelli diversi con la foto e regge un modello che non risponde', async () => {
    const seen = [];
    const ai = { run: async (model, payload) => {
      seen.push(model);
      assert.match(payload.messages[0].content[1].image_url.url, /^data:image\/jpeg;base64,/);
      if (model.includes('mistral')) throw new Error('giù');
      return { response: A };
    } };
    const r = await readMenuPhoto(ai, new Uint8Array([255, 216, 255, 1, 2]), 'image/jpeg');
    // Mistral giù (anche al secondo tentativo) → la seconda lettura la fa il modello di riserva.
    assert.equal(new Set(seen).size, 3);
    assert.ok(seen.some((m) => m.includes('gemma')));
    assert.equal(r.ok, true);
    assert.equal(r.method, 'jarvis_foto_doppia_lettura');
    assert.match(r.warnings[0], /uno di riserva/);
    // Anche il modello di riserva giù: una lettura sola, tutto da verificare.
    const down = { run: async (model) => { if (!model.includes('llama')) throw new Error('giù'); return { response: A }; } };
    const single = await readMenuPhoto(down, new Uint8Array([255, 216, 255, 1, 2]), 'image/jpeg');
    assert.equal(single.method, 'jarvis_foto_lettura_singola');
    assert.equal(single.agreed, 0);
  });
  it('molte voci in disaccordo: una terza lettura decide, ma entra solo ciò che due letture su tre confermano', async () => {
    const base = Array.from({ length: 14 }, (_, i) => `Piatto numero ${i + 1} — ${i + 5},00`).join('\n');
    const wrong = Array.from({ length: 14 }, (_, i) => `Piatto numero ${i + 1} — ${i + 50},00`).join('\n');
    const third = Array.from({ length: 14 }, (_, i) => `Piatto numero ${i + 1} — ${i < 10 ? i + 5 : i + 90},00`).join('\n');
    const ai = { run: async (model) => ({ response: model.includes('gemma') ? third : model.includes('llama') ? base : wrong }) };
    const r = await readMenuPhoto(ai, new Uint8Array([255, 216, 255, 1, 2]), 'image/jpeg');
    assert.equal(r.method, 'jarvis_foto_tripla_lettura');
    assert.equal(r.agreed, 10);
    assert.match(r.text, /^Piatto numero 1 — 5,00$/m);
    assert.doesNotMatch(r.text, /^Piatto numero 12 — /m, 'prezzo letto diverso da tutte e tre: resta in dubbio');
    assert.match(r.warnings[0], /tre volte con tre modelli diversi: 10 voci concordi \(10 confermate dalla terza lettura\)/);
  });
  it('rifiuta formati non leggibili e foto senza piatti', async () => {
    assert.equal((await readMenuPhoto({ run: async () => ({}) }, new Uint8Array(4), 'image/heic')).ok, false);
    assert.equal((await readMenuPhoto({ run: async () => ({ response: 'Una bella foto di un tramonto' }) }, new Uint8Array(4), 'image/png')).ok, false);
  });
  it('PDF: usa il testo del file, senza intestazioni di pagina; scansione senza testo = foto', async () => {
    const ai = { toMarkdown: async () => [{ data: '# menu.pdf\n## Metadata\n- PDFFormatVersion=1.7\n## Contents\n### Page 1\nANTIPASTI\nFrico — 12,00\n' }] };
    const r = await readMenuPdf(ai, new Uint8Array(4));
    assert.equal(r.ok, true);
    assert.doesNotMatch(r.text, /Page 1|Metadata/);
    assert.equal((await readMenuPdf({ toMarkdown: async () => [{ data: '## Contents\n### Page 1\n' }] }, new Uint8Array(4))).ok, false);
  });
});

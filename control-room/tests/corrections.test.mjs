import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractMenuFromText } from '../cloudflare/functions/_lib/menu.js';
import { assistExtraction } from '../cloudflare/functions/_lib/assist.js';
import { applyPriceCorrections } from '../cloudflare/functions/_lib/corrections.js';
import { reviewNotes, notesSummary } from '../cloudflare/functions/_lib/notes.js';

const SRC = readFileSync(new URL('./fixtures-faro-gmail.txt', import.meta.url), 'utf8');
const all = (menu) => menu.sezioni.flatMap((s) => s.voci.map((v) => [s.nome.it, v.nome.it, v.prezzo]));

test('prova reale Al Faro: la correzione del fritto misto non diventa una bevanda', async () => {
  const base = extractMenuFromText('Ristorante Al Faro', SRC);
  // Il modello (come nella prova reale) propone «fritto misto 19» come piatto: Jarvis lo scarta.
  const lines = SRC.split(/\r?\n/);
  const ai = { run: async (_m, payload) => {
    const rows = JSON.parse(payload.messages[1].content.split('\n').slice(1).join('\n'));
    return { response: JSON.stringify({ lines: rows.map((r) => (/fritto misto/i.test(r.text) ? { id: r.id, kind: 'piatto', name: 'fritto misto', price: '19' } : { id: r.id, kind: 'altro' })) }) };
  } };
  const assisted = await assistExtraction(ai, 'Ristorante Al Faro', SRC, 'ristorante-al-faro', base);
  assert.ok(!all(assisted.menu).some(([section, name]) => section === 'Bevande' && /fritto/i.test(name)));
  const corrections = applyPriceCorrections(assisted, SRC);
  assert.deepEqual(corrections.map((c) => [c.name, c.before, c.after]), [["Fritto misto dell'Adriatico", '18,00', '19,00']]);
  const fritto = all(assisted.menu).filter(([, name]) => /fritto/i.test(name));
  assert.deepEqual(fritto, [['Secondi', "Fritto misto dell'Adriatico", '19,00']]);
  assert.ok(assisted.provenance.some((p) => p.path === 'sezioni.2.voci.1.prezzo' && p.value === '19,00' && /^riga \d+$/.test(p.source)));
  assert.equal(lines.length > 40, true);
  const notes = reviewNotes({ sourceText: SRC, uncertain: assisted.uncertain, extracted: assisted.extracted, corrections });
  assert.match(notesSummary(notes), /correzione Fritto misto dell'Adriatico 18,00 → 19,00/);
  assert.ok(!notes.some((n) => n.kind === 'correzione'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { menuSummary, memoryContext } from '../cloudflare/functions/_lib/memory.js';
import { INTENTS } from '../cloudflare/functions/_lib/voice.js';

test('memoria: il riassunto del menu riporta solo sezioni, piatti e prezzi presenti', () => {
  const summary = menuSummary({ id: 'bakaro', nome: { it: 'Bakaro' }, coperto: '3,00', sezioni: [{ nome: { it: 'Antipasti' }, voci: [{ nome: { it: 'Frico' }, prezzo: '9,00' }, { nome: { it: 'Pane' } }] }] });
  assert.equal(summary, 'Menu «Bakaro»\nCoperto 3,00 €\nAntipasti: Frico 9,00 €; Pane');
  assert.equal(menuSummary(null), '');
});

test('memoria: il contesto di Jarvis unisce note e ultimo menu', () => {
  const text = memoryContext({ name: 'Bakaro', menu_id: 'bakaro' }, [
    { kind: 'nota', text: 'chiude il lunedì', created_at: '2026-10-03T08:00:00Z' },
    { kind: 'menu', text: 'Menu «Bakaro»', created_at: '2026-10-02T08:00:00Z' }
  ]);
  assert.match(text, /chiude il lunedì \(2026-10-03\)/);
  assert.match(text, /Ultimo menu online \(2026-10-02\)/);
  assert.ok(INTENTS.has('ricorda'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { logLines, markFresh } from '../site/jarvis-log.js';

test('registro dal vivo: righe recenti, chi le ha fatte e righe nuove', () => {
  const audit = [
    { id: 'a1', action: 'draft.generate', actor: 'jarvis', summary: 'Bozza pronta per Al Bakaro', createdAt: '2026-10-14T08:00:00Z' },
    { id: 'a2', action: 'github.menu.read', actor: 'owner', summary: 'Letto', createdAt: '2026-10-14T09:00:00Z' },
    { id: 'a3', action: 'jarvis.phone_call', actor: 'jarvis', summary: 'Telefonata a Riccardo', createdAt: '2026-10-14T10:00:00Z' },
    { id: 'a4', action: 'github.pr.merged', actor: 'owner', summary: 'Menu  pubblicato', createdAt: '2026-10-14T11:00:00Z' }
  ];
  const lines = logLines(audit);
  assert.deepEqual(lines.map((l) => [l.id, l.who, l.kind]), [['a4', 'RICCARDO', 'pub'], ['a3', 'JARVIS', 'call'], ['a1', 'JARVIS', 'info']]);
  assert.equal(lines[0].text, 'Menu pubblicato');
  assert.equal(lines[0].time, '13:00');
  assert.deepEqual(markFresh(lines).map((l) => l.fresh), [false, false, false]);
  const more = logLines([...audit, { id: 'a5', action: 'request.create', summary: 'Nuova richiesta', createdAt: '2026-10-14T12:00:00Z' }]);
  assert.deepEqual(markFresh(more).map((l) => [l.id, l.who, l.fresh]), [['a5', 'SISTEMA', true], ['a4', 'RICCARDO', false], ['a3', 'JARVIS', false], ['a1', 'JARVIS', false]]);
});

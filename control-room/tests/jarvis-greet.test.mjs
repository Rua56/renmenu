import test from 'node:test';
import assert from 'node:assert/strict';
import { greetingFor } from '../site/jarvis-greet.js';

const now = Date.parse('2026-10-14T14:00:00');
const clients = [{ id: 'c1', name: 'Al Bakaro' }, { id: 'c2', name: 'Da Nives' }];
const requests = [
  { id: 'r1', clientId: 'c1', subject: 'Menu', createdAt: '2026-10-14T09:00:00' },
  { id: 'r2', clientId: 'c2', subject: 'Prezzi', createdAt: '2026-10-10T09:00:00' }
];
const audit = [
  { action: 'github.pr.merged', createdAt: '2026-10-14T10:00:00' },
  { action: 'jarvis.phone_call', createdAt: '2026-10-14T09:01:00' },
  { action: 'jarvis.phone_call', createdAt: '2026-10-14T11:00:00' }
];

test('saluto: novità da ieri sera e cosa aspetta Riccardo', () => {
  const g = greetingFor({ requests, clients, audit, missions: [{ requestId: 'r2', status: 'attesa_si' }], now, before: Date.parse('2026-10-13T21:00:00'), hour: 14 });
  assert.equal(g.show, 'Da ieri sera: una richiesta nuova (Al Bakaro), un menu pubblicato e 2 chiamate di avviso. Da Nives aspetta il tuo SÌ.');
  assert.equal(g.say, `Buon pomeriggio, Riccardo. ${g.show}`);
});

test('saluto: niente di nuovo, primo avvio, pratiche ferme', () => {
  assert.equal(greetingFor({ requests, clients, audit, now, before: Date.parse('2026-10-14T13:30:00'), hour: 14 }).show, 'Da poco fa è tutto tranquillo.');
  assert.equal(greetingFor({ now, hour: 9 }).say, 'Buongiorno, Riccardo. Niente aspetta una tua decisione.');
  assert.equal(greetingFor({ missions: [{ status: 'ferma' }, { status: 'ferma' }], now, hour: 20 }).show, '2 pratiche sono ferme su una tua decisione.');
});

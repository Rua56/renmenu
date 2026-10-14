import test from 'node:test';
import assert from 'node:assert/strict';
import { wakeHeard } from '../site/jarvis-wake.js';

test('«Ehi Jarvis»: sveglia e richiesta che segue', () => {
  assert.deepEqual(wakeHeard('Ehi Jarvis'), { rest: '' });
  assert.deepEqual(wakeHeard('hey jarvis, mostrami i numeri'), { rest: 'mostrami i numeri' });
  assert.deepEqual(wakeHeard('ok Jarvis com\'è la situazione?'), { rest: 'com\'è la situazione?' });
  assert.deepEqual(wakeHeard('Jarvis apri le pratiche'), { rest: 'apri le pratiche' });
  assert.deepEqual(wakeHeard('ehi giarvis'), { rest: '' });
  assert.equal(wakeHeard('domani parlo con il cliente del menu'), null);
  assert.equal(wakeHeard('ho detto a Marco che jarvis funziona'), null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, COMMON, findActions, navigationPhrase, venueIn } from '../site/jarvis-find.js';

const top = (query) => findActions(query, { limit: 1 })[0]?.id;

test('due parole portano alla funzione giusta', () => {
  assert.equal(top('manda anteprima'), 'anteprima-cliente');
  assert.equal(top('schede vini'), 'schede');
  assert.equal(top('bottiglie'), 'schede');
  assert.equal(top('QR'), 'qr');
  assert.equal(top('cambiare un prezzo'), 'modifica');
  assert.equal(top('allergeni'), 'checklist');
  assert.equal(top('colori'), 'tema');
  assert.equal(top('traduzione in inglese'), 'traduci');
  assert.equal(top('riordina le sezioni'), 'riordina');
  assert.equal(top('chiave gemini'), 'impostazioni');
  assert.equal(top('tema scuro'), 'tema-scuro');
  assert.equal(top('telefono del cliente'), 'cliente');
  assert.equal(top('Pubblicà'), 'pubblica');
});

test('casella vuota: le più usate; parole senza senso: niente', () => {
  assert.deepEqual(findActions('', { limit: 3 }).map((a) => a.id), COMMON.slice(0, 3));
  assert.deepEqual(findActions('zxqw'), []);
});

test('ogni funzione ha una schermata o un gesto, e ogni id è unico', () => {
  assert.equal(new Set(ACTIONS.map((a) => a.id)).size, ACTIONS.length);
  for (const action of ACTIONS) assert.ok(action.route || action.action, action.id);
  for (const id of COMMON) assert.ok(ACTIONS.some((a) => a.id === id), id);
});

test('il nome del locale sceglie la pratica e resta fuori dalla ricerca', () => {
  const clients = [{ id: 'c1', name: 'Osteria Al Tralcio' }, { id: 'c2', name: 'Enoteca Il Calice Storto' }];
  assert.deepEqual(venueIn('foto al tralcio', clients), { client: clients[0], rest: 'foto' });
  assert.equal(venueIn('schede vini del Calice Storto', clients).client.id, 'c2');
  assert.equal(venueIn('foto', clients).client, null);
});

test('frasi di navigazione dette a Jarvis', () => {
  assert.equal(navigationPhrase('Apri le schede dei vini'), 'le schede dei vini');
  assert.equal(navigationPhrase("Dov'è il QR?"), 'il qr');
  assert.equal(navigationPhrase('portami alle foto del Tralcio'), 'foto del tralcio');
  assert.equal(navigationPhrase("Come faccio a mandare l'anteprima"), 'mandare l anteprima');
  assert.equal(navigationPhrase('mostrami i numeri'), null);
  assert.equal(navigationPhrase('quante pratiche ho'), null);
});

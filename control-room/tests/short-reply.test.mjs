import test from 'node:test';
import assert from 'node:assert/strict';
import { pickButton } from '../cloudflare/functions/_lib/short-reply.js';

const proposal = [['Fallo', 'prop:a:si'], ['Non ora', 'prop:a:dopo'], ['Mai', 'prop:a:mai']];
const list = [['Elimina la 1: «Menu pranzo» del 3 ott', 'del:r1'], ['Elimina la 2: «Menu cena» del 4 ott', 'del:r2'], ['Elimina tutte e 2', 'dela:c'], ['Nessuna', 'delno:x']];
const confirm = [['SÌ, elimina', 'del:r1'], ['No, tienila', 'delno:x']];
const clients = [['Al Bakaro (2 pratiche)', 'delq:c1'], ['Osteria Nuova', 'delq:c2'], ['Nessuna', 'delno:x']];
const publish = [['SÌ, pubblica', 'pub:m'], ['Non ancora', 'no:m']];
const pick = (said, buttons) => pickButton(said, buttons)?.data ?? pickButton(said, buttons);

test('risposte brevi: sì, no, non ora, mai sui pulsanti di una proposta', () => {
  assert.equal(pick('Sì', proposal), 'prop:a:si');
  assert.equal(pick('ok fallo', proposal), 'prop:a:si');
  assert.equal(pick('no', proposal), 'prop:a:dopo');
  assert.equal(pick('non ora grazie', proposal), 'prop:a:dopo');
  assert.equal(pick('mai', proposal), 'prop:a:mai');
});

test('risposte brevi: la seconda, l’ultima, una parola del pulsante', () => {
  assert.equal(pick('la seconda', clients), 'delq:c2');
  assert.equal(pick('la prima', clients), 'delq:c1');
  assert.equal(pick('l’ultima', clients), 'delq:c2');
  assert.equal(pick('Bakaro', clients), 'delq:c1');
  assert.equal(pick('osteria', clients), 'delq:c2');
});

test('risposte brevi: cancellare vale solo come sì a una conferma; il resto passa dal flusso che chiede conferma', () => {
  assert.equal(pick('sì', confirm), 'del:r1');
  assert.equal(pick('no', confirm), 'delno:x');
  assert.equal(pickButton('la seconda', list), null);
  assert.equal(pickButton('entrambe', list), null);
  assert.equal(pickButton('cena', list), null);
  assert.equal(pick('nessuna', list), 'delno:x');
});

test('risposte brevi: pubblicare resta un tocco', () => {
  assert.deepEqual(pickButton('sì', publish), { tapOnly: 'SÌ, pubblica' });
  assert.equal(pick('non ancora', publish), 'no:m');
});

test('risposte brevi: i comandi veri non vengono scambiati per una scelta', () => {
  for (const said of ['metti il coperto a 2', 'fammi vedere prima la bozza', 'mostrami tutte le pratiche', 'no, il frico costa 12', 'perfetto', 'cambia il prezzo del frico a 15 al Bakaro', 'come siamo messi oggi con le pratiche aperte dei locali?']) {
    assert.equal(pickButton(said, [...proposal, ...clients]), null, said);
  }
  assert.equal(pickButton('sì', []), null);
});

test('risposte brevi: «nessuno» e «tutti» su una scelta a tre', () => {
  const modes = [['Solo importanti', 'voce:importanti'], ['Tutti', 'voce:tutti'], ['Nessuno', 'voce:nessuno']];
  assert.equal(pick('nessuno', modes), 'voce:nessuno');
  assert.equal(pick('tutti', modes), 'voce:tutti');
  assert.equal(pick('solo importanti', modes), 'voce:importanti');
});

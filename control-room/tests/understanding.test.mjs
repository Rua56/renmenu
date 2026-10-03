import test from 'node:test';
import assert from 'node:assert/strict';
import { findDishes, findLocales, guessIntent, hintsText } from '../cloudflare/functions/_lib/understanding.js';
import { menuSummary } from '../cloudflare/functions/_lib/memory.js';

const clients = [{ id: 'a', name: 'Riccardo sei il migliore', menu_id: 'riccardo-sei-il-migliore' }, { id: 'b', name: 'Bakaro', menu_id: 'bakaro' }];
const summary = menuSummary({ nome: 'Riccardo sei il migliore', sezioni: [{ nome: 'Secondi', voci: [{ nome: 'Frico di patate con salame e cipolla (7,9,12)', prezzo: '14,00' }, { nome: 'Sarde alla veneziana(4)', prezzo: '12,00' }] }] });
const menus = [{ client: clients[0], summary }];

test('comprensione: riconosce il locale anche trascritto male', () => {
  assert.deepEqual(findLocales('metti il frico a 12 da riccardo sei il miliore', clients).map((c) => c.id), ['a']);
  assert.deepEqual(findLocales('come va al bacaro?', clients).map((c) => c.id), ['b']);
  assert.equal(findLocales('come va oggi?', clients).length, 0);
});

test('comprensione: dal piatto capisce locale e compito', () => {
  const dishes = findDishes('alza il frico a 15 euro', menus);
  assert.equal(dishes[0].dish.name, 'Frico di patate con salame e cipolla');
  assert.equal(dishes[0].dish.price, '14,00');
  const guess = guessIntent('alza il frico a 15 euro', { locales: [], dishes });
  assert.deepEqual(guess, { intent: 'aggiorna_menu', locale: 'Riccardo sei il migliore' });
  assert.match(hintsText({ locales: [], dishes, guess }), /Frico di patate.*14,00 €.*Riccardo sei il migliore/);
});

test('comprensione: domande, ricordi, nuove pratiche e pubblicazione', () => {
  const dishes = findDishes('quanto costa il frico?', menus);
  assert.equal(guessIntent('quanto costa il frico?', { dishes }).intent, 'risposta');
  assert.equal(guessIntent('segnati che riccardo sei il migliore chiude il lunedì', { locales: [clients[0]] }).intent, 'ricorda');
  assert.equal(guessIntent('apri una nuova pratica per la trattoria da mario, piano standard').intent, 'crea_pratica');
  assert.equal(guessIntent('mettilo online', { locales: [clients[0]] }).intent, 'pubblica');
  assert.equal(guessIntent('le sarde', { dishes: findDishes('le sarde', menus) }).intent, 'ambiguo');
});

test('comprensione: il nome del locale non viene scambiato per un numero o un ordine', () => {
  const locales = findLocales('le sarde da riccardo sei il migliore', clients);
  assert.equal(guessIntent('le sarde da riccardo sei il migliore', { locales, dishes: findDishes('le sarde', menus) }).intent, 'ambiguo');
  assert.equal(guessIntent('ricordami cosa devo fare oggi').intent, 'risposta');
  assert.equal(guessIntent('senti, il frico alzamelo a quindici euro', { dishes: findDishes('il frico alzamelo', menus) }).intent, 'aggiorna_menu');
});

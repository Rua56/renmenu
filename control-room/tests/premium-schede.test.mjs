// Schede Premium preparate da Jarvis: proposte solo su fatti sicuri, mai sui campi del cliente.
import assert from 'node:assert/strict';
import test from 'node:test';
import { applySchede, proposeSchede, sanitizeSchede, schedeTargets } from '../cloudflare/functions/_lib/premium-schede.js';
import { validateMenu } from '../cloudflare/functions/_lib/menu.js';

const menu = () => ({
  id: 'enoteca-prova', nome: 'Enoteca Prova', lingue: ['it', 'en'], premium: { direzione: 'bistrot' },
  sezioni: [
    { nome: { it: 'Cicchetti', en: 'Cicchetti' }, voci: [
      { nome: { it: 'Frico con polenta' }, prezzo: '9,00' },
      { nome: { it: 'Baccalà mantecato' }, prezzo: '4,00', descrizione: { it: 'Su crostino, ricetta della nonna' } }
    ] },
    { nome: { it: 'Vini bianchi', en: 'White wines' }, voci: [
      { nome: { it: 'Ribolla Gialla — Primosic' }, prezzi: [{ etichetta: { it: 'Calice' }, prezzo: '6,00' }, { etichetta: { it: 'Bottiglia' }, prezzo: '28,00' }], scheda: { cantina: 'Primosic' } },
      { nome: { it: 'Friulano' }, prezzo: '5,00', scheda: { vitigno: 'Friulano', territorio: 'Collio', profumo: 'Mandorla', gusto: 'Sapido' } }
    ] },
    { nome: { it: 'Bibite' }, voci: [{ nome: { it: 'Coca-Cola' }, prezzo: '3,00' }] }
  ]
});

test('voci da completare: vini con scheda scarna e piatti senza descrizione, niente bibite', () => {
  const t = schedeTargets(menu());
  assert.deepEqual(t.map((x) => [x.kind, x.name]), [['piatto', 'Frico con polenta'], ['vino', 'Ribolla Gialla — Primosic']]);
  assert.deepEqual(schedeTargets(menu(), ['Frico con polenta']).map((x) => x.name), ['Ribolla Gialla — Primosic']);
});

const wineAnswer = { id: 1, certezza: 'alta', vitigno: { it: 'Ribolla Gialla', en: 'Ribolla Gialla' }, territorio: { it: 'Collio goriziano', en: 'Collio, Gorizia' },
  colore: { it: 'Giallo paglierino', en: 'Straw yellow' }, profumo: { it: 'Fiori bianchi, mela, agrumi', en: 'White flowers, apple, citrus' }, gusto: { it: 'Fresco e sapido', en: 'Fresh and savoury' },
  abbinamenti: { it: 'Frico con polenta, pesce crudo', en: 'Frico with polenta, raw fish' }, nota: { it: 'Il bianco simbolo del Collio.', en: 'The signature white of the Collio.' },
  temperatura: '8-10 °C', profilo: { aromi: 70, struttura: 50, acidita: 75, dolcezza: 10, corpo: 45 } };

test('risposta del modello ripulita: certezza bassa, affermazioni vietate e campi fuori formato scartati', () => {
  const items = schedeTargets(menu());
  const { proposals, skipped } = sanitizeSchede({ voci: [{ id: 0, certezza: 'alta', descrizione: { it: 'Frico fatto in casa con Montasio' } }, wineAnswer] }, items, ['it', 'en']);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].scheda.temperatura, '8-10 °C');
  assert.equal(proposals[0].scheda.nota.it, 'Il bianco simbolo del Collio');
  assert.deepEqual(skipped, [{ name: 'Frico con polenta', reason: 'descrizione non accettata' }]);
  const low = sanitizeSchede({ voci: [{ ...wineAnswer, id: 0, certezza: 'bassa' }] }, [items[1]], ['it', 'en']);
  assert.equal(low.proposals.length, 0);
  assert.match(low.skipped[0].reason, /sicurezza/);
  const year = sanitizeSchede({ voci: [{ ...wineAnswer, id: 0, nota: { it: 'Vendemmia 2021 premiata' } }] }, [items[1]], ['it', 'en']);
  assert.equal(year.proposals[0].scheda.nota, undefined);
});

test('approvazione: la scheda del cliente resta, il menu resta valido, la provenienza dice che è di Jarvis', () => {
  const items = schedeTargets(menu());
  const { proposals } = sanitizeSchede({ voci: [{ id: 0, certezza: 'media', descrizione: { it: 'Formaggio Montasio e patate, croccante, con polenta', en: 'Montasio cheese and potatoes, crispy, with polenta' } }, wineAnswer] }, items, ['it', 'en']);
  const done = applySchede(menu(), proposals);
  assert.deepEqual(done.applied, ['Frico con polenta', 'Ribolla Gialla — Primosic']);
  const ribolla = done.menu.sezioni[1].voci[0];
  assert.equal(ribolla.scheda.cantina, 'Primosic');
  assert.equal(ribolla.scheda.vitigno.en, 'Ribolla Gialla');
  assert.equal(done.menu.sezioni[0].voci[0].descrizione.it, 'Formaggio Montasio e patate, croccante, con polenta');
  assert.ok(done.provenance.every((x) => x.status === 'da_verificare'));
  assert.deepEqual(validateMenu(done.menu).errors, []);
  // Bozza rifatta con le voci in un altro ordine: la scheda ritrova il suo vino per nome.
  const moved = menu(); moved.sezioni[1].voci.reverse();
  assert.equal(applySchede(moved, proposals).menu.sezioni[1].voci[1].scheda.gusto.it, 'Fresco e sapido');
});

test('proposta con Gemini (finto): un gruppo, testi nelle lingue del menu', async () => {
  const seen = [];
  const fetchImpl = async (url, options) => { seen.push(JSON.parse(options.body)); return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ voci: [{ id: 0, certezza: 'alta', descrizione: { it: 'Formaggio e patate dorati in padella, con polenta', en: 'Cheese and potatoes pan-fried until golden, with polenta' } }, wineAnswer] }) }] } }] }); };
  const out = await proposeSchede(menu(), { key: 'k', models: ['gemini-2.5-flash'], fetchImpl });
  assert.equal(out.proposals.length, 2);
  assert.equal(out.remaining, 0);
  assert.match(seen[0].system_instruction.parts[0].text, /Mai: prezzi, annate/);
  assert.match(seen[0].contents[0].parts[0].text, /Frico con polenta/);
  const none = await proposeSchede(menu(), null);
  assert.equal(none.unavailable, true);
});

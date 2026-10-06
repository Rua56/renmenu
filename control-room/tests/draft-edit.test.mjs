import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOps, normalizePrice, spokenPrices, validateOps, wordNumber } from '../cloudflare/functions/_lib/draft-edit.js';

const menu = () => ({
  id: 'prova', nome: 'Prova', lingue: ['it', 'en'],
  sezioni: [
    { nome: { it: 'Secondi' }, voci: [
      { nome: { it: 'Braciole di vitello o maiale' }, prezzo: '8,00' },
      { nome: { it: 'Frico con polenta' }, prezzo: '12,00' },
      { nome: { it: 'Strudel di mele' } }
    ] },
    { nome: { it: 'Vini' }, voci: [{ nome: { it: 'Friulano' }, prezzo: '5,00' }] }
  ]
});
const prov = () => [
  { path: 'sezioni.0.voci.0.prezzo', value: '8,00', source: 'foto', status: 'confermato' },
  { path: 'sezioni.0.voci.1.nome.it', value: 'Frico con polenta', source: 'foto', status: 'confermato' },
  { path: 'sezioni.0.voci.1.prezzo', value: '12,00', source: 'foto', status: 'confermato' },
  { path: 'sezioni.1.voci.0.prezzo', value: '5,00', source: 'foto', status: 'confermato' }
];

test('prezzi detti a cifre e a parole', () => {
  assert.equal(wordNumber('dodici'), 12); assert.equal(wordNumber('ventotto'), 28); assert.equal(wordNumber('trentacinque'), 35); assert.equal(wordNumber('cane'), null);
  assert.ok(spokenPrices('il frico costa 14').has('14,00'));
  assert.ok(spokenPrices('vitello 12,50 e maiale 8').has('12,50'));
  assert.ok(spokenPrices('costa dodici euro').has('12,00'));
  assert.ok(spokenPrices('otto e cinquanta').has('8,50'));
  assert.ok(spokenPrices('12 euro e 50').has('12,50'));
  assert.ok(spokenPrices('5 €').has('5,00'));
  assert.ok(!spokenPrices('il frico costa 14').has('12,00'));
  assert.equal(normalizePrice('9'), '9,00'); assert.equal(normalizePrice('9.5'), '9,50'); assert.equal(normalizePrice('abc'), null);
});

test('un prezzo non detto o una voce non nominata blocca tutto', () => {
  const said = 'il frico costa 14';
  assert.deepEqual(validateOps([{ tipo: 'prezzo', si: 0, vi: 1, prezzo: '14' }], menu(), said).problems, []);
  assert.match(validateOps([{ tipo: 'prezzo', si: 0, vi: 1, prezzo: '15' }], menu(), said).problems[0], /non ho sentito il prezzo 15,00/);
  assert.match(validateOps([{ tipo: 'prezzo', si: 1, vi: 0, prezzo: '14' }], menu(), said).problems[0], /non l’hai nominata/);
  assert.match(validateOps([{ tipo: 'prezzo', si: 9, vi: 0, prezzo: '14' }], menu(), said).problems[0], /non esiste/);
  assert.match(validateOps([{ tipo: 'aggiungi', si: 0, nome: 'Tartufo nero', prezzo: '14' }], menu(), said).problems[0], /nome non corrisponde/);
});

test('braciole: due prezzi diventano varianti sulla stessa voce', () => {
  const said = 'le braciole sono vitello 12 e maiale 8';
  const { ops, problems } = validateOps([{ tipo: 'varianti', si: 0, vi: 0, varianti: [{ etichetta: 'Vitello', prezzo: '12' }, { etichetta: 'Maiale', prezzo: '8' }] }], menu(), said);
  assert.deepEqual(problems, []);
  const out = applyOps(menu(), prov(), ops, 'Riccardo (Telegram)');
  const item = out.menu.sezioni[0].voci[0];
  assert.equal(item.prezzo, undefined);
  assert.deepEqual(item.prezzi.map((v) => [v.etichetta.it, v.prezzo]), [['Vitello', '12,00'], ['Maiale', '8,00']]);
  assert.ok(out.needsEnglish);
  assert.ok(!out.provenance.some((r) => r.path === 'sezioni.0.voci.0.prezzo' && r.source === 'foto'));
  assert.ok(out.provenance.some((r) => r.path === 'sezioni.0.voci.0.prezzi.1.prezzo' && r.value === '8,00' && r.source === 'Riccardo (Telegram)'));
  assert.ok(out.provenance.some((r) => r.path === 'sezioni.0.voci.1.prezzo' && r.source === 'foto'));
});

test('prezzo mancante: lo strudel riceve 5', () => {
  const { ops, problems } = validateOps([{ tipo: 'prezzo', si: 0, vi: 2, prezzo: '5' }], menu(), 'lo strudel di mele costa cinque euro');
  assert.deepEqual(problems, []);
  assert.equal(applyOps(menu(), prov(), ops, 'R').menu.sezioni[0].voci[2].prezzo, '5,00');
});

test('rimuovi e aggiungi: la provenienza segue le voci', () => {
  const said = 'togli le braciole e aggiungi tiramisù a 5 euro nei secondi';
  const { ops, problems } = validateOps([{ tipo: 'rimuovi', si: 0, vi: 0 }, { tipo: 'aggiungi', si: 0, nome: 'Tiramisù', prezzo: '5' }], menu(), said);
  assert.deepEqual(problems, []);
  const out = applyOps(menu(), prov(), ops, 'R');
  assert.deepEqual(out.menu.sezioni[0].voci.map((v) => v.nome.it), ['Frico con polenta', 'Strudel di mele', 'Tiramisù']);
  assert.ok(out.provenance.some((r) => r.path === 'sezioni.0.voci.0.prezzo' && r.value === '12,00' && r.source === 'foto'));
  assert.ok(!out.provenance.some((r) => r.path === 'sezioni.0.voci.1.prezzo' && r.source === 'foto'));
  assert.ok(out.provenance.some((r) => r.path === 'sezioni.0.voci.2.prezzo' && r.value === '5,00' && r.source === 'R'));
  assert.ok(!JSON.stringify(out.menu).includes('__'));
  // l'originale non viene toccato
  assert.equal(menu().sezioni[0].voci.length, 3);
});

test('descrizione e nome devono venire dalle parole dette', () => {
  const said = 'al frico metti la descrizione con patate e formaggio Montasio';
  assert.deepEqual(validateOps([{ tipo: 'descrizione', si: 0, vi: 1, descrizione: 'con patate e formaggio Montasio' }], menu(), said).problems, []);
  assert.match(validateOps([{ tipo: 'descrizione', si: 0, vi: 1, descrizione: 'con tartufo e foie gras' }], menu(), said).problems[0], /parole non dette/);
});

test('sposta, nuova sezione e rinomina sezione', () => {
  const said = 'sposta lo strudel di mele nei dolci, nuova sezione Dolci';
  const { ops, problems } = validateOps([
    { tipo: 'aggiungi', sezione: 'Dolci', nome: 'Strudel di mele', prezzo: '' }
  ], menu(), said);
  assert.deepEqual(problems, []);
  const out = applyOps(menu(), prov(), ops, 'R');
  assert.equal(out.menu.sezioni.at(-1).nome.it, 'Dolci');
  const moved = validateOps([{ tipo: 'sposta', si: 0, vi: 2, a_si: 1 }], menu(), 'sposta lo strudel di mele nei vini');
  assert.deepEqual(moved.problems, []);
  assert.equal(applyOps(menu(), prov(), moved.ops, 'R').menu.sezioni[1].voci.at(-1).nome.it, 'Strudel di mele');
});

test('sposta più voci in una sezione nuova, creata una sola volta', () => {
  const said = 'sposta frico con polenta e strudel di mele in una nuova sezione Bevande';
  const checked = validateOps([
    { tipo: 'sposta', si: 0, vi: 1, sezione: 'Bevande' },
    { tipo: 'sposta', si: 0, vi: 2, sezione: 'Bevande' }
  ], menu(), said);
  assert.deepEqual(checked.problems, []);
  const out = applyOps(menu(), prov(), checked.ops, 'R');
  assert.equal(out.menu.sezioni.length, 3);
  assert.equal(out.menu.sezioni[2].nome.it, 'Bevande');
  assert.deepEqual(out.menu.sezioni[2].voci.map((v) => v.nome.it), ['Frico con polenta', 'Strudel di mele']);
  assert.equal(out.menu.sezioni[0].voci.length, 1);
  assert.equal(out.needsEnglish, true);
  assert.ok(!JSON.stringify(out.menu).includes('__'));
  // il nome della nuova sezione deve venire dalla frase
  assert.match(validateOps([{ tipo: 'sposta', si: 0, vi: 1, sezione: 'Dolcezze' }], menu(), 'sposta il frico con polenta altrove').problems[0], /destinazione non valida/);
  // se la sezione esiste già, si usa quella
  assert.equal(validateOps([{ tipo: 'sposta', si: 0, vi: 1, sezione: 'Vini' }], menu(), 'sposta il frico con polenta nei vini').ops[0].a_si, 1);
});

test('il tipo di operazione scritto con varianti viene ricondotto, uno sconosciuto è segnalato', () => {
  const said = 'sposta lo strudel di mele nei vini';
  assert.equal(validateOps([{ tipo: 'Sposta_voce', si: 0, vi: 2, a_si: 1 }], menu(), said).ops.length, 1);
  assert.match(validateOps([{ tipo: 'cancella_tutto' }], menu(), said).problems[0], /tipo «cancella_tutto»/);
});

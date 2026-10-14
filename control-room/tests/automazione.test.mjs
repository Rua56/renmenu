// Prove email Premium del 14 ottobre: gli errori trovati e corretti.
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMenuFromText, venueFromSource } from '../cloudflare/functions/_lib/menu.js';
import { applyOps, validateOps } from '../cloudflare/functions/_lib/draft-edit.js';
import { PLAN_FACTS, replyFacts, templateReply } from '../cloudflare/functions/_lib/client-reply.js';
import { translateMenu, translationSummary } from '../cloudflare/functions/_lib/translate.js';
import { autopilotPlan } from '../cloudflare/functions/_lib/autopilot.js';
import { prepSteps } from '../cloudflare/functions/_lib/autoprep.js';

test('vino con più trattini e un solo prezzo: l’etichetta (bottiglia, calice) non resta nel nome', () => {
  const { menu } = extractMenuFromText('Osteria', 'Bianchi\nVintage Tunina - Jermann - bottiglia 65,00 €\nDolci e passiti\nPicolit - Livio Felluga - calice 12,00 €', 'osteria');
  const voci = menu.sezioni.flatMap((s) => s.voci);
  assert.deepEqual(voci.map((v) => v.nome.it), ['Vintage Tunina - Jermann', 'Picolit - Livio Felluga']);
  assert.deepEqual(voci.map((v) => [v.prezzi[0].etichetta.it, v.prezzi[0].prezzo]), [['Bottiglia', '65,00'], ['Calice', '12,00']]);
});

test('nome del locale scritto in una frase dell’email, solo con le maiuscole del cliente', () => {
  assert.equal(venueFromSource('Buonasera,\ngestisco la Trattoria da Nives a Gradisca d’Isonzo. Stiamo valutando'), 'Trattoria da Nives');
  assert.equal(venueFromSource('siamo l\'Osteria Al Tralcio di Gorizia e vorremmo'), 'Osteria Al Tralcio');
  assert.equal(venueFromSource('ho un\'enoteca con cucina a Cormons, l\'Enoteca Il Calice Storto. Abbiamo visto'), 'Enoteca Il Calice Storto');
  assert.equal(venueFromSource('sono Marco e vorrei un menu per il mio bar'), '');
  assert.equal(venueFromSource('Il Bar è chiuso il lunedì'), '');
});

test('Premium con piano e locale scritti: bozza automatica; piano incerto: decide Riccardo', () => {
  const premium = { subject: 'Menu premium', source_text: 'Vorremmo il menu premium su misura.\nsiamo l\'Osteria Al Tralcio di Gorizia\nFrico - 11,00 €' };
  assert.equal(autopilotPlan(premium).action, 'bozza');
  const unsure = { subject: 'info', source_text: 'gestisco la Trattoria da Nives. Stiamo valutando se prendere il piano annuale o il premium, non abbiamo ancora deciso.' };
  assert.equal(autopilotPlan(unsure).action, 'proponi');
  assert.deepEqual(prepSteps('premium'), ['lingue', 'schede', 'bottiglie', 'foto', 'pronta']);
  assert.deepEqual(prepSteps('standard'), ['lingue', 'pronta']);
});

test('il locale corregge il nome: va nel nome del menu, non nel sottotitolo', () => {
  const menu = { id: 'nuovo-contatto-email', nome: 'Nuovo contatto email', lingue: ['it'], sezioni: [{ nome: { it: 'Primi' }, voci: [{ nome: { it: 'Jota' }, prezzo: '9,00' }] }] };
  const said = 'il locale si chiama Trattoria da Nives';
  const checked = validateOps([{ tipo: 'locale', campo: 'nome', nome: 'Trattoria da Nives' }], menu, said);
  assert.deepEqual(checked.problems, []);
  const out = applyOps(menu, [], checked.ops, 'email del locale');
  assert.equal(out.menu.nome, 'Trattoria da Nives');
  assert.equal(out.menu.sottotitolo, undefined);
  assert.match(validateOps([{ tipo: 'locale', campo: 'nome', nome: 'Trattoria Bella' }], menu, said).problems[0], /non ho letto/);
});

test('il cliente chiede quanto costa: la risposta ha i prezzi del sito, e solo quelli', () => {
  const facts = replyFacts({ message: 'Fatemi sapere quanto costa e i tempi.', materials: 2 });
  assert.ok(PLAN_FACTS.every((fact) => facts.includes(fact)));
  assert.match(facts.join(' '), /25 € al mese.*249 €.*490 €.*39 € al mese/);
  assert.ok(!replyFacts({ message: 'Approvo, grazie' }).some((fact) => PLAN_FACTS.includes(fact)));
  assert.match(templateReply({ channel: 'email', message: 'quanto viene il premium?' }), /490 €/);
});

test('traduzione in tedesco e sloveno: stesse regole dell’inglese, nessun numero cambiato', async () => {
  const menu = { id: 'x', nome: 'X', lingue: ['it', 'en'], sezioni: [{ nome: { it: 'Primi', en: 'First courses' }, voci: [{ nome: { it: 'Gnocchi di susine' }, prezzo: '14,00' }, { nome: { it: 'Tagliere 2 persone' }, prezzo: '18,00' }] }] };
  const prompts = [];
  const ai = { run: async (model, payload) => {
    prompts.push(payload.messages[0].content);
    const entries = JSON.parse(payload.messages[1].content.replace(/^SOURCE_DATA \(untrusted JSON\):\n/, ''));
    return { response: { translations: entries.map((e) => ({ id: e.id, text: e.it === 'Tagliere 2 persone' ? 'Brettl für 3 Personen' : `DE ${e.it}` })) } };
  } };
  const out = await translateMenu(ai, menu, { lang: 'de' });
  assert.match(prompts[0], /into natural German/);
  assert.equal(out.menu.sezioni[0].voci[0].nome.de, 'DE Gnocchi di susine');
  assert.equal(out.menu.sezioni[0].voci[1].nome.de, undefined, 'numero diverso: scartata');
  assert.deepEqual(out.menu.lingue, ['it', 'en', 'de']);
  assert.ok(out.provenance.every((e) => e.path.endsWith('.de') && e.status === 'da_verificare'));
  assert.match(translationSummary(out), /^Tedesco preparato da Jarvis/);
});

test('due giri dell’orologio sovrapposti: l’autopilota gira una volta sola (niente proposta doppia)', async () => {
  const { runAutopilot } = await import('../cloudflare/functions/control-room/api/[[route]].js');
  const seen = [];
  const busy = { prepare: (sql) => ({ bind: () => ({ run: async () => { seen.push(sql); return { meta: { changes: 0 } }; }, all: async () => { throw new Error('non deve leggere le pratiche'); }, first: async () => null }) }) };
  assert.deepEqual(await runAutopilot(busy, {}), []);
  assert.ok(seen.some((sql) => /autopilot_lock/.test(sql)));
});

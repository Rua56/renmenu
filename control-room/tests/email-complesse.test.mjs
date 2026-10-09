// Email complessa e poco chiara (9 ottobre 2026, prova «Osteria Ponte Vecchio»): Jarvis deve leggerla
// fino in fondo senza inventare, senza inserire ciò che è dubbio e senza perdere nulla.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractMenuFromText, validateMenu, venueFromSource } from '../cloudflare/functions/_lib/menu.js';
import { extractVenueInfo, applyVenueInfo } from '../cloudflare/functions/_lib/venue-info.js';
import { reviewNotes, structureNotes } from '../cloudflare/functions/_lib/notes.js';
import { allExtras, applyExtras } from '../cloudflare/functions/_lib/extras.js';
import { creativeBrief, briefNotes, briefLines } from '../cloudflare/functions/_lib/premium.js';
import { prepareEmailSource, wrapWidth } from '../cloudflare/functions/_lib/email-text.js';

const RAW = readFileSync(new URL('./fixtures-email-ponte-vecchio.txt', import.meta.url), 'utf8');
const SOURCE = prepareEmailSource(RAW);

function run(source = SOURCE) {
  const venue = venueFromSource(source) || 'Osteria Ponte Vecchio';
  const ex = extractMenuFromText(venue, source, 'osteria-ponte-vecchio');
  const info = applyVenueInfo(ex.menu, extractVenueInfo(source));
  ex.menu = info.menu; ex.info = { applied: info.applied, doubts: info.doubts };
  const notes = [...reviewNotes({ sourceText: source, uncertain: ex.uncertain, extracted: ex.extracted, mode: ex.mode, info: ex.info, corrections: [] }), ...structureNotes(ex)];
  return { ex, notes, menu: ex.menu };
}
const section = (menu, name) => menu.sezioni.find((s) => s.nome.it === name);
const dish = (menu, rx) => menu.sezioni.flatMap((s) => s.voci).find((v) => rx.test(v.nome.it));
const prices = (v) => (v.prezzi || []).map((p) => `${p.etichetta.it} ${p.prezzo}`);

test('email a capo automatico: le righe spezzate si riuniscono, il numero di righe non cambia', () => {
  assert.equal(SOURCE.split('\n').length, RAW.split('\n').length);
  assert.ok(wrapWidth(RAW.split('\n')) >= 70);
  assert.match(SOURCE, /prezzo da decidere, circa 18-19 €/);
  assert.match(SOURCE, /Ribolla Gialla spumante brut, Azienda Zorzettig \(nome inventato\): 6 € al calice, 28 € in bottiglia/);
  assert.match(SOURCE, /tagliolini 1,3,7,9; cappesante/);
  // idempotente
  assert.equal(prepareEmailSource(SOURCE), SOURCE);
});

test('testo scritto a mano (una voce per riga) non viene toccato', () => {
  const manual = 'Antipasti\nBruschetta 5\nTagliere misto della casa con salumi e formaggi 12\nPrimi\nGnocchi 10\nTagliatelle al ragù 9\nSecondi\nTagliata 18\nOrata 16\nDolci\nTiramisù 6';
  assert.equal(prepareEmailSource(manual), manual);
  const short = 'Buongiorno,\nvorrei aggiornare il prezzo.\nGrazie';
  assert.equal(prepareEmailSource(short), short);
});

test('piatti e prezzi: quattro sezioni, nomi interi, nessun prezzo inventato', () => {
  const { menu } = run();
  assert.deepEqual(menu.sezioni.slice(0, 4).map((s) => [s.nome.it, s.voci.length]), [['Antipasti', 4], ['Primi', 3], ['Secondi', 2], ['Dolci', 2]]);
  assert.equal(dish(menu, /Prosciutto/).prezzo, '14,00');
  assert.equal(dish(menu, /Guancia/).prezzo, '22,00');
  // «prezzo da decidere, circa 18-19»: nessun prezzo, nessun numero scelto dall'intervallo
  const scallops = dish(menu, /Cappesante/);
  assert.equal(scallops.nome.it, 'Cappesante scottate, crema di topinambur');
  assert.equal(scallops.prezzo, undefined);
  // «prezzo al mercato, cambia ogni giorno»: è un piatto, senza prezzo fisso
  const bass = dish(menu, /Branzino/);
  assert.equal(bass.nome.it, 'Branzino al forno, olive e pomodorini');
  assert.equal(bass.prezzo, undefined);
  assert.match(bass.descrizione.it, /mercato/);
  // «(solo in primavera)» non è parte del nome
  const risotto = dish(menu, /Risotto/);
  assert.equal(risotto.nome.it, 'Risotto al Friulano e asparagi');
  assert.equal(risotto.descrizione.it, 'Solo in primavera');
  assert.equal(risotto.prezzo, '16,00');
});

test('percorso degustazione: titolo intero, due formule con i prezzi, regole in descrizione, il resto non è assorbito', () => {
  const { menu } = run();
  const tasting = menu.sezioni.find((s) => s.tipo === 'degustazione');
  assert.equal(tasting.nome.it, 'Percorso degustazione “Collio in 5 tempi”');
  assert.equal(tasting.prezzo, undefined, '«5 tempi» non è un prezzo');
  assert.deepEqual(tasting.voci.map((v) => v.nome.it), ['5 portate', '7 portate']);
  assert.deepEqual(prices(tasting.voci[0]), ['A persona 65,00', 'Con abbinamento di 4 calici 85,00']);
  assert.deepEqual(prices(tasting.voci[1]), ['A persona 85,00', 'Con abbinamento di 5 calici 115,00']);
  assert.match(tasting.descrizione.it, /minimo 2 persone/);
  assert.match(tasting.descrizione.it, /non è disponibile la domenica/);
});

test('carta dei vini: categorie, calice/bottiglia, «solo bottiglia», «solo calice», osservazioni tolte dal nome', () => {
  const { menu } = run();
  assert.deepEqual(menu.sezioni.slice(5).map((s) => s.nome.it), ['Bollicine', 'Bianchi del Collio', 'Rossi', 'Vini dolci']);
  const ribolla = dish(menu, /spumante brut/);
  assert.equal(ribolla.nome.it, 'Ribolla Gialla spumante brut, Azienda Zorzettig');
  assert.deepEqual(prices(ribolla), ['Calice 6,00', 'Bottiglia 28,00']);
  assert.deepEqual(prices(dish(menu, /Friulano, annata/)), ['Calice 6,00', 'Bottiglia 26,00']);
  assert.deepEqual(prices(dish(menu, /Pinot Grigio ramato/)), ['Bottiglia 32,00']);
  assert.deepEqual(prices(dish(menu, /Merlot riserva/)), ['Bottiglia 38,00']);
  assert.deepEqual(prices(dish(menu, /Picolit/)), ['Calice 12,00']);
  assert.ok(!menu.sezioni.some((s) => /carta dei vini/i.test(s.nome.it)));
  assert.ok(!menu.sezioni.flatMap((s) => s.voci).some((v) => /inventato|legenda|struttura è questa/i.test(v.nome.it)));
});

test('dati del locale: coperto con importo giusto e precisazione, orari, contatti, ferie da confermare', () => {
  const { menu, notes } = run();
  assert.equal(menu.coperto, '2,50');
  assert.equal(menu.telefono, '0481 000000');
  assert.equal(menu.instagram, 'osteriapontevecchio');
  assert.match(menu.orari.it, /Martedì–sabato 12:00–14:30 e 19:00–22:30/);
  assert.match(menu.orari.it, /Domenica 12:00–15:00/);
  assert.match(menu.orari.it, /Chiuso il lunedì/);
  assert.doesNotMatch(menu.orari.it, /agosto/i, 'le ferie con date non decise non entrano negli orari');
  const cover = notes.find((n) => /^Il coperto/.test(n.text));
  assert.equal(cover.kind, 'conferma');
  assert.match(cover.hint, /bambini sotto i 6 anni/);
  const hours = notes.find((n) => /^Orari:/.test(n.text));
  assert.equal(hours.kind, 'conferma');
  assert.match(hours.hint, /Chiusura per ferie/);
  assert.match(hours.hint, /date non sono decise/);
  const contacts = notes.find((n) => /^Contatti:/.test(n.text));
  assert.match(contacts.hint, /info@osteriapontevecchio-test\.example/);
});

test('allergeni: legenda UE verificata, numeri per piatto proposti, il resto da chiedere in cucina', () => {
  const { menu } = run();
  const extras = allExtras(RAW, menu);
  const byName = (rx) => extras.find((e) => e.type === 'allergeni' && rx.test(e.name));
  assert.deepEqual(byName(/Frico/).codes, ['7']);
  assert.deepEqual(byName(/Gnocchi/).codes, ['1', '3', '7']);
  assert.deepEqual(byName(/Tagliolini/).codes, ['1', '3', '7', '9']);
  assert.deepEqual(byName(/Cappesante/).codes, ['7', '14']);
  assert.deepEqual(byName(/Branzino/).codes, ['4']);
  assert.deepEqual(byName(/Gubana/).codes, ['1', '3', '7', '8', '12']);
  assert.equal(extras.filter((e) => e.type === 'allergeni').length, 6);
  const rest = extras.find((e) => e.type === 'manuale' && /tartare/i.test(e.source));
  assert.match(rest.note, /cucina/);
  assert.equal(new Set(extras.map((e) => e.id)).size, extras.length, 'identificativi unici');
  // Nulla entra nel menu senza la scelta di Riccardo; poi sì, e solo per i piatti scelti.
  assert.ok(menu.sezioni.flatMap((s) => s.voci).every((v) => !v.allergeni));
  const applied = applyExtras(menu, extras.filter((e) => e.type === 'allergeni'), (e) => `riga ${e.line}`);
  assert.deepEqual(dish(applied.menu, /Gnocchi/).allergeni, ['1', '3', '7']);
  assert.equal(dish(applied.menu, /Tartare/).allergeni, undefined);
});

test('legenda del cliente diversa da quella UE: nessuna conversione, una proposta manuale', () => {
  const odd = RAW.replace('1 glutine, 2 crostacei, 3 uova', '1 latte, 2 glutine, 3 uova');
  const extras = allExtras(odd, run().menu);
  assert.ok(!extras.some((e) => e.type === 'allergeni'));
  assert.ok(extras.some((e) => e.type === 'manuale' && /non coincide/.test(e.note)));
});

test('richieste e domande del cliente: una nota per ciascuna, mai una risposta di Jarvis', () => {
  const { notes } = run();
  const find = (rx) => notes.find((n) => rx.test(n.text));
  assert.equal(find(/Che tempi e prezzi/).kind, 'preventivo');
  assert.match(find(/Che tempi e prezzi/).hint, /rispondi tu/);
  assert.equal(find(/scritta/).kind, 'dicitura');
  assert.equal(find(/Le foto ve le mando/).kind, 'galleria');
  assert.ok(notes.some((n) => n.kind === 'storia'));
  assert.equal(find(/servizio è compreso/i).kind, 'servizio');
  assert.equal(find(/^1 glutine/).kind, 'allergeni');
  assert.equal(find(/^I numeri accanto ai piatti/).kind, 'allergeni');
  assert.match(find(/^I numeri accanto ai piatti/).hint, /Dati scritti dal locale/);
  assert.ok(notes.every((n) => n.text.length < 400), 'nessuna nota gigante');
});

test('Premium: riferimento, storia, galleria, schede vini, dicitura e acconto finiscono nella scheda creativa', () => {
  const brief = creativeBrief(SOURCE, { attachments: 0 });
  assert.deepEqual(brief.lingue, ['en', 'de', 'sl']);
  assert.ok(brief.colori.some((c) => c.nome === 'blu notte'));
  assert.ok(brief.riferimenti.some((r) => /Al Bakaro/.test(r.valore)));
  assert.equal(brief.riferimenti.length, 1, 'la frase sulla storia non è un riferimento');
  assert.equal(brief.scadenza, null, '«entro le 18» è l’orario di prenotazione del percorso, non una scadenza');
  assert.deepEqual(brief.storia.fatti, ['nato nel 1952 come mescita di vino']);
  assert.equal(brief.galleria.numero, '6-8');
  assert.ok(brief.schedeVini);
  assert.equal(brief.diciture[0].testo, 'piatti tutti fatti in casa');
  assert.equal(brief.diciture[0].dubbio, true);
  assert.equal(brief.preventivo.acconto, true);
  assert.equal(brief.preventivo.quando, 'questa settimana');
  const hints = briefNotes(brief).map((n) => n.hint).join(' | ');
  assert.match(hints, /solo l’inglese/);
  assert.match(hints, /non scrivo la storia da solo/i);
  assert.match(hints, /non l’ho inserita/);
  assert.match(hints, /totale lo decidi tu/);
  assert.ok(briefLines(brief).some((l) => /Galleria foto: 6-8 foto/.test(l)));
});

test('la bozza è valida e non contiene nulla di inventato', () => {
  const { menu, ex } = run();
  assert.deepEqual(validateMenu(menu).errors, []);
  const all = JSON.stringify(menu);
  assert.doesNotMatch(all, /19,00|18,00/, 'nessun prezzo preso dall’intervallo 18-19');
  assert.doesNotMatch(all, /fatti in casa|1952/, 'né la dicitura né la storia entrano da sole');
  assert.equal(ex.extracted.length, 23);
});

test('righe numerate o frasi non diventano piatti', () => {
  const { menu } = run();
  const names = menu.sezioni.flatMap((s) => s.voci.map((v) => v.nome.it));
  assert.ok(!names.some((n) => /^1 glutine|numeri accanto|servizio è compreso|coperto è|Il percorso si prenota/i.test(n)));
});

// Altra email «a mano», scritta male: prezzi come «10,-» o «€6», note dopo il prezzo, prezzo da chiedere, coperto negato.
const MESSY = readFileSync(new URL('./fixtures-email-disordinata.txt', import.meta.url), 'utf8');
test('email disordinata: prezzi scritti a mano, note dopo il prezzo, prezzo da chiedere, nessun piatto perso', () => {
  const { menu, notes } = run(prepareEmailSource(MESSY));
  assert.deepEqual(menu.sezioni.slice(0, 3).map((s) => [s.nome.it, s.voci.length]), [['Antipasti', 4], ['Primi piatti', 3], ['Secondi', 2]]);
  assert.equal(dish(menu, /Lasagne/).prezzo, '10,00');
  assert.equal(dish(menu, /Crostini/).prezzo, '6,00');
  const scoglio = dish(menu, /Spaghetti allo scoglio/);
  assert.equal(scoglio.prezzo, '14,00');
  assert.equal(scoglio.descrizione.it, 'Surgelato in inverno');
  assert.equal(dish(menu, /Tagliere/).descrizione.it, 'Per 2 persone');
  assert.equal(dish(menu, /Tagliata/).descrizione.it, 'Con rucola e grana');
  const pasta = dish(menu, /Pasta del giorno/);
  assert.equal(pasta.prezzo, undefined);
  assert.match(pasta.descrizione.it, /chiedere al personale/);
  assert.equal(dish(menu, /Frittura/).prezzo, undefined);
  assert.deepEqual(prices(dish(menu, /Vino della casa/)), ['1/4 l 4,00', '1/2 l 7,00', '1 l 12,00']);
  assert.equal(menu.coperto, undefined, '«il coperto non lo facciamo»: nessun coperto inserito');
  assert.ok(notes.some((n) => /non fa pagare il coperto/.test(n.hint)));
  assert.ok(notes.some((n) => n.kind === 'piatto' && /Menu pranzo di lavoro/.test(n.text)), 'la riga non letta resta in elenco, non sparisce');
  assert.deepEqual(validateMenu(menu).errors, []);
});

test('numeri tra parentesi dopo il prezzo restano allergeni, non diventano descrizione', () => {
  const r = extractMenuFromText('Bar X', 'Primi\nGnocchi 10 (1,3,7)\nRisotto 12\nSecondi\nOrata 16\nTagliata 18');
  const gnocchi = r.menu.sezioni.flatMap((s) => s.voci).find((v) => /Gnocchi/.test(v.nome.it));
  assert.ok(!/1,3,7/.test(gnocchi?.descrizione?.it || ''), 'nessuna descrizione «1,3,7»');
});

// Strutture dei menu veri (Al Bakaro, Blanch, «Il Culo di Alex» da Telegram, 2026-10-03):
// vini con calice e bottiglia, percorsi degustazione, descrizioni sotto il piatto, due letture foto.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractMenuFromText, validateMenu } from '../cloudflare/functions/_lib/menu.js';
import { combineReadings } from '../cloudflare/functions/_lib/vision.js';
import { structureNotes } from '../cloudflare/functions/_lib/notes.js';
import { translationEntries } from '../cloudflare/functions/_lib/translate.js';

const read = (text) => extractMenuFromText('Prova', text, 'prova');
const prices = (item) => (item.prezzi || []).map((p) => `${p.etichetta.it} ${p.prezzo}`);

describe('Vini e bevande con più prezzi', () => {
  it('etichette scritte, in tutte le forme dei clienti', () => {
    const r = read(['Vini bianchi', 'Ribolla Gialla — calice 5 / bottiglia 40', 'Friulano 2024 calice € 4,50 bottiglia € 26',
      'Malvasia: 5 € al calice, 30 € la bottiglia', 'Sauvignon (calice) 6 (bottiglia) 32', 'Vitovska — bicchiere 6 - bott. 35'].join('\n'));
    const voci = r.menu.sezioni[0].voci;
    assert.deepEqual(voci.map((v) => v.nome.it), ['Ribolla Gialla', 'Friulano 2024', 'Malvasia', 'Sauvignon', 'Vitovska']);
    assert.deepEqual(voci.map(prices), [['Calice 5,00', 'Bottiglia 40,00'], ['Calice 4,50', 'Bottiglia 26,00'], ['Calice 5,00', 'Bottiglia 30,00'], ['Calice 6,00', 'Bottiglia 32,00'], ['Calice 6,00', 'Bottiglia 35,00']]);
    assert.ok(voci.every((v) => v.prezzo === undefined));
    assert.deepEqual(r.uncertain, []);
    assert.deepEqual(r.confirm, []);
    assert.deepEqual(validateMenu(r.menu).errors, []);
  });
  it('due prezzi senza etichetta: calice/bottiglia solo in una sezione vini, e da confermare', () => {
    const wine = read('Vini rossi\nMerlot 5/25\nRefosco 6,00 30,00');
    assert.deepEqual(wine.menu.sezioni[0].voci.map(prices), [['Calice 5,00', 'Bottiglia 25,00'], ['Calice 6,00', 'Bottiglia 30,00']]);
    assert.equal(wine.confirm.length, 2);
    assert.match(wine.confirm[0].hint, /Conferma/);
    // Fuori da una sezione vini o con prezzi al contrario: nessuna etichetta inventata.
    const food = read('Primi\nGnocchi 10/12\nTagliatelle 9');
    assert.ok(!food.menu.sezioni.flatMap((s) => s.voci).some((v) => v.prezzi));
    const reversed = read('Vini rossi\nMerlot 25/5\nRefosco 6');
    assert.ok(!reversed.menu.sezioni.flatMap((s) => s.voci).some((v) => v.prezzi));
  });
  it('colonne dichiarate («calice  bottiglia»), righe «calice 5» sotto il nome, «(calice)/(bottiglia)» su due righe', () => {
    const cols = read('VINI BIANCHI   calice   bottiglia\nCabernet Franc 5 33\nSchioppettino 6,50 38,00');
    assert.equal(cols.menu.sezioni[0].nome.it, 'Vini bianchi');
    assert.deepEqual(cols.menu.sezioni[0].voci.map(prices), [['Calice 5,00', 'Bottiglia 33,00'], ['Calice 6,50', 'Bottiglia 38,00']]);
    assert.deepEqual(cols.confirm, []);
    const lines = read('Vini\nVitovska\ncalice 6\nbottiglia 35\nRibolla — 5');
    assert.deepEqual(lines.menu.sezioni[0].voci.map((v) => [v.nome.it, v.prezzo || prices(v).join(' | ')]), [['Vitovska', 'Calice 6,00 | Bottiglia 35,00'], ['Ribolla', '5,00']]);
    assert.deepEqual(lines.uncertain, []);
    const pairs = read('# Vini rossi\nMerlot (calice) — 5\nMerlot (bottiglia) — 25\nRefosco — 6');
    assert.deepEqual(pairs.menu.sezioni[0].voci.map((v) => [v.nome.it, v.prezzo || prices(v).join(' | ')]), [['Merlot', 'Calice 5,00 | Bottiglia 25,00'], ['Refosco', '6,00']]);
  });
  it('mai un prezzo senza nome, mai un anno o una quantità come prezzo', () => {
    const r = read('Birre\nMoretti\npiccola 3 grande 5\ncalice 7\nMoretti Grande 5,00\nAcqua 0,75 l 3\nFriulano 2023 — 28\nQuartino 1/4 l 4');
    const voci = r.menu.sezioni[0].voci;
    assert.deepEqual(voci.map((v) => [v.nome.it, v.prezzo || prices(v).join(' | ')]), [['Moretti', 'Piccola 3,00 | Grande 5,00'], ['Moretti Grande', '5,00'], ['Acqua 0,75 l', '3,00'], ['Friulano 2023', '28,00'], ['Quartino 1/4 l', '4,00']]);
    assert.deepEqual(r.uncertain, ['calice 7']);
  });
});

describe('Percorsi degustazione', () => {
  it('titolo con prezzo a persona, portate, descrizione e abbinamento vini', () => {
    const r = read(['PERCORSO DEGUSTAZIONE — 55 € a persona, vini esclusi', 'Frico e polenta', 'Gnocchi di susine', 'burro e cannella',
      'Guancia di manzo al Collio', 'Gubana della casa', 'Abbinamento vini 25 €', '# Dolci', 'Tiramisù 6'].join('\n'));
    const [degu, dolci] = r.menu.sezioni;
    assert.equal(degu.tipo, 'degustazione');
    assert.equal(degu.nome.it, 'Percorso degustazione');
    assert.equal(degu.prezzo, '55,00');
    assert.equal(degu.unita.it, 'a persona, vini esclusi');
    assert.deepEqual(degu.voci.map((v) => v.nome.it), ['Frico e polenta', 'Gnocchi di susine', 'Guancia di manzo al Collio', 'Gubana della casa', 'Abbinamento vini']);
    assert.equal(degu.voci[1].descrizione.it, 'burro e cannella');
    assert.equal(degu.voci[4].prezzo, '25,00');
    assert.ok(degu.voci.slice(0, 4).every((v) => !v.prezzo));
    assert.deepEqual(dolci.voci.map((v) => v.prezzo), ['6,00']);
    assert.deepEqual(validateMenu(r.menu).errors, []);
  });
  it('prezzo su una riga a parte, con il minimo di persone', () => {
    const r = read('Menu degustazione del territorio\nAntipasto di salumi\nCjarsons\nPrezzo 48 euro a persona (minimo 2 persone)');
    assert.equal(r.menu.sezioni[0].prezzo, '48,00');
    assert.equal(r.menu.sezioni[0].unita.it, 'a persona, minimo 2 persone');
    assert.equal(r.menu.sezioni[0].voci.length, 2);
  });
  it('percorso senza prezzo scritto: nessun prezzo inventato, nota da completare', () => {
    const r = read('Percorso del territorio\nFrico\nCjarsons\nGubana');
    assert.equal(r.menu.sezioni[0].tipo, 'degustazione');
    assert.equal(r.menu.sezioni[0].prezzo, undefined);
    assert.ok(r.confirm.some((c) => /senza prezzo/.test(c.hint)));
  });
  it('un percorso citato solo a parole resta testo, mai una sezione', () => {
    const r = read('Antipasti\nFrico con polenta — 9\nAbbiamo anche un percorso degustazione da 55 euro a persona.\nGrazie, a presto');
    assert.ok(!r.menu.sezioni.some((s) => s.tipo === 'degustazione'));
    assert.ok(r.uncertain.some((u) => /percorso degustazione/.test(u)));
    // «Degustazione di formaggi 12» è un piatto, non un percorso.
    const dish = read('Formaggi\nDegustazione di formaggi 12\nTagliere 15');
    assert.deepEqual(dish.menu.sezioni[0].voci.map((v) => [v.nome.it, v.prezzo]), [['Degustazione di formaggi', '12,00'], ['Tagliere', '15,00']]);
  });
});

describe('Descrizioni sotto il piatto', () => {
  it('ingredienti in maiuscolo con i numeri degli allergeni: descrizione e nota, allergeni mai assegnati', () => {
    const r = read('Gli Antipasti\nSalmone e Barbabietola 15,00\nCON BARBABIETOLA SOTTACETO, PISTACCHIO TOSTATO, AVOCADO E EMULSIONE DI KEFIR (7-8-12)\nProsciutto di Picanha 17,00');
    const [salmone, picanha] = r.menu.sezioni[0].voci;
    assert.equal(salmone.descrizione.it, 'Con barbabietola sottaceto, pistacchio tostato, avocado e emulsione di kefir (7-8-12)');
    assert.equal(salmone.allergeni, undefined);
    assert.equal(picanha.descrizione, undefined);
    assert.ok(r.confirm.some((c) => /7, 8, 12/.test(c.hint)));
    assert.ok(r.provenance.some((p) => p.path === 'sezioni.0.voci.0.descrizione.it' && p.source === 'riga 3'));
  });
  it('descrizione del vino (DOC, note) e riga «> » delle foto', () => {
    const r = read('Vini bianchi\nPinot Grigio 5/28\nCollio DOC, fresco e minerale\nRibolla — 6\n> macerata sulle bucce');
    assert.deepEqual(r.menu.sezioni[0].voci.map((v) => v.descrizione?.it), ['Collio DOC, fresco e minerale', 'macerata sulle bucce']);
  });
  it('una frase dell’email dopo i piatti non diventa una descrizione', () => {
    const r = read('Antipasti\nFrico con polenta — 9\nGrazie mille, a presto');
    assert.equal(r.menu.sezioni[0].voci[0].descrizione, undefined);
  });
});

describe('Foto: due letture anche con nomi, descrizioni, calici e percorsi', () => {
  it('una lettura scrive la descrizione al posto del nome: stesso posto e stesso prezzo → voce confermata', () => {
    const first = '# Antipasti\nSalmone e Barbabietola — 15\n> CON BARBABIETOLA SOTTACETO, PISTACCHIO TOSTATO, AVOCADO E EMULSIONE DI KEFIR (7-8-12)\nProsciutto di Picanha — 17\n> MARINATO E AFFUMICATO (9)';
    const second = '# ANTIPASTI\nCON BARBABIETOLA SOTTACETO, PISTACCHIO TOSTATO, AVOCADO E EMULSIONE DI KEFIR (7-8-12) — 15\nMARINATO E AFFUMICATO IN CROSTA (9) — 17';
    const c = combineReadings(first, second);
    assert.equal(c.agreed, 2);
    const voci = read(c.text).menu.sezioni[0].voci;
    assert.deepEqual(voci.map((v) => [v.nome.it, v.prezzo]), [['Salmone e Barbabietola', '15,00'], ['Prosciutto di Picanha', '17,00']]);
    assert.match(voci[0].descrizione.it, /^Con barbabietola sottaceto/);
    // Descrizione diversa tra le due letture: non entra, resta da verificare.
    assert.equal(voci[1].descrizione, undefined);
    assert.match(c.text, /\[da verificare\] Descrizione di «Prosciutto di Picanha»/);
  });
  it('prezzi diversi o al posto sbagliato: mai confermati', () => {
    const c = combineReadings('# Antipasti\nSalmone — 15\nPicanha — 17', '# Antipasti\nCON BARBABIETOLA, AVOCADO — 16\nPicanha — 17');
    assert.equal(c.agreed, 1);
    assert.match(c.text, /\[da verificare\] Salmone: letto 15,00/);
  });
  it('calice e bottiglia: entrano solo se tutti i prezzi coincidono; il percorso solo con lo stesso prezzo', () => {
    const c = combineReadings('# Vini bianchi\nRibolla Gialla — calice 5 / bottiglia 40\nFriulano — calice 4,5 / bottiglia 26\n# Percorso degustazione — 55 a persona\nFrico\nCjarsons\nAbbinamento vini — 25',
      '# VINI BIANCHI\nRibolla Gialla — bicchiere 5 / bottiglia 40\nFriulano — calice 4,50 / bottiglia 28\n# Menu degustazione — 55 a persona\nFrico\nCjarsons\nAbbinamento vini — 25');
    const r = read(c.text);
    assert.deepEqual(r.menu.sezioni[0].voci.map(prices), [['Calice 5,00', 'Bottiglia 40,00']]);
    assert.match(c.text, /\[da verificare\] Friulano: letto calice 4,50 \/ bottiglia 26,00, seconda lettura calice 4,50 \/ bottiglia 28,00/);
    const degu = r.menu.sezioni[1];
    assert.equal(degu.tipo, 'degustazione');
    assert.equal(degu.prezzo, '55,00');
    assert.deepEqual(degu.voci.map((v) => [v.nome.it, v.prezzo || '']), [['Frico', ''], ['Cjarsons', ''], ['Abbinamento vini', '25,00']]);
    const other = combineReadings('# Percorso degustazione — 55 a persona\nFrico\nCjarsons', '# Percorso degustazione — 65 a persona\nFrico\nCjarsons');
    assert.equal(read(other.text).menu.sezioni[0].prezzo, undefined);
    assert.match(other.text, /Prezzo del percorso «Percorso degustazione»: letto 55,00, seconda lettura 65,00/);
  });
});

describe('Foto reali «Il Culo di Alex» (letture dal vivo del 3 ottobre)', () => {
  it('nome in maiuscolo da una lettura: si tiene quello normale; avvisi della foto mai persi', () => {
    const c = combineReadings('# I Primi\nFregola e Polipetti — 15\n> con crema di zucchine, verdure croccanti (1-4-7)',
      '# I PRIMI\n\nFREGOLA E POLIPETTI — 15\n> CON CREMA DI ZUCCHINE, VERDURE CROCCANTI (1-4-7)\n\nTUTTE LE NOSTRE PASTE, FRESCHE, SONO FATTE IN CASA E TIRATE RIGOROSAMENTE AL MATTARELLO');
    assert.equal(c.agreed, 1);
    assert.match(c.text, /^# I Primi\nFregola e Polipetti — 15,00\n> con crema di zucchine, verdure croccanti \(1-4-7\)/);
    assert.match(c.text, /\[da verificare\] Testo sulla foto \(non è un piatto\): «TUTTE LE NOSTRE PASTE/);
    const d = combineReadings('# Primi\nFREGOLA — 15', '# I PRIMI\nFregola — 15');
    assert.equal(d.text, '# Primi\nFregola — 15,00');
  });
});

describe('Note, traduzioni e Revisione', () => {
  it('note: etichette dedotte da confermare, voci con più prezzi e percorsi elencati', () => {
    const r = read('# Percorso degustazione — 55 € a persona\nFrico\nCjarsons\n# Vini\nRibolla — calice 5 / bottiglia 40\nFriulano 5/30');
    const notes = structureNotes(r);
    assert.ok(notes.some((n) => n.kind === 'conferma' && /Friulano/.test(n.text)));
    assert.ok(notes.some((n) => n.kind === 'inserito' && /Ribolla: Calice 5,00 · Bottiglia 40,00/.test(n.text)));
    assert.ok(notes.some((n) => n.kind === 'inserito' && /Percorso degustazione — 55,00 € a persona/.test(n.text)));
  });
  it('traduzione: anche etichette dei prezzi e unità del percorso', () => {
    const r = read('# Percorso degustazione — 55 € a persona\nFrico\nCjarsons\n# Vini\nRibolla — calice 5 / bottiglia 40');
    const paths = translationEntries(r.menu).map((e) => e.path);
    assert.ok(paths.includes('sezioni.0.unita'));
    assert.ok(paths.includes('sezioni.1.voci.0.prezzi.0.etichetta'));
    assert.ok(paths.includes('sezioni.1.voci.0.prezzi.1.etichetta'));
  });
});

describe('Numeri degli allergeni scritti sotto i piatti', () => {
  it('proposte non preselezionate, solo numeri UE validi, mai su piatti con allergeni già inseriti', async () => {
    const { proposeMenuAllergens, applyExtras } = await import('../cloudflare/functions/_lib/extras.js');
    const r = read('Primi\nFregola e Polipetti 15\ncon crema di zucchine (1-4-7)\nGnocchi 14\ncon burro (1-3-27)\nRisotto 17\ncon cozze (3-9-14)');
    r.menu.sezioni[0].voci[2].allergeni = ['14'];
    const proposals = proposeMenuAllergens(r.menu);
    assert.deepEqual(proposals.map((p) => [p.name, p.codes.join(','), p.legend]), [['Fregola e Polipetti', '1,4,7', true]]);
    const applied = applyExtras(r.menu, proposals, () => 'numeri allergeni scritti dal locale sotto il piatto');
    assert.deepEqual(applied.menu.sezioni[0].voci[0].allergeni, ['1', '4', '7']);
    const notes = structureNotes(r);
    assert.equal(notes.filter((n) => n.kind === 'allergeni').length, 1);
  });
});

describe('Pagina «Mescita — by the glass» (foto reale «Il Culo di Alex»)', () => {
  it('prezzo singolo al calice: la sezione dei vini lo dice, i nomi restano come scritti', () => {
    const first = '# Mescita — by the glass\n# Bollicine\nRodaro Brut Nature — 7\n# Vini Bianchi\nErmacora Friulano 2024 — 4.5\nAquila Del Torre Torre Bianco (Sauvignon, Friulano) 2022 — 5\n# Vini Rossi\nPetrussa Merlot 2023 — 5.5';
    const second = '# MESCITA\n— by the glass —\n# BOLLICINE\nRodaro Brut Nature — 7\n# VINI BIANCHI\nErmacora Friulano 2024 — 4.5\nAquila del Torre Torre Bianco (Sauvignon, Friulano) 2022 — 5\n# VINI ROSSI\nPetrussa Merlot 2023 — 5.5';
    const c = combineReadings(first, second);
    assert.equal(c.agreed, 4);
    const r = read(c.text);
    assert.deepEqual(r.menu.sezioni.map((s) => [s.nome.it, s.descrizione?.it]), [['Bollicine', 'Al calice'], ['Vini Bianchi', 'Al calice'], ['Vini Rossi', 'Al calice']]);
    assert.deepEqual(r.menu.sezioni[1].voci.map((v) => [v.nome.it, v.prezzo]), [['Ermacora Friulano 2024', '4,50'], ['Aquila Del Torre Torre Bianco (Sauvignon, Friulano) 2022', '5,00']]);
    // Le sezioni di cibo dopo la pagina dei vini non diventano «al calice».
    const mixed = read('# Vini al calice\n# Vini bianchi\nFriulano — 5\n# Primi\nGnocchi — 12');
    assert.deepEqual(mixed.menu.sezioni.map((s) => s.descrizione?.it || ''), ['Al calice', '']);
  });
});

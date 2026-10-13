/* Menu senza sezioni sul materiale (La Chincaglieria Gastronomica, foto reali del 6 ottobre 2026):
 * una sola sezione «Piatti», nell'ordine delle foto, e la sola sezione scritta sul menu («Dolci»). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SECTION, extractMenuFromText, validateMenu } from '../cloudflare/functions/_lib/menu.js';
import { applyOps } from '../cloudflare/functions/_lib/draft-edit.js';

// Testi letti da Jarvis, nell'ordine in cui le foto sono state mandate.
const FOTO = [
  "Prosciutto crudo artigianale D’Osvaldo, pancetta arrotolata, ossocollo, salama, mortadella di Cinghiale al tartufo — 18,00\nLa nostra selezione di formaggi accompagnata dal miele e dalle confetture dei nostri artigiani — 12,00\n# Dal materiale ricevuto\nLA ZUCCA IN SAOR — 10,00\n> Zucca al forno, cipolla rossa, pinoli e uvetta Allergeni: 12 contiene prodotti naturalmente privi di glutine\nLA TARTARA D’ASINO, CREMA AL CREN E FORMAGGIO, PETALI DI CIPOLLA E SUSINE — 16,00\n> Allergeni: 7,12 contiene prodotti naturalmente privi di glutine\nLA “MILLEFOGLIE” DI SARDE SCOTTATE, PANE ALL’AGLIO E MOZZARELLA — 13,00\n> Allergeni: 1, 4, 7 *\nL’UOVO, I FUNGHI ED IL FORMAGGIO — 15,00\n> uovo morbido, crema di funghi, funghi arrosto e Vecchio Zoff Allergeni: 7 *@\nGLI GNOCCHI DI RICOTTA, CREMA DI FAGIOLI, GUANCIALE E ACETO — 14,00\n> Allergeni: 1, 3, 7, 9, 12 @\n[da verificare] IL CARPACCIO DI FICHI, PROSCIUTTO D’OSVALDO, NOCI E CACIOTTA — [?]\n[da verificare] Descrizione di «Prosciutto crudo artigianale D’Osvaldo, pancetta arrotolata, ossocollo, salama, mortadella di Cinghiale al tartufo» letta una sola volta: «Prosciutto crudo artigianale D’Osvaldo, pancetta arrotolata, ossocollo, salama, mortadella di Cinghiale al tartufo (consigliato per due) Allergeni: contiene pro»\n[da verificare] Descrizione di «La nostra selezione di formaggi accompagnata dal miele e dalle confetture dei nostri artigiani» letta una sola volta: «La nostra selezione di formaggi accompagnata dal miele e dalle confetture dei nostri artigiani Allergeni: 7 contiene prodotti naturalmente privi di glutine, può»\n[da verificare] Testo sulla foto (non è un piatto): «> Allergeni: 7,8 contiene prodotti naturalmente privi di glutine»\n[da verificare] Testo sulla foto (non è un piatto): «Zucca al forno, cipolla rossa, pinoli e uvetta»\n[da verificare] Testo sulla foto (non è un piatto): «> Allergeni: 1, 4, 7 *»\n[da verificare] Testo sulla foto (non è un piatto): «> Allergeni: 1, 3, 7, 9, 12 @»",
  "IL RISOTTO MANTECATO CON IL CAPRINO, UVA, NOCCIOLE E CAPPERI (min. per2) — 14,00\n> Allergeni: 7, 8,9 contiene prodotti naturalmente privi di glutine\nI TORTELLI FATTI IN CASA, PATE' DI FEGATO DI VITELLO E LA FONDUTA DI FORMAGGIO STAGIONATO AL TABACCO — 14,00\n> Allergeni: 1, 3, 7, 9 @\nLE TAGLIATELLE FATTE IN CASA, PITINA E ZUCCA — 15,00\n> Allergeni: 1, 3, 7, 12 @\nLA VELLUTATA DI SEDANO RAPA, L'ANGUILLA AFFUMICATA E CUBETTI DI PAN TOSTATO — 14,00\n> Allergeni:1, 4, 7, 9 @\nGLI GNOCCHI DI PANE ED IL RAGU' DI CINGHIALE — 15,00\n> Allergeni: 1, 3, 7, 9 * @\nLE SEPPIE MARINATE ALL'ANETO E AGRUMI E SCOTTATE IN PADELLA, JULIENNE DI VERDURE CROCCANTI — 14,00\n> Allergeni: 4, 9 * @ contiene prodotti naturalmente privi di glutine\nLA CIPOLLA: tortino alla cipolla, scalogno caramellato, petali di cipolla all'aceto di more ed uvetta, crema di tenerone — 12,00\n> Allergeni: 7 contiene prodotti naturalmente privi di glutine\nANIMELLE AL BURRO, SUSINE E VERMOUTH — 16,00\n> Allergeni: 7, 12 contiene prodotti naturalmente privi di glutine * @\nTORTINO DI LJUBLJANSKA AL FORNO, CREN, MELE, SENAPE E AJVAR — 15,00\n> Allergeni: 7,10, 12 contiene prodotti naturalmente privi di glutine\nIL FRICO CON LA POLENTA — 10,00\n> Allergeni: 7 contiene prodotti naturalmente privi di glutine",
  "PATATE IN TECIA — 5,00\n> Allergeni: --\nMELANZANE AL FUNGHETTO — 5,00\n> (9)\n# Dolci\nGNOCCHI DI SUSINE DELLA TRADIZIONE MITTELEUROPEA — 7,00\n> Allergeni: 1, 3, 7 @\nLA MELA — 7,00\n> (3-7-8) mela cotta al forno, crema alla vaniglia, crumble salato alle mandorle e gelato alla cannella\nIL CIOCCOLATO, OLIO E SALE — 7,00\n> (1-7) mousse al cioccolato fondente, olio extravergine locale, sale e briciole di pane tostato al rosmarino\nIL “MONTEBIANCO” DELLA CHINCA — 7,00\n> (7) Castagna, mascarpone al caffè, cioccolato e grappa\nGUBANA DELL’ANTICA RICETTA — 4,00\n> (1-3-7-8)"
];

// Stessa unione che fa la bozza: un file che comincia con piatti senza titolo apre la sezione «Piatti».
const unisci = (files) => files.reduce((acc, text) => {
  const first = text.split(/\r?\n/).find((l) => l.trim());
  return `${acc}${acc.trim() && first && !/^\s*#/.test(first) ? `\n# ${DEFAULT_SECTION}` : ''}\n${text}`;
}, '');

test('foto senza titoli di sezione: una sola sezione «Piatti», poi «Dolci»', () => {
  const { menu } = extractMenuFromText('La Chincaglieria Gastronomica', unisci(FOTO), 'la-chincaglieria-gastronomica');
  assert.deepEqual(menu.sezioni.map((s) => s.nome.it), [DEFAULT_SECTION, 'Dolci']);
  assert.equal(menu.sezioni[0].nome.it, 'Piatti');
  const nomi = menu.sezioni[0].voci.map((v) => v.nome.it);
  assert.equal(nomi.length, 19);
  assert.match(nomi[0], /TAGLIERE|Prosciutto/i, 'l’ordine è quello delle foto: si comincia dalla prima');
  assert.ok(nomi.includes('PATATE IN TECIA') && nomi.includes('IL FRICO CON LA POLENTA'));
  assert.equal(menu.sezioni[1].voci.length, 5);
  assert.ok(!menu.sezioni[1].voci.some((v) => /Prosciutto|formaggi|ZUCCA/i.test(v.nome.it)), 'nessun piatto estraneo nei dolci');
  assert.deepEqual(validateMenu(menu).errors, []);
});

test('anche con le foto in ordine diverso nessun piatto finisce nei dolci', () => {
  const { menu } = extractMenuFromText('La Chincaglieria Gastronomica', unisci([FOTO[2], FOTO[0], FOTO[1]]), 'la-chincaglieria-gastronomica');
  const dolci = menu.sezioni.find((s) => s.nome.it === 'Dolci');
  assert.equal(dolci.voci.length, 5);
  assert.equal(menu.sezioni.filter((s) => s.nome.it === 'Piatti').length, 1, 'una sola sezione Piatti');
});

test('dare un altro nome alla sezione Piatti a voce funziona come per ogni sezione', () => {
  const { menu } = extractMenuFromText('La Chincaglieria Gastronomica', unisci(FOTO), 'la-chincaglieria-gastronomica');
  const out = applyOps(menu, [], [{ tipo: 'rinomina_sezione', si: 0, nome: 'Il menu' }], 'Riccardo');
  assert.equal(out.menu.sezioni[0].nome.it, 'Il menu');
});

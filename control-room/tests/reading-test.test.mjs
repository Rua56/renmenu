import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { CASES_URL, draftFromReadings, lastReadingTest, menuItems, nameScore, readingTestStep, reportText, scoreCase, startReadingTest } from '../cloudflare/functions/_lib/reading-test.js';

const menu = (sections) => ({ sezioni: sections.map(([nome, voci]) => ({ nome: { it: nome }, voci: voci.map(([n, p]) => (Array.isArray(p) ? { nome: { it: n }, prezzi: p.map((x, i) => ({ etichetta: { it: `v${i}` }, prezzo: x })) } : { nome: { it: n }, prezzo: p })) })) });

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE jarvis_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE drafts (request_id TEXT, menu_json TEXT)');
  return {
    sqlite,
    prepare(sql) {
      return { bind(...params) {
        const statement = sqlite.prepare(sql);
        return { first: async () => statement.get(...params) || null, all: async () => ({ results: statement.all(...params) }), run: async () => ({ meta: { changes: statement.run(...params).changes } }) };
      } };
    }
  };
}

describe('prova di lettura: confronto', () => {
  it('riconosce lo stesso piatto scritto in modo diverso', () => {
    assert.ok(nameScore('Tiramisù della casa', 'TIRAMISU DELLA CASA') >= 0.9);
    assert.ok(nameScore('Gnocchi di ricotta, crema di fagioli', 'Gnocchi di ricotta crema di fagioli e guanciale') >= 0.6);
    assert.ok(nameScore('Frico con polenta', 'Tartare di manzo') < 0.6);
  });

  it('conta giusti, prezzi sbagliati, da verificare, persi e voci in più', () => {
    const truth = menu([['Primi', [['Gnocchi di ricotta', '14,00'], ['Tagliatelle alla pitina', '15,00'], ['Frico con polenta', '10,00'], ['Zucca in saor', '10,00']]], ['Vini', [['Ribolla', ['5,00', '28,00']]]]]);
    const draft = menu([['Primi', [['GNOCCHI DI RICOTTA', '14'], ['Tagliatelle alla pitina', '16,00'], ['Coperto', '2,50']]], ['Vini', [['Ribolla gialla', ['28,00', '5,00']]]]]);
    const s = scoreCase(truth, draft, ['[da verificare] FRICO CON LA POLENTA: letto 10,00, non trovato nella seconda lettura']);
    assert.equal(s.totale, 5);
    assert.equal(s.giusti, 2); // gnocchi (14 = 14,00) e ribolla (stesse varianti)
    assert.deepEqual(s.prezzoSbagliato.map((w) => [w.nome, w.letto, w.giusto]), [['Tagliatelle alla pitina', '16,00', '15,00']]);
    assert.deepEqual(s.daVerificare.map((w) => w.nome), ['Frico con polenta']);
    assert.deepEqual(s.persi.map((w) => w.nome), ['Zucca in saor']);
    assert.deepEqual(s.inPiu.map((w) => w.nome), ['Coperto']);
    const text = reportText({ photos: 2, failed: 0, cases: [{ nome: 'Osteria', score: s }] });
    assert.match(text, /Su 5 piatti: 2 giusti \(40%\)/);
    assert.match(text, /«Tagliatelle alla pitina» 16,00 invece di 15,00/);
  });

  it('le portate senza prezzo di un percorso non contano', () => {
    const m = { sezioni: [{ nome: { it: 'Percorso' }, tipo: 'degustazione', voci: [{ nome: { it: 'Antipasto' } }] }] };
    assert.equal(menuItems(m).length, 0);
  });

  it('la bozza delle letture mette insieme più foto e tiene le righe dubbie', () => {
    const { menu: m, doubts } = draftFromReadings('Osteria', ['# Primi\nGnocchi — 14,00', 'Frico — 10,00\n[da verificare] Zucca: letto 10,00, non trovato nella seconda lettura']);
    const names = menuItems(m).map((i) => i.name);
    assert.ok(names.includes('Gnocchi') && names.includes('Frico'));
    assert.ok(doubts.some((d) => d.includes('Zucca')));
  });
});

describe('prova di lettura: giri dell’orologio', () => {
  it('legge una foto per giro e alla fine manda il resoconto', async () => {
    const db = d1();
    const truth = menu([['Primi', [['Gnocchi di ricotta', '14,00'], ['Frico con polenta', '10,00']]]]);
    db.sqlite.prepare('INSERT INTO drafts VALUES (?,?)').run('req-1', JSON.stringify(truth));
    const cases = [{ id: 'osteria', nome: 'Osteria', foto: [{ r2: 'private/a.jpg' }, { r2: 'private/b.jpg' }], riferimento: { bozza: 'req-1' }, provvisorio: true }];
    const fetchImpl = async (url) => {
      assert.equal(url, CASES_URL);
      return new Response(JSON.stringify(cases), { status: 200 });
    };
    const objects = { 'private/a.jpg': 'A', 'private/b.jpg': 'B' };
    const env = {
      BUCKET: { get: async (key) => ({ arrayBuffer: async () => new TextEncoder().encode(objects[key]).buffer, httpMetadata: { contentType: 'image/jpeg' } }) },
      AI: { run: async (model, payload) => {
        const url = payload.messages[0].content[1].image_url.url;
        return { response: url.endsWith(btoa('A')) ? '# Primi\nGnocchi di ricotta — 14,00' : 'Frico con polenta — 12,00' };
      } }
    };
    assert.match(await startReadingTest(db, env, { fetchImpl }), /1 locali, 2 foto/);
    assert.match(await startReadingTest(db, env, { fetchImpl }), /già in corso: 0 foto lette su 2/);
    assert.deepEqual(await readingTestStep(db, env, { fetchImpl }), { done: false, left: 1 });
    const end = await readingTestStep(db, env, { fetchImpl });
    assert.equal(end.done, true);
    assert.match(end.text, /Su 2 piatti: 1 giusti/);
    assert.match(end.text, /«Frico con polenta» 12,00 invece di 10,00/);
    assert.equal(await readingTestStep(db, env, { fetchImpl }), null);
    assert.match(await lastReadingTest(db), /Ultima prova/);
  });
});

describe('prova di lettura: errori trovati il 14 ottobre', () => {
  it('pizze con più formati: tutti i prezzi, con le etichette scritte', async () => {
    const { combineReadings } = await import('../cloudflare/functions/_lib/vision.js');
    const a = '# Pizze\n1 - FOCACCIA — Pizze tonde 3,50 / Pizze da 50 cm 6,00 / Pizze da 75 cm 9,00 / Pizze da un metro 12,00\n# Bufaline\nZIA GIADA — 11,50 / 13,50';
    const b = '# Pizze\nFOCACCIA — tonda 3,50 / 50 cm 6,00 / 75 cm 9,00 / 1 metro 12,00\n# Bufaline\nZIA GIADA — normale 11,50 / famiglia 13,50';
    const { menu: m, doubts } = draftFromReadings('Pizzeria', [combineReadings(a, b).text]);
    const items = menuItems(m);
    assert.deepEqual(items.map((i) => [i.name, i.prices]), [['1 - FOCACCIA', [350, 600, 900, 1200]], ['ZIA GIADA', [1150, 1350]]]);
    assert.equal(doubts.length, 0);
    const zia = m.sezioni[1].voci[0];
    assert.deepEqual(zia.prezzi.map((p) => p.etichetta.it), ['Normale', 'Famiglia']);
  });

  it('prezzi senza etichetta fuori dai vini: tutti dentro, etichette da scrivere', async () => {
    const { extractMenuFromText } = await import('../cloudflare/functions/_lib/menu.js');
    const r = extractMenuFromText('Pizzeria', '# Classiche\nMargherita — 6,50 / 8,50\nDiavola — 7,50 / 9,50', 'pizzeria');
    assert.deepEqual(r.menu.sezioni[0].voci.map((v) => v.prezzi.map((p) => `${p.etichetta.it}=${p.prezzo}`)), [['Prezzo 1=6,50', 'Prezzo 2=8,50'], ['Prezzo 1=7,50', 'Prezzo 2=9,50']]);
  });

  it('allergeni dopo il prezzo o tra parentesi quadre non fanno perdere il piatto', async () => {
    const { tidyReading } = await import('../cloudflare/functions/_lib/vision.js');
    assert.equal(tidyReading('Polenta concia — 12,00 (8-14)'), 'Polenta concia — 12,00\n> (8-14)');
    assert.equal(tidyReading('jota: classica minestra triestina. [1][3][8][9] — 13,00'), 'jota — 13,00\n> classica minestra triestina (1-3-8-9)');
    assert.equal(tidyReading('Amari, liquori — Likerji 2,50'), 'Amari, liquori - Likerji — 2,50');
  });
});

describe('prova di lettura: impaginazioni vere (seconda prova)', () => {
  const draft = async (text) => {
    const { combineReadings } = await import('../cloudflare/functions/_lib/vision.js');
    return menuItems(draftFromReadings('Locale', [combineReadings(text, text).text]).menu).map((i) => `${i.name} = ${i.prices.join('/')}`);
  };

  it('nomi su due righe, allergeni come numeri, varianti sotto un nome (Da Marcello)', async () => {
    const items = await draft(['# Antipasti', 'Misto mare “Casa Nostra” 1 2 3 4 7 12 14 — 12,00', 'Carpaccio di polpo con pomodoro — 15,00', '> fresco e olive taggiasche 4',
      'Battuta di carne al coltello con — 15,00', '> stracciatella e granella di pistacchio 1 3 9 10', '# Primi', 'Penne con scampi 1 2 3 4 — 9,00',
      'Ravioli di borragine:', 'al ragù 1 7 9 — 8,00', 'ai funghi porcini o carciofi 1 7 — 10,00', '# Secondi', 'Tonno al sesamo con rucola 4 11 — 13,00', '# Pesce spada', 'alla piastra 4 — 12,00'].join('\n'));
    assert.deepEqual(items, ['Misto mare “Casa Nostra” = 1200', 'Carpaccio di polpo con pomodoro fresco e olive taggiasche = 1500', 'Battuta di carne al coltello con stracciatella e granella di pistacchio = 1500',
      'Penne con scampi = 900', 'Ravioli di borragine al ragù = 800', 'Ravioli di borragine ai funghi porcini o carciofi = 1000', 'Tonno al sesamo con rucola = 1300', 'Pesce spada alla piastra = 1200']);
  });

  it('prezzo sul titolo della sezione, prezzo a peso, «cad», percorso col prezzo (La Pigna, Alle Volte, Cardamomo)', async () => {
    const items = await draft(['# Secondi', 'Lombata di Rubia Gallega froll. 90gg — 7,00hg', '# CONTORNI € 5,00', 'Patatine fritte (8)*', 'Insalata mista',
      '# Primi', 'Risotto minimo x 2 persone — 16,00 cad 1', '# Percorso Degustazione', 'con 5 Portate dalla Cucina & Dolce — 90,00', 'Abbinamento 5 Vini — 50,00'].join('\n'));
    assert.deepEqual(items, ['Lombata di Rubia Gallega froll. 90gg = 700', 'Patatine fritte = 500', 'Insalata mista = 500', 'Risotto minimo x 2 persone = 1600',
      'Percorso Degustazione con 5 Portate dalla Cucina & Dolce = 9000', 'Abbinamento 5 Vini = 5000']);
  });

  it('foto piccola: due letture uguali non bastano se la terza legge un altro prezzo', async () => {
    const { combineReadings, imageSize } = await import('../cloudflare/functions/_lib/vision.js');
    const r = combineReadings('KEBABBO — 5,00\nMARGHERITA — 4,00', 'KEBABBO — 5,00\nMARGHERITA — 4,00', 'KEBABBO — 6,00\nMARGHERITA — 4,00', { strict: true });
    assert.match(r.text, /^MARGHERITA — 4,00$/m);
    assert.match(r.text, /\[da verificare\] KEBABBO: letto 5,00 da due letture, 6,00 dalla terza/);
    const png = new Uint8Array(24); png.set([0x89, 0x50, 0x4e, 0x47]); png.set([0, 0, 2, 0xa9, 0, 0, 1, 0xe1], 16);
    assert.deepEqual(imageSize(png), { width: 681, height: 481 });
  });
});

describe('prova di lettura: terza prova', () => {
  it('percorso e abbinamento scritti come titoli col prezzo, senza voci sotto, sono voci (Cardamomo)', async () => {
    const { combineReadings } = await import('../cloudflare/functions/_lib/vision.js');
    const text = '# Dolci\nTiramisù — 8,00\n# Percorso Degustazione con 5 Portate dalla Cucina & Dolce — 90\n# Abbinamento 5 Vini — 50\nAcqua — 3,50';
    const items = menuItems(draftFromReadings('X', [combineReadings(text, text).text]).menu).map((i) => `${i.name} = ${i.prices.join('/')}`);
    assert.deepEqual(items, ['Tiramisù = 800', 'Percorso Degustazione con 5 Portate dalla Cucina & Dolce = 9000', 'Abbinamento 5 Vini = 5000', 'Acqua = 350']);
  });

  it('una descrizione che finisce con i numeri degli allergeni non diventa un prezzo (Da Marcello)', async () => {
    const { fixLayout } = await import('../cloudflare/functions/_lib/vision.js');
    const text = ['Penne con scampi 1 2 3 4 — 9,00', 'Gnocchi al pesto 1 3 7 8 — 9,00', 'Totani fritti 1 2 4 5 — 13,00', 'Orate o Branzini (circa 800g) — 25,00', '> olio e limone 4'].join('\n');
    const out = fixLayout(text);
    assert.match(out, /^Orate o Branzini \(circa 800g\) olio e limone — 25,00$/m);
    assert.doesNotMatch(out, /4,00|— 4$/m);
  });
});

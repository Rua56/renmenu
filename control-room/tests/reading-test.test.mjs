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

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { missions, readPendingMaterials } from '../cloudflare/functions/control-room/api/[[route]].js';
import { parseVisit, visitKey, visitReadyText } from '../cloudflare/functions/_lib/visit.js';
import { PREP_KEY } from '../cloudflare/functions/_lib/autoprep.js';

function database({ withCategory = true } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0001_initial.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0002_integrations.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0003_ai_free_scope.sql', import.meta.url), 'utf8'));
  if (withCategory) sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0004_request_category.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0005_draft_provenance.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0010_draft_review_notes.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0011_draft_creative.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0006_publication_approvals.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0007_jarvis_missions.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0008_mail_files.sql', import.meta.url), 'utf8'));
  return {
    prepare(sql) {
      return { bind(...params) {
        const statement = sqlite.prepare(sql);
        return { first: () => statement.get(...params) || null,
          all: () => ({ results: statement.all(...params) }),
          run: () => ({ meta: { changes: statement.run(...params).changes } }) };
      } };
    },
    async batch(statements) {
      sqlite.exec('BEGIN TRANSACTION');
      try { const results = statements.map((s) => s.run()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
    close: () => sqlite.close()
  };
}

const testEnv = (db, extra = {}) => ({ DB: db, OWNER_EMAIL: 'renmenu1569@gmail.com', ...extra });
const TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const calls = [];
const fakeFetch = async (url, options = {}) => {
  const href = String(url);
  if (href.startsWith('https://api.telegram.org/file/')) return new Response(new Uint8Array([255, 216, 255, 224, 1, 2, 3]), { status: 200 });
  if (href.startsWith('https://api.telegram.org/')) {
    const method = href.split('/').pop();
    calls.push({ method, body: options.body instanceof FormData ? Object.fromEntries([...options.body.keys()].map((k) => [k, options.body.get(k)])) : JSON.parse(options.body || '{}') });
    return Response.json({ ok: true, result: method === 'getFile' ? { file_path: 'photos/file_1.jpg', file_size: 7 } : { message_id: 1 } });
  }
  return new Response('not found', { status: 404 });
};
const said = (text, extra = {}) => ({ message: { chat: { id: 42, type: 'private' }, text, ...extra } });
const photo = (caption) => ({ message: { chat: { id: 42, type: 'private' }, photo: [{ file_id: `f${Math.random()}`, width: 800, height: 1200, file_size: 7 }], ...(caption ? { caption } : {}) } });
const lastText = () => calls.filter((c) => c.method === 'sendMessage').at(-1)?.body.text || '';

describe('Modalità visita', () => {
  it('capisce «visita <locale>» e non scambia altre frasi per una visita', () => {
    assert.deepEqual(parseVisit('visita Bar Centrale'), { venue: 'Bar Centrale' });
    assert.deepEqual(parseVisit('/visita Pizzeria Università'), { venue: 'Pizzeria Università' });
    assert.deepEqual(parseVisit('Jarvis, visita al bar Centrale.'), { venue: 'bar Centrale' });
    assert.deepEqual(parseVisit('sono in visita da Ai Tre Soldi Goriziani'), { venue: 'Ai Tre Soldi Goriziani' });
    assert.deepEqual(parseVisit('visita all’osteria Codelli'), { venue: 'osteria Codelli' });
    assert.deepEqual(parseVisit('Visita Al Bakaro'), { venue: 'Al Bakaro' }, '«Al» fa parte del nome');
    assert.deepEqual(parseVisit('modalità visita caffè Garibaldi'), { venue: 'caffè Garibaldi' });
    assert.deepEqual(parseVisit('visita'), { venue: '' });
    assert.deepEqual(parseVisit('visita Diana'), { venue: 'Diana' });
    assert.equal(parseVisit('visita di domani al bar Centrale'), null);
    assert.equal(parseVisit('visita finita'), null);
    assert.equal(parseVisit('visita il menu del Bakaro'), null);
    assert.equal(parseVisit('visitare il Bakaro'), null);
    assert.equal(parseVisit('com’è andata la visita?'), null);
    assert.equal(parseVisit('visita Bar\nCentrale'), null);
    assert.equal(parseVisit(undefined), null);
  });
  it('«visita Bar Centrale» apre la visita, la foto si collega lì; un locale già online non si visita', async () => {
    const db = database();
    const previous = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      calls.length = 0;
      await missions.putSetting(db, 'telegram_chat_id', '42');
      await db.prepare("INSERT INTO clients (id,name,plan,menu_id,internal_notes,revision,created_at,updated_at) VALUES ('bk','Al Bakaro','premium','al-bakaro','',1,'2026-10-01','2026-10-01')").bind().run();
      const store = new Map();
      const env = testEnv(db, { TELEGRAM_BOT_TOKEN: TOKEN, BUCKET: { put: async (k, v) => { store.set(k, v); }, get: async () => null, delete: async () => {} } });
      await missions.telegramUpdate(db, env, said('visita Bar Centrale'));
      const request = await db.prepare('SELECT r.*,c.name AS client FROM requests r JOIN clients c ON c.id=r.client_id').bind().first();
      assert.deepEqual([request.client, request.subject, request.plan, request.category, request.kind], ['Bar Centrale', 'Visita · Bar Centrale', 'standard', 'nuovo_standard', 'nuovo']);
      assert.ok(await missions.setting(db, visitKey(request.id)), 'pratica segnata come visita');
      assert.match(lastText(), /Modalità visita per «Bar Centrale»\. Mandami le foto/);
      assert.match(lastText(), /Non invio niente al locale e non pubblico niente/);
      await missions.telegramUpdate(db, env, photo());
      assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM materials WHERE request_id=?').bind(request.id).first()).n, 1);
      assert.match(lastText(), /Foto ricevuta per la visita a «Bar Centrale»\. La leggo subito/);
      // Di nuovo «visita Bar Centrale»: riprende la stessa visita, nessuna pratica in più.
      await missions.telegramUpdate(db, env, said('visita bar centrale'));
      assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM requests').bind().first()).n, 1);
      assert.match(lastText(), /riprendo la visita già aperta/);
      // Foto con didascalia: apre la visita di un altro locale e ci collega la foto.
      await missions.telegramUpdate(db, env, photo('visita Osteria Nuova'));
      const other = await db.prepare("SELECT id FROM requests WHERE subject='Visita · Osteria Nuova'").bind().first();
      assert.ok(other);
      assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM materials WHERE request_id=?').bind(other.id).first()).n, 1);
      // Locale con menu già online: niente visita.
      await missions.telegramUpdate(db, env, said('visita Al Bakaro'));
      assert.match(lastText(), /«Al Bakaro» ha già un menu online/);
      assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM requests WHERE client_id='bk'").bind().first()).n, 0);
      await missions.telegramUpdate(db, env, said('visita'));
      assert.match(lastText(), /Dimmi anche il nome del locale/);
    } finally { globalThis.fetch = previous; db.close(); }
  });
  it('le foto della visita si leggono dopo 15 secondi, senza domande, e tornano come link dell’anteprima', async () => {
    const db = database();
    try {
      const stamp = new Date().toISOString();
      const old = new Date(Date.now() - 20_000).toISOString();
      await db.prepare("INSERT INTO clients (id,name,plan,internal_notes,revision,created_at,updated_at) VALUES ('c1','Bar Centrale','da_definire','',1,?,?)").bind(stamp, stamp).run();
      await db.prepare("INSERT INTO clients (id,name,plan,internal_notes,revision,created_at,updated_at) VALUES ('c2','Trattoria Normale','da_definire','',1,?,?)").bind(stamp, stamp).run();
      const add = (id, requestId, subject) => db.prepare("INSERT INTO requests (id,client_id,subject,source_channel,source_text,status,kind,category,plan,revision,created_at,updated_at) VALUES (?,?,?,'altro',?,'nuova','nuovo','nuovo_standard','standard',1,?,?)").bind(requestId, id, subject, `Locale: ${subject.split(' · ')[1]}`, stamp, stamp).run();
      await add('c1', 'rv', 'Visita · Bar Centrale');
      await add('c2', 'rn', 'Nuovo menu Standard · Trattoria Normale');
      await missions.putSetting(db, visitKey('rv'), JSON.stringify({ venue: 'Bar Centrale', at: stamp }));
      const store = new Map([['kv', new Uint8Array([255, 216, 255, 1])], ['kn', new Uint8Array([255, 216, 255, 2])]]);
      for (const [id, requestId, key] of [['mv', 'rv', 'kv'], ['mn', 'rn', 'kn']]) await db.prepare("INSERT INTO materials (id,request_id,r2_key,filename,mime,size,source,processing_status,text_preview,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .bind(id, requestId, key, `${id}.jpg`, 'image/jpeg', 4, 'telegram', 'da_trascrivere', null, old).run();
      // Le due letture non concordano sul tagliere: in una pratica normale Jarvis chiederebbe il prezzo prima della bozza.
      const ai = { run: async (model) => ({ response: model.includes('mistral') ? '# ANTIPASTI\nFrico con polenta — 12\nTagliere misto — 16\n# DOLCI\nGubana — 5' : '# Antipasti\nFrico con polenta — 12\nTagliere misto — 15\n# Dolci\nGubana — 5' }) };
      const env = testEnv(db, { TELEGRAM_BOT_TOKEN: TOKEN, BUCKET: { get: async (k) => (store.has(k) ? { arrayBuffer: async () => store.get(k).buffer } : null) }, AI: ai, TRANSLATION_PROVIDER: 'disabled', JARVIS_ORIGIN: 'https://jarvis.example' });
      const read = await readPendingMaterials(db, env);
      assert.deepEqual(read.map((r) => r.material.id), ['mv'], 'solo la visita: la pratica normale aspetta i suoi 40 secondi');
      const { outcome } = read[0];
      assert.equal(outcome.drafted, true, JSON.stringify(outcome));
      assert.equal(outcome.checks, undefined, 'in visita nessuna domanda sui prezzi');
      assert.match(outcome.visit.link, /^https:\/\/jarvis\.example\/jarvis-hook\/bozza\/BZ-[A-Z0-9]{10}$/);
      assert.deepEqual([outcome.visit.venue, outcome.visit.items, outcome.visit.doubts], ['Bar Centrale', 2, 1]);
      assert.ok(!outcome.prep, 'nessuna preparazione automatica né «la mando al locale?»');
      assert.equal(String(await missions.setting(db, PREP_KEY) || '').includes('rv'), false);
      const draft = await db.prepare('SELECT id FROM drafts WHERE request_id=?').bind('rv').first();
      const code = outcome.visit.link.split('/').pop();
      assert.equal(JSON.parse(await missions.setting(db, `peek_${code}`)).draftId, draft.id);
      assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM jarvis_missions').bind().first()).n, 0);
      const text = visitReadyText('Bar Centrale', outcome.visit.link, outcome.visit);
      assert.match(text, /Anteprima pronta per «Bar Centrale» \(2 voci\)/);
      assert.match(text, /non è pubblicata e non l’ho mandata a nessuno/);
      assert.match(text, /Una voce aveva il prezzo poco leggibile: non l’ho messa nell’anteprima/);
    } finally { db.close(); }
  });
});

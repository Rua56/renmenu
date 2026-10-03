import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { linkPendingMailFiles, onRequest, readPendingMaterials, receivePendingMail } from "../cloudflare/functions/control-room/api/[[route]].js";

const domain = 'https://team-api-test.cloudflareaccess.com';
const accessEnv = { TEAM_DOMAIN: domain, POLICY_AUD: 'api-test-owner-only', OWNER_EMAIL: 'renmenu1569@gmail.com' };
const keyPair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...await crypto.subtle.exportKey('jwk', keyPair.publicKey), kid: 'api-test-key', use: 'sig', alg: 'RS256' };
const previousFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => String(url) === `${domain}/cdn-cgi/access/certs`
  ? Response.json({ keys: [jwk] }) : previousFetch(url, options);
after(() => { globalThis.fetch = previousFetch; });
const encode = (data) => Buffer.from(JSON.stringify(data)).toString('base64url');
const head = encode({ alg: 'RS256', kid: jwk.kid });
const body = encode({ iss: domain, aud: [accessEnv.POLICY_AUD], email: accessEnv.OWNER_EMAIL, type: 'app',
  exp: Math.floor(Date.now() / 1000) + 3600 });
const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keyPair.privateKey, new TextEncoder().encode(`${head}.${body}`));
const jwt = `${head}.${body}.${Buffer.from(signature).toString('base64url')}`;
const credentials = { 'Cf-Access-Jwt-Assertion': jwt };
const testEnv = (db, extra = {}) => ({ DB: db, ...accessEnv, ...extra });

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
const base = 'https://renmenu.pages.dev/control-room/api/';
async function call(db, path, payload, extra = {}) {
  const method = payload === undefined ? 'GET' : 'POST';
  const request = new Request(`${base}${path}`, {
    method, headers: method === 'POST' ? { ...credentials, Origin: 'https://renmenu.pages.dev', 'Content-Type': 'application/json' } : credentials,
    body: method === 'POST' ? JSON.stringify(payload) : undefined
  });
  const response = await onRequest({ request, env: testEnv(db, extra), params: { route: path.split('/') } });
  return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text() };
}
const action = (db, type, payload) => call(db, 'actions', { type, payload });

import { buildImportBatch } from '../staging/gmail-import.mjs';
import { autopilotPreview } from '../cloudflare/functions/_lib/autopilot.js';

const email = (messageId, subject, text) => ({ messageId, from: 'locale@example.com', to: 'renmenu1569@gmail.com', subject, text,
  receivedAt: '2026-10-02T18:00:00Z', relevant: true, bodyComplete: true, hasAttachments: false, attachmentNames: [], ambiguous: false });
async function importEmail(db, event) {
  const plan = buildImportBatch(event);
  for (const { sql, params } of plan.batch) await db.prepare(sql).bind(...params).run();
  return plan.ids.requestId;
}
const act = (db, type, payload, extra) => call(db, 'actions', { type, payload }, extra);

const READ_A = '# Antipasti\nFrico con polenta — 12\nTagliere misto — 15\n# Dolci\nGubana — 5';
const READ_B = '# ANTIPASTI\nFrico con polenta — 12\nTagliere misto — 16\n# DOLCI\nGubana — 5';
const bucket = (store = new Map()) => ({ store,
  get: async (key) => (store.has(key) ? { arrayBuffer: async () => store.get(key).buffer } : null),
  put: async (key, value) => { store.set(key, value); }, delete: async (key) => { store.delete(key); } });
const ai = { run: async (model) => ({ response: model.includes('mistral') ? READ_B : READ_A }) };

describe('Foto del menu nella pratica', () => {
  it('Jarvis legge la foto, poi l’autopilota prepara la bozza con le sole voci concordi', async () => {
    const db = database();
    try {
      const requestId = await importEmail(db, email('f1', 'Nuovo menu Standard', 'Locale: Trattoria della Foto\nVorrei attivare il piano Standard. Vi allego la foto del menu.'));
      const store = new Map([['private/requests/x/m1', new Uint8Array([255, 216, 255, 224, 1, 2, 3])]]);
      await db.prepare("INSERT INTO materials (id,request_id,r2_key,filename,mime,size,source,processing_status,text_preview,created_at) VALUES ('m1',?,?,?,?,?,?,?,?,?)")
        .bind(requestId, 'private/requests/x/m1', 'menu.jpg', 'image/jpeg', 7, 'email', 'da_trascrivere', null, '2026-10-03T00:00:00Z').run();
      const env = testEnv(db, { BUCKET: bucket(store), AI: ai, TRANSLATION_PROVIDER: 'disabled' });
      const run0 = await act(db, 'runAutopilot', {}, { BUCKET: bucket(store), AI: ai, TRANSLATION_PROVIDER: 'disabled' });
      assert.equal(await db.prepare('SELECT id FROM drafts WHERE request_id=?').bind(requestId).first(), null, 'aspetta la lettura della foto');
      const read = await readPendingMaterials(db, env);
      assert.equal(read[0].outcome.ok, true, JSON.stringify(read));
      assert.equal(read[0].outcome.agreed, 2);
      assert.equal((await db.prepare("SELECT processing_status AS s FROM materials WHERE id=?").bind('m1').first()).s, 'letto_da_jarvis');
      const run = await act(db, 'runAutopilot', {}, { BUCKET: bucket(store), AI: ai, TRANSLATION_PROVIDER: 'disabled' });
      assert.equal(run.status, 200, JSON.stringify(run.body));
      const draft = await db.prepare('SELECT * FROM drafts WHERE request_id=?').bind(requestId).first();
      assert.ok(draft, 'bozza creata dopo la lettura: ' + JSON.stringify(run0.body?.result));
      const menu = JSON.parse(draft.menu_json);
      assert.deepEqual(menu.sezioni.map((s) => [s.nome.it, s.voci.map((v) => `${v.nome.it} ${v.prezzo}`)]), [['Antipasti', ['Frico con polenta 12,00']], ['Dolci', ['Gubana 5,00']]]);
      const provenance = JSON.parse(draft.provenance_json);
      assert.ok(provenance.some((p) => /file «menu\.jpg» riga \d+ \(letta da Jarvis due volte\)/.test(p.source)), JSON.stringify(provenance));
      assert.match(draft.warnings_json || JSON.stringify(provenance), /.*/);
      assert.equal((await readPendingMaterials(db, env)).length, 0, 'ogni foto si legge una volta sola');
    } finally { db.close(); }
  });

  it('più foto nella stessa pratica: bozza dopo l’ultima, e quella di Jarvis non toccata si rifà con tutte', async () => {
    const db = database();
    try {
      await db.prepare("INSERT INTO clients (id,name,plan,internal_notes,revision,created_at,updated_at) VALUES ('c1','Trattoria Tre Foto','da_definire','',1,'2026-10-03','2026-10-03')").bind().run();
      const requestId = (await act(db, 'createRequest', { clientId: 'c1', subject: 'Nuovo menu Standard · Trattoria Tre Foto', sourceChannel: 'altro', sourceText: 'Locale: Trattoria Tre Foto', category: 'nuovo_standard', plan: 'standard', kind: 'nuovo' })).body.result.id;
      const store = new Map([['k1', new Uint8Array([255, 216, 255, 1])], ['k2', new Uint8Array([255, 216, 255, 2])], ['k3', new Uint8Array([255, 216, 255, 3])]]);
      const add = (id, key, at) => db.prepare("INSERT INTO materials (id,request_id,r2_key,filename,mime,size,source,processing_status,text_preview,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .bind(id, requestId, key, `${id}.jpg`, 'image/jpeg', 4, 'telegram', 'da_trascrivere', null, at).run();
      await add('p1', 'k1', '2026-10-03T00:01:00Z'); await add('p2', 'k2', '2026-10-03T00:02:00Z');
      const pages = { k1: '# Antipasti\nFrico con polenta — 12', k2: '# Dolci\nGubana — 5', k3: '# Vini\nRibolla gialla — 6' };
      let current = 'k1';
      const env = testEnv(db, { BUCKET: { get: async (k) => { current = k; return store.has(k) ? { arrayBuffer: async () => store.get(k).buffer } : null; } }, AI: { run: async () => ({ response: pages[current] }) }, TRANSLATION_PROVIDER: 'disabled' });
      const first = await readPendingMaterials(db, env);
      assert.equal(first[0].outcome.waiting, true, JSON.stringify(first));
      assert.equal(await db.prepare('SELECT id FROM drafts WHERE request_id=?').bind(requestId).first(), null, 'aspetta la seconda foto');
      assert.equal((await readPendingMaterials(db, env))[0].outcome.drafted, true);
      const names = async () => JSON.parse((await db.prepare('SELECT menu_json FROM drafts WHERE request_id=?').bind(requestId).first()).menu_json).sezioni.flatMap((s) => s.voci.map((v) => v.nome.it));
      assert.deepEqual(await names(), ['Frico con polenta', 'Gubana']);
      await add('p3', 'k3', '2026-10-03T00:05:00Z');
      const third = await readPendingMaterials(db, env);
      assert.equal(third[0].outcome.drafted, true, JSON.stringify(third));
      assert.deepEqual(await names(), ['Frico con polenta', 'Gubana', 'Ribolla gialla']);
      assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM drafts WHERE request_id=?').bind(requestId).first()).n, 1);
      // Riccardo modifica la bozza; poi arriva un'altra foto: la bozza NON si tocca e Jarvis lo dice.
      const draft = await db.prepare('SELECT * FROM drafts WHERE request_id=?').bind(requestId).first();
      const edited = JSON.parse(draft.menu_json); edited.sezioni[0].voci[0].nome.it = 'Frico croccante con polenta';
      assert.equal((await act(db, 'saveDraft', { id: draft.id, revision: draft.revision, menu: edited, slug: draft.slug })).status, 200);
      store.set('k4', new Uint8Array([255, 216, 255, 4])); pages.k4 = '# Vini\nRefosco — 7';
      await add('p4', 'k4', '2026-10-03T00:09:00Z');
      const fourth = await readPendingMaterials(db, env);
      assert.equal(fourth[0].outcome.draftKept, true);
      assert.deepEqual(await names(), ['Frico croccante con polenta', 'Gubana', 'Ribolla gialla']);
      // Su sua richiesta (conferma esplicita) Jarvis rifà la bozza con TUTTI i materiali.
      assert.equal((await act(db, 'rebuildDraft', { draftId: draft.id })).status, 403, 'senza conferma non si rifà');
      const rebuilt = await act(db, 'rebuildDraft', { draftId: draft.id, confirmation: 'RIFAI BOZZA' });
      assert.equal(rebuilt.status, 200, JSON.stringify(rebuilt.body));
      assert.deepEqual(await names(), ['Frico con polenta', 'Gubana', 'Ribolla gialla', 'Refosco']);
    } finally { db.close(); }
  });

  it('album di 4 foto da Telegram: lette una alla volta, una bozza sola con TUTTE le voci (anche con nomi e descrizioni scambiati)', async () => {
    const db = database();
    try {
      await db.prepare("INSERT INTO clients (id,name,plan,internal_notes,revision,created_at,updated_at) VALUES ('c4','Il Culo di Alex','da_definire','',1,'2026-10-03','2026-10-03')").bind().run();
      const requestId = (await act(db, 'createRequest', { clientId: 'c4', subject: 'Nuovo menu Standard · Il Culo di Alex', sourceChannel: 'altro', sourceText: 'Locale: Il Culo di Alex', category: 'nuovo_standard', plan: 'standard', kind: 'nuovo' })).body.result.id;
      const keys = ['a1', 'a2', 'a3', 'a4'];
      const store = new Map(keys.map((k, i) => [k, new Uint8Array([255, 216, 255, i + 1])]));
      // Le due letture di ogni foto: il secondo modello scrive la descrizione al posto del nome.
      const pages = {
        a1: ['# Antipasti\nSalmone e Barbabietola — 15\n> CON BARBABIETOLA SOTTACETO, PISTACCHIO TOSTATO (7-8-12)', '# ANTIPASTI\nCON BARBABIETOLA SOTTACETO, PISTACCHIO TOSTATO (7-8-12) — 15'],
        a2: ['# Primi\nTagliolini al ragù bianco — 16\n> CON FONDO DI VITELLO E TIMO (1-3-9)', '# PRIMI\nCON FONDO DI VITELLO E TIMO (1-3-9) — 16'],
        a3: ['# Secondi\nGuancia di manzo — 22', '# SECONDI\nGuancia di manzo — 22'],
        a4: ['# Vini bianchi\nRibolla Gialla — calice 5 / bottiglia 40\nFriulano — calice 6 / bottiglia 32', '# VINI BIANCHI\nRibolla Gialla — calice 5 / bottiglia 40\nFriulano — calice 6 / bottiglia 32']
      };
      let current = 'a1';
      const env = testEnv(db, { BUCKET: { get: async (k) => { current = k; return { arrayBuffer: async () => store.get(k).buffer }; } },
        AI: { run: async (model) => ({ response: pages[current][model.includes('mistral') ? 1 : 0] }) }, TRANSLATION_PROVIDER: 'disabled' });
      const stamp = new Date().toISOString();
      for (const [i, k] of keys.entries()) await db.prepare("INSERT INTO materials (id,request_id,r2_key,filename,mime,size,source,processing_status,text_preview,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .bind(`m${i + 1}`, requestId, k, `foto-${i + 1}.jpg`, 'image/jpeg', 4, 'telegram', 'da_trascrivere', null, stamp.replace(/\.\d+Z$/, `.${String(i).padStart(3, '0')}Z`)).run();
      assert.deepEqual(await readPendingMaterials(db, env), [], 'album appena arrivato: aspetta');
      const rounds = [];
      for (let i = 0; i < 4; i += 1) rounds.push((await readPendingMaterials(db, env, { calmMs: 0 }))[0]);
      assert.deepEqual(rounds.map((r) => r.material.filename), ['foto-1.jpg', 'foto-2.jpg', 'foto-3.jpg', 'foto-4.jpg'], 'una foto per giro, in ordine');
      assert.deepEqual(rounds.map((r) => Boolean(r.outcome.waiting)), [true, true, true, false]);
      assert.equal(rounds[3].outcome.drafted, true);
      assert.equal(rounds[3].outcome.files.length, 4, 'riepilogo di tutte e 4 le foto in un solo messaggio');
      const menu = JSON.parse((await db.prepare('SELECT menu_json FROM drafts WHERE request_id=?').bind(requestId).first()).menu_json);
      const voci = menu.sezioni.flatMap((s) => s.voci);
      assert.deepEqual(voci.map((v) => v.nome.it), ['Salmone e Barbabietola', 'Tagliolini al ragù bianco', 'Guancia di manzo', 'Ribolla Gialla', 'Friulano']);
      assert.deepEqual(voci.map((v) => v.prezzo || v.prezzi.map((p) => `${p.etichetta.it} ${p.prezzo}`).join(' | ')), ['15,00', '16,00', '22,00', 'Calice 5,00 | Bottiglia 40,00', 'Calice 6,00 | Bottiglia 32,00']);
      assert.match(voci[0].descrizione.it, /^Con barbabietola sottaceto, pistacchio tostato \(7-8-12\)$/);
      assert.ok(voci.every((v) => !v.allergeni?.length), 'allergeni mai assegnati da soli');
      const notes = JSON.parse((await db.prepare('SELECT review_notes_json FROM drafts WHERE request_id=?').bind(requestId).first()).review_notes_json);
      assert.ok(notes.some((n) => n.kind === 'allergeni' && /numeri degli allergeni sotto 2 piatti/.test(n.hint)));
    } finally { db.close(); }
  });

  it('allegati dell’email: collegati alla pratica dello stesso mittente, letti, poi bozza in automatico', async () => {
    const db = database();
    try {
      const store = new Map();
      const env = testEnv(db, { BUCKET: bucket(store), AI: ai, TRANSLATION_PROVIDER: 'disabled' });
      const jpeg = Buffer.from([255, 216, 255, 224, 9, 9, 9]).toString('base64');
      // Lo script Gmail arriva prima dell'importer: gli allegati restano in attesa.
      const sent = await receivePendingMail(db, env, { messageId: 'att1', from: 'Locale@Example.com', subject: 'Nuovo menu Standard',
        files: [{ name: 'menu.jpg', mime: 'image/jpeg', data: jpeg }, { name: 'falso.jpg', mime: 'image/jpeg', data: Buffer.from('ciao').toString('base64') }, { name: 'listino.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: 'AAAA' }] });
      assert.deepEqual([sent.ok, sent.stored, sent.skipped], [true, 1, 2]);
      assert.equal((await receivePendingMail(db, env, { messageId: 'att1', from: 'locale@example.com', files: [{ name: 'menu.jpg', mime: 'image/jpeg', data: jpeg }] })).stored, 1, 'ripetizione senza doppioni');
      assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM mail_files').bind().first()).n, 1);
      assert.match((await db.prepare("SELECT body FROM notifications WHERE subject LIKE '%a mano%'").bind().first()).body, /falso\.jpg, listino\.docx/);
      assert.deepEqual(await linkPendingMailFiles(db, env), [], 'nessuna pratica ancora');
      const requestId = await importEmail(db, { ...email('att1', 'Nuovo menu Standard', 'Locale: Trattoria della Foto\nVorrei attivare il piano Standard. Il menu è in allegato.'), hasAttachments: true, attachmentNames: ['menu.jpg'] });
      assert.equal((await db.prepare('SELECT status FROM requests WHERE id=?').bind(requestId).first()).status, 'dati_da_confermare');
      await linkPendingMailFiles(db, env);
      const material = await db.prepare('SELECT * FROM materials WHERE request_id=?').bind(requestId).first();
      assert.equal(material.source, 'email');
      assert.equal((await db.prepare('SELECT status FROM requests WHERE id=?').bind(requestId).first()).status, 'nuova', 'torna all’autopilota');
      await act(db, 'runAutopilot', {}, { BUCKET: bucket(store), AI: ai, TRANSLATION_PROVIDER: 'disabled' });
      assert.equal(await db.prepare('SELECT id FROM drafts WHERE request_id=?').bind(requestId).first(), null, 'aspetta la lettura');
      assert.deepEqual(await readPendingMaterials(db, env), [], 'file appena arrivato: Jarvis aspetta 40 secondi di calma');
      assert.equal((await readPendingMaterials(db, env, { calmMs: 0 }))[0].outcome.ok, true);
      await act(db, 'runAutopilot', {}, { BUCKET: bucket(store), AI: ai, TRANSLATION_PROVIDER: 'disabled' });
      const draft = await db.prepare('SELECT menu_json FROM drafts WHERE request_id=?').bind(requestId).first();
      assert.ok(draft, 'bozza creata dalla foto allegata');
      assert.equal(JSON.parse(draft.menu_json).sezioni.flatMap((s) => s.voci).length, 2);
    } finally { db.close(); }
  });
  it('mittente diverso dal cliente della pratica: allegato non collegato', async () => {
    const db = database();
    try {
      const env = testEnv(db, { BUCKET: bucket(), AI: ai });
      await receivePendingMail(db, env, { messageId: 'att2', from: 'altro@example.com', files: [{ name: 'm.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4 x').toString('base64') }] });
      const requestId = await importEmail(db, { ...email('att2', 'Menu', 'Ciao'), hasAttachments: true, attachmentNames: ['m.pdf'] });
      const notices = await linkPendingMailFiles(db, env);
      assert.match(notices[0].text, /mittente non coincide/);
      assert.equal(await db.prepare('SELECT id FROM materials WHERE request_id=?').bind(requestId).first(), null);
    } finally { db.close(); }
  });
});

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
      assert.equal((await readPendingMaterials(db, env))[0].outcome.ok, true);
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

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { onRequest } from '../cloudflare/functions/control-room/api/[[route]].js';

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
  sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0006_publication_approvals.sql', import.meta.url), 'utf8'));
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

const LIVE = { id: 'osteria-viva', nome: 'Osteria Viva', lingue: ['it'], sezioni: [
  { nome: { it: 'Antipasti' }, voci: [{ nome: { it: 'Frico con polenta' }, prezzo: '12,00' }, { nome: { it: 'Tagliere di salumi' }, prezzo: '14,00' }] },
  { nome: { it: 'Dolci' }, voci: [{ nome: { it: 'Gubana' }, prezzo: '5,00' }] },
  { nome: { it: 'Bevande' }, voci: [{ nome: { it: 'Spritz Aperol' }, prezzo: '4,00' }] }] };
const github = (menu = LIVE) => async (url) => {
  const href = String(url);
  if (href.includes('/contents/menus/osteria-viva.json')) return Response.json({ type: 'file', sha: 'abc1234def', content: Buffer.from(JSON.stringify(menu)).toString('base64') });
  if (href.includes('/contents/menus/')) return Response.json({ message: 'Not Found' }, { status: 404 });
  return Response.json({ message: 'unexpected' }, { status: 500 });
};
const liveEnv = (fetch = github()) => ({ GITHUB_PROVIDER: 'live', GITHUB_TOKEN: 't', GITHUB_FETCH: fetch, TRANSLATION_PROVIDER: 'disabled' });
const act = (db, type, payload, extra) => call(db, 'actions', { type, payload }, extra);

describe('Aggiornamento di un menu già online', () => {
  it('parte dal menu su main e applica solo le modifiche scritte, con lo stesso Menu ID', async () => {
    const db = database();
    try {
      const requestId = await importEmail(db, email('u1', 'Aggiornare i prezzi', 'Buongiorno, lo spritz ora costa 5 euro. Togliete il frico. Aggiungete la torta di mele a 6 euro nei dolci. Grazie'));
      await db.prepare("UPDATE clients SET menu_id='osteria-viva',plan='standard' WHERE id=(SELECT client_id FROM requests WHERE id=?)").bind(requestId).run();
      const run = await act(db, 'runAutopilot', {}, liveEnv());
      assert.equal(run.status, 200, JSON.stringify(run.body));
      const draft = await db.prepare('SELECT * FROM drafts WHERE request_id=?').bind(requestId).first();
      assert.ok(draft, 'bozza creata');
      assert.equal(draft.slug, 'osteria-viva');
      const menu = JSON.parse(draft.menu_json);
      assert.deepEqual(menu.sezioni.map((s) => [s.nome.it, s.voci.map((v) => `${v.nome.it} ${v.prezzo}`)]), [
        ['Antipasti', ['Tagliere di salumi 14,00']], ['Dolci', ['Gubana 5,00', 'Torta di mele 6,00']], ['Bevande', ['Spritz Aperol 5,00']]]);
      const provenance = JSON.parse(draft.provenance_json);
      assert.ok(provenance.some((p) => p.path === 'sezioni.0.voci.0.prezzo' && /Menu online \(main abc1234\)/.test(p.source)), 'invariati: fonte = menu online');
      assert.ok(provenance.some((p) => p.path === 'sezioni.2.voci.0.prezzo' && /Email del locale/.test(p.source)), 'modificati: fonte = email');
      const note = await db.prepare("SELECT body FROM notifications WHERE request_id=? AND subject LIKE 'Jarvis%'").bind(requestId).first();
      assert.match(note.body, /aggiornamento pronto per il menu online «osteria-viva»/);
    } finally { db.close(); }
  });
  it('senza Menu ID collegato propone soltanto, e non indovina il menu dal testo', async () => {
    const db = database();
    try {
      const requestId = await importEmail(db, email('u2', 'Aggiornare i prezzi', 'Locale: Osteria Viva\nLo spritz ora costa 5 euro.'));
      await act(db, 'runAutopilot', {}, liveEnv());
      assert.equal(await db.prepare('SELECT id FROM drafts WHERE request_id=?').bind(requestId).first(), null);
      const note = await db.prepare("SELECT body FROM notifications WHERE request_id=? AND subject LIKE 'Jarvis%'").bind(requestId).first();
      assert.match(note.body, /quale menu online aggiornare/);
    } finally { db.close(); }
  });
  it('menu non online o email senza modifiche precise: nessuna bozza, motivo chiaro', async () => {
    const db = database();
    try {
      const requestId = await importEmail(db, email('u3', 'Aggiornare i prezzi', 'Vorrei aggiornare un po’ di prezzi, ci sentiamo.'));
      await db.prepare("UPDATE clients SET menu_id='osteria-viva',plan='standard' WHERE id=(SELECT client_id FROM requests WHERE id=?)").bind(requestId).run();
      await act(db, 'runAutopilot', {}, liveEnv());
      assert.equal(await db.prepare('SELECT id FROM drafts WHERE request_id=?').bind(requestId).first(), null);
      const note = await db.prepare("SELECT body FROM notifications WHERE request_id=? AND subject LIKE 'Jarvis%'").bind(requestId).first();
      assert.match(note.body, /non trovo una modifica precisa/);
    } finally { db.close(); }
  });
});

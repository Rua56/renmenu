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
  sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0011_draft_creative.sql', import.meta.url), 'utf8'));
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
const SOURCE = 'Buongiorno, vorrei attivare il menu digitale Standard.\nLocale: Osteria Autopilota\n\nANTIPASTI\nFrico con polenta — 12,00\nSardoni impanati — 9,00\nCoperto 2,50 €\nGli sardoni contengono pesce e glutine.';

describe('Autopilota di Jarvis', () => {
  it('prepara da solo la bozza quando nome e piano sono scritti, e lo registra come Jarvis', async () => {
    const db = database();
    try {
      const requestId = await importEmail(db, email('auto1', 'Nuovo menu', SOURCE));
      assert.equal((await call(db, 'state')).body.autopilotPending, 1);
      const run = await action(db, 'runAutopilot', {});
      assert.equal(run.status, 200, String(run.body.error));
      assert.equal(run.body.result.done[0].outcome, 'bozza');
      const state = run.body.state;
      const request = state.requests.find((entry) => entry.id === requestId);
      assert.equal(request.category, 'nuovo_standard');
      assert.equal(request.plan, 'standard');
      const draft = state.drafts.find((entry) => entry.requestId === requestId);
      assert.equal(draft.slug, 'osteria-autopilota');
      assert.deepEqual(draft.sourceExtras.map((entry) => entry.type), ['allergeni'], 'allergeni proposti, non inseriti');
      assert.ok(draft.menu.coperto, 'coperto scritto nella richiesta: inserito con la fonte');
      assert.equal(draft.checks.prices, false, 'la checklist resta a Riccardo');
      const audits = state.audit.filter((entry) => entry.requestId === requestId);
      assert.ok(audits.some((entry) => entry.action === 'draft.generate' && entry.actor === 'jarvis'));
      assert.ok(audits.some((entry) => entry.action === 'autopilot.draft'));
      assert.ok(state.notifications.some((entry) => entry.subject === 'Jarvis · bozza pronta' && /Osteria Autopilota/.test(entry.body)));
      assert.equal(state.autopilotPending, 0);
      assert.deepEqual((await action(db, 'runAutopilot', {})).body.result.done, [], 'una sola volta per pratica');
    } finally { db.close(); }
  });
  it('senza piano scritto propone soltanto e chiede a Riccardo; non tocca pratiche già modificate', async () => {
    const db = database();
    try {
      const vague = await importEmail(db, email('auto2', 'Menu per il bar', 'Vorrei un menu digitale.\nLocale: Bar Prova\nCaffè — 1,20'));
      const touched = await importEmail(db, email('auto3', 'Nuovo menu', SOURCE.replace('Osteria Autopilota', 'Altro Locale')));
      const current = (await call(db, 'state')).body.requests.find((entry) => entry.id === touched);
      assert.equal((await action(db, 'updateRequest', { id: touched, revision: current.revision, patch: { nextStep: 'Lo seguo io.' } })).status, 200);
      const run = await action(db, 'runAutopilot', {});
      assert.deepEqual(run.body.result.done.map((entry) => [entry.requestId, entry.outcome]), [[vague, 'proponi']]);
      assert.equal(run.body.state.drafts.length, 0);
      assert.match(run.body.result.done[0].message, /scegli tu Standard, Annuale o Premium/);
    } finally { db.close(); }
  });
  it('classifica in modo prudente', () => {
    const preview = (subject, text) => autopilotPreview({ subject, source_text: text });
    assert.equal(preview('Info', 'Quanto costa il servizio?').category, 'commerciale');
    assert.equal(preview('Spritz', 'Il prezzo dello spritz passa a 4 euro').category, 'prezzo');
    assert.equal(preview('Menu', 'Meglio annuale o premium?\nLocale: X').action, 'proponi');
    assert.equal(preview('Ciao', 'grazie mille').action, 'chiedi');
  });
});

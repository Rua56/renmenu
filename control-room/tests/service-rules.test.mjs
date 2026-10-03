import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { onRequest } from '../cloudflare/functions/control-room/api/[[route]].js';
import * as serverRules from '../cloudflare/functions/_lib/service-rules.js';
import * as siteRules from '../site/service-rules.js';
import { reviewIssues as serverReview } from '../cloudflare/functions/_lib/editorial.js';
import { reviewIssues as demoReview } from '../site/editorial.js';
import { approveByClient } from './helpers/client-approval.mjs';

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
const documentedReview = {
  fieldEvidence: {
    prices: 'Listino di prova, due righe con prezzo 12,00 e 8,50.',
    allergens: 'Email del locale fittizio: omissione dei numeri allergeni esplicitamente approvata.',
    languages: 'Testo italiano originale nella richiesta demo verificato.'
  },
  allergenOmissionConfirmed: true
};


const { PLAN_RULES, resolveCategory, draftBlocker, planIssues, CATEGORY_CODES } = serverRules;
const menu = (lingue) => ({ id: 'locale-regole', nome: Object.fromEntries(lingue.map((l) => [l, `Locale ${l}`])), lingue,
  sezioni: [{ nome: Object.fromEntries(lingue.map((l) => [l, `Primi ${l}`])), voci: [{ nome: Object.fromEntries(lingue.map((l) => [l, `Gnocchi ${l}`])), prezzo: '12,00' }] }] });
const fullChecks = (extra = {}) => ({ prices: true, allergens: true, languages: true, clientApproval: true,
  fieldEvidence: { prices: 'Listino fittizio, riga Gnocchi 12,00.', allergens: 'Omissione allergeni autorizzata per iscritto (fittizio).', languages: 'Traduzioni fornite dal locale fittizio.' },
  allergenOmissionConfirmed: true, clientApprovalEvidence: 'Approvazione scritta del locale fittizio.', ...extra });

describe('Regole di servizio RenMenu', () => {
  it('il modulo server e quello del sito sono identici', () => {
    assert.equal(readFileSync(new URL('../site/service-rules.js', import.meta.url), 'utf8'),
      readFileSync(new URL('../cloudflare/functions/_lib/service-rules.js', import.meta.url), 'utf8'));
    assert.deepEqual(siteRules.CATEGORY_CODES, CATEGORY_CODES);
  });
  it('riconosce esattamente le 11 categorie approvate, coerenti con la migrazione 0004', () => {
    assert.equal(CATEGORY_CODES.length, 11);
    const migration = readFileSync(new URL('../cloudflare/migrations/0004_request_category.sql', import.meta.url), 'utf8');
    for (const code of CATEGORY_CODES) assert.ok(migration.includes(`'${code}'`), code);
    assert.deepEqual(Object.keys(PLAN_RULES), ['standard', 'annuale', 'premium']);
  });
  it('deriva tipo e piano dalla categoria e rifiuta le incoerenze', () => {
    assert.deepEqual(resolveCategory({ category: 'nuovo_annuale', kind: 'altro', plan: 'da_definire' }), { category: 'nuovo_annuale', kind: 'nuovo', plan: 'annuale' });
    assert.deepEqual(resolveCategory({ category: 'vini_cocktail', kind: 'nuovo', plan: 'premium' }), { category: 'vini_cocktail', kind: 'aggiornamento', plan: 'premium' });
    assert.deepEqual(resolveCategory({ category: null, kind: 'prezzo', plan: 'standard' }), { category: null, kind: 'prezzo', plan: 'standard' });
    assert.throws(() => resolveCategory({ category: 'nuovo_premium', kind: 'nuovo', plan: 'standard' }), /non coerente/);
    assert.throws(() => resolveCategory({ category: 'inventata', kind: 'nuovo', plan: 'standard' }), /non valida/);
  });
  it('blocca la bozza finche il piano non e confermato', () => {
    assert.match(draftBlocker('da_definire'), /Piano da confermare/);
    assert.match(draftBlocker(undefined), /Piano da confermare/);
    for (const plan of ['standard', 'annuale', 'premium']) assert.equal(draftBlocker(plan), null);
  });
  it('applica le lingue del piano e l’approvazione creativa Premium', () => {
    assert.deepEqual(planIssues(menu(['it', 'en']), 'standard', {}), []);
    assert.match(planIssues(menu(['it', 'de']), 'standard', {}).join(' '), /non incluse nel piano \(de\)/);
    assert.match(planIssues(menu(['it', 'en', 'de']), 'standard', {}).join(' '), /massimo 2 lingue/);
    assert.deepEqual(planIssues(menu(['it', 'en', 'de']), 'annuale', {}), []);
    assert.match(planIssues(menu(['it', 'en', 'de', 'fr']), 'annuale', {}).join(' '), /massimo 3 lingue/);
    assert.match(planIssues(menu(['it', 'en', 'de', 'fr']), 'premium', {}).join(' '), /approvazione creativa/);
    assert.match(planIssues(menu(['it']), 'premium', { creativeApproval: true, creativeApprovalEvidence: 'breve' }).join(' '), /riferimento/);
    assert.deepEqual(planIssues(menu(['it', 'en', 'de', 'fr']), 'premium', { creativeApproval: true, creativeApprovalEvidence: 'Proposta grafica v2 approvata da Riccardo.' }), []);
    assert.match(planIssues(menu(['it', 'en', 'de', 'fr', 'es']), 'premium', { creativeApproval: true, creativeApprovalEvidence: 'Proposta grafica v2 approvata da Riccardo.' }).join(' '), /massimo 4 lingue/);
    assert.match(planIssues(menu(['it']), 'da_definire', {}).join(' '), /Piano non confermato/);
  });
  it('il gate editoriale include il piano con parita API/demo', () => {
    const draft = menu(['it', 'en', 'de']);
    assert.deepEqual(serverReview(draft, fullChecks()).issues, []);
    assert.match(serverReview(draft, fullChecks(), 'standard').issues.join(' '), /Standard mensile/);
    assert.deepEqual(serverReview(draft, fullChecks(), 'annuale').issues, []);
    assert.match(serverReview(draft, fullChecks(), null).issues.join(' '), /Piano non confermato/);
    for (const plan of ['standard', 'annuale', 'premium', null]) assert.deepEqual(serverReview(draft, fullChecks(), plan), demoReview(draft, fullChecks(), plan));
  });
});

describe('Regole di servizio nella API staging', () => {
  const setup = async (db, request) => {
    const client = await action(db, 'createClient', { name: 'Osteria regole', phone: '+390000000009', plan: 'da_definire' });
    return action(db, 'createRequest', { clientId: client.body.result.id, subject: 'Pratica regole', sourceChannel: 'manuale',
      sourceText: '## Primi\nGnocchi — 12,00', ...request });
  };
  it('salva la categoria, deriva il piano e blocca la bozza con piano da definire', async () => {
    const db = database();
    try {
      const conflict = await setup(db, { category: 'nuovo_premium', plan: 'standard' });
      assert.equal(conflict.status, 422);
      const undefinedPlan = await setup(db, { kind: 'nuovo' });
      assert.equal(undefinedPlan.status, 200);
      const blocked = await action(db, 'generateDraft', { requestId: undefinedPlan.body.result.id });
      assert.equal(blocked.status, 422);
      assert.match(blocked.body.error, /Piano da confermare/);
      assert.equal(blocked.body.state, undefined);
      const created = await setup(db, { category: 'nuovo_annuale' });
      assert.equal(created.status, 200);
      const request = created.body.state.requests.find((item) => item.id === created.body.result.id);
      assert.deepEqual([request.category, request.kind, request.plan], ['nuovo_annuale', 'nuovo', 'annuale']);
      const moved = await action(db, 'updateRequest', { id: request.id, revision: request.revision, patch: { plan: 'premium' } });
      assert.equal(moved.status, 200);
      const updated = moved.body.state.requests.find((item) => item.id === request.id);
      assert.deepEqual([updated.category, updated.plan], ['nuovo_premium', 'premium']);
      const reclassified = await action(db, 'updateRequest', { id: request.id, revision: updated.revision, patch: { category: 'prezzo' } });
      assert.equal(reclassified.status, 200);
      const priceRequest = reclassified.body.state.requests.find((item) => item.id === request.id);
      assert.deepEqual([priceRequest.category, priceRequest.kind, priceRequest.plan], ['prezzo', 'prezzo', 'premium']);
    } finally { db.close(); }
  });
  it('Premium: la PR resta bloccata senza approvazione creativa documentata', async () => {
    const db = database();
    try {
      const created = await setup(db, { category: 'nuovo_premium' });
      const extracted = await action(db, 'generateDraft', { requestId: created.body.result.id });
      assert.equal(extracted.status, 200);
      const draft = extracted.body.state.drafts[0];
      const base = { id: draft.id, revision: draft.revision, checks: { prices: true, allergens: true, languages: true, clientApproval: true },
        approvalEvidence: 'Email conferma cliente fittizio del 02/10/2026', ...documentedReview };
      const missing = await action(db, 'reviewDraft', base);
      assert.equal(missing.status, 422);
      assert.match(missing.body.error, /approvazione creativa/);
      const approved = await action(db, 'reviewDraft', { ...base, creativeApproval: true, creativeApprovalEvidence: 'Proposta grafica v1 approvata da Riccardo.' });
      assert.equal(approved.status, 200);
      assert.equal(approved.body.result.ready, false, 'il consenso del cliente arriva solo dalla sua risposta');
      assert.equal(approved.body.state.drafts[0].checks.creativeApproval, true);
      const client = await approveByClient(action, db, draft.id);
      assert.equal(client.ready, true);
      assert.equal(client.approval.activation, 'premium_acconto');
    } finally { db.close(); }
  });
  it('Standard: rifiuta una terza lingua alla revisione', async () => {
    const db = database();
    try {
      const created = await setup(db, { category: 'nuovo_standard' });
      const draft = (await action(db, 'generateDraft', { requestId: created.body.result.id })).body.state.drafts[0];
      const extended = { ...menu(['it', 'en', 'de']), id: draft.slug };
      const saved = await action(db, 'saveDraft', { id: draft.id, revision: draft.revision, menu: extended, slug: draft.slug });
      assert.equal(saved.status, 200, String(saved.body.error));
      const current = saved.body.state.drafts[0];
      const review = await action(db, 'reviewDraft', { id: current.id, revision: current.revision,
        checks: { prices: true, allergens: true, languages: true, clientApproval: true },
        approvalEvidence: 'Email conferma cliente fittizio del 02/10/2026', ...documentedReview });
      assert.equal(review.status, 422);
      assert.match(review.body.error, /Standard mensile: massimo 2 lingue/);
    } finally { db.close(); }
  });
  it('senza migrazione 0004 la dashboard resta leggibile e le pratiche senza categoria funzionano', async () => {
    const db = database({ withCategory: false });
    try {
      const created = await setup(db, { kind: 'nuovo', plan: 'standard' });
      assert.equal(created.status, 200);
      const request = created.body.state.requests.find((item) => item.id === created.body.result.id);
      assert.equal(request.category, null);
      assert.equal((await call(db, 'state')).status, 200);
    } finally { db.close(); }
  });
});

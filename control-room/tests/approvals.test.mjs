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
import { approveByClient } from './helpers/client-approval.mjs';
import { assessReply, previewEmail, previewUrl, stripQuoted, approvalState } from '../cloudflare/functions/_lib/approvals.js';

const setup = async (db, request = {}) => {
  const client = await action(db, 'createClient', { name: 'Osteria anteprima', email: 'osteria@example.com', plan: 'standard' });
  const created = await action(db, 'createRequest', { clientId: client.body.result.id, subject: 'Nuovo menu', sourceChannel: 'manuale',
    category: 'nuovo_standard', menuId: 'osteria-anteprima', sourceText: '## Primi\nGnocchi — 12,00', ...request });
  const draft = (await action(db, 'generateDraft', { requestId: created.body.result.id })).body.state.drafts[0];
  const reviewed = await action(db, 'reviewDraft', { id: draft.id, revision: draft.revision,
    checks: { prices: true, allergens: true, languages: true, clientApproval: false }, ...documentedReview });
  assert.equal(reviewed.status, 200, String(reviewed.body.error));
  return { requestId: created.body.result.id, draft: reviewed.body.state.drafts.find((entry) => entry.id === draft.id) };
};
const decode = (url) => JSON.parse(Buffer.from(url.split('#data=')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));

describe('Percorso di approvazione: funzioni pure', () => {
  it('il link di anteprima contiene il menu esatto nel frammento, senza pubblicare nulla', () => {
    const menu = { id: 'x', nome: { it: 'Caffè Ò' }, lingue: ['it', 'en'], sezioni: [{ nome: { it: 'Dolci', en: 'Desserts' }, voci: [{ nome: { it: 'Strudel' }, prezzo: '5,00' }] }] };
    const url = previewUrl(menu);
    assert.match(url, /^https:\/\/renmenu\.pages\.dev\/menu\/\?lang=it#data=/);
    assert.deepEqual(decode(url), menu);
    const email = previewEmail({ menu, code: 'RM-ABCDEF', url });
    assert.match(email.subject, /rif\. RM-ABCDEF/);
    assert.match(email.body, /Caffè Ò/);
    assert.match(email.body, /italiano e inglese/);
    assert.match(email.body, /«Approvo»/);
    assert.match(email.body, /allergeni non sono indicati/);
    assert.doesNotMatch(email.body, /€|\b25\b|249|490/, 'nessun prezzo commerciale inventato');
  });
  it('propone come approvazione solo una risposta chiara e senza richieste', () => {
    assert.equal(assessReply('Approvo, grazie!').suggestion, 'approvazione');
    assert.equal(assessReply('Va bene così').suggestion, 'approvazione');
    assert.equal(assessReply('Approvo ma cambiate il prezzo dei gnocchi').suggestion, 'modifiche');
    assert.equal(assessReply('Il frico è sbagliato').suggestion, 'modifiche');
    assert.equal(assessReply('Ok?').suggestion, 'modifiche');
    assert.equal(assessReply('Grazie').suggestion, 'incerta');
    assert.equal(assessReply('> Approvo').suggestion, 'vuota');
    assert.equal(stripQuoted('Approvo\n\nIl giorno 2 ott 2026 RenMenu ha scritto:\n> non è online'), 'Approvo');
  });
  it('un’approvazione vale solo per lo stesso contenuto', () => {
    const approval = { status: 'approvata_cliente', snapshot_sha: 'a', activation: null };
    assert.deepEqual(approvalState(approval, 'a', 'aggiornamento'), { valid: true, stale: false, activationMissing: false });
    assert.equal(approvalState(approval, 'b', 'aggiornamento').valid, false);
    assert.equal(approvalState(approval, 'a', 'nuovo').activationMissing, true);
  });
});

describe('Percorso di approvazione nella API staging', () => {
  it('blocca anteprima senza revisione interna e destinatari non validi', async () => {
    const db = database();
    try {
      const client = await action(db, 'createClient', { name: 'Senza email' });
      const created = await action(db, 'createRequest', { clientId: client.body.result.id, subject: 'Nuovo', sourceChannel: 'manuale',
        category: 'nuovo_standard', menuId: 'senza-email', sourceText: '## Primi\nGnocchi — 12,00' });
      const draft = (await action(db, 'generateDraft', { requestId: created.body.result.id })).body.state.drafts[0];
      assert.equal((await action(db, 'preparePreview', { draftId: draft.id, revision: draft.revision })).status, 422, 'serve la revisione interna');
      const reviewed = (await action(db, 'reviewDraft', { id: draft.id, revision: draft.revision,
        checks: { prices: true, allergens: true, languages: true, clientApproval: false }, ...documentedReview })).body.state.drafts[0];
      const noEmail = await action(db, 'preparePreview', { draftId: draft.id, revision: reviewed.revision });
      assert.equal(noEmail.status, 422);
      const owner = await action(db, 'preparePreview', { draftId: draft.id, revision: reviewed.revision, recipient: 'renmenu1569@gmail.com' });
      assert.equal(owner.status, 422);
      assert.match(owner.body.error, /casella RenMenu/);
    } finally { db.close(); }
  });
  it('il consenso non si spunta a mano e i menu nuovi richiedono l’attivazione', async () => {
    const db = database();
    try {
      const { draft } = await setup(db);
      const manual = await action(db, 'reviewDraft', { id: draft.id, revision: draft.revision,
        checks: { prices: true, allergens: true, languages: true, clientApproval: true }, approvalEvidence: 'Approvazione inventata a mano.', ...documentedReview });
      assert.equal(manual.body.result.ready, false);
      assert.equal(manual.body.state.drafts[0].checks.clientApproval, false);
      const approved = await approveByClient(action, db, draft.id, { activation: false });
      assert.equal(approved.ready, true);
      const blocked = await action(db, 'preparePr', { id: draft.id, revision: approved.draft.revision, confirmation: 'CONFERMO PR DI PROVA' });
      assert.equal(blocked.status, 403);
      assert.match(blocked.body.error, /attivazione/);
      const wrong = await action(db, 'setActivation', { id: approved.approval.id, revision: approved.approval.revision, activation: 'annuale_pagato', date: '2026-10-02' });
      assert.equal(wrong.status, 422, 'attivazione incoerente con il piano Standard');
      const ok = await action(db, 'setActivation', { id: approved.approval.id, revision: approved.approval.revision, activation: 'prova_30_giorni', date: '2026-10-02' });
      assert.equal(ok.status, 200);
      const pr = await action(db, 'preparePr', { id: draft.id, revision: approved.draft.revision, confirmation: 'CONFERMO PR DI PROVA' });
      assert.equal(pr.status, 200, String(pr.body.error));
    } finally { db.close(); }
  });
  it('una modifica dopo l’approvazione la rende scaduta', async () => {
    const db = database();
    try {
      const { draft } = await setup(db);
      const approved = await approveByClient(action, db, draft.id);
      const menu = structuredClone(approved.draft.menu);
      menu.sezioni[0].voci[0].prezzo = '13,00';
      const saved = await action(db, 'saveDraft', { id: draft.id, revision: approved.draft.revision, menu, slug: approved.draft.slug });
      assert.equal(saved.status, 200, String(saved.body.error));
      const approval = saved.body.state.approvals.find((entry) => entry.draftId === draft.id);
      assert.equal(approval.stale, true);
      assert.equal(approval.valid, false);
      const current = saved.body.state.drafts.find((entry) => entry.id === draft.id);
      const rereview = await action(db, 'reviewDraft', { id: draft.id, revision: current.revision,
        checks: { prices: true, allergens: true, languages: true, clientApproval: true }, ...documentedReview });
      assert.equal(rereview.body.result.ready, false, 'la vecchia approvazione non vale per il nuovo prezzo');
    } finally { db.close(); }
  });
  it('una risposta con richieste riapre la revisione; una incerta richiede la frase di conferma', async () => {
    const db = database();
    try {
      const { draft } = await setup(db);
      const prepared = await action(db, 'preparePreview', { draftId: draft.id, revision: draft.revision });
      assert.equal(prepared.status, 200);
      assert.equal(prepared.body.result.recipient, 'osteria@example.com');
      let approval = prepared.body.state.approvals[0];
      await action(db, 'markPreviewSent', { id: approval.id, revision: approval.revision });
      db.prepare("UPDATE publication_approvals SET status='risposta_ricevuta',reply_from='osteria@example.com',reply_text='Grazie, ci sentiamo',reply_received_at='2026-10-02T10:00:00Z',revision=revision+1 WHERE id=?").bind(approval.id).run();
      approval = (await call(db, 'state')).body.approvals[0];
      assert.equal(approval.replyAssessment.suggestion, 'incerta');
      assert.equal((await action(db, 'decideClientReply', { id: approval.id, revision: approval.revision, decision: 'approva' })).status, 403);
      const changes = await action(db, 'decideClientReply', { id: approval.id, revision: approval.revision, decision: 'modifiche' });
      assert.equal(changes.status, 200);
      assert.equal(changes.body.state.approvals[0].status, 'modifiche_richieste');
      assert.equal(changes.body.state.requests[0].status, 'in_revisione');
      const again = await action(db, 'preparePreview', { draftId: draft.id, revision: changes.body.state.drafts[0].revision });
      assert.equal(again.status, 200);
      assert.notEqual(again.body.result.referenceCode, prepared.body.result.referenceCode, 'nuova anteprima, nuovo riferimento');
    } finally { db.close(); }
  });
});

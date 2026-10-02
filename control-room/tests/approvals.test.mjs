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
import { assessReply, previewEmail, previewUrl, proposeReplyChanges, stripQuoted, approvalState } from '../cloudflare/functions/_lib/approvals.js';

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

  it('legge le modifiche chieste dal locale come proposte, senza inventare', () => {
    const menu = { sezioni: [
      { nome: { it: 'Antipasti' }, voci: [{ nome: { it: 'Frico con polenta' }, prezzo: '11,50' }, { nome: { it: 'Tagliere di salumi' }, prezzo: '14,00' }] },
      { nome: { it: 'Dolci' }, voci: [{ nome: { it: 'Gnocchi di susine' }, prezzo: '10,00' }] },
      { nome: { it: 'Vini al calice' }, voci: [{ nome: { it: 'Ribolla Gialla' }, prezzo: '5,00' }] }] };
    const pick = (text) => proposeReplyChanges(text, menu).map((p) => [p.type, p.name ?? null, p.after ?? p.price ?? null, p.section ?? null]);
    assert.deepEqual(pick('Il frico costa 12,00. Aggiungete anche il Terrano: calice 5,00, bottiglia\n22,00.\n\n> rif. RM-AAAAAA'), [
      ['prezzo', 'Frico con polenta', '12,00', null], ['aggiungi', 'Terrano (calice)', '5,00', 2], ['aggiungi', 'Terrano (bottiglia)', '22,00', 2]]);
    assert.deepEqual(pick('Togliete il tagliere. Aggiungete la torta di mele a 5 euro'), [['rimuovi', 'Tagliere di salumi', null, null], ['aggiungi', 'Torta di mele', '5,00', 1]]);
    assert.deepEqual(pick('Approvo.'), []);
    assert.equal(pick('Cambiate la foto')[0][0], 'manuale', 'nessuna modifica precisa: a mano');
    assert.equal(pick('Il frico costa 11,50')[0]?.[0], undefined, 'stesso prezzo: niente da proporre');
  });

  it('applica solo le modifiche scelte, ricalcolate dal testo salvato, con fonte e checklist azzerata', async () => {
    const db = database();
    try {
      const { draft } = await setup(db, { sourceText: '## Primi\nGnocchi — 12,00\nBlecs — 10,00\n## Vini\nRibolla — 5,00' });
      const prepared = await action(db, 'preparePreview', { draftId: draft.id, revision: draft.revision });
      let approval = prepared.body.state.approvals[0];
      await action(db, 'markPreviewSent', { id: approval.id, revision: approval.revision });
      db.prepare("UPDATE publication_approvals SET status='risposta_ricevuta',reply_from='osteria@example.com',reply_text=?,reply_received_at='2026-10-02T10:00:00Z',revision=revision+1 WHERE id=?")
        .bind('Togliete gli gnocchi. I blecs costano 11,00. Aggiungete il Terrano: calice 5,00, bottiglia 22,00.', approval.id).run();
      approval = (await call(db, 'state')).body.approvals[0];
      assert.equal(approval.replyAssessment.suggestion, 'modifiche');
      const reopened = await action(db, 'decideClientReply', { id: approval.id, revision: approval.revision, decision: 'modifiche' });
      const proposals = reopened.body.state.approvals[0].changeProposals;
      assert.deepEqual(proposals.map((p) => p.type), ['rimuovi', 'prezzo', 'aggiungi', 'aggiungi']);
      const current = reopened.body.state.drafts[0];
      assert.equal((await action(db, 'applyReplyChanges', { draftId: current.id, revision: current.revision, accept: [] })).status, 422);
      const accept = proposals.filter((p) => p.name !== 'Terrano (bottiglia)').map((p) => p.id);
      const applied = await action(db, 'applyReplyChanges', { draftId: current.id, revision: current.revision, accept });
      assert.equal(applied.status, 200, String(applied.body.error));
      const saved = applied.body.state.drafts[0];
      assert.deepEqual(saved.menu.sezioni.map((s) => s.voci.map((v) => `${v.nome.it ?? v.nome}=${v.prezzo}`)),
        [['Blecs=11,00'], ['Ribolla=5,00', 'Terrano (calice)=5,00']]);
      assert.equal(saved.checks.prices, false, 'contenuto cambiato: checklist da rifare');
      const provenance = saved.provenance || [];
      assert.ok(provenance.some((row) => row.path === 'sezioni.0.voci.0.prezzo' && row.value === '11,00' && /Risposta del locale/.test(row.source)));
      assert.ok(provenance.some((row) => row.path === 'sezioni.0.voci.0.nome.it' && row.value === 'Blecs' && /riga/.test(row.source)), 'la fonte del piatto spostato resta');
      assert.ok(provenance.some((row) => row.path === 'sezioni.1.voci.1.prezzo' && row.value === '5,00' && /Risposta del locale/.test(row.source)));
      assert.ok(applied.body.state.audit.some((row) => row.action === 'draft.reply_changes' && /Blecs 10,00 → 11,00/.test(row.summary)));
    } finally { db.close(); }
  });
});

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { approveByClient } from './helpers/client-approval.mjs';
import { onRequest } from '../cloudflare/functions/control-room/api/[[route]].js';
import { extractMenuFromText, validateMenu } from '../cloudflare/functions/_lib/menu.js';
import { validateMenu as validateEditor } from '../site/model.js';
import { prepareMockGitHubProposal } from '../cloudflare/functions/_lib/github.js';

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

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0001_initial.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0002_integrations.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0003_ai_free_scope.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0004_request_category.sql', import.meta.url), 'utf8'));
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

describe('Control Room API staging', () => {
  it('rifiuta GET, POST e file senza JWT Access firmato anche se il middleware è assente', async () => {
    const db = database();
    try {
      for (const route of ['state', 'material/file-di-test']) {
        const path = route.split('/');
        const unauthenticated = await onRequest({ request: new Request(`${base}${route}`),
          env: testEnv(db, { BUCKET: { get: async () => { throw new Error('R2 non va interrogato'); } } }), params: { route: path } });
        assert.equal(unauthenticated.status, 403);
      }
      const unauthenticatedPost = await onRequest({
        request: new Request(`${base}actions`, { method: 'POST', headers: { Origin: 'https://renmenu.pages.dev', 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'addNotification', payload: { subject: 'niente', body: 'niente' } }) }),
        env: testEnv(db), params: { route: ['actions'] }
      });
      assert.equal(unauthenticatedPost.status, 403);
      assert.equal((await call(db, 'state', undefined, { POLICY_AUD: 'un-app-diversa' })).status, 403);
    } finally { db.close(); }
  });
  it('notifica solo il proprietario dopo conferma; se Resend non è configurato non chiama il provider', async () => {
    const db = database();
    try {
      const client = await action(db, 'createClient', { name: 'Locale di test email' });
      const request = await action(db, 'createRequest', { clientId: client.body.result.id,
        subject: 'Richiesta fittizia', sourceChannel: 'manuale', kind: 'nuovo', sourceText: '' });
      const requestId = request.body.result.id;
      const payload = { requestId, subject: 'Revisione richiesta fittizia', text: 'La bozza privata attende verifica.', priority: 'urgente' };
      assert.equal((await action(db, 'sendOwnerEmail', payload)).status, 403);
      const disabled = await action(db, 'sendOwnerEmail', { ...payload, confirmation: 'CONFERMO EMAIL AL PROPRIETARIO' });
      assert.equal(disabled.status, 200);
      assert.equal(disabled.body.result.sent, false);
      assert.equal(disabled.body.result.reason, 'EMAIL_LIVE_DISABLED');
      assert.equal(disabled.body.state.ownerDeliveries.length, 0);
      const fetchCalls = [];
      const configured = {
        EMAIL_LIVE_ENABLED: 'true', ENVIRONMENT: 'protected-staging', STAGING_PROTECTED: 'true',
        RESEND_API_KEY: 'key-only-for-unit-test', EMAIL_FROM: 'onboarding@resend.dev',
        EMAIL_FROM_VERIFIED: 'true', RESEND_ONBOARDING_SENDER_AUTHORIZED: 'true',
        RESEND_FETCH: async (url, options) => {
          fetchCalls.push({ url, body: JSON.parse(options.body) });
          return Response.json({ id: 'fake-provider-receipt' }, { status: 200 });
        }
      };
      const sent = await call(db, 'actions', { type: 'sendOwnerEmail', payload: {
        ...payload, confirmation: 'CONFERMO EMAIL AL PROPRIETARIO', recipient: 'customer@example.test'
      } }, configured);
      assert.equal(sent.status, 200);
      assert.equal(sent.body.result.sent, true);
      assert.equal(sent.body.state.ownerDeliveries[0].recipient, 'renmenu1569@gmail.com');
      assert.equal(fetchCalls.length, 1);
      assert.deepEqual(fetchCalls[0].body.to, ['renmenu1569@gmail.com']);
      const retry = await call(db, 'actions', { type: 'sendOwnerEmail', payload: {
        ...payload, confirmation: 'CONFERMO EMAIL AL PROPRIETARIO'
      } }, configured);
      assert.equal(retry.body.result.duplicate, true);
      assert.equal(fetchCalls.length, 1);
      assert.equal(sent.body.state.ownerDeliveries[0].message_text, undefined);
    } finally { db.close(); }
  });
  it('estrae solo piatti con prezzo attestato e non inventa allergeni o contatti', () => {
    const extraction = extractMenuFromText('Osteria di prova', '## Primi\nGnocchi — 12,00\nRisotto: 13,50\nAllergeni da chiedere al locale');
    assert.equal(extraction.extracted.length, 2);
    assert.equal(extraction.uncertain.length, 1);
    assert.deepEqual(extraction.menu.sezioni[0].voci[0], { nome: { it: 'Gnocchi' }, prezzo: '12,00' });
    assert.equal(extraction.menu.sezioni[0].voci[0].allergeni, undefined);
    assert.equal(validateMenu(extraction.menu).errors.length, 0);
    const proposal = prepareMockGitHubProposal({ clientName: 'Osteria prova', requestKind: 'nuovo', requestId: 'r1', slug: extraction.menu.id,
      menu: extraction.menu, sourceFiles: ['privato-iban-esempio.pdf'] });
    assert.match(proposal.prBody, /1 file privati/);
    assert.doesNotMatch(proposal.prBody, /privato-iban|r1/);
  });
  it('registra cliente/pratica/bozza con versioni e blocca PR e pubblicazione fino a due conferme', async () => {
    const db = database();
    try {
      const client = await action(db, 'createClient', { name: 'Osteria di prova', phone: '+390000000001', contactName: 'Referente mock', plan: 'standard' });
      assert.equal(client.status, 200);
      const clientId = client.body.result.id;
      const revisedClient = await action(db, 'updateClient', { id: clientId, revision: 1, patch: { internalNotes: 'Prova locale fittizia' } });
      assert.equal(revisedClient.status, 200);
      assert.equal((await action(db, 'updateClient', { id: clientId, revision: 1, patch: { name: 'Duplicato' } })).status, 409);
      const created = await action(db, 'createRequest', { clientId, subject: 'Menu di prova', sourceChannel: 'manuale', kind: 'nuovo', plan: 'standard', nextStep: 'Controllare la fonte', followUpAt: '2026-10-09', sourceText: '## Primi\nGnocchi — 12,00\nZuppa — 8,50' });
      const requestId = created.body.result.id;
      const notice = await action(db, 'addNotification', { requestId, channel: 'in_app', subject: 'Verifica cliente', body: 'Solo test', priority: 'importante', dueAt: '2026-10-09' });
      assert.equal(notice.body.state.notifications[0].priority, 'importante');
      assert.equal((await action(db, 'markNotificationRead', { id: notice.body.result.id, read: true })).body.state.notifications[0].readAt !== null, true);
      const incoming = await action(db, 'mockIncomingWhatsapp', { from: '+39 000 000 0001', body: 'Vorrei un menu nuovo' });
      assert.equal(incoming.status, 200);
      assert.equal(incoming.body.result.simulated, true);
      assert.equal(incoming.body.state.requests.some((item) => item.sourceChannel === 'whatsapp'), true);
      const callMock = await action(db, 'mockCall', { requestId, message: 'Riccardo, bozza da rivedere' });
      assert.equal(callMock.body.result.simulated, true);
      assert.equal(callMock.body.state.notifications.some((item) => item.channel === 'telefono'), true);
      const providerBlocked = await call(db, 'actions', { type: 'generateDraft', payload: { requestId } }, { AI_PROVIDER: 'live' });
      assert.equal(providerBlocked.status, 501);
      for (const provider of ['cloudflare_workers_ai', 'openai_compatible']) {
        const extra = await action(db, 'createRequest', { clientId, subject: `Pannello AI ${provider}`, sourceChannel: 'email', category: 'nuovo_standard', menuId: `prova-${provider.replace(/_/g, '-')}`, sourceText: '## Primi\nGnocchi — 12,00' });
        const generated = await call(db, 'actions', { type: 'generateDraft', payload: { requestId: extra.body.result.id } }, { AI_PROVIDER: provider });
        assert.equal(generated.status, 200, `il provider ${provider} del pannello AI non deve bloccare la bozza deterministica`);
        assert.equal(generated.body.result.extraction.extracted.length, 1);
      }
      const extracted = await action(db, 'generateDraft', { requestId });
      assert.equal(extracted.status, 200);
      assert.equal(extracted.body.result.extraction.extracted.length, 2);
      const draft = extracted.body.state.drafts[0];
      const blocked = await action(db, 'preparePr', { id: draft.id, revision: draft.revision, confirmation: 'CONFERMO PR DI PROVA' });
      assert.equal(blocked.status, 409);
      const checkboxesOnly = await action(db, 'reviewDraft', { id: draft.id, revision: draft.revision,
        checks: { prices: true, allergens: true, languages: true, clientApproval: true },
        approvalEvidence: 'Email di approvazione fittizia del locale' });
      assert.equal(checkboxesOnly.status, 422);
      const noAllergenEvidence = await action(db, 'reviewDraft', { id: draft.id, revision: draft.revision,
        checks: { prices: true, allergens: true, languages: true, clientApproval: true },
        approvalEvidence: 'Email di approvazione fittizia del locale',
        fieldEvidence: documentedReview.fieldEvidence });
      assert.equal(noAllergenEvidence.status, 422);
      const review = await action(db, 'reviewDraft', { id: draft.id, revision: draft.revision, checks: { prices: true, allergens: true, languages: true, clientApproval: true }, approvalEvidence: 'Email conferma cliente del 01/10/2026', ...documentedReview });
      assert.equal(review.status, 200);
      // Il consenso del cliente non si spunta a mano: senza risposta registrata la bozza non è pronta.
      assert.equal(review.body.result.ready, false);
      assert.equal(review.body.state.drafts[0].checks.clientApproval, false);
      const noApproval = await action(db, 'preparePr', { id: draft.id, revision: review.body.state.drafts[0].revision, confirmation: 'CONFERMO PR DI PROVA' });
      assert.equal(noApproval.status, 409);
      const approved = await approveByClient(action, db, draft.id);
      assert.equal(approved.ready, true);
      assert.match(approved.draft.checks.clientApprovalEvidence, /Approvo/);
      assert.equal(approved.response.body.state.requests.find((item) => item.id === requestId).status, 'approvata');
      assert.equal((await action(db, 'updateRequest', { id: requestId, revision: approved.response.body.state.requests.find((item) => item.id === requestId).revision, patch: { status: 'pronta_pubblicazione' } })).status, 409);
      const missingPhrase = await action(db, 'preparePr', { id: draft.id, revision: approved.draft.revision });
      assert.equal(missingPhrase.status, 403);
      const proposal = await action(db, 'preparePr', { id: draft.id, revision: approved.draft.revision, confirmation: 'CONFERMO PR DI PROVA' });
      assert.equal(proposal.status, 200);
      assert.equal(proposal.body.result.simulated, true);
      assert.equal(proposal.body.state.proposals[0].status, 'mock');
      assert.equal(proposal.body.state.proposals[0].filePath, 'menus/osteria-di-prova.json');
      assert.equal(proposal.body.state.requests.find((item) => item.id === requestId).status, 'pronta_pubblicazione');
      assert.equal((await action(db, 'updateRequest', { id: requestId, revision: proposal.body.state.requests.find((item) => item.id === requestId).revision, patch: { sourceText: 'Manipolazione dopo PR' } })).status, 409);
      assert.match(proposal.body.state.proposals[0].prBody, /nessun branch, commit, PR, merge o deploy/);
      const wrongConfirm = await action(db, 'simulatePublish', { id: draft.id, revision: proposal.body.state.drafts[0].revision, confirmation: 'PUBBLICA' });
      assert.equal(wrongConfirm.status, 403);
      const published = await action(db, 'simulatePublish', { id: draft.id, revision: proposal.body.state.drafts[0].revision, confirmation: 'CONFERMO PUBBLICAZIONE SIMULATA' });
      assert.equal(published.status, 200);
      assert.equal(published.body.state.requests.find((item) => item.id === requestId).status, 'completata');
      assert.equal(published.body.state.audit.some((entry) => entry.action === 'publish.mock'), true);
      assert.equal(published.body.state.drafts[0].versions.length, 1);
      assert.equal(published.body.state.clients[0].name, 'Osteria di prova');
    } finally { db.close(); }
  });
  it('non accetta modifiche stantie, scritture cross-site o operazioni esterne inesistenti', async () => {
    const db = database();
    try {
      const clientId = (await action(db, 'createClient', { name: 'Caffè mock' })).body.result.id;
      const requestId = (await action(db, 'createRequest', { clientId, subject: 'Richiesta', sourceChannel: 'email', kind: 'aggiornamento', sourceText: 'Caffè: 2,00' })).body.result.id;
      const first = await action(db, 'updateRequest', { id: requestId, revision: 1, patch: { subject: 'Richiesta aggiornata' } });
      assert.equal(first.status, 200);
      assert.equal((await action(db, 'updateRequest', { id: requestId, revision: 1, patch: { subject: 'Sovrascrittura' } })).status, 409);
      assert.equal((await action(db, 'merge', { requestId })).status, 404);
      assert.equal((await action(db, 'sendWhatsapp', { requestId })).status, 404);
      const forged = await onRequest({
        request: new Request(`${base}actions`, { method: 'POST', headers: { ...credentials, Origin: 'https://malicious.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'addNotification', payload: { channel: 'email', subject: 'x', body: 'x' } }) }),
        env: testEnv(db), params: { route: ['actions'] }
      });
      assert.equal(forged.status, 403);
    } finally { db.close(); }
  });
  it('preserva il Menu ID degli aggiornamenti e invalida le conferme quando arriva una nuova fonte', async () => {
    const db = database();
    const objects = new Map();
    const BUCKET = { put: async (key, bytes) => objects.set(key, bytes), get: async () => null, delete: async (key) => objects.delete(key) };
    try {
      const clientId = (await action(db, 'createClient', { name: 'Locale simulato', menuId: 'qr-invariato' })).body.result.id;
      const requestId = (await action(db, 'createRequest', { clientId, subject: 'Cambio prezzo', sourceChannel: 'manuale', plan: 'standard', kind: 'prezzo', sourceText: '## Piatti\nZuppa — 8,00' })).body.result.id;
      const extracted = await action(db, 'generateDraft', { requestId });
      assert.equal(extracted.status, 200);
      const draft = extracted.body.state.drafts.find((item) => item.requestId === requestId);
      assert.equal(draft.slug, 'qr-invariato');
      const changedSlug = structuredClone(draft.menu); changedSlug.id = 'qr-diverso';
      assert.equal((await action(db, 'saveDraft', { id: draft.id, revision: draft.revision, slug: changedSlug.id, menu: changedSlug })).status, 422);
      const review = await action(db, 'reviewDraft', { id: draft.id, revision: draft.revision, checks: { prices: true, allergens: true, languages: true, clientApproval: true }, approvalEvidence: 'Email demo cliente: revisione approvata', ...documentedReview });
      assert.equal(review.status, 200);
      const approvedUpdate = await approveByClient(action, db, draft.id);
      assert.equal(approvedUpdate.draft.status, 'pronta_pr');
      const form = new FormData();
      form.set('requestId', requestId);
      form.set('file', new File(['%PDF-1.4\naltro listino di prova'], 'aggiornamento-demo.pdf', { type: 'application/pdf' }));
      const response = await onRequest({
        request: new Request(`${base}material`, { method: 'POST', headers: { ...credentials, Origin: 'https://renmenu.pages.dev' }, body: form }),
        env: testEnv(db, { BUCKET }), params: { route: ['material'] }
      });
      assert.equal(response.status, 200);
      const stateAfterUpload = (await response.json()).state;
      const newDraft = stateAfterUpload.drafts.find((item) => item.id === draft.id);
      assert.equal(newDraft.checks.prices, false);
      assert.equal(newDraft.status, 'revisione');
      assert.equal(stateAfterUpload.requests.find((item) => item.id === requestId).status, 'materiale_ricevuto');
      assert.equal((await action(db, 'preparePr', { id: draft.id, revision: newDraft.revision, confirmation: 'CONFERMO PR DI PROVA' })).status, 409);
      const archived = await action(db, 'archiveMaterial', { id: stateAfterUpload.materials[0].id, confirmation: 'ARCHIVIA MATERIALE' });
      assert.equal(archived.status, 200);
      assert.equal(archived.body.state.requests.find((item) => item.id === requestId).status, 'in_revisione');
    } finally { db.close(); }
  });
  it('rifiuta metadati editoriali e riferimenti R2 nel JSON potenzialmente pubblico', async () => {
    const db = database();
    try {
      const clientId = (await action(db, 'createClient', { name: 'Locale di prova' })).body.result.id;
      const requestId = (await action(db, 'createRequest', { clientId, subject: 'Nuovo menu', sourceChannel: 'manuale', plan: 'standard', kind: 'nuovo', sourceText: '## Primi\nZuppa — 8,00' })).body.result.id;
      const draft = (await action(db, 'generateDraft', { requestId })).body.state.drafts[0];
      const unsafe = structuredClone(draft.menu);
      unsafe.source_references = ['private/requests/example/file.pdf'];
      unsafe.sezioni[0].voci[0].internal_editor_note = 'non pubblicare';
      assert.ok(validateMenu(unsafe).errors.length > 0);
      assert.ok(validateEditor(unsafe).errors.length > 0);
      const denied = await action(db, 'saveDraft', { id: draft.id, revision: draft.revision, slug: draft.slug, menu: unsafe });
      assert.equal(denied.status, 422);
      assert.equal((await call(db, 'state')).body.drafts[0].versions.length, 1);
      assert.equal((await call(db, 'state')).body.drafts[0].menu.source_references, undefined);
    } finally { db.close(); }
  });
  it('annulla ogni mutazione se l’insert audit fallisce: cliente e versione non restano a metà', async () => {
    const db = database();
    const originalPrepare = db.prepare;
    const failAudit = (sql) => sql.startsWith('INSERT INTO audit_events')
      ? { bind: () => ({ run: () => { throw new Error('audit unavailable'); } }) }
      : originalPrepare(sql);
    try {
      db.prepare = failAudit;
      const denied = await action(db, 'createClient', { name: 'Cliente non persistito' });
      assert.equal(denied.status, 500);
      db.prepare = originalPrepare;
      assert.equal((await call(db, 'state')).body.clients.length, 0);
      assert.equal((await call(db, 'state')).body.audit.length, 0);
      const clientId = (await action(db, 'createClient', { name: 'Locale di prova' })).body.result.id;
      const requestId = (await action(db, 'createRequest', { clientId, subject: 'Menu', sourceChannel: 'manuale', plan: 'standard', kind: 'nuovo', sourceText: '## Piatti\nPasta — 9,00' })).body.result.id;
      const draft = (await action(db, 'generateDraft', { requestId })).body.state.drafts[0];
      const modified = structuredClone(draft.menu); modified.sezioni[0].voci[0].prezzo = '10,00';
      db.prepare = failAudit;
      const rejected = await action(db, 'saveDraft', { id: draft.id, revision: draft.revision, slug: draft.slug, menu: modified });
      assert.equal(rejected.status, 500);
      db.prepare = originalPrepare;
      const after = (await call(db, 'state')).body.drafts[0];
      assert.equal(after.revision, draft.revision);
      assert.equal(after.versions.length, draft.versions.length);
      assert.equal(after.menu.sezioni[0].voci[0].prezzo, '9,00');
    } finally { db.prepare = originalPrepare; db.close(); }
  });
  it('mantiene gli allegati privati in R2 e limita file e download alla pratica', async () => {
    const db = database();
    const objects = new Map();
    const BUCKET = { put: async (key, bytes) => objects.set(key, bytes), get: async (key) => objects.has(key) ? { body: new Blob([objects.get(key)]) } : null, delete: async (key) => objects.delete(key) };
    try {
      const clientId = (await action(db, 'createClient', { name: 'Cliente demo' })).body.result.id;
      const requestId = (await action(db, 'createRequest', { clientId, subject: 'Materiale', sourceChannel: 'manuale', kind: 'nuovo', sourceText: '' })).body.result.id;
      const form = new FormData();
      form.set('requestId', requestId);
      form.set('file', new File(['%PDF-1.4\nfile demo'], 'menu-esempio.pdf', { type: 'application/pdf' }));
      const response = await onRequest({
        request: new Request(`${base}material`, { method: 'POST', headers: { ...credentials, Origin: 'https://renmenu.pages.dev' }, body: form }),
        env: testEnv(db, { BUCKET }), params: { route: ['material'] }
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      const id = body.result.id;
      assert.equal(body.state.materials[0].requestId, requestId);
      assert.equal(body.state.materials[0].r2_key, undefined);
      const download = await onRequest({ request: new Request(`${base}material/${id}`, { headers: credentials }), env: testEnv(db, { BUCKET }), params: { route: ['material', id] } });
      assert.equal(download.status, 200);
      assert.equal((await download.text()).startsWith('%PDF-1.4'), true);
      const archived = await action(db, 'archiveMaterial', { id, confirmation: 'ARCHIVIA MATERIALE' });
      assert.equal(archived.status, 200);
      assert.ok(archived.body.state.materials[0].archivedAt);
      const denied = await onRequest({ request: new Request(`${base}material/${id}`, { headers: credentials }), env: testEnv(db, { BUCKET }), params: { route: ['material', id] } });
      assert.equal(denied.status, 404);
    } finally { db.close(); }
  });
  it('salva una trascrizione manuale solo con la revisione corrente e ne conserva la fonte R2', async () => {
    const db = database();
    const objects = new Map();
    const BUCKET = { put: async (key, bytes) => objects.set(key, bytes), get: async (key) => objects.has(key)
      ? { arrayBuffer: async () => objects.get(key).buffer.slice(objects.get(key).byteOffset,
        objects.get(key).byteOffset + objects.get(key).byteLength) } : null,
      delete: async (key) => objects.delete(key) };
    try {
      const clientId = (await action(db, 'createClient', { name: 'Osteria fittizia' })).body.result.id;
      const requestId = (await action(db, 'createRequest', { clientId, subject: 'Fonte fotografica', sourceChannel: 'manuale', kind: 'nuovo', sourceText: '' })).body.result.id;
      const form = new FormData();
      form.set('requestId', requestId);
      form.set('file', new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0])], 'finto.png', { type: 'image/png' }));
      const upload = await onRequest({ request: new Request(`${base}material`, { method: 'POST',
        headers: { ...credentials, Origin: 'https://renmenu.pages.dev' }, body: form }),
      env: testEnv(db, { BUCKET }), params: { route: ['material'] } });
      assert.equal(upload.status, 200);
      const data = await upload.json();
      const materialId = data.result.id, revision = data.state.requests.find((item) => item.id === requestId).revision;
      const transcript = await call(db, 'actions', { type: 'setMaterialTranscript', payload: {
        materialId, requestRevision: revision, text: 'Pasta — 12,00, trascrizione manuale non verificata'
      } }, { BUCKET });
      assert.equal(transcript.status, 200);
      assert.equal(transcript.body.state.analyses.length, 1);
      assert.equal(transcript.body.state.analyses[0].status, 'needs_review');
      assert.equal(transcript.body.state.analyses[0].sourceSha256.length, 64);
      assert.equal(transcript.body.state.analyses[0].provenance[0].reviewed, false);
      assert.equal((await call(db, 'actions', { type: 'setMaterialTranscript', payload: {
        materialId, requestRevision: revision, text: 'Ripetuto senza rileggere la pratica'
      } }, { BUCKET })).status, 409);
    } finally { db.close(); }
  });

  it('pilota Gmail: nome da riga Locale, provenienza registrata e mantenuta solo per i valori invariati', async () => {
    const db = database();
    try {
      const client = await action(db, 'createClient', { name: 'Nuovo contatto email' });
      const sourceText = 'Oggetto ricevuto: TEST\n\nLocale: Trattoria Prova Gorizia\nVorrei il menu Standard.\n\n# Primi\nTagliatelle al ragù — 12,00\n\n# Secondi\nFrico con polenta — 14,00';
      const created = await action(db, 'createRequest', { clientId: client.body.result.id, subject: 'Pilota', sourceChannel: 'email', category: 'nuovo_standard', sourceText });
      const generated = await action(db, 'generateDraft', { requestId: created.body.result.id });
      assert.equal(generated.status, 200);
      const draft = generated.body.state.drafts[0];
      assert.equal(draft.slug, 'trattoria-prova-gorizia');
      assert.equal(draft.menu.nome, 'Trattoria Prova Gorizia');
      assert.equal(generated.body.result.extraction.warnings.some((w) => w.includes('confermalo in revisione')), true);
      // La scheda cliente non viene toccata: il nome resta da confermare.
      assert.equal(generated.body.state.clients.find((c) => c.id === client.body.result.id).name, 'Nuovo contatto email');
      const price = draft.provenance.find((entry) => entry.path === 'sezioni.0.voci.0.prezzo');
      assert.deepEqual(price, { path: 'sezioni.0.voci.0.prezzo', source: 'riga 7', value: '12,00', status: 'confermato' });
      assert.equal(draft.provenance.find((entry) => entry.path === 'sezioni.1.voci.0.prezzo').source, 'riga 10');
      const saved = await action(db, 'saveDraft', { id: draft.id, revision: draft.revision, menu: draft.menu, slug: draft.slug });
      assert.equal(saved.status, 200);
      // Salvataggio senza modifiche: le fonti restano.
      assert.deepEqual(saved.body.state.drafts[0].provenance, draft.provenance);
      const edited = structuredClone(draft.menu);
      edited.sezioni[0].voci[0].prezzo = '13,00';
      const resaved = await action(db, 'saveDraft', { id: draft.id, revision: saved.body.state.drafts[0].revision, menu: edited, slug: draft.slug });
      const after = resaved.body.state.drafts[0].provenance;
      assert.equal(after.some((entry) => entry.path === 'sezioni.0.voci.0.prezzo'), false, 'prezzo cambiato: fonte rimossa');
      assert.equal(after.some((entry) => entry.path === 'sezioni.1.voci.0.prezzo'), true, 'prezzo invariato: fonte mantenuta');
      const swapped = structuredClone(edited);
      [swapped.sezioni[0], swapped.sezioni[1]] = [swapped.sezioni[1], swapped.sezioni[0]];
      const moved = await action(db, 'saveDraft', { id: draft.id, revision: resaved.body.state.drafts[0].revision, menu: swapped, slug: draft.slug });
      assert.equal(moved.body.state.drafts[0].provenance.some((entry) => /prezzo$/.test(entry.path)), false, 'piatti spostati: nessun prezzo attestato per posizione');
      // Un cliente con nome già registrato non viene sostituito dalla riga Locale.
      const named = await action(db, 'createClient', { name: 'Osteria Registrata' });
      const other = await action(db, 'createRequest', { clientId: named.body.result.id, subject: 'Altro', sourceChannel: 'email', category: 'nuovo_standard', sourceText });
      const second = await action(db, 'generateDraft', { requestId: other.body.result.id });
      assert.equal(second.status, 409, 'riga Locale diversa dal cliente registrato: decide Riccardo');
      assert.match(second.body.error, /Trattoria Prova Gorizia.*Osteria Registrata/);
    } finally { db.close(); }
  });
  it('pratica importata senza categoria: chiede la categoria, non il Menu ID', async () => {
    const db = database();
    try {
      const client = await action(db, 'createClient', { name: 'Nuovo contatto email' });
      const created = await action(db, 'createRequest', { clientId: client.body.result.id, subject: 'Import', sourceChannel: 'email', kind: 'altro', plan: 'standard', sourceText: '# Primi\nGnocchi — 10,50' });
      const blocked = await action(db, 'generateDraft', { requestId: created.body.result.id });
      assert.equal(blocked.status, 422);
      assert.match(blocked.body.error, /Scegli la categoria della pratica/);
    } finally { db.close(); }
  });
  it('stesso mittente, altro locale: niente bozza finché Riccardo non sceglie il Menu ID; identificativi unici', async () => {
    const db = database();
    try {
      const client = await action(db, 'createClient', { name: 'Trattoria Prova Gorizia' });
      const clientId = client.body.result.id;
      const first = await action(db, 'createRequest', { clientId, subject: 'Primo', sourceChannel: 'email', category: 'nuovo_standard', sourceText: '# Primi\nGnocchi — 10,50' });
      assert.equal((await action(db, 'generateDraft', { requestId: first.body.result.id })).body.state.drafts[0].slug, 'trattoria-prova-gorizia');
      const text = 'Locale: Bar Prova Isonzo\n# Colazione\nCappuccino — 1,80';
      const other = await action(db, 'createRequest', { clientId, subject: 'Altro locale', sourceChannel: 'email', category: 'nuovo_standard', sourceText: text });
      const otherId = other.body.result.id;
      const mismatch = await action(db, 'generateDraft', { requestId: otherId });
      assert.equal(mismatch.status, 409);
      assert.match(mismatch.body.error, /Bar Prova Isonzo.*Trattoria Prova Gorizia.*bar-prova-isonzo/);
      // Stesso cliente senza riga Locale: lo slug collide con la prima bozza.
      const dup = await action(db, 'createRequest', { clientId, subject: 'Doppione', sourceChannel: 'email', category: 'nuovo_standard', sourceText: '# Primi\nZuppa — 8,00' });
      const collision = await action(db, 'generateDraft', { requestId: dup.body.result.id });
      assert.equal(collision.status, 409);
      assert.match(collision.body.error, /già usato da «Trattoria Prova Gorizia»/);
      // Riccardo sceglie il Menu ID: bozza con nome e slug del nuovo locale.
      const current = (await call(db, 'state')).body.requests.find((r) => r.id === otherId);
      assert.equal((await action(db, 'updateRequest', { id: otherId, revision: current.revision, patch: { menuId: 'bar-prova-isonzo' } })).status, 200);
      const ok = await action(db, 'generateDraft', { requestId: otherId });
      assert.equal(ok.status, 200);
      const draft = ok.body.state.drafts.find((d) => d.requestId === otherId);
      assert.equal(draft.slug, 'bar-prova-isonzo');
      assert.equal(draft.menu.nome, 'Bar Prova Isonzo');
      // Rinominare una bozza nuova sull'identificativo di un altro locale è bloccato.
      const firstDraft = ok.body.state.drafts.find((d) => d.requestId === first.body.result.id);
      const stolen = await action(db, 'saveDraft', { id: firstDraft.id, revision: firstDraft.revision, menu: { ...firstDraft.menu, id: 'bar-prova-isonzo' }, slug: 'bar-prova-isonzo' });
      assert.equal(stolen.status, 409);
    } finally { db.close(); }
  });
  it('nuovo menu: Jarvis prepara subito l’inglese come bozza; “Traduci in inglese” completa le voci mancanti', async () => {
    const db = database();
    const ai = { async run(model, payload) {
      const items = JSON.parse(payload.messages[1].content.split('\n').slice(1).join('\n'));
      const dict = { Primi: 'First courses', 'Gnocchi al ragù': 'Gnocchi with meat sauce', Dolci: 'Desserts', Tiramisù: 'Tiramisù' };
      return { response: { translations: items.filter(({ it }) => dict[it]).map(({ id, it }) => ({ id, en: dict[it] })) } };
    } };
    try {
      const client = await action(db, 'createClient', { name: 'Osteria Inglese' });
      const req = await action(db, 'createRequest', { clientId: client.body.result.id, subject: 'Menu', sourceChannel: 'email', category: 'nuovo_standard', sourceText: '# Primi\nGnocchi al ragù — 12,00\n# Dolci\nTiramisù — 6,00\nStrudel — 5,00' });
      const generated = await call(db, 'actions', { type: 'generateDraft', payload: { requestId: req.body.result.id } }, { AI: ai });
      assert.equal(generated.status, 200);
      const draft = generated.body.state.drafts[0];
      assert.deepEqual(draft.menu.lingue, ['it', 'en']);
      assert.equal(draft.menu.sezioni[0].voci[0].nome.en, 'Gnocchi with meat sauce');
      assert.equal(draft.menu.sezioni[0].voci[0].prezzo, '12,00');
      assert.equal(draft.menu.sezioni[1].voci[1].nome.en, undefined, 'Strudel senza proposta: resta da completare');
      assert.ok(generated.body.result.extraction.warnings.some((w) => /4 di 5 testi.*1 da completare/.test(w)));
      assert.ok(draft.provenance.some((e) => e.path === 'sezioni.0.voci.0.prezzo'), 'provenienza prezzi conservata');
      assert.ok(draft.provenance.some((e) => e.path === 'sezioni.0.voci.0.nome.en' && e.status === 'da_verificare'));
      // Seconda passata: l’unica voce mancante viene completata, le altre restano invariate.
      const ai2 = { async run(model, payload) { const items = JSON.parse(payload.messages[1].content.split('\n').slice(1).join('\n'));
        assert.deepEqual(items.map((i) => i.it), ['Strudel']); return { response: { translations: [{ id: 0, en: 'Apple strudel' }] } }; } };
      const done = await call(db, 'actions', { type: 'translateDraft', payload: { id: draft.id, revision: draft.revision } }, { AI: ai2 });
      assert.equal(done.status, 200);
      const updated = done.body.state.drafts[0];
      assert.equal(updated.menu.sezioni[1].voci[1].nome.en, 'Apple strudel');
      assert.equal(updated.revision, draft.revision + 1);
      assert.equal(updated.checks.prices, false, 'contenuti cambiati: checklist azzerata');
      const again = await call(db, 'actions', { type: 'translateDraft', payload: { id: draft.id, revision: updated.revision } }, { AI: ai2 });
      assert.equal(again.status, 422);
      const noAi = await action(db, 'translateDraft', { id: draft.id, revision: updated.revision });
      assert.equal(noAi.status, 503);
    } finally { db.close(); }
  });
});

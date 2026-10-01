import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { onRequest } from '../cloudflare/functions/control-room/api/[[route]].js';
import { extractMenuFromText, validateMenu } from '../cloudflare/functions/_lib/menu.js';
import { validateMenu as validateEditor } from '../site/model.js';
import { prepareMockGitHubProposal } from '../cloudflare/functions/_lib/github.js';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0001_initial.sql', import.meta.url), 'utf8'));
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
    method, headers: method === 'POST' ? { Origin: 'https://renmenu.pages.dev', 'Content-Type': 'application/json' } : {},
    body: method === 'POST' ? JSON.stringify(payload) : undefined
  });
  const response = await onRequest({ request, env: { DB: db, ...extra }, params: { route: path.split('/') } });
  return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text() };
}
const action = (db, type, payload) => call(db, 'actions', { type, payload });

describe('Control Room API staging', () => {
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
      const extracted = await action(db, 'generateDraft', { requestId });
      assert.equal(extracted.status, 200);
      assert.equal(extracted.body.result.extraction.extracted.length, 2);
      const draft = extracted.body.state.drafts[0];
      const blocked = await action(db, 'preparePr', { id: draft.id, revision: draft.revision, confirmation: 'CONFERMO PR DI PROVA' });
      assert.equal(blocked.status, 409);
      const review = await action(db, 'reviewDraft', { id: draft.id, revision: draft.revision, checks: { prices: true, allergens: true, languages: true, clientApproval: true }, approvalEvidence: 'Email conferma cliente del 01/10/2026' });
      assert.equal(review.status, 200);
      assert.equal(review.body.result.ready, true);
      assert.equal(review.body.state.requests.find((item) => item.id === requestId).status, 'approvata');
      assert.equal((await action(db, 'updateRequest', { id: requestId, revision: review.body.state.requests.find((item) => item.id === requestId).revision, patch: { status: 'pronta_pubblicazione' } })).status, 409);
      const missingPhrase = await action(db, 'preparePr', { id: draft.id, revision: review.body.state.drafts[0].revision });
      assert.equal(missingPhrase.status, 403);
      const proposal = await action(db, 'preparePr', { id: draft.id, revision: review.body.state.drafts[0].revision, confirmation: 'CONFERMO PR DI PROVA' });
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
        request: new Request(`${base}actions`, { method: 'POST', headers: { Origin: 'https://malicious.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'addNotification', payload: { channel: 'email', subject: 'x', body: 'x' } }) }),
        env: { DB: db }, params: { route: ['actions'] }
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
      const requestId = (await action(db, 'createRequest', { clientId, subject: 'Cambio prezzo', sourceChannel: 'manuale', kind: 'prezzo', sourceText: '## Piatti\nZuppa — 8,00' })).body.result.id;
      const extracted = await action(db, 'generateDraft', { requestId });
      assert.equal(extracted.status, 200);
      const draft = extracted.body.state.drafts.find((item) => item.requestId === requestId);
      assert.equal(draft.slug, 'qr-invariato');
      const changedSlug = structuredClone(draft.menu); changedSlug.id = 'qr-diverso';
      assert.equal((await action(db, 'saveDraft', { id: draft.id, revision: draft.revision, slug: changedSlug.id, menu: changedSlug })).status, 422);
      const review = await action(db, 'reviewDraft', { id: draft.id, revision: draft.revision, checks: { prices: true, allergens: true, languages: true, clientApproval: true }, approvalEvidence: 'Email demo cliente: revisione approvata' });
      assert.equal(review.body.state.drafts.find((item) => item.id === draft.id).status, 'pronta_pr');
      const form = new FormData();
      form.set('requestId', requestId);
      form.set('file', new File(['%PDF-1.4\naltro listino di prova'], 'aggiornamento-demo.pdf', { type: 'application/pdf' }));
      const response = await onRequest({
        request: new Request(`${base}material`, { method: 'POST', headers: { Origin: 'https://renmenu.pages.dev' }, body: form }),
        env: { DB: db, BUCKET }, params: { route: ['material'] }
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
      const requestId = (await action(db, 'createRequest', { clientId, subject: 'Nuovo menu', sourceChannel: 'manuale', kind: 'nuovo', sourceText: '## Primi\nZuppa — 8,00' })).body.result.id;
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
      const requestId = (await action(db, 'createRequest', { clientId, subject: 'Menu', sourceChannel: 'manuale', kind: 'nuovo', sourceText: '## Piatti\nPasta — 9,00' })).body.result.id;
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
        request: new Request(`${base}material`, { method: 'POST', headers: { Origin: 'https://renmenu.pages.dev' }, body: form }),
        env: { DB: db, BUCKET }, params: { route: ['material'] }
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      const id = body.result.id;
      assert.equal(body.state.materials[0].requestId, requestId);
      assert.equal(body.state.materials[0].r2_key, undefined);
      const archived = await action(db, 'archiveMaterial', { id, confirmation: 'ARCHIVIA MATERIALE' });
      assert.equal(archived.status, 200);
      assert.ok(archived.body.state.materials[0].archivedAt);
      const download = await onRequest({ request: new Request(`${base}material/${id}`), env: { DB: db, BUCKET }, params: { route: ['material', id] } });
      assert.equal(download.status, 200);
      assert.equal((await download.text()).startsWith('%PDF-1.4'), true);
    } finally { db.close(); }
  });
});

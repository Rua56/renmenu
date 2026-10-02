import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { buildImportBatch, VERIFY_SQL, DATABASE_ID } from '../staging/gmail-import.mjs';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of ['0001_initial.sql', '0002_integrations.sql', '0003_ai_free_scope.sql', '0004_request_category.sql', '0005_draft_provenance.sql'])
    sqlite.exec(readFileSync(new URL(`../cloudflare/migrations/${name}`, import.meta.url), 'utf8'));
  return sqlite;
}
const run = (db, plan) => { for (const { sql, params } of plan.batch) db.prepare(sql).run(...params.map(String)); };
const base = { messageId: '1a0fcabc123', from: 'Cliente@Example.com', to: 'renmenu1569@gmail.com', subject: 'Nuovo menu',
  text: 'Locale: Osteria Prova\n# Primi\nGnocchi — 10,50', receivedAt: '2026-10-02T12:44:00Z', relevant: true,
  bodyComplete: true, hasAttachments: false, attachmentNames: [], ambiguous: false };

describe('Import automatico Gmail → D1 staging', () => {
  it('punta solo al D1 privato di staging', () => assert.equal(DATABASE_ID, 'be94eb32-dad9-48c5-92b3-c3bf58565c8d'));
  it('crea una pratica da revisionare, idempotente sullo stesso ID', () => {
    const db = database();
    const plan = buildImportBatch(base, '2026-10-02T12:45:00.000Z');
    run(db, plan); run(db, buildImportBatch(base, '2026-10-02T12:50:00.000Z'));
    assert.deepEqual({ ...db.prepare(VERIFY_SQL).get('gmail', base.messageId) }, { status: 'imported', request_id: 'gmail-request-1a0fcabc123' });
    const request = db.prepare('SELECT status,plan,kind,source_channel,source_text FROM requests').all();
    assert.equal(request.length, 1);
    assert.equal(request[0].status, 'nuova');
    assert.equal(request[0].plan, 'da_definire');
    assert.match(request[0].source_text, /^Oggetto ricevuto: Nuovo menu\n\nLocale: Osteria Prova/);
    const clients = db.prepare('SELECT name,email FROM clients').all();
    assert.deepEqual(clients.map((c) => ({ ...c })), [{ name: 'Nuovo contatto email', email: 'cliente@example.com' }]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM drafts').get().n, 0, 'nessuna bozza automatica');
  });
  it('allegati o ambiguità → needs_review; irrilevante → ignored senza corpo', () => {
    const db = database();
    run(db, buildImportBatch({ ...base, messageId: 'att1', hasAttachments: true, attachmentNames: ['menu.pdf'] }));
    assert.equal(db.prepare(VERIFY_SQL).get('gmail', 'att1').status, 'needs_review');
    assert.equal(db.prepare("SELECT status FROM requests WHERE id='gmail-request-att1'").get().status, 'dati_da_confermare');
    const ignored = buildImportBatch({ ...base, messageId: 'spam1', relevant: false });
    assert.equal(ignored.batch.length, 1);
    assert.equal(JSON.stringify(ignored.batch).includes('Gnocchi'), false);
    run(db, ignored);
    assert.equal(db.prepare(VERIFY_SQL).get('gmail', 'spam1').status, 'ignored');
  });
  it('rifiuta caselle diverse da quella business e input non validi', () => {
    assert.equal(buildImportBatch({ ...base, to: 'iuran56@gmail.com' }).error, 'NOT_BUSINESS_INBOX');
    assert.equal(buildImportBatch({ ...base, messageId: 'a b' }).error, 'INVALID_MESSAGE_ID');
    assert.equal(buildImportBatch({ ...base, relevant: 'si' }).error, 'INVALID_INPUT');
  });
});

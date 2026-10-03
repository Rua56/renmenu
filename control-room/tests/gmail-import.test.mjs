import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { buildImportBatch, buildReplyBatch, replyReference, APPROVAL_SQL, VERIFY_SQL, DATABASE_ID } from '../staging/gmail-import.mjs';
import { assessReply } from '../cloudflare/functions/_lib/approvals.js';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of ['0001_initial.sql', '0002_integrations.sql', '0003_ai_free_scope.sql', '0004_request_category.sql', '0005_draft_provenance.sql', '0010_draft_review_notes.sql', '0011_draft_creative.sql', '0006_publication_approvals.sql'])
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
  it('collega la risposta all’anteprima senza creare pratiche, solo dal destinatario giusto', () => {
    const db = database();
    run(db, buildImportBatch(base));
    db.prepare(`INSERT INTO drafts (id,request_id,slug,menu_json,status,checks_json,revision,created_at,updated_at) VALUES ('d1','gmail-request-1a0fcabc123','osteria-prova','{}','revisione','{}',1,'x','x')`).run();
    db.prepare(`INSERT INTO publication_approvals (id,draft_id,request_id,reference_code,snapshot_sha,status,recipient,preview_url,email_subject,email_body,prepared_at,revision,created_at,updated_at)
      VALUES ('a1','d1','gmail-request-1a0fcabc123','RM-ABC234','sha','anteprima_inviata','cliente@example.com','u','s','b','x',1,'x','x')`).run();
    const reply = { ...base, messageId: 'reply1', subject: 'Re: Anteprima del vostro menu digitale RenMenu · rif. RM-ABC234', text: 'Approvo, grazie.\n\nIl giorno 2 ott RenMenu ha scritto:\n> ...', relevant: false };
    assert.equal(replyReference(reply), 'RM-ABC234');
    // Oggetto svuotato dal client di posta: vale il riferimento letto nel messaggio citato.
    assert.equal(replyReference({ ...reply, subject: 'Re:', reference: 'RM-ABC234' }), 'RM-ABC234');
    assert.equal(replyReference({ ...reply, subject: 'Re:', reference: 'testo RM-ABC234 altro' }), null, 'solo il codice esatto');
    assert.equal(replyReference({ ...reply, subject: 'Re:' }), null);
    const approval = db.prepare(APPROVAL_SQL).get('RM-ABC234');
    assert.equal(buildReplyBatch({ ...reply, from: 'altro@example.com' }, approval).error, 'REPLY_SENDER_MISMATCH');
    const plan = buildReplyBatch(reply, approval);
    run(db, plan); run(db, buildReplyBatch(reply, approval));
    assert.deepEqual({ ...db.prepare(VERIFY_SQL).get('gmail', 'reply1') }, { status: 'imported', request_id: 'gmail-request-1a0fcabc123' });
    const row = db.prepare('SELECT status,reply_from,reply_text FROM publication_approvals').get();
    assert.equal(row.status, 'risposta_ricevuta', 'resta da confermare a Riccardo');
    assert.equal(row.reply_from, 'cliente@example.com');
    assert.equal(assessReply(row.reply_text).suggestion, 'approvazione');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM requests').get().n, 1, 'nessuna nuova pratica');
    const short = buildReplyBatch({ ...reply, messageId: 'reply2', text: 'approvo', bodyComplete: false }, { ...approval, status: 'risposta_ricevuta' });
    run(db, short);
    assert.equal(assessReply(db.prepare('SELECT reply_text FROM publication_approvals').get().reply_text).suggestion, 'approvazione', 'una risposta brevissima non è parziale');
    const long = 'Approvo il menu. ' + 'Vi chiedo però di controllare con calma anche la sezione dei vini prima di pubblicare, grazie mille. '.repeat(2);
    const partial = buildReplyBatch({ ...reply, messageId: 'reply4', text: long, bodyComplete: false }, { ...approval, status: 'risposta_ricevuta' });
    run(db, partial);
    assert.equal(assessReply(db.prepare('SELECT reply_text FROM publication_approvals').get().reply_text).suggestion, 'incerta');
    db.prepare("UPDATE publication_approvals SET status='approvata_cliente'").run();
    assert.equal(buildReplyBatch({ ...reply, messageId: 'reply3' }, db.prepare(APPROVAL_SQL).get('RM-ABC234')).error, 'REPLY_NOT_EXPECTED');
  });
});

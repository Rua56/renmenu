import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import * as script from '../staging/gmail-import.mjs';
import * as lib from '../cloudflare/functions/_lib/mail-import.js';
import { automatedReason, importIncomingMail, parseIncomingMail } from '../cloudflare/functions/_lib/mail-in.js';
import { linkMailFiles, receiveMailFiles } from '../cloudflare/functions/_lib/mail-files.js';

const MIGRATIONS = new URL('../cloudflare/migrations/', import.meta.url);
function d1() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
  const statement = (sql, params = []) => ({
    sql, params,
    bind: (...values) => statement(sql, values),
    first: async () => { const row = sqlite.prepare(sql).get(...params); return row ? { ...row } : null; },
    all: async () => ({ results: sqlite.prepare(sql).all(...params).map((row) => ({ ...row })) }),
    run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...params).changes } })
  });
  return {
    sqlite,
    prepare: (sql) => statement(sql),
    async batch(list) {
      sqlite.exec('BEGIN');
      try { const out = list.map((s) => ({ meta: { changes: sqlite.prepare(s.sql).run(...s.params).changes } })); sqlite.exec('COMMIT'); return out; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    }
  };
}
function bucket() {
  const objects = new Map();
  return { objects, async put(key, bytes) { objects.set(key, bytes); }, async delete(key) { objects.delete(key); } };
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40_000, 7)]);
const LOGO = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(800, 1)]);
const b64 = (bytes) => Buffer.from(bytes).toString('base64').replace(/.{76}/g, '$&\r\n');
function mime({ from = 'Osteria Codelli <Info@Codelli.it>', subject = 'Nuovo menu', text = 'Buongiorno, ecco il nostro menu.\nPrimi: Gnocchi 10,50', extraHeaders = '', parts = [], messageId = '<abc123@mail.example.it>', html = null } = {}) {
  const head = `From: ${from}\r\nTo: menu@renmenu.com\r\nSubject: ${subject}\r\nDate: Mon, 13 Oct 2026 10:00:00 +0200\r\nMessage-ID: ${messageId}\r\nMIME-Version: 1.0\r\n${extraHeaders}`;
  const body = html ? `Content-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n` : `Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${text}\r\n`;
  if (!parts.length) return new TextEncoder().encode(`${head}${body}`);
  const boundary = 'XYZ';
  const attachments = parts.map((p) => `--${boundary}\r\nContent-Type: ${p.type}${p.name ? `; name="${p.name}"` : ''}\r\nContent-Transfer-Encoding: base64\r\n${p.cid ? `Content-ID: <${p.cid}>\r\nContent-Disposition: inline\r\n` : `Content-Disposition: attachment; filename="${p.name}"\r\n`}\r\n${b64(p.bytes)}\r\n`).join('');
  return new TextEncoder().encode(`${head}Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n--${boundary}\r\n${body}${attachments}--${boundary}--\r\n`);
}
const NOW = new Date('2026-10-13T08:05:00.000Z');
const envelope = { envelopeFrom: 'bounce-123@mailer.codelli.it', envelopeTo: 'menu@renmenu.com', now: NOW };
function deps(db, store) {
  const env = { BUCKET: store };
  let n = 0;
  return { receiveFiles: (payload) => receiveMailFiles(db, env, payload, { now: () => NOW.toISOString(), uid: () => `file-${n += 1}` }) };
}

describe('logica di import condivisa con il vecchio ponte Gmail', () => {
  it('lo SHA-256 senza Node coincide con quello di Node', () => {
    for (const text of ['', 'cliente@example.com', 'àèìòù€', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'y'.repeat(1000)])
      assert.equal(lib.sha256HexSync(text), createHash('sha256').update(text).digest('hex'));
  });
  it('per le email Gmail produce esattamente gli stessi batch dello script', () => {
    const base = { messageId: '1a0fcabc123', from: 'Cliente@Example.com', to: 'renmenu1569@gmail.com', subject: 'I: Nuovo menu', text: 'Locale: Prova\n# Primi\nGnocchi — 10,50 €',
      receivedAt: '2026-10-02T12:44:00Z', relevant: true, bodyComplete: true, hasAttachments: false, attachmentNames: [], ambiguous: false };
    const stamp = '2026-10-02T12:45:00.000Z';
    for (const event of [base, { ...base, hasAttachments: true, attachmentNames: ['menu.pdf'] }, { ...base, relevant: false }, { ...base, ambiguous: true },
      { ...base, text: 'è'.repeat(4000) }, { ...base, to: 'altro@example.com' }])
      assert.deepEqual(lib.buildImportBatch(event, stamp), script.buildImportBatch(event, stamp));
    const approval = { id: 'a1', request_id: 'r1', status: 'anteprima_inviata', recipient: 'cliente@example.com' };
    for (const text of ['Approvo', 'ò'.repeat(2000)])
      assert.deepEqual(lib.buildReplyBatch({ ...base, text }, approval, stamp), script.buildReplyBatch({ ...base, text }, approval, stamp));
  });
});

describe('email diretta su menu@renmenu.com', () => {
  it('legge testo e allegati: foto e PDF tenuti, loghi delle firme ignorati, il resto segnalato', async () => {
    const raw = mime({ parts: [
      { type: 'image/jpeg', name: 'menu-1.jpg', bytes: JPEG },
      { type: 'image/png', name: 'logo.png', cid: 'logo1', bytes: LOGO },
      { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', name: 'vini.docx', bytes: Buffer.from('PK\u0003\u0004 doc') }
    ] });
    const { event, files, skipped, reason } = await parseIncomingMail(raw, envelope);
    assert.equal(reason, '');
    assert.equal(event.from, 'info@codelli.it', 'il mittente è quello dell’intestazione, non il rimbalzo tecnico');
    assert.equal(event.to, 'menu@renmenu.com');
    assert.match(event.messageId, /^m[a-f0-9]{40}$/);
    assert.equal(event.receivedAt, '2026-10-13T08:00:00.000Z');
    assert.match(event.text, /Gnocchi 10,50/);
    assert.deepEqual(files.map((f) => [f.name, f.mime, f.bytes.length]), [['menu-1.jpg', 'image/jpeg', JPEG.length]]);
    assert.deepEqual(skipped, ['vini.docx']);
    assert.deepEqual(event.attachmentNames, ['menu-1.jpg', 'vini.docx']);
  });

  it('crea la pratica, mette da parte la foto e l’orologio la collega e la riprende', async () => {
    const db = d1(), store = bucket();
    const raw = mime({ parts: [{ type: 'image/jpeg', name: 'menu-1.jpg', bytes: JPEG }] });
    const outcome = await importIncomingMail(db, raw, envelope, deps(db, store));
    assert.equal(outcome.ok, true);
    assert.equal(outcome.kind, 'request');
    assert.equal(outcome.attachments, 1);
    assert.match(outcome.note, /Nuova email su menu@renmenu\.com da info@codelli\.it: «Nuovo menu»\. Ho preso un allegato/);
    const request = await db.prepare('SELECT r.status,r.source_text,r.internal_notes,c.email FROM requests r JOIN clients c ON c.id=r.client_id WHERE r.id=?').bind(outcome.requestId).first();
    assert.equal(request.status, 'dati_da_confermare');
    assert.equal(request.email, 'info@codelli.it');
    assert.match(request.source_text, /^Oggetto ricevuto: Nuovo menu\n\nBuongiorno/);
    assert.match(request.internal_notes, /menu@renmenu\.com/);
    assert.doesNotMatch(request.internal_notes, /Gmail/);
    assert.equal(store.objects.size, 1);
    let n = 0;
    await linkMailFiles(db, { BUCKET: store }, { now: () => NOW.toISOString(), uid: () => `mat-${n += 1}`, auditedBatch: (_ctx, statements) => db.batch(statements) });
    const material = await db.prepare('SELECT filename,source,processing_status FROM materials WHERE request_id=?').bind(outcome.requestId).first();
    assert.deepEqual(material, { filename: 'menu-1.jpg', source: 'email', processing_status: 'da_trascrivere' });
    assert.equal((await db.prepare('SELECT status FROM requests WHERE id=?').bind(outcome.requestId).first()).status, 'nuova', 'torna all’autopilota');
  });

  it('una seconda consegna della stessa email non crea doppioni né nuovi avvisi', async () => {
    const db = d1(), store = bucket();
    const raw = mime();
    const first = await importIncomingMail(db, raw, envelope, deps(db, store));
    assert.equal(first.status, 'imported');
    assert.match(first.note, /Pratica creata: preparo la bozza/);
    const again = await importIncomingMail(db, raw, envelope, deps(db, store));
    assert.deepEqual([again.ok, again.kind, again.note], [true, 'duplicate', undefined]);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM requests').first()).n, 1);
  });

  it('newsletter, rimbalzi e risposte automatiche: registrati come non pertinenti, senza contenuto', async () => {
    const db = d1();
    const news = await importIncomingMail(db, mime({ extraHeaders: 'List-Unsubscribe: <mailto:x@y.it>\r\n', parts: [{ type: 'image/jpeg', name: 'promo.jpg', bytes: JPEG }] }), envelope, deps(db, bucket()));
    assert.deepEqual([news.ok, news.kind, news.reason, news.note], [true, 'ignored', 'mailing_list', undefined]);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM requests').first()).n, 0);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM mail_files').first()).n, 0);
    const header = (values) => (name) => values[name];
    assert.equal(automatedReason(header({}), 'mailer-daemon@googlemail.com'), 'automatic_sender');
    assert.equal(automatedReason(header({}), 'no-reply@ditta.it'), 'automatic_sender');
    assert.equal(automatedReason(header({ 'auto-submitted': 'auto-replied' }), 'titolare@bar.it'), 'auto_submitted');
    assert.equal(automatedReason(header({}), 'menu@renmenu.com'), 'own_domain');
    assert.equal(automatedReason(header({ 'auto-submitted': 'no' }), 'titolare@bar.it'), '');
  });

  it('una risposta all’anteprima si collega all’approvazione, senza nuova pratica', async () => {
    const db = d1();
    const first = await importIncomingMail(db, mime(), envelope, deps(db, bucket()));
    db.sqlite.prepare(`INSERT INTO drafts (id,request_id,slug,menu_json,status,checks_json,revision,created_at,updated_at) VALUES ('d1',?,'codelli','{}','revisione','{}',1,'x','x')`).run(first.requestId);
    db.sqlite.prepare(`INSERT INTO publication_approvals (id,draft_id,request_id,reference_code,snapshot_sha,status,recipient,preview_url,email_subject,email_body,prepared_at,revision,created_at,updated_at)
      VALUES ('a1','d1',?,'RM-ABC234','sha','anteprima_inviata','info@codelli.it','u','s','b','x',1,'x','x')`).run(first.requestId);
    const reply = await importIncomingMail(db, mime({ subject: 'Re: Anteprima del vostro menu digitale RenMenu · rif. RM-ABC234', text: 'Approvo, grazie.', messageId: '<reply1@mail.example.it>' }), envelope, deps(db, bucket()));
    assert.deepEqual([reply.ok, reply.kind, reply.requestId], [true, 'client_reply', first.requestId]);
    assert.match(reply.note, /ha risposto all'anteprima RM-ABC234\. Sembra un’approvazione/);
    assert.equal((await db.prepare('SELECT status FROM publication_approvals').first()).status, 'risposta_ricevuta', 'decide sempre Riccardo');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM requests').first()).n, 1);
    // Oggetto svuotato dal client di posta: vale il codice citato nel testo.
    const quoted = await importIncomingMail(db, mime({ subject: 'Re:', text: 'Va bene così.\n\n> Anteprima rif. RM-ABC234', messageId: '<reply2@mail.example.it>' }), envelope, deps(db, bucket()));
    assert.equal(quoted.kind, 'client_reply');
    // Risposta da Gmail con tutta l'anteprima citata (link lungo): conta solo «Approvo», niente «testo parziale».
    const long = `https://renmenu.com/menu/?lang=it#data=${'eyJpZCI6Im9zdGVyaWEi'.repeat(300)}`;
    const gmail = await importIncomingMail(db, mime({ subject: 'Re: Anteprima del vostro menu digitale RenMenu · rif. RM-ABC234',
      text: `Approvo.\n\nLuca\n\nOn Wed, Oct 14, 2026 02:50 PM, RenMenu <\nmenu@renmenu.com> wrote:\n\nBuongiorno,\n\necco l’anteprima:\n${long}\n\nRiferimento anteprima: RM-ABC234`,
      messageId: '<reply3@mail.example.it>' }), envelope, deps(db, bucket()));
    assert.equal(gmail.kind, 'client_reply');
    assert.match(gmail.note, /Sembra un’approvazione/);
    assert.equal((await db.prepare('SELECT reply_text FROM publication_approvals').first()).reply_text, 'Approvo.\n\nLuca');
  });

  it('email solo HTML: il testo si legge lo stesso', async () => {
    const { event } = await parseIncomingMail(mime({ html: '<p>Buongiorno,</p><p>Secondi: <b>Frico</b> 12 &euro;</p>' }), envelope);
    assert.match(event.text, /Frico 12 €/);
  });

  it('accetta solo le email indirizzate a menu@renmenu.com', async () => {
    const db = d1();
    const outcome = await importIncomingMail(db, mime(), { ...envelope, envelopeTo: 'info@renmenu.com' }, deps(db, bucket()));
    assert.deepEqual(outcome, { ok: false, error: 'NOT_BUSINESS_INBOX' });
  });
});

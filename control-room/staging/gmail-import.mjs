#!/usr/bin/env node
// Importa UNA email della casella business renmenu1569@gmail.com nel D1 privato di staging
// (renmenu_jarvis_stage) come pratica "da revisionare". Traduzione fedele del batch di
// docs/gmail-trigger-relay.md: ID deterministici, ON CONFLICT/NOT EXISTS, verifica finale.
//
// Non risponde, non archivia, non cancella email; non genera bozze, PR o pubblicazioni.
// Non stampa corpo, oggetto o indirizzi: solo ID, conteggi e stato.
//
// Uso (sandbox Perplexity, credenziale Cloudflare iniettata dal proxy HTTPS):
//   node control-room/staging/gmail-import.mjs evento.json
// evento.json = { messageId, from, to, subject, text, receivedAt, relevant, bodyComplete,
//                 hasAttachments, attachmentNames, ambiguous }
// venueName resta sempre null: il nome del locale si conferma in revisione.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const BUSINESS_INBOX = 'renmenu1569@gmail.com';
export const ACCOUNT_ID = 'c114b21f55c15f484223d864218a92a6';
export const DATABASE_ID = 'be94eb32-dad9-48c5-92b3-c3bf58565c8d'; // renmenu_jarvis_stage, mai il D1 pubblico
const PLACEHOLDER_CLIENT = 'Nuovo contatto email';
const controlChars = /[\u0000-\u001f\u007f]/g;

export function validateEvent(e) {
  if (!e || typeof e !== 'object') return 'INVALID_INPUT';
  if (String(e.to || '').toLowerCase() !== BUSINESS_INBOX) return 'NOT_BUSINESS_INBOX';
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(e.messageId || ''))) return 'INVALID_MESSAGE_ID';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e.from || ''))) return 'INVALID_SENDER';
  if (!Number.isFinite(Date.parse(e.receivedAt))) return 'INVALID_DATE';
  for (const key of ['relevant', 'bodyComplete', 'hasAttachments', 'ambiguous'])
    if (typeof e[key] !== 'boolean') return 'INVALID_INPUT';
  if (!Array.isArray(e.attachmentNames) || e.attachmentNames.length > 20) return 'INVALID_INPUT';
  return '';
}

// Restituisce { batch, ids, expectedStatus } oppure { error }.
export function buildImportBatch(e, stamp = new Date().toISOString()) {
  const error = validateEvent(e);
  if (error) return { error };
  const from = e.from.toLowerCase();
  const receivedAt = new Date(e.receivedAt).toISOString();
  const subject = String(e.subject || '').replace(controlChars, ' ').slice(0, 180) || 'Richiesta email da verificare';
  const raw = e.relevant ? String(e.text || '') : ''; // irrilevanti: il corpo non lascia la sandbox
  const rawBytes = Buffer.from(raw, 'utf8');
  const clipped = rawBytes.subarray(0, 7000).toString('utf8').replace(/\uFFFD$/, '');
  const names = e.attachmentNames.filter((n) => typeof n === 'string' && n.length <= 255).map((n) => n.replace(controlChars, ' '));
  const incomplete = e.ambiguous || !e.bodyComplete || rawBytes.length > 7000 || e.hasAttachments || names.length > 0;
  const source = `Oggetto ricevuto: ${subject}\n\n${clipped}`;
  if (Buffer.byteLength(source, 'utf8') > 8192) return { error: 'BODY_TOO_LARGE' };
  const note = incomplete
    ? `Email Gmail da verificare; pertinenza, corpo o allegati da confermare. Allegati nominati (NON importati): ${names.join(', ') || 'da controllare in Gmail'}. Conservare l'originale.`.slice(0, 2000)
    : 'Email Gmail importata; controllare fonte e dati prima di generare bozze. Conservare l’originale.';
  const step = incomplete ? 'Aprire il messaggio originale in Gmail e importare manualmente gli allegati prima della bozza.'
    : 'Verificare manualmente testo e dati della richiesta prima della bozza.';
  const eventId = `gmail-event-${e.messageId}`, requestId = `gmail-request-${e.messageId}`, auditId = `gmail-audit-${e.messageId}`;
  const clientId = `gmail-contact-${createHash('sha256').update(from).digest('hex').slice(0, 32)}`;
  const status = incomplete ? 'needs_review' : 'imported';
  const reason = e.ambiguous ? 'ambiguous_request' : incomplete ? 'body_incomplete_or_attachments' : '';
  if (!e.relevant) {
    return { ids: { eventId, requestId: null }, expectedStatus: 'ignored', batch: [{
      sql: "INSERT INTO external_events (id,source,source_event_id,request_id,status,reason,received_at) VALUES (?,'gmail',?,NULL,'ignored','not_relevant',?) ON CONFLICT(source,source_event_id) DO NOTHING",
      params: [eventId, e.messageId, receivedAt] }] };
  }
  const gate = "EXISTS (SELECT 1 FROM external_events WHERE id=? AND status='received')";
  const batch = [
    { sql: "INSERT INTO external_events (id,source,source_event_id,request_id,status,reason,received_at) VALUES (?,'gmail',?,NULL,'received',NULL,?) ON CONFLICT(source,source_event_id) DO NOTHING",
      params: [eventId, e.messageId, receivedAt] },
    { sql: `INSERT INTO clients (id,name,email,plan,internal_notes,revision,created_at,updated_at) SELECT ?,?,?,'da_definire','',1,?,? WHERE ${gate} AND NOT EXISTS (SELECT 1 FROM clients WHERE lower(email)=?)`,
      params: [clientId, PLACEHOLDER_CLIENT, from, stamp, stamp, eventId, from] },
    { sql: `INSERT INTO requests (id,client_id,subject,source_channel,source_text,kind,status,plan,contact_info,internal_notes,next_step,last_action_at,revision,created_at,updated_at) SELECT ?,(SELECT id FROM clients WHERE lower(email)=? ORDER BY created_at ASC LIMIT 1),?,'email',?,'altro',?,'da_definire',?,?,?,?,1,?,? WHERE ${gate} AND NOT EXISTS (SELECT 1 FROM requests WHERE id=?)`,
      params: [requestId, from, subject, source, incomplete ? 'dati_da_confermare' : 'nuova', from, note, step, stamp, receivedAt, stamp, eventId, requestId] },
    { sql: `INSERT INTO audit_events (id,request_id,action,summary,actor,created_at) SELECT ?,?,'gmail.import','Email cliente ricevuta e registrata per revisione.','gmail-connector',? WHERE ${gate} AND NOT EXISTS (SELECT 1 FROM audit_events WHERE id=?)`,
      params: [auditId, requestId, stamp, eventId, auditId] },
    { sql: "UPDATE external_events SET request_id=?,status=?,reason=NULLIF(?,'') WHERE id=? AND status='received' AND EXISTS (SELECT 1 FROM requests WHERE id=?)",
      params: [requestId, status, reason, eventId, requestId] }
  ];
  return { batch, ids: { eventId, requestId }, expectedStatus: status };
}

// Risposta del locale a un'anteprima (oggetto con «rif. RM-XXXXXX»): non crea una nuova
// pratica, collega il testo all'approvazione in attesa. L'approvazione resta da confermare
// a Riccardo nella Control Room; qui non si decide nulla.
export const REFERENCE = /\bRM-[A-HJ-NP-Z2-9]{6}\b/;
export const PARTIAL_MARK = '[Testo parziale: leggi l’email completa in Gmail prima di decidere]';
export const APPROVAL_SQL = "SELECT id,request_id,status,lower(recipient) AS recipient FROM publication_approvals WHERE reference_code=?";
// Il riferimento si cerca nell'oggetto; se manca (oggetto svuotato dal client di posta),
// vale il campo `reference` letto dall'automazione nel messaggio citato di RenMenu.
// In ogni caso il mittente deve coincidere con il destinatario dell'anteprima.
export function replyReference(e) {
  const match = REFERENCE.exec(String(e?.subject || ''));
  if (match) return match[0];
  const quoted = REFERENCE.exec(String(e?.reference || ''));
  return quoted && quoted[0] === String(e.reference).trim() ? quoted[0] : null;
}
export function buildReplyBatch(e, approval, stamp = new Date().toISOString()) {
  const error = validateEvent(e);
  if (error) return { error };
  const from = e.from.toLowerCase();
  if (!approval || approval.recipient !== from) return { error: 'REPLY_SENDER_MISMATCH' };
  if (!['anteprima_pronta', 'anteprima_inviata', 'risposta_ricevuta'].includes(approval.status)) return { error: 'REPLY_NOT_EXPECTED' };
  const receivedAt = new Date(e.receivedAt).toISOString();
  const raw = Buffer.from(String(e.text || ''), 'utf8').subarray(0, 3000).toString('utf8').replace(/\uFFFD$/, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
  // Una risposta brevissima (es. "Approvo") sta tutta nell'anteprima di Gmail: anche se
  // l'automazione non ha riaperto il messaggio, il testo non può essere tagliato (pilota 8).
  // Oltre i 120 byte serve il corpo letto per intero. La decisione resta comunque a Riccardo.
  const bytes = Buffer.byteLength(String(e.text || '').trim(), 'utf8');
  const partial = (!e.bodyComplete && bytes > 120) || e.ambiguous || e.hasAttachments || bytes > 3000;
  const text = partial ? `${PARTIAL_MARK}\n${raw}` : raw;
  const eventId = `gmail-event-${e.messageId}`, auditId = `gmail-audit-${e.messageId}`;
  const gate = "EXISTS (SELECT 1 FROM external_events WHERE id=? AND status='received')";
  const batch = [
    { sql: "INSERT INTO external_events (id,source,source_event_id,request_id,status,reason,received_at) VALUES (?,'gmail',?,NULL,'received',NULL,?) ON CONFLICT(source,source_event_id) DO NOTHING",
      params: [eventId, e.messageId, receivedAt] },
    { sql: `UPDATE publication_approvals SET status='risposta_ricevuta',reply_message_id=?,reply_from=?,reply_text=?,reply_received_at=?,revision=revision+1,updated_at=? WHERE id=? AND status IN ('anteprima_pronta','anteprima_inviata','risposta_ricevuta') AND ${gate}`,
      params: [e.messageId, from, text, receivedAt, stamp, approval.id, eventId] },
    { sql: `INSERT INTO audit_events (id,request_id,action,summary,actor,created_at) SELECT ?,?,'gmail.client_reply','Risposta del locale all’anteprima ricevuta: da valutare in Approvazioni.','gmail-connector',? WHERE ${gate} AND NOT EXISTS (SELECT 1 FROM audit_events WHERE id=?)`,
      params: [auditId, approval.request_id, stamp, eventId, auditId] },
    { sql: "UPDATE external_events SET request_id=?,status='imported',reason='client_reply' WHERE id=? AND status='received' AND EXISTS (SELECT 1 FROM publication_approvals WHERE id=? AND reply_message_id=?)",
      params: [approval.request_id, eventId, approval.id, e.messageId] }
  ];
  return { batch, ids: { eventId, requestId: approval.request_id }, expectedStatus: 'imported', kind: 'client_reply' };
}

export const VERIFY_SQL = 'SELECT status,request_id FROM external_events WHERE source=? AND source_event_id=?';

export function d1(sql, params) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`;
  // curl rispetta HTTPS_PROXY: la credenziale viene iniettata dal proxy, mai scritta qui.
  const out = execFileSync('curl', ['-sS', '-X', 'POST', url, '-H', 'Content-Type: application/json', '--data-binary', '@-'],
    { input: JSON.stringify({ sql, params: params.map(String) }) });
  const response = JSON.parse(out.toString('utf8'));
  if (!response.success) throw new Error(`D1_ERROR ${JSON.stringify(response.errors || []).slice(0, 300)}`);
  return response.result?.[0];
}

// Testo per la notifica a Riccardo: cosa Jarvis ha capito e cosa preparerà all'apertura della
// Control Room. Usa le stesse funzioni pure del server; se lo script gira da solo (senza il
// resto del repository) la notifica resta quella standard.
export async function jarvisNote(event, plan, row) {
  try {
    const lib = (path) => import(new URL(`../cloudflare/functions/_lib/${path}`, import.meta.url).href);
    if (plan.kind === 'client_reply') {
      const { assessReply } = await lib('approvals.js');
      const verdict = assessReply(String(event.text || '')).suggestion;
      return { jarvis: verdict === 'approvazione' ? 'Riccardo, il locale sembra approvare: conferma tu in Approvazioni.'
        : verdict === 'modifiche' ? 'Riccardo, il locale chiede modifiche: ti preparo le correzioni in Approvazioni.'
          : 'Riccardo, risposta del locale da leggere: decidi tu in Approvazioni.' };
    }
    if (row?.status !== 'imported' || !event.relevant) return {};
    const { autopilotMessage, autopilotPreview } = await lib('autopilot.js');
    const source = `Oggetto ricevuto: ${event.subject}\n\n${event.text}`;
    const preview = autopilotPreview({ subject: event.subject, source_text: source });
    const message = autopilotMessage(event.subject, preview);
    return { jarvis: preview.action === 'bozza' ? message.replace('bozza pronta per', 'all’apertura della Control Room preparo la bozza per').replace(' Apri Revisione per controllarla.', '') : message };
  } catch { return {}; }
}

async function main(file) {
  const event = JSON.parse(readFileSync(file, 'utf8'));
  // Una risposta a un'anteprima si collega all'approvazione solo se il riferimento esiste e il
  // mittente coincide con il destinatario dell'anteprima; altrimenti segue l'import normale.
  const reference = replyReference(event);
  const approval = reference ? d1(APPROVAL_SQL, [reference])?.results?.[0] : null;
  const reply = approval ? buildReplyBatch(event, approval) : null;
  const plan = reply && !reply.error ? reply : buildImportBatch(event);
  if (plan.error) { console.log(JSON.stringify({ ok: false, reason: plan.error })); process.exit(2); }
  // Sequenziale e idempotente: un nuovo tentativo dopo un errore completa il record senza duplicarlo.
  for (const { sql, params } of plan.batch) d1(sql, params);
  const row = d1(VERIFY_SQL, ['gmail', event.messageId])?.results?.[0];
  const ok = row?.status === plan.expectedStatus && (plan.ids.requestId === null || row?.request_id === plan.ids.requestId);
  // Un evento già registrato prima (stesso ID) è un duplicato: nessuna nuova pratica.
  console.log(JSON.stringify({ ok, messageId: event.messageId, requestId: row?.request_id || null, status: row?.status || 'unverified', expected: plan.expectedStatus,
    kind: plan.kind || 'request', ...(reference ? { reference, replyLinked: plan.kind === 'client_reply', replyIssue: reply?.error || null } : {}),
    ...(ok ? await jarvisNote(event, plan, row) : {}) }));
  process.exit(ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (!process.argv[2]) { console.error('Uso: node gmail-import.mjs evento.json'); process.exit(2); }
  main(process.argv[2]).catch((error) => { console.log(JSON.stringify({ ok: false, reason: String(error.message).slice(0, 300) })); process.exit(1); });
}

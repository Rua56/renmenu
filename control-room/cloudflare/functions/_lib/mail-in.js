// Ingresso diretto delle email: menu@renmenu.com → Email Routing → Worker `renmenu-jarvis-mail`
// (cloudflare/mail/mail.mjs) → POST /jarvis-hook/mail-in con l'email grezza (MIME).
// Qui, in un solo passaggio: testo e allegati letti, pratica registrata con lo stesso batch del
// vecchio ponte Gmail (_lib/mail-import.js), foto e PDF messi da parte per Jarvis (_lib/mail-files.js),
// risposte alle anteprime («rif. RM-XXXXXX») collegate all'approvazione.
// Il contenuto dell'email è un dato non attendibile: non viene mai eseguito né seguito.
// Non risponde al mittente, non genera bozze né pubblica nulla: il resto lo fa l'orologio.
import PostalMime from './vendor/postal-mime/postal-mime.js';
import { htmlToText } from './vendor/postal-mime/text-format.js';
import { APPROVAL_SQL, DOMAIN_INBOX, REFERENCE, VERIFY_SQL, buildImportBatch, buildReplyBatch, replyReference, unforwardSubject } from './mail-import.js';
import { assessReply, stripQuoted } from './approvals.js';

export const MAX_RAW_BYTES = 30_000_000; // Email Routing accetta fino a 25 MiB
const FILE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const SMALL_INLINE_IMAGE = 20_000; // loghi e icone delle firme: non sono menu
const encoder = new TextEncoder();

async function sha256Hex(input) {
  const bytes = typeof input === 'string' ? encoder.encode(input) : input;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// ID stabile del messaggio (lettere e cifre): dal Message-ID, o dall'email intera se manca.
// Lo stesso messaggio consegnato due volte dà lo stesso ID, quindi nessuna pratica doppia.
export async function mailMessageId(headerId, raw) {
  const id = String(headerId || '').trim();
  return `m${(await sha256Hex(id || raw)).slice(0, 40)}`;
}

// Email automatiche (rimbalzi, newsletter, risposte automatiche, giri dal nostro dominio):
// registrate come «non pertinenti», senza salvarne il contenuto.
export function automatedReason(header, from) {
  const value = (name) => String(header(name) || '').trim().toLowerCase();
  if (/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounces?)([+._-][^@]*)?@/i.test(from)) return 'automatic_sender';
  if (/@(?:[a-z0-9-]+\.)*renmenu\.com$/i.test(from)) return 'own_domain';
  const auto = value('auto-submitted');
  if (auto && auto !== 'no') return 'auto_submitted';
  if (/^(bulk|list|junk)$/.test(value('precedence'))) return 'bulk';
  if (value('list-unsubscribe') || value('list-id')) return 'mailing_list';
  return '';
}

// Riferimento dell'anteprima citato nel testo (quando il client di posta ha svuotato l'oggetto):
// vale solo se nel testo c'è un unico codice.
function quotedReference(text) {
  const codes = new Set(String(text || '').match(new RegExp(REFERENCE.source, 'g')) || []);
  return codes.size === 1 ? [...codes][0] : undefined;
}

/** Legge l'email grezza: { event, files, skipped, reason }. Non scrive nulla. */
export async function parseIncomingMail(raw, { envelopeFrom = '', now = new Date() } = {}) {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  const parsed = await PostalMime.parse(bytes);
  const headers = new Map((parsed.headers || []).map((h) => [String(h.key).toLowerCase(), h.value]));
  const header = (name) => headers.get(name);
  const from = String(parsed.from?.address || envelopeFrom || '').trim().toLowerCase();
  const messageId = await mailMessageId(parsed.messageId, bytes);
  const text = String(parsed.text || (parsed.html ? htmlToText(parsed.html) : '') || '').replace(/\r\n?/g, '\n').trim();
  const reason = automatedReason(header, from);
  const files = [], skipped = [], names = [];
  for (const attachment of parsed.attachments || []) {
    const mime = String(attachment.mimeType || '').toLowerCase();
    const content = attachment.content instanceof ArrayBuffer ? new Uint8Array(attachment.content) : new Uint8Array(0);
    const name = String(attachment.filename || '').trim();
    // Immagini piccole dentro il testo (firme, loghi, social): non contano come allegati.
    if (mime.startsWith('image/') && attachment.contentId && content.length < SMALL_INLINE_IMAGE && attachment.disposition !== 'attachment') continue;
    if (attachment.mimeType === 'message/rfc822' && !name) continue;
    names.push(name || `allegato-${names.length + 1}`);
    if (FILE_TYPES.has(mime) && content.length) files.push({ name, mime, bytes: content });
    else skipped.push(name || mime || 'allegato senza nome');
  }
  const receivedAt = Number.isFinite(Date.parse(parsed.date)) && Date.parse(parsed.date) <= now.getTime() + 3_600_000 ? new Date(parsed.date).toISOString() : now.toISOString();
  const event = {
    messageId, from, to: DOMAIN_INBOX, subject: String(parsed.subject || ''), text, receivedAt,
    relevant: !reason, bodyComplete: true, hasAttachments: names.length > 0, attachmentNames: names.slice(0, 20), ambiguous: false,
    reference: quotedReference(text)
  };
  return { event, files, skipped, reason };
}

const statements = (db, plan) => plan.batch.map(({ sql, params }) => db.prepare(sql).bind(...params));

/**
 * Registra l'email: pratica nuova o risposta a un'anteprima, più gli allegati.
 * deps: { receiveFiles(payload) } che mette da parte foto e PDF (receivePendingMail).
 * Restituisce un esito sintetico e il testo per Riccardo (`note`), senza il contenuto dell'email.
 */
export async function importIncomingMail(db, raw, { envelopeFrom, envelopeTo, now = new Date() } = {}, { receiveFiles } = {}) {
  if (String(envelopeTo || '').trim().toLowerCase() !== DOMAIN_INBOX) return { ok: false, error: 'NOT_BUSINESS_INBOX' };
  const { event, files, skipped, reason } = await parseIncomingMail(raw, { envelopeFrom, now });
  const stamp = now.toISOString();
  // Stessa email consegnata di nuovo: già registrata, nessun nuovo avviso.
  const seen = await db.prepare(VERIFY_SQL).bind('gmail', event.messageId).first();
  if (seen && seen.status !== 'received') return { ok: true, messageId: event.messageId, kind: 'duplicate', requestId: seen.request_id || null };
  if (!event.relevant) {
    const plan = buildImportBatch(event, stamp);
    if (plan.error) return { ok: false, error: plan.error };
    await db.batch(statements(db, plan));
    return { ok: true, messageId: event.messageId, kind: 'ignored', reason };
  }
  const reference = replyReference(event);
  const approval = reference ? await db.prepare(APPROVAL_SQL).bind(reference).first() : null;
  // Della risposta all'anteprima conta solo il testo nuovo: la citazione (con il link lungo dell'anteprima)
  // la farebbe sembrare lunga e Jarvis si fermerebbe anche su un semplice «Approvo».
  const replyText = approval ? stripQuoted(event.text) : '';
  const reply = approval ? buildReplyBatch(replyText ? { ...event, text: replyText } : event, approval, stamp) : null;
  const plan = reply && !reply.error ? reply : buildImportBatch(event, stamp);
  if (plan.error) return { ok: false, error: plan.error };
  // Prima gli allegati (idempotenti), poi la pratica: l'orologio li collega appena la pratica esiste.
  let attachments = { stored: 0, skipped: 0 };
  if (plan.kind !== 'client_reply' && (files.length || skipped.length) && receiveFiles) {
    attachments = await receiveFiles({ messageId: event.messageId, from: event.from, subject: event.subject, files, skipped });
    if (attachments?.ok === false) return { ok: false, error: attachments.error || 'ATTACHMENTS_FAILED' };
  }
  await db.batch(statements(db, plan));
  const row = await db.prepare(VERIFY_SQL).bind('gmail', event.messageId).first();
  const ok = row?.status === plan.expectedStatus && (plan.ids.requestId === null || row?.request_id === plan.ids.requestId);
  if (!ok) return { ok: false, error: 'NOT_VERIFIED', messageId: event.messageId };
  const subject = unforwardSubject(event.subject).slice(0, 80) || 'senza oggetto';
  let note;
  if (plan.kind === 'client_reply') {
    const verdict = assessReply(event.text).suggestion;
    note = `${event.from} ha risposto all'anteprima ${reference}. ${verdict === 'approvazione' ? 'Sembra un’approvazione: conferma tu in Approvazioni.'
      : verdict === 'modifiche' ? 'Chiede modifiche: ti preparo le correzioni in Approvazioni.' : 'Leggila e decidi tu in Approvazioni.'}`;
  } else {
    const stored = attachments?.stored || 0;
    note = `Nuova email su ${DOMAIN_INBOX} da ${event.from}: «${subject}». ${stored ? `Ho preso ${stored === 1 ? 'un allegato' : `${stored} allegati`}: li leggo e poi preparo la bozza.`
      : row.status === 'imported' ? 'Pratica creata: preparo la bozza.' : 'Pratica creata, da verificare in Revisione.'}`;
  }
  return { ok: true, messageId: event.messageId, kind: plan.kind || 'request', requestId: row.request_id, status: row.status, attachments: attachments?.stored || 0, note };
}

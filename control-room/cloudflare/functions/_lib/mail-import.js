// Import di UNA email cliente come pratica "da revisionare" (batch idempotente di
// docs/gmail-trigger-relay.md). Funzioni pure, senza Node: le usano sia lo script
// staging/gmail-import.mjs (vecchio ponte Gmail) sia l'ingresso diretto menu@renmenu.com
// (_lib/mail-in.js). ID deterministici: lo stesso messaggio non crea mai due pratiche.
//
// Caselle accettate: la casella Gmail storica e l'indirizzo del dominio.
export const BUSINESS_INBOX = 'renmenu1569@gmail.com';
export const DOMAIN_INBOX = 'menu@renmenu.com';
export const BUSINESS_INBOXES = [BUSINESS_INBOX, DOMAIN_INBOX];
const PLACEHOLDER_CLIENT = 'Nuovo contatto email';
const controlChars = /[\u0000-\u001f\u007f]/g;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');
const byteLength = (text) => encoder.encode(text).length;
// Primi `max` byte UTF-8 del testo, senza lasciare un carattere spezzato in fondo.
const clipBytes = (text, max) => decoder.decode(encoder.encode(text).subarray(0, max)).replace(/\uFFFD$/, '');

// SHA-256 sincrono (FIPS 180-4) per l'ID cliente deterministico: crypto.subtle è solo asincrono.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);
export function sha256HexSync(text) {
  const data = encoder.encode(String(text));
  const padded = new Uint8Array(Math.ceil((data.length + 9) / 64) * 64);
  padded.set(data); padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(data.length / 0x20000000));
  view.setUint32(padded.length - 4, (data.length * 8) >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  return [...h].map((x) => x.toString(16).padStart(8, '0')).join('');
}

// Email inoltrate da Riccardo (es. la richiesta di un locale arrivata su un altro indirizzo):
// via il prefisso «I:/Fwd:» dall'oggetto e l'intestazione dell'inoltro (Da/Data/Oggetto/A) dal
// corpo, così Jarvis legge solo il messaggio del locale. Le righe scritte sopra da Riccardo restano.
const FORWARD_MARK = /^\s*(?:-{2,}\s*(?:forwarded message|messaggio inoltrato|original message|messaggio originale)\s*-{2,}|inizio messaggio inoltrato:?|begin forwarded message:?)\s*$/i;
const FORWARD_HEADER = /^\s*(?:da|from|data|date|inviato|sent|oggetto|subject|a|to|cc|ccn|bcc|rispondi a|reply-to)\s*:/i;
export function unforwardSubject(subject) {
  return String(subject || '').replace(/^\s*(?:(?:fwd?|i|inoltro|tr|wg|r|re|ris|oggetto|subject)\s*:\s*)+/i, '').trim();
}
export function unforwardText(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!FORWARD_MARK.test(lines[i])) { out.push(lines[i]); continue; }
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j += 1;
    while (j < lines.length && (FORWARD_HEADER.test(lines[j]) || (!lines[j].trim() && j + 1 < lines.length && FORWARD_HEADER.test(lines[j + 1])))) j += 1;
    i = j - 1;
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function validateEvent(e) {
  if (!e || typeof e !== 'object') return 'INVALID_INPUT';
  if (!BUSINESS_INBOXES.includes(String(e.to || '').toLowerCase())) return 'NOT_BUSINESS_INBOX';
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
  const subject = unforwardSubject(String(e.subject || '').replace(controlChars, ' ')).slice(0, 180) || 'Richiesta email da verificare';
  const raw = e.relevant ? unforwardText(e.text) : ''; // irrilevanti: il corpo non viene salvato
  const rawSize = byteLength(raw);
  const clipped = clipBytes(raw, 7000);
  const names = e.attachmentNames.filter((n) => typeof n === 'string' && n.length <= 255).map((n) => n.replace(controlChars, ' '));
  const incomplete = e.ambiguous || !e.bodyComplete || rawSize > 7000 || e.hasAttachments || names.length > 0;
  const source = `Oggetto ricevuto: ${subject}\n\n${clipped}`;
  if (byteLength(source) > 8192) return { error: 'BODY_TOO_LARGE' };
  const direct = String(e.to).toLowerCase() === DOMAIN_INBOX; // arrivata su menu@renmenu.com, senza Gmail
  const note = direct
    ? (incomplete
      ? `Email a ${DOMAIN_INBOX} da verificare; pertinenza, corpo o allegati da confermare. Allegati: ${names.join(', ') || 'nessuno'} (foto e PDF li ha già presi Jarvis; gli altri vanno caricati a mano). Conservare l'originale.`.slice(0, 2000)
      : `Email a ${DOMAIN_INBOX} importata; controllare fonte e dati prima di generare bozze. Conservare l’originale.`)
    : incomplete
      ? `Email Gmail da verificare; pertinenza, corpo o allegati da confermare. Allegati nominati: ${names.join(', ') || 'da controllare in Gmail'} (foto e PDF li importa Jarvis da Gmail; gli altri vanno caricati a mano). Conservare l'originale.`.slice(0, 2000)
      : 'Email Gmail importata; controllare fonte e dati prima di generare bozze. Conservare l’originale.';
  const step = !incomplete ? 'Verificare manualmente testo e dati della richiesta prima della bozza.'
    : direct ? 'Controllare gli allegati letti da Jarvis e caricare a mano quelli che non sa leggere prima della bozza.'
      : 'Aprire il messaggio originale in Gmail e importare manualmente gli allegati prima della bozza.';
  const eventId = `gmail-event-${e.messageId}`, requestId = `gmail-request-${e.messageId}`, auditId = `gmail-audit-${e.messageId}`;
  const clientId = `gmail-contact-${sha256HexSync(from).slice(0, 32)}`;
  const status = incomplete ? 'needs_review' : 'imported';
  // Solo allegati in sospeso (corpo completo e chiaro): Jarvis li importa e poi riprende la pratica.
  const onlyAttachments = incomplete && !e.ambiguous && e.bodyComplete && rawSize <= 7000;
  const reason = e.ambiguous ? 'ambiguous_request' : onlyAttachments ? 'attachments_pending' : incomplete ? 'body_incomplete_or_attachments' : '';
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
// vale il campo `reference` letto nel messaggio citato di RenMenu.
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
  const raw = clipBytes(String(e.text || ''), 3000).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
  // Una risposta brevissima (es. "Approvo") sta tutta nell'anteprima di Gmail: anche se
  // l'automazione non ha riaperto il messaggio, il testo non può essere tagliato (pilota 8).
  // Oltre i 120 byte serve il corpo letto per intero. La decisione resta comunque a Riccardo.
  const bytes = byteLength(String(e.text || '').trim());
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

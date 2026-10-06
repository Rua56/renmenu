import {
  DEFAULT_MAX_CANONICAL_BYTES,
  DEFAULT_MAX_WEBHOOK_BYTES,
  gmailRelaySigningInput,
  readBoundedRawBody,
  timingSafeEqual,
  verifyAndParseWhatsAppWebhook,
  verifyWhatsAppChallenge
} from './inbound.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const GMAIL_MAILBOX = 'renmenu1569@gmail.com';
const GMAIL_MAX_BYTES = DEFAULT_MAX_CANONICAL_BYTES;
const REPLAY_WINDOW_SECONDS = 300;
const MAX_FUTURE_SKEW_SECONDS = 60;

const fail = (reason) => ({ ok: false, reason });
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const byteLength = (value) => encoder.encode(value).byteLength;
const isConfiguredSecret = (value) => typeof value === 'string' && value.length >= 16;
const header = (request, name) => request.headers.get(name);
const nowIso = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

function signatureBytes(value) {
  if (typeof value !== 'string') return null;
  const match = /^(?:sha256|v1)=([a-f0-9]{64})$/i.exec(value.trim());
  const hex = match ? match[1] : value.trim();
  if (!/^[a-f0-9]{64}$/i.test(hex)) return null;
  const output = new Uint8Array(32);
  for (let index = 0; index < output.length; index += 1) output[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return output;
}

async function hmacSha256(secret, input) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, input));
}

function safeString(value, maxBytes, { allowEmpty = false } = {}) {
  return typeof value === 'string' && (allowEmpty || value.length > 0) && byteLength(value) <= maxBytes && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function validEmail(value) {
  return safeString(value, 320) && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}

function validDate(value) {
  return safeString(value, 64) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) && !Number.isNaN(Date.parse(value));
}

function exactKeys(value, allowed, required) {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.has(key)) && required.every((key) => Object.hasOwn(value, key));
}

/**
 * Gmail relay data is a deliberately small signed envelope.  There are no URL
 * fields; text is opaque source material and is never fetched or interpreted.
 * `venue`, if supplied, must be explicitly attested by the relay.
 */
export function validateSignedGmailPayload(payload) {
  const allowed = new Set(['mailbox', 'messageId', 'from', 'to', 'subject', 'text', 'bodyComplete', 'attachmentNames', 'receivedAt', 'relevant', 'venue']);
  const required = ['mailbox', 'messageId', 'from', 'to', 'subject', 'text', 'bodyComplete', 'attachmentNames', 'receivedAt', 'relevant'];
  if (!isPlainObject(payload) || !exactKeys(payload, allowed, required)) return fail('MALFORMED_GMAIL_PAYLOAD');
  if (payload.mailbox !== GMAIL_MAILBOX || payload.to !== GMAIL_MAILBOX || !validEmail(payload.from)
    || !safeString(payload.messageId, 512) || !safeString(payload.subject, 512, { allowEmpty: true })
    || !safeString(payload.text, 8 * 1024, { allowEmpty: true }) || typeof payload.bodyComplete !== 'boolean'
    || !validDate(payload.receivedAt) || typeof payload.relevant !== 'boolean') return fail('MALFORMED_GMAIL_PAYLOAD');
  if (!Array.isArray(payload.attachmentNames) || payload.attachmentNames.length > 20
    || payload.attachmentNames.some((name) => !safeString(name, 255))) return fail('MALFORMED_GMAIL_PAYLOAD');
  if (Object.hasOwn(payload, 'venue')) {
    const venue = payload.venue;
    if (!isPlainObject(venue) || !exactKeys(venue, new Set(['name', 'attested']), ['name', 'attested'])
      || venue.attested !== true || !safeString(venue.name, 140)) return fail('MALFORMED_GMAIL_PAYLOAD');
  }
  return { ok: true, payload };
}

/**
 * Parses only a bounded JSON body, canonicalizes it, and checks its HMAC before
 * inspecting any payload property.  This prevents an unsigned field from
 * controlling routing, mailbox selection, or database writes.
 */
export async function verifyGmailWebhookRequest(request, secret, { now = Math.floor(Date.now() / 1000) } = {}) {
  const read = await readBoundedRawBody(request, { maxBytes: GMAIL_MAX_BYTES });
  if (!read.ok) return read;
  let payload;
  try {
    payload = JSON.parse(decoder.decode(read.rawBody));
  } catch {
    return fail('MALFORMED_GMAIL_PAYLOAD');
  }

  const timestampValue = header(request, 'x-gmail-relay-timestamp');
  if (typeof timestampValue !== 'string' || !/^\d{10}$/.test(timestampValue)) return fail('MISSING_OR_INVALID_TIMESTAMP');
  const timestamp = Number(timestampValue);
  if (!Number.isSafeInteger(timestamp) || timestamp < now - REPLAY_WINDOW_SECONDS || timestamp > now + MAX_FUTURE_SKEW_SECONDS) return fail('STALE_OR_FUTURE_EVENT');
  const supplied = signatureBytes(header(request, 'x-gmail-relay-signature'));
  if (!supplied || !isConfiguredSecret(secret)) return fail('MISSING_OR_INVALID_SIGNATURE');

  try {
    // gmailRelaySigningInput canonicalizes the full parsed JSON before fields are read.
    const expected = await hmacSha256(secret, gmailRelaySigningInput(payload, timestampValue, { maxBytes: GMAIL_MAX_BYTES }));
    if (!timingSafeEqual(expected, supplied)) return fail('INVALID_SIGNATURE');
  } catch {
    return fail('INVALID_SIGNATURE');
  }
  return validateSignedGmailPayload(payload);
}

export function gmailWebhookConfiguration(env = {}) {
  const enabled = env.GMAIL_RELAY_ENABLED === 'true';
  const secret = env.GMAIL_RELAY_SECRET;
  return { enabled, configured: enabled && isConfiguredSecret(secret), secret };
}

export function whatsappWebhookConfiguration(env = {}) {
  const enabled = env.WHATSAPP_WEBHOOK_ENABLED === 'true';
  const appSecret = env.WHATSAPP_APP_SECRET;
  const verifyToken = env.WHATSAPP_VERIFY_TOKEN;
  return { enabled, configured: enabled && isConfiguredSecret(appSecret) && isConfiguredSecret(verifyToken), appSecret, verifyToken };
}

export async function verifyWhatsAppWebhookRequest(request, appSecret) {
  const read = await readBoundedRawBody(request, { maxBytes: DEFAULT_MAX_WEBHOOK_BYTES });
  if (!read.ok) return read;
  return verifyAndParseWhatsAppWebhook({ headers: request.headers, rawBody: read.rawBody, appSecret });
}

export { verifyWhatsAppChallenge };

function requireD1(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') throw new Error('D1 unavailable');
}

function contactParts(contact) {
  if (contact?.type === 'email' && validEmail(contact.value)) {
    return {
      email: contact.value.toLowerCase(), phone: null, info: contact.value.toLowerCase(),
      matchSql: 'lower(email)=lower(?)', matchArgs: [contact.value],
      clientName: contact.clientName
    };
  }
  if (contact?.type === 'whatsapp' && typeof contact.value === 'string' && /^\d{6,20}$/.test(contact.value)) {
    const phone = `+${contact.value}`;
    return {
      email: null, phone, info: phone,
      matchSql: '(phone=? OR phone=?)', matchArgs: [phone, contact.value],
      clientName: contact.clientName
    };
  }
  throw new Error('Invalid trusted contact shape');
}

/**
 * D1.batch is transactional.  The external event insert is the transaction's
 * durable idempotency gate; all dependent SQL is conditioned on that newly
 * created `received` row, so a duplicate cannot create a second client/case or
 * audit record.  Audit summaries deliberately contain no inbound content.
 */
export async function persistIncomingExternalEvent(db, record) {
  requireD1(db);
  const contact = contactParts(record.contact);
  const stamp = nowIso();
  const externalId = uid();
  const clientId = uid();
  const requestId = uid();
  const source = record.source;
  const eventId = record.sourceEventId;
  if (!['gmail', 'whatsapp'].includes(source) || !safeString(eventId, 512) || !safeString(record.sourceText, 16 * 1024, { allowEmpty: true })
    || !safeString(record.subject, 180) || !['email', 'whatsapp'].includes(record.sourceChannel)
    || !['imported', 'needs_review'].includes(record.externalStatus) || !['nuova', 'dati_da_confermare'].includes(record.requestStatus)) throw new Error('Invalid external event');

  const gate = 'EXISTS (SELECT 1 FROM external_events WHERE id=? AND status=\'received\')';
  const clientLookup = `SELECT id FROM clients WHERE ${contact.matchSql} ORDER BY created_at ASC LIMIT 1`;
  const statements = [
    db.prepare('INSERT INTO external_events (id,source,source_event_id,request_id,status,reason,received_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(source,source_event_id) DO NOTHING')
      .bind(externalId, source, eventId, null, 'received', null, stamp),
    db.prepare(`INSERT INTO clients (id,name,email,phone,contact_name,contact_role,plan,payment_status,menu_id,menu_url,internal_notes,trial_ends_at,renewal_at,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${gate} AND NOT EXISTS (SELECT 1 FROM clients WHERE ${contact.matchSql})`)
      .bind(clientId, contact.clientName, contact.email, contact.phone, null, null, 'da_definire', null, null, null, '', null, null, stamp, stamp, externalId, ...contact.matchArgs),
    db.prepare(`INSERT INTO requests (id,client_id,subject,source_channel,source_text,kind,status,plan,contact_name,contact_role,contact_info,internal_notes,menu_id,public_url,next_step,follow_up_at,last_action_at,revision,created_at,updated_at)
      SELECT ?,COALESCE((${clientLookup}),?),?,?,?,?,?,'da_definire',NULL,NULL,?,'',NULL,NULL,'Verificare manualmente il messaggio in ingresso.',NULL,?,1,?,? WHERE ${gate}`)
      .bind(requestId, ...contact.matchArgs, clientId, record.subject, record.sourceChannel, record.sourceText, 'altro', record.requestStatus, contact.info, stamp, stamp, stamp, externalId),
    db.prepare(`INSERT INTO audit_events (id,request_id,action,summary,actor,created_at)
      SELECT ?,?,?,?,?,? WHERE ${gate}`)
      .bind(uid(), requestId, `webhook.${source}.import`, 'Evento webhook registrato per revisione.', 'relay', stamp, externalId),
    db.prepare("UPDATE external_events SET request_id=?,status=?,reason=? WHERE id=? AND status='received'")
      .bind(requestId, record.externalStatus, record.reason ?? null, externalId)
  ];
  const results = await db.batch(statements);
  return { deduplicated: results[0]?.meta?.changes === 0, requestId: results[0]?.meta?.changes === 1 ? requestId : null };
}

/** Records a non-relevant signed event without retaining its source content. */
export async function persistIgnoredExternalEvent(db, { source, sourceEventId, reason = 'not_relevant' }) {
  requireD1(db);
  if (!['gmail', 'whatsapp'].includes(source) || !safeString(sourceEventId, 512) || !safeString(reason, 80)) throw new Error('Invalid ignored event');
  const stamp = nowIso();
  const externalId = uid();
  const statements = [
    db.prepare('INSERT INTO external_events (id,source,source_event_id,request_id,status,reason,received_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(source,source_event_id) DO NOTHING')
      .bind(externalId, source, sourceEventId, null, 'ignored', reason, stamp),
    db.prepare("INSERT INTO audit_events (id,request_id,action,summary,actor,created_at) SELECT ?,NULL,? ,?,?,? WHERE EXISTS (SELECT 1 FROM external_events WHERE id=? AND status='ignored')")
      .bind(uid(), `webhook.${source}.ignored`, 'Evento webhook ignorato senza contenuto.', 'relay', stamp, externalId)
  ];
  const results = await db.batch(statements);
  return { deduplicated: results[0]?.meta?.changes === 0 };
}

export function gmailRecordFromPayload(payload) {
  const needsReview = !payload.bodyComplete || payload.attachmentNames.length > 0;
  return {
    source: 'gmail', sourceEventId: payload.messageId, sourceChannel: 'email',
    subject: 'Richiesta email da verificare',
    sourceText: `Oggetto ricevuto: ${payload.subject}\n\n${payload.text}`,
    contact: {
      type: 'email', value: payload.from,
      clientName: payload.venue?.attested === true ? payload.venue.name : 'Nuovo contatto email'
    },
    externalStatus: needsReview ? 'needs_review' : 'imported',
    requestStatus: needsReview ? 'dati_da_confermare' : 'nuova',
    reason: needsReview ? 'body_incomplete_or_attachments' : null
  };
}

export function whatsappRecordFromMessage(message) {
  const isText = message.messageType === 'text' && typeof message.content?.text === 'string';
  return {
    source: 'whatsapp', sourceEventId: message.id, sourceChannel: 'whatsapp',
    subject: 'Richiesta WhatsApp da verificare', sourceText: isText ? message.content.text : '',
    contact: { type: 'whatsapp', value: message.waId, clientName: 'Nuovo contatto WhatsApp' },
    externalStatus: isText ? 'imported' : 'needs_review',
    requestStatus: isText ? 'nuova' : 'dati_da_confermare',
    reason: isText ? null : 'unsupported_message_type'
  };
}

export const hookJson = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
});
export const hidden = () => new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
export const forbidden = () => new Response(null, { status: 403, headers: { 'Cache-Control': 'no-store' } });

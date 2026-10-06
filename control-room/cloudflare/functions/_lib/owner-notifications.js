import { quietHoursStatus, sendEmail } from './outbound.js';

/** The only recipient that this module can ever pass to the email adapter. */
export const OWNER_NOTIFICATION_RECIPIENT = 'renmenu1569@gmail.com';

const REDACTED_MESSAGE_TEXT = '[owner notification body redacted]';
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_SUBJECT_BYTES = 998;
const MAX_TEXT_BYTES = 100 * 1024;
const encoder = new TextEncoder();

function deny(reason, extra = {}) {
  return { ok: false, sent: false, reserved: false, reason, ...extra };
}

function asNonEmptyString(value, maxBytes) {
  return typeof value === 'string' && value.length > 0 && encoder.encode(value).byteLength <= maxBytes && !/[\u0000\r\n]/.test(value)
    ? value
    : null;
}

function validRequestId(value) {
  return asNonEmptyString(value, MAX_REQUEST_ID_LENGTH);
}

function validPriority(value) {
  return value === undefined || value === 'normale' || value === 'importante' || value === 'urgente'
    ? (value ?? 'normale')
    : null;
}

function senderAddress(value) {
  if (typeof value !== 'string' || value.length > 320 || /[\r\n]/.test(value)) return null;
  const named = /^(?:[^<>\r\n]{1,128}\s)?<([^<>\s]+)>$/.exec(value.trim());
  const address = (named ? named[1] : value.trim()).toLowerCase();
  const match = /^([a-z0-9.!#$%&'*+/=?^_`{|}~-]+)@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/i.exec(address);
  return match ? { address, domain: match[2].toLowerCase() } : null;
}

function validApiKey(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 2_048 && !/[\u0000\r\n]/.test(value);
}

function normalizeNow(value) {
  const date = value === undefined ? new Date() : value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function identifier(prefix) {
  if (typeof crypto?.randomUUID === 'function') return `${prefix}_${crypto.randomUUID()}`;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function statement(db, sql, values) {
  return db.prepare(sql).bind(...values);
}

async function rowById(db, id) {
  return statement(db, 'SELECT id, request_id, channel, recipient, content_hash, provider_id, status, created_at, updated_at FROM outbound_deliveries WHERE id = ?', [id]).first();
}

async function contentHash(subject, text) {
  const material = JSON.stringify({ channel: 'email', recipient: OWNER_NOTIFICATION_RECIPIENT, subject, text });
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(material));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Validates only the deployment variables required for a real owner notification.
 *
 * Required exact values: EMAIL_LIVE_ENABLED='true', STAGING_PROTECTED='true',
 * ENVIRONMENT='protected-staging', and OWNER_EMAIL='renmenu1569@gmail.com'.
 * EMAIL_FROM_VERIFIED='true' is an explicit deployment attestation that EMAIL_FROM
 * was verified in the Resend account. If EMAIL_FROM is onboarding@resend.dev, the
 * separate RESEND_ONBOARDING_SENDER_AUTHORIZED='true' attestation is also required;
 * it is intentionally scoped to this business account rather than treated as a
 * global restriction on the Resend address.
 */
export function ownerNotificationConfigStatus(env = {}) {
  if (!env || typeof env !== 'object') return deny('INVALID_ENVIRONMENT');
  if (env.EMAIL_LIVE_ENABLED !== 'true') return deny('EMAIL_LIVE_DISABLED');
  if (env.STAGING_PROTECTED !== 'true' || env.ENVIRONMENT !== 'protected-staging') return deny('STAGING_NOT_PROTECTED');
  if (env.OWNER_EMAIL !== OWNER_NOTIFICATION_RECIPIENT) return deny('OWNER_EMAIL_MISMATCH');
  if (!validApiKey(env.RESEND_API_KEY)) return deny('MISSING_RESEND_API_KEY');
  if (env.EMAIL_FROM_VERIFIED !== 'true') return deny('EMAIL_FROM_NOT_VERIFIED');

  const sender = senderAddress(env.EMAIL_FROM);
  if (!sender) return deny('INVALID_EMAIL_FROM');
  if (sender.address === 'onboarding@resend.dev' && env.RESEND_ONBOARDING_SENDER_AUTHORIZED !== 'true') {
    return deny('ONBOARDING_SENDER_NOT_AUTHORIZED');
  }

  return {
    ok: true,
    sender: env.EMAIL_FROM,
    adapterConfig: {
      enabled: true,
      environment: 'protected-staging',
      protectedStaging: true,
      apiKey: env.RESEND_API_KEY,
      allowedSenderDomains: [sender.domain],
      allowedRecipientEmails: [OWNER_NOTIFICATION_RECIPIENT]
    }
  };
}

function notificationInput(input = {}) {
  const requestId = validRequestId(input.requestId);
  const subject = asNonEmptyString(input.subject, MAX_SUBJECT_BYTES);
  const text = typeof input.text === 'string' && input.text.length > 0 && encoder.encode(input.text).byteLength <= MAX_TEXT_BYTES
    ? input.text
    : null;
  const priority = validPriority(input.priority);
  if (!requestId) return deny('INVALID_REQUEST_ID');
  if (!subject) return deny('INVALID_SUBJECT');
  if (!text) return deny('INVALID_TEXT_BODY');
  if (!priority) return deny('INVALID_PRIORITY');
  return { ok: true, requestId, subject, text, priority };
}

async function insertReservation(db, { requestId, subject, text, priority, now }) {
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') return deny('D1_TRANSACTION_REQUIRED');
  const id = identifier('owner_email');
  const hash = await contentHash(subject, text);
  const timestamp = now.toISOString();
  const auditId = identifier('audit');

  try {
    // D1 batch is transactional. The audit INSERT is conditional on this invocation
    // inserting the delivery, so a duplicate can never create a misleading audit event.
    await db.batch([
      statement(db, `INSERT OR IGNORE INTO outbound_deliveries
        (id, request_id, channel, recipient, content_hash, message_text, approver, provider_id, status, created_at, updated_at)
        VALUES (?, ?, 'email', ?, ?, ?, ?, NULL, 'reserved', ?, ?)`,
      [id, requestId, OWNER_NOTIFICATION_RECIPIENT, hash, REDACTED_MESSAGE_TEXT, 'control-room-owner-notifications', timestamp, timestamp]),
      statement(db, `INSERT INTO audit_events (id, request_id, action, summary, actor, created_at)
        SELECT ?, ?, 'owner_email_reserved', 'Owner email reserved', 'control-room-owner-notifications', ?
        WHERE changes() = 1`, [auditId, requestId, timestamp])
    ]);
    const row = await rowById(db, id);
    if (row) return { ok: true, reserved: true, created: true, delivery: row, contentHash: hash };

    const existing = await statement(db, `SELECT id, request_id, channel, recipient, content_hash, provider_id, status, created_at, updated_at
      FROM outbound_deliveries WHERE channel = 'email' AND request_id = ? AND recipient = ? AND content_hash = ?`,
    [requestId, OWNER_NOTIFICATION_RECIPIENT, hash]).first();
    if (!existing) return deny('RESERVATION_NOT_FOUND');
    return { ok: true, reserved: false, created: false, duplicate: true, delivery: existing, contentHash: hash };
  } catch {
    // No provider interaction has occurred. Never include inputs, body, or keys in this result.
    return deny('D1_RESERVATION_FAILED');
  }
}

async function transitionDelivery(db, delivery, status, now, providerId) {
  const timestamp = now.toISOString();
  const action = status === 'sent' ? 'owner_email_sent'
    : status === 'unknown' ? 'owner_email_provider_unknown'
      : 'owner_email_failed';
  const summary = status === 'sent' ? 'Owner email accepted by provider'
    : status === 'unknown' ? 'Owner email provider outcome unknown'
      : 'Owner email not accepted by provider';

  try {
    // The status transition and its audit record commit or roll back together.
    await db.batch([
      statement(db, `UPDATE outbound_deliveries
        SET status = ?, provider_id = CASE WHEN ? IS NULL THEN provider_id ELSE ? END, updated_at = ?
        WHERE id = ? AND channel = 'email' AND recipient = ? AND status = 'reserved'`,
      [status, providerId ?? null, providerId ?? null, timestamp, delivery.id, OWNER_NOTIFICATION_RECIPIENT]),
      statement(db, `INSERT INTO audit_events (id, request_id, action, summary, actor, created_at)
        SELECT ?, ?, ?, ?, 'control-room-owner-notifications', ?
        WHERE changes() = 1`, [identifier('audit'), delivery.request_id, action, summary, timestamp])
    ]);
    return await rowById(db, delivery.id);
  } catch {
    return null;
  }
}

/**
 * Creates the durable, redacted D1 reservation and audit event but never calls a provider.
 * It has no recipient parameter: every row is addressed to OWNER_NOTIFICATION_RECIPIENT.
 * A duplicate in reserved, sent, or unknown state is returned without creating another row.
 */
export async function reserveOwnerNotification({ db, env, requestId, subject, text, priority, now } = {}) {
  const configuration = ownerNotificationConfigStatus(env);
  if (!configuration.ok) return configuration;
  const input = notificationInput({ requestId, subject, text, priority });
  if (!input.ok) return input;
  const timestamp = normalizeNow(now);
  if (!timestamp) return deny('INVALID_NOW');

  const quiet = quietHoursStatus({ at: timestamp, start: '21:00', end: '08:00', timeZone: 'Europe/Rome' });
  if (quiet.quiet && input.priority !== 'urgente') return deny('QUIET_HOURS');
  return insertReservation(db, { ...input, now: timestamp });
}

/**
 * Reserves and then attempts exactly one email delivery for a newly-created reservation.
 * fetchImpl is deliberately mandatory: callers must inject the platform fetch explicitly;
 * this module never falls back to global fetch, so tests and accidental local use cannot
 * perform network I/O. Existing reserved, sent, and unknown rows are never resent.
 */
export async function sendOwnerNotification({ db, env, requestId, subject, text, priority, now, fetchImpl } = {}) {
  if (typeof fetchImpl !== 'function') return deny('MISSING_FETCH_IMPLEMENTATION');
  const reservation = await reserveOwnerNotification({ db, env, requestId, subject, text, priority, now });
  if (!reservation.ok) return reservation;
  if (!reservation.created) {
    return {
      ok: true,
      sent: false,
      reserved: false,
      duplicate: true,
      status: reservation.delivery.status,
      deliveryId: reservation.delivery.id,
      contentHash: reservation.contentHash
    };
  }

  const configuration = ownerNotificationConfigStatus(env);
  const timestamp = normalizeNow(now);
  // Both have already been validated by reserveOwnerNotification; retain the fail-closed
  // checks in case this function is changed independently in the future.
  if (!configuration.ok || !timestamp) return deny('POST_RESERVATION_VALIDATION_FAILED');

  const adapterResult = await sendEmail({
    config: configuration.adapterConfig,
    approval: { approved: true, channel: 'email', idempotencyKey: reservation.delivery.id },
    from: configuration.sender,
    to: OWNER_NOTIFICATION_RECIPIENT,
    subject,
    text,
    idempotencyKey: reservation.delivery.id,
    fetchImpl
  });
  const status = adapterResult.sent === true ? 'sent'
    : adapterResult.reason === 'PROVIDER_UNAVAILABLE' ? 'unknown'
      : 'failed';
  const updated = await transitionDelivery(db, reservation.delivery, status, timestamp, adapterResult.providerId);
  if (!updated) return deny('D1_DELIVERY_TRANSITION_FAILED', { deliveryId: reservation.delivery.id });

  return {
    ok: adapterResult.ok === true,
    sent: updated.status === 'sent',
    reserved: false,
    status: updated.status,
    deliveryId: updated.id,
    contentHash: reservation.contentHash,
    ...(adapterResult.provider ? { provider: adapterResult.provider } : {}),
    ...(adapterResult.reason ? { reason: adapterResult.reason } : {})
  };
}

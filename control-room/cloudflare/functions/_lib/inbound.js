const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export const GMAIL_RELAY_MAILBOX = 'renmenu1569@gmail.com';
export const DEFAULT_REPLAY_WINDOW_SECONDS = 300;
export const DEFAULT_MAX_CANONICAL_BYTES = 16 * 1024;
export const DEFAULT_MAX_WEBHOOK_BYTES = 256 * 1024;

const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);

function fail(reason) {
  return { ok: false, reason };
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function getHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  if (!isPlainObject(headers)) return null;
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected && typeof value === 'string') return value;
  }
  return null;
}

function parseUnixSeconds(value) {
  if (typeof value !== 'string' || !/^\d{10}$/.test(value)) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

function bytes(value) {
  if (typeof value === 'string') return encoder.encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('Expected string or bytes');
}

function hexToBytes(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) return null;
  const result = new Uint8Array(32);
  for (let index = 0; index < result.length; index += 1) result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return result;
}

function signatureBytes(value) {
  if (typeof value !== 'string') return null;
  const match = /^(?:sha256|v1)=([a-f0-9]{64})$/i.exec(value.trim());
  return hexToBytes(match ? match[1] : value.trim());
}

export function timingSafeEqual(left, right) {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array)) return false;
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

async function hmacSha256(secret, message) {
  if (typeof secret !== 'string' || secret.length < 16) throw new TypeError('Missing HMAC secret');
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes(message)));
}

function canonicalString(value, state, depth = 0) {
  if (depth > 12) throw new TypeError('Payload nesting exceeds limit');
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Payload has a non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    const quoted = JSON.stringify(value);
    state.bytes += encoder.encode(quoted).byteLength;
    if (state.bytes > state.maxBytes) throw new RangeError('Canonical payload exceeds limit');
    return quoted;
  }
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw new RangeError('Payload array exceeds limit');
    return `[${value.map((item) => canonicalString(item, state, depth + 1)).join(',')}]`;
  }
  if (!isPlainObject(value)) throw new TypeError('Payload contains a non-JSON object');
  const keys = Object.keys(value).sort();
  if (keys.length > 1_000) throw new RangeError('Payload object exceeds limit');
  const fields = keys.map((key) => {
    if (forbiddenKeys.has(key)) throw new TypeError('Payload contains a forbidden key');
    const quotedKey = JSON.stringify(key);
    state.bytes += encoder.encode(quotedKey).byteLength + 1;
    if (state.bytes > state.maxBytes) throw new RangeError('Canonical payload exceeds limit');
    return `${quotedKey}:${canonicalString(value[key], state, depth + 1)}`;
  });
  return `{${fields.join(',')}}`;
}

/** Deterministic JSON for the relay's HMAC protocol; it rejects oversized or exotic input. */
export function canonicalizeGmailRelayPayload(payload, { maxBytes = DEFAULT_MAX_CANONICAL_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 256 || maxBytes > 1024 * 1024) throw new TypeError('Invalid canonical payload limit');
  const canonical = canonicalString(payload, { bytes: 2, maxBytes });
  if (encoder.encode(canonical).byteLength > maxBytes) throw new RangeError('Canonical payload exceeds limit');
  return canonical;
}

/** The timestamp is signed with the canonical body to prevent header substitution. */
export function gmailRelaySigningInput(payload, timestamp, options = {}) {
  const seconds = parseUnixSeconds(String(timestamp));
  if (seconds === null) throw new TypeError('Invalid relay timestamp');
  return encoder.encode(`${seconds}\n${canonicalizeGmailRelayPayload(payload, options)}`);
}

function validInboundId(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}

function eventId(payload) {
  return payload.messageId ?? payload.gmailMessageId ?? payload.id;
}

function markSeen(seenIds, id) {
  if (!seenIds) return true;
  if (typeof seenIds.has !== 'function' || typeof seenIds.add !== 'function') throw new TypeError('seenIds must implement has and add');
  if (seenIds.has(id)) return false;
  seenIds.add(id);
  return true;
}

/**
 * Verifies the custom Gmail Relay contract. Only the dedicated mailbox is accepted;
 * external content is returned explicitly as untrusted data, never as an instruction.
 */
export async function verifyGmailRelayEvent({
  headers,
  payload,
  secret,
  now = Math.floor(Date.now() / 1000),
  replayWindowSeconds = DEFAULT_REPLAY_WINDOW_SECONDS,
  maxFutureSkewSeconds = 60,
  maxCanonicalBytes = DEFAULT_MAX_CANONICAL_BYTES,
  timestampHeader = 'x-gmail-relay-timestamp',
  signatureHeader = 'x-gmail-relay-signature',
  seenIds
} = {}) {
  try {
    if (!isPlainObject(payload)) return fail('MALFORMED_RELAY_PAYLOAD');
    if (payload.mailbox !== GMAIL_RELAY_MAILBOX || (payload.accountEmail !== undefined && payload.accountEmail !== GMAIL_RELAY_MAILBOX)) {
      return fail('MAILBOX_NOT_ALLOWED');
    }
    const id = eventId(payload);
    if (!validInboundId(id)) return fail('MISSING_EVENT_ID');
    const timestamp = parseUnixSeconds(getHeader(headers, timestampHeader));
    if (timestamp === null) return fail('MISSING_OR_INVALID_TIMESTAMP');
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(replayWindowSeconds) || replayWindowSeconds < 1 || !Number.isSafeInteger(maxFutureSkewSeconds) || maxFutureSkewSeconds < 0) {
      return fail('INVALID_REPLAY_CONFIGURATION');
    }
    if (timestamp < now - replayWindowSeconds || timestamp > now + maxFutureSkewSeconds) return fail('STALE_OR_FUTURE_EVENT');
    const supplied = signatureBytes(getHeader(headers, signatureHeader));
    if (!supplied) return fail('MISSING_OR_INVALID_SIGNATURE');
    const expected = await hmacSha256(secret, gmailRelaySigningInput(payload, String(timestamp), { maxBytes: maxCanonicalBytes }));
    if (!timingSafeEqual(expected, supplied)) return fail('INVALID_SIGNATURE');
    if (!markSeen(seenIds, id)) return fail('DUPLICATE_EVENT');
    return {
      ok: true,
      event: {
        channel: 'email',
        provider: 'gmail-relay',
        mailbox: GMAIL_RELAY_MAILBOX,
        id,
        signedAt: timestamp,
        content: { trust: 'untrusted-external-content', payload }
      }
    };
  } catch {
    return fail('INVALID_RELAY_EVENT');
  }
}

/** Validates Meta's X-Hub-Signature-256 against the exact raw request bytes. */
export async function verifyWhatsAppSignature({ headers, rawBody, appSecret } = {}) {
  try {
    const supplied = signatureBytes(getHeader(headers, 'x-hub-signature-256'));
    if (!supplied) return fail('MISSING_OR_INVALID_SIGNATURE');
    const raw = bytes(rawBody);
    if (raw.byteLength > DEFAULT_MAX_WEBHOOK_BYTES) return fail('WEBHOOK_TOO_LARGE');
    const expected = await hmacSha256(appSecret, raw);
    return timingSafeEqual(expected, supplied) ? { ok: true } : fail('INVALID_SIGNATURE');
  } catch {
    return fail('INVALID_WEBHOOK_SIGNATURE');
  }
}

function isWaId(value) {
  return typeof value === 'string' && /^\d{6,20}$/.test(value);
}

function messageText(message) {
  if (message.type !== 'text') return undefined;
  const text = message.text?.body;
  if (typeof text !== 'string' || encoder.encode(text).byteLength > 8 * 1024) return undefined;
  return text;
}

/**
 * Extracts only customer message records (not delivery statuses). The content remains
 * labelled untrusted so callers must map it to a reviewed workflow rather than execute it.
 * `seenIds` must be backed by durable storage in production to survive Worker restarts.
 */
export function parseWhatsAppCustomerMessages(payload, { seenIds } = {}) {
  try {
    if (!isPlainObject(payload) || payload.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry) || payload.entry.length > 1_000) {
      return fail('MALFORMED_WHATSAPP_PAYLOAD');
    }
    const messages = [];
    const duplicates = [];
    for (const entry of payload.entry) {
      if (!isPlainObject(entry) || !Array.isArray(entry.changes) || entry.changes.length > 1_000) return fail('MALFORMED_WHATSAPP_PAYLOAD');
      for (const change of entry.changes) {
        if (!isPlainObject(change) || change.field !== 'messages' || !isPlainObject(change.value)) continue;
        const value = change.value;
        if (value.messages !== undefined && !Array.isArray(value.messages)) return fail('MALFORMED_WHATSAPP_PAYLOAD');
        const contacts = new Map();
        if (value.contacts !== undefined && !Array.isArray(value.contacts)) return fail('MALFORMED_WHATSAPP_PAYLOAD');
        for (const contact of value.contacts ?? []) {
          if (isPlainObject(contact) && isWaId(contact.wa_id)) contacts.set(contact.wa_id, contact);
        }
        for (const message of value.messages ?? []) {
          if (!isPlainObject(message) || !validInboundId(message.id) || !isWaId(message.from) || !contacts.has(message.from)) continue;
          if (!markSeen(seenIds, message.id)) {
            duplicates.push(message.id);
            continue;
          }
          const text = messageText(message);
          messages.push({
            channel: 'whatsapp',
            provider: 'whatsapp-cloud',
            id: message.id,
            waId: message.from,
            messageType: typeof message.type === 'string' && message.type.length <= 64 ? message.type : 'unknown',
            timestamp: typeof message.timestamp === 'string' && /^\d{10}$/.test(message.timestamp) ? Number(message.timestamp) : undefined,
            content: {
              trust: 'untrusted-external-content',
              text,
              raw: message
            }
          });
        }
      }
    }
    return { ok: true, messages, duplicates };
  } catch {
    return fail('MALFORMED_WHATSAPP_PAYLOAD');
  }
}

function queryValue(query, key) {
  if (query instanceof URLSearchParams) return query.get(key);
  if (query instanceof URL) return query.searchParams.get(key);
  if (query instanceof Request) return new URL(query.url).searchParams.get(key);
  if (isPlainObject(query) && typeof query[key] === 'string') return query[key];
  return null;
}

/** Returns the challenge only for Meta's subscribe handshake with a matching secret token. */
export function verifyWhatsAppChallenge({ query, verifyToken } = {}) {
  try {
    const mode = queryValue(query, 'hub.mode');
    const suppliedToken = queryValue(query, 'hub.verify_token');
    const challenge = queryValue(query, 'hub.challenge');
    if (mode !== 'subscribe' || typeof verifyToken !== 'string' || verifyToken.length < 16 || typeof suppliedToken !== 'string' || typeof challenge !== 'string' || challenge.length < 1 || challenge.length > 2_048 || /[\r\n]/.test(challenge)) {
      return fail('INVALID_CHALLENGE');
    }
    if (!timingSafeEqual(encoder.encode(verifyToken), encoder.encode(suppliedToken))) return fail('INVALID_CHALLENGE');
    return { ok: true, challenge };
  } catch {
    return fail('INVALID_CHALLENGE');
  }
}

/** Verify raw bytes first, then parse and extract untrusted customer messages. */
export async function verifyAndParseWhatsAppWebhook({ headers, rawBody, appSecret, seenIds } = {}) {
  const verified = await verifyWhatsAppSignature({ headers, rawBody, appSecret });
  if (!verified.ok) return verified;
  try {
    const raw = bytes(rawBody);
    if (raw.byteLength > DEFAULT_MAX_WEBHOOK_BYTES) return fail('WEBHOOK_TOO_LARGE');
    return parseWhatsAppCustomerMessages(JSON.parse(decoder.decode(raw)), { seenIds });
  } catch {
    return fail('MALFORMED_WHATSAPP_PAYLOAD');
  }
}

/** Reads a bounded Cloudflare Request body before signature verification; it never logs it. */
export async function readBoundedRawBody(request, { maxBytes = DEFAULT_MAX_WEBHOOK_BYTES } = {}) {
  try {
    if (!(request instanceof Request) || !Number.isSafeInteger(maxBytes) || maxBytes < 1) return fail('INVALID_REQUEST');
    const contentLength = request.headers.get('content-length');
    if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)) return fail('WEBHOOK_TOO_LARGE');
    const raw = new Uint8Array(await request.arrayBuffer());
    return raw.byteLength <= maxBytes ? { ok: true, rawBody: raw } : fail('WEBHOOK_TOO_LARGE');
  } catch {
    return fail('UNREADABLE_REQUEST_BODY');
  }
}

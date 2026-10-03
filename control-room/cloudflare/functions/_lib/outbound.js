const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
const MAX_EMAIL_BODY_BYTES = 100 * 1024;
const MAX_WHATSAPP_TEXT_BYTES = 4 * 1024;
const encoder = new TextEncoder();

function deny(reason) {
  return { ok: false, sent: false, reason };
}

function safeString(value, maxBytes) {
  return typeof value === 'string' && value.length > 0 && encoder.encode(value).byteLength <= maxBytes && !/[\u0000\r\n]/.test(value);
}

function validIdempotencyKey(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= MAX_IDEMPOTENCY_KEY_LENGTH && /^[A-Za-z0-9._:/-]+$/.test(value);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function emailAddress(value) {
  if (typeof value !== 'string' || value.length > 320 || /[\r\n]/.test(value)) return null;
  const named = /^(?:[^<>\r\n]{1,128}\s)?<([^<>\s]+)>$/.exec(value.trim());
  const candidate = (named ? named[1] : value.trim()).toLowerCase();
  const match = /^([a-z0-9.!#$%&'*+/=?^_`{|}~-]+)@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/i.exec(candidate);
  return match ? { value: candidate, domain: match[2].toLowerCase() } : null;
}

function stringSet(value) {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((item) => typeof item === 'string').map((item) => item.toLowerCase()));
}

function authorizedAdapter({ config, approval, channel, idempotencyKey, needsApiKey = true }) {
  if (!plainObject(config) || config.enabled !== true) return deny('LIVE_ADAPTER_DISABLED');
  // B/C adapters may run only after an explicit protected-staging configuration.
  if (config.environment !== 'protected-staging' || config.protectedStaging !== true) return deny('STAGING_NOT_PROTECTED');
  if (!validIdempotencyKey(idempotencyKey)) return deny('INVALID_IDEMPOTENCY_KEY');
  if (!plainObject(approval) || approval.approved !== true || approval.channel !== channel || approval.idempotencyKey !== idempotencyKey) {
    return deny('EXPLICIT_APPROVAL_REQUIRED');
  }
  if (needsApiKey && (!safeString(config.apiKey, 2_048))) return deny('MISSING_PROVIDER_KEY');
  return { ok: true };
}

function validatedRecipients(to, config) {
  const values = Array.isArray(to) ? to : [to];
  if (values.length < 1 || values.length > 50) return null;
  const allowedEmails = stringSet(config.allowedRecipientEmails);
  const allowedDomains = stringSet(config.allowedRecipientDomains);
  if (allowedEmails.size === 0 && allowedDomains.size === 0) return null;
  const recipients = values.map(emailAddress);
  if (recipients.some((recipient) => !recipient)) return null;
  if (recipients.some((recipient) => !allowedEmails.has(recipient.value) && !allowedDomains.has(recipient.domain))) return null;
  return recipients.map((recipient) => recipient.value);
}

function validatedSender(from, config) {
  const sender = emailAddress(from);
  const allowedDomains = stringSet(config.allowedSenderDomains);
  return sender && allowedDomains.size > 0 && allowedDomains.has(sender.domain) ? from : null;
}

function providerEndpoint(config) {
  if (config.provider === undefined || config.provider === 'resend') return { name: 'resend', endpoint: 'https://api.resend.com/emails' };
  if (!plainObject(config.provider) || typeof config.provider.endpoint !== 'string') return null;
  try {
    const endpoint = new URL(config.provider.endpoint);
    const allowlist = stringSet(config.allowedProviderHosts);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash || allowlist.size === 0 || !allowlist.has(endpoint.hostname.toLowerCase())) return null;
    return { name: typeof config.provider.name === 'string' ? config.provider.name.slice(0, 64) : 'configured', endpoint: endpoint.toString() };
  } catch {
    return null;
  }
}

async function responseId(response) {
  try {
    const body = await response.clone().json();
    return typeof body?.id === 'string' ? body.id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Sends through Resend by default, or a Resend-compatible HTTPS provider explicitly
 * allowlisted in configuration. No call is made until the protected-staging gate and
 * a matching approval payload pass. The supplied idempotency key is forwarded to Resend.
 */
export async function sendEmail({ config, approval, from, to, subject, text, html, idempotencyKey, fetchImpl = globalThis.fetch } = {}) {
  const gate = authorizedAdapter({ config, approval, channel: 'email', idempotencyKey });
  if (!gate.ok) return gate;
  const sender = validatedSender(from, config);
  const recipients = validatedRecipients(to, config);
  if (!sender || !recipients) return deny('ADDRESS_NOT_ALLOWLISTED');
  if (!safeString(subject, 998)) return deny('INVALID_SUBJECT');
  if (text !== undefined && (typeof text !== 'string' || encoder.encode(text).byteLength > MAX_EMAIL_BODY_BYTES)) return deny('INVALID_TEXT_BODY');
  if (html !== undefined && (typeof html !== 'string' || encoder.encode(html).byteLength > MAX_EMAIL_BODY_BYTES)) return deny('INVALID_HTML_BODY');
  if (text === undefined && html === undefined) return deny('MISSING_MESSAGE_BODY');
  const provider = providerEndpoint(config);
  if (!provider) return deny('INVALID_PROVIDER_CONFIGURATION');
  if (typeof fetchImpl !== 'function') return deny('MISSING_FETCH');

  try {
    const response = await fetchImpl(provider.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify({ from: sender, to: recipients, subject, ...(text === undefined ? {} : { text }), ...(html === undefined ? {} : { html }) })
    });
    if (!response || !response.ok) return deny('PROVIDER_REJECTED');
    return { ok: true, sent: true, provider: provider.name, idempotencyKey, providerId: await responseId(response) };
  } catch {
    return deny('PROVIDER_UNAVAILABLE');
  }
}

function phone(value) {
  return typeof value === 'string' && /^\+[1-9]\d{7,14}$/.test(value) ? value : null;
}

function approvedWhatsAppWindow(approval, now) {
  if (approval.customerServiceWindow !== true || !Number.isSafeInteger(approval.lastCustomerMessageAt)) return false;
  return approval.lastCustomerMessageAt <= now && now - approval.lastCustomerMessageAt <= 24 * 60 * 60;
}

async function claimOnce(idempotencyStore, idempotencyKey) {
  if (!idempotencyStore || typeof idempotencyStore.claim !== 'function') return false;
  try {
    return await idempotencyStore.claim(idempotencyKey) === true;
  } catch {
    return false;
  }
}

/**
 * Optional WhatsApp Cloud API text sender. It requires a durable injected idempotency
 * claim, an allowlisted E.164 recipient, and a documented open 24-hour service window.
 * Meta's accepted response is not proof of delivery; statuses must be handled separately.
 */
export async function sendWhatsAppText({ config, approval, to, body, idempotencyKey, idempotencyStore, now = Math.floor(Date.now() / 1000), fetchImpl = globalThis.fetch } = {}) {
  const gate = authorizedAdapter({ config, approval, channel: 'whatsapp', idempotencyKey });
  if (!gate.ok) return gate;
  const recipient = phone(to);
  const allowlist = new Set((Array.isArray(config.allowedWhatsAppRecipients) ? config.allowedWhatsAppRecipients : []).filter(phone));
  if (!recipient || !allowlist.has(recipient)) return deny('RECIPIENT_NOT_ALLOWLISTED');
  if (!safeString(body, MAX_WHATSAPP_TEXT_BYTES)) return deny('INVALID_WHATSAPP_BODY');
  if (!approvedWhatsAppWindow(approval, now)) return deny('CUSTOMER_SERVICE_WINDOW_REQUIRED');
  if (typeof config.phoneNumberId !== 'string' || !/^\d{5,32}$/.test(config.phoneNumberId)) return deny('INVALID_PHONE_NUMBER_ID');
  const graphVersion = typeof config.graphVersion === 'string' ? config.graphVersion : 'v26.0';
  if (!/^v\d+\.\d+$/.test(graphVersion)) return deny('INVALID_GRAPH_VERSION');
  if (typeof fetchImpl !== 'function') return deny('MISSING_FETCH');
  if (!await claimOnce(idempotencyStore, idempotencyKey)) return deny('DUPLICATE_OR_MISSING_IDEMPOTENCY_CLAIM');

  try {
    const response = await fetchImpl(`https://graph.facebook.com/${graphVersion}/${config.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: recipient, type: 'text', text: { preview_url: false, body } })
    });
    if (!response || !response.ok) return deny('PROVIDER_REJECTED');
    return { ok: true, sent: true, provider: 'whatsapp-cloud', idempotencyKey, providerId: await responseId(response) };
  } catch {
    return deny('PROVIDER_UNAVAILABLE');
  }
}

/** SMS is deliberately unavailable until a separately reviewed adapter is supplied. */
export async function sendSms({ config, approval, idempotencyKey } = {}) {
  const gate = authorizedAdapter({ config, approval, channel: 'sms', idempotencyKey });
  return gate.ok ? deny('SMS_NOT_IMPLEMENTED_FAIL_CLOSED') : gate;
}

/** Telephone calls are deliberately unavailable until a separately reviewed adapter is supplied. */
export async function placeCall({ config, approval, idempotencyKey } = {}) {
  const gate = authorizedAdapter({ config, approval, channel: 'call', idempotencyKey });
  return gate.ok ? deny('CALL_NOT_IMPLEMENTED_FAIL_CLOSED') : gate;
}

function parseClock(value) {
  if (typeof value !== 'string') return null;
  const match = /^(?:[01]\d|2[0-3]):[0-5]\d$/.exec(value);
  return match ? Number(match[0].slice(0, 2)) * 60 + Number(match[0].slice(3, 5)) : null;
}

/** Evaluates local quiet hours with IANA timezone rules; invalid configuration is quiet by default. */
export function quietHoursStatus({ at = Date.now(), start = '21:00', end = '08:00', timeZone = 'Europe/Rome' } = {}) {
  try {
    const startMinutes = parseClock(start);
    const endMinutes = parseClock(end);
    const date = at instanceof Date ? at : new Date(at);
    if (startMinutes === null || endMinutes === null || Number.isNaN(date.getTime())) return { quiet: true, reason: 'INVALID_QUIET_HOURS_CONFIGURATION' };
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return { quiet: true, reason: 'INVALID_QUIET_HOURS_CONFIGURATION' };
    const current = hour * 60 + minute;
    const quiet = startMinutes === endMinutes ? true : startMinutes < endMinutes
      ? current >= startMinutes && current < endMinutes
      : current >= startMinutes || current < endMinutes;
    return { quiet, localTime: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`, timeZone };
  } catch {
    return { quiet: true, reason: 'INVALID_QUIET_HOURS_CONFIGURATION' };
  }
}

export function isQuietHours(options) {
  return quietHoursStatus(options).quiet;
}

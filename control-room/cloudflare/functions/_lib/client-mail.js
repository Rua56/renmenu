// Email ai locali spedite direttamente da Jarvis, dal dominio renmenu.com (via Resend).
// Prima le spediva l'automazione Gmail di renmenu1569 leggendo la coda `jarvis_outbox`;
// ora, se CLIENT_MAIL_FROM è impostato, Jarvis spedisce da solo le righe della coda.
// Variabili: CLIENT_MAIL_FROM («RenMenu <menu@renmenu.com>»), RESEND_API_KEY, EMAIL_LIVE_ENABLED=true,
// CLIENT_MAIL_BCC facoltativo (copia nascosta di ogni invio, per l'archivio di Riccardo).
// Le risposte dei locali arrivano a menu@renmenu.com, cioè di nuovo a Jarvis.
export const CLIENT_MAIL_DOMAIN = 'renmenu.com';
const RESEND = 'https://api.resend.com/emails';
const MAX_ATTACHMENT_BYTES = 8_000_000;

function address(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 320 || /[\r\n\u0000]/.test(raw)) return null;
  const named = /^(?:([^<>]{1,80})\s)?<([^<>\s]+)>$/.exec(raw);
  const email = (named ? named[2] : raw).toLowerCase();
  const match = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/.exec(email);
  return match ? { raw, email, domain: match[1] } : null;
}

/** La configurazione dell'invio diretto, o il motivo per cui non è attivo (allora resta il ponte Gmail). */
export function clientMailConfig(env = {}) {
  if (!env.CLIENT_MAIL_FROM) return { ok: false, reason: 'CLIENT_MAIL_OFF' };
  if (env.EMAIL_LIVE_ENABLED !== 'true') return { ok: false, reason: 'EMAIL_LIVE_DISABLED' };
  const from = address(env.CLIENT_MAIL_FROM);
  if (!from || from.domain !== CLIENT_MAIL_DOMAIN) return { ok: false, reason: 'INVALID_CLIENT_MAIL_FROM' };
  if (typeof env.RESEND_API_KEY !== 'string' || env.RESEND_API_KEY.length < 8) return { ok: false, reason: 'MISSING_RESEND_API_KEY' };
  const bcc = env.CLIENT_MAIL_BCC ? address(env.CLIENT_MAIL_BCC) : null;
  return { ok: true, from: from.raw, sender: from.email, apiKey: env.RESEND_API_KEY, bcc: bcc?.email || null };
}

/**
 * Spedisce una email a un solo locale. attachments: [{ filename, content (base64) }].
 * Restituisce { ok, id } oppure { ok:false, reason, retryable }: retryable vuol dire che la stessa
 * richiesta (stessa chiave) si può ripetere senza rischiare un doppio invio.
 */
export async function sendClientMail({ env, to, subject, text, attachments = [], idempotencyKey, fetchImpl }) {
  const config = clientMailConfig(env);
  if (!config.ok) return { ok: false, reason: config.reason, retryable: false };
  const recipient = address(to);
  if (!recipient) return { ok: false, reason: 'INVALID_RECIPIENT', retryable: false };
  if (recipient.domain === CLIENT_MAIL_DOMAIN) return { ok: false, reason: 'OWN_DOMAIN_RECIPIENT', retryable: false };
  if (!subject || /[\r\n]/.test(subject) || subject.length > 900) return { ok: false, reason: 'INVALID_SUBJECT', retryable: false };
  if (!text) return { ok: false, reason: 'EMPTY_BODY', retryable: false };
  const files = attachments.filter((a) => a?.filename && a?.content);
  if (files.reduce((t, a) => t + a.content.length, 0) > MAX_ATTACHMENT_BYTES) return { ok: false, reason: 'ATTACHMENTS_TOO_LARGE', retryable: false };
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'MISSING_FETCH', retryable: false };
  let response;
  try {
    response = await fetchImpl(RESEND, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({
        from: config.from, to: [recipient.email], ...(config.bcc && config.bcc !== recipient.email ? { bcc: [config.bcc] } : {}),
        subject, text, ...(files.length ? { attachments: files.map((a) => ({ filename: a.filename, content: a.content })) } : {})
      })
    });
  } catch { return { ok: false, reason: 'PROVIDER_UNAVAILABLE', retryable: true }; }
  let body = null; try { body = await response.json(); } catch { body = null; }
  if (response.ok && typeof body?.id === 'string') return { ok: true, id: body.id };
  // 429 e 5xx: si riprova con la stessa chiave; il resto è un rifiuto (indirizzo, dominio non verificato…).
  const retryable = response.status === 429 || response.status >= 500;
  const detail = String(body?.message || body?.name || '').replace(/\s+/g, ' ').slice(0, 80);
  return { ok: false, reason: `RESEND_${response.status}${detail ? ` ${detail}` : ''}`, retryable };
}

import {
  forbidden,
  gmailRecordFromPayload,
  gmailWebhookConfiguration,
  hidden,
  hookJson,
  persistIgnoredExternalEvent,
  persistIncomingExternalEvent,
  verifyGmailWebhookRequest
} from '../_lib/webhooks.js';

/** Cloudflare Pages Function for POST /hooks/gmail.  It makes no outbound calls. */
export async function onRequest(context) {
  if (context.request.method !== 'POST') return hidden();
  const config = gmailWebhookConfiguration(context.env);
  if (!config.enabled) return hidden();
  if (!config.configured) return forbidden();

  const verified = await verifyGmailWebhookRequest(context.request, config.secret);
  if (!verified.ok) return forbidden();

  try {
    // `relevant` is signed relay metadata only.  It gates admission, never an action.
    if (verified.payload.relevant !== true) {
      const outcome = await persistIgnoredExternalEvent(context.env.DB, {
        source: 'gmail', sourceEventId: verified.payload.messageId, reason: 'not_relevant'
      });
      return hookJson({ ok: true, ignored: true, deduplicated: outcome.deduplicated });
    }
    const outcome = await persistIncomingExternalEvent(context.env.DB, gmailRecordFromPayload(verified.payload));
    return hookJson({ ok: true, accepted: true, deduplicated: outcome.deduplicated });
  } catch {
    // Never include inbound content, signatures, or secret material in a response or log.
    return new Response(null, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}

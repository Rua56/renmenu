import {
  forbidden,
  hidden,
  hookJson,
  verifyWhatsAppChallenge,
  verifyWhatsAppWebhookRequest,
  whatsappWebhookConfiguration
} from '../_lib/webhooks.js';
import { importWhatsAppMessage } from '../_lib/whatsapp-in.js';

/**
 * Cloudflare Pages Function for GET/POST /hooks/whatsapp. The only outbound calls are to Meta,
 * to download photos and PDFs the venue sent (with WHATSAPP_TOKEN). Jarvis announces new
 * messages on Telegram from its clock tick (announceExternal).
 */
export async function onRequest(context) {
  const config = whatsappWebhookConfiguration(context.env);
  if (!config.enabled) return hidden();

  if (context.request.method === 'GET') {
    // A challenge is exposed only after every required secret has been configured.
    if (!config.configured) return hidden();
    const verified = verifyWhatsAppChallenge({ query: context.request, verifyToken: config.verifyToken });
    return verified.ok
      ? new Response(verified.challenge, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })
      : forbidden();
  }

  if (context.request.method !== 'POST') return hidden();
  if (!config.configured) return forbidden();
  const parsed = await verifyWhatsAppWebhookRequest(context.request, config.appSecret);
  if (!parsed.ok) return forbidden();

  try {
    let accepted = 0;
    let deduplicated = 0;
    for (const message of parsed.messages) {
      const outcome = await importWhatsAppMessage(context.env.DB, context.env, message);
      if (outcome.kind === 'duplicate') deduplicated += 1;
      else accepted += 1;
    }
    return hookJson({ ok: true, accepted, deduplicated });
  } catch {
    // Never include raw Meta payloads, message text, signatures, or secrets in logs/responses.
    return new Response(null, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}

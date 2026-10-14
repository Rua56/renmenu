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
 * Cloudflare Pages Function for GET/POST /hooks/whatsapp. The only outbound calls are to Meta
 * (or Dualhook, with WHATSAPP_INBOUND_VIA=dualhook), to download photos and PDFs the venue sent
 * (with WHATSAPP_TOKEN). Unknown numbers wait for Riccardo when WHATSAPP_PRIVATE_FILTER=true. Jarvis announces new
 * messages on Telegram from its clock tick (announceExternal).
 */
export async function onRequest(context) {
  const config = whatsappWebhookConfiguration(context.env);
  if (!config.enabled) return hidden();

  if (context.request.method === 'GET') {
    // A challenge is exposed only after every required secret has been configured.
    if (!config.challengeReady) return hidden();
    const verified = verifyWhatsAppChallenge({ query: context.request, verifyToken: config.verifyToken });
    return verified.ok
      ? new Response(verified.challenge, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })
      : forbidden();
  }

  if (context.request.method !== 'POST') return hidden();
  const peek = context.request.clone();
  if (!config.configured) { await traceDelivery(context.env.DB, peek, 'NOT_CONFIGURED'); return forbidden(); }
  const parsed = await verifyWhatsAppWebhookRequest(context.request, config);
  if (!parsed.ok) { await traceDelivery(context.env.DB, peek, parsed.reason || 'REJECTED'); return forbidden(); }
  await traceDelivery(context.env.DB, peek, `OK ${parsed.messages.length}`);

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

// Traccia dell'ultima consegna (solo esito e metadati, mai testo né chiavi): serve a capire
// perché un messaggio non arriva. Si legge in jarvis_settings.wa_hook_last.
async function traceDelivery(db, request, outcome) {
  try {
    const url = new URL(request.url);
    let entries = [], fields = [];
    try {
      const body = JSON.parse(await request.text());
      entries = (body?.entry || []).slice(0, 5).map((e) => String(e?.id || '').slice(0, 30));
      fields = [...new Set((body?.entry || []).flatMap((e) => (e?.changes || []).map((c) => String(c?.field || '').slice(0, 40))))].slice(0, 10);
    } catch {}
    const trace = { at: new Date().toISOString(), outcome: String(outcome).slice(0, 60), path: url.pathname.slice(0, 60), hasKey: url.searchParams.has('k'), signed: request.headers.has('x-hub-signature-256'), entries, fields };
    await db.prepare('INSERT INTO jarvis_settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
      .bind('wa_hook_last', JSON.stringify(trace), trace.at).run();
  } catch {}
}

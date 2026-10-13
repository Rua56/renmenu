// Chiamata a Claude (Messages API) senza dipendenze npm, per le Functions di Cloudflare.
// Usata dalla riflessione del lunedì, dalla comprensione dei comandi e dalla conversazione.
// Senza chiave ANTHROPIC_API_KEY restituisce { error } e chi chiama usa i modelli di riserva.
const API = 'https://api.anthropic.com/v1/messages';
export const CLAUDE_MODEL = 'claude-opus-5-5';

export const claudeKey = (env) => String(env?.ANTHROPIC_API_KEY || '').trim();

/**
 * Restituisce { text, json, model } oppure { error }.
 * schema: se presente la risposta è un oggetto JSON con quella forma (json).
 */
export async function askClaude(env, { system, messages, schema = null, effort = 'high', maxTokens = 16000, model = CLAUDE_MODEL },
  { fetchImpl = globalThis.fetch, timeoutMs = 60_000 } = {}) {
  const key = claudeKey(env);
  if (!key) return { error: 'manca la chiave ANTHROPIC_API_KEY' };
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const send = (withFallback) => fetchImpl(API, {
    method: 'POST', signal: controller?.signal,
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', ...(withFallback ? { 'anthropic-beta': 'server-side-fallback-2026-07-01' } : {}) },
    body: JSON.stringify({
      model, max_tokens: maxTokens, ...(withFallback ? { fallbacks: 'default' } : {}), system,
      output_config: { effort, ...(schema ? { format: { type: 'json_schema', schema } } : {}) },
      messages
    })
  });
  try {
    let response = await send(true);
    let payload = await response.json().catch(() => null);
    // Il fallback lato server non è disponibile per ogni chiave o account: senza, la richiesta resta valida.
    if (response.status === 400) {
      const retry = await send(false);
      const retryPayload = await retry.json().catch(() => null);
      if (retry.ok || retry.status !== 400) { response = retry; payload = retryPayload; }
    }
    if (/credit balance/i.test(String(payload?.error?.message || ''))) return { error: 'l’account Anthropic non ha credito: va caricato in console.anthropic.com, sezione Billing (Plans & Billing)' };
    if (!response.ok) return { error: `Claude ha risposto ${response.status}${payload?.error?.type ? ` (${payload.error.type}${payload.error.message ? `: ${String(payload.error.message).slice(0, 160)}` : ''})` : ''}` };
    if (payload?.stop_reason === 'refusal') return { error: 'Claude ha rifiutato la richiesta' };
    if (payload?.stop_reason === 'max_tokens') return { error: 'risposta di Claude troncata' };
    const text = (payload?.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('').trim();
    if (!text) return { error: 'risposta di Claude vuota' };
    let json = null;
    if (schema) { try { json = JSON.parse(text); } catch { return { error: 'risposta di Claude non leggibile' }; } }
    return { text, json, model: payload.model || model };
  } catch (error) {
    return { error: error?.name === 'AbortError' ? 'Claude non ha risposto in tempo' : 'Claude non raggiungibile' };
  } finally { if (timer) clearTimeout(timer); }
}

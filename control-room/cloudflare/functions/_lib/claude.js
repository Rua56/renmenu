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
  try {
    const response = await fetchImpl(API, {
      method: 'POST', signal: controller?.signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'server-side-fallback-2026-07-01' },
      body: JSON.stringify({
        model, max_tokens: maxTokens, fallbacks: 'default', system,
        output_config: { effort, ...(schema ? { format: { type: 'json_schema', schema } } : {}) },
        messages
      })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) return { error: `Claude ha risposto ${response.status}${payload?.error?.type ? ` (${payload.error.type})` : ''}` };
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

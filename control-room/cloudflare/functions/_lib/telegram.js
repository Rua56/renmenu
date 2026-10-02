// Canale Telegram di Jarvis: un solo destinatario (Riccardo), collegato con un codice monouso
// generato dalla Control Room. Il token del bot vive solo nel segreto TELEGRAM_BOT_TOKEN.
const API = 'https://api.telegram.org';
export const TELEGRAM_HOOK_URL = 'https://renmenu-jarvis-stage.pages.dev/jarvis-hook/telegram';

export const telegramReady = (env) => /^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(String(env?.TELEGRAM_BOT_TOKEN || '').trim());

async function call(env, method, body, fetchImpl = globalThis.fetch) {
  if (!telegramReady(env)) return { ok: false, description: 'TELEGRAM_NOT_CONFIGURED' };
  try {
    const response = await fetchImpl(`${API}/bot${String(env.TELEGRAM_BOT_TOKEN).trim()}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    return data && typeof data === 'object' ? data : { ok: false };
  } catch { return { ok: false, description: 'TELEGRAM_UNREACHABLE' }; }
}

// Testo semplice (niente HTML/Markdown): nessun rischio di formattazione rotta dai nomi dei locali.
export function sendTelegram(env, chatId, text, buttons = null, fetchImpl) {
  const body = { chat_id: chatId, text: String(text).slice(0, 3900), disable_web_page_preview: true };
  if (buttons?.length) body.reply_markup = { inline_keyboard: [buttons.map(([label, data]) => ({ text: label, callback_data: String(data).slice(0, 64) }))] };
  return call(env, 'sendMessage', body, fetchImpl);
}
export const answerCallback = (env, id, text, fetchImpl) => call(env, 'answerCallbackQuery', { callback_query_id: id, text: String(text || '').slice(0, 190) }, fetchImpl);
export const clearButtons = (env, chatId, messageId, fetchImpl) => call(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }, fetchImpl);
export const getMe = (env, fetchImpl) => call(env, 'getMe', {}, fetchImpl);
export const setWebhook = (env, secret, fetchImpl) => call(env, 'setWebhook', {
  url: TELEGRAM_HOOK_URL, secret_token: secret, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true
}, fetchImpl);

export function randomToken(bytes = 24) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
// Confronto a tempo costante per i segreti del webhook e dell'orologio.
export function sameSecret(a, b) {
  const x = String(a || ''), y = String(b || '');
  if (!x || !y || x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

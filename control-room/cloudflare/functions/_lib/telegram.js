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
export function sendTelegram(env, chatId, text, buttons = null, fetchImpl, options = {}) {
  const body = { chat_id: chatId, text: String(text).slice(0, 3900), disable_web_page_preview: true };
  // silent: arriva senza suono (avvisi normali di notte).
  if (options.silent) body.disable_notification = true;
  const button = ([label, data]) => ({ text: String(label).slice(0, 60), callback_data: String(data).slice(0, 64) });
  // stacked: un pulsante per riga (elenchi di pratiche); altrimenti tutti sulla stessa riga.
  // columns: N pulsanti per riga (il menu dei comandi).
  const rows = options.columns ? buttons?.reduce((out, b, i) => (i % options.columns ? out.at(-1).push(button(b)) : out.push([button(b)]), out), []) : null;
  if (buttons?.length) body.reply_markup = { inline_keyboard: rows || (options.stacked ? buttons.map((b) => [button(b)]) : [buttons.map(button)]) };
  return call(env, 'sendMessage', body, fetchImpl);
}
export const answerCallback = (env, id, text, fetchImpl) => call(env, 'answerCallbackQuery', { callback_query_id: id, text: String(text || '').slice(0, 190) }, fetchImpl);
export const clearButtons = (env, chatId, messageId, fetchImpl) => call(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }, fetchImpl);
// Comandi di Jarvis: il menu «/» accanto al campo di scrittura di Telegram e i pulsanti di /menu.
// [comando, descrizione nel menu «/», etichetta del pulsante]. Cambiando l'elenco, cambia COMMANDS_VERSION.
export const COMMANDS = [
  ['menu', 'Tutti i comandi come pulsanti', '☰ Comandi'],
  ['stato', 'La situazione adesso', '📋 Situazione'],
  ['idee', 'Cosa ti propongo di fare', '💡 Proposte di oggi'],
  ['briefing', 'Il riepilogo del mattino, adesso', '☀️ Briefing'],
  ['settimana', 'Com’è andata la settimana', '📅 Settimana'],
  ['risposte', 'Risposte pronte ai clienti (sì/no)', '✉️ Risposte ai clienti'],
  ['voce', 'Avvisi a voce', '🔊 Avvisi a voce'],
  ['chiamami', 'Jarvis ti telefona adesso', '📞 Chiamami'],
  ['claude', 'Claude acceso o spento', '🧠 Claude sì/no'],
  ['proposte', 'Proposte del lunedì', '🗂 Proposte del lunedì'],
  ['rifletti', 'Rifletti sulla settimana adesso', '🔁 Rifletti ora'],
  ['provalettura', 'Prova di lettura dei menu', '🔬 Prova lettura'],
  ['provaemail', 'Email di prova da renmenu.com', '📧 Email di prova']
];
export const COMMANDS_VERSION = '1';
export const setMyCommands = (env, fetchImpl) => call(env, 'setMyCommands', { commands: COMMANDS.map(([command, description]) => ({ command, description })) }, fetchImpl);
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

// File mandati da Riccardo al bot (foto dei menu): massimo 20 MB per le API dei bot, qui 10 MB.
export async function downloadTelegramFile(env, fileId, fetchImpl = globalThis.fetch) {
  const info = await call(env, 'getFile', { file_id: fileId }, fetchImpl);
  const path = info?.result?.file_path;
  if (!info?.ok || !path || Number(info.result.file_size || 0) > 10_000_000) return null;
  try {
    const response = await fetchImpl(`${API}/file/bot${String(env.TELEGRAM_BOT_TOKEN).trim()}/${path}`);
    if (!response.ok) return null;
    return { bytes: new Uint8Array(await response.arrayBuffer()), path };
  } catch { return null; }
}

// Vocale di Jarvis (MP3): Telegram lo mostra come messaggio vocale.
export async function sendVoice(env, chatId, bytes, caption = '', fetchImpl = globalThis.fetch) {
  if (!telegramReady(env) || !bytes?.length) return { ok: false };
  try {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('voice', new Blob([bytes], { type: 'audio/mpeg' }), 'jarvis.mp3');
    if (caption) form.append('caption', String(caption).slice(0, 1000));
    const response = await fetchImpl(`${API}/bot${String(env.TELEGRAM_BOT_TOKEN).trim()}/sendVoice`, { method: 'POST', body: form });
    return await response.json().catch(() => ({ ok: false }));
  } catch { return { ok: false }; }
}

// Immagine (anteprima nella chat) e file (qualità piena, per stampare): usati per il QR del menu.
async function upload(env, method, field, chatId, bytes, filename, mime, caption, fetchImpl = globalThis.fetch) {
  if (!telegramReady(env) || !bytes?.length) return { ok: false };
  try {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append(field, new Blob([typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes], { type: mime }), filename);
    if (caption) form.append('caption', String(caption).slice(0, 1000));
    const response = await fetchImpl(`${API}/bot${String(env.TELEGRAM_BOT_TOKEN).trim()}/${method}`, { method: 'POST', body: form });
    return await response.json().catch(() => ({ ok: false }));
  } catch { return { ok: false }; }
}
export const sendPhoto = (env, chatId, bytes, caption = '', fetchImpl) => upload(env, 'sendPhoto', 'photo', chatId, bytes, 'qr.png', 'image/png', caption, fetchImpl);
export const sendDocument = (env, chatId, bytes, filename, mime, caption = '', fetchImpl) => upload(env, 'sendDocument', 'document', chatId, bytes, filename, mime, caption, fetchImpl);

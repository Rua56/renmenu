// Jarvis sugli occhiali (Ray-Ban Meta Display): web app su Vercel che parla con /jarvis-hook/occhiali.
// La chiave si crea con /occhiali su Telegram e resta valida finché Riccardo non ne crea un'altra o la spegne.
import { qrPng } from './qr.js';
import { spokenText } from './cr-chat.js';

export const GLASSES_APP_URL = 'https://jarvis-meta-display.vercel.app';
export const GLASSES_ORIGIN = new URL(GLASSES_APP_URL).origin;
export const GLASSES_KEY = 'glasses_key';
export const GLASSES_LAST = 'glasses_last';
// Avvisi per le lenti: tutto ciò che Jarvis scrive su Telegram di sua iniziativa o in chat (non quello chiesto dagli occhiali).
export const GLASSES_FEED = 'glasses_feed';
export const FEED_MAX = 15;

/** Link della web app con la chiave: pagina degli occhiali e pagina del telefono (per parlare). */
export const glassesAppLink = (key) => `${GLASSES_APP_URL}/?k=${encodeURIComponent(key)}`;
export const glassesPhoneLink = (key) => `${GLASSES_APP_URL}/telefono/?k=${encodeURIComponent(key)}`;
/** Link di installazione sugli occhiali (da inquadrare con la fotocamera del telefono, app Meta AI in modalità sviluppatore). */
export const glassesInstallLink = (key) => `fb-viewapp://web_app_deep_link?appName=Jarvis&appUrl=${encodeURIComponent(glassesAppLink(key))}`;
export const glassesQr = (key) => qrPng(glassesInstallLink(key));

/** Testo come lo mostrano le lenti: senza link (restano su Telegram) e senza righe vuote doppie. */
export const glassesText = (text) => String(text || '').replace(/https?:\/\/\S+/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

/** Header CORS per la sola origine della web app. */
export function glassesCors(request) {
  const origin = request.headers.get('Origin') || '';
  return origin === GLASSES_ORIGIN
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400', Vary: 'Origin' }
    : { Vary: 'Origin' };
}

const isPublish = (data) => String(data).split(':')[0] === 'pub';
/** Pulsanti che le lenti possono mostrare: mai quelli della pubblicazione (si conferma solo toccando su Telegram). */
export const glassesButtons = (buttons) => (Array.isArray(buttons) ? buttons : []).filter((b) => Array.isArray(b) && b[1] && !isPublish(b[1])).map(([label, data]) => [String(label).slice(0, 80), String(data)]).slice(0, 8);

/** Aggiunge un messaggio di Jarvis agli avvisi per le lenti (gli ultimi FEED_MAX). */
export function addToFeed(feed, { id, at, text, buttons, quiet = false }) {
  const publish = (Array.isArray(buttons) ? buttons : []).some((b) => Array.isArray(b) && isPublish(b[1]));
  const shown = glassesText(text);
  if (!shown) return feed;
  const item = { id, at, text: `${shown}${publish ? '\n\nPer pubblicare tocca il pulsante su Telegram.' : ''}`.slice(0, 1500), say: spokenText(text).slice(0, 320), buttons: glassesButtons(buttons), quiet: Boolean(quiet) };
  return [...(Array.isArray(feed) ? feed : []), item].slice(-FEED_MAX);
}

/** Avvisi arrivati dopo `after` (id dell'ultimo visto, o FEED_EMPTY se non ce n'erano). Senza id si parte
 * dall'ultimo, senza ripetere quelli vecchi. */
export const FEED_EMPTY = 'vuoto';
export function feedAfter(feed, after) {
  const list = Array.isArray(feed) ? feed : [];
  const last = list.at(-1)?.id || FEED_EMPTY;
  if (!after) return { avvisi: [], avvisoId: last };
  if (after === FEED_EMPTY) return { avvisi: list.slice(-3), avvisoId: last };
  const at = list.findIndex((item) => item.id === after);
  return { avvisi: at >= 0 ? list.slice(at + 1) : list.slice(-3), avvisoId: last };
}

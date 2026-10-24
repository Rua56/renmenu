// Jarvis sugli occhiali (Ray-Ban Meta Display): web app su Vercel che parla con /jarvis-hook/occhiali.
// La chiave si crea con /occhiali su Telegram e resta valida finché Riccardo non ne crea un'altra o la spegne.
import { qrPng } from './qr.js';

export const GLASSES_APP_URL = 'https://jarvis-meta-display.vercel.app';
export const GLASSES_ORIGIN = new URL(GLASSES_APP_URL).origin;
export const GLASSES_KEY = 'glasses_key';
export const GLASSES_LAST = 'glasses_last';

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

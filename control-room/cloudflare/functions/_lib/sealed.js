// Chiavi di servizi esterni salvate da Riccardo nella Control Room (es. la voce di Jarvis):
// nel database restano cifrate (AES-GCM) con il segreto SETTINGS_SECRET di Cloudflare, mai in chiaro.
// Senza segreto (test locali) il valore resta com'è; un valore vecchio in chiaro viene cifrato alla prima lettura.
const PREFIX = 'enc:v1:';
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function keyFor(secret) {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(`renmenu-jarvis-settings:${secret}`));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export const isSealed = (stored) => String(stored || '').startsWith(PREFIX);

export async function seal(env, value) {
  const secret = env?.SETTINGS_SECRET;
  if (!value || !secret) return String(value || '');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFor(secret), enc.encode(String(value)));
  return `${PREFIX}${b64(iv)}:${b64(ct)}`;
}

export async function unseal(env, stored) {
  if (!isSealed(stored)) return stored || '';
  const secret = env?.SETTINGS_SECRET;
  if (!secret) return '';
  const [iv, ct] = String(stored).slice(PREFIX.length).split(':');
  try { return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await keyFor(secret), unb64(ct))); }
  catch { return ''; }
}

/** Legge una chiave salvata; se era ancora in chiaro e il segreto c'è, la riscrive cifrata. */
export async function readSealedSetting(env, getSetting, putSetting, db, key) {
  const stored = await getSetting(db, key);
  if (stored && !isSealed(stored) && env?.SETTINGS_SECRET) await putSetting(db, key, await seal(env, stored));
  return unseal(env, stored);
}

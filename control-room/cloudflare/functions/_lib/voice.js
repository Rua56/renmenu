// Comandi vocali di Jarvis (punto 5 della roadmap).
// 1. ascolta: vocale Telegram → testo (Whisper su Workers AI, italiano);
// 2. capisce: un modello sceglie UNA intenzione tra poche consentite; i valori (prezzi, piatti)
//    restano quelli detti da Riccardo, mai riscritti dal modello;
// 3. risponde: testo e, se è configurata una voce, un vocale con tono calmo e caldo.
// Pubblicare o inviare email richiede sempre il pulsante SÌ: la voce non basta mai.
import { CLOUDFLARE_FREE_MODEL } from './ai-live.js';
import { slugify } from './menu.js';

export const STT_MODEL = '@cf/openai/whisper-large-v3-turbo';
export const INTENTS = new Set(['risposta', 'aggiorna_menu', 'pubblica', 'non_chiaro']);
export const VOICE_PRESETS = {
  // ElevenLabs, modello multilingue: voci maschili calme e calde (la prima è la predefinita).
  elevenlabs: [['JBFqnCBsd6RMkjVDRZzb', 'George · caldo, calmo, accento britannico (stile Jarvis)'], ['onwK4e9ZLuTAKqWW03F9', 'Daniel · profondo e autorevole'], ['nPczCjzI2devNBz1zQrb', 'Brian · profondo e rassicurante']],
  openai: [['onyx', 'Onyx · profonda e calma'], ['ash', 'Ash · calda e pacata'], ['echo', 'Echo · chiara e misurata']]
};
const STYLE = 'Parla in italiano con voce maschile calma, calda e cortese, ritmo pacato, come un assistente maggiordomo britannico elegante e rassicurante (stile J.A.R.V.I.S.).';

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
const withTimeout = (promise, ms) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('tempo scaduto')), ms); })]).finally(() => clearTimeout(timer));
};

/** Vocale (OGG/Opus di Telegram, MP3, M4A) → testo italiano. */
export async function transcribe(ai, bytes, { timeoutMs = 30_000 } = {}) {
  if (typeof ai?.run !== 'function') return { ok: false, reason: 'trascrizione non disponibile' };
  if (!bytes?.length || bytes.length > 20_000_000) return { ok: false, reason: 'vocale vuoto o troppo lungo' };
  try {
    const out = await withTimeout(Promise.resolve().then(() => ai.run(STT_MODEL, { audio: toBase64(bytes), language: 'it', vad_filter: true,
      initial_prompt: 'Comandi per Jarvis, assistente di RenMenu: menu, locali, prezzi in euro, piatti, pubblica, anteprima, briefing.' })), timeoutMs);
    const text = String(out?.text || '').replace(/\s+/g, ' ').trim();
    return text.length >= 2 ? { ok: true, text } : { ok: false, reason: 'non ho sentito parole chiare' };
  } catch (error) { return { ok: false, reason: `trascrizione non riuscita (${String(error?.message || 'errore').slice(0, 60)})` }; }
}

function parseJson(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

/** Capisce il comando. `context` = testo del briefing + elenco dei locali (fonte unica per le risposte). */
export async function understand(ai, utterance, context, { timeoutMs = 25_000 } = {}) {
  const fallback = { intent: 'non_chiaro', locale: '', risposta: '' };
  if (typeof ai?.run !== 'function') return fallback;
  const system = [
    'Sei Jarvis, l’assistente personale di Riccardo per RenMenu (menu digitali QR per locali). Tono calmo, caldo, cortese, conciso.',
    'Ricevi un comando di Riccardo (trascritto da un vocale, può contenere piccoli errori) e i DATI attuali della Control Room.',
    'Rispondi SOLO con un oggetto JSON: {"intent": "...", "locale": "...", "risposta": "..."}.',
    'intent può essere solo:',
    '- "risposta": domanda o richiesta di informazioni (situazione, pratiche, locali, scadenze, cosa fare). In "risposta" scrivi 1-3 frasi in italiano parlato, usando SOLO i DATI; se un dato non c’è dillo. Niente elenchi puntati, niente emoji.',
    '- "aggiorna_menu": Riccardo chiede di cambiare il menu online di un locale (prezzi, piatti da aggiungere o togliere). In "locale" il nome del locale così come detto. Non riscrivere le modifiche.',
    '- "pubblica": chiede di pubblicare o mettere online un menu. In "locale" il nome se detto.',
    '- "non_chiaro": non è chiaro cosa vuole. In "risposta" una breve domanda per chiarire.',
    'Non inventare mai prezzi, piatti, allergeni o numeri.'
  ].join('\n');
  try {
    const out = await withTimeout(Promise.resolve().then(() => ai.run(CLOUDFLARE_FREE_MODEL, { messages: [
      { role: 'system', content: system },
      { role: 'user', content: `DATI:\n${String(context || '').slice(0, 6000)}\n\nCOMANDO DI RICCARDO:\n${String(utterance).slice(0, 1500)}` }
    ], temperature: 0.2, max_tokens: 400 })), timeoutMs);
    const parsed = parseJson(out?.response ?? out?.choices?.[0]?.message?.content);
    if (!parsed || !INTENTS.has(parsed.intent)) return fallback;
    return { intent: parsed.intent, locale: String(parsed.locale || '').slice(0, 120), risposta: String(parsed.risposta || '').replace(/[*#•]/g, '').slice(0, 700) };
  } catch { return fallback; }
}

/** Locale citato a voce → cliente con menu online. Una sola corrispondenza, altrimenti nessuna. */
export function matchVenue(spoken, clients) {
  const key = slugify(spoken).replace(/^(?:(?:al|all|allo|alla|il|lo|la|l|da|dal|dalla|del|della|dell|per|menu|di)-)+/, '');
  if (key.length < 3) return { client: null, candidates: [] };
  const words = key.split('-').filter((w) => w.length > 2);
  const score = (client) => {
    const hay = `${slugify(client.name)}-${slugify(client.menu_id)}`;
    if (hay.includes(key)) return 2;
    return words.length && words.every((w) => hay.includes(w)) ? 1 : 0;
  };
  const ranked = clients.map((client) => ({ client, s: score(client) })).filter((r) => r.s > 0).sort((a, b) => b.s - a.s);
  const best = ranked.filter((r) => r.s === ranked[0]?.s);
  return { client: best.length === 1 ? best[0].client : null, candidates: best.map((r) => r.client) };
}

/** Testo → audio MP3 con la voce scelta. Restituisce null se la voce non è configurata o fallisce. */
export async function speak(settings, text, fetchImpl = globalThis.fetch, { timeoutMs = 25_000 } = {}) {
  const provider = settings?.provider, key = String(settings?.apiKey || '').trim();
  const say = String(text || '').replace(/https?:\/\/\S+/g, '').replace(/[*#•_]/g, '').replace(/\s+/g, ' ').trim().slice(0, 900);
  if (!key || !say) return null;
  try {
    let response;
    if (provider === 'elevenlabs') {
      const voice = /^[A-Za-z0-9]{10,40}$/.test(settings.voiceId || '') ? settings.voiceId : VOICE_PRESETS.elevenlabs[0][0];
      response = await withTimeout(fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_64`, {
        method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({ text: say, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.6, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true, speed: 0.95 } })
      }), timeoutMs);
    } else if (provider === 'openai') {
      const voice = VOICE_PRESETS.openai.some(([id]) => id === settings.voiceId) ? settings.voiceId : 'onyx';
      response = await withTimeout(fetchImpl('https://api.openai.com/v1/audio/speech', {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice, input: say, instructions: STYLE, response_format: 'mp3' })
      }), timeoutMs);
    } else return null;
    if (!response?.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.length > 500 ? bytes : null;
  } catch { return null; }
}

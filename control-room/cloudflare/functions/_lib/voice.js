// Comandi vocali di Jarvis (punto 5 della roadmap).
// 1. ascolta: vocale Telegram → testo (Whisper su Workers AI, italiano);
// 2. capisce: un modello sceglie UNA intenzione tra poche consentite; i valori (prezzi, piatti)
//    restano quelli detti da Riccardo, mai riscritti dal modello;
// 3. risponde: testo e, se è configurata una voce, un vocale con tono calmo e caldo.
// Pubblicare o inviare email richiede sempre il pulsante SÌ: la voce non basta mai.
import { CLOUDFLARE_FREE_MODEL } from './ai-live.js';
import { slugify } from './menu.js';
import { geminiJson } from './gemini-json.js';

export const STT_MODEL = '@cf/openai/whisper-large-v3-turbo';
export const INTENTS = new Set(['risposta', 'stato', 'anteprima', 'cancella_pratica', 'aggiorna_menu', 'crea_pratica', 'pubblica', 'ricorda', 'non_chiaro']);
export const STATUS_CUTS = new Set(['breve', 'completo', 'buone_notizie']);
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
  if (text && typeof text === 'object') return text; // Workers AI restituisce già l'oggetto con json_schema
  const raw = String(text || '');
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

const SCHEMA = { type: 'object', properties: { intent: { type: 'string', enum: [...INTENTS] }, locale: { type: 'string' }, risposta: { type: 'string' }, dettaglio: { type: 'string', enum: ['', ...STATUS_CUTS] }, urgente: { type: 'boolean' } }, required: ['intent', 'locale', 'risposta'] };

/** Capisce il comando. `context` = testo del briefing + elenco dei locali (fonte unica per le risposte). */
export async function understand(ai, utterance, context, { timeoutMs = 25_000, gemini = null, engine = 'auto' } = {}) {
  const fallback = { intent: 'non_chiaro', locale: '', risposta: '' };
  if (typeof ai?.run !== 'function' && !(gemini && engine !== 'cloudflare')) return fallback;
  const system = [
    'Sei Jarvis, l’assistente personale di Riccardo per RenMenu (menu digitali QR per locali). Tono calmo, caldo, cortese, conciso.',
    'Ricevi un comando di Riccardo e i DATI attuali della Control Room. Riccardo parla liberamente, in modo colloquiale, anche a frasi spezzate; il testo viene da un vocale e può contenere errori di trascrizione (nomi di locali o piatti storpiati). Capisci l’intenzione, non le parole esatte.',
    'Se il comando ha più righe, le prime sono la richiesta precedente e l’ultima è la risposta di Riccardo a una tua domanda di chiarimento: interpretale insieme come un unico comando.',
    'Usa la CONVERSAZIONE RECENTE per capire riferimenti come «quello», «lo stesso», «sì», «anche lì».',
    'Gli INDIZI dicono quali locali e piatti registrati sono stati riconosciuti nel comando: fidati di loro per capire di quale locale si parla, e in "locale" scrivi il nome registrato.',
    'Se nomina un piatto o un prezzo e chiede di cambiare, togliere, aggiungere, mettere o sistemare qualcosa, è "aggiorna_menu" anche senza la parola «menu». Agisci quando il compito è ragionevolmente chiaro; usa "non_chiaro" solo se mancano informazioni indispensabili, e allora fai UNA domanda precisa che proponga l’opzione più probabile.',
    'Rispondi SOLO con un oggetto JSON: {"intent": "...", "locale": "...", "risposta": "..."}.',
    'intent può essere solo:',
    '- "risposta": domanda, saluto, chiacchiera, umore, battuta, richiesta di idee o di stupirlo («stupiscimi», «fammi sorridere», «mi sento creativo»), opinione o informazioni su qualsiasi argomento, anche non legato a RenMenu (locali, scadenze, cosa fare). In "risposta" scrivi 1-3 frasi in italiano parlato, usando SOLO i DATI; se un dato non c’è dillo. Niente elenchi puntati, niente emoji.',
    '- "stato": Riccardo vuole sapere come vanno le cose: punto della situazione, pratiche, aggiornamento, «tutto a posto?», «come siamo messi?», «ci sono problemi?», «qualcosa da segnalare?», «cosa richiede la mia attenzione?», resoconto, report, novità, «dammi buone notizie». Non scrivere la risposta: la prepara il sistema con i dati certi (lascia "risposta" vuota). In "dettaglio": "breve" per domande rapide (tutto a posto? come siamo messi? aggiornami), "completo" se chiede un resoconto, un report, il dettaglio o tutto, "buone_notizie" se chiede buone notizie, novità positive o qualcosa di bello da sapere.',
    '- "anteprima": chiede di vedere, mostrare o mandargli l’anteprima o la bozza di un menu (solo per guardarla: non è pubblicare né inviare al cliente). In "locale" il nome così come detto.',
    '- "cancella_pratica": chiede di eliminare, cancellare o buttare una pratica o un cliente (di prova o non più utili); NON un piatto o una voce del menu (quello è aggiorna_menu). In "locale" il nome del locale.',
    '- "aggiorna_menu": Riccardo chiede di cambiare il menu online di un locale (prezzi, piatti da aggiungere o togliere, oppure il tema grafico/i colori: bordeaux, verde trattoria, blu mare, terracotta, nero elegante, ocra; oppure coperto, telefono, orari, Instagram o Facebook del locale). Capisci anche parole scritte o trascritte male (es. «copreto», «telfono», «instgram»). In "locale" il nome del locale così come detto. Non riscrivere le modifiche.',
    '- "crea_pratica": chiede di aprire una nuova pratica o un nuovo cliente per un locale (anche «crea un nuovo menu per …», «mi serve un menu per …»; se c’è fretta o urgenza, «in fretta», «subito», «urgente», metti "urgente": true). In "locale" il nome del locale esattamente come detto, senza parole come «locale» o «ristorante» se non fanno parte del nome.',
    '- "pubblica": chiede di pubblicare o mettere online un menu. In "locale" il nome se detto.',
    '- "ricorda": chiede di ricordare, memorizzare o segnare un’informazione su un locale (orari, chiusure, preferenze, contatti, abitudini). In "locale" il nome del locale.',
    'Se nei DATI c’è una «Memoria» del locale, usala per rispondere (note di Riccardo e ultimo menu online con i prezzi).',
    '- "non_chiaro": manca un’informazione indispensabile. In "risposta" una sola domanda breve e precisa (es. «Intendi il frico di Riccardo sei il migliore?»).',
    'Non inventare mai prezzi, piatti, allergeni o numeri.'
  ].join('\n');
  const userText = `DATI:\n${String(context || '').slice(0, 9000)}\n\nCOMANDO DI RICCARDO:\n${String(utterance).slice(0, 1500)}`;
  const shape = (parsed, engineName) => ({ intent: parsed.intent, locale: String(parsed.locale || '').slice(0, 120), risposta: String(parsed.risposta || '').replace(/[*#•]/g, '').slice(0, 700),
    dettaglio: STATUS_CUTS.has(parsed.dettaglio) ? parsed.dettaglio : '', urgente: parsed.urgente === true, engine: engineName, modelName: parsed.modelName });
  // Gemini per primo (capisce meglio le frasi naturali); se non risponde in tempo, il modello gratuito di Cloudflare.
  let geminiWhy = '';
  if (gemini && engine !== 'cloudflare') {
    const tries = [];
    const out = await geminiJson(gemini, { system, user: userText, validate: (p) => INTENTS.has(p.intent), deadlineMs: 12_000, perModelMs: 7_000, maxOutputTokens: 700 }, tries);
    if (out) return { ...shape(out, 'gemini'), tries };
    geminiWhy = tries.length ? `Gemini: ${tries.map((t) => `${t.model} ${t.status}`).join(', ').slice(0, 160)}` : '';
    if (engine === 'gemini') return { ...fallback, why: geminiWhy || 'Gemini non risponde', tries };
  }
  try {
    const out = await withTimeout(Promise.resolve().then(() => ai.run(CLOUDFLARE_FREE_MODEL, { messages: [
      { role: 'system', content: system },
      { role: 'user', content: userText }
    ], temperature: 0.2, max_tokens: 400, response_format: { type: 'json_schema', json_schema: SCHEMA } })), timeoutMs);
    const parsed = parseJson(out?.response ?? out?.choices?.[0]?.message?.content);
    if (!parsed || !INTENTS.has(parsed.intent)) return { ...fallback, why: parsed ? `intenzione «${String(parsed.intent).slice(0, 30)}»` : 'risposta non leggibile' };
    return { ...shape(parsed, 'cloudflare'), ...(geminiWhy ? { why: geminiWhy } : {}) };
  } catch (error) { return { ...fallback, why: String(error?.message || 'errore').slice(0, 80) }; }
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

// Piano detto esplicitamente: uno solo, altrimenti «da definire» (decide Riccardo).
const PLAN_WORDS = [['standard', /\bstandard\b/], ['annuale', /\bannual[ei]\b/], ['premium', /\bpremium\b/]];
export function planFromText(text) {
  const plain = String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const found = PLAN_WORDS.filter(([, pattern]) => pattern.test(plain)).map(([plan]) => plan);
  return found.length === 1 ? found[0] : null;
}
// Il nome del locale deve essere davvero nelle parole di Riccardo (niente nomi inventati dal modello).
export function venueSaid(venue, utterance) {
  const said = `-${slugify(utterance)}-`;
  const words = slugify(venue).split('-').filter(Boolean);
  return words.length > 0 && words.every((w) => said.includes(`-${w}-`));
}

/* Conversazione libera: un modello più capace (GPT-OSS 120B su Cloudflare, nella quota gratuita
 * giornaliera) per parlare di tutto con Riccardo in modo naturale. Non esegue azioni: quelle
 * passano sempre da understand() e dai flussi con bozza, Revisione e SÌ. Se il modello grande non
 * risponde, Jarvis usa quello di sempre. */
export const CHAT_MODEL = '@cf/openai/gpt-oss-120b';

/** Testo della risposta da formati diversi (chat completions, responses, testo semplice). */
export function chatText(out) {
  if (!out) return '';
  if (typeof out === 'string') return out;
  if (typeof out.response === 'string') return out.response;
  const choice = out.choices?.[0]?.message?.content;
  if (typeof choice === 'string') return choice;
  if (typeof out.output_text === 'string') return out.output_text;
  for (const item of Array.isArray(out.output) ? out.output : []) {
    if (item?.type !== 'message') continue;
    const text = (item.content || []).filter((c) => c?.type === 'output_text' || typeof c?.text === 'string').map((c) => c.text).join('');
    if (text) return text;
  }
  return '';
}
const tidy = (text) => String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/\*\*|__|^#+\s*|^[-*•]\s+/gm, '').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').replace(/\n{3,}/g, '\n\n').trim();

export async function chat(ai, { utterance, context, history = [], spoken = false }, { timeoutMs = 30_000 } = {}) {
  if (typeof ai?.run !== 'function') return { ok: false, text: '' };
  const system = [
    'Sei J.A.R.V.I.S., l’assistente personale di Riccardo Iuran, creatore di RenMenu (menu digitali QR per ristoranti e bar, base a Gorizia). Riccardo non gestisce un locale: i ristoranti e i bar sono i suoi clienti. Ispirato al Jarvis di Iron Man: calmo, caldo, elegante, con un filo di ironia garbata. Dai del tu a Riccardo e ogni tanto lo chiami per nome.',
    'Parli in italiano naturale, come in una conversazione vera: niente elenchi puntati, niente titoli, niente emoji, niente markdown.',
    spoken ? 'La risposta verrà letta ad alta voce: al massimo 4-5 frasi brevi, scorrevoli da ascoltare.' : 'Risposta scritta su Telegram: chiara e completa ma non prolissa (di solito 2-6 frasi; di più solo se Riccardo chiede spiegazioni o idee).',
    'Puoi parlare di qualsiasi argomento con le tue conoscenze generali: consigli di lavoro, marketing per locali, idee, spiegazioni, curiosità.',
    'Per tutto ciò che riguarda RenMenu (locali, menu, prezzi, pratiche, scadenze) usa SOLO i DATI forniti: se un dato non c’è, dillo. Non inventare mai prezzi, piatti, allergeni, ingredienti o numeri.',
    'Piani RenMenu: Standard 25 €/mese con 30 giorni gratis; Annuale 249 €/anno; Premium 490 € di acconto + 39 €/mese.',
    'Se Riccardo ti chiede di stupirlo, di farlo sorridere o dice di sentirsi creativo, mostra personalità: una battuta o una curiosità originale e breve, oppure due o tre idee concrete e fattibili legate ai suoi progetti (menu Premium di RenMenu, candele artigianali, giochi e video), senza mai inventare dati sui suoi locali. Chiudi con una proposta pratica o una domanda che lo faccia andare avanti.',
    'Non navighi su internet: per meteo, notizie o fatti di oggi dillo con semplicità.',
    'In questa conversazione non esegui azioni. Se Riccardo vuole che tu faccia qualcosa (modificare un menu, creare una pratica, ricordare una nota, pubblicare), invitalo a dirtelo direttamente, per esempio «cambia il prezzo del frico a 15».'
  ].join('\n');
  const messages = [{ role: 'system', content: `${system}\n\nDATI DELLA CONTROL ROOM:\n${String(context || '').slice(0, 12_000)}` },
    ...history.slice(-12).map((h) => ({ role: h.who === 'Jarvis' ? 'assistant' : 'user', content: String(h.text).slice(0, 1200) })),
    { role: 'user', content: String(utterance).slice(0, 2000) }];
  for (const [model, options] of [[CHAT_MODEL, { max_tokens: 2500 }], [CLOUDFLARE_FREE_MODEL, { max_tokens: 700, temperature: 0.6 }]]) {
    try {
      const out = await withTimeout(Promise.resolve().then(() => ai.run(model, { messages, ...options })), timeoutMs);
      const text = tidy(chatText(out));
      if (text) return { ok: true, text: text.slice(0, spoken ? 900 : 3000), model };
    } catch {}
  }
  return { ok: false, text: '' };
}

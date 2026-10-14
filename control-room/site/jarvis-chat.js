/* «Parla con Jarvis» nella Control Room: conversazione scritta e a voce con lo stesso Jarvis di Telegram.
 * Microfono: riconoscimento vocale del browser (gratis), acceso solo quando lo tocchi o in «mani libere».
 * Risposte: voce del browser (gratis) oppure la voce vera di Jarvis (ElevenLabs, consuma crediti) se la
 * accendi qui. Pubblicare, cancellare e scrivere ai locali restano tocchi espliciti sui pulsanti di Jarvis. */
import { askJarvis, isDemoMode, jarvisVoiceAudio } from './api.js';

const Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
const Synth = globalThis.speechSynthesis;
const STOP_WORDS = /^(?:ok\s+)?(?:basta|stop|fine|chiudi|grazie(?:\s+jarvis)?(?:,?\s+(?:basta|a dopo|ciao))?|a dopo|ciao jarvis)[.!]?$/i;
const SUGGESTIONS = ['Com’è la situazione?', 'Mostrami le pratiche aperte', 'Quali locali sono registrati?', 'Modifiche di questa settimana', 'Mostrami l’anteprima di …', 'Nella bozza di … metti … a … euro'];
const HISTORY_KEY = 'jarvis-chat';
const VOICE_KEY = 'jarvis-chat-voice';

const local = {
  get(key, fallback) { try { return globalThis.localStorage?.getItem(key) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { globalThis.localStorage?.setItem(key, value); } catch { /* niente memoria: va bene lo stesso */ } }
};
function loadHistory() {
  try { const list = JSON.parse(globalThis.sessionStorage?.getItem(HISTORY_KEY) || '[]'); return Array.isArray(list) ? list.slice(-40) : []; } catch { return []; }
}
function saveHistory(list) {
  // Immagini e file restano solo a schermo: in memoria della sessione va il testo.
  try { globalThis.sessionStorage?.setItem(HISTORY_KEY, JSON.stringify(list.slice(-40).map(({ src, ...rest }) => rest))); } catch { /* ok */ }
}

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const linkify = (text) => escapeHtml(text).replace(/https:\/\/[^\s<]+[^\s<.,;:!?)»]/g, (url) => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
const MIC = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const SEND = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

let sheet = null;
let history = loadHistory();
let busy = false;
let handsFree = false;
let jarvisVoice = local.get(VOICE_KEY, 'no') === 'si';
let voiceReady = false;
let telegramBot = '';
let showHandler = null; // «mostrami …»: la home apre l'elenco (vedi jarvis-show.js)
let recognition = null;
let player = null;
let phase = 'idle'; // idle | listening | thinking | speaking

function setPhase(next, note = '') {
  phase = next;
  if (!sheet) return;
  sheet.dataset.phase = next;
  const status = sheet.querySelector('#chat-status');
  const labels = { idle: handsFree ? 'Mani libere: tocca il microfono per cominciare' : 'Tocca il microfono e parla, oppure scrivi', listening: 'Ti ascolto…', thinking: 'Jarvis sta pensando…', speaking: 'Jarvis risponde…' };
  if (status) status.textContent = note || labels[next];
  const mic = sheet.querySelector('[data-chat="mic"]');
  if (mic) { mic.setAttribute('aria-pressed', String(next === 'listening')); mic.setAttribute('aria-label', next === 'listening' ? 'Smetti di ascoltare' : next === 'speaking' ? 'Interrompi e parla' : 'Parla con Jarvis'); }
}

function bubble(entry) {
  if (entry.role === 'user') return `<div class="msg u">${escapeHtml(entry.text)}</div>`;
  const body = entry.text ? `<div class="chat-text">${linkify(entry.text)}</div>` : '';
  const media = entry.kind === 'image' && entry.src ? `<img class="chat-img" src="${escapeHtml(entry.src)}" alt="${escapeHtml(entry.text || 'Immagine di Jarvis')}">`
    : entry.kind === 'file' && entry.src ? `<a class="chat-file" href="${escapeHtml(entry.src)}" download="${escapeHtml(entry.name || 'file')}">Scarica ${escapeHtml(entry.name || 'il file')}</a>`
    : entry.kind === 'file' ? `<p class="chat-note">File «${escapeHtml(entry.name || '')}» pronto: lo trovi su Telegram se ti serve.</p>` : '';
  const buttons = entry.buttons?.length && !entry.used
    ? `<div class="chat-btns">${entry.buttons.map(([label, data]) => `<button type="button" data-chat-press="${escapeHtml(data)}">${escapeHtml(label)}</button>`).join('')}</div>` : '';
  return `<div class="msg j${entry.kind === 'note' ? ' note' : ''}">${body}${media}${buttons}</div>`;
}

function renderLog() {
  const log = sheet?.querySelector('#chat-log');
  if (!log) return;
  const intro = `<div class="msg j"><div class="chat-text">${isDemoMode ? 'Demo: qui le risposte sono finte e non parte nulla.' : 'Sono qui, Riccardo. Parlami o scrivimi come su Telegram: capisco le stesse cose e pubblicare resta sempre un tuo tocco.'}</div></div>`;
  log.innerHTML = intro + history.map(bubble).join('');
  log.scrollTop = log.scrollHeight;
}

function render() {
  sheet.innerHTML = `<div class="sheet-head"><strong>Parla con Jarvis</strong><button type="button" data-action="ask-close">Chiudi</button></div>
    <div class="chat-core" aria-hidden="true"><span></span></div>
    <p class="chat-status" id="chat-status" role="status"></p>
    <div class="log" id="chat-log" aria-live="polite"></div>
    <div class="quick chat-quick">${SUGGESTIONS.map((s) => `<button type="button" data-chat-suggest="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('')}</div>
    <form class="chat-bar" data-chat="form" autocomplete="off">
      <input name="text" maxlength="1000" placeholder="Scrivi a Jarvis…" aria-label="Messaggio per Jarvis" enterkeyhint="send">
      <button class="chat-send" type="submit" aria-label="Invia">${SEND}</button>
      <button class="chat-mic" type="button" data-chat="mic" aria-pressed="false" aria-label="Parla con Jarvis">${MIC}</button>
    </form>
    <div class="chat-opts">
      <label class="chat-toggle"><input type="checkbox" data-chat="handsfree" ${handsFree ? 'checked' : ''}><span>Mani libere<small>dopo ogni risposta riascolta da solo; «basta» per finire</small></span></label>
      <label class="chat-toggle"><input type="checkbox" data-chat="voice" ${jarvisVoice ? 'checked' : ''} ${voiceReady ? '' : 'disabled'}><span>Voce di Jarvis<small>${voiceReady ? 'ElevenLabs: consuma i tuoi crediti' : 'da configurare in Sistema → Notifiche'}; spenta usa la voce del telefono, gratis</small></span></label>
    </div>
    ${telegramBot && !isDemoMode ? `<a class="chat-tg" href="https://t.me/${escapeHtml(telegramBot)}" target="_blank" rel="noopener">Apri Telegram</a>` : ''}`;
  renderLog();
  setPhase(phase === 'thinking' ? 'thinking' : 'idle');
}

function push(entry) { history.push(entry); history = history.slice(-40); saveHistory(history); renderLog(); }

// ——— voce in uscita ———
function stopSpeaking() {
  if (player) { const audio = player; player = null; audio.pause(); audio.onended?.(); }
  try { Synth?.cancel(); } catch { /* ok */ }
}
function browserSay(text) {
  return new Promise((resolve) => {
    if (!Synth || !globalThis.SpeechSynthesisUtterance || !text) { resolve(); return; }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'it-IT';
    const italian = Synth.getVoices().find((v) => v.lang?.toLowerCase().startsWith('it'));
    if (italian) utterance.voice = italian;
    utterance.onend = () => resolve(); utterance.onerror = () => resolve();
    Synth.cancel(); Synth.speak(utterance);
  });
}
async function say(text, { always = false } = {}) {
  if (!text || !sheet || (sheet.hidden && !always)) return;
  setPhase('speaking');
  if (jarvisVoice && voiceReady) {
    const blob = await jarvisVoiceAudio(text).catch(() => null);
    if (blob && sheet && (always || !sheet.hidden) && phase === 'speaking') {
      const url = URL.createObjectURL(blob);
      const played = await new Promise((resolve) => {
        const audio = new Audio(url);
        player = audio;
        audio.onended = () => resolve(true); audio.onerror = () => resolve(false);
        audio.play().catch(() => resolve(false));
      });
      player = null;
      URL.revokeObjectURL(url);
      if (played || phase !== 'speaking') return;
    }
  }
  if (phase === 'speaking') await browserSay(text);
}

// ——— microfono ———
function stopListening() { if (recognition) { recognition.onend = null; recognition.abort(); recognition = null; } }
function listen() {
  if (!Recognition) { setPhase('idle', 'Questo browser non sente la voce: scrivi pure, oppure usa Chrome o Safari aggiornati.'); handsFree = false; return; }
  stopSpeaking(); stopListening();
  const input = sheet.querySelector('input[name="text"]');
  const instance = new Recognition();
  recognition = instance;
  instance.lang = 'it-IT'; instance.continuous = false; instance.interimResults = true; instance.maxAlternatives = 1;
  let finalText = '';
  instance.onresult = (event) => {
    const parts = [...event.results].map((r) => r[0]?.transcript || '');
    if (input) input.value = parts.join(' ').trim();
    if ([...event.results].every((r) => r.isFinal)) finalText = input?.value || '';
  };
  instance.onerror = (event) => {
    const quiet = event.error === 'no-speech' || event.error === 'aborted';
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') handsFree = false;
    setPhase('idle', quiet ? 'Non ho sentito nulla. Tocca il microfono quando vuoi.' : `Microfono non disponibile (${event.error}). Puoi scrivere.`);
    if (quiet) handsFree = false;
    syncToggles();
  };
  instance.onend = () => {
    if (recognition === instance) recognition = null;
    const text = finalText.trim();
    if (text) send(text, { spoken: true });
    else if (phase === 'listening') setPhase('idle');
  };
  setPhase('listening');
  try { instance.start(); } catch { setPhase('idle', 'Il microfono non è partito: riprova.'); }
}
function syncToggles() { const box = sheet?.querySelector('[data-chat="handsfree"]'); if (box) box.checked = handsFree; }

// ——— conversazione ———
async function send(text, { spoken = false } = {}) {
  const clean = String(text || '').trim();
  if (!clean || busy) return;
  const input = sheet?.querySelector('input[name="text"]');
  if (input) input.value = '';
  if (spoken && handsFree && STOP_WORDS.test(clean)) {
    handsFree = false; syncToggles(); push({ role: 'user', text: clean });
    push({ role: 'jarvis', kind: 'text', text: 'Va bene, smetto di ascoltare. Sono qui se ti servo.' });
    await say('Va bene. Sono qui se ti servo.'); setPhase('idle'); return;
  }
  push({ role: 'user', text: clean });
  // «Mostrami le pratiche chiuse», «quali locali…»: l'elenco si apre a schermo, senza chiamare Jarvis.
  const shown = showHandler?.(clean);
  if (shown) {
    push({ role: 'jarvis', kind: 'text', text: shown.say });
    handsFree = false; stopListening();
    sheet.hidden = true;
    await say(shown.say, { always: true });
    setPhase('idle');
    return;
  }
  await exchange({ text: clean });
}
async function press(data, trigger) {
  if (busy) return;
  const owner = history.findLast?.((e) => e.buttons?.some(([, d]) => d === data)) || [...history].reverse().find((e) => e.buttons?.some(([, d]) => d === data));
  if (owner) owner.used = true;
  push({ role: 'user', text: `▸ ${trigger.textContent.trim()}` });
  await exchange({ press: data });
}
async function exchange(payload) {
  busy = true; setPhase('thinking');
  try {
    const result = await askJarvis(payload);
    const replies = Array.isArray(result?.messages) ? result.messages : [];
    for (const m of replies) push({ role: 'jarvis', kind: m.kind || 'text', text: m.text || '', buttons: m.buttons || [], src: m.src || '', name: m.name || '' });
    busy = false;
    const words = replies.map((m) => m.say).filter(Boolean).join(' ').slice(0, 900);
    await say(words);
    // Se intanto Riccardo ha toccato il microfono (interrompendo Jarvis) l'ascolto è già partito.
    if (!sheet || sheet.hidden || phase === 'listening') return;
    const waitsForTap = replies.some((m) => m.buttons?.length);
    if (handsFree && !waitsForTap) listen(); else setPhase('idle', waitsForTap ? 'Scegli un pulsante, oppure rispondi a voce.' : '');
  } catch (error) {
    busy = false;
    push({ role: 'jarvis', kind: 'note', text: error?.message || 'Jarvis non risponde: riprova tra poco.' });
    setPhase('idle');
  }
}

function onClick(event) {
  const pressBtn = event.target.closest('[data-chat-press]');
  if (pressBtn) { press(pressBtn.dataset.chatPress, pressBtn); return; }
  const suggestion = event.target.closest('[data-chat-suggest]');
  if (suggestion) {
    const text = suggestion.dataset.chatSuggest;
    if (text.includes('…')) { const input = sheet.querySelector('input[name="text"]'); input.value = text; input.focus(); input.setSelectionRange(text.indexOf('…'), text.indexOf('…') + 1); }
    else send(text);
    return;
  }
  if (event.target.closest('[data-chat="mic"]')) {
    if (busy) return;
    if (phase === 'listening') { stopListening(); setPhase('idle'); return; }
    listen();
  }
}
function onChange(event) {
  const box = event.target.closest('[data-chat]');
  if (!box) return;
  if (box.dataset.chat === 'handsfree') { handsFree = box.checked; if (handsFree && phase === 'idle' && !busy) listen(); else if (!handsFree) setPhase(phase); }
  if (box.dataset.chat === 'voice') { jarvisVoice = box.checked; local.set(VOICE_KEY, jarvisVoice ? 'si' : 'no'); }
}
function onSubmit(event) {
  event.preventDefault();
  stopListening();
  send(new FormData(event.target).get('text'));
}

/** Apre la conversazione. voice: true se la voce di Jarvis è configurata; listen: parte subito in ascolto. */
export function openChat(element, { voice = false, bot = '', listenNow = false, onShow = null } = {}) {
  showHandler = onShow;
  if (sheet !== element) {
    sheet = element;
    sheet.addEventListener('click', onClick);
    sheet.addEventListener('change', onChange);
    sheet.addEventListener('submit', onSubmit);
  }
  voiceReady = Boolean(voice); telegramBot = bot || '';
  render();
  sheet.hidden = false;
  if (listenNow) listen(); else sheet.querySelector('input[name="text"]')?.focus();
}
export function closeChat() {
  handsFree = false;
  stopListening(); stopSpeaking();
  phase = 'idle';
  if (sheet) sheet.hidden = true;
}

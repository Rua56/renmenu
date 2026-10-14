/* «Parla con Jarvis» nella Control Room: conversazione scritta e a voce con lo stesso Jarvis di Telegram.
 * Microfono: l'orecchio di Jarvis (jarvis-ear.js, trascrizione Whisper gratis), acceso solo quando lo tocchi o in «mani libere».
 * Risposte: voce del browser (gratis) oppure la voce vera di Jarvis (ElevenLabs, consuma crediti) se la
 * accendi qui. «Dialogo dal vivo» parla con l'agente ElevenLabs senza pause, come al telefono (consuma
 * minuti, parte solo dal tocco). Pubblicare, cancellare e scrivere ai locali restano tocchi espliciti sui pulsanti di Jarvis. */
import { askJarvis, isDemoMode, jarvisLiveSession, jarvisVoiceAudio, transcribeVoice } from './api.js';
import { earAvailable, hear, stopHearing, unlockEar } from './jarvis-ear.js';
import { liveAvailable, startLive } from './jarvis-live.js';

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
let live = null; // dialogo dal vivo in corso (jarvis-live.js)

let lastNote = '';
// Il reattore (home e foglio della chat) segue Jarvis: html[data-jarvis] e i livelli di voce --jv-lvl / --jv-out.
const root = globalThis.document?.documentElement;
function setLevel(value) { root?.style.setProperty('--jv-lvl', Number(value || 0).toFixed(2)); }
function setOutLevel(value) {
  if (!root) return;
  if (value === null) { delete root.dataset.jarvisOut; root.style.setProperty('--jv-out', '0'); return; }
  root.dataset.jarvisOut = '1';
  root.style.setProperty('--jv-out', Number(value).toFixed(2));
}
function setPhase(next, note = '') {
  phase = next;
  if (root) { if (next === 'idle') delete root.dataset.jarvis; else root.dataset.jarvis = next; }
  if (next !== 'listening') setLevel(0);
  if (next !== 'speaking') setOutLevel(null);
  if (!sheet) return;
  sheet.dataset.phase = next;
  const status = sheet.querySelector('#chat-status');
  const labels = { idle: handsFree ? 'Mani libere: tocca il microfono per cominciare' : 'Tocca il microfono e parla, oppure scrivi', listening: 'Ti ascolto…', thinking: 'Jarvis sta pensando…', speaking: handsFree ? 'Jarvis risponde… poi ti riascolto' : 'Jarvis risponde…' };
  lastNote = note || labels[next];
  if (status) status.textContent = lastNote;
  const mic = sheet.querySelector('[data-chat="mic"]');
  if (mic) { mic.setAttribute('aria-pressed', String(next === 'listening' || Boolean(live))); mic.setAttribute('aria-label', live ? 'Termina il dialogo dal vivo' : next === 'listening' ? 'Smetti di ascoltare' : next === 'speaking' ? 'Interrompi e parla' : 'Parla con Jarvis'); }
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
    <div class="chat-core reactor" aria-hidden="true"><span class="r1"></span><span class="r2"></span><span class="r3"></span><span class="core"></span></div>
    <p class="chat-status" id="chat-status" role="status"></p>
    <div class="log" id="chat-log" aria-live="polite"></div>
    <div class="quick chat-quick">${SUGGESTIONS.map((s) => `<button type="button" data-chat-suggest="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('')}</div>
    <form class="chat-bar" data-chat="form" autocomplete="off">
      <input name="text" maxlength="1000" placeholder="Scrivi a Jarvis…" aria-label="Messaggio per Jarvis" enterkeyhint="send">
      <button class="chat-send" type="submit" aria-label="Invia">${SEND}</button>
      <button class="chat-mic" type="button" data-chat="mic" aria-pressed="false" aria-label="Parla con Jarvis">${MIC}</button>
    </form>
    ${liveAvailable && !isDemoMode ? `<button class="chat-live" type="button" data-chat="live" aria-pressed="${live ? 'true' : 'false'}" ${voiceReady || live ? '' : 'disabled'}><strong>${live ? 'Termina il dialogo dal vivo' : 'Dialogo dal vivo'}</strong><small>${voiceReady ? 'Jarvis ti risponde subito e puoi interromperlo. ElevenLabs: consuma minuti; si chiude dopo 10 minuti o se lasci la pagina' : 'serve la voce ElevenLabs in Sistema → Notifiche'}</small></button>` : ''}
    <div class="chat-opts">
      <label class="chat-toggle"><input type="checkbox" data-chat="handsfree" ${handsFree ? 'checked' : ''}><span>Mani libere<small>dopo ogni risposta riascolta da solo; «basta» per finire</small></span></label>
      <label class="chat-toggle"><input type="checkbox" data-chat="voice" ${jarvisVoice ? 'checked' : ''} ${voiceReady ? '' : 'disabled'}><span>Voce di Jarvis<small>${voiceReady ? 'ElevenLabs: consuma i tuoi crediti' : 'da configurare in Sistema → Notifiche'}; spenta usa la voce del telefono, gratis</small></span></label>
    </div>
    ${telegramBot && !isDemoMode ? `<a class="chat-tg" href="https://t.me/${escapeHtml(telegramBot)}" target="_blank" rel="noopener">Apri Telegram</a>` : ''}`;
  renderLog();
  if (live) setPhase(phase, lastNote);
  else setPhase(phase === 'thinking' ? 'thinking' : 'idle');
}

function push(entry) { history.push(entry); history = history.slice(-40); saveHistory(history); renderLog(); }

// ——— voce in uscita ———
function stopSpeaking() {
  if (player) { const audio = player; player = null; audio.pause(); audio.onended?.(); }
  try { Synth?.cancel(); } catch { /* ok */ }
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function browserSay(text) {
  return new Promise((resolve) => {
    if (!Synth || !globalThis.SpeechSynthesisUtterance || !text) { resolve(); return; }
    // Su molti telefoni la voce del browser non avvisa mai che ha finito: senza questi controlli
    // le «mani libere» aspetterebbero per sempre e non riascolterebbero più.
    let done = false, watchdog = 0, poll = 0;
    const end = () => { if (done) return; done = true; clearTimeout(watchdog); clearInterval(poll); resolve(); };
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'it-IT';
    const italian = Synth.getVoices().find((v) => v.lang?.toLowerCase().startsWith('it'));
    if (italian) utterance.voice = italian;
    utterance.onend = end; utterance.onerror = end;
    if (Synth.speaking || Synth.pending) Synth.cancel();
    Synth.speak(utterance);
    watchdog = setTimeout(end, 2500 + text.length * 90);
    const started = Date.now();
    poll = setInterval(() => { if (Date.now() - started > 1500 && !Synth.speaking && !Synth.pending) end(); }, 300);
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
        let guard = setTimeout(() => resolve(false), 15000); // se non parte mai, passa alla voce del telefono
        audio.onloadedmetadata = () => { clearTimeout(guard); guard = setTimeout(() => resolve(true), (Number.isFinite(audio.duration) && audio.duration > 0 ? Math.min(audio.duration, 120) : 120) * 1000 + 3000); };
        audio.onended = () => { clearTimeout(guard); resolve(true); };
        audio.onerror = () => { clearTimeout(guard); resolve(false); };
        audio.play().catch(() => { clearTimeout(guard); resolve(false); });
      });
      player = null;
      URL.revokeObjectURL(url);
      if (played || phase !== 'speaking') return;
    }
  }
  if (phase === 'speaking') await browserSay(text);
}

// ——— microfono ———
// Di base l'orecchio di Jarvis (jarvis-ear.js: registra, capisce quando hai finito, trascrive Whisper):
// funziona anche dopo che Jarvis ha parlato e senza toccare nulla in «mani libere». Il riconoscimento del
// browser resta solo dove il microfono non si può registrare (e nella demo, che non chiama il server).
let listenTurn = 0;
let quietTurns = 0;
function stopListening() {
  listenTurn += 1;
  stopHearing(false);
  if (recognition) { const old = recognition; recognition = null; old.onend = null; old.onerror = null; old.onresult = null; old.abort(); }
  setLevel(0);
}
function quiet(note) {
  // In «mani libere» riprova un paio di volte prima di smettere: magari stavi pensando.
  if (handsFree && quietTurns < 2) { quietTurns += 1; listen(); return; }
  quietTurns = 0; handsFree = false; syncToggles();
  setPhase('idle', note || 'Non ho sentito nulla. Tocca il microfono quando vuoi.');
}
function listen() {
  if (busy) return;
  stopSpeaking(); stopListening();
  if (earAvailable && !isDemoMode) { listenWithEar(); return; }
  listenWithBrowser();
}
async function listenWithEar() {
  const turn = listenTurn;
  setPhase('listening');
  let blob = null;
  try {
    blob = await hear({ onLevel: setLevel });
  } catch (error) {
    if (turn !== listenTurn) return;
    // Il telefono ha messo in pausa il microfono dopo aver parlato: basta un tocco per ripartire,
    // e le mani libere restano accese per i turni dopo.
    if (error?.name === 'EarStuck') { setPhase('idle', 'Il telefono ha messo in pausa il microfono: toccalo per continuare.'); return; }
    handsFree = false; syncToggles();
    setPhase('idle', /denied|allowed|permission/i.test(String(error?.name || error?.message)) ? 'Il microfono è bloccato: consentilo nelle impostazioni del browser per questo sito.' : 'Il microfono non è partito: riprova.');
    return;
  }
  if (turn !== listenTurn || !sheet || sheet.hidden) return;
  if (!blob) { quiet(); return; }
  setPhase('thinking', 'Trascrivo…');
  let text = '';
  try { text = await transcribeVoice(blob); } catch (error) {
    if (turn !== listenTurn) return;
    quiet(error?.message ? `${error.message} Riprova.` : '');
    return;
  }
  if (turn !== listenTurn || !sheet || sheet.hidden) return;
  if (!text) { quiet('Non ho capito le parole. Riprova un po’ più vicino al telefono.'); return; }
  quietTurns = 0;
  setPhase('idle');
  send(text, { spoken: true });
}
function listenWithBrowser() {
  if (!Recognition) { setPhase('idle', 'Questo browser non sente la voce: scrivi pure, oppure usa Chrome o Safari aggiornati.'); handsFree = false; syncToggles(); return; }
  const input = sheet.querySelector('input[name="text"]');
  const instance = new Recognition();
  recognition = instance;
  instance.lang = 'it-IT'; instance.continuous = false; instance.interimResults = true; instance.maxAlternatives = 1;
  instance.onresult = (event) => {
    if (input) input.value = [...event.results].map((r) => r[0]?.transcript || '').join(' ').trim();
  };
  instance.onerror = (event) => {
    if (recognition !== instance) return;
    recognition = null;
    if (event.error === 'no-speech' || event.error === 'aborted') { quiet(); return; }
    handsFree = false; syncToggles();
    setPhase('idle', `Microfono non disponibile (${event.error}). Puoi scrivere.`);
  };
  instance.onend = () => {
    if (recognition !== instance) return;
    recognition = null;
    // Alcuni browser (Safari) non segnano mai la frase come «finale»: vale quello che si è sentito.
    const text = String(input?.value || '').trim();
    if (text) { quietTurns = 0; send(text, { spoken: true }); } else quiet();
  };
  setPhase('listening');
  try { instance.start(); } catch { recognition = null; setPhase('idle', 'Il microfono non è partito: riprova.'); }
}
function syncToggles() { const box = sheet?.querySelector('[data-chat="handsfree"]'); if (box) box.checked = handsFree; }

// ——— dialogo dal vivo ———
function liveButton() {
  const button = sheet?.querySelector('[data-chat="live"]');
  if (!button) return;
  button.setAttribute('aria-pressed', String(Boolean(live)));
  const label = button.querySelector('strong');
  if (label) label.textContent = live ? 'Termina il dialogo dal vivo' : 'Dialogo dal vivo';
  button.disabled = !voiceReady && !live;
}
function startLiveDialog() {
  if (live || busy) return;
  handsFree = false; syncToggles();
  stopListening(); stopSpeaking();
  const LIVE_NOTES = { connecting: 'Collego Jarvis dal vivo…', listening: 'Dal vivo: parla pure', speaking: 'Jarvis parla… interrompilo quando vuoi' };
  live = startLive({
    session: jarvisLiveSession,
    onLevel: setLevel,
    onOutLevel: setOutLevel,
    onUser: (text) => push({ role: 'user', text }),
    onAgent: (text) => push({ role: 'jarvis', kind: 'text', text }),
    onState: (state, note) => {
      if (state === 'ended') {
        live = null;
        delete document.body.dataset.live;
        liveButton();
        setPhase('idle', note || 'Dialogo finito.');
        return;
      }
      setPhase(state === 'connecting' ? 'thinking' : state, LIVE_NOTES[state]);
    },
    onTool: liveTool
  });
  document.body.dataset.live = '1';
  liveButton();
}
function stopLiveDialog() { live?.stop(); }
// Strumenti dell'agente dal vivo: il Jarvis vero (stesse risposte e pulsanti di Telegram), gli elenchi a schermo, la chiusura.
async function liveTool(name, params) {
  if (name === 'chiedi_a_jarvis') {
    const text = String(params.richiesta || '').trim().slice(0, 1000);
    if (!text) return 'Manca la richiesta.';
    const result = await askJarvis({ text });
    const replies = Array.isArray(result?.messages) ? result.messages : [];
    for (const m of replies) push({ role: 'jarvis', kind: m.kind || 'text', text: m.text || '', buttons: m.buttons || [], src: m.src || '', name: m.name || '' });
    const buttons = replies.flatMap((m) => (m.buttons || []).map(([label]) => label));
    const said = replies.map((m) => m.say || (m.kind === 'image' ? 'Immagine mostrata a schermo.' : m.kind === 'file' ? 'File pronto a schermo.' : '')).filter(Boolean).join(' ');
    return `${said || 'Fatto.'}${buttons.length ? ` Pulsanti a schermo per Riccardo: ${buttons.join(', ')}.` : ''}`;
  }
  if (name === 'mostra') {
    const shown = showHandler?.(String(params.cosa || ''));
    if (!shown) return 'Questo elenco non so aprirlo a schermo: chiedilo con chiedi_a_jarvis.';
    push({ role: 'jarvis', kind: 'text', text: shown.say });
    sheet.hidden = true; // l'elenco è sulla home; il dialogo continua, la barra in basso riapre la conversazione
    return `${shown.say} L'elenco è aperto a schermo.`;
  }
  if (name === 'chiudi') { setTimeout(stopLiveDialog, 2500); return 'Chiudo.'; }
  return 'Strumento sconosciuto.';
}

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
    if (live) { live.context(`A schermo: ${shown.say}`); return; }
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
  busy = true;
  if (!live) setPhase('thinking');
  try {
    const result = await askJarvis(payload);
    const replies = Array.isArray(result?.messages) ? result.messages : [];
    for (const m of replies) push({ role: 'jarvis', kind: m.kind || 'text', text: m.text || '', buttons: m.buttons || [], src: m.src || '', name: m.name || '' });
    busy = false;
    const words = replies.map((m) => m.say).filter(Boolean).join(' ').slice(0, 900);
    // Dal vivo parla l'agente: gli si dice cosa è successo a schermo, senza interromperlo.
    if (live) { live.context(`Riccardo ha usato lo schermo (${payload.press ? 'pulsante' : `scritto: «${payload.text}»`}). Jarvis ha risposto: ${words || 'fatto'}`); return; }
    await say(words);
    // Un attimo prima di riaprire il microfono: il telefono torna dall'altoparlante alla registrazione
    // e la coda della voce di Jarvis non finisce nella frase successiva.
    if (handsFree && words) await pause(400);
    // Se intanto Riccardo ha toccato il microfono (interrompendo Jarvis) l'ascolto è già partito.
    if (!sheet || sheet.hidden || phase === 'listening') return;
    const waitsForTap = replies.some((m) => m.buttons?.length);
    // In «mani libere» riascolta sempre: a un pulsante si può rispondere anche a voce («sì», «la seconda»).
    if (handsFree) listen(); else setPhase('idle', waitsForTap ? 'Scegli un pulsante, oppure rispondi a voce.' : '');
  } catch (error) {
    busy = false;
    push({ role: 'jarvis', kind: 'note', text: error?.message || 'Jarvis non risponde: riprova tra poco.' });
    if (!live) setPhase('idle');
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
  if (event.target.closest('[data-chat="live"]')) { if (live) stopLiveDialog(); else startLiveDialog(); return; }
  if (event.target.closest('[data-chat="mic"]')) {
    if (live) { stopLiveDialog(); return; }
    if (busy) return;
    unlockEar();
    // Mentre ascolta, il tocco vuol dire «ho finito»: manda subito quello che ha sentito.
    if (phase === 'listening') { if (recognition) recognition.stop(); else stopHearing(true); return; }
    quietTurns = 0;
    listen();
  }
}
function onChange(event) {
  const box = event.target.closest('[data-chat]');
  if (!box) return;
  if (box.dataset.chat === 'handsfree' && live) { box.checked = false; return; }
  if (box.dataset.chat === 'handsfree') { handsFree = box.checked; quietTurns = 0; if (handsFree) unlockEar(); if (handsFree && phase === 'idle' && !busy) listen(); else if (!handsFree) setPhase(phase); }
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
  if (live) return;
  if (listenNow) listen(); else sheet.querySelector('input[name="text"]')?.focus();
}
export function closeChat() {
  stopLiveDialog();
  handsFree = false;
  stopListening(); stopSpeaking();
  setPhase('idle');
  if (sheet) sheet.hidden = true;
}

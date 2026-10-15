/* «Parla con Jarvis» nella Control Room: conversazione scritta e a voce con lo stesso Jarvis di Telegram.
 * Microfono: l'orecchio di Jarvis (jarvis-ear.js, trascrizione Whisper gratis), acceso solo quando lo tocchi o in «mani libere».
 * Risposte: voce del browser (gratis) oppure la voce vera di Jarvis (ElevenLabs, consuma crediti) se la
 * accendi qui. «Dialogo dal vivo» parla con l'agente ElevenLabs senza pause, come al telefono (consuma
 * minuti, parte solo dal tocco). Pubblicare, cancellare e scrivere ai locali restano tocchi espliciti sui pulsanti di Jarvis. */
import { askJarvis, isDemoMode, jarvisLiveSession, jarvisReady, jarvisVoiceAudio, transcribeVoice } from './api.js';
import { earAvailable, hear, stopHearing, unlockEar } from './jarvis-ear.js';
import { liveAvailable, startLive } from './jarvis-live.js';
import { attachSpectrum } from './jarvis-holo.js';
import { pauseWake, resumeWake } from './jarvis-wake.js';

const Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
const Synth = globalThis.speechSynthesis;
const STOP_WORDS = /^(?:ok\s+)?(?:basta|stop|fine|chiudi|grazie(?:\s+jarvis)?(?:,?\s+(?:basta|a dopo|ciao))?|a dopo|ciao jarvis)[.!]?$/i;
const SUGGESTIONS = ['Fammi il briefing', 'Com’è la situazione?', 'Le mie regole', 'Nel menu di … metti … a … euro', 'Crea una nuova pratica per …', 'Pubblica il menu di …', 'Mostrami l’anteprima di …', 'Elimina la pratica di …', 'Mostrami le pratiche aperte'];
// Briefing a voce: Jarvis legge una alla volta le decisioni che ha preparato e Riccardo risponde a voce.
const BRIEF_WORDS = /^\W*(?:ok\s+)?(?:(?:ehi\s+)?jarvis[\s,!.]*)?(?:(?:fammi|facciamo|dammi)\s+(?:il\s+|un\s+)?(?:briefing|punto)|briefing(?:\s+a\s+voce)?|cosa\s+(?:devo|c[’']?è\s+da)\s+decidere|cosa\s+mi\s+hai\s+preparato|cosa\s+(?:c[’']?è\s+)?(?:di\s+)?pronto(?:\s+per\s+me)?)[\s?!.]*$/i;
const SKIP_WORDS = /^\W*(?:salta(?:la)?|passa(?:\s+oltre)?|prossim[ao]|avanti|la\s+prossima|dopo|più\s+tardi|ci\s+penso\s+dopo)[\s!.]*$/i;
const END_WORDS = /^\W*(?:ok\s+)?(?:basta(?:\s+così)?|stop|fine|ferma(?:ti)?|chiudi|finito|grazie(?:\s+jarvis)?)[\s!.]*$/i;
const BRIEF_MAX = 8;
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
let closeHandler = null; // la conversazione si è chiusa: la home riprende ad ascoltare «Ehi Jarvis»
let woken = false; // aperta da «Ehi Jarvis» o dal nucleo: «basta» chiude anche il foglio
let recognition = null;
let player = null;
let phase = 'idle'; // idle | listening | thinking | speaking
let live = null; // dialogo dal vivo in corso (jarvis-live.js)
let inline = false; // conversazione dentro la home (non un foglio che si chiude)
let introHtml = null; // la home mette in cima alla conversazione le decisioni che aspettano Riccardo
const bound = new WeakSet();
let brief = null; // briefing in corso: { queue, current, n, total, hands }
let afterReply = null;
let userSays = null; // la home aggancia sulla mappa il locale nominato // la home rilegge «Pronto per te» dopo ogni risposta di Jarvis

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
// Il microfono è uno solo: mentre Jarvis ascolta, pensa o parla, l'ascolto di «Ehi Jarvis» si ferma (sul
// telefono i due si rubavano il microfono, e Jarvis poteva svegliarsi sentendo il proprio nome). Nella home,
// tornata a riposo, la sveglia riparte da sola dopo un attimo; il foglio la riaccende quando si chiude.
let wakeTimer = 0;
function shareMic(next) {
  clearTimeout(wakeTimer);
  if (next !== 'idle') { pauseWake(); return; }
  if (inline && !handsFree && !live) wakeTimer = setTimeout(() => { if (phase === 'idle' && !handsFree && !live) resumeWake(); }, 1200);
}
function setPhase(next, note = '') {
  phase = next;
  shareMic(next);
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
  const badge = entry.brief ? `<span class="brief-n">${escapeHtml(entry.brief)}</span>` : '';
  // Risposta appena arrivata: si monta come un pannello olografico (una volta sola, non a ogni ridisegno).
  const fresh = entry.at && Date.now() - entry.at < 1500 ? ' holo-in' : '';
  const stamp = entry.at ? new Date(entry.at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  return `<div class="msg j${entry.kind === 'note' ? ' note' : ''}${entry.card ? ' has-card' : ''}${fresh}"${stamp ? ` data-stamp="JARVIS · ${stamp}"` : ''}>${badge}${body}${entry.card ? cardHtml(entry.card) : ''}${media}${buttons}</div>`;
}

// ——— anteprima dal vivo: il menu come lo vede il cliente, con la modifica segnata ———
const MODE_NOTE = {
  modifica: (n) => `${n === 1 ? 'Una modifica' : `${n} modifiche`} nella bozza · non ancora online`,
  online: (n) => `Rispetto al menu online: ${n === 1 ? 'una modifica' : `${n} modifiche`} · non ancora online`,
  nuova: () => 'Bozza nuova · non ancora online',
  bozza: () => 'La bozza così com’è · non ancora online',
  uguale: () => 'Nessuna differenza visibile nel menu'
};
const MARK_LABEL = { nuovo: 'nuovo', tolto: 'tolto', prezzo: 'prezzo', nome: 'nome', descrizione: 'testo', spostato: 'spostato' };
function cardHtml(card) {
  const note = (MODE_NOTE[card.mode] || MODE_NOTE.bozza)(card.total || 0);
  const lines = card.lines?.length ? `<ul class="lc-lines">${card.lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}${card.total > card.lines.length ? `<li class="muted">e altre ${card.total - card.lines.length}</li>` : ''}</ul>` : '';
  const item = (it) => {
    const price = it.mark === 'prezzo' && it.was ? `<s>${escapeHtml(it.was)}</s> ${escapeHtml(it.p)}` : escapeHtml(it.p || '');
    const name = it.mark === 'nome' && it.was ? `${escapeHtml(it.n)} <s>${escapeHtml(it.was)}</s>` : escapeHtml(it.n);
    return `<div class="lc-item${it.mark ? ` mk-${escapeHtml(it.mark)}` : ''}"><span>${name}${it.mark ? ` <em>${escapeHtml(MARK_LABEL[it.mark] || it.mark)}</em>` : ''}${it.d ? `<small>${escapeHtml(it.d)}</small>` : ''}</span><b>${price}</b></div>`;
  };
  const sections = (card.sections || []).map((section) => `<section><h5>${escapeHtml(section.name)}</h5>${section.items.map(item).join('')}${section.hidden ? `<p class="lc-more">… altre ${section.hidden} voci</p>` : ''}</section>`).join('');
  const open = card.requestId ? `<button type="button" class="lc-open" data-select-request="${escapeHtml(card.requestId)}" data-route="revisione">Apri in Revisione</button>` : '';
  return `<figure class="live-card${card.premium ? ' premium' : ''}" aria-label="Anteprima del menu di ${escapeHtml(card.title)}"><figcaption><span>COME LO VEDE IL CLIENTE</span><strong>${escapeHtml(card.title)}</strong><small>${escapeHtml(note)}</small></figcaption>${lines}<div class="lc-phone"><div class="lc-notch" aria-hidden="true"></div><p class="lc-title">${escapeHtml(card.title)}</p>${sections}${card.more ? `<p class="lc-more">… e altre ${card.more} sezioni toccate</p>` : ''}</div>${open}</figure>`;
}

function renderLog(follow = true) {
  const log = sheet?.querySelector('#chat-log');
  if (!log) return;
  const intro = introHtml?.() || `<div class="msg j"><div class="chat-text">${isDemoMode ? 'Demo: qui le risposte sono finte e non parte nulla.' : 'Sono qui, Riccardo. Parlami o scrivimi come su Telegram: capisco le stesse cose e pubblicare resta sempre un tuo tocco.'}</div></div>`;
  log.innerHTML = intro + history.map(bubble).join('');
  log.scrollTop = log.scrollHeight;
  if (inline && follow && history.length) log.lastElementChild?.scrollIntoView({ block: 'nearest' });
}
/** La home ha nuovi dati: ridisegna solo i messaggi (quello che stai scrivendo resta). */
export function refreshChat() { if (sheet && !sheet.hidden) renderLog(false); }

function render() {
  const head = inline ? '' : `<div class="sheet-head"><strong>J.A.R.V.I.S.<small>Parla con Jarvis</small></strong><button type="button" data-action="ask-close">Chiudi</button></div>
    <div class="chat-core reactor" aria-hidden="true"><i class="holo-spec" data-holo-spectrum></i><span class="r1"></span><span class="r2"></span><span class="r3"></span><span class="core"></span></div>`;
  sheet.innerHTML = `${head}
    <p class="chat-status" id="chat-status" role="status"></p>
    <div class="log" id="chat-log" aria-live="polite"></div>
    <div class="quick chat-quick">${SUGGESTIONS.map((s) => `<button type="button" data-chat-suggest="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('')}</div>
    <form class="chat-bar" data-chat="form" autocomplete="off">
      <input name="text" maxlength="1000" placeholder="Scrivi a Jarvis…" aria-label="Messaggio per Jarvis" enterkeyhint="send">
      <button class="chat-send" type="submit" aria-label="Invia">${SEND}</button>
      <button class="chat-mic" type="button" data-chat="mic" aria-pressed="false" aria-label="Parla con Jarvis">${MIC}</button>
    </form>
    ${inline ? '<details class="chat-more"><summary>Voce e opzioni</summary>' : ''}${liveAvailable && !isDemoMode ? `<button class="chat-live" type="button" data-chat="live" aria-pressed="${live ? 'true' : 'false'}" ${voiceReady || live ? '' : 'disabled'}><strong>${live ? 'Termina il dialogo dal vivo' : 'Dialogo dal vivo'}</strong><small>${voiceReady ? 'Jarvis ti risponde subito e puoi interromperlo. ElevenLabs: consuma minuti; si chiude dopo 10 minuti o se lasci la pagina' : 'serve la voce ElevenLabs in Strumenti → Collegamenti e voce di Jarvis'}</small></button>` : ''}
    <div class="chat-opts">
      <label class="chat-toggle"><input type="checkbox" data-chat="handsfree" ${handsFree ? 'checked' : ''}><span>Mani libere<small>dopo ogni risposta riascolta da solo; «basta» per finire</small></span></label>
      <label class="chat-toggle"><input type="checkbox" data-chat="voice" ${jarvisVoice ? 'checked' : ''} ${voiceReady ? '' : 'disabled'}><span>Voce di Jarvis<small>${voiceReady ? 'ElevenLabs: consuma i tuoi crediti' : 'da configurare in Strumenti → Collegamenti e voce di Jarvis'}; spenta usa la voce del telefono, gratis</small></span></label>
    </div>
    ${telegramBot && !isDemoMode ? `<a class="chat-tg" href="https://t.me/${escapeHtml(telegramBot)}" target="_blank" rel="noopener">Apri Telegram</a>` : ''}${inline ? '</details>' : ''}`;
  renderLog(!inline);
  if (!inline) attachSpectrum(sheet.querySelector('[data-holo-spectrum]'));
  if (live) setPhase(phase, lastNote);
  else setPhase(phase === 'thinking' ? 'thinking' : 'idle');
}

function push(entry) { entry.at = entry.at || Date.now(); history.push(entry); history = history.slice(-40); saveHistory(history); renderLog(); }

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
/** Jarvis parla fuori dalla conversazione (saluto all'apertura): voce del telefono, gratis, e il reattore segue. */
export async function announce(text) {
  if (!text || phase !== 'idle' || (sheet && !sheet.hidden && !inline)) return;
  setPhase('speaking');
  await browserSay(text);
  if (phase === 'speaking') setPhase('idle');
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
  // Svegliato con «Ehi Jarvis» e poi silenzio: si richiude e torna ad aspettare la sveglia.
  if (woken && !note) { closeChat(); return; }
  setPhase('idle', note || 'Non ho sentito nulla. Tocca il microfono quando vuoi.');
}
function listen() {
  if (busy) return;
  clearTimeout(wakeTimer); pauseWake();
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
  clearTimeout(wakeTimer); pauseWake();
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
    for (const m of replies) push({ role: 'jarvis', kind: m.kind || 'text', text: m.text || '', buttons: m.buttons || [], src: m.src || '', name: m.name || '', ...(m.card ? { card: m.card } : {}) });
    afterReply?.();
    const buttons = replies.flatMap((m) => (m.buttons || []).map(([label]) => label));
    const said = replies.map((m) => m.say || (m.kind === 'image' ? 'Immagine mostrata a schermo.' : m.kind === 'file' ? 'File pronto a schermo.' : '')).filter(Boolean).join(' ');
    return `${said || 'Fatto.'}${buttons.length ? ` Pulsanti a schermo per Riccardo: ${buttons.join(', ')}.` : ''}`;
  }
  if (name === 'mostra') {
    const shown = showHandler?.(String(params.cosa || ''));
    if (!shown) return 'Questo elenco non so aprirlo a schermo: chiedilo con chiedi_a_jarvis.';
    push({ role: 'jarvis', kind: 'text', text: shown.say });
    if (!inline) sheet.hidden = true; // l'elenco è sulla home; il dialogo continua, la barra in basso riapre la conversazione
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
  if (inline) chatOn();
  try { userSays?.(clean); } catch { /* solo grafica */ }
  if (brief) {
    push({ role: 'user', text: clean });
    if (END_WORDS.test(clean) || STOP_WORDS.test(clean)) { await endBriefing('Va bene, chiudo il briefing. Il resto lo trovi qui in alto quando vuoi.'); return; }
    if (SKIP_WORDS.test(clean)) { await nextBrief(); return; }
    // «sì», «no», «la seconda», «manda»: valgono come il tocco sui pulsanti della decisione in corso.
    await exchange({ text: clean, choose: brief.current?.buttons || [] });
    return;
  }
  if (BRIEF_WORDS.test(clean)) { push({ role: 'user', text: clean }); await startBriefing(); return; }
  if (spoken && handsFree && STOP_WORDS.test(clean)) {
    handsFree = false; syncToggles(); push({ role: 'user', text: clean });
    push({ role: 'jarvis', kind: 'text', text: 'Va bene, smetto di ascoltare. Sono qui se ti servo.' });
    await say('Va bene. Sono qui se ti servo.'); setPhase('idle');
    if (woken) closeChat();
    return;
  }
  push({ role: 'user', text: clean });
  // «Mostrami le pratiche chiuse», «quali locali…»: l'elenco si apre a schermo, senza chiamare Jarvis.
  const shown = showHandler?.(clean);
  if (shown) {
    push({ role: 'jarvis', kind: 'text', text: shown.say });
    handsFree = false; stopListening();
    if (!inline) sheet.hidden = true;
    if (live) { live.context(`A schermo: ${shown.say}`); return; }
    await say(shown.say, { always: true });
    setPhase('idle');
    closeHandler?.();
    return;
  }
  await exchange({ text: clean });
}
function markUsed(data) {
  const owner = [...history].reverse().find((e) => !e.used && e.buttons?.some(([, d]) => d === data));
  if (owner) { owner.used = true; saveHistory(history); renderLog(false); }
}
async function press(data, trigger) {
  if (busy) return;
  stopListening();
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
    for (const m of replies) push({ role: 'jarvis', kind: m.kind || 'text', text: m.text || '', buttons: m.buttons || [], src: m.src || '', name: m.name || '', ...(m.card ? { card: m.card } : {}) });
    if (result?.pressed) markUsed(result.pressed);
    busy = false;
    afterReply?.();
    if (brief) { await briefAfter(replies); return; }
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
    if (brief) { await endBriefing(''); return; }
    if (!live) setPhase('idle');
  }
}

// ——— briefing a voce ———
/** Jarvis legge le decisioni pronte una alla volta; si risponde a voce o con i pulsanti. */
export async function startBriefing() {
  if (busy || live || !sheet) return;
  busy = true; stopSpeaking(); stopListening();
  setPhase('thinking', 'Preparo il briefing…');
  let items = [];
  try { items = (await jarvisReady())?.items || []; } catch (error) {
    busy = false;
    push({ role: 'jarvis', kind: 'note', text: error?.message || 'Non riesco a leggere le decisioni adesso: riprova tra poco.' });
    setPhase('idle');
    return;
  }
  busy = false;
  afterReply?.();
  const ready = items.filter((item) => item.buttons?.length).slice(0, BRIEF_MAX);
  if (!ready.length) {
    const text = 'Niente da decidere adesso, Riccardo: quello che potevo preparare è pronto e il resto aspetta i locali.';
    push({ role: 'jarvis', kind: 'text', text });
    await say(text, { always: true });
    setPhase('idle');
    return;
  }
  brief = { queue: ready, current: null, n: 0, total: ready.length, hands: handsFree };
  handsFree = true; quietTurns = 0; syncToggles(); unlockEar();
  const intro = `Briefing: ${ready.length === 1 ? 'c’è una cosa' : `ci sono ${ready.length} cose`} da decidere. Rispondimi «sì» o «no», «salta» per passare alla prossima, «basta» per finire. Pubblicare resta un tocco sul pulsante.`;
  push({ role: 'jarvis', kind: 'text', text: intro });
  await say(intro, { always: true });
  await nextBrief();
}
async function nextBrief() {
  if (!brief) return;
  const item = brief.queue.shift();
  if (!item) { await endBriefing('Briefing finito: per ora è tutto. Sono qui se ti serve altro.'); return; }
  brief.n += 1;
  brief.current = item;
  push({ role: 'jarvis', kind: 'text', text: item.text, buttons: item.buttons, brief: `${brief.n} di ${brief.total}` });
  await say(`${brief.n === brief.total && brief.n > 1 ? 'Ultima' : brief.n === 1 ? 'Prima' : `Numero ${brief.n}`}. ${item.say || item.text}`, { always: true });
  if (!brief || phase === 'listening' || busy) return;
  await pause(350);
  if (brief && phase !== 'listening' && !busy) listen();
}
// Dopo una risposta di Jarvis nel briefing: se chiede ancora qualcosa (un SÌ, un riepilogo) si resta lì, se no si va avanti.
async function briefAfter(replies) {
  const ask = replies.find((m) => m.buttons?.length);
  const words = replies.map((m) => m.say).filter(Boolean).join(' ').slice(0, 900);
  if (ask) {
    brief.current = { text: ask.text, buttons: ask.buttons };
    await say(words, { always: true });
    if (brief && phase !== 'listening' && !busy) { await pause(350); listen(); }
    return;
  }
  if (words) await say(words, { always: true });
  await pause(250);
  await nextBrief();
}
async function endBriefing(text) {
  const hands = Boolean(brief?.hands);
  brief = null;
  handsFree = hands; syncToggles(); stopListening();
  if (text) { push({ role: 'jarvis', kind: 'text', text }); await say(text, { always: true }); }
  setPhase('idle');
}
/** Briefing in corso? (la home non lo interrompe con i suoi aggiornamenti) */
export const briefing = () => Boolean(brief);
/** La home vuole sapere quando Jarvis ha risposto (per rileggere «Pronto per te»). */
export function onJarvisReply(fn) { afterReply = fn; }
/** La home vuole sapere cosa dice Riccardo (per agganciare il locale sulla mappa). */
export function onUserSays(fn) { userSays = fn; }
function chatOn() { if (globalThis.document) document.documentElement.dataset.chatOn = '1'; }

function onClick(event) {
  if (event.target.closest('[data-chat-brief]')) { if (brief) endBriefing('Va bene, chiudo il briefing.'); else startBriefing(); return; }
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
export function openChat(element, { voice = false, bot = '', listenNow = false, onShow = null, onClose = null, wake = false, firstText = '', inline: embedded = false, intro = null, focus = true } = {}) {
  showHandler = onShow; closeHandler = onClose; woken = Boolean(wake);
  // Passando dalla home al foglio (o viceversa) il vecchio contenitore si svuota: una sola conversazione a schermo.
  if (sheet && sheet !== element && !inline) sheet.hidden = true;
  if (sheet && sheet !== element) sheet.innerHTML = '';
  inline = Boolean(embedded); introHtml = intro;
  sheet = element;
  if (!bound.has(element)) {
    bound.add(element);
    element.addEventListener('click', onClick);
    element.addEventListener('change', onChange);
    element.addEventListener('submit', onSubmit);
    // Quando scrivi nella home il reattore si fa piccolo e la conversazione sale (vedi jarvis-hud.css).
    element.addEventListener('focusin', (event) => { if (inline && event.target.matches?.('input[name="text"]')) chatOn(); });
  }
  voiceReady = Boolean(voice); telegramBot = bot || '';
  render();
  sheet.hidden = false;
  if (live) return;
  // Svegliato a voce o dal nucleo: conversazione a mani libere, finché Riccardo non dice «basta».
  if (wake) { handsFree = true; quietTurns = 0; syncToggles(); unlockEar(); }
  if (firstText) { send(firstText, { spoken: true }); return; }
  if (listenNow) listen(); else if (focus) sheet.querySelector('input[name="text"]')?.focus({ preventScroll: inline });
}
/** La conversazione è aperta dentro questo contenitore? */
export const chatIn = (element) => sheet === element && !sheet.hidden;
export function closeChat() {
  brief = null;
  stopLiveDialog();
  handsFree = false;
  stopListening(); stopSpeaking();
  setPhase('idle');
  const wasOpen = sheet && !sheet.hidden;
  if (sheet && !inline) sheet.hidden = true;
  woken = false;
  if (wasOpen) closeHandler?.();
}

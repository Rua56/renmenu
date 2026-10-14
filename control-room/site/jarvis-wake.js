/* «Ehi Jarvis»: con la Control Room aperta e in primo piano, il riconoscimento vocale del browser resta in
 * ascolto della parola di sveglia. Quando la sente apre la conversazione a mani libere; se dopo «Ehi Jarvis»
 * c'è già una richiesta («Ehi Jarvis, mostrami i numeri») la passa subito. Gratis: usa il riconoscimento
 * del browser (Chrome lo fa sui server di Google), mai la trascrizione di RenMenu. Si ferma quando la pagina
 * va in secondo piano, mentre la conversazione è aperta e se Riccardo lo spegne. */
const Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
const KEY = 'jarvis-wake';
// «Ehi Jarvis», «Hey Jarvis», «Ok Jarvis», o «Jarvis» a inizio frase. Il riconoscimento italiano a volte
// scrive «giarvis», «jervis», «gervis».
const NAME = '(?:jarvis|giarvis|jarvi|jervis|gervis|jarviss)';
const WAKE = new RegExp(`(?:^|\\b(?:e?hey|ehi|ehy|hei|ei|ok|okay|ciao|ehilà)[,!\\s]+)${NAME}\\b[,.!?\\s]*(.*)$`, 'i');

export const wakeAvailable = Boolean(Recognition);

/** La frase contiene la sveglia? Restituisce null oppure { rest } con quello che segue «Jarvis». */
export function wakeHeard(text) {
  const match = String(text || '').trim().match(WAKE);
  return match ? { rest: match[1].trim().replace(/^[,.!?\s]+/, '') } : null;
}

const local = {
  get() { try { return globalThis.localStorage?.getItem(KEY) ?? 'si'; } catch { return 'si'; } },
  set(value) { try { globalThis.localStorage?.setItem(KEY, value); } catch { /* va bene lo stesso */ } }
};
export const wakeEnabled = () => wakeAvailable && local.get() !== 'no';

let wanted = false;
let paused = false;
let instance = null;
let handler = null;
let notify = () => {};
let state = 'off'; // off | listening | blocked | paused
let restartTimer = 0;
let fireTimer = 0;
let failures = 0;

function setState(next) { if (state !== next) { state = next; notify(next); } }
export const wakeState = () => state;

function kill() {
  clearTimeout(restartTimer); clearTimeout(fireTimer);
  if (!instance) return;
  const old = instance; instance = null;
  old.onresult = null; old.onerror = null; old.onend = null;
  try { old.abort(); } catch { /* già fermo */ }
}
function fire(rest) {
  kill();
  paused = true; setState('paused');
  handler?.(rest);
}
function begin() {
  if (!wanted || paused || instance || globalThis.document?.hidden) return;
  const rec = new Recognition();
  instance = rec;
  rec.lang = 'it-IT'; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 3;
  rec.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      for (let a = 0; a < result.length; a += 1) {
        const heard = wakeHeard(result[a]?.transcript);
        if (!heard) continue;
        failures = 0;
        // Frase finita: si parte subito. Ancora in corso: si aspetta un attimo il resto della richiesta.
        if (result.isFinal) { fire(heard.rest); return; }
        clearTimeout(fireTimer);
        fireTimer = setTimeout(() => fire(heard.rest), 1400);
        return;
      }
    }
  };
  rec.onerror = (event) => {
    if (instance !== rec) return;
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') { wanted = false; kill(); setState('blocked'); return; }
    if (event.error !== 'no-speech' && event.error !== 'aborted') failures += 1;
  };
  rec.onend = () => {
    if (instance !== rec) return;
    instance = null;
    // Il browser chiude l'ascolto continuo dopo un po' di silenzio: si riapre, rallentando se continua a fallire.
    if (wanted && !paused) restartTimer = setTimeout(begin, Math.min(30_000, 300 + failures * failures * 1000));
  };
  try { rec.start(); setState('listening'); } catch { instance = null; restartTimer = setTimeout(begin, 2000); }
}

/** Accende l'ascolto della sveglia. onWake(rest) riceve quello che è stato detto dopo «Jarvis». */
export function startWake({ onWake, onState } = {}) {
  if (!wakeEnabled()) { setState('off'); return false; }
  if (onWake) handler = onWake;
  if (onState) notify = onState;
  wanted = true; paused = false; failures = 0;
  begin();
  return true;
}
/** Mette in pausa (conversazione aperta): il microfono serve alla conversazione. */
export function pauseWake() { paused = true; kill(); if (wanted) setState('paused'); }
/** Riprende dopo la conversazione. */
export function resumeWake() { if (!wanted) return; paused = false; begin(); }
export function stopWake() { wanted = false; kill(); setState('off'); }
export function setWakeEnabled(on) {
  local.set(on ? 'si' : 'no');
  if (on) startWake(); else stopWake();
}

globalThis.document?.addEventListener('visibilitychange', () => {
  if (globalThis.document.hidden) kill(); else if (wanted && !paused) begin();
});

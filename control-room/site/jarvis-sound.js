/* Suoni HUD di Jarvis: bip brevi e bassi generati dal browser (nessun file, nessun costo). Toccare una
 * schermata, Jarvis che comincia ad ascoltare, la sveglia «Ehi Jarvis», una novità nel registro. Si spengono
 * da «Collegamenti e voce di Jarvis»; i telefoni li lasciano suonare solo dopo il primo tocco. */
const KEY = 'jarvis-sounds';
const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
let ctx = null;

export const soundsAvailable = Boolean(Ctx);
export function soundsOn() {
  if (!Ctx) return false;
  try { return globalThis.localStorage?.getItem(KEY) !== 'no'; } catch { return true; }
}
export function setSounds(on) {
  try { globalThis.localStorage?.setItem(KEY, on ? 'si' : 'no'); } catch { /* ok */ }
  if (on) play('done');
}

// Ogni suono: note [frequenza Hz, inizio s, durata s], forma d'onda e volume.
const SOUNDS = {
  tap: { wave: 'sine', gain: 0.035, notes: [[1320, 0, 0.05]] },
  open: { wave: 'sine', gain: 0.04, notes: [[880, 0, 0.06], [1320, 0.06, 0.08]] },
  listen: { wave: 'sine', gain: 0.05, notes: [[660, 0, 0.07], [990, 0.07, 0.1]] },
  wake: { wave: 'triangle', gain: 0.05, notes: [[523, 0, 0.08], [784, 0.08, 0.08], [1047, 0.16, 0.14]] },
  done: { wave: 'sine', gain: 0.04, notes: [[1047, 0, 0.06], [784, 0.07, 0.1]] },
  news: { wave: 'triangle', gain: 0.03, notes: [[1568, 0, 0.04], [1568, 0.08, 0.04]] }
};

function context() {
  if (!Ctx) return null;
  if (!ctx) { try { ctx = new Ctx(); } catch { return null; } }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}
/** Suona un bip HUD (se i suoni sono accesi e la pagina è in primo piano). */
export function play(name) {
  const sound = SOUNDS[name];
  if (!sound || !soundsOn() || globalThis.document?.hidden) return;
  const audio = context();
  if (!audio) return;
  // Appena sbloccato dal primo tocco l'audio può essere ancora in avvio: suona appena è pronto.
  if (audio.state !== 'running') { audio.resume().then(() => { if (audio.state === 'running') notes(audio, sound); }).catch(() => {}); return; }
  notes(audio, sound);
}
function notes(audio, sound) {
  const start = audio.currentTime + 0.01;
  for (const [freq, at, length] of sound.notes) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = sound.wave; osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, start + at);
    gain.gain.linearRampToValueAtTime(sound.gain, start + at + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + at + length);
    osc.connect(gain).connect(audio.destination);
    osc.start(start + at); osc.stop(start + at + length + 0.02);
  }
}

// I telefoni sbloccano l'audio solo dentro un tocco: il primo tocco lo prepara.
globalThis.document?.addEventListener('pointerdown', () => { if (soundsOn()) context(); }, { capture: true, passive: true });
// Il reattore dice cosa fa Jarvis (html[data-jarvis]): quando comincia ad ascoltare, un bip.
const root = globalThis.document?.documentElement;
if (root && globalThis.MutationObserver) {
  let last = root.dataset.jarvis || 'idle';
  new MutationObserver(() => {
    const now = root.dataset.jarvis || 'idle';
    if (now === 'listening' && last !== 'listening') play('listen');
    last = now;
  }).observe(root, { attributes: true, attributeFilter: ['data-jarvis'] });
}

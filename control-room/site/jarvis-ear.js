/* Orecchio di Jarvis nella Control Room: registra dal microfono solo mentre ascolta, capisce da solo
 * quando hai finito di parlare (un attimo di silenzio dopo la voce) e restituisce l'audio in WAV 16 kHz,
 * che Jarvis trascrive con Whisper su Workers AI (gratis). Il microfono si chiude a ogni turno, così la
 * voce di Jarvis esce a volume pieno.
 * Dopo che il telefono ha parlato, iPhone a volte mette l'audio «in pausa» o fa arrivare solo silenzio
 * dal microfono: l'orecchio se ne accorge da solo (orologio vero, non solo i campioni audio), riapre
 * l'audio da zero e riprova; se proprio non sente nulla lo dice invece di restare appeso. */
const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
export const earAvailable = Boolean(globalThis.navigator?.mediaDevices?.getUserMedia && Context);

let ctx = null;
let current = null; // turno di ascolto in corso: { finish(keep) }
let generation = 0; // cresce a ogni stopHearing: un ascolto ancora in apertura sa che è stato annullato
const STUCK = Symbol('stuck');
const NO_FRAMES_MS = 2500;

/** Da chiamare dentro il tocco dell'utente: iPhone fa partire l'audio solo da un gesto. */
export function unlockEar() {
  if (!Context) return;
  if (!ctx || ctx.state === 'closed') ctx = new Context();
  if (ctx.state !== 'running') ctx.resume().catch(() => {});
}

/** Chiude l'ascolto in corso: keep=true manda ciò che ha sentito, keep=false lo butta. */
export function stopHearing(keep = true) {
  if (!keep) generation += 1;
  current?.finish(keep);
}

function resetContext() {
  const old = ctx;
  ctx = null;
  try { old?.close(); } catch { /* già chiuso */ }
}
const within = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);

/**
 * Ascolta una frase. Restituisce un Blob WAV, oppure null se non hai parlato (o se l'ascolto è stato
 * annullato). Se il microfono non manda audio nemmeno dopo aver riaperto tutto, lancia un errore EarStuck.
 * onLevel(0..1) serve all'animazione; i tempi sono in millisecondi.
 */
export async function hear(options = {}) {
  stopHearing(false);
  const mine = generation;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await hearOnce(options, mine);
    if (result !== STUCK) return result;
    if (mine !== generation) return null;
    resetContext();
  }
  const error = new Error('Il microfono non manda audio.');
  error.name = 'EarStuck';
  throw error;
}

async function hearOnce({ onLevel = () => {}, waitMs = 8000, silenceMs = 1100, maxMs = 20000 }, mine) {
  unlockEar();
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  if (mine !== generation) { stream.getTracks().forEach((track) => track.stop()); return null; }
  // iPhone: «interrupted» dopo la voce del telefono; con il microfono acceso il resume è permesso.
  if (ctx.state !== 'running') await within(ctx.resume().catch(() => {}), 800);
  return new Promise((resolve) => {
    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(processor); processor.connect(mute); mute.connect(ctx.destination);
    const rate = ctx.sampleRate, started = performance.now();
    const chunks = [], preroll = [];
    let floor = 0.004, spoke = false, lastVoice = 0, done = false, alive = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      clearInterval(clock);
      if (current?.finish === finish) current = null;
      processor.onaudioprocess = null;
      try { source.disconnect(); processor.disconnect(); mute.disconnect(); } catch { /* già scollegati */ }
      stream.getTracks().forEach((track) => track.stop());
      onLevel(0);
      resolve(keep === STUCK ? STUCK : keep && spoke && chunks.length ? toWav(chunks, rate) : null);
    };
    current = { finish };
    // Orologio vero: se l'audio non arriva (contesto in pausa) o arriva solo silenzio assoluto
    // (microfono «muto» dopo la voce del telefono), il turno non resta appeso.
    const clock = setInterval(() => {
      const now = performance.now();
      if (!alive && now - started > NO_FRAMES_MS) { finish(STUCK); return; }
      if (!spoke && now - started > waitMs + 500) finish(false);
      else if (spoke && (now - lastVoice > silenceMs + 1500 || now - started > maxMs + 500)) finish(true);
    }, 250);
    processor.onaudioprocess = (event) => {
      if (done) return;
      const data = new Float32Array(event.inputBuffer.getChannelData(0));
      let sum = 0;
      for (let i = 0; i < data.length; i += 1) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length), now = performance.now();
      if (sum > 0) alive = true;
      onLevel(Math.min(1, rms * 12));
      const loud = rms > Math.max(0.012, floor * 3);
      if (!spoke) {
        // Prima della voce: impara il rumore di fondo e tiene mezzo secondo da mettere davanti alla frase.
        if (!loud) floor = floor * 0.9 + rms * 0.1;
        preroll.push(data);
        while (preroll.length * data.length > rate * 0.5) preroll.shift();
        if (loud) { spoke = true; lastVoice = now; chunks.push(...preroll); }
        else if (now - started > waitMs) finish(false);
        return;
      }
      chunks.push(data);
      if (loud) lastVoice = now;
      if (now - lastVoice > silenceMs || now - started > maxMs) finish(true);
    };
  });
}

// WAV mono 16 bit a 16 kHz: piccolo e letto bene da Whisper.
function toWav(chunks, rate) {
  const length = chunks.reduce((n, c) => n + c.length, 0);
  const input = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) { input.set(chunk, offset); offset += chunk.length; }
  const target = 16000, ratio = rate / target, out = new Int16Array(Math.floor(length / ratio));
  for (let i = 0; i < out.length; i += 1) {
    const from = Math.floor(i * ratio), to = Math.min(length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = from; j < to; j += 1) sum += input[j];
    const value = to > from ? sum / (to - from) : 0;
    out[i] = Math.max(-1, Math.min(1, value)) * 0x7fff;
  }
  const buffer = new ArrayBuffer(44 + out.length * 2), view = new DataView(buffer);
  const text = (at, s) => { for (let i = 0; i < s.length; i += 1) view.setUint8(at + i, s.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, 36 + out.length * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, target, true); view.setUint32(28, target * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, out.length * 2, true);
  new Int16Array(buffer, 44).set(out);
  return new Blob([buffer], { type: 'audio/wav' });
}

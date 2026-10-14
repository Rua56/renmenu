/* Orecchio di Jarvis nella Control Room: registra dal microfono solo mentre ascolta, capisce da solo
 * quando hai finito di parlare (un attimo di silenzio dopo la voce) e restituisce l'audio in WAV 16 kHz,
 * che Jarvis trascrive con Whisper su Workers AI (gratis). Funziona allo stesso modo su iPhone e Android
 * anche dopo che Jarvis ha parlato: il riconoscimento vocale del browser, invece, spesso si blocca dopo
 * la prima frase. Il microfono si chiude a ogni turno, così la voce di Jarvis esce a volume pieno. */
const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
export const earAvailable = Boolean(globalThis.navigator?.mediaDevices?.getUserMedia && Context);

let ctx = null;
let current = null; // turno di ascolto in corso: { finish(keep) }

/** Da chiamare dentro il tocco dell'utente: iPhone fa partire l'audio solo da un gesto. */
export function unlockEar() {
  if (!Context) return;
  if (!ctx) ctx = new Context();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
}

/** Chiude l'ascolto in corso: keep=true manda ciò che ha sentito, keep=false lo butta. */
export function stopHearing(keep = true) { current?.finish(keep); }

/**
 * Ascolta una frase. Restituisce un Blob WAV, oppure null se non hai parlato.
 * onLevel(0..1) serve all'animazione; i tempi sono in millisecondi.
 */
export async function hear({ onLevel = () => {}, waitMs = 8000, silenceMs = 1100, maxMs = 20000 } = {}) {
  unlockEar();
  stopHearing(false);
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  return new Promise((resolve) => {
    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(processor); processor.connect(mute); mute.connect(ctx.destination);
    const rate = ctx.sampleRate, started = performance.now();
    const chunks = [], preroll = [];
    let floor = 0.004, spoke = false, lastVoice = 0, done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      if (current?.finish === finish) current = null;
      processor.onaudioprocess = null;
      try { source.disconnect(); processor.disconnect(); mute.disconnect(); } catch { /* già scollegati */ }
      stream.getTracks().forEach((track) => track.stop());
      onLevel(0);
      resolve(keep && spoke && chunks.length ? toWav(chunks, rate) : null);
    };
    current = { finish };
    processor.onaudioprocess = (event) => {
      if (done) return;
      const data = new Float32Array(event.inputBuffer.getChannelData(0));
      let sum = 0;
      for (let i = 0; i < data.length; i += 1) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length), now = performance.now();
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

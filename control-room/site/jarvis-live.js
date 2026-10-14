/* Dialogo dal vivo con Jarvis: la Control Room parla con l'agente vocale di ElevenLabs come in una
 * telefonata, ma dal browser. Il microfono resta aperto e Jarvis risponde appena hai finito (puoi anche
 * interromperlo). Audio in PCM 16 kHz su WebSocket; l'indirizzo firmato arriva dal server, che tiene la
 * chiave. Gli strumenti dell'agente (chiedere al Jarvis vero, mostrare un elenco, chiudere) li esegue la
 * pagina con onTool. Consuma minuti ElevenLabs: parte solo da un tocco e si chiude se lasci la pagina. */
const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
export const liveAvailable = Boolean(globalThis.WebSocket && Context && globalThis.navigator?.mediaDevices?.getUserMedia);

const rateOf = (format, fallback) => Number(String(format || '').match(/_(\d{4,6})$/)?.[1]) || fallback;
function toBase64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}
function fromBase64(text) {
  const raw = atob(text), bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
/** Campioni del microfono → PCM 16 bit alla frequenza chiesta dall'agente. */
export function pcm16(input, fromRate, toRate) {
  const ratio = fromRate / toRate, out = new Int16Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i += 1) {
    const from = Math.floor(i * ratio), to = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = from; j < to; j += 1) sum += input[j];
    out[i] = Math.max(-1, Math.min(1, to > from ? sum / (to - from) : 0)) * 0x7fff;
  }
  return out;
}
/** Audio di Jarvis (PCM 16 bit o µ-law) → campioni per Web Audio. */
export function samples(bytes, format) {
  if (/^ulaw/.test(format || '')) {
    return Float32Array.from(bytes, (byte) => {
      const u = ~byte & 0xff, sign = u & 0x80, exponent = (u >> 4) & 7, mantissa = u & 0x0f;
      const value = (((mantissa << 3) + 0x84) << exponent) - 0x84;
      return (sign ? -value : value) / 32768;
    });
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength - (bytes.byteLength % 2));
  const out = new Float32Array(view.byteLength / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

/**
 * Apre il dialogo. Va chiamata dentro il tocco (iPhone sblocca l'audio solo così).
 * session(): Promise<{ url, situation }> dal server. Callback: onState('connecting'|'listening'|'speaking'|'ended', note),
 * onUser(text), onAgent(text), onLevel(0..1), onTool(name, params) → Promise<string>.
 * Restituisce { stop(), context(text) }.
 */
export function startLive({ session, onState = () => {}, onUser = () => {}, onAgent = () => {}, onLevel = () => {}, onTool = async () => '' }) {
  const ctx = new Context();
  ctx.resume?.().catch(() => {});
  let ws = null, stream = null, source = null, processor = null, mute = null;
  let ready = false, ended = false, inputRate = 16000, outputFormat = 'pcm_16000', playHead = 0, speaking = false;
  const playing = new Set();

  const send = (message) => { if (ws?.readyState === 1) ws.send(JSON.stringify(message)); };
  const setSpeaking = (on) => { if (on !== speaking && !ended) { speaking = on; onState(on ? 'speaking' : 'listening'); } };
  function silence() {
    for (const node of playing) { try { node.onended = null; node.stop(); } catch { /* già ferma */ } }
    playing.clear(); playHead = 0; setSpeaking(false);
  }
  function play(base64) {
    const data = samples(fromBase64(base64), outputFormat);
    if (!data.length) return;
    const buffer = ctx.createBuffer(1, data.length, rateOf(outputFormat, 16000));
    buffer.copyToChannel ? buffer.copyToChannel(data, 0) : buffer.getChannelData(0).set(data);
    const node = ctx.createBufferSource();
    node.buffer = buffer; node.connect(ctx.destination);
    const at = Math.max(ctx.currentTime + 0.03, playHead);
    node.start(at); playHead = at + buffer.duration;
    playing.add(node);
    node.onended = () => { playing.delete(node); if (!playing.size) setSpeaking(false); };
    setSpeaking(true);
  }
  function stop(note = '') {
    if (ended) return;
    ended = true;
    silence();
    globalThis.document?.removeEventListener('visibilitychange', onHidden);
    try { processor && (processor.onaudioprocess = null); source?.disconnect(); processor?.disconnect(); mute?.disconnect(); } catch { /* ok */ }
    stream?.getTracks().forEach((track) => track.stop());
    if (ws && ws.readyState <= 1) { try { ws.close(1000); } catch { /* ok */ } }
    ctx.close?.().catch(() => {});
    onLevel(0);
    onState('ended', note);
  }
  // Lasciare la pagina chiude il dialogo: niente minuti consumati a telefono in tasca.
  function onHidden() { if (globalThis.document?.visibilityState === 'hidden') stop('Dialogo chiuso: hai lasciato la pagina.'); }
  globalThis.document?.addEventListener('visibilitychange', onHidden);

  async function onMessage(event) {
    let message; try { message = JSON.parse(event.data); } catch { return; }
    switch (message.type) {
      case 'conversation_initiation_metadata': {
        const meta = message.conversation_initiation_metadata_event || {};
        outputFormat = meta.agent_output_audio_format || outputFormat;
        inputRate = rateOf(meta.user_input_audio_format, 16000);
        ready = true; onState('listening');
        break;
      }
      case 'audio': if (message.audio_event?.audio_base_64) play(message.audio_event.audio_base_64); break;
      case 'interruption': silence(); break;
      case 'ping': {
        const id = message.ping_event?.event_id;
        setTimeout(() => send({ type: 'pong', event_id: id }), Number(message.ping_event?.ping_ms) || 0);
        break;
      }
      case 'user_transcript': { const text = message.user_transcription_event?.user_transcript; if (text) onUser(String(text)); break; }
      case 'agent_response': { const text = message.agent_response_event?.agent_response; if (text) onAgent(String(text)); break; }
      case 'client_tool_call': {
        const call = message.client_tool_call || {};
        let result = '', isError = false;
        try { result = String(await onTool(call.tool_name, call.parameters || {}) ?? ''); } catch (error) { result = String(error?.message || 'Non riuscito.'); isError = true; }
        if (call.expects_response !== false) send({ type: 'client_tool_result', tool_call_id: call.tool_call_id, result: result.slice(0, 4000) || 'Fatto.', is_error: isError });
        break;
      }
      default: break;
    }
  }

  (async () => {
    onState('connecting');
    try {
      const [mic, info] = await Promise.all([
        navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }),
        session()
      ]);
      stream = mic;
      if (ended) { stop(); return; }
      if (ctx.state !== 'running') await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 800))]);
      ws = new WebSocket(info.url);
      ws.onopen = () => send({ type: 'conversation_initiation_client_data', dynamic_variables: { situazione: info.situation || 'Nessuna novità.' } });
      ws.onmessage = onMessage;
      ws.onerror = () => {};
      ws.onclose = (event) => stop(ready ? (event.code === 1000 ? 'Dialogo finito.' : 'Il dialogo si è interrotto.') : `ElevenLabs non ha aperto il dialogo${event.reason ? `: ${String(event.reason).slice(0, 120)}` : '.'}`);
      source = ctx.createMediaStreamSource(stream);
      processor = ctx.createScriptProcessor(4096, 1, 1);
      mute = ctx.createGain(); mute.gain.value = 0;
      source.connect(processor); processor.connect(mute); mute.connect(ctx.destination);
      processor.onaudioprocess = (e) => {
        if (!ready || ended) return;
        const data = e.inputBuffer.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < data.length; i += 1) sum += data[i] * data[i];
        onLevel(Math.min(1, Math.sqrt(sum / data.length) * 12));
        const pcm = pcm16(data, ctx.sampleRate, inputRate);
        send({ user_audio_chunk: toBase64(new Uint8Array(pcm.buffer)) });
      };
    } catch (error) {
      const denied = /denied|allowed|permission/i.test(String(error?.name || error?.message));
      stop(denied ? 'Il microfono è bloccato: consentilo nelle impostazioni del browser.' : String(error?.message || 'Il dialogo non è partito.'));
    }
  })();

  return {
    stop: () => stop('Dialogo chiuso.'),
    /** Informa l'agente senza interromperlo (per esempio un pulsante toccato a schermo). */
    context: (text) => send({ type: 'contextual_update', text: String(text || '').slice(0, 2000) })
  };
}

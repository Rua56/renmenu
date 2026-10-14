// «Parla con Jarvis» dalla Control Room: stesso cervello di Telegram, risposte nella Control Room.
// Jarvis riceve la frase come se arrivasse dalla chat di Riccardo; i messaggi che manderebbe a
// Telegram vengono intercettati qui (non partono) e tornati alla pagina: testo, pulsanti, immagini
// (QR) e file. Tutto il resto (Gemini, Workers AI, ElevenLabs, renmenu.com) passa dalla rete vera.
const TG = 'https://api.telegram.org/';
const MAX_INLINE = 400_000;

function base64(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}
async function inlineFile(file) {
  if (!file || typeof file.arrayBuffer !== 'function' || file.size > MAX_INLINE) return null;
  return `data:${file.type || 'application/octet-stream'};base64,${base64(await file.arrayBuffer())}`;
}
const json = (body) => { try { return JSON.parse(typeof body === 'string' ? body : '{}'); } catch { return {}; } };

/** fetch che trattiene le chiamate a Telegram e raccoglie in `messages` ciò che Jarvis avrebbe mandato. */
export function telegramCapture(realFetch) {
  const messages = [];
  async function fetchImpl(input, init = {}) {
    const url = String(input?.url || input);
    if (!url.startsWith(TG)) return realFetch(input, init);
    const method = url.split('?')[0].split('/').pop();
    const form = init.body instanceof FormData ? init.body : null;
    const caption = String(form?.get('caption') || '');
    if (method === 'sendMessage') {
      const body = json(init.body);
      const buttons = (body.reply_markup?.inline_keyboard || []).flat().map((b) => [String(b.text || ''), String(b.callback_data || '')]).filter(([, data]) => data);
      messages.push({ kind: 'text', text: String(body.text || ''), buttons });
    } else if (method === 'answerCallbackQuery') {
      const text = String(json(init.body).text || '');
      if (text) messages.push({ kind: 'note', text });
    } else if (method === 'sendPhoto' && form) {
      messages.push({ kind: 'image', text: caption, src: await inlineFile(form.get('photo')) });
    } else if (method === 'sendDocument' && form) {
      const file = form.get('document');
      messages.push({ kind: 'file', text: caption, name: String(file?.name || 'file'), src: await inlineFile(file) });
    }
    // sendVoice: la Control Room dice la risposta da sé (voce del browser o di Jarvis, a scelta).
    return new Response(JSON.stringify({ ok: true, result: { message_id: 0 } }), { headers: { 'Content-Type': 'application/json' } });
  }
  return { fetchImpl, messages };
}

/** Testo da dire a voce: senza la trascrizione «…» iniziale, senza link e simboli. */
export function spokenText(text) {
  return String(text || '').replace(/^«[\s\S]*?»\n\n/, '').replace(/https?:\/\/\S+/g, '').replace(/[•▸→*_#]/g, ' ')
    .replace(/\s*\n+\s*/g, '. ').replace(/\.\s*\./g, '.').replace(/\s+/g, ' ').trim().slice(0, 900);
}

import { loadDemoState, performDemoAction, uploadDemoFile } from './demo-store.js';

const hostname = String(globalThis.location?.hostname || '').toLowerCase();
const demoRequested = new URLSearchParams(globalThis.location?.search || '').get('demo') === '1';
export const isDemoMode = (hostname === 'localhost' || hostname === '127.0.0.1') && demoRequested;
export const isAuthorizedHost = hostname === 'localhost' || hostname === '127.0.0.1'
  || hostname === 'renmenu-jarvis-stage.pages.dev'
  || /^[a-z0-9-]+\.renmenu-jarvis-stage\.pages\.dev$/.test(hostname);
export const modeLabel = isDemoMode ? 'DEMO LOCALE' : 'API PRIVATA';

function requireAuthorizedHost() {
  if (!isAuthorizedHost) {
    const error = new Error('Control Room non disponibile su questa origine.');
    error.status = 403;
    throw error;
  }
}

async function parseResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json().catch(() => ({})) : {};
  if (!response.ok) {
    const error = new Error(payload.error || `Richiesta non riuscita (${response.status}).`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

/** Contract: never invokes fetch while local demo is active. */
export async function loadState() {
  requireAuthorizedHost();
  if (isDemoMode) return loadDemoState();
  const response = await fetch('/control-room/api/state', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
  return parseResponse(response);
}

/** Contract: POST JSON /actions in live; localStorage transaction in demo. */
export async function performAction(type, payload = {}) {
  requireAuthorizedHost();
  if (isDemoMode) return performDemoAction(type, payload);
  const response = await fetch('/control-room/api/actions', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ type, payload })
  });
  return parseResponse(response);
}

/** Contract: material bytes are handled only by private same-origin API in live. */
export async function uploadFile(requestId, file) {
  requireAuthorizedHost();
  if (isDemoMode) return uploadDemoFile(requestId, file);
  const body = new FormData();
  body.append('requestId', requestId);
  body.append('file', file);
  const response = await fetch('/control-room/api/material', { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' }, body });
  return parseResponse(response);
}

/** Copia ridotta di una foto per il menu (fatta nel browser): resta privata finché non la confermi. */
export async function uploadMediaImage(mediaId, blob) {
  requireAuthorizedHost();
  if (isDemoMode) throw new Error('La demo non carica foto.');
  const response = await fetch(`/control-room/api/media/${encodeURIComponent(mediaId)}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': blob.type, Accept: 'application/json' }, body: blob });
  return parseResponse(response);
}

/** «Parla con Jarvis»: la frase va al cervello di Jarvis (lo stesso di Telegram), le risposte tornano qui. */
export async function askJarvis(payload) {
  requireAuthorizedHost();
  if (isDemoMode) {
    const text = payload.press ? 'Demo: pulsante ricevuto, nessuna azione eseguita.' : `Demo: ho capito «${String(payload.text || '').slice(0, 120)}». Nella Control Room vera ti risponde Jarvis con lo stesso cervello di Telegram.`;
    return { messages: [{ kind: 'text', text, say: text, buttons: payload.press ? [] : [['Va bene', 'demo:ok']] }] };
  }
  const response = await fetch('/control-room/api/jarvis/ask', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload)
  });
  return parseResponse(response);
}

/** Frase detta al microfono (WAV) → testo, trascritto da Jarvis con Whisper (Workers AI, gratis). */
export async function transcribeVoice(blob) {
  requireAuthorizedHost();
  if (isDemoMode) return '';
  const response = await fetch('/control-room/api/jarvis/hear', {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'audio/wav', Accept: 'application/json' }, body: blob
  });
  return String((await parseResponse(response))?.text || '').trim();
}

/** Voce di Jarvis (ElevenLabs) per una risposta. null se non è configurata o non risponde. */
export async function jarvisVoiceAudio(text) {
  requireAuthorizedHost();
  if (isDemoMode) return null;
  const response = await fetch('/control-room/api/jarvis/voice', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text })
  });
  if (response.status !== 200 || !(response.headers.get('content-type') || '').startsWith('audio/')) return null;
  return response.blob();
}

/** A mock must not expose a pseudo URL for a material. */
export function getMaterialUrl(id) {
  if (!isAuthorizedHost) return null;
  if (isDemoMode) return null;
  return `/control-room/api/material/${encodeURIComponent(id)}`;
}

const previewMimeAllowlist = new Set([
  'application/pdf', 'image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp',
  'text/csv', 'text/markdown', 'text/plain'
]);
const SYNTHETIC_PDF_ID = '5eae22bc-7a50-4bd2-8b8a-000000000403';

/** Only inert document/image MIME types are rendered in the private viewer. */
export function isPreviewableMime(mime) {
  return previewMimeAllowlist.has(String(mime || '').split(';', 1)[0].trim().toLowerCase());
}

/**
 * Fetches a private material only from the same-origin protected endpoint.
 * The caller receives a Blob, never an R2 URL; demos deliberately have no bytes.
 */
export async function fetchMaterialPreview(id) {
  requireAuthorizedHost();
  if (isDemoMode) {
    if (id !== SYNTHETIC_PDF_ID) throw new Error('La demo conserva solo metadati degli upload: nessuna anteprima binaria è disponibile.');
    const response = await fetch('/control-room/site/demo-assets/menu-fittizio-demo.pdf', { credentials: 'same-origin' });
    if (!response.ok) throw new Error('PDF fittizio non disponibile in questa demo locale.');
    const blob = await response.blob();
    if (!blob.size || blob.size > 10 * 1024 * 1024) throw new Error('Dimensione PDF fittizio non valida.');
    return { blob: new Blob([blob], { type: 'application/pdf' }), mime: 'application/pdf', synthetic: true };
  }
  const url = getMaterialUrl(id);
  if (!url) throw new Error('Anteprima privata non disponibile.');
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: { Accept: 'application/pdf,image/avif,image/gif,image/jpeg,image/png,image/webp,text/plain,text/csv,text/markdown' }
  });
  if (!response.ok) {
    const error = new Error(response.status === 404 ? 'Materiale non disponibile o archiviato.' : `Anteprima non disponibile (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  const mime = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  if (!isPreviewableMime(mime)) throw new Error('Questo tipo di file non può essere mostrato nel viewer privato.');
  if (Number(response.headers.get('content-length') || 0) > 10 * 1024 * 1024) throw new Error('Materiale troppo grande per il viewer privato.');
  const blob = await response.blob();
  if (!blob.size || blob.size > 10 * 1024 * 1024) throw new Error('Materiale privato vuoto o troppo grande.');
  return { blob, mime };
}

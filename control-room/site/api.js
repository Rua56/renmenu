import { loadDemoState, performDemoAction, uploadDemoFile } from './demo-store.js';

const hostname = String(globalThis.location?.hostname || '').toLowerCase();
const demoRequested = new URLSearchParams(globalThis.location?.search || '').get('demo') === '1';
export const isDemoMode = (hostname === 'localhost' || hostname === '127.0.0.1') && demoRequested;
export const isAuthorizedHost = hostname === 'localhost' || hostname === '127.0.0.1'
  || hostname === 'renmenu.pages.dev' || hostname.endsWith('.renmenu.pages.dev');
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

/** A mock must not expose a pseudo URL for a material. */
export function getMaterialUrl(id) {
  if (!isAuthorizedHost) return null;
  if (isDemoMode) return null;
  return `/control-room/api/material/${encodeURIComponent(id)}`;
}

// Foto delle bottiglie dai siti delle cantine (2026-10-14, scelta di Baffone: «Anche dalle cantine»).
// Per i vini Premium senza foto Jarvis cerca con Google (Gemini gratuito con ricerca) la pagina del vino
// sul sito della cantina, prende le immagini della pagina e tiene SOLO quella in cui il modello delle foto
// riconosce una bottiglia con l'etichetta di quel vino. La foto diventa una «Foto per il menu» proposta,
// con l'indirizzo della fonte: entra nel menu solo se Riccardo la conferma (e ha verificato di poterla usare).
import { menuSlots, slotFrequencies, slotScore } from './media.js';

export const CANTINA_SOURCE = 'sito_cantina';
export const PER_ROUND = 3;
const MAX_PAGES = 3, MAX_IMAGES = 2, MAX_BYTES = 4_000_000, MAX_HTML = 1_500_000;
const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const SKIP_IMG = /logo|icon|sprite|banner|placeholder|avatar|flag|bandier|social|facebook|instagram|payment|pagament|cookie|loader|spinner|header|footer|bg[-_]|background|award|medaglia|premio/i;
const SEARCH_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'];

const norm = (v) => String(v || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const words = (v) => norm(v).split(' ').filter((w) => w.length >= 3 && !['doc', 'docg', 'igt', 'vino', 'the', 'and'].includes(w));
const text = (v) => (v == null ? '' : typeof v === 'string' ? v : v.it || Object.values(v)[0] || '');

/** Vini della bozza ancora senza foto (e non già cercati). */
export function winesWithoutPhoto(menu, done = []) {
  const skip = new Set(done.map(norm));
  return menuSlots(menu).filter((slot) => {
    if (!slot.wine || skip.has(norm(slot.name))) return false;
    const m = /^voce:(\d+):(\d+)$/.exec(slot.target);
    return !menu.sezioni[Number(m[1])].voci[Number(m[2])].foto;
  });
}

/** Indirizzo pubblico https (niente IP, localhost o porte strane). */
export function publicHttps(raw) {
  try {
    const url = new URL(String(raw || '').trim());
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
    if (/^(?:localhost|.*\.local|.*\.internal|\d+\.\d+\.\d+\.\d+|\[.*\])$/i.test(url.hostname) || !url.hostname.includes('.')) return null;
    url.hash = '';
    return url.toString();
  } catch { return null; }
}

/** Gemini con la ricerca Google: pagine dove si vede la bottiglia di questo vino. */
export async function searchWinePages(gemini, slot, { fetchImpl = globalThis.fetch, timeoutMs = 25_000 } = {}) {
  if (!gemini?.key) return [];
  const prompt = [
    `Cerca sul web la pagina del vino «${slot.name}»${slot.section ? ` (carta dei vini, sezione «${slot.section}»)` : ''} sul sito ufficiale della cantina che lo produce.`,
    'Se il sito della cantina non ha una pagina del vino, va bene la scheda di un\'enoteca online dove si vede la foto della bottiglia.',
    'Rispondi solo con JSON: {"pagine": ["https://…"]}, al massimo 3 indirizzi, il sito della cantina per primo. Non inventare indirizzi: solo pagine trovate con la ricerca.'
  ].join('\n');
  const models = [...new Set([...SEARCH_MODELS.filter((m) => gemini.models?.includes(m)), ...SEARCH_MODELS])];
  for (const model of models.slice(0, 2)) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => controller?.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': gemini.key }, signal: controller?.signal,
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], tools: [{ google_search: {} }], generationConfig: { temperature: 0.1, maxOutputTokens: 600 } })
      });
      if (!response.ok) continue;
      const data = await response.json();
      const candidate = data?.candidates?.[0] || {};
      const raw = (candidate.content?.parts || []).map((p) => p.text || '').join('');
      let fromText = [];
      try { const s = raw.indexOf('{'), e = raw.lastIndexOf('}'); fromText = s >= 0 ? JSON.parse(raw.slice(s, e + 1)).pagine || [] : []; } catch { fromText = []; }
      // Le fonti vere della ricerca (anche se il testo è sbagliato): indirizzi di rimando di Google verso le pagine.
      const grounded = (candidate.groundingMetadata?.groundingChunks || []).map((c) => c?.web?.uri).filter(Boolean);
      const pages = [...new Set([...fromText, ...grounded].map(publicHttps).filter(Boolean))].slice(0, MAX_PAGES);
      if (pages.length) return pages;
    } catch { /* modello successivo */ } finally { clearTimeout(timer); }
  }
  return [];
}

// «%» non valido nell'indirizzo di un'immagine (succede sui siti veri): decodeURIComponent lancerebbe un errore.
const safeDecode = (v) => { try { return decodeURIComponent(v); } catch { return v; } };

/** Immagini della pagina che possono essere la bottiglia: og:image e <img> che nominano il vino. */
export function imageCandidates(html, pageUrl, wineName) {
  const want = words(wineName);
  const out = new Map();
  const add = (src, alt, bonus) => {
    let url;
    try { url = publicHttps(new URL(String(src || '').replace(/&amp;/g, '&').trim(), pageUrl).toString()); } catch { url = null; }
    if (!url || /\.svg(?:\?|$)|\.gif(?:\?|$)|^data:/i.test(url) || SKIP_IMG.test(`${url} ${alt || ''}`)) return;
    const hay = norm(`${safeDecode(url.split('?')[0]).split('/').slice(-2).join(' ')} ${alt || ''}`);
    const hits = want.filter((w) => hay.includes(w)).length;
    const score = bonus + hits * 2 + (/bottigli|bottle|flasche|packshot|etichett/.test(hay) ? 1 : 0);
    if (score > (out.get(url) ?? -1)) out.set(url, score);
  };
  const doc = String(html || '').slice(0, MAX_HTML);
  for (const m of doc.matchAll(/<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image)["'][^>]*>/gi)) {
    const c = /content=["']([^"']+)["']/i.exec(m[0]); if (c) add(c[1], '', 2);
  }
  for (const m of doc.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = (/\b(?:data-src|data-lazy-src|data-large_image|src)=["']([^"']+)["']/i.exec(tag) || [])[1];
    const alt = (/\balt=["']([^"']*)["']/i.exec(tag) || [])[1] || '';
    if (src) add(src, alt, 0);
  }
  return [...out.entries()].filter(([, s]) => s >= 2).sort((a, b) => b[1] - a[1]).slice(0, MAX_IMAGES).map(([url]) => url);
}

const sniff = (b) => (b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : b[0] === 0x89 && b[1] === 0x50 ? 'image/png' : b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 ? 'image/webp' : '');
async function fetchLimited(url, fetchImpl, max, accept) {
  const response = await fetchImpl(url, { headers: { accept, 'user-agent': 'Mozilla/5.0 (compatible; RenMenu-Jarvis/1.0; +https://renmenu.com)' }, redirect: 'follow' });
  if (!response.ok) return null;
  const length = Number(response.headers.get('content-length') || 0);
  if (length > max) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  return bytes.length > max ? null : { bytes, type: (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(), finalUrl: response.url || url };
}

/**
 * Cerca la bottiglia di un vino. classify(bytes, mime) è il riconoscimento delle foto (Workers AI).
 * Restituisce { found: { bytes, mime, page, image, seen } } oppure { reason }.
 */
export async function findBottle(gemini, slot, df, { classify, fetchImpl = globalThis.fetch } = {}) {
  const pages = await searchWinePages(gemini, slot, { fetchImpl });
  if (!pages.length) return { reason: 'nessuna pagina trovata' };
  let tried = 0;
  for (const page of pages) {
    let html;
    try { html = await fetchLimited(page, fetchImpl, MAX_HTML, 'text/html'); } catch { html = null; }
    if (!html || !/html/.test(html.type)) continue;
    const pageUrl = publicHttps(html.finalUrl) || page;
    const images = imageCandidates(new TextDecoder().decode(html.bytes), pageUrl, slot.name);
    for (const image of images) {
      if (tried >= 4) break;
      tried += 1;
      let file;
      try { file = await fetchLimited(image, fetchImpl, MAX_BYTES, 'image/webp,image/jpeg,image/png'); } catch { file = null; }
      const mime = file && sniff(file.bytes);
      if (!file || !TYPES.has(mime) || file.bytes.length < 4_000) continue;
      const seen = await classify(file.bytes, mime);
      if (!seen?.ok || seen.kind !== 'bottiglia') continue;
      // Stesso controllo delle foto del cliente: l'etichetta letta deve corrispondere al vino.
      const score = slotScore({ kind: 'bottiglia', label: seen.label || {}, description: seen.description || '', filename: '' }, slot, df);
      if (score >= 0.5) return { found: { bytes: file.bytes, mime, page: pageUrl, image, seen, score } };
    }
  }
  return { reason: tried ? 'nessuna foto con l\'etichetta di questo vino' : 'nessuna immagine adatta sulle pagine trovate' };
}

/** Riga della fonte salvata nel materiale (si mostra in Revisione per il controllo dei diritti). */
export const sourceNote = (slot, page, image) => `Fonte: ${page} · immagine: ${image} · vino: ${slot.name}`;
export const parseSourceNote = (note) => { const m = /^Fonte: (\S+) · immagine: (\S+) · vino: (.+)$/.exec(String(note || '')); return m ? { page: m[1], image: m[2], wine: m[3] } : null; };
export { slotFrequencies, text };

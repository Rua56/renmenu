// Foto delle bottiglie dai siti delle cantine (2026-10-14, scelta di Baffone: «Anche dalle cantine»).
// Per i vini Premium senza foto Jarvis cerca con Google (Gemini gratuito con ricerca) la pagina del vino
// sul sito della cantina, prende le immagini della pagina e tiene SOLO quella in cui il modello delle foto
// riconosce una bottiglia con l'etichetta di quel vino. La foto diventa una «Foto per il menu» proposta,
// con l'indirizzo della fonte: entra nel menu solo se Riccardo la conferma (e ha verificato di poterla usare).
import { menuSlots, slotFrequencies, slotScore } from './media.js';

export const CANTINA_SOURCE = 'sito_cantina';
export const PER_ROUND = 3;
const MAX_PAGES = 3, MAX_IMAGES = 3, MAX_TRIES = 6, MAX_BYTES = 4_000_000, MAX_HTML = 1_500_000;
const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const SKIP_IMG = /logo|icon|sprite|banner|placeholder|avatar|flag|bandier|social|facebook|instagram|payment|pagament|cookie|loader|spinner|header|footer|bg[-_]|background|award|medaglia|premio/i;
const SEARCH_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'];
const SEARCH_TRIES = 3;

const norm = (v) => String(v || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const words = (v) => norm(v).split(' ').filter((w) => w.length >= 3 && !['doc', 'docg', 'igt', 'vino', 'the', 'and'].includes(w));
const text = (v) => (v == null ? '' : typeof v === 'string' ? v : v.it || Object.values(v)[0] || '');
const GENERIC = new Set(['azienda', 'agricola', 'agricole', 'cantina', 'cantine', 'vini', 'vigneti', 'societa', 'fratelli', 'family', 'winery', 'estate', 'wines']);

/**
 * Produttore di un vino, quando la carta lo dà in modo sicuro (slot.producer). Trattoria Blanch: la descrizione
 * è «Produttore · luogo — dettagli», vedi blanchProducers. Le altre carte non lo hanno separato: niente controllo.
 */
export const producerOf = (slot) => (slot?.wine ? String(slot.producer || '').trim().slice(0, 80) : '');
const single = (v) => String(v).replace(/(.)\1+/g, '$1');
function editsAtMostOne(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i += 1; else if (b.length > a.length) j += 1; else { i += 1; j += 1; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
/** Trattoria Blanch: il produttore di ogni vino è la prima parte della descrizione. */
export function blanchProducers(slots) {
  for (const slot of slots) if (slot.wine) slot.producer = String(slot.descr || '').split(/ · | — /)[0].trim();
  return slots;
}
/**
 * La foto è del produttore giusto? Un «Friulano» qualsiasi non basta: con il produttore in carta serve ritrovarlo
 * sull'etichetta letta, nella descrizione della foto o nell'indirizzo del sito/immagine (es. borgotrevisan.it).
 * Senza produttore (o con un nome fatto solo di parole generiche o corte) non si può controllare e vale il nome del vino.
 */
export function producerMatch(slot, { label = {}, description = '', page = '', image = '' } = {}) {
  const want = words(producerOf(slot)).filter((w) => w.length >= 4 && !GENERIC.has(w));
  if (!want.length) return true;
  const said = ` ${norm([label.cantina, label.nome, label.denominazione, description].filter(Boolean).join(' '))} `;
  const where = norm(`${page} ${safeDecode(String(image || ''))}`).replace(/ /g, '');
  // Le carte scrivono i nomi a modo loro («Schioppetto» per Schiopetto): doppie ridotte e una lettera di scarto.
  const saidWords = said.trim().split(' ').map(single);
  const near = (w) => saidWords.some((h) => h === single(w) || (w.length >= 6 && Math.abs(h.length - w.length) <= 1 && editsAtMostOne(h, single(w))));
  // Tutte le parole del nome: «Borgo» da solo è di troppe cantine.
  return want.every((w) => said.includes(` ${w} `) || (w.length >= 5 && said.includes(w)) || near(w) || where.includes(w) || single(where).includes(single(w)));
}

/** Vini della bozza ancora senza foto (e non già cercati). section: filtro facoltativo sulle sezioni (Blanch: solo le bottiglie). */
export function winesWithoutPhoto(menu, done = [], section = null) {
  const skip = new Set(done.map(norm));
  return menuSlots(menu).filter((slot) => {
    if (!slot.wine || skip.has(norm(slot.key || slot.name))) return false;
    const m = /^voce:(\d+):(\d+)$/.exec(slot.target);
    if (section && !section(menu.sezioni[Number(m[1])])) return false;
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
export async function searchWinePages(gemini, slot, options = {}) {
  return (await searchPages(gemini, slot, options)).pages;
}
// Prima i modelli che stanno rispondendo davvero (gemini.models mette per primi quelli andati a buon fine),
// poi quelli adatti alla ricerca. I 2.5 «pensano» e il pensiero consuma i token della risposta: lo si spegne.
async function searchPages(gemini, slot, { fetchImpl = globalThis.fetch, timeoutMs = 25_000 } = {}) {
  if (!gemini?.key) return { pages: [], why: 'manca la chiave Gemini' };
  const producer = producerOf(slot);
  const prompt = [
    producer ? `Cerca sul web la pagina del vino «${slot.name}» prodotto da «${producer}»${slot.section ? ` (carta dei vini, sezione «${slot.section}»)` : ''} sul sito ufficiale di quella cantina.`
      : `Cerca sul web la pagina del vino «${slot.name}»${slot.descr ? ` (nella carta: «${String(slot.descr).slice(0, 120)}»)` : ''}${slot.section ? ` (carta dei vini, sezione «${slot.section}»)` : ''} sul sito ufficiale della cantina che lo produce.`,
    producer ? `Deve essere proprio il vino di «${producer}»: lo stesso vitigno di un'altra cantina è sbagliato.` : '',
    'Se il sito della cantina non ha una pagina del vino, va bene la scheda di un\'enoteca online dove si vede la foto della bottiglia.',
    'Rispondi solo con JSON: {"pagine": ["https://…"], "immagini": ["https://….jpg"]}: al massimo 3 pagine, il sito della cantina per primo, e se le vedi fino a 3 foto della bottiglia (indirizzo diretto dell\'immagine). Non inventare indirizzi: solo quelli trovati con la ricerca.'
  ].filter(Boolean).join('\n');
  const models = [...new Set([...(gemini.models || []), ...SEARCH_MODELS])].slice(0, SEARCH_TRIES);
  const failures = [];
  for (const model of models) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => controller?.abort(), timeoutMs);
    const thinking = /^gemini-2\.5/.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : /^gemini-3/.test(model) ? { thinkingConfig: { thinkingLevel: 'low' } } : {};
    try {
      const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': gemini.key }, signal: controller?.signal,
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], tools: [{ google_search: {} }], generationConfig: { temperature: 0.1, maxOutputTokens: 2048, ...thinking } })
      });
      if (!response.ok) { failures.push(`${model} ${response.status}`); continue; }
      const data = await response.json();
      const candidate = data?.candidates?.[0] || {};
      const raw = (candidate.content?.parts || []).map((p) => p.text || '').join('');
      let fromText = [], images = [];
      try {
        const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
        const parsed = s >= 0 ? JSON.parse(raw.slice(s, e + 1)) : {};
        fromText = Array.isArray(parsed.pagine) ? parsed.pagine : [];
        images = Array.isArray(parsed.immagini) ? parsed.immagini : [];
      } catch { fromText = []; images = []; }
      // Le fonti vere della ricerca (anche se il testo è sbagliato): indirizzi di rimando di Google verso le pagine.
      const grounded = (candidate.groundingMetadata?.groundingChunks || []).map((c) => c?.web?.uri).filter(Boolean);
      const pages = [...new Set([...fromText, ...grounded].map(publicHttps).filter(Boolean))].slice(0, MAX_PAGES);
      // Le immagini dette dal modello si verificano come le altre (scaricate, riconosciute, etichetta e cantina).
      if (pages.length) return { pages, images: [...new Set(images.map(publicHttps).filter(Boolean))].slice(0, 3), why: '' };
      failures.push(`${model} senza pagine`);
    } catch (error) { failures.push(`${model} ${error?.name === 'AbortError' ? 'lento' : 'non raggiungibile'}`); } finally { clearTimeout(timer); }
  }
  return { pages: [], why: failures.join(', ') };
}

// «%» non valido nell'indirizzo di un'immagine (succede sui siti veri): decodeURIComponent lancerebbe un errore.
const safeDecode = (v) => { try { return decodeURIComponent(v); } catch { return v; } };

/** Immagini della pagina che possono essere la bottiglia: og:image e <img> che nominano il vino. */
export function imageCandidates(html, pageUrl, wineName, siteOfProducer = false) {
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
    // Siti che caricano le foto con srcset: la versione più grande.
    const set = (/\b(?:data-srcset|srcset)=["']([^"']+)["']/i.exec(tag) || [])[1];
    if (set) add(set.split(',').map((x) => x.trim().split(/\s+/)[0]).filter(Boolean).pop(), alt, 0);
  }
  // Schede prodotto dei negozi online (JSON-LD «image»).
  for (const m of doc.matchAll(/"image"\s*:\s*(?:\[\s*)?"(https?:[^"]+)"/gi)) add(m[1].replace(/\\\//g, '/'), '', 1);
  // Sul sito della cantina stessa vale anche una foto senza nome nel file: la verifica la fa il riconoscimento.
  const own = siteOfProducer ? 0 : 2;
  return [...out.entries()].filter(([, s]) => s >= own).sort((a, b) => b[1] - a[1]).slice(0, MAX_IMAGES).map(([url]) => url);
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
  const { pages, images: direct = [], why } = await searchPages(gemini, slot, { fetchImpl });
  if (!pages.length) return { reason: `nessuna pagina trovata${why ? ` (${why})` : ''}`.slice(0, 160) };
  let tried = 0, closed = 0;
  const producerWords = words(producerOf(slot)).filter((w) => w.length >= 4 && !GENERIC.has(w)).map(single);
  // Prima le foto indicate dalla ricerca (fonte: la pagina dello stesso sito, se c'è), poi quelle trovate sulle pagine.
  const visits = [{ page: null, images: direct }, ...pages.map((page) => ({ page }))];
  for (const visit of visits) {
    let pageUrl, images;
    if (visit.page === null) {
      if (!visit.images.length) continue;
      images = visit.images;
    } else {
      let html;
      try { html = await fetchLimited(visit.page, fetchImpl, MAX_HTML, 'text/html'); } catch { html = null; }
      if (!html || !/html/.test(html.type)) { closed += 1; continue; }
      pageUrl = publicHttps(html.finalUrl) || visit.page;
      const host = single(new URL(pageUrl).hostname.replace(/[^a-z0-9]/gi, '').toLowerCase());
      const own = producerWords.length > 0 && producerWords.every((w) => host.includes(w));
      images = imageCandidates(new TextDecoder().decode(html.bytes), pageUrl, `${slot.name} ${producerOf(slot)}`, own);
    }
    for (const image of images) {
      const sourcePage = pageUrl || pages.find((p) => { try { return new URL(p).hostname === new URL(image).hostname; } catch { return false; } }) || image;
      if (tried >= MAX_TRIES) break;
      tried += 1;
      let file;
      try { file = await fetchLimited(image, fetchImpl, MAX_BYTES, 'image/webp,image/jpeg,image/png'); } catch { file = null; }
      const mime = file && sniff(file.bytes);
      if (!file || !TYPES.has(mime) || file.bytes.length < 4_000) continue;
      const seen = await classify(file.bytes, mime);
      if (!seen?.ok || seen.kind !== 'bottiglia') continue;
      // Stesso controllo delle foto del cliente: l'etichetta letta deve corrispondere al vino.
      const score = slotScore({ kind: 'bottiglia', label: seen.label || {}, description: seen.description || '', filename: '' }, slot, df);
      if (score >= 0.5 && producerMatch(slot, { label: seen.label || {}, description: seen.description || '', page: sourcePage, image })) return { found: { bytes: file.bytes, mime, page: sourcePage, image, seen, score } };
    }
  }
  if (tried) return { reason: 'nessuna foto con l\'etichetta di questo vino (e di questa cantina)' };
  return { reason: closed === pages.length ? 'pagine trovate ma non si aprono (il sito blocca i programmi)' : 'nessuna immagine adatta sulle pagine trovate' };
}

/** Riga della fonte salvata nel materiale (si mostra in Revisione per il controllo dei diritti). */
export const sourceNote = (slot, page, image) => `Fonte: ${page} · immagine: ${image} · vino: ${slot.key || slot.name}`;
export const parseSourceNote = (note) => { const m = /^Fonte: (\S+) · immagine: (\S+) · vino: (.+)$/.exec(String(note || '')); return m ? { page: m[1], image: m[2], wine: m[3] } : null; };
export { slotFrequencies, text };

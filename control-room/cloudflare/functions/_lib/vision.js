// Lettura di foto e PDF dei menu (punto 4 della roadmap di Jarvis).
// Foto: due modelli di visione diversi trascrivono la stessa immagine in modo indipendente. Un
// piatto entra nel testo "confermato" solo se le due letture concordano su nome e prezzo; se non
// concordano finisce tra le righe da verificare, con entrambe le letture. Così un prezzo letto male
// (o inventato) da un modello non entra mai in silenzio nel menu.
// PDF: si usa il testo incorporato nel file (conversione esatta, nessuna interpretazione); un PDF
// scansionato senza testo va mandato come foto.
import { extractMenuFromText } from './menu.js';

export const VISION_MODELS = ['@cf/meta/llama-4-scout-17b-16e-instruct', '@cf/mistralai/mistral-small-3.1-24b-instruct'];
export const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_IMAGE_BYTES = 4_500_000;
export const DOUBT = '[da verificare]';

const PROMPT = [
  'Sei un trascrittore. Trascrivi ESATTAMENTE il testo di questa foto di un menu di un locale italiano, nell’ordine in cui appare.',
  'Regole:',
  '- un piatto o una bevanda per riga, nel formato: Nome — prezzo (il prezzo è il numero scritto accanto o allineato a destra, senza simbolo €);',
  '- se una voce ha più prezzi (es. piccola/grande, calice/bottiglia) scrivi una riga per prezzo: Nome (piccola) — 6;',
  '- i titoli delle sezioni su una riga a sé, preceduti da "# " (es. # Primi);',
  '- copia le parole come sono scritte: non tradurre, non correggere, non completare, non aggiungere ingredienti o allergeni non scritti;',
  '- se un nome o un prezzo non si legge con sicurezza scrivi [?] al suo posto;',
  '- niente commenti, niente introduzioni, solo le righe.'
].join('\n');

const norm = (value) => String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const words = (value) => new Set(norm(value).split(' ').filter((w) => w.length > 1));
function similar(a, b) {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return false;
  const common = [...x].filter((w) => y.has(w)).length;
  return common / Math.max(x.size, y.size) >= 0.6 || norm(a) === norm(b);
}

function toBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

async function transcribe(ai, model, dataUrl, timeoutMs) {
  const payload = { messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }, { type: 'image_url', image_url: { url: dataUrl } }] }], temperature: 0, max_tokens: 2500 };
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('tempo scaduto')), timeoutMs); });
  try {
    const result = await Promise.race([Promise.resolve().then(() => ai.run(model, payload)), timeout]);
    const text = result?.response ?? result?.choices?.[0]?.message?.content ?? '';
    return String(typeof text === 'string' ? text : JSON.stringify(text)).replace(/```[a-z]*\n?|```/g, '').trim();
  } finally { clearTimeout(timer); }
}

const clean = (line) => line.replace(/^[-•*]\s*/, '').replace(/\*\*/g, '').trim();
function parse(text) {
  const rows = String(text || '').split(/\r?\n/).map(clean).filter(Boolean);
  const out = [];
  for (const row of rows) {
    if (/^#{1,3}\s*\S/.test(row)) { out.push({ kind: 'titolo', title: row.replace(/^#{1,3}\s*/, '').trim() }); continue; }
    if (row.includes('[?]')) { out.push({ kind: 'dubbio', text: row }); continue; }
    const read = extractMenuFromText('x', row, 'x').extracted[0];
    out.push(read ? { kind: 'piatto', name: read.name, price: read.price, text: row } : { kind: 'altro', text: row });
  }
  return out;
}

/**
 * Combina due letture indipendenti. Restituisce il testo da usare come fonte (formato canonico
 * "Nome — prezzo" per le voci concordi, righe "[da verificare] …" per tutto il resto).
 */
export function combineReadings(first, second) {
  const a = parse(first), b = parse(second || '');
  const single = !second;
  const bItems = b.filter((r) => r.kind === 'piatto');
  const used = new Set();
  const lines = [], doubts = [];
  let agreed = 0;
  for (const row of a) {
    if (row.kind === 'titolo') { lines.push(`# ${row.title}`); continue; }
    if (row.kind !== 'piatto') { if (row.kind === 'dubbio') doubts.push(`${DOUBT} ${row.text}`); continue; }
    if (single) { doubts.push(`${DOUBT} ${row.name} — ${row.price} (letto una sola volta)`); continue; }
    const match = bItems.findIndex((other, index) => !used.has(index) && other.price === row.price && similar(other.name, row.name));
    if (match >= 0) { used.add(match); lines.push(`${row.name} — ${row.price}`); agreed += 1; continue; }
    const near = bItems.find((other) => similar(other.name, row.name));
    doubts.push(`${DOUBT} ${row.name}: letto ${row.price}${near ? `, seconda lettura ${near.price}` : ', non trovato nella seconda lettura'}`);
  }
  bItems.forEach((other, index) => { if (!used.has(index) && !a.some((row) => row.kind === 'piatto' && similar(row.name, other.name))) doubts.push(`${DOUBT} ${other.name}: letto ${other.price} solo nella seconda lettura`); });
  return { text: [...lines, ...doubts].join('\n'), agreed, doubts: doubts.length };
}

/** Foto di un menu → testo fonte con le sole voci concordi tra due modelli. Non lancia mai. */
export async function readMenuPhoto(ai, bytes, mime, { timeoutMs = 45_000 } = {}) {
  if (typeof ai?.run !== 'function') return { ok: false, reason: 'lettura delle foto non disponibile in questo ambiente' };
  if (!PHOTO_TYPES.has(mime)) return { ok: false, reason: `formato ${mime} non leggibile: manda la foto in JPG o PNG` };
  if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, reason: 'foto troppo grande (oltre 4,5 MB): mandala da Telegram o in qualità ridotta' };
  const dataUrl = `data:${mime};base64,${toBase64(bytes)}`;
  const reads = await Promise.allSettled(VISION_MODELS.map((model) => transcribe(ai, model, dataUrl, timeoutMs)));
  const texts = reads.map((r) => (r.status === 'fulfilled' ? r.value : ''));
  const good = texts.filter((t) => t && parse(t).some((row) => row.kind === 'piatto'));
  if (!good.length) return { ok: false, reason: 'non riesco a leggere piatti e prezzi in questa foto: prova con una foto più nitida, dritta e senza riflessi', raw: texts };
  const combined = combineReadings(good[0], good[1]);
  const warnings = [good.length === 2
    ? `Foto letta da Jarvis due volte con modelli diversi: ${combined.agreed} voci concordi${combined.doubts ? `, ${combined.doubts} righe da verificare sulla foto` : ''}.`
    : 'Foto letta una sola volta (il secondo modello non ha risposto): tutte le voci restano da verificare sulla foto.'];
  return { ok: true, text: combined.text, agreed: combined.agreed, doubts: combined.doubts, method: good.length === 2 ? 'jarvis_foto_doppia_lettura' : 'jarvis_foto_lettura_singola', warnings, raw: texts };
}

/** PDF → testo incorporato (nessuna interpretazione). */
export async function readMenuPdf(ai, bytes, filename = 'menu.pdf') {
  if (typeof ai?.toMarkdown !== 'function') return { ok: false, reason: 'lettura dei PDF non disponibile in questo ambiente' };
  try {
    const [result] = await ai.toMarkdown([{ name: filename, blob: new Blob([bytes], { type: 'application/pdf' }) }]);
    // toMarkdown: "# file / ## Metadata / … / ## Contents / ### Page 1 / testo": solo il testo delle pagine.
    let text = String(result?.data || '');
    const contents = text.search(/^#{1,3}\s*Contents\s*$/m);
    if (contents >= 0) text = text.slice(contents).replace(/^#{1,3}\s*Contents\s*$/m, '');
    text = text.split(/\r?\n/).filter((line) => !/^#{1,4}\s*(?:Page|Pagina)\s+\d+\s*$/i.test(line.trim())).join('\n').trim();
    if (!extractMenuFromText('x', text, 'x').extracted.length) return { ok: false, reason: 'il PDF non contiene testo leggibile (forse è una scansione): manda le pagine come foto' };
    return { ok: true, text, method: 'jarvis_pdf_testo', warnings: ['Testo estratto dal PDF così com’è scritto nel file.'] };
  } catch (error) {
    return { ok: false, reason: `PDF non leggibile (${String(error?.message || 'errore').slice(0, 80)})` };
  }
}

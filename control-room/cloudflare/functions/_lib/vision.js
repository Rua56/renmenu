// Lettura di foto e PDF dei menu (punto 4 della roadmap di Jarvis).
// Foto: due modelli di visione diversi trascrivono la stessa immagine in modo indipendente. Un
// piatto entra nel testo "confermato" solo se le due letture concordano su nome e prezzo; se non
// concordano finisce tra le righe da verificare, con entrambe le letture. Così un prezzo letto male
// (o inventato) da un modello non entra mai in silenzio nel menu.
// PDF: si usa il testo incorporato nel file (conversione esatta, nessuna interpretazione); un PDF
// scansionato senza testo va mandato come foto.
import { extractMenuFromText } from './menu.js';

export const VISION_MODELS = ['@cf/meta/llama-4-scout-17b-16e-instruct', '@cf/mistralai/mistral-small-3.1-24b-instruct'];
// Se uno dei due non risponde (es. errore 5026 su una certa foto), un terzo modello diverso fa la seconda lettura:
// così il controllo incrociato resta a DUE letture indipendenti e la bozza non resta vuota.
export const VISION_FALLBACK = '@cf/google/gemma-4-26b-a4b-it';
export const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_IMAGE_BYTES = 4_500_000;
export const DOUBT = '[da verificare]';

const PROMPT = [
  'Sei un trascrittore. Trascrivi ESATTAMENTE il testo di questa foto di un menu di un locale italiano, nell’ordine in cui appare.',
  'Regole:',
  '- i titoli delle sezioni su una riga a sé, preceduti da "# " (es. # Primi); anche il titolo della pagina con il suo sottotitolo (es. # Mescita — by the glass);',
  '- simboli o icone accanto al nome (foglia, spiga barrata, peperoncino…) NON vanno scritti nel nome;',
  '- un piatto o una bevanda per riga, nel formato: Nome — prezzo (il prezzo è il numero scritto accanto o allineato a destra, senza simbolo €);',
  '- la descrizione o gli ingredienti scritti sotto o accanto al nome vanno nella riga SUBITO DOPO, che inizia con "> " (es. > con burro e salvia (1-7)); il nome del piatto resta nella riga col prezzo;',
  '- se una voce ha più prezzi (es. calice e bottiglia, piccola e grande) scrivili sulla stessa riga con le etichette: Nome — calice 5 / bottiglia 40; se le etichette sono in testa alle colonne (es. "calice  bottiglia") usa quelle;',
  '- percorso o menu degustazione: titolo con il prezzo su una riga, es. # Percorso degustazione — 55 a persona; poi una portata per riga, senza prezzo; supplementi come "Abbinamento vini — 25";',
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
// Un modello a volte trascrive la descrizione al posto del nome («CON BARBABIETOLA SOTTACETO, …»).
function descriptionAsName(name) {
  const text = String(name || '').trim();
  const letters = text.replace(/[^A-Za-zÀ-ÿ]/g, '');
  const shouting = letters.length >= 12 && letters === letters.toUpperCase() && text.split(/\s+/).length >= 4;
  return shouting || /^(?:con|al|allo|alla|alle|ai|agli|in|su|e|di|servit\w*|accompagnat\w*)\s/i.test(text) || /^[a-zà-ÿ]/.test(text) || /\(\d{1,2}(?:\s*[-,]\s*\d{1,2})*\)\s*$/.test(text);
}

const shouting = (text) => { const l = String(text).replace(/[^A-Za-zÀ-ÿ]/g, ''); return l.length >= 4 && l === l.toUpperCase(); };
function toBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

async function transcribe(ai, model, dataUrl, timeoutMs) {
  const payload = { messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }, { type: 'image_url', image_url: { url: dataUrl } }] }], temperature: 0, max_tokens: 3500 };
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('tempo scaduto')), timeoutMs); });
  try {
    const result = await Promise.race([Promise.resolve().then(() => ai.run(model, payload)), timeout]);
    const text = result?.response ?? result?.choices?.[0]?.message?.content ?? '';
    return String(typeof text === 'string' ? text : JSON.stringify(text)).replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```[a-z]*\n?|```/g, '').trim();
  } finally { clearTimeout(timer); }
}

const clean = (line) => line.replace(/^[-•*]\s*/, '').replace(/\*\*/g, '').trim();
const priceKey = (item) => (item.prezzi ? item.prezzi.map((p) => `${norm(p.etichetta.it)}=${p.prezzo}`).join('|') : item.prezzo || '');
const amountsKey = (item) => (item.prezzi ? item.prezzi.map((p) => p.prezzo).join('|') : item.prezzo || '');
const priceText = (item) => (item.prezzi ? item.prezzi.map((p) => `${p.etichetta.it.toLowerCase()} ${p.prezzo}`).join(' / ') : item.prezzo);

/** Una lettura → voci strutturate (sezione, nome, prezzo o prezzi, descrizione) + righe dubbie. */
/* Alcuni modelli non seguono il formato «Nome — prezzo»: scrivono il prezzo sulla riga dopo e gli
 * allergeni dentro il nome («Pasta corta - Allergeni 1-2» / riga «Allergeni 4»). Qui si rimette in
 * ordine senza inventare nulla: il prezzo torna sulla riga del nome, i numeri degli allergeni
 * diventano «> (1-2)» (da confermare dal locale, come sempre), le righe «Allergeni» senza numeri spariscono. */
const BARE_PRICE = /^\s*(?:€\s*)?(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:€|eur[o]?)?\s*$/i;
const ALLERGEN_TAIL = /\s*[-–—,(]?\s*al+er+geni(?:\s*[:.]?\s*((?:\d{1,2}\s*[-,/]?\s*)+))?\s*\)?\s*$/i;
const ALLERGEN_ROW = /^\s*>?\s*al+er+geni\b\s*[:.]?\s*((?:\d{1,2}\s*[-,/]?\s*)*)(?:soliti)?\s*(?:[—–-]\s*)?(\d{1,4}(?:[.,]\d{1,2})?)?\s*$/i;
const codes = (raw) => (String(raw || '').match(/\d{1,2}/g) || []).filter((n) => Number(n) >= 1 && Number(n) <= 14).join('-');
const hasPrice = (line) => /(?:\s[-–]|—)\s*(?:€\s*)?\d{1,4}(?:[.,]\d{1,2})?\s*(?:€)?\s*$/.test(line) || /\s\d{1,4}[.,]\d{2}\s*€?\s*$/.test(line);
export function tidyReading(text) {
  const out = [];
  let item = -1; // ultima riga «voce» (non titolo, non descrizione) ancora senza prezzo o appena chiusa
  let legend = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) { out.push(line); continue; }
    if (/^#{1,3}\s/.test(line)) { out.push(line); item = -1; legend = false; continue; }
    // Legenda finale «Allergeni / 1 Glutine …»: non sono piatti.
    if (/^\s*al+er+geni\s*:?\s*$/i.test(line)) { legend = true; continue; }
    if (legend && /^\s*\d{1,2}\s*[-.)]?\s*[A-Za-zÀ-ÿ]/.test(line)) { out.push(`${DOUBT} Legenda allergeni sulla foto: «${line.trim()}»`); continue; }
    const row = line.match(ALLERGEN_ROW);
    if (row) {
      const list = codes(row[1]);
      if (list && item >= 0) out.splice(item + 1, 0, `> (${list})`);
      continue; // il prezzo ripetuto su questa riga è quello della voce sopra
    }
    const bare = line.match(BARE_PRICE);
    if (bare) {
      if (item >= 0 && !hasPrice(out[item])) out[item] = `${out[item].replace(/\s*[—–-]\s*$/, '')} — ${bare[1]}`;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const tail = line.match(ALLERGEN_TAIL);
      out.push(tail ? `${line.slice(0, tail.index).trimEnd()}${codes(tail[1]) ? ` (${codes(tail[1])})` : ''}` : line);
      continue;
    }
    let name = line, list = '';
    const tail = name.match(ALLERGEN_TAIL);
    if (tail && !hasPrice(name)) { list = codes(tail[1]); name = name.slice(0, tail.index).trimEnd(); }
    else if (hasPrice(name)) {
      const m = name.match(/^(.*?)\s*[-–—,(]\s*al+er+geni\s*[:.]?\s*((?:\d{1,2}\s*[-,/]?\s*)*)\)?\s*([—–-]\s*\d.*)$/i);
      if (m) { name = `${m[1]} ${m[3]}`; list = codes(m[2]); }
    }
    out.push(name);
    item = out.length - 1;
    if (list) out.push(`> (${list})`);
  }
  return out.join('\n');
}

function parse(text) {
  const rows = tidyReading(text).split(/\r?\n/).map(clean);
  const doubts = rows.filter((r) => r.includes('[?]'));
  const extraction = extractMenuFromText('x', rows.filter((r) => !r.includes('[?]')).join('\n'), 'x');
  const items = [], sections = [];
  extraction.menu.sezioni.forEach((s, si) => {
    sections.push({ name: s.nome.it, tipo: s.tipo || '', prezzo: s.prezzo || '', unita: s.unita?.it || '', index: si });
    s.voci.forEach((v, vi) => items.push({ section: si, index: vi, tipo: s.tipo || '', name: v.nome.it, prezzo: v.prezzo, prezzi: v.prezzi, descr: v.descrizione?.it || '', course: s.tipo === 'degustazione' && !v.prezzo }));
  });
  const titles = rows.filter((r) => /^#{1,3}\s*\S/.test(r) && /\bmescita\b|by the glass|\bal calice\b|\bal bicchiere\b/i.test(r)).map((r) => r.replace(/^#{1,3}\s*/, '').trim());
  return { items, sections, doubts, other: extraction.uncertain, titles };
}
// Compatibilità con i test e con la diagnosi: le voci con prezzo di una lettura.
export function readingItems(text) { return parse(text).items.filter((i) => !i.course); }

/**
 * Combina due letture indipendenti. Restituisce il testo da usare come fonte, in formato canonico:
 * «# Sezione», «Nome — prezzo», «Nome — calice 5,00 / bottiglia 40,00», «> descrizione», percorsi
 * «# Percorso — 55,00 € a persona» con le portate. Entra solo ciò che le DUE letture confermano;
 * tutto il resto diventa una riga «[da verificare] …» con entrambe le letture.
 */
export function combineReadings(first, second) {
  const A = parse(first), B = parse(second || '');
  const single = !second;
  const used = new Set(), lines = [], doubts = [];
  let agreed = 0, lastB = -1, currentSection = null;
  for (const d of A.doubts) doubts.push(`${DOUBT} ${d}`);
  for (const d of B.doubts) if (!A.doubts.some((x) => similar(x, d))) doubts.push(`${DOUBT} ${d} (seconda lettura)`);
  const sectionHead = (si) => {
    if (currentSection === si) return;
    currentSection = si;
    const s = A.sections[si];
    if (s.tipo === 'degustazione') {
      const other = B.sections.find((x) => x.tipo === 'degustazione' && (similar(x.name, s.name) || B.sections.filter((y) => y.tipo === 'degustazione').length === 1));
      if (s.prezzo && other?.prezzo === s.prezzo) lines.push(`# ${s.name} — ${s.prezzo} €${s.unita ? ` ${s.unita}` : ''}`);
      else {
        lines.push(`# ${s.name}`);
        if (s.prezzo || other?.prezzo) doubts.push(`${DOUBT} Prezzo del percorso «${s.name}»: letto ${s.prezzo || 'nessun prezzo'}${other ? `, seconda lettura ${other.prezzo || 'nessun prezzo'}` : ', percorso non trovato nella seconda lettura'}`);
      }
    } else if (s.name !== 'Dal materiale ricevuto') lines.push(`# ${s.name}`);
  };
  // Titolo di pagina senza voci («Mescita — by the glass»): letto da entrambe → resta, serve a capire i prezzi.
  for (const title of A.titles) if (single || B.titles.some((t) => /mescita|glass|calice|bicchiere/i.test(t))) { lines.push(`# ${title}`); break; }
  for (const row of A.items) {
    if (single) { doubts.push(`${DOUBT} ${row.name}${row.course ? ' (portata)' : ` — ${priceText(row)}`} (letto una sola volta)`); continue; }
    const candidates = B.items.map((other, index) => ({ other, index })).filter(({ index }) => !used.has(index));
    // 1) stesso nome (simile) e stessi prezzi.
    let hit = candidates.find(({ other }) => other.course === row.course && priceKey(other) === priceKey(row) && similar(other.name, row.name));
    let name = row.name, aNameIsDesc = false;
    // 2) stessa posizione e stessi prezzi, ma una lettura ha scritto la descrizione al posto del nome.
    if (!hit && !row.course) {
      const next = candidates.find(({ index, other }) => index > lastB && !other.course);
      if (next && amountsKey(next.other) === amountsKey(row) && (similar(next.other.name, row.descr) || similar(row.name, next.other.descr) || descriptionAsName(next.other.name) || descriptionAsName(row.name))) {
        hit = next;
        if (descriptionAsName(row.name) && !descriptionAsName(next.other.name)) { name = next.other.name; aNameIsDesc = true; }
      }
    }
    if (!hit) {
      const near = B.items.find((other) => similar(other.name, row.name));
      doubts.push(`${DOUBT} ${row.name}${row.course ? ' (portata del percorso)' : `: letto ${priceText(row)}`}${near ? (row.course ? '' : `, seconda lettura ${priceText(near)}`) : ', non trovato nella seconda lettura'}`);
      continue;
    }
    used.add(hit.index); lastB = Math.max(lastB, hit.index); agreed += 1;
    sectionHead(row.section);
    const other = hit.other;
    // Nome scritto tutto in maiuscolo da una lettura e normale dall'altra: si tiene quello normale.
    if (shouting(name) && !shouting(other.name) && similar(name, other.name)) name = other.name;
    lines.push(row.course ? name : `${name} — ${priceText(row)}`);
    // Descrizione: solo se confermata da entrambe le letture (anche quando l'altra l'ha scritta come nome).
    const descA = row.descr || (aNameIsDesc ? row.name : ''), descB = other.descr || (!aNameIsDesc && descriptionAsName(other.name) && !similar(other.name, name) ? other.name : '');
    if (descA && descB && similar(descA, descB)) lines.push(`> ${descA.length >= descB.length ? descA : descB}`);
    else if (descA || descB) doubts.push(`${DOUBT} Descrizione di «${name}» letta una sola volta: «${(descA || descB).slice(0, 160)}»`);
  }
  // Avvisi scritti sulla foto («prodotti abbattuti a -18°», «paste fatte in casa»): mai persi, li valuta Riccardo.
  const notes = [];
  for (const line of [...A.other, ...B.other]) {
    const text = String(line).replace(/^\*+\s*/, '').trim();
    if (text.length >= 20 && !text.startsWith(DOUBT) && !notes.some((n) => similar(n, text))) notes.push(text);
  }
  for (const text of notes) doubts.push(`${DOUBT} Testo sulla foto (non è un piatto): «${text.slice(0, 200)}»`);
  if (!single) B.items.forEach((other, index) => {
    if (used.has(index) || A.items.some((row) => similar(row.name, other.name))) return;
    if (descriptionAsName(other.name) && A.items.some((row) => similar(row.descr, other.name))) return;
    doubts.push(`${DOUBT} ${other.name}${other.course ? ' (portata del percorso)' : `: letto ${priceText(other)}`} solo nella seconda lettura`);
  });
  return { text: [...lines, ...doubts].join('\n'), agreed, doubts: doubts.length };
}

/** Foto di un menu → testo fonte con le sole voci concordi tra due modelli. Non lancia mai. */
export async function readMenuPhoto(ai, bytes, mime, { timeoutMs = 45_000 } = {}) {
  if (typeof ai?.run !== 'function') return { ok: false, reason: 'lettura delle foto non disponibile in questo ambiente' };
  if (!PHOTO_TYPES.has(mime)) return { ok: false, reason: `formato ${mime} non leggibile: manda la foto in JPG o PNG` };
  if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, reason: 'foto troppo grande (oltre 4,5 MB): mandala da Telegram o in qualità ridotta' };
  const dataUrl = `data:${mime};base64,${toBase64(bytes)}`;
  // Un errore passeggero del servizio (es. codice 5026) non deve lasciare la foto con una sola lettura: un secondo tentativo.
  const once = (model) => transcribe(ai, model, dataUrl, timeoutMs).catch((error) => (/tempo scaduto/.test(String(error?.message)) ? Promise.reject(error) : transcribe(ai, model, dataUrl, timeoutMs)));
  const reads = await Promise.allSettled(VISION_MODELS.map((model) => once(model)));
  const texts = reads.map((r) => (r.status === 'fulfilled' ? r.value : ''));
  const failed = texts.findIndex((t) => !t || !readingItems(t).length);
  let fallbackUsed = false;
  if (failed >= 0 && texts.some((t) => t && readingItems(t).length)) {
    try { texts[failed] = await transcribe(ai, VISION_FALLBACK, dataUrl, timeoutMs); fallbackUsed = Boolean(texts[failed]); } catch { /* resta una lettura sola */ }
  }
  const good = texts.filter((t) => t && readingItems(t).length);
  if (!good.length) return { ok: false, reason: 'non riesco a leggere piatti e prezzi in questa foto: prova con una foto più nitida, dritta e senza riflessi', raw: texts };
  const combined = combineReadings(good[0], good[1]);
  const warnings = [good.length === 2
    ? `Foto letta da Jarvis due volte con modelli diversi${fallbackUsed ? ' (uno di riserva, il primo non rispondeva)' : ''}: ${combined.agreed} voci concordi${combined.doubts ? `, ${combined.doubts} righe da verificare sulla foto` : ''}.`
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

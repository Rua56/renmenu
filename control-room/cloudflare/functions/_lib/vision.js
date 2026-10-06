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
// Screenshot e file a piena qualità da Telegram (PNG dell'iPhone ~5 MB): più nitidi della foto compressa.
const MAX_IMAGE_BYTES = 9_000_000;
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
  // «Tirami sù» = «Tiramisù», «The» = «Tè»: stesso nome scritto in modo diverso.
  const tight = (v) => norm(v).replace(/ /g, '').replace(/^the\b|^the(?=[^a-z]|$)/, 'te');
  return common / Math.max(x.size, y.size) >= 0.6 || norm(a) === norm(b) || (tight(a).length >= 4 && tight(a) === tight(b));
}
// «Brodo: gnocchetti di semolino,» dentro «Brodo: gnocchetti di semolino, pastina fatta in casa»: la stessa voce
// spezzata in modo diverso dalle due letture (almeno 3 parole tutte contenute nell'altra).
function contains(a, b) {
  const x = words(a), y = words(b);
  const [small, big] = x.size <= y.size ? [x, y] : [y, x];
  return small.size >= 3 && [...small].every((w) => big.has(w));
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
  // Gemma 4 ragiona prima di rispondere: senza questo spende i token nel ragionamento e la trascrizione resta vuota.
  if (model.includes('gemma')) Object.assign(payload, { max_completion_tokens: 4000, chat_template_kwargs: { enable_thinking: false } });
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
const ALLERGEN_TAIL = /\s*[-–—,(]?\s*a[lf]{1,3}er+g[ei]ni(?:\s*[:.]?\s*((?:\d{1,2}\s*[-,/]?\s*)+))?\s*\)?\s*$/i;
const ALLERGEN_ROW = /^\s*>?\s*a[lf]{1,3}er+g[ei]ni\b\s*[:.]?\s*((?:\d{1,2}\s*[-,/]?\s*)*)(?:soliti|solfiti|sof+it+i)?\s*(?:[—–-]\s*)?(\d{1,4}(?:[.,]\d{1,2})?)?\s*$/i;
const codes = (raw) => (String(raw || '').match(/\d{1,2}/g) || []).filter((n) => Number(n) >= 1 && Number(n) <= 14).join('-');
const hasPrice = (line) => /(?:\s[-–]|—)\s*(?:€\s*)?\d{1,4}(?:[.,]\d{1,2})?\s*(?:€)?\s*$/.test(line) || /\s\d{1,4}[.,]\d{2}\s*€?\s*$/.test(line);
/* Alcuni modelli scrivono ogni piatto come titolo («# LA ZUCCA IN SAOR — 10»): con il prezzo sulla riga e subito dopo una
 * descrizione («> …»), un altro titolo o la fine, è un piatto, non una sezione. I percorsi («# Menu degustazione — 55 € a persona»,
 * seguiti dalle portate) e il coperto restano titoli. */
function dishesWrittenAsHeadings(text) {
  const lines = String(text || '').split(/\r?\n/);
  const nextIdx = (i) => { for (let j = i + 1; j < lines.length; j += 1) if (lines[j].trim()) return j; return -1; };
  const isHeading = (l) => /^\s*#{1,3}\s/.test(l);
  const isNote = (l) => /^\s*>/.test(l);
  const priced = /^(.*\S)\s*[—–-]\s*(?:€\s*)?(\d{1,4}(?:[.,]\d{1,2})?)\s*€?\s*$/;
  const PATH = /a persona|per persona|percorso|degustazione|\bmenu\b|tasting|coperto|servizio|\bpp\b/i;
  // Dopo la riga i: solo righe «>» e vuote, poi titolo o fine? (un piatto isolato, non una sezione con altri piatti)
  const endsAfterNotes = (i) => { let k = i + 1, notes = 0; while (k < lines.length && (!lines[k].trim() || isNote(lines[k]))) { if (isNote(lines[k])) notes += 1; k += 1; } return notes > 0 && (k >= lines.length || isHeading(lines[k])); };
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // «# IL TAGLIERE DI SALUMI» + «Prosciutto, salama… — 18» + «> (consigliato per due)» + fine/titolo: il titolo è il piatto, la riga col prezzo è la descrizione.
    const bare = line.match(/^\s*#{1,3}\s*([^—–]+?)\s*$/);
    if (bare && !PATH.test(bare[1]) && bare[1].split(/\s+/).length >= 4) {
      const j = nextIdx(i), d = j >= 0 && !isHeading(lines[j]) && !isNote(lines[j]) ? lines[j].match(priced) : null;
      if (d && d[1].trim().split(/\s+/).length >= 6 && endsAfterNotes(j)) { out.push(`${bare[1].trim()} — ${d[2]}`, `> ${d[1].trim()}`); i = j; continue; }
    }
    // «# LA ZUCCA IN SAOR — 10»: titolo con prezzo, poi (facoltativa) una riga di descrizione e le note «>» fino a un titolo o alla fine = piatto.
    const m = line.match(/^\s*#{1,3}\s*(.+?)\s*[—–-]\s*(?:€\s*)?(\d{1,4}(?:[.,]\d{1,2})?)\s*€?\s*$/);
    if (m && !PATH.test(line)) {
      const j = nextIdx(i);
      if (j < 0 || isNote(lines[j]) || isHeading(lines[j])) { out.push(`${m[1].trim()} — ${m[2]}`); continue; }
      if (!priced.test(lines[j]) && !/\d[.,]\d{2}\s*€?\s*$/.test(lines[j]) && endsAfterNotes(j)) { out.push(`${m[1].trim()} — ${m[2]}`, `> ${lines[j].trim()}`); i = j; continue; }
    }
    out.push(line);
  }
  return out.join('\n');
}
export function tidyReading(text) {
  const out = [];
  let item = -1; // ultima riga «voce» (non titolo, non descrizione) ancora senza prezzo o appena chiusa
  let legend = false;
  for (const raw of dishesWrittenAsHeadings(text).split(/\r?\n/)) {
    // «> prosciutto cotto 5,00»: una riga col prezzo è una voce, non una descrizione.
    const line = /^\s*>\s*.*\d[.,]\d{2}\s*(?:€|euro)?\s*$/i.test(raw) ? raw.replace(/^\s*>\s*/, '').trimEnd() : raw.trimEnd();
    if (!line.trim()) { out.push(line); continue; }
    if (/^#{1,3}\s/.test(line)) { out.push(line); item = -1; legend = false; continue; }
    // Legenda finale «Allergeni / 1 Glutine …»: non sono piatti.
    if (/^\s*a[lf]{1,3}er+g[ei]ni\s*:?\s*$/i.test(line)) { legend = true; continue; }
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
    // «Amari, liquori — Likerji 2,50»: il trattino lungo separa le due lingue, non il prezzo.
    const tailPrice = name.match(/^(.*\S)\s+(?:€\s*)?(\d{1,4}[.,]\d{2})\s*€?\s*$/);
    if (tailPrice && /\s—\s/.test(tailPrice[1]) && !/a[lf]{1,3}er+g[ei]ni/i.test(tailPrice[1])) name = `${tailPrice[1].replace(/\s—\s/g, ' - ')} — ${tailPrice[2]}`;
    const tail = name.match(ALLERGEN_TAIL);
    if (tail && !hasPrice(name)) { list = codes(tail[1]); name = name.slice(0, tail.index).trimEnd(); }
    else if (hasPrice(name)) {
      const m = name.match(/^(.*?)\s*[-–—,(]\s*a[lf]{1,3}er+g[ei]ni\s*[:.]?\s*(\d{1,2}(?:\s*[-,/]\s*\d{1,2})*)?\)?\s*((?:\s[-–]|—)\s*€?\s*\d{1,4}(?:[.,]\d{1,2})?\s*€?)\s*$/i);
      if (m) { name = `${m[1]} ${m[3]}`; list = codes(m[2]); }
      // «Goulash — Allergeni 1 10,00 €»: allergeni tra nome e prezzo, senza trattino davanti al prezzo.
      const mid = !m && name.match(/^(.*?)\s*[-–—,(]?\s*a[lf]{1,3}er+g[ei]ni\s*[:.]?\s*(\d{1,2}(?:\s*[-,/]\s*\d{1,2})*)?\s*(?:soliti|solfiti)?\)?\s+(\d{1,4}[.,]\d{2})\s*€?\s*$/i);
      if (mid && mid[1].trim()) { name = `${mid[1].trim()} — ${mid[3]}`; list = codes(mid[2]); }
      // «Gnocchi con le susine — Allergeni 1-2 (agosto/settembre) — 9,00»: la nota resta nel nome, i numeri vanno negli allergeni.
      const note = !m && !mid && name.match(/^(.*?)\s*[-–—,]\s*a[lf]{1,3}er+g[ei]ni\s*[:.]?\s*(\d{1,2}(?:\s*[-,/]\s*\d{1,2})*)\s+(\([^)]{2,40}\))\s*(?:[-–—]\s*)?€?\s*(\d{1,4}(?:[.,]\d{2})?)\s*€?\s*$/i);
      if (note && note[1].trim()) { name = `${note[1].trim()} ${note[3]} — ${note[4]}`; list = codes(note[2]); }
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
export function combineReadings(first, second, third = '') {
  const A = parse(first), B = parse(second || ''), C = third ? parse(third) : null;
  const usedC = new Set();
  let byThird = 0;
  const bySection = new Map();
  const tally = (row, ok) => { const name = A.sections[row.section]?.name || 'Menu'; const t = bySection.get(name) || { name, ok: 0, total: 0 }; t.total += 1; if (ok) t.ok += 1; bySection.set(name, t); };
  const single = !second;
  const used = new Set(), lines = [], doubts = [], checks = [];
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
    // 2b) stessa voce spezzata diversamente («Brodo: gnocchetti di semolino,» / «… , pastina fatta in casa»), stessi prezzi:
    // vale il nome più completo.
    if (!hit && !row.course) {
      const whole = candidates.find(({ other }) => !other.course && priceKey(other) === priceKey(row) && contains(other.name, row.name));
      if (whole) { hit = whole; if (words(whole.other.name).size > words(row.name).size) name = whole.other.name.replace(/[,;:\s]+$/, ''); }
    }
    // 3) Le prime due non concordano: decide la terza lettura (se c'è). Entra solo con nome e prezzi uguali: 2 letture su 3.
    if (!hit && C) {
      const ci = C.items.findIndex((other, i) => !usedC.has(i) && other.course === row.course && priceKey(other) === priceKey(row) && similar(other.name, row.name));
      if (ci >= 0) { usedC.add(ci); hit = { other: C.items[ci], index: -1 }; byThird += 1; }
    }
    tally(row, Boolean(hit));
    if (!hit) {
      const near = B.items.find((other) => similar(other.name, row.name));
      doubts.push(`${DOUBT} ${row.name}${row.course ? ' (portata del percorso)' : `: letto ${priceText(row)}`}${near ? (row.course ? '' : `, seconda lettura ${priceText(near)}`) : ', non trovato nella seconda lettura'}`);
      // Dubbio da chiudere con un tocco (Telegram): nome, sezione e i prezzi letti.
      if (!row.course) {
        const third = C?.items.find((o) => similar(o.name, row.name));
        const options = [...new Set([priceText(row), near && priceText(near), third && priceText(third)].filter(Boolean))];
        checks.push({ line: doubts.at(-1), section: A.sections[row.section]?.name || '', name: row.name, options, descr: row.descr || '' });
      }
      continue;
    }
    if (hit.index >= 0) { used.add(hit.index); lastB = Math.max(lastB, hit.index); }
    agreed += 1;
    sectionHead(row.section);
    const other = hit.other;
    // Nome scritto tutto in maiuscolo da una lettura e normale dall'altra: si tiene quello normale.
    if (shouting(name) && !shouting(other.name) && similar(name, other.name)) name = other.name;
    lines.push(row.course ? name : `${name} — ${priceText(row)}`);
    // Descrizione: solo se confermata da entrambe le letture (anche quando l'altra l'ha scritta come nome).
    const descA = row.descr || (aNameIsDesc ? row.name : ''), descB = other.descr || (!aNameIsDesc && descriptionAsName(other.name) && !similar(other.name, name) ? other.name : '');
    // Solo numeri di allergeni («(1)», «(1-2-4)»): bastano anche da una lettura, tanto restano una proposta da
    // confermare con la legenda; se le letture danno numeri diversi, resta un dubbio.
    const codesOnly = (d) => /^\(\s*\d{1,2}(?:\s*[-,/]\s*\d{1,2})*\s*\)$/.test(String(d || '').trim());
    if ((codesOnly(descA) || codesOnly(descB)) && (!descA || !descB || norm(descA) === norm(descB)) && (codesOnly(descA || descB))) lines.push(`> ${(descA || descB).trim()}`);
    else if (descA && descB && similar(descA, descB)) lines.push(`> ${descA.length >= descB.length ? descA : descB}`);
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
    if (used.has(index) || A.items.some((row) => similar(row.name, other.name) || (contains(row.name, other.name) && amountsKey(row) === amountsKey(other)))) return;
    if (descriptionAsName(other.name) && A.items.some((row) => similar(row.descr, other.name))) return;
    doubts.push(`${DOUBT} ${other.name}${other.course ? ' (portata del percorso)' : `: letto ${priceText(other)}`} solo nella seconda lettura`);
    if (!other.course) checks.push({ line: doubts.at(-1), section: B.sections[other.section]?.name || '', name: other.name, options: [priceText(other)], descr: other.descr || '' });
  });
  return { text: [...lines, ...doubts].join('\n'), agreed, doubts: doubts.length, byThird, sections: [...bySection.values()], checks };
}

/** Foto di un menu → testo fonte con le sole voci concordi tra due modelli. Non lancia mai. */
// Menu lunghi (70 voci): un modello può metterci più di un minuto. Se Jarvis smette di aspettare, la
// richiesta viene annullata (su Cloudflare risulta errore 5026) e resta una lettura sola.
// Gemini (Google AI Studio, quota gratuita): legge i menu fitti molto meglio dei modelli gratuiti di Cloudflare.
// Se la chiave c'è, due modelli Gemini diversi leggono la foto e uno di Cloudflare fa da arbitro; se Gemini non
// risponde (quota finita, errore), Jarvis torna da solo ai modelli di Cloudflare.
export const GEMINI_PREFERRED = ['gemini-2.5-flash', 'gemini-3-flash-preview', 'gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite', 'gemini-3.5-flash-lite'];
export async function transcribeGemini({ key, model, fetchImpl = globalThis.fetch }, bytes, mime, timeoutMs = 110_000) {
  // Trascrivere non richiede ragionamento lungo: pensiero al minimo (nomi dei campi cambiati tra 2.5 e 3).
  // Se Google rifiuta l'impostazione del pensiero (400), si riprova senza: mai una lettura persa per questo.
  const thinking = /^gemini-2\.5/.test(model) ? { thinkingBudget: 0 } : { thinkingLevel: 'low' };
  const ask = async (withThinking) => {
    const body = { contents: [{ role: 'user', parts: [{ text: PROMPT }, { inline_data: { mime_type: mime, data: toBase64(bytes) } }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 24000, ...(withThinking ? { thinkingConfig: thinking } : {}) } };
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => controller?.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body), signal: controller?.signal });
      const data = await response.json().catch(() => ({}));
      return { response, data };
    } finally { clearTimeout(timer); }
  };
  let { response, data } = await ask(true);
  if (response.status === 400) ({ response, data } = await ask(false));
  // 503 «UNAVAILABLE» (modello sovraccarico): passeggero, un secondo tentativo dopo una breve pausa.
  if (response.status === 503 || response.status === 500) { await new Promise((r) => setTimeout(r, 2500)); ({ response, data } = await ask(true)); }
  if (!response.ok) throw new Error(`Gemini ${response.status}${data?.error?.status ? ` ${data.error.status}` : ''}`);
  const candidate = data?.candidates?.[0];
  const text = (candidate?.content?.parts || []).filter((part) => !part.thought).map((part) => part.text || '').join('');
  if (!text && candidate?.finishReason) throw new Error(`Gemini senza testo (${candidate.finishReason})`);
  return String(text).replace(/```[a-z]*\n?|```/g, '').trim();
}

export const TRANSIENT_GEMINI = /Gemini (?:503|500|429|senza testo)|tempo scaduto|abort|fetch failed|network|UNAVAILABLE|RESOURCE_EXHAUSTED/i;
export async function readMenuPhoto(ai, bytes, mime, { timeoutMs = 110_000, gemini = null, deferOnTransient = false } = {}) {
  const geminiReady = Boolean(gemini?.key && gemini?.models?.length);
  if (typeof ai?.run !== 'function' && !geminiReady) return { ok: false, reason: 'lettura delle foto non disponibile in questo ambiente' };
  if (!PHOTO_TYPES.has(mime)) return { ok: false, reason: `formato ${mime} non leggibile: manda la foto in JPG o PNG` };
  if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, reason: 'foto troppo grande (oltre 9 MB): fai uno screenshot della foto e manda quello' };
  const dataUrl = `data:${mime};base64,${toBase64(bytes)}`;
  // Un errore passeggero del servizio (es. codice 5026) non deve lasciare la foto con una sola lettura: un secondo tentativo.
  const once = (model) => transcribe(ai, model, dataUrl, timeoutMs).catch((error) => (/tempo scaduto/.test(String(error?.message)) ? Promise.reject(error) : transcribe(ai, model, dataUrl, timeoutMs)));
  const cf = (model) => ({ label: model, run: () => once(model) });
  const gm = (model) => ({ label: model, gemini: true, run: () => transcribeGemini({ ...gemini, model }, bytes, mime, timeoutMs) });
  // Catena Gemini: i modelli scelti alla prova della chiave, poi gli altri gratuiti. Un modello che risponde
  // «404» (non disponibile per questa chiave) o resta sovraccarico cede il posto al successivo.
  const chain = geminiReady ? [...new Set([...gemini.models, ...GEMINI_PREFERRED])] : [];
  const geminiRead = async () => {
    while (chain.length) {
      const model = chain.shift();
      try { const text = await gm(model).run(); if (text && readingItems(text).length) return { text, model }; notes.push(`${model}: lettura senza voci`); }
      catch (error) { notes.push(`${model}: ${String(error?.message || 'errore').slice(0, 120)}`); }
    }
    throw new Error('Gemini non disponibile');
  };
  const primary = geminiReady ? [0, 1].map(() => ({ label: 'gemini', gemini: true, run: async function run() { const r = await geminiRead(); this.label = r.model; return r.text; } })) : VISION_MODELS.map(cf);
  const spare = geminiReady ? [cf(VISION_MODELS[1]), cf(VISION_MODELS[0])] : [cf(VISION_FALLBACK)];
  const notes = [];
  const reads = await Promise.allSettled(primary.map((r) => r.run()));
  const used = primary.map((r) => r.label);
  const texts = reads.map((r, i) => { if (r.status !== 'fulfilled') notes.push(`${primary[i].label}: ${String(r.reason?.message || 'errore').slice(0, 120)}`); return r.status === 'fulfilled' ? r.value : ''; });
  // Google sovraccarico o lento: meglio riprovare tra qualche minuto con Gemini che ripiegare subito su modelli più deboli.
  const geminiStats = { requests: primary.length, failed: texts.filter((t) => !t).length, errors: notes.filter((n) => TRANSIENT_GEMINI.test(n)).slice(0, 4) };
  if (deferOnTransient && geminiReady && texts.some((t) => !t || !readingItems(t).length) && notes.some((n) => TRANSIENT_GEMINI.test(n))) {
    return { ok: false, retryLater: true, reason: 'Google non risponde adesso', geminiStats, raw: notes.map((n) => `[nota] ${n}`) };
  }
  // Una lettura mancata (quota Gemini finita, errore): la sostituisce un modello di riserva.
  let fallbackUsed = false;
  for (let i = 0; i < texts.length; i += 1) {
    if (texts[i] && readingItems(texts[i]).length) continue;
    const next = spare.shift();
    if (!next) break;
    try { texts[i] = await next.run(); used[i] = next.label; fallbackUsed = Boolean(texts[i]); } catch (error) { notes.push(`${next.label}: ${String(error?.message || 'errore').slice(0, 120)}`); }
  }
  // La lettura più completa fa da base (ordine e sezioni del menu), l'altra conferma.
  const good = texts.filter((t) => t && readingItems(t).length).sort((a, b) => readingItems(b).length - readingItems(a).length);
  if (!good.length) return { ok: false, geminiStats, reason: 'non riesco a leggere piatti e prezzi in questa foto: prova con una foto più nitida, dritta e senza riflessi', raw: [...texts, ...notes.map((n) => `[nota] ${n}`)] };
  let combined = combineReadings(good[0], good[1]);
  // Molte voci in disaccordo (menu lunghi, scritte piccole): una terza lettura con un altro modello fa da arbitro.
  let thirdText = '';
  const arbiter = spare.shift();
  if (good.length === 2 && arbiter && combined.doubts >= (geminiReady ? 1 : 10) && combined.agreed < (geminiReady ? 1 : 0.8) * readingItems(good[0]).length) {
    try { thirdText = await arbiter.run(); used.push(arbiter.label); } catch (error) { thirdText = ''; texts.push(`[terza lettura non riuscita] ${String(error?.message || 'errore').slice(0, 200)}`); }
    if (thirdText && readingItems(thirdText).length) combined = combineReadings(good[0], good[1], thirdText);
    else { texts.push(`[terza lettura senza voci] ${String(thirdText || '(vuota)').slice(0, 1500)}`); thirdText = ''; }
  }
  // Sezioni dove le letture non concordano: Jarvis chiede di rimandare solo quelle.
  const weakSections = (combined.sections || []).filter((t) => t.total >= 3 && t.ok < t.total * 0.6).map((t) => `${t.name} (${t.ok} su ${t.total})`);
  const withGemini = used.some((label) => label.startsWith('gemini'));
  const warnings = [good.length === 2
    ? `Foto letta da Jarvis ${thirdText ? 'tre volte con tre modelli diversi' : 'due volte con modelli diversi'}${withGemini ? ' (Gemini)' : ''}${fallbackUsed ? ' (uno di riserva, il primo non rispondeva)' : ''}: ${combined.agreed} voci concordi${thirdText && combined.byThird ? ` (${combined.byThird} confermate dalla terza lettura)` : ''}${combined.doubts ? `, ${combined.doubts} righe da verificare sulla foto` : ''}.`
    : 'Foto letta una sola volta (il secondo modello non ha risposto): tutte le voci restano da verificare sulla foto.'];
  if (good.length === 2 && weakSections.length) warnings.push(`Sezioni meno sicure: ${weakSections.join(', ')}.`);
  return { ok: true, geminiStats, text: combined.text, agreed: combined.agreed, doubts: combined.doubts, checks: combined.checks || [], models: used,
    method: good.length === 2 ? (thirdText ? 'jarvis_foto_tripla_lettura' : 'jarvis_foto_doppia_lettura') : 'jarvis_foto_lettura_singola', warnings,
    raw: [...(thirdText ? [...texts, thirdText] : texts), ...notes.map((n) => `[nota] ${n}`)] };
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

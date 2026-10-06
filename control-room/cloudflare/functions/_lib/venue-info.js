/* Informazioni del locale scritte nell'email o dette a voce: coperto, telefono, orari, Instagram,
 * Facebook. Jarvis le inserisce nel menu solo quando il valore è scritto in modo chiaro; se ha
 * un dubbio (due numeri, un importo strano, un nome pagina incerto) non inserisce e chiede.
 * Nessun valore viene inventato: ogni campo porta la riga da cui è stato letto. */
import { fixTypos } from './typos.js';

const VOCAB = ['coperto', 'telefono', 'cellulare', 'numero', 'whatsapp', 'instagram', 'facebook', 'orari', 'orario', 'aperti', 'aperto', 'apertura',
  'chiusi', 'chiuso', 'chiusura', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato', 'domenica', 'giorni', 'pranzo', 'cena', 'persona'];
const DAYS = 'lun(?:edi|edì)?|mar(?:tedi|tedì)?|mer(?:coledi|coledì)?|gio(?:vedi|vedì)?|ven(?:erdi|erdì)?|sab(?:ato)?|dom(?:enica)?';
const TIME = /\b\d{1,2}(?:[:.]\d{2})?\s*(?:-|–|—|alle|fino alle|\/)\s*\d{1,2}(?:[:.]\d{2})?\b/;
const plain = (v) => String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const SPOKEN_AT = /\s*\b(?:chiocciola|at)\b\s*/gi;

const KEY_START = /\b(?:tel\.?|telefono|cell\.?|cellulare|whatsapp|chiamate(?:ci)?|instagram|insta|ig|facebook|fb|coperto|il coperto|orari(?:o)?(?: nuovi| di apertura)?|siamo aperti|apriamo)\b/gi;
function clauses(line) {
  // Una riga può contenere più informazioni: «aperti 12-14:30, chiusi il martedì. Telefono …, Instagram … e su Facebook …».
  const out = [];
  for (const sentence of line.split(/(?<=[.;!?])\s+(?=[A-ZÀ-Ýa-z])/)) {
    const starts = [...sentence.matchAll(KEY_START)].map((m) => m.index).filter((i, k, a) => !k || i - a[k - 1] > 3);
    if (!starts.length) { out.push(sentence); continue; }
    if (starts[0] > 0) out.push(sentence.slice(0, starts[0]));
    starts.forEach((start, k) => out.push(sentence.slice(start, starts[k + 1] ?? sentence.length)));
  }
  return out.map((c) => c.replace(/^[\s,;]+|[\s,;]+$/g, '').replace(/\s+(?:oppure|e|o|e su|su|seguiteci su|o su)$/i, '').trim()).filter(Boolean);
}

function phoneIn(text) {
  const t = plain(text);
  const keyword = /\b(?:tel|telefono|telefonare|cell|cellulare|numero|whatsapp|chiamare|chiamateci|prenotazioni)\b/.test(t);
  const found = [...String(text).matchAll(/(?:\+|00)?\d[\d\s./-]{4,18}\d/g)].map((m) => m[0].trim())
    .filter((n) => { const digits = n.replace(/\D/g, ''); return digits.length >= 6 && digits.length <= 13 && !TIME.test(n) && !/^\d{1,2}[:.]\d{2}/.test(n); });
  const italian = found.filter((n) => /^(?:\+39|0039)?\s*(?:0\d|3\d)/.test(n.replace(/[^\d+]/g, '')));
  if (!found.length || (!keyword && !italian.length)) return null;
  const list = [...new Set((keyword ? found : italian).map((n) => n.replace(/[./-]/g, ' ').replace(/\s+/g, ' ').replace(/^0039/, '+39')))];
  if (list.length > 1) return { doubt: `Ho trovato più numeri (${list.join(', ')}): quale metto nel menu?` };
  return { value: list[0] };
}

function instagramIn(text) {
  const spokenAt = /\bchiocciola\b/i.test(text);
  const t = String(text).replace(SPOKEN_AT, ' @');
  if (spokenAt) {
    const spoken = (t.split('@')[1] || '').replace(/\s+punto\s+/gi, '.').replace(/\s+(?:trattino basso|underscore)\s+/gi, '_').replace(/\s+(?:al|del|per il|sul)\s+(?:menu|locale)\b.*$/i, '');
    const words = spoken.trim().split(/\s+/).slice(0, 3).filter((w) => /^[A-Za-z0-9._]+$/.test(w));
    const handle = words.join('').toLowerCase();
    return handle.length >= 3 ? { value: handle, doubt: `Ho capito Instagram @${handle}: è giusto?` } : { doubt: 'Non ho capito l’account Instagram: scrivimelo.' };
  }
  const url = t.match(/instagram\.com\/([A-Za-z0-9._]{2,30})/i);
  if (url) return { value: url[1] };
  const key = /\b(?:instagram|insta|ig)\b/i.exec(t);
  if (!key) return null;
  const after = t.slice(key.index + key[0].length, key.index + key[0].length + 60);
  const at = after.match(/@([A-Za-z0-9._]{2,30})/) || t.match(/@([A-Za-z0-9._]{2,30})(?![A-Za-z0-9._]*@|\.[a-z]{2,4}\b)/);
  if (at) return { value: at[1].replace(/\.$/, '') };
  const word = after.match(/^\s*(?:e|è|:|=|ci trovate come|come|siamo|si chiama|account|profilo)?\s*([A-Za-z0-9._]{3,30})\s*[.,]?\s*$/i);
  if (word && !/^(?:il|la|lo|di|del|nostro|nostra)$/i.test(word[1])) return { value: word[1], check: `scritto senza @` };
  const spoken = after.match(/^\s*(?:e|è|:)?\s*((?:[A-Za-z0-9]+\s+){1,3}[A-Za-z0-9]+)\s*[.,]?\s*$/);
  if (spoken) return { doubt: `Instagram detto a parole («${spoken[1]}»): dimmi l’account esatto.` };
  return { doubt: 'Il locale cita Instagram ma non scrive l’account: chiedilo.' };
}

function facebookIn(text) {
  const t = String(text);
  const url = t.match(/(?:https?:\/\/)?(?:www\.|m\.)?(?:facebook|fb)\.com\/[^\s,;]+/i);
  if (url) return { value: url[0].startsWith('http') ? url[0].replace(/[.)]+$/, '') : `https://${url[0].replace(/[.)]+$/, '')}` };
  const key = /\b(?:facebook|fb)\b/i.exec(t);
  if (!key) return null;
  const after = t.slice(key.index + key[0].length).trim().replace(/^\s*(?:e|è|:|=|come|ci trovate come|siamo|pagina|la pagina|si chiama)\s*/i, '').replace(/^\s*(?:è|:)\s*/, '').trim();
  const at = after.match(/^@?([A-Za-z0-9.]{3,50})\s*[.,]?\s*$/);
  if (at) return { value: at[1] };
  const name = after.match(/^[«"“']?([A-ZÀ-Ý0-9][^.;!?«»"“”]{2,60}?)[»"”']?\s*[.,]?\s*$/);
  if (name) return { value: name[1].trim(), check: 'indicata col nome: il menu apre la ricerca di questa pagina; se hai l’indirizzo esatto è meglio' };
  return { doubt: 'Il locale cita Facebook ma non scrive la pagina: chiedila.' };
}

// Indirizzo scritto nel testo: «a Gorizia, in via Rastello 12» oppure «Via Rastello 12, 34170 Gorizia».
const STREET = /\b([Vv]iale|[Vv]ia|[Pp]iazzale|[Pp]iazza|[Cc]orso|[Bb]orgo|[Ll]argo|[Vv]icolo|[Ss]trada|[Cc]ontrada|[Rr]iva|[Cc]alle)\s+((?:[A-ZÀ-Ý0-9][\p{L}'’.]*|d[aei]l?l?[aeoi]?['’]?|d[ei]|del|della|dei|degli|delle|san|santa)(?:\s+(?:[A-ZÀ-Ý0-9][\p{L}'’.]*|d[aei]l?l?[aeoi]?['’]?|d[ei]|del|della|dei|degli|delle|san|santa)){0,4}?)\s*,?\s*(?:n\.?\s*)?(\d{1,4}(?:\/?[a-zA-Z])?)\b/u;
const CITY = "([A-ZÀ-Ý][\\p{L}'’]+(?:\\s+(?:[A-ZÀ-Ý][\\p{L}'’]+|d[ie]l?|sul|al)){0,3})";
function addressIn(text) {
  const t = String(text);
  if (!/\b(?:via|viale|piazza|piazzale|corso|borgo|largo|vicolo|strada|contrada|riva|calle|indirizzo)\b/i.test(t)) return null;
  const st = STREET.exec(t);
  if (!st || !/(?:^|\s)[A-ZÀ-Ý]/.test(st[2])) return null;
  const street = `${st[1].charAt(0).toUpperCase()}${st[1].slice(1).toLowerCase()} ${st[2]} ${st[3]}`;
  const after = t.slice(st.index + st[0].length);
  const before = t.slice(0, st.index);
  const cityAfter = new RegExp(`^(?:\\s*[,–-]\\s*(?:\\d{5}\\s+)?|\\s+(?:a|ad)\\s+)${CITY}`, 'u').exec(after);
  const cityBefore = new RegExp(`\\b(?:a|ad|in)\\s+${CITY}\\s*,?\\s*(?:in\\s+|nella\\s+|sulla\\s+)?$`, 'u').exec(before);
  const city = (cityAfter || cityBefore)?.[1]?.replace(/\s+(?:d[ie]l?|sul|al)$/, '');
  return city ? { value: `${street}, ${city}` } : { value: street, check: 'senza città: aggiungila se serve' };
}

function coverIn(text) {
  const t = plain(text);
  if (!/\bcoperto\b/.test(t)) return null;
  if (/\b(?:non|niente|senza|togli\w*|toglie\w*|rimuov\w*|elimin\w*|nessun)\b[^.]{0,30}\bcoperto\b|\bcoperto\b[^.]{0,20}\b(?:gratis|gratuito|non c'e|non ce)\b/.test(t)) return { doubt: 'Frase sul coperto negativa o da togliere: decidi tu.' };
  const amounts = [...t.matchAll(/(\d{1,2})(?:[,.](\d{1,2}))?\s*(?:€|euro|eur)?/g)].filter((m) => !/\d[:.]\d{2}\s*[-–]/.test(t.slice(m.index, m.index + 8)));
  if (amounts.length !== 1) return amounts.length ? { doubt: 'Più importi nella frase sul coperto: quale è giusto?' } : { doubt: 'Coperto citato senza importo: chiedilo al locale.' };
  const [, euro, cents = ''] = amounts[0];
  const value = `${Number(euro)},${cents.padEnd(2, '0')}`;
  if (Number(value.replace(',', '.')) > 10 || Number(value.replace(',', '.')) <= 0) return { value, doubt: `Coperto di ${value} €: importo insolito, confermalo.` };
  return { value };
}

function hoursIn(text) {
  const t = plain(text);
  const timeLike = TIME.test(t) || /\bdalle\s+\d{1,2}/.test(t);
  const daysLike = new RegExp(`\\b(?:${DAYS})\\b|tutti i giorni|ogni giorno|feriali|festivi|weekend`).test(t);
  const hoursWord = /\b(?:orari|orario|aperti|aperto|apertura|apriamo|chiusi|chiuso|chiusura|chiudiamo|pranzo|cena)\b/.test(t);
  if (!(timeLike && (hoursWord || daysLike)) && !(hoursWord && daysLike && /\bchius\w*/.test(t))) return null;
  let value = String(text).replace(/^\s*(?:siamo\s+)?(?:aperti|apriamo|(?:i\s+|gli\s+)?(?:nuovi\s+)?orari(?:o)?(?: nuovi| di apertura)?(?:\s+(?:sono|diventano|cambiano in))?)\s*[:\-–]?\s*/i, '').replace(/^\s*(?:i nostri orari sono|gli orari sono|l'orario è)\s*/i, '').replace(/[.;]\s*$/, '').trim();
  value = value.charAt(0).toUpperCase() + value.slice(1);
  return { value };
}

/**
 * @param {string} sourceText testo dell'email o frase detta a voce
 * @returns {{ found: Record<string, {value?: string, doubt?: string, line: number, source: string, fixed: boolean}> }}
 */
export function extractVenueInfo(sourceText, { protectedWords = [] } = {}) {
  const found = {};
  const guard = new Set(protectedWords.map(plain));
  // Righe spezzate dall'a capo automatico dell'email: si riuniscono le frasi (la riga indicata resta la prima).
  const rawLines = String(sourceText || '').split(/\r?\n/), lines = [], lineNo = [];
  rawLines.forEach((raw, i) => {
    const prev = lines.length - 1, t = raw.trim();
    if (prev >= 0 && t && lines[prev].trim().length > 45 && !/[.!?:]$/.test(lines[prev].trim()) && /^[a-zà-ÿ0-9]/.test(t)) { lines[prev] = `${lines[prev].trim()} ${t}`; return; }
    lines.push(raw); lineNo.push(i + 1);
  });
  const hours = [];
  lines.forEach((raw, k) => {
    const index = lineNo[k] - 1;
    const original = raw.trim().replace(/^[-•*]\s*/, '');
    // Righe «[da verificare] …» della lettura di una foto: sono dubbi su piatti, mai informazioni del locale.
    if (!original || /^>/.test(original) || /^\[da verificare\]/i.test(original)) return;
    const line = fixTypos(original, VOCAB, guard);
    const before = new Set(original.toLowerCase().match(/[a-zà-ÿ]+/g) || []);
    const corrected = new Set((line.toLowerCase().match(/[a-zà-ÿ]+/g) || []).filter((w) => !before.has(w)));
    for (const clause of clauses(line)) {
      const fixed = (clause.toLowerCase().match(/[a-zà-ÿ]+/g) || []).some((w) => corrected.has(w));
      const put = (field, result) => {
        if (!result || found[field]?.value && !result.doubt) { if (result && found[field] && found[field].value !== result.value && field !== 'orari') found[field] = { doubt: `Due valori diversi per ${field} («${found[field].value}» e «${result.value}»): quale tengo?`, line: index + 1, source: original, fixed }; return; }
        found[field] = { ...result, line: index + 1, source: original, fixed, clause };
      };
      if (/\bcoperto\b/i.test(clause)) { put('coperto', coverIn(clause)); continue; }
      const fb = facebookIn(clause); if (fb) { put('facebook', fb); continue; }
      const ig = instagramIn(clause); if (ig) { put('instagram', ig); continue; }
      const hr = hoursIn(clause);
      const ph = phoneIn(hr ? clause.replace(new RegExp(TIME.source, 'g'), ' ') : clause);
      if (hr) hours.push({ ...hr, line: index + 1, source: original, fixed, clause });
      if (ph && (!hr || /\b(?:tel|telefono|cell|cellulare|numero|whatsapp|chiamate)\b/i.test(clause))) put('telefono', ph);
    }
  });
  if (!found.indirizzo) for (const [k, raw] of lines.entries()) {
    if (/^>/.test(raw.trim())) continue;
    const ad = addressIn(raw);
    if (ad) { found.indirizzo = { ...ad, line: lineNo[k], source: raw.trim(), fixed: false, clause: null }; break; }
  }
  if (hours.length) {
    // orari: refuso segnalato se una delle parti è stata corretta
    const sameBlock = hours.every((h, i) => !i || h.line - hours[i - 1].line <= 2);
    found.orari = sameBlock
      ? { value: hours.map((h) => h.value).join(', ').slice(0, 200), clauses: hours.map((h) => h.clause), line: hours[0].line, source: hours.map((h) => h.source).filter((s, i, a) => a.indexOf(s) === i).join(' / '), fixed: hours.some((h) => h.fixed) }
      : { doubt: `Orari scritti in punti diversi dell’email (righe ${hours.map((h) => h.line).join(', ')}): controllali tu.`, line: hours[0].line, source: hours[0].source, fixed: false };
  }
  return { found };
}

/** Il testo senza le parti già lette come informazioni del locale (per non confonderle con i piatti). */
export function withoutVenueInfo(sourceText, info) {
  const parts = Object.values(info.found || {}).filter((f) => f.value && !f.doubt).flatMap((f) => f.clauses || [f.clause]).filter(Boolean);
  return String(sourceText || '').split(/\r?\n/).map((raw) => {
    let line = fixTypos(raw, VOCAB);
    for (const part of parts) line = line.replace(part, ' ');
    line = line.replace(/\s*[,;]\s*(?=[,;.]|$)/g, '').replace(/\s{2,}/g, ' ').trim();
    return /[A-Za-zÀ-ÿ]{3}/.test(line) ? line : '';
  }).join('\n');
}

export const INFO_LABELS = { coperto: 'Coperto', telefono: 'Telefono', orari: 'Orari', instagram: 'Instagram', facebook: 'Facebook', indirizzo: 'Indirizzo' };
const show = (field, value) => (field === 'coperto' ? `${value} €` : field === 'instagram' ? `@${value}` : value);

/**
 * Applica al menu solo i valori sicuri e diversi da quelli già presenti.
 * @returns {{ menu, applied: Array, doubts: Array, provenance: Array, warnings: string[] }}
 */
export function applyVenueInfo(menu, info, { source = 'testo ricevuto', overwrite = false } = {}) {
  const next = { ...menu }, applied = [], doubts = [], provenance = [], warnings = [];
  for (const [field, entry] of Object.entries(info.found || {})) {
    if (entry.doubt || !entry.value) { doubts.push({ field, ...entry }); continue; }
    const current = field === 'orari' ? (typeof menu.orari === 'object' ? menu.orari?.it : menu.orari) : menu[field];
    if (String(current || '') === entry.value) continue;
    if (current && !overwrite) { doubts.push({ field, ...entry, doubt: `${INFO_LABELS[field]}: nel menu c’è «${current}», nel testo «${entry.value}». Quale tengo?` }); continue; }
    next[field] = field === 'orari' ? { it: entry.value } : entry.value;
    applied.push({ field, value: entry.value, before: current || null, line: entry.line, source: entry.source, fixed: entry.fixed, check: entry.check || null });
    provenance.push({ path: field === 'orari' ? 'orari.it' : field, source: entry.line ? `riga ${entry.line}` : source, value: entry.value, status: 'confermato' });
  }
  if (applied.length) warnings.push(`Inseriti dal testo: ${applied.map((a) => `${INFO_LABELS[a.field]} ${show(a.field, a.value)}${a.before ? ` (prima «${a.before}»)` : ''}${a.line ? ` (riga ${a.line})` : ''}${a.fixed ? ' — corretto un refuso, controlla' : ''}${a.check ? ` — ${a.check}` : ''}`).join('; ')}.`);
  for (const d of doubts) warnings.push(`Da confermare — ${INFO_LABELS[d.field]}: ${d.doubt}`);
  return { menu: next, applied, doubts, provenance, warnings };
}

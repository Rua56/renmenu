// Agenda delle visite: Riccardo detta a Jarvis i locali da visitare («questa settimana devo visitare
// questi locali: …»), poi gli dice man mano «ho visitato …». Se per un giorno non si fa sentire,
// Jarvis gli ricorda quelli che mancano. Solo un promemoria: non scrive a nessun locale.
import { PLACE } from './visit.js';

export const AGENDA_KEY = 'agenda';
export const AGENDA_WAIT_KEY = 'agenda_wait';
export const AGENDA_WAIT_MS = 30 * 60_000;
export const AGENDA_QUIET_MS = 24 * 3600_000;
const HEAD = /^\s*(?:jarvis[\s,!.]*)?/i.source;
const PREP = `(?:all['’]\\s*|dall['’]\\s*|(?:alla|allo|alle|al|ai|agli|dalla|dallo|dal|dai|da|a|in)\\s+)`;
const NUMBERS = { uno: 1, un: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, sette: 7, otto: 8, nove: 9, dieci: 10, undici: 11, dodici: 12, quindici: 15, venti: 20 };

export const plain = (text) => String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** «il bar Centrale» → «bar Centrale»; «Al Bakaro» resta com'è (l'articolo fa parte del nome). */
export function cleanVenue(name) {
  let out = String(name || '').replace(/^\s*(?:\d+\s*[.)\-]|[-•*·])\s*/, '').replace(/[\s.!?;:]+$/, '').replace(/^[«"“']|[»"”']$/g, '').trim();
  const articled = out.match(/^(?:il|lo|la|l['’]|i|gli|le|al|alla|allo|all['’]|ai|dal|dalla|da)\s*(.*)$/i);
  if (articled && PLACE.test(articled[1])) out = articled[1];
  return out.slice(0, 80);
}

/** Elenco di nomi: righe, virgole o punti e virgola; l'ultimo pezzo si divide anche su «e». */
export function splitNames(text) {
  const parts = String(text || '').split(/\n|;|,/).map((p) => p.trim()).filter(Boolean);
  if (parts.length) {
    const last = parts.pop();
    const tail = last.match(/^(.+?)\s+(?:e|ed|poi|infine)\s+(.+)$/i);
    if (tail && parts.length) parts.push(tail[1], tail[2]);
    // Senza virgole («bar Centrale e Pizzeria Università») si divide solo se sembrano due locali: «Pane e Vino» resta uno.
    else if (tail && !parts.length && (PLACE.test(tail[2]) || /^(?:il|lo|la|l['’]|i|gli|le|al|alla|ai|da|dal)\s/i.test(tail[2]) || (tail[1].trim().split(/\s+/).length >= 2 && tail[2].trim().split(/\s+/).length >= 2))) parts.push(tail[1], tail[2]);
    else parts.push(last);
  }
  const seen = new Set();
  return parts.map(cleanVenue).filter((n) => /[a-zà-ÿ]{2}/i.test(n) && !/^(?:e|ed|poi|basta|grazie|fine)$/i.test(n)).filter((n) => { const k = plain(n); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 30);
}

/**
 * Cosa vuole Riccardo dall'agenda. null = non parla dell'agenda.
 * create {names, count}, done {names, note}, add {names}, show, clear.
 */
export function parseAgenda(text) {
  const line = String(text || '').trim();
  if (!line || line.length > 1500) return null;
  if (new RegExp(`${HEAD}(?:cancella|elimina|svuota|chiudi|azzera|butta)\\s+(?:via\\s+)?(?:l['’]\\s*|tutta\\s+l['’]\\s*)?agenda\\b`, 'i').test(line) || /^\s*(?:jarvis[\s,!.]*)?agenda\s+(?:finita|chiusa|completata)\b/i.test(line)) return { kind: 'clear' };
  const create = line.match(new RegExp(`${HEAD}(?:[^\\n]{0,60}?\\b(?:devo|dovrei|vado\\s+a|voglio|ho\\s+da|andr[oò]\\s+a)\\s+visitare\\b|(?:nuova\\s+agenda|prepara(?:mi)?\\s+(?:l['’]\\s*)?agenda|fammi\\s+(?:l['’]\\s*)?agenda|\\/?agenda\\s*[:\\-\\n]))([\\s\\S]*)$`, 'i'));
  if (create) {
    let rest = create[1];
    const count = (() => { const m = rest.match(/^\s*(?:questi\s+|i\s+seguenti\s+)?(\d{1,2}|[a-z]+)\s+locali\b/i); return m ? Number(m[1]) || NUMBERS[m[1].toLowerCase()] || null : null; })();
    rest = rest.includes(':') ? rest.slice(rest.indexOf(':') + 1) : rest.replace(/^\s*(?:questi\s+|i\s+seguenti\s+|ancora\s+)?(?:(?:\d{1,2}|[a-z]+)\s+)?locali\b\s*(?:che\s+sono\s+|cio[eè]\s+)?/i, '');
    rest = rest.replace(/^\s*(?:questa|la\s+prossima)\s+settimana\b/i, '');
    return { kind: 'create', names: splitNames(rest), count };
  }
  const done = line.match(new RegExp(`${HEAD}(?:ho\\s+(?:gi[aà]\\s+|appena\\s+)?(?:visitato\\s+|fatto\\s+(?:la\\s+)?visita\\s+${PREP}|finito\\s+(?:la\\s+visita\\s+)?${PREP})|sono\\s+(?:gi[aà]\\s+|appena\\s+)?(?:stato|passato|andato)\\s+${PREP}|visitat[oi]\\s*:?\\s*|fatt[oi]\\s*:\\s*)([\\s\\S]+)$`, 'i'));
  if (done) {
    const [names, ...note] = done[1].split(/\s*(?::|—|–|\s-\s)\s*/);
    return { kind: 'done', names: splitNames(names), note: note.join(' ').trim().slice(0, 300) };
  }
  const add = line.match(new RegExp(`${HEAD}(?:aggiungi|metti|inserisci)\\s+(?:nell['’]\\s*agenda|all['’]\\s*agenda|in\\s+agenda)\\s+([\\s\\S]+)$`, 'i'))
    || line.match(new RegExp(`${HEAD}(?:aggiungi|metti|inserisci)\\s+([\\s\\S]+?)\\s+(?:nell['’]\\s*agenda|all['’]\\s*agenda|in\\s+agenda)[\\s.!]*$`, 'i'));
  if (add) return { kind: 'add', names: splitNames(add[1]) };
  if (new RegExp(`${HEAD}(?:\\/agenda|agenda|(?:mostrami|fammi\\s+vedere|dammi|leggimi|com['’]?\\s*[eè])\\s+(?:l['’]\\s*)?agenda(?:\\s+delle\\s+visite)?|(?:che|quali)\\s+locali\\s+(?:devo\\s+ancora\\s+visitare|mi\\s+mancano|mi\\s+restano)(?:\\s+da\\s+visitare)?|(?:chi|cosa)\\s+mi\\s+(?:manca|resta)(?:\\s+da\\s+visitare)?|a\\s+che\\s+punto\\s+sono\\s+con\\s+le\\s+visite)[\\s?!.]*$`, 'i').test(line)) return { kind: 'show' };
  return null;
}

export const parseStored = (raw) => { try { const a = JSON.parse(raw || 'null'); return a && Array.isArray(a.items) ? a : null; } catch { return null; } };
const sameName = (a, b) => plain(a) === plain(b);
/** Nome detto → voce dell'agenda (uguale, contenuto, o tutte le parole lunghe presenti). */
export function findItem(items, said) {
  const key = plain(said).replace(/^(?:al|all|allo|alla|il|lo|la|l|da|dal|dalla|del|della|ai)\s+/, '');
  if (key.length < 3) return null;
  const exact = items.find((i) => sameName(i.name, said));
  if (exact) return exact;
  const words = key.split(' ').filter((w) => w.length > 2);
  const hits = items.filter((i) => { const hay = ` ${plain(i.name)} `; return hay.includes(` ${key} `) || (words.length && words.every((w) => hay.includes(` ${w}`))); });
  return hits.length === 1 ? hits[0] : null;
}

export function newAgenda(names, at) {
  return { created_at: at, last_contact: at, last_reminder: null, items: names.map((name) => ({ name, done_at: null, note: '' })) };
}
export function addItems(agenda, names, at) {
  const added = [];
  for (const name of names) if (!agenda.items.some((i) => sameName(i.name, name))) { agenda.items.push({ name, done_at: null, note: '' }); added.push(name); }
  agenda.last_contact = at;
  return added;
}
/** Segna come visitati i locali detti. Quelli che non sono in agenda li aggiunge già visitati. */
export function markDone(agenda, names, note, at) {
  const marked = [], extra = [], again = [];
  for (const said of names) {
    const item = findItem(agenda.items, said);
    if (item && item.done_at) { again.push(item.name); continue; }
    if (item) { item.done_at = at; if (note) item.note = note; marked.push(item.name); continue; }
    agenda.items.push({ name: said, done_at: at, note: note || '', extra: true });
    extra.push(said);
  }
  agenda.last_contact = at;
  return { marked, extra, again };
}
export const remaining = (agenda) => (agenda?.items || []).filter((i) => !i.done_at);

export function agendaText(agenda) {
  if (!agenda?.items?.length) return 'L’agenda delle visite è vuota. Dimmi per esempio «questa settimana devo visitare: Bar Centrale, Pizzeria Università, Ai Tre Soldi» e la preparo.';
  const left = remaining(agenda), done = agenda.items.length - left.length;
  const lines = agenda.items.map((i) => `${i.done_at ? '✅' : '⬜️'} ${i.name}${i.note ? ` · ${i.note}` : ''}`);
  return `Agenda delle visite: ${done} su ${agenda.items.length} fatte.\n${lines.join('\n')}\n\n${left.length ? 'Quando passi da uno, scrivimi o dimmi «ho visitato …».' : 'Hai visitato tutti i locali dell’agenda. Complimenti!'}`;
}
export function createdText(agenda, count) {
  const n = agenda.items.length;
  const short = count && count !== n ? ` Me ne hai detti ${n} su ${count}: se ne manca qualcuno dimmi «aggiungi all’agenda …».` : '';
  return `Agenda pronta, ${n} ${n === 1 ? 'locale' : 'locali'} da visitare:\n${agenda.items.map((i, k) => `${k + 1}. ${i.name}`).join('\n')}\n\nQuando passi da uno dimmi «ho visitato …» (anche più di uno insieme, e dopo i due punti una nota: «ho visitato Bar Centrale: vuole il Premium»). Se per un giorno non mi dici niente, ti ricordo quelli che mancano.${short}`;
}
export function doneText(agenda, { marked, extra, again }) {
  const left = remaining(agenda);
  const bits = [];
  if (marked.length) bits.push(`Segnato: ${marked.join(', ')} ✅.`);
  if (extra.length) bits.push(`${extra.join(', ')} non ${extra.length === 1 ? 'era' : 'erano'} in agenda: ${extra.length === 1 ? 'l’ho aggiunto' : 'li ho aggiunti'} come già ${extra.length === 1 ? 'visitato' : 'visitati'}.`);
  if (again.length) bits.push(`${again.join(', ')} ${again.length === 1 ? 'era' : 'erano'} già segnat${again.length === 1 ? 'o' : 'i'}.`);
  bits.push(left.length ? `Ne ${left.length === 1 ? 'resta uno' : `restano ${left.length}`}: ${left.map((i) => i.name).join(', ')}.` : 'Hai visitato tutti i locali dell’agenda!');
  return bits.join(' ');
}

/** Promemoria: ci sono locali da visitare e Riccardo non si fa sentire da un giorno (solo dalle 9 alle 20). */
export function reminderDue(agenda, at = new Date(), hour = 12) {
  if (!agenda || !remaining(agenda).length || hour < 9 || hour >= 20) return false;
  const last = Math.max(Date.parse(agenda.last_contact || '') || 0, Date.parse(agenda.last_reminder || '') || 0);
  return at.getTime() - last >= AGENDA_QUIET_MS;
}
export const reminderText = (agenda) => {
  const left = remaining(agenda);
  return `Riccardo, è da ieri che non mi dici niente delle visite. Ti ${left.length === 1 ? 'resta da visitare' : `restano da visitare ${left.length} locali`}: ${left.map((i) => i.name).join(', ')}.\n\nQuando passi da uno dimmi «ho visitato …». Se un locale non ti interessa più: «cancella l’agenda» per ripartire da capo.`;
};

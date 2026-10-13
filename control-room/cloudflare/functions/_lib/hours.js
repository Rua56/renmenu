// Orari di apertura: da una frase libera («mercoledì chiuso, da giovedì a martedì dalle 12 alle 15 e
// dalle 19 alle 22») a una riga ordinata, uguale in italiano e in inglese, senza traduzione automatica.
//
// Regole: si legge solo ciò che c'è scritto. Se la frase è ambigua (cifre che non sono orari, giorni
// senza orario, frasi senza giorni su un menu che ha già orari illeggibili) la funzione restituisce
// null e il chiamante lascia la decisione a Riccardo. Mai inventare giorni o orari.

const DAYS_IT = ['lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato', 'domenica'];
const DAYS_EN = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const SHORT_IT = ['lun', 'mar', 'mer', 'gio', 'ven', 'sab', 'dom'];
const SHORT_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY = '(?:lunedi|lun|martedi|mar|mercoledi|mer|giovedi|gio|venerdi|ven|sabato|sab|domenica|dom)';
const DAY_RE = new RegExp(`\\b${DAY}\\b\\.?`, 'g');
const dayIndex = (token) => ['lun', 'mar', 'mer', 'gio', 'ven', 'sab', 'dom'].indexOf(token.slice(0, 3));
const plain = (value) => String(value || '').toLocaleLowerCase('it-IT').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const CONNECT = '(?:-|a|al|alla|fino a|fino al|fino alla)';
const TIME_RE = /(?:dalle\s+(?:ore\s+)?)?(\d{1,2})(?:[:.h](\d{2}))?\s*(?:-|alle(?:\s+ore)?|a(?=\s*\d))\s*(?:ore\s+)?(\d{1,2})(?:[:.h](\d{2}))?/g;
const CLOSED = /\bchius\w*|\briposo\b|\bnon (?:siamo aperti|apriamo|apre)\b/;
const EXCEPT = /\b(?:tranne|eccetto|escluso|esclusi|salvo)\b/;

function span(a, b) {
  const out = [];
  for (let i = a; ; i = (i + 1) % 7) { out.push(i); if (i === b) break; }
  return out;
}

function daysIn(text) {
  let t = text;
  const days = new Set();
  const range = new RegExp(`(?:\\b(?:da|dal|dallo)\\s+)?\\b(${DAY})\\b\\.?\\s*${CONNECT}\\s*\\b(${DAY})\\b`, 'g');
  t = t.replace(range, (_, a, b) => { span(dayIndex(a), dayIndex(b)).forEach((d) => days.add(d)); return ' '; });
  // «giovedì … e così via fino a lunedì»: dal giorno già nominato fino a quello indicato.
  const until = t.match(new RegExp(`\\bfino a(?:l|lla)?\\s+(${DAY})\\b`));
  if (until) {
    const before = [...t.slice(0, until.index).matchAll(DAY_RE)].map((m) => dayIndex(m[0].replace('.', '')));
    if (before.length) { span(before[before.length - 1], dayIndex(until[1])).forEach((d) => days.add(d)); t = t.replace(until[0], ' '); }
  }
  for (const match of t.matchAll(DAY_RE)) days.add(dayIndex(match[0].replace('.', '')));
  if (/\btutti i giorni\b|\bogni giorno\b|\bsempre\b|\b7 giorni su 7\b/.test(t)) for (let i = 0; i < 7; i += 1) days.add(i);
  if (/\bferiali\b/.test(t)) [0, 1, 2, 3, 4].forEach((d) => days.add(d));
  if (/\bweekend\b|\bfine settimana\b|\bfestivi\b/.test(t)) [5, 6].forEach((d) => days.add(d));
  return days;
}

function minutes(h, m) {
  const hour = Number(h), min = m === undefined ? 0 : Number(m);
  if (!Number.isInteger(hour) || hour < 0 || hour > 24 || min < 0 || min > 59 || (hour === 24 && min)) return null;
  return hour * 60 + min;
}

function rangesIn(text) {
  const ranges = [];
  const rest = text.replace(TIME_RE, (_, h1, m1, h2, m2) => {
    const start = minutes(h1, m1), end = minutes(h2, m2);
    if (start === null || end === null || start === end) { ranges.push(null); return ' '; }
    ranges.push([start, end]);
    return ' ';
  });
  return { ranges, rest };
}

/** Coppie «inizio-fine» (in minuti) scritte in un testo: servono a verificare che nulla sia inventato. */
export function timesWritten(text) {
  const out = new Set();
  for (const range of rangesIn(plain(text).replace(/(\d),(\d{2})\b/g, '$1:$2')).ranges) if (range) out.add(range.join('-'));
  return out;
}

function assignments(text) {
  let t = plain(text).replace(/[–—−]/g, '-').replace(/(\d),(\d{2})\b/g, '$1:$2').replace(/\s*·\s*/g, ', ').replace(/\n+/g, ', ');
  const splitter = new RegExp(`(?:[,;]|\\.(?=\\s|$))\\s*|\\s+(?=ma\\s)|\\s+e\\s+(?=(?:(?:da|dal|il|nel|di)\\s+)?(?:${DAY}|tutti|ogni)\\b)`);
  const out = [];
  let pending = new Set();
  let prevClosed = false;
  for (const part of t.split(splitter)) {
    const segment = (part || '').trim();
    if (!segment) continue;
    const wasClosed = prevClosed;
    prevClosed = false;
    const { ranges, rest } = rangesIn(segment);
    if (ranges.includes(null)) return null;
    if (/\d/.test(rest)) return null;
    let days = daysIn(rest);
    const closed = CLOSED.test(rest);
    if (EXCEPT.test(rest)) {
      const [left, right] = rest.split(EXCEPT);
      const kept = daysIn(left), excluded = daysIn(right);
      const base = kept.size ? kept : new Set([0, 1, 2, 3, 4, 5, 6]);
      if (!excluded.size) return null;
      days = new Set([...base].filter((d) => !excluded.has(d)));
      if (ranges.length) { out.push({ days: new Set([...pending, ...days]), ranges }); pending = new Set(); }
      out.push({ days: excluded, closed: true });
      continue;
    }
    if (closed) {
      const target = new Set([...pending, ...days]);
      if (!target.size) return null;
      pending = new Set();
      out.push({ days: target, closed: true });
      prevClosed = true;
      continue;
    }
    if (ranges.length) {
      const last = out[out.length - 1];
      if (!days.size && !pending.size && last && last.ranges) { last.ranges.push(...ranges); continue; }
      out.push({ days: days.size || pending.size ? new Set([...pending, ...days]) : null, ranges });
      pending = new Set();
      continue;
    }
    if (days.size) {
      const last = out[out.length - 1];
      // «chiusi il lunedì e il mercoledì»: il secondo giorno eredita «chiuso» dalla frase precedente.
      if (wasClosed && last?.closed) { days.forEach((d) => last.days.add(d)); prevClosed = true; continue; }
      days.forEach((d) => pending.add(d));
    }
  }
  if (pending.size) return null;
  return out.length ? out : null;
}

/** Legge un testo di orari in una settimana: ogni giorno è undefined, 'closed' oppure [[inizio, fine], …]. */
function readWeek(text, base) {
  const list = assignments(text);
  if (!list) return null;
  const week = base ? base.map((d) => (Array.isArray(d) ? d.map((r) => [...r]) : d)) : Array(7).fill(undefined);
  for (const entry of list) {
    if (entry.closed) { entry.days.forEach((d) => { week[d] = 'closed'; }); continue; }
    const targets = entry.days ? [...entry.days] : week.map((d, i) => i).filter((i) => week[i] !== 'closed');
    const ranges = [...entry.ranges].sort((a, b) => a[0] - b[0]);
    targets.forEach((d) => { week[d] = ranges.map((r) => [...r]); });
  }
  if (week.every((d) => d === undefined)) return null;
  return week;
}

const pad = (n) => String(n).padStart(2, '0');
const clock = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const keyOf = (state) => (state === undefined ? 'u' : state === 'closed' ? 'c' : state.map((r) => r.join('-')).join('+'));

function format(week, lang, short) {
  const en = lang === 'en';
  const names = en ? (short ? SHORT_EN : DAYS_EN) : (short ? SHORT_IT : DAYS_IT);
  const and = en ? ' and ' : ' e ';
  const keys = week.map(keyOf);
  const start = keys.every((k) => k === keys[0]) ? 0 : keys.findIndex((k, i) => k !== keys[(i + 6) % 7]);
  const groups = new Map();
  const closed = [];
  let i = 0;
  while (i < 7) {
    const first = (start + i) % 7, key = keys[first];
    let length = 1;
    while (i + length < 7 && keys[(start + i + length) % 7] === key) length += 1;
    const run = Array.from({ length }, (_, n) => (first + n) % 7);
    if (key === 'c') closed.push(...run);
    else if (key !== 'u') groups.set(key, [...(groups.get(key) || []), run]);
    i += length;
  }
  // Se lo stesso orario vale per gruppi di giorni separati, si elencano nell'ordine della settimana (da lunedì).
  for (const [key, runs] of groups) {
    if (runs.length < 2) continue;
    const flat = [];
    keys.forEach((k, d) => { if (k === key) flat.push(d); });
    const split = [];
    for (const d of flat) { const last = split[split.length - 1]; if (last && last[last.length - 1] === d - 1) last.push(d); else split.push([d]); }
    groups.set(key, split);
  }
  const label = (run, several) => (run.length === 7 ? (en ? 'Every day' : 'Tutti i giorni')
    : run.length === 1 ? names[run[0]] : run.length === 2 && !several ? `${names[run[0]]}${and}${names[run[1]]}` : `${names[run[0]]}–${names[run[run.length - 1]]}`);
  const parts = [];
  for (const [key, runs] of groups) {
    const ranges = week[runs[0][0]].map(([a, b]) => `${clock(a)}–${clock(b)}`).join(and);
    const days = runs.map((run) => label(run, runs.length > 1));
    let text = days.length === 1 ? days[0] : `${days.slice(0, -1).join(', ')}${and}${days[days.length - 1]}`;
    text = text.charAt(0).toUpperCase() + text.slice(1);
    // Un solo orario per tutti i giorni aperti, con qualche giorno di chiusura: basta dire l'orario e la chiusura.
    const everyOpenDay = groups.size === 1 && closed.length && !keys.includes('u') && 7 - closed.length >= 4;
    parts.push(everyOpenDay ? ranges : `${text} ${ranges}`);
  }
  if (closed.length) {
    const ordered = [...closed].sort((a, b) => a - b).map((d) => names[d]);
    const list = en ? (ordered.length === 1 ? ordered[0] : `${ordered.slice(0, -1).join(', ')} and ${ordered[ordered.length - 1]}`)
      : ordered.map((n) => `il ${n}`).join(', ').replace(/, (?=[^,]*$)/, ' e ');
    parts.push(en ? `Closed on ${list}` : `Chiuso ${list}`);
  }
  return parts.join(' · ');
}

/**
 * Orari ordinati in italiano e in inglese.
 * @param {{ existing?: string, text: string, utterance?: string }} input
 *   existing = orari già nel menu (si conservano i giorni che la frase non nomina);
 *   text = testo da leggere; utterance = frase originale di Riccardo (ogni orario deve esserci davvero).
 * @returns {{ it: string, en: string } | null}
 */
export function normalizeHours({ existing = '', text, utterance = text }) {
  const written = timesWritten(utterance);
  const used = timesWritten(text);
  for (const pair of used) if (!written.has(pair)) return null;
  const old = String(existing || '').trim();
  const base = old ? readWeek(old, null) : null;
  const week = readWeek(text, base);
  if (!week) return null;
  // Orari già nel menu che non so leggere: non li sovrascrivo con una settimana a metà.
  if (old && !base && week.some((d) => d === undefined)) return null;
  for (const short of [false, true]) {
    const it = format(week, 'it', short), en = format(week, 'en', short);
    if (it.length <= 200 && en.length <= 200) return { it, en };
  }
  return null;
}

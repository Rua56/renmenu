/* «Mostrami …»: Jarvis apre a schermo l'elenco chiesto a voce o per iscritto (pratiche aperte, chiuse,
 * da decidere, locali registrati, menu online, modifiche, attività recenti), anche filtrato per locale
 * («le pratiche del Bakaro») o per periodo («oggi», «ieri», «questa settimana», «questo mese»).
 * «Mostrami i numeri» apre i grafici olografici: richieste nuove, pratiche chiuse, menu pubblicati e
 * chiamate di Jarvis giorno per giorno (7 giorni, o 30 con «del mese»).
 * Funziona sui dati già caricati nella pagina: nessuna chiamata, nessun costo. Le altre frasi (modifiche
 * alla bozza, anteprime, pubblicazioni) restano a Jarvis. */
const plain = (value) => String(value || '').toLocaleLowerCase('it-IT').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, ' ').replace(/\s+/g, ' ').trim();
const SHOW_VERB = /\b(?:mostra\w*|fammi vedere|fai vedere|vedere|vedo|elenca\w*|elenco|lista|quali|quant[ieo]|apri|visualizza\w*|dammi|dimmi|tutt[ei])\b/;
const STOP = new Set(['ristorante', 'trattoria', 'osteria', 'pizzeria', 'locale', 'bar', 'caffe', 'demo', 'della', 'delle', 'dello', 'degli']);
const SINGLE = { pratiche: ['pratica', 'pratiche'], locali: ['locale', 'locali'], menu: ['menu', 'menu'], modifiche: ['modifica', 'modifiche'], attivita: ['attività', 'attività'] };

function topic(words) {
  if (/\b(?:numeri|grafic\w*|andamento|statistic\w*|trend|come (?:sta|stiamo|va|vanno|sto) andando)\b/.test(words)) return 'numeri';
  if (/\b(?:attivita|registro|storico|cronologia|cosa e successo|cos e successo|ultime azioni|novita)\b/.test(words)) return 'attivita';
  if (/\b(?:modific\w*|aggiornament\w*|cambi(?:amenti)?)\b/.test(words) && !/\b(?:metti|togli|aggiungi|cambia|porta|sostituisci|rinomina)\b/.test(words)) return 'modifiche';
  if (/\bmenu\s+(?:online|creati|pubblicati|attivi|fatti|realizzati)\b|\b(?:i|tutti i|quanti)\s+menu\b|\bmenu\s+(?:che|gia)\b/.test(words)) return 'menu';
  if (/\b(?:locali|clienti|ristoranti)\b/.test(words) || /\blocal\w*\s+registrat\w*/.test(words)) return 'locali';
  if (/\b(?:pratic\w*|richiest\w*)\b/.test(words)) return 'pratiche';
  return null;
}
function practiceFilter(words) {
  if (/\b(?:chius\w*|conclus\w*|complet\w*|finit\w*|archiviat\w*|pubblicat\w*)\b/.test(words)) return 'chiuse';
  if (/\b(?:decider\w*|decision\w*|aspett\w*|attesa|urgent\w*)\b/.test(words)) return 'decidere';
  if (/\bin corso\b|\blavorazione\b|\bsegu\w*\b/.test(words)) return 'corso';
  if (/\bnuov\w*\b/.test(words)) return 'nuove';
  if (/\btutt\w*\b/.test(words) && !/\baperte\b/.test(words)) return 'tutte';
  return 'aperte';
}
function period(words, now) {
  const day = new Date(now); day.setHours(0, 0, 0, 0);
  if (/\boggi\b/.test(words)) return { from: day.getTime(), label: 'di oggi' };
  if (/\bieri\b/.test(words)) return { from: day.getTime() - 86_400_000, to: day.getTime(), label: 'di ieri' };
  if (/\b(?:settimana|7 giorni|sette giorni)\b/.test(words)) return { from: now - 7 * 86_400_000, label: 'degli ultimi 7 giorni' };
  if (/\bmese\b/.test(words)) return { from: now - 30 * 86_400_000, label: 'degli ultimi 30 giorni' };
  return null;
}
function venueIn(words, clients) {
  const scored = clients.map((client) => {
    const keys = plain(client.name).split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w));
    return { client, hits: keys.filter((w) => new RegExp(`\\b${w}\\b`).test(words)).length };
  }).filter((entry) => entry.hits > 0).sort((a, b) => b.hits - a.hits);
  return scored.length && (scored.length === 1 || scored[0].hits > scored[1].hits) ? scored[0].client : null;
}
const inPeriod = (value, range) => {
  if (!range) return true;
  const t = Date.parse(value || '');
  return Number.isFinite(t) && t >= range.from && (!range.to || t < range.to);
};
const PLANS = { standard: 'Standard', annuale: 'Annuale', premium: 'Premium' };
const count = (n, [one, many]) => `${n} ${n === 1 ? one : many}`;
const DAY_MS = 86_400_000;
const WEEKDAYS = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
// Le quattro serie dei grafici: cosa contano e come si dicono a voce.
const SERIES = [
  { key: 'nuove', label: 'Richieste nuove', noun: ['richiesta nuova', 'richieste nuove'], tone: 'info' },
  { key: 'chiuse', label: 'Pratiche chiuse', noun: ['pratica chiusa', 'pratiche chiuse'], tone: 'good' },
  { key: 'menu', label: 'Menu pubblicati', noun: ['menu pubblicato', 'menu pubblicati'], tone: 'good' },
  { key: 'chiamate', label: 'Chiamate', noun: ['chiamata', 'chiamate'], tone: 'hot' }
];

/** Numeri giorno per giorno degli ultimi `span` giorni (oggi compreso), anche di un solo locale. */
export function numbersFor({ pratiche = [], clients = [], audit = [], now = Date.now(), span = 7, venue = null } = {}) {
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const days = Array.from({ length: span }, (_, i) => {
    const start = new Date(today); start.setDate(start.getDate() - (span - 1 - i));
    const end = new Date(start); end.setDate(end.getDate() + 1);
    return { from: start.getTime(), to: end.getTime(), label: `${WEEKDAYS[start.getDay()]} ${start.getDate()}`, today: i === span - 1 };
  });
  const slot = (value) => {
    const t = Date.parse(value || '');
    return Number.isFinite(t) ? days.findIndex((d) => t >= d.from && t < d.to) : -1;
  };
  const ofVenue = (info) => !venue || info.request.clientId === venue.id;
  const requestOf = new Map(pratiche.map((info) => [info.request.id, info]));
  const values = Object.fromEntries(SERIES.map((s) => [s.key, days.map(() => 0)]));
  const add = (key, when) => { const i = slot(when); if (i >= 0) values[key][i] += 1; };
  pratiche.filter(ofVenue).forEach((info) => {
    add('nuove', info.request.createdAt);
    if (info.group === 'chiuse') add('chiuse', info.request.updatedAt || info.request.createdAt);
  });
  audit.forEach((a) => {
    if (a.action === 'github.pr.merged') {
      const info = requestOf.get(a.requestId);
      if (!venue || (info && ofVenue(info))) add('menu', a.createdAt);
    } else if (a.action === 'jarvis.phone_call' && !venue) add('chiamate', a.createdAt);
  });
  const series = SERIES.filter((s) => !venue || s.key !== 'chiamate').map((s) => ({ ...s, values: values[s.key], total: values[s.key].reduce((a, b) => a + b, 0) }));
  const online = clients.filter((c) => c.menuId && (!venue || c.id === venue.id)).length;
  return { days: days.map(({ label, today: isToday }) => ({ label, today: isToday })), series, online };
}

/**
 * Cosa mostrare per una frase. data: { pratiche (con group/headline/tone), clients, audit, now }.
 * Restituisce null se la frase non chiede di vedere un elenco; altrimenti { topic, title, say, rows }.
 */
export function showFor(text, { pratiche = [], clients = [], audit = [], now = Date.now() } = {}) {
  const words = plain(text).replace(/[?!.,;:]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!words || words.length > 160) return null;
  const what = topic(words);
  if (!what) return null;
  // Serve un verbo da «mostrami» oppure una frase corta fatta solo dell'elenco («pratiche chiuse»).
  if (!SHOW_VERB.test(words) && words.split(' ').length > 4) return null;
  const venue = venueIn(words, clients);
  if (what === 'numeri') {
    const span = /\b(?:mese|30 giorni|trenta giorni)\b/.test(words) ? 30 : 7;
    const chart = numbersFor({ pratiche, clients, audit, now, span, venue });
    const title = `Numeri degli ultimi ${span} giorni${venue ? ` · ${venue.name}` : ''}`;
    const said = chart.series.map((s) => count(s.total, s.noun)).join(', ');
    const say = `Negli ultimi ${span} giorni${venue ? ` per ${venue.name}` : ''}: ${said}. ${chart.online === 1 ? 'Un menu online' : `Menu online: ${chart.online}`}${venue ? '' : ' in tutto'}.`;
    return { topic: 'numeri', filter: null, title, say, rows: [], chart };
  }
  const range = period(words, now);
  const suffix = `${venue ? ` di ${venue.name}` : ''}${range ? ` ${range.label}` : ''}`;
  const clientName = (id) => clients.find((c) => c.id === id)?.name || '';
  const fromPratica = (info) => ({ kind: 'request', id: info.request.id, title: info.client?.name || clientName(info.request.clientId) || info.request.subject, sub: `${info.headline} · ${info.request.subject}`, when: info.request.updatedAt || info.request.createdAt || '', tone: info.tone });
  let rows = [], title = '', noun = SINGLE.pratiche, filter = null;
  const ofVenue = (info) => !venue || info.request.clientId === venue.id;
  const when = (info) => inPeriod(info.request.updatedAt || info.request.createdAt, range);
  if (what === 'pratiche') {
    filter = practiceFilter(words);
    // «le pratiche del Bakaro»: di un locale si vedono tutte, anche chiuse, se non chiedi solo le aperte.
    if (venue && filter === 'aperte' && !/\baperte\b/.test(words)) filter = 'tutte';
    const pick = {
      chiuse: (i) => i.group === 'chiuse', decidere: (i) => i.group === 'decidere', corso: (i) => i.group === 'corso',
      nuove: (i) => i.request.status === 'nuova', tutte: () => true, aperte: (i) => i.group !== 'chiuse'
    }[filter];
    rows = pratiche.filter((i) => pick(i) && ofVenue(i) && when(i)).map(fromPratica);
    title = { chiuse: 'Pratiche chiuse', decidere: 'Da decidere', corso: 'Pratiche in corso', nuove: 'Richieste nuove', tutte: 'Tutte le pratiche', aperte: 'Pratiche aperte' }[filter];
  } else if (what === 'modifiche') {
    noun = SINGLE.modifiche;
    rows = pratiche.filter((i) => i.request.kind && i.request.kind !== 'nuovo' && ofVenue(i) && when(i)).map(fromPratica);
    title = 'Modifiche ai menu';
  } else if (what === 'locali') {
    noun = SINGLE.locali;
    rows = clients.filter((c) => (!venue || c.id === venue.id) && inPeriod(c.createdAt, range)).map((c) => ({ kind: 'client', id: c.id, title: c.name, sub: `${c.menuId ? 'Menu online' : 'Menu non ancora online'}${PLANS[c.plan] ? ` · ${PLANS[c.plan]}` : ''}`, when: c.createdAt || '', tone: c.menuId ? 'good' : 'info' }));
    title = 'Locali registrati';
  } else if (what === 'menu') {
    noun = SINGLE.menu;
    rows = clients.filter((c) => c.menuId && (!venue || c.id === venue.id) && inPeriod(c.updatedAt || c.createdAt, range)).map((c) => ({ kind: 'client', id: c.id, title: c.name, sub: `Menu online · ${c.menuId}`, when: c.updatedAt || c.createdAt || '', tone: 'good' }));
    title = 'Menu online';
  } else {
    noun = SINGLE.attivita;
    rows = audit.filter((a) => inPeriod(a.createdAt, range) && (!venue || pratiche.some((i) => i.request.id === a.requestId && i.request.clientId === venue.id)))
      .map((a) => { const info = pratiche.find((i) => i.request.id === a.requestId); return { kind: info ? 'request' : 'event', id: info ? info.request.id : a.id, title: a.summary || a.action || 'Azione', sub: info ? (info.client?.name || info.request.subject) : (a.action || ''), when: a.createdAt || '', tone: 'info' }; });
    title = 'Attività recenti';
  }
  rows.sort((a, b) => String(b.when).localeCompare(String(a.when)));
  if (what === 'attivita') rows = rows.slice(0, 30);
  const label = `${title}${suffix}`;
  const tail = { chiuse: ' chius', decidere: ' da decidere', corso: ' in corso', nuove: ' nuov', aperte: ' apert' }[filter] || '';
  const described = what === 'pratiche' && tail
    ? `${rows.length} ${rows.length === 1 ? 'pratica' : 'pratiche'}${tail.endsWith(' chius') || tail.endsWith(' nuov') || tail.endsWith(' apert') ? `${tail}${rows.length === 1 ? 'a' : 'e'}` : tail}`
    : count(rows.length, noun);
  const say = rows.length
    ? `Ecco ${described}${suffix}.${rows.length <= 3 && !venue ? ` ${rows.map((r) => r.title).join(', ')}.` : ''}`
    : `Nessun risultato per ${label.toLocaleLowerCase('it-IT')}.`;
  return { topic: what, filter, title: label, say, rows };
}

/* Saluto all'apertura: Jarvis dice in due frasi cosa è cambiato dall'ultima volta che Riccardo ha aperto
 * la Control Room (richieste nuove, menu pubblicati, chiamate) e cosa aspetta lui adesso (SÌ, pratiche
 * ferme). Solo dati già nella pagina, nessuna chiamata. Il testo compare sotto il reattore; la voce parte
 * al primo tocco, perché i telefoni non lasciano parlare una pagina prima di un tocco. */
const KEY = 'jarvis-last-visit';
const DAY = 86_400_000;
const names = (list) => list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} e ${list.at(-1)}`;
const count = (n, one, many, article = 'una') => `${n === 1 ? article : n} ${n === 1 ? one : many}`;

/** Quando l'ha guardata l'ultima volta (ms). Al primo avvio: null. */
export function lastVisit() {
  try {
    const raw = Number(globalThis.localStorage?.getItem(KEY));
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  } catch { return null; } // niente memoria: saluto senza «da quando sei uscito»
}
/** Segna adesso come ultima visita (all'avvio e quando la pagina va in secondo piano). */
export function markVisit(now = Date.now()) {
  try { globalThis.localStorage?.setItem(KEY, String(now)); } catch { /* ok */ }
}
/** Il saluto si fa una volta per sessione del browser. */
export function greetOnce() {
  try {
    if (globalThis.sessionStorage?.getItem('jarvis-greeted')) return false;
    globalThis.sessionStorage?.setItem('jarvis-greeted', '1');
  } catch { /* ok */ }
  return true;
}

function since(before, now) {
  if (!before) return '';
  const gap = now - before;
  if (gap < 2 * 3_600_000) return 'Da poco fa';
  const then = new Date(before), today = new Date(now);
  const sameDay = then.toDateString() === today.toDateString();
  const yesterday = new Date(now - DAY).toDateString() === then.toDateString();
  if (sameDay) return then.getHours() < 13 ? 'Da stamattina' : 'Da oggi pomeriggio';
  if (yesterday) return then.getHours() >= 18 ? 'Da ieri sera' : 'Da ieri';
  return gap < 7 * DAY ? `Negli ultimi ${Math.round(gap / DAY)} giorni` : 'Dall’ultima volta';
}

/**
 * Il saluto. data: { requests, clients, missions, audit, now, before, hour }.
 * Restituisce { show, say, news }: show va sotto il titolo (che saluta già), say è la frase detta a
 * voce, news solo la frase sulle novità dall'ultima visita (vuota al primo avvio).
 */
export function greetingFor({ requests = [], clients = [], missions = [], audit = [], now = Date.now(), before = null, hour = new Date(now).getHours() } = {}) {
  const hello = hour < 5 ? 'Buonanotte' : hour < 13 ? 'Buongiorno' : hour < 18 ? 'Buon pomeriggio' : 'Buonasera';
  const clientName = (id) => clients.find((c) => c.id === id)?.name || '';
  const requestName = (id) => { const r = requests.find((x) => x.id === id); return r ? clientName(r.clientId) || r.subject || '' : ''; };
  const after = (value) => { const t = Date.parse(value || ''); return before && Number.isFinite(t) && t > before && t <= now; };
  const parts = [];
  const opener = since(before, now);
  if (opener) {
    const fresh = requests.filter((r) => after(r.createdAt));
    const published = audit.filter((a) => a.action === 'github.pr.merged' && after(a.createdAt));
    const calls = audit.filter((a) => a.action === 'jarvis.phone_call' && after(a.createdAt));
    const news = [];
    if (fresh.length) {
      const who = [...new Set(fresh.map((r) => clientName(r.clientId)).filter(Boolean))].slice(0, 2);
      news.push(`${count(fresh.length, 'richiesta nuova', 'richieste nuove')}${who.length && fresh.length <= 2 ? ` (${names(who)})` : ''}`);
    }
    if (published.length) news.push(`${count(published.length, 'menu pubblicato', 'menu pubblicati', 'un')}`);
    if (calls.length) news.push(`${count(calls.length, 'chiamata', 'chiamate')} di avviso`);
    parts.push(news.length ? `${opener}: ${names(news)}.` : `${opener} è tutto tranquillo.`);
  }
  const waiting = missions.filter((m) => m.status === 'attesa_si');
  const stopped = missions.filter((m) => m.status === 'ferma');
  const label = (m) => requestName(m.requestId);
  if (waiting.length) {
    const who = waiting.map(label).filter(Boolean).slice(0, 2);
    parts.push(waiting.length === 1 && who.length ? `${who[0]} aspetta il tuo SÌ.` : `${waiting.length} ${waiting.length === 1 ? 'menu aspetta' : 'menu aspettano'} il tuo SÌ${who.length ? `, tra cui ${names(who)}` : ''}.`);
  }
  if (stopped.length) parts.push(`${count(stopped.length, 'pratica è ferma', 'pratiche sono ferme')} su una tua decisione.`);
  if (!waiting.length && !stopped.length && !opener) parts.push('Niente aspetta una tua decisione.');
  const show = parts.join(' ');
  return { show, say: `${hello}, Riccardo. ${show}`.trim(), news: opener ? parts[0] : '' };
}

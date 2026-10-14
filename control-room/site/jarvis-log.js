/* «Registro dal vivo»: le ultime azioni di Jarvis e di Riccardo come righe di un terminale sulla home.
 * Le righe arrivano dal registro già caricato (state.audit); la home si aggiorna da sola ogni tanto e le
 * righe nuove entrano scritte. Nessun costo oltre alla lettura della situazione. */
const QUIET = new Set(['github.menu.read', 'material.read.deferred']);
const WHO = { jarvis: 'JARVIS', owner: 'RICCARDO' };

function kind(action = '') {
  if (action === 'jarvis.phone_call') return 'call';
  if (action === 'github.pr.merged' || action === 'jarvis.publish_ok') return 'pub';
  if (/^(?:request|mail|whatsapp|client)\./.test(action) || action === 'jarvis.whatsapp_contact') return 'in';
  if (/error|fail|needs_reconciliation/.test(action)) return 'err';
  return 'info';
}
const hhmm = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '--:--' : new Intl.DateTimeFormat('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' }).format(date);
};

/** Le righe del registro, dalla più recente: { id, time, who, text, kind }. */
export function logLines(audit = [], { limit = 6 } = {}) {
  return [...audit]
    .filter((a) => a && !QUIET.has(a.action) && (a.summary || a.action))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, limit)
    .map((a) => ({ id: a.id, time: hhmm(a.createdAt), who: WHO[a.actor] || 'SISTEMA', text: String(a.summary || a.action).replace(/\s+/g, ' ').trim(), kind: kind(a.action) }));
}

// Righe già viste in questa pagina: solo quelle arrivate dopo entrano con l'effetto di scrittura.
const seen = new Set();
let primed = false;
/** Segna le righe nuove (fresh: true) rispetto all'ultimo giro; al primo giro nessuna è nuova. */
export function markFresh(lines) {
  const out = lines.map((line) => ({ ...line, fresh: primed && !seen.has(line.id) }));
  lines.forEach((line) => seen.add(line.id));
  primed = true;
  return out;
}

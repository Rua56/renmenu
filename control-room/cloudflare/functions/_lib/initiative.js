// Jarvis propositivo: guarda da solo nei dati di RenMenu cosa è fermo, in ritardo o in scadenza e lo
// propone a Riccardo con l'azione pronta (un tocco). Non fa nulla da solo: pubblicare, scrivere ai locali e
// i pagamenti restano decisioni di Riccardo. Ogni proposta ha «Più tardi» (domani) e «Lascia stare» (per due
// settimane), così Jarvis non insiste. Solo dati del database: nessun modello, nessun costo.
const DAY = 86_400_000;
const OPEN_REQUEST = "r.status NOT IN ('completata','archiviata','chiusa')";
const WAITING_REQUEST = ['nuova', 'materiale_ricevuto', 'in_analisi', 'dati_da_confermare'];
export const LATER_MS = DAY;
export const MUTE_MS = 14 * DAY;
export const REPEAT_MS = 2 * DAY;

const days = (from, to) => Math.floor((to - from) / DAY);
const ms = (value) => { const t = Date.parse(value || ''); return Number.isFinite(t) ? t : null; };
const ago = (n) => (n <= 0 ? 'oggi' : n === 1 ? 'da ieri' : `da ${n} giorni`);
const dateIt = (t) => new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', day: 'numeric', month: 'long' }).format(new Date(t));
const nameOf = (row) => { try { return JSON.parse(row.menu_json || '{}').nome || row.client_name || row.subject || 'una pratica'; } catch { return row.client_name || row.subject || 'una pratica'; } };

/**
 * Proposte dai dati. rows: { drafts, missions, waiting, clients } (vedi loadInitiatives). Ordinate dalla più
 * urgente. Ogni proposta: { key, kind, score, venue, text, buttons, requestId?, clientId? }.
 */
export function findInitiatives({ drafts = [], missions = [], waiting = [], clients = [], openClients = [] } = {}, now = Date.now()) {
  const out = [];
  const add = (item) => out.push(item);
  const followed = new Set(missions.map((m) => m.request_id));
  for (const m of missions) {
    const idle = days(ms(m.step_started_at || m.updated_at) ?? now, now);
    const venue = nameOf(m);
    if (m.status === 'attesa_si' && idle >= 1) add({ key: `si:${m.id}`, kind: 'si', score: 70 + idle, venue, requestId: m.request_id,
      text: `«${venue}» aspetta il tuo SÌ per la pubblicazione ${ago(idle)}. Lo pubblico?`, buttons: [['SÌ, pubblica', `pub:${m.id}`], ['Non ancora', `no:${m.id}`]] });
    if (m.status === 'ferma' && idle >= 1) add({ key: `ferma:${m.id}`, kind: 'ferma', score: 60 + idle, venue, requestId: m.request_id,
      text: `«${venue}» è ferma ${ago(idle)}${m.note ? ` (${String(m.note).slice(0, 160)})` : ''}. La riprendiamo?`, buttons: [['Mostrami la bozza', `peek:${m.draft_id}`], ['Affida a Jarvis', `affq:${m.draft_id}`]] });
  }
  for (const d of drafts) {
    if (followed.has(d.request_id)) continue;
    const idle = days(ms(d.updated_at) ?? now, now);
    if (idle < 2) continue;
    const venue = nameOf(d);
    add({ key: `bozza:${d.id}`, kind: 'bozza', score: 50 + Math.min(idle, 20), venue, requestId: d.request_id,
      text: `«${venue}»: la bozza è pronta in revisione ${ago(idle)} e il locale aspetta il suo menu. Le diamo un’occhiata? Se ti va bene me la affidi e al resto penso io.`, buttons: [['Mostrami la bozza', `peek:${d.id}`], ['Affida a Jarvis', `affq:${d.id}`]] });
  }
  for (const r of waiting) {
    const due = ms(r.follow_up_at);
    if (due !== null && due <= now) {
      add({ key: `segnato:${r.id}`, kind: 'segnato', score: 65, venue: r.client_name || r.subject, requestId: r.id,
        text: `Ti eri segnato di riprendere «${r.client_name || r.subject}» per il ${dateIt(due)}${r.next_step ? `: ${String(r.next_step).slice(0, 160)}` : ''}.`, buttons: [] });
      continue;
    }
    if (r.has_draft || !WAITING_REQUEST.includes(r.status)) continue;
    const idle = days(ms(r.updated_at) ?? now, now);
    if (idle < 2) continue;
    add({ key: `richiesta:${r.id}`, kind: 'richiesta', score: 40 + Math.min(idle, 20), venue: r.client_name || r.subject, requestId: r.id,
      text: `«${r.client_name || r.subject}» ha scritto ${idle} giorni fa e non c’è ancora una bozza${r.materials ? '' : ': mi manca il menu'}. Se hai foto o file del menu mandameli qui; se la richiesta non serve più dimmi «elimina la pratica di ${r.client_name || r.subject}».`, buttons: [] });
  }
  const busy = new Set(openClients);
  for (const c of clients) {
    const trial = ms(c.trial_ends_at), renewal = ms(c.renewal_at), created = ms(c.created_at);
    if (trial !== null && trial >= now - DAY && trial - now <= 5 * DAY) {
      const left = Math.max(0, Math.ceil((trial - now) / DAY));
      add({ key: `prova:${c.id}`, kind: 'prova', score: 75, venue: c.name, clientId: c.id,
        text: `La prova di «${c.name}» finisce ${left === 0 ? 'oggi' : left === 1 ? 'domani' : `tra ${left} giorni`} (${dateIt(trial)}). È il momento di sentirli per il piano: la chiamata o il messaggio sono tuoi.`, buttons: [] });
    }
    if (renewal !== null && renewal < now && now - renewal <= 30 * DAY) add({ key: `rinnovo:${c.id}`, kind: 'rinnovo', score: 80, venue: c.name, clientId: c.id,
      text: `Il rinnovo di «${c.name}» era il ${dateIt(renewal)}, ${days(renewal, now)} giorni fa. Se è pagato, aggiorna la data nella scheda del locale; se no, lo senti tu.`, buttons: [] });
    else if (renewal !== null && renewal >= now && renewal - now <= 14 * DAY) add({ key: `rinnovo:${c.id}`, kind: 'rinnovo', score: 55, venue: c.name, clientId: c.id,
      text: `Il rinnovo di «${c.name}» è il ${dateIt(renewal)}, tra ${Math.ceil((renewal - now) / DAY)} giorni${c.payment_status === 'scaduto' || c.payment_status === 'in_scadenza' ? ' e il pagamento risulta da sistemare' : ''}.`, buttons: [] });
    if (!c.menu_id && created !== null && days(created, now) >= 7 && !busy.has(c.id)) add({ key: `senzamenu:${c.id}`, kind: 'senzamenu', score: 30, venue: c.name, clientId: c.id,
      text: `«${c.name}» è registrato da ${days(created, now)} giorni ma non ha ancora un menu online, e non c’è nessuna pratica aperta. Hai il loro menu? Mandamelo qui e preparo la bozza.`, buttons: [] });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Legge dal database ciò che serve a findInitiatives. Una tabella che manca vale vuota. */
export async function loadInitiatives(db, now = Date.now()) {
  const all = async (sql) => { try { return (await db.prepare(sql).bind().all()).results || []; } catch { return []; } };
  const [drafts, missions, waiting, clients, open] = await Promise.all([
    all(`SELECT d.id,d.request_id,d.updated_at,d.menu_json,r.subject,c.name AS client_name FROM drafts d JOIN requests r ON r.id=d.request_id LEFT JOIN clients c ON c.id=r.client_id WHERE d.status IN ('bozza','revisione','pronta_pr') AND ${OPEN_REQUEST} LIMIT 50`),
    all("SELECT m.id,m.request_id,m.draft_id,m.status,m.note,m.step_started_at,m.updated_at,d.menu_json FROM jarvis_missions m JOIN drafts d ON d.id=m.draft_id WHERE m.status NOT IN ('completata','annullata') LIMIT 50"),
    all(`SELECT r.id,r.subject,r.status,r.updated_at,r.follow_up_at,r.next_step,c.name AS client_name,(SELECT COUNT(*) FROM drafts d WHERE d.request_id=r.id) AS has_draft,(SELECT COUNT(*) FROM materials m WHERE m.request_id=r.id) AS materials FROM requests r LEFT JOIN clients c ON c.id=r.client_id WHERE ${OPEN_REQUEST} AND COALESCE(r.is_ai_test_fixture,0)=0 LIMIT 100`),
    all('SELECT id,name,menu_id,payment_status,trial_ends_at,renewal_at,created_at FROM clients LIMIT 300'),
    all(`SELECT DISTINCT r.client_id FROM requests r WHERE ${OPEN_REQUEST}`)
  ]);
  return findInitiatives({ drafts, missions, waiting, clients, openClients: open.map((o) => o.client_id) }, now);
}

/** Toglie quelle messe in pausa («Più tardi») o lasciate stare. memory: { [key]: { later?, mute?, last? } }. */
export function activeInitiatives(list, memory = {}, now = Date.now()) {
  return list.filter((item) => {
    const seen = memory[item.key] || {};
    return !(ms(seen.mute) > now) && !(ms(seen.later) > now);
  });
}

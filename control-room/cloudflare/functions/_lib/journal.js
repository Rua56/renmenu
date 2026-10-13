// Diario di Jarvis: cosa è successo in un periodo, in numeri. È il primo passo del «Jarvis che
// propone»: prima di suggerire migliorie deve sapere dove si inciampa. Legge il registro
// (audit_events), le pratiche e le missioni che esistono già; la tabella jarvis_events conserva solo
// ciò che il registro non tiene (per esempio gli errori dell'orologio). Solo letture, tranne
// recordEvent. Nessun dato di contatto: nomi dei locali e conteggi.
const DAY = 86_400_000;
export const SILENT_DAYS = 45;
const MAX_DETAIL = 1000;

// Azioni del registro che il diario conta, raggruppate per significato.
export const AUDIT_GROUPS = {
  bozzeGenerate: ['draft.generate'],
  bozzeRifatte: ['draft.rebuild'],
  correzioniTelegram: ['draft.telegram_edit'],
  correzioniControlRoom: ['draft.save'],
  correzioniAnnullate: ['draft.telegram_undo'],
  modificheDelLocale: ['draft.reply_changes'],
  dubbi: ['material.check'],
  lettureFallite: ['material.read.failed'],
  affidate: ['jarvis.entrust'],
  si: ['jarvis.publish_ok'],
  pubblicateVerificate: ['github.publication.verified'],
  erroriPr: ['github.pr.error'],
  missioniFermate: ['jarvis.mission_paused']
};
const ACTIONS = [...new Set(Object.values(AUDIT_GROUPS).flat())];

/** Annota un evento nel diario. Non lancia mai: il diario non deve fermare il lavoro di Jarvis. */
export async function recordEvent(db, kind, { requestId = null, detail = {}, now = new Date() } = {}) {
  try {
    const json = JSON.stringify(detail ?? {}).slice(0, MAX_DETAIL);
    await db.prepare('INSERT INTO jarvis_events (id,kind,request_id,detail_json,created_at) VALUES (?,?,?,?,?)')
      .bind(`evt-${crypto.randomUUID()}`, String(kind).slice(0, 60), requestId, json, now.toISOString()).run();
    return true;
  } catch { return false; }
}

async function all(db, sql, ...params) {
  try { return (await db.prepare(sql).bind(...params).all()).results || []; } catch { return []; }
}
const days = (from, to) => (Date.parse(to) - Date.parse(from)) / DAY;
const round1 = (n) => Math.round(n * 10) / 10;

/** Riepilogo degli ultimi `period` giorni (default 7) fino a `now`. */
export async function buildDigest(db, { now = new Date(), period = 7 } = {}) {
  const to = now.toISOString(), from = new Date(now.getTime() - period * DAY).toISOString();
  const marks = ACTIONS.map(() => '?').join(',');
  const [audit, created, completed, events, stuck, clients, lastRequests] = await Promise.all([
    all(db, `SELECT a.action,a.summary,a.request_id,c.name AS client FROM audit_events a LEFT JOIN requests r ON r.id=a.request_id LEFT JOIN clients c ON c.id=r.client_id WHERE a.created_at>=? AND a.created_at<? AND a.action IN (${marks})`, from, to, ...ACTIONS),
    all(db, 'SELECT r.kind,r.source_channel,c.name AS client FROM requests r LEFT JOIN clients c ON c.id=r.client_id WHERE r.created_at>=? AND r.created_at<?', from, to),
    all(db, "SELECT created_at,updated_at FROM requests WHERE status='completata' AND updated_at>=? AND updated_at<?", from, to),
    all(db, 'SELECT kind,COUNT(*) AS n FROM jarvis_events WHERE created_at>=? AND created_at<? GROUP BY kind ORDER BY n DESC', from, to),
    all(db, "SELECT COUNT(*) AS n FROM jarvis_missions WHERE status='ferma'"),
    all(db, "SELECT id,name,created_at FROM clients WHERE menu_id IS NOT NULL AND menu_id<>''"),
    all(db, 'SELECT client_id,MAX(created_at) AS last FROM requests GROUP BY client_id')
  ]);

  const count = Object.fromEntries(Object.keys(AUDIT_GROUPS).map((key) => [key, 0]));
  const group = Object.fromEntries(Object.entries(AUDIT_GROUPS).flatMap(([key, list]) => list.map((action) => [action, key])));
  const perClient = new Map();
  let dubbiSaltati = 0, dubbiFuoriMenu = 0;
  for (const row of audit) {
    const key = group[row.action];
    count[key] += 1;
    if (key === 'dubbi') {
      if (/: saltato\.$/.test(row.summary)) dubbiSaltati += 1;
      else if (/non è nel menu/.test(row.summary)) dubbiFuoriMenu += 1;
    }
    if (row.client && ['correzioniTelegram', 'correzioniControlRoom', 'modificheDelLocale'].includes(key)) perClient.set(row.client, (perClient.get(row.client) || 0) + 1);
  }
  const requestsPerClient = new Map();
  for (const row of created) if (row.client) requestsPerClient.set(row.client, (requestsPerClient.get(row.client) || 0) + 1);
  const tally = (list) => Object.entries(list.reduce((acc, row) => ({ ...acc, [row]: (acc[row] || 0) + 1 }), {})).sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n }));
  const durations = completed.map((r) => days(r.created_at, r.updated_at)).filter((d) => d >= 0);

  const last = new Map(lastRequests.map((r) => [r.client_id, r.last]));
  const silent = clients.map((c) => ({ name: c.name, days: Math.floor(days(last.get(c.id) || c.created_at, to)) }))
    .filter((c) => c.days >= SILENT_DAYS).sort((a, b) => b.days - a.days);

  return {
    from, to, period,
    richieste: {
      nuove: created.length,
      perTipo: tally(created.map((r) => r.kind)),
      perCanale: tally(created.map((r) => r.source_channel)),
      completate: completed.length,
      giorniMedi: durations.length ? round1(durations.reduce((a, b) => a + b, 0) / durations.length) : null
    },
    bozze: { generate: count.bozzeGenerate, rifatte: count.bozzeRifatte },
    correzioni: {
      telegram: count.correzioniTelegram, controlRoom: count.correzioniControlRoom, annullate: count.correzioniAnnullate,
      dalLocale: count.modificheDelLocale,
      perLocale: [...perClient].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n).slice(0, 5)
    },
    letture: { dubbi: count.dubbi, dubbiSaltati, dubbiFuoriMenu, fallite: count.lettureFallite },
    missioni: { affidate: count.affidate, si: count.si, pubblicate: count.pubblicateVerificate, fermate: count.missioniFermate, fermeOra: Number(stuck[0]?.n || 0) },
    errori: { pr: count.erroriPr, diario: events.map((e) => ({ kind: e.kind, n: Number(e.n) })) },
    locali: {
      silenziosi: silent.slice(0, 5), silenziosiTotale: silent.length,
      piuAttivi: [...requestsPerClient].map(([name, n]) => ({ name, n })).filter((c) => c.n >= 2).sort((a, b) => b.n - a.n).slice(0, 5)
    }
  };
}

const itDate = (iso) => { const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${d}/${m}`; };
const list = (items, unit = '') => items.map((i) => `${i.name} ${i.n}${unit}`).join(', ');
const EVENT_LABEL = { 'errore.missione': 'errori dell’orologio sulle pratiche' };

/** Testo per Telegram (/settimana). Solo righe con qualcosa da dire. */
export function digestText(d) {
  const lines = [`Diario di Jarvis · dal ${itDate(d.from)} al ${itDate(d.to)}`, ''];
  const r = d.richieste;
  lines.push(`Richieste: ${r.nuove} nuove${r.perTipo.length ? ` (${list(r.perTipo)})` : ''}, ${r.completate} chiuse${r.giorniMedi !== null ? ` in ${String(r.giorniMedi).replace('.', ',')} giorni di media` : ''}.`);
  if (d.bozze.generate || d.bozze.rifatte) lines.push(`Bozze: ${d.bozze.generate} preparate, ${d.bozze.rifatte} rifatte.`);
  const c = d.correzioni, fixes = c.telegram + c.controlRoom;
  if (fixes || c.dalLocale) lines.push(`Correzioni: ${fixes} tue (${c.telegram} da Telegram, ${c.controlRoom} dalla Control Room${c.annullate ? `, ${c.annullate} annullate` : ''}), ${c.dalLocale} chieste dai locali.${c.perLocale.length ? ` Più corretti: ${list(c.perLocale)}.` : ''}`);
  const l = d.letture;
  if (l.dubbi || l.fallite) lines.push(`Lettura dei menu: ${l.dubbi} dubbi chiusi da te${l.dubbiSaltati ? ` (${l.dubbiSaltati} saltati)` : ''}${l.dubbiFuoriMenu ? `, ${l.dubbiFuoriMenu} righe che non erano piatti` : ''}; ${l.fallite} file non letti.`);
  const m = d.missioni;
  if (m.affidate || m.si || m.pubblicate || m.fermeOra) lines.push(`Pratiche affidate a me: ${m.affidate} affidate, ${m.si} SÌ, ${m.pubblicate} pubblicate e verificate${m.fermate ? `, ${m.fermate} fermate` : ''}${m.fermeOra ? `; ${m.fermeOra} ferme adesso` : ''}.`);
  const errors = [...(d.errori.pr ? [`${d.errori.pr} pull request non aperte`] : []), ...d.errori.diario.map((e) => `${e.n} ${EVENT_LABEL[e.kind] || e.kind}`)];
  lines.push(errors.length ? `Errori: ${errors.join(', ')}.` : 'Errori: nessuno.');
  if (d.locali.piuAttivi.length) lines.push(`Locali più attivi: ${list(d.locali.piuAttivi, ' richieste')}.`);
  if (d.locali.silenziosiTotale) lines.push(`Locali online senza richieste da più di ${SILENT_DAYS} giorni: ${d.locali.silenziosi.map((s) => `${s.name} (${s.days} giorni)`).join(', ')}${d.locali.silenziosiTotale > d.locali.silenziosi.length ? ` e altri ${d.locali.silenziosiTotale - d.locali.silenziosi.length}` : ''}.`);
  return lines.join('\n');
}

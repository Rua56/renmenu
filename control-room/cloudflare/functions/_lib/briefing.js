// Briefing di Jarvis: il punto della situazione per Riccardo, ogni mattina (lun–sab, 8:00 ora
// italiana) su Telegram e su richiesta con /briefing. Solo letture: D1, elenco dei menu su main
// (GitHub) e controllo dei menu pubblici. Nessun dato di contatto nel testo.
import { validateMenu } from './menu.js';

const DAY = 86_400_000;
const PUBLIC = 'https://renmenu.pages.dev';
const REPO_MENUS = 'https://api.github.com/repos/Rua56/renmenu/contents/menus?ref=main';
const MISSION_LABEL = { affidata: 'preparo l’anteprima', attesa_invio: 'invio dell’anteprima', attesa_cliente: 'attendo il locale', attesa_si: 'aspetta il tuo SÌ', pubblicazione: 'in pubblicazione', verifica: 'verifica online', ferma: 'ferma: serve te' };

const romeParts = (date) => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' })
  .formatToParts(date).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
export const romeDay = (date = new Date()) => { const p = romeParts(date); return `${p.year}-${p.month}-${p.day}`; };
// Finestra 8:00–8:14 lun–sab: l'orologio gira ogni minuto, l'invio è uno solo al giorno.
export function briefingDue(date = new Date()) {
  const p = romeParts(date);
  return p.weekday !== 'Sun' && Number(p.hour) === 8 && Number(p.minute) < 15;
}
const daysBetween = (from, to) => Math.floor((Date.parse(to) - Date.parse(from)) / DAY);
const itDate = (iso) => { const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${d}/${m}`; };
const nameOf = (json, fallback) => { try { return JSON.parse(json).nome || fallback; } catch { return fallback; } };

async function menuHealth(env, fetchImpl) {
  const token = String(env?.GITHUB_TOKEN || '').trim();
  if (!token) return { error: 'elenco dei menu non disponibile (GitHub non configurato)' };
  let list;
  try {
    const response = await fetchImpl(REPO_MENUS, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'RenMenu-Jarvis-Control-Room', 'X-GitHub-Api-Version': '2022-11-28' } });
    if (!response.ok) return { error: `elenco dei menu non disponibile (GitHub ${response.status})` };
    list = (await response.json()).filter((f) => f.type === 'file' && /^[a-z0-9-]+\.json$/.test(f.name)).map((f) => f.name.slice(0, -5));
  } catch { return { error: 'elenco dei menu non disponibile (rete)' }; }
  const results = await Promise.all(list.map(async (slug) => {
    try {
      const response = await fetchImpl(`${PUBLIC}/menus/${slug}.json`, { redirect: 'manual', headers: { 'Cache-Control': 'no-cache' } });
      if (response.status !== 200) return { slug, problem: `risponde ${response.status}` };
      const menu = await response.json().catch(() => null);
      if (!menu) return { slug, problem: 'file non leggibile' };
      const errors = validateMenu(menu).errors;
      return errors.length ? { slug, name: menu.nome, problem: errors[0] } : { slug, name: menu.nome };
    } catch { return { slug, problem: 'non raggiungibile' }; }
  }));
  return { results };
}

export async function buildBriefing(db, env = {}, { now = new Date(), fetchImpl = globalThis.fetch } = {}) {
  const today = now.toISOString();
  const all = async (sql, ...params) => { try { return (await db.prepare(sql).bind(...params).all()).results || []; } catch { return []; } };
  const [requests, missions, waiting, trials, renewals, health] = await Promise.all([
    all("SELECT status,COUNT(*) AS n FROM requests WHERE status NOT IN ('completata','archiviata','chiusa') GROUP BY status"),
    all("SELECT m.status,m.note,d.menu_json FROM jarvis_missions m JOIN drafts d ON d.id=m.draft_id WHERE m.status NOT IN ('completata','annullata') ORDER BY m.updated_at"),
    all("SELECT a.reference_code,a.sent_at,d.menu_json FROM publication_approvals a JOIN drafts d ON d.id=a.draft_id WHERE a.status='anteprima_inviata' AND a.sent_at IS NOT NULL ORDER BY a.sent_at"),
    all("SELECT a.activation_date,d.menu_json FROM publication_approvals a JOIN drafts d ON d.id=a.draft_id JOIN requests r ON r.id=a.request_id WHERE a.activation='prova_30_giorni' AND r.status='completata'"),
    all("SELECT name,renewal_at,trial_ends_at,plan FROM clients WHERE (renewal_at IS NOT NULL OR trial_ends_at IS NOT NULL)"),
    menuHealth(env, fetchImpl)
  ]);
  const lines = [`Buongiorno Riccardo. Briefing di Jarvis · ${itDate(romeDay(now))}`];

  const open = Object.fromEntries(requests.map((r) => [r.status, r.n]));
  const toYou = (open.nuova || 0) + (open.dati_da_confermare || 0) + (open.bozza_pronta || 0) + (open.in_revisione || 0);
  lines.push('', 'Richieste');
  lines.push(toYou ? `- ${toYou} da guardare (nuove ${open.nuova || 0}, dati da confermare ${open.dati_da_confermare || 0}, bozze in revisione ${(open.bozza_pronta || 0) + (open.in_revisione || 0)})` : '- Nessuna richiesta che aspetta te.');

  lines.push('', 'Pratiche affidate a me');
  if (!missions.length) lines.push('- Nessuna in corso.');
  for (const m of missions) lines.push(`- ${nameOf(m.menu_json, 'pratica')}: ${MISSION_LABEL[m.status] || m.status}`);

  const silent = waiting.map((w) => ({ name: nameOf(w.menu_json, w.reference_code), days: daysBetween(w.sent_at, today) })).filter((w) => w.days >= 2);
  lines.push('', 'Locali che non rispondono');
  lines.push(...(silent.length ? silent.map((w) => `- ${w.name}: anteprima senza risposta da ${w.days} giorni`) : ['- Nessuno.']));

  const expiring = [];
  for (const t of trials) {
    const end = new Date(Date.parse(`${t.activation_date}T00:00:00Z`) + 30 * DAY).toISOString();
    const left = daysBetween(today, end);
    if (left <= 7 && left >= -3) expiring.push(`- ${nameOf(t.menu_json, 'locale')}: prova gratuita ${left >= 0 ? `finisce il ${itDate(end)} (tra ${left} giorni)` : `finita il ${itDate(end)}`}`);
  }
  for (const c of renewals) {
    const when = c.renewal_at || c.trial_ends_at, left = daysBetween(today, when);
    if (left <= 14 && left >= -3) expiring.push(`- ${c.name}: ${c.renewal_at ? 'rinnovo' : 'fine prova'} il ${itDate(when)}`);
  }
  lines.push('', 'Prove e rinnovi in scadenza');
  lines.push(...(expiring.length ? expiring : ['- Nessuna scadenza nei prossimi giorni.']));

  lines.push('', 'Menu online');
  if (health.error) lines.push(`- Non ho potuto controllare: ${health.error}.`);
  else {
    const bad = health.results.filter((r) => r.problem);
    lines.push(bad.length ? `- ${health.results.length - bad.length} su ${health.results.length} in ordine. Da controllare:` : `- Tutti e ${health.results.length} in ordine.`);
    for (const b of bad) lines.push(`  · ${b.name || b.slug}: ${b.problem}`);
  }
  return lines.join('\n');
}

// Sorveglianza continua dei menu dei clienti veri: ogni 15 minuti Jarvis apre il menu online (il file e la
// pagina del QR). Se per due controlli di fila non si apre, avvisa Riccardo (avviso importante), una volta
// sola ogni 6 ore; quando torna a posto glielo dice. Non tocca mai niente.
// L'elenco parte dai clienti veri (Al Bakaro, Trattoria Blanch); ogni menu pubblicato da Jarvis si aggiunge da solo.

export const GUARD_KEY = 'guard_menus';
export const GUARD_STATE_KEY = 'guard_state';
export const GUARD_DEFAULT = Object.freeze(['bakaro', 'trattoria-blanch']);
export const GUARD_EVERY_MS = 15 * 60_000;
export const GUARD_RETRY_MS = 3 * 60_000;
export const GUARD_REMIND_MS = 6 * 3600_000;
export const GUARD_PER_TICK = 2;

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function parseList(value) {
  if (value == null || value === '') return [...GUARD_DEFAULT];
  try {
    const list = JSON.parse(value);
    return Array.isArray(list) ? [...new Set(list.filter((s) => typeof s === 'string' && SLUG.test(s)))] : [...GUARD_DEFAULT];
  } catch { return [...GUARD_DEFAULT]; }
}

export function parseState(value) {
  try { const state = JSON.parse(value || '{}'); return state && typeof state === 'object' && !Array.isArray(state) ? state : {}; } catch { return {}; }
}

/** I menu da controllare adesso: quelli mai controllati o scaduti, al massimo GUARD_PER_TICK, i più vecchi prima. */
export function dueSlugs(list, state, at = Date.now()) {
  return list.filter((slug) => !(Date.parse(state[slug]?.next || '') > at))
    .sort((a, b) => (Date.parse(state[a]?.next || '') || 0) - (Date.parse(state[b]?.next || '') || 0))
    .slice(0, GUARD_PER_TICK);
}

/** Cosa non va nel menu letto (stesso controllo della sorveglianza dopo la pubblicazione, senza il contenuto). */
export function problemsOf(seen, slug) {
  const problems = [];
  if (!seen?.menuJson?.ok) problems.push(`il file del menu ${seen?.menuJson?.why || 'non si legge'}`);
  else if (seen.id !== slug) problems.push('il file del menu non ha più l’identificativo giusto');
  if (!seen?.page?.ok) problems.push(`la pagina del menu (quella del QR) ${seen?.page?.why || 'non si apre'}`);
  return problems;
}

/**
 * Nuovo stato di un menu dopo un controllo, e l'eventuale messaggio per Riccardo.
 * { entry, alert: 'giu' | 'ancora' | 'su' | null }
 */
export function step(previous, problems, at = Date.now()) {
  const was = previous || {};
  const iso = (ms) => new Date(ms).toISOString();
  if (!problems.length) return { entry: { fails: 0, ok_at: iso(at), next: iso(at + GUARD_EVERY_MS) }, alert: was.alerted ? 'su' : null };
  const fails = (was.fails || 0) + 1;
  if (fails < 2) return { entry: { ...was, fails, why: problems.join('; '), next: iso(at + GUARD_RETRY_MS) }, alert: null };
  const alerted = Date.parse(was.alerted || '');
  const remind = Number.isFinite(alerted) && at - alerted >= GUARD_REMIND_MS;
  const alert = !Number.isFinite(alerted) ? 'giu' : remind ? 'ancora' : null;
  return { entry: { ...was, fails, why: problems.join('; '), alerted: alert ? iso(at) : was.alerted, down_since: was.down_since || iso(at), next: iso(at + GUARD_EVERY_MS) }, alert };
}

export function alertText(kind, name, why, url) {
  if (kind === 'su') return `«${name}» è di nuovo online: il menu si apre regolarmente.\n${url}`;
  const head = kind === 'ancora' ? `Il menu di «${name}» è ancora irraggiungibile` : `Attenzione, Riccardo: il menu di «${name}» non si apre`;
  return `${head}: ${why}.\n${url}\nL’ho controllato due volte di fila. Non tocco niente: se l’hai tolto tu apposta, scrivimi «non sorvegliare ${name}».`;
}

/** «sorveglianza», «quali menu sorvegli?», «sorveglia Al Bakaro», «non sorvegliare Al Tralcio». null = altro. */
export function parseGuard(text) {
  const line = String(text || '').trim();
  if (!line || line.length > 120 || /\n/.test(line)) return null;
  const head = /^\s*(?:jarvis[\s,!.]*)?/i.source;
  if (new RegExp(`${head}(?:\\/sorveglianza|sorveglianza(?:\\s+dei\\s+menu)?|quali\\s+menu\\s+(?:sorvegli|controlli|tieni\\s+d['’]occhio))\\s*[?.!]*\\s*$`, 'i').test(line)) return { kind: 'show' };
  const off = line.match(new RegExp(`${head}(?:non\\s+sorvegliare(?:\\s+più)?|smetti\\s+di\\s+sorvegliare|togli\\s+dalla\\s+sorveglianza)\\s+(?:il\\s+menu\\s+(?:di\\s+)?)?(.+?)\\s*[.!]*$`, 'i'));
  if (off) return { kind: 'off', venue: off[1].replace(/^[«"“']|[»"”']$/g, '').trim() };
  const on = line.match(new RegExp(`${head}(?:sorveglia|tieni\\s+d['’]occhio)\\s+(?:anche\\s+)?(?:il\\s+menu\\s+(?:di\\s+)?)?(.+?)\\s*[.!]*$`, 'i'));
  if (on) return { kind: 'on', venue: on[1].replace(/^[«"“']|[»"”']$/g, '').trim() };
  return null;
}

export function listText(entries) {
  if (!entries.length) return 'Non sto sorvegliando nessun menu. Scrivimi «sorveglia <locale>» per aggiungerne uno.';
  const lines = entries.map(({ name, state }) => {
    if (state?.fails >= 2) return `• ${name}: NON si apre (${state.why || 'errore'})`;
    if (state?.ok_at) return `• ${name}: online, ultimo controllo alle ${new Date(state.ok_at).toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' })}`;
    return `• ${name}: non ancora controllato`;
  });
  return `Menu che controllo ogni 15 minuti:\n${lines.join('\n')}\n\nSe uno non si apre per due controlli di fila ti avviso subito. «non sorvegliare <locale>» per toglierlo.`;
}

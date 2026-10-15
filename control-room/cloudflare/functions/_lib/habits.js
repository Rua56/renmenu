// Jarvis impara da Riccardo (Baffone, 2026-10-15): conta le scelte che si ripetono sempre uguali e, dopo
// qualche «sì» di fila, chiede una volta «d'ora in poi lo faccio da solo?». Ogni sì diventa una regola che
// Riccardo vede («le mie regole») e può togliere quando vuole. Solo azioni che lui già approva a mano:
// pubblicare, pagare, eliminare e il QR non diventano mai automatici. Nessun modello, nessun costo.
// Lo stato vive in jarvis_settings.habits: { [tipo]: { yes, no, streak, nextAsk, rule, askedAt, since } }.
export const HABITS_KEY = 'habits';
export const ASK_AFTER = 3;
export const ASK_AGAIN_AFTER = 6;

export const HABITS = {
  anteprima: {
    title: 'Anteprime ai locali',
    rule: 'quando una bozza è pronta e i controlli passano, la affido e mando l’anteprima al locale senza chiedertelo',
    ask: (n) => `Le ultime ${n} volte che ti ho chiesto se mandare l’anteprima al locale mi hai detto di sì. D’ora in poi la mando io da solo, quando la bozza è pronta e i controlli passano? Ti avviso ogni volta, e la pubblicazione resta sempre un tuo SÌ.`
  },
  promemoria: {
    title: 'Promemoria ai locali',
    rule: 'quando un locale non risponde all’anteprima, gli mando io il promemoria (al massimo due)',
    ask: (n) => `Le ultime ${n} volte che ti ho proposto un promemoria per un locale che non rispondeva me l’hai fatto mandare. D’ora in poi li mando io da solo? Ti avviso ogni volta.`
  },
  risposta: {
    title: 'Risposte ai locali',
    rule: 'quando un locale scrive, gli mando io la risposta che ho preparato dai dati della pratica',
    ask: (n) => `Le ultime ${n} risposte che ti ho preparato per i locali le hai mandate così com’erano. D’ora in poi rispondo io da solo? Ti avviso ogni volta con il testo che ho mandato.`
  }
};

/** Quale abitudine tocca questo pulsante e in che verso. null se il pulsante non insegna nulla. */
export function habitOf(data) {
  const [verb, a] = String(data || '').split(':');
  if (verb === 'aff') return { kind: 'anteprima', yes: true };
  if (verb === 'affno') return { kind: 'anteprima', yes: false };
  if (verb === 'soll') return { kind: 'promemoria', yes: true };
  if (verb === 'sollno') return { kind: 'promemoria', yes: false };
  if (verb === 'rep' && a === 'send') return { kind: 'risposta', yes: true };
  if (verb === 'rep' && (a === 'skip' || a === 'edit')) return { kind: 'risposta', yes: false };
  return null;
}

export function parseHabits(raw) {
  try { const value = JSON.parse(raw || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
}

/** Registra una scelta. Ritorna { state, ask }: ask è vero quando è il momento di proporre la regola. */
export function recordChoice(state, { kind, yes }, at = new Date().toISOString()) {
  if (!HABITS[kind]) return { state, ask: false };
  const entry = { yes: 0, no: 0, streak: 0, nextAsk: ASK_AFTER, rule: null, ...(state[kind] || {}) };
  if (yes) { entry.yes += 1; entry.streak += 1; } else { entry.no += 1; entry.streak = 0; }
  const ask = yes && entry.rule !== 'auto' && entry.streak >= entry.nextAsk;
  if (ask) entry.askedAt = at;
  return { state: { ...state, [kind]: entry }, ask };
}

/** Risposta di Riccardo alla domanda o all'elenco delle regole: on (fallo da solo), never (chiedimelo), off (togli la regola). */
export function setRule(state, kind, choice, at = new Date().toISOString()) {
  if (!HABITS[kind]) return state;
  const entry = { yes: 0, no: 0, streak: 0, nextAsk: ASK_AFTER, rule: null, ...(state[kind] || {}) };
  if (choice === 'on') Object.assign(entry, { rule: 'auto', since: at });
  else { Object.assign(entry, { rule: null, since: null, nextAsk: entry.streak + ASK_AGAIN_AFTER }); }
  return { ...state, [kind]: entry };
}

export const isAuto = (state, kind) => state?.[kind]?.rule === 'auto';

const dateIt = (iso) => { try { return new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', day: 'numeric', month: 'long' }).format(new Date(iso)); } catch { return ''; } };
/** Elenco per «le mie regole»: testo e pulsanti per togliere le regole attive. */
export function rulesView(state) {
  const active = Object.keys(HABITS).filter((kind) => isAuto(state, kind));
  const learning = Object.keys(HABITS).filter((kind) => !isAuto(state, kind) && (state[kind]?.yes || state[kind]?.no));
  const lines = [];
  if (active.length) lines.push('Cosa faccio da solo, perché me l’hai detto tu:', ...active.map((kind) => `• ${HABITS[kind].title}: ${HABITS[kind].rule}${state[kind].since ? ` (dal ${dateIt(state[kind].since)})` : ''}.`));
  else lines.push('Per ora non faccio niente da solo: ti chiedo sempre prima.');
  if (learning.length) lines.push('', 'Sto imparando:', ...learning.map((kind) => `• ${HABITS[kind].title}: ${state[kind].yes} sì e ${state[kind].no} no${state[kind].streak ? `, ${state[kind].streak} sì di fila` : ''}.`));
  lines.push('', `Quando dici sì ${ASK_AFTER} volte di fila alla stessa cosa ti chiedo se posso farla da solo. Pubblicare, pagamenti, QR ed eliminazioni restano sempre tuoi.`);
  return { text: lines.join('\n'), buttons: active.map((kind) => [`Togli: ${HABITS[kind].title}`, `hab:off:${kind}`]) };
}

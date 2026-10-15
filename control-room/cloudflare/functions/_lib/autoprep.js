// Preparazione automatica (Baffone, 2026-10-14): appena Jarvis ha fatto da solo la bozza di una
// pratica con il piano chiaro, completa tutto quello che sa fare (lingue chieste dal locale e, per il
// Premium, schede, foto delle bottiglie e foto del cliente al loro posto), poi chiede a Riccardo una
// cosa sola: «Anteprima pronta: la mando al locale?». Invio dell'anteprima e pubblicazione restano suoi.
// Lo stato vive in jarvis_settings.auto_prep: { [draftId]: { requestId, plan, steps, done, log, at, tries, rounds } }.
export const PREP_KEY = 'auto_prep';
export const PREP_STEPS = { lingue: 'Lingue', schede: 'Schede dei vini e descrizioni', bottiglie: 'Foto delle bottiglie', foto: 'Foto nel menu', pronta: 'Anteprima' };
export const MAX_TRIES = 3;
export const MAX_ROUNDS = 8;

export function parsePrep(raw) {
  try { const value = JSON.parse(raw || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
}
/** Passi per piano: tutti controllano le lingue; il Premium aggiunge schede, bottiglie e foto. */
export function prepSteps(plan) {
  return plan === 'premium' ? ['lingue', 'schede', 'bottiglie', 'foto', 'pronta'] : ['lingue', 'pronta'];
}
/** Mette in coda la preparazione di una bozza fatta da Jarvis (idempotente). */
// steps/maxRounds/notifyOnly: preparazioni su richiesta di Riccardo (per esempio «cerca le foto delle bottiglie di Blanch»):
// solo quei passi, più giri se i vini sono tanti, e alla fine un avviso con il link invece della domanda sull'anteprima.
export async function enrollPrep({ get, put }, db, { draftId, requestId, plan, steps = null, maxRounds = null, notifyOnly = false }, at = new Date().toISOString()) {
  if (!draftId) return false;
  const state = parsePrep(await get(db, PREP_KEY));
  if (state[draftId]) return false;
  state[draftId] = { requestId, plan: plan || null, steps: steps || prepSteps(plan), done: [], log: [], at, tries: 0, rounds: 0,
    ...(maxRounds ? { maxRounds } : {}), ...(notifyOnly ? { notifyOnly: true } : {}) };
  await put(db, PREP_KEY, JSON.stringify(state));
  return true;
}
export const nextStep = (entry) => (entry.steps || []).find((step) => !(entry.done || []).includes(step)) || null;

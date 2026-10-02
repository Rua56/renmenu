// Regole di servizio RenMenu applicate dal codice della Control Room.
// Fonte: control-room/docs/renmenu-service-rules.md (approvato da Riccardo).
// Questo modulo NON contiene prezzi di vendita, Payment Link o dati di pagamento:
// descrive soltanto cosa Jarvis puo preparare per ciascun piano.
// Il file site/service-rules.js deve restare identico (verificato dai test).

export const PLAN_RULES = Object.freeze({
  standard: Object.freeze({
    label: 'Standard mensile',
    maxLanguages: 2,
    allowedLanguages: Object.freeze(['it', 'en']),
    creativeApproval: false,
    summary: 'Grafica RenMenu, QR stabile, italiano e inglese, allergeni solo se confermati.'
  }),
  annuale: Object.freeze({
    label: 'Annuale',
    maxLanguages: 3,
    allowedLanguages: null,
    creativeApproval: false,
    summary: 'Tutto lo Standard, una lingua aggiuntiva, QR con logo, priorità negli aggiornamenti.'
  }),
  premium: Object.freeze({
    label: 'Premium su misura',
    maxLanguages: 4,
    allowedLanguages: null,
    creativeApproval: true,
    summary: 'Proposta dedicata, identità del locale, fino a quattro lingue, approvazione creativa obbligatoria.'
  })
});

// Le 11 categorie approvate. `kind` e il tipo tecnico gia esistente nel database;
// `plan` e presente solo per le categorie di nuovo menu.
export const REQUEST_CATEGORIES = Object.freeze([
  Object.freeze({ code: 'nuovo_standard', label: 'Nuovo menu Standard', kind: 'nuovo', plan: 'standard' }),
  Object.freeze({ code: 'nuovo_annuale', label: 'Nuovo menu Annuale', kind: 'nuovo', plan: 'annuale' }),
  Object.freeze({ code: 'nuovo_premium', label: 'Nuovo menu Premium su misura', kind: 'nuovo', plan: 'premium' }),
  Object.freeze({ code: 'prezzo', label: 'Aggiornamento prezzo', kind: 'prezzo', plan: null }),
  Object.freeze({ code: 'piatto', label: 'Aggiunta o rimozione piatto', kind: 'aggiornamento', plan: null }),
  Object.freeze({ code: 'disponibilita', label: 'Modifica disponibilità o piatto del giorno', kind: 'aggiornamento', plan: null }),
  Object.freeze({ code: 'vini_cocktail', label: 'Modifica carta vini/cocktail', kind: 'aggiornamento', plan: null }),
  Object.freeze({ code: 'lingua', label: 'Aggiunta o revisione lingua', kind: 'traduzione', plan: null }),
  Object.freeze({ code: 'qr_cartello', label: 'Richiesta QR/cartello', kind: 'qr', plan: null }),
  Object.freeze({ code: 'commerciale', label: 'Richiesta commerciale o preventivo', kind: 'commerciale', plan: null }),
  Object.freeze({ code: 'da_verificare', label: 'Richiesta poco chiara da verificare', kind: 'altro', plan: null })
]);

export const CATEGORY_CODES = Object.freeze(REQUEST_CATEGORIES.map((entry) => entry.code));
export const categoryByCode = (code) => REQUEST_CATEGORIES.find((entry) => entry.code === code) || null;

const fail = (message) => Object.assign(new Error(message), { status: 422 });

/**
 * Risolve categoria, tipo tecnico e piano di una pratica.
 * - Senza categoria: comportamento precedente (kind e plan invariati).
 * - Con categoria di nuovo menu: il piano deriva dalla categoria; un piano diverso e un errore.
 * - Con categoria di modifica: il kind deriva dalla categoria, il piano resta quello indicato.
 */
export function resolveCategory({ category, kind, plan }) {
  if (category == null || category === '') return { category: null, kind, plan };
  const entry = categoryByCode(category);
  if (!entry) throw fail('Categoria richiesta non valida.');
  if (entry.plan) {
    if (plan && plan !== 'da_definire' && plan !== entry.plan)
      throw fail(`Categoria "${entry.label}" non coerente con il piano indicato.`);
    return { category: entry.code, kind: entry.kind, plan: entry.plan };
  }
  return { category: entry.code, kind: entry.kind, plan: plan || 'da_definire' };
}

/** Motivo per cui Jarvis non può generare la bozza, oppure null. */
export function draftBlocker(plan) {
  if (!PLAN_RULES[plan]) return 'Piano da confermare con Riccardo: scegli Standard, Annuale o Premium prima di generare la bozza.';
  return null;
}

const evidence = (value) => typeof value === 'string' && value.trim().length >= 12 && value.length <= 500;

/** Controlli legati al piano: lingue consentite e approvazione creativa Premium. */
export function planIssues(menu, plan, checks) {
  const rule = PLAN_RULES[plan];
  if (!rule) return ['Piano non confermato: la pratica deve essere Standard, Annuale o Premium.'];
  const issues = [];
  const languages = Array.isArray(menu?.lingue) && menu.lingue.length ? menu.lingue : ['it'];
  if (new Set(languages).size !== languages.length) issues.push('Lingue duplicate nel menu.');
  if (languages.length > rule.maxLanguages)
    issues.push(`${rule.label}: massimo ${rule.maxLanguages} lingue, il menu ne dichiara ${languages.length}.`);
  if (rule.allowedLanguages) {
    const extra = languages.filter((lang) => !rule.allowedLanguages.includes(lang));
    if (extra.length) issues.push(`${rule.label}: lingue non incluse nel piano (${extra.join(', ')}). Servono Annuale o Premium.`);
  }
  if (rule.creativeApproval) {
    if (checks?.creativeApproval !== true) issues.push('Premium: manca l’approvazione creativa di Riccardo.');
    else if (!evidence(checks?.creativeApprovalEvidence))
      issues.push('Premium: inserisci il riferimento all’approvazione creativa (12–500 caratteri).');
  }
  return issues;
}

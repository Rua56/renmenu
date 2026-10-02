import { planIssues } from './service-rules.js';

// A mock PR must never be prepared from checkbox assertions alone.
// These checks are intentionally stricter than the public JSON schema: a structurally valid
// menu may still need source evidence and written permission to omit allergen labels.
const description = (value) => typeof value === 'string' && value.trim().length >= 12 && value.length <= 500;
const localized = (value, lang, primary) => typeof value === 'string' ? (lang === primary && Boolean(value.trim()))
  : Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && typeof value[lang] === 'string' && value[lang].trim());

export function criticalFields(menu) {
  const pricesMissing = [], allergensMissing = [], translationsMissing = [];
  const languages = Array.isArray(menu?.lingue) ? menu.lingue : [];
  for (const [sectionIndex, section] of (menu?.sezioni || []).entries()) {
    const names = [section?.nome, ...(section?.voci || []).map((item) => item?.nome)];
    for (const [nameIndex, name] of names.entries()) {
      for (const lang of languages) {
        if (!localized(name, lang, languages[0])) translationsMissing.push(`sezioni.${sectionIndex}.${nameIndex === 0 ? 'nome' : `voci.${nameIndex - 1}.nome`}.${lang}`);
      }
    }
    for (const [itemIndex, item] of (section?.voci || []).entries()) {
      const path = `sezioni.${sectionIndex}.voci.${itemIndex}`;
      if (!item?.prezzo && item?.prezzo !== 0) pricesMissing.push(`${path}.prezzo`);
      if (!Array.isArray(item?.allergeni) || item.allergeni.length === 0) allergensMissing.push(`${path}.allergeni`);
    }
  }
  for (const lang of languages) if (!localized(menu?.nome, lang, languages[0])) translationsMissing.push(`nome.${lang}`);
  return { pricesMissing, allergensMissing, translationsMissing };
}

export const EVIDENCE_LABELS = Object.freeze({ prices: 'Evidenza prezzi', allergens: 'Evidenza allergeni', languages: 'Evidenza lingue' });

// `plan` is optional for backward compatibility; every production caller passes it.
export function reviewIssues(menu, checks, plan) {
  const issues = [];
  const missing = criticalFields(menu);
  const required = ['prices', 'allergens', 'languages', 'clientApproval'];
  if (!checks || required.some((key) => checks[key] !== true)) issues.push('La checklist contiene conferme ancora mancanti.');
  if (missing.pricesMissing.length) issues.push(`${missing.pricesMissing.length} prezzi non attestati: correggili prima della PR.`);
  if (missing.translationsMissing.length) issues.push(`${missing.translationsMissing.length} nomi senza traduzione dichiarata: completa o rimuovi la lingua.`);
  if (missing.allergensMissing.length && checks?.allergenOmissionConfirmed !== true)
    issues.push('ALLERGENI NON CONFERMATI DAL LOCALE: serve una conferma esplicita sull’omissione oppure la fonte per ogni voce.');
  for (const key of ['prices', 'allergens', 'languages']) {
    if (checks?.[key] && !description(checks?.fieldEvidence?.[key]))
      issues.push(`${EVIDENCE_LABELS[key]}: inserisci il riferimento scritto e controllabile alla fonte (12–500 caratteri).`);
  }
  if (checks?.clientApproval && !description(checks?.clientApprovalEvidence))
    issues.push('Riferimento all’approvazione scritta del locale mancante (12–500 caratteri).');
  if (plan !== undefined) issues.push(...planIssues(menu, plan, checks));
  return { issues, missing };
}

// Proposte di Jarvis per le evidenze della checklist (2026-10-02). Usano SOLO fatti registrati:
// provenienza della bozza, metadati della pratica, lingue del menu. Non attestano mai
// l'autorizzazione del locale né l'approvazione scritta del cliente: quelle restano a Riccardo.
const itemAt = (menu, path) => {
  const match = /^sezioni\.(\d+)\.voci\.(\d+)\.prezzo$/.exec(path);
  return match ? menu?.sezioni?.[Number(match[1])]?.voci?.[Number(match[2])] : null;
};
const textOf = (value) => (typeof value === 'string' ? value : value?.it || '');
const dateIt = (value) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10).split('-').reverse().join('/') : '';
};
export function suggestedEvidence(draft, request) {
  const menu = draft?.menu || {};
  const items = (menu.sezioni || []).flatMap((section) => section.voci || []);
  const priced = items.filter((item) => String(item.prezzo ?? '').trim());
  const prices = (draft?.provenance || []).filter((entry) => entry.status === 'confermato' && /\.prezzo$/.test(entry.path));
  const matches = prices.every((entry) => { const item = itemAt(menu, entry.path); return item && String(item.prezzo) === String(entry.value); });
  const subject = String(request?.subject || '').slice(0, 80);
  const origin = request?.sourceChannel === 'email'
    ? `Email${subject ? ` «${subject}»` : ''}${dateIt(request?.createdAt) ? ` del ${dateIt(request.createdAt)}` : ''}`
    : `Testo della pratica${subject ? ` «${subject}»` : ''}`;
  const result = { prices: '', allergens: '', languages: '', notes: {} };
  if (prices.length && prices.length === priced.length && matches) {
    const rows = prices.map((entry) => `${entry.source} ${textOf(itemAt(menu, entry.path).nome)} ${entry.value}`);
    result.prices = `${origin}: ${rows.join('; ')}.`.slice(0, 500);
  } else if (priced.length) {
    result.notes.prices = 'Provenienza assente o non allineata alla bozza (modificata a mano?): verifica i prezzi sulla versione attuale.';
  }
  if (draft?.provenance?.length && items.length && items.every((item) => !Array.isArray(item.allergeni) || !item.allergeni.length))
    result.allergens = `${origin}: il testo ricevuto non indica allergeni.`.slice(0, 500);
  const languages = Array.isArray(menu.lingue) && menu.lingue.length ? menu.lingue : ['it'];
  const autoEnglish = (draft?.provenance || []).filter((entry) => String(entry.path).endsWith('.en')).length;
  result.languages = (languages.includes('en')
    ? (autoEnglish ? `Testo ricevuto in italiano; inglese preparato in automatico da Jarvis come bozza (${autoEnglish} testi), rivisto prima della conferma.`
      : 'Testo ricevuto in italiano; inglese presente nella bozza: traduzione da far approvare al locale.')
    : 'Testo ricevuto in italiano. Inglese non fornito: traduzione da preparare come bozza.');
  return result;
}

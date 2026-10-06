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
      // Prezzo variabile dichiarato dal locale («secondo il pescato», «a peso»): niente importo, ma è attestato.
      const variable = /^Prezzo (?:variabile|secondo|a peso)/.test(typeof item?.descrizione === 'string' ? item.descrizione : item?.descrizione?.it || '');
      // Più prezzi con etichetta (calice / bottiglia): attestati se ogni variante ha il suo importo.
      const variants = Array.isArray(item?.prezzi) && item.prezzi.length && item.prezzi.every((v) => v?.prezzo);
      // Portata di un percorso degustazione: il prezzo è quello del percorso (a persona), non del piatto.
      const course = section?.tipo === 'degustazione' && !item?.prezzo;
      if (course) { if (!section?.prezzo && !pricesMissing.includes(`sezioni.${sectionIndex}.prezzo`)) pricesMissing.push(`sezioni.${sectionIndex}.prezzo`); }
      else if (!item?.prezzo && item?.prezzo !== 0 && !variable && !variants) pricesMissing.push(`${path}.prezzo`);
      if (!Array.isArray(item?.allergeni) || item.allergeni.length === 0) allergensMissing.push(`${path}.allergeni`);
    }
  }
  // Il nome del locale è un nome proprio e non si traduce (come nei menu pubblicati, es. "Al Bakaro"):
  // una stringa semplice vale per tutte le lingue; se è un oggetto per lingua, servono tutte.
  const venueNamed = typeof menu?.nome === 'string' && Boolean(menu.nome.trim());
  for (const lang of languages) if (!venueNamed && !localized(menu?.nome, lang, languages[0])) translationsMissing.push(`nome.${lang}`);
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
  const withAllergens = (menu.sezioni || []).flatMap((section, si) => (section.voci || []).map((item, vi) => ({ item, path: `sezioni.${si}.voci.${vi}.allergeni` })))
    .filter(({ item }) => Array.isArray(item.allergeni) && item.allergeni.length);
  const allergenSources = (draft?.provenance || []).filter((entry) => entry.status === 'confermato' && /\.allergeni$/.test(entry.path));
  const pending = (draft?.sourceExtras || []).filter((entry) => entry.type === 'allergeni');
  const mentions = /\ballergen|\bcont(?:ien|eng)\w*\b[^.\n]*\b(?:glutine|uov|latte|lattosio|pesce|crostace|soia|arachid|frutta a guscio|noci|sedano|senape|sesamo|solfiti|lupini|molluschi)/i.test(String(request?.sourceText || ''));
  if (pending.length) {
    result.notes.allergens = 'Il locale ha scritto degli allergeni: inseriscili dal riquadro «Dati scritti dal locale» prima di confermare.';
  } else if (withAllergens.length && withAllergens.every(({ item, path }) => allergenSources.some((entry) => entry.path === path && entry.value === item.allergeni.join(',')))) {
    const rows = withAllergens.map(({ item, path }) => `${allergenSources.find((entry) => entry.path === path).source} ${textOf(item.nome)} ${item.allergeni.join(', ')}`);
    const others = items.length - withAllergens.length;
    result.allergens = `${origin}: allergeni dichiarati dal locale (codici UE): ${rows.join('; ')}.${others ? ` Per gli altri ${others} piatti il locale non ha indicato allergeni.` : ''}`.slice(0, 500);
  } else if (withAllergens.length) {
    result.notes.allergens = 'Alcuni allergeni non hanno una fonte registrata: verificali sul testo del locale.';
  } else if (mentions) {
    result.notes.allergens = 'Il testo del locale parla di allergeni: controllalo, Jarvis non ha trovato a quale piatto si riferiscono.';
  } else if (draft?.provenance?.length && items.length)
    result.allergens = `${origin}: il testo ricevuto non indica allergeni.`.slice(0, 500);
  const languages = Array.isArray(menu.lingue) && menu.lingue.length ? menu.lingue : ['it'];
  const autoEnglish = (draft?.provenance || []).filter((entry) => String(entry.path).endsWith('.en')).length;
  result.languages = (languages.includes('en')
    ? (autoEnglish ? `Testo ricevuto in italiano; inglese preparato in automatico da Jarvis come bozza (${autoEnglish} testi), rivisto prima della conferma.`
      : 'Testo ricevuto in italiano; inglese presente nella bozza: traduzione da far approvare al locale.')
    : 'Testo ricevuto in italiano. Inglese non fornito: traduzione da preparare come bozza.');
  return result;
}

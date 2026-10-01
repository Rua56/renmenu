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

export function reviewIssues(menu, checks) {
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
      issues.push(`${key}: inserisci il riferimento scritto e controllabile alla fonte (12–500 caratteri).`);
  }
  if (checks?.clientApproval && !description(checks?.clientApprovalEvidence))
    issues.push('Riferimento all’approvazione scritta del locale mancante (12–500 caratteri).');
  return { issues, missing };
}

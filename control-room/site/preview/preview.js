import { loadState, isAuthorizedHost, isDemoMode } from '../api.js';

const byId = (id) => document.getElementById(id);
const localized = (value, lang = 'it') => typeof value === 'string' ? value :
  (value && typeof value === 'object' ? String(value[lang] || value.it || Object.values(value)[0] || '') : '');
const element = (tag, text, className = '') => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  return node;
};

async function main() {
  const status = byId('preview-status');
  try {
    if (!isAuthorizedHost || isDemoMode) throw new Error('Anteprima disponibile solo nell’area privata di staging.');
    const slug = new URL(location.href).searchParams.get('m') || '';
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 64 ||
      new URL(location.href).searchParams.get('draft') !== '1') throw new Error('Link di anteprima non valido.');
    const data = await loadState();
    const draft = data.drafts?.find((item) => item.slug === slug);
    if (!draft) throw new Error('Bozza assente o non autorizzata. Nessun menù pubblico è stato caricato.');
    const request = data.requests?.find((item) => item.id === draft.requestId);
    if (!request || !draft.menu?.sezioni?.length) throw new Error('Bozza incompleta o priva della pratica di origine.');
    const root = byId('preview-menu');
    root.replaceChildren();
    const primary = draft.menu.lingue?.[0] || 'it';
    byId('preview-title').textContent = localized(draft.menu.nome, primary) || 'Bozza senza titolo';
    root.append(element('p', `Pratica ${request.subject} · revisione ${draft.revision} · ${draft.menu.sezioni.filter((s) => !s.senzaTitolo).length} sezioni${draft.menu.sezioni.some((s) => s.senzaTitolo) ? ' (più un elenco senza titolo)' : ''}`, 'preview-meta'));
    for (const section of draft.menu.sezioni) {
      const block = document.createElement('section'); block.className = 'preview-section';
      if (!section.senzaTitolo) block.append(element('h2', localized(section.nome, primary)));
      for (const item of section.voci || []) {
        const row = document.createElement('div'); row.className = 'preview-item';
        row.append(element('span', localized(item.nome, primary)),
          element('strong', item.prezzo ? `€ ${String(item.prezzo)}` : 'Prezzo da verificare'));
        if (item.descrizione) row.append(element('small', localized(item.descrizione, primary), 'preview-description'));
        block.append(row);
      }
      root.append(block);
    }
    root.hidden = false;
    status.textContent = `Bozza privata caricata. Stato: ${draft.status}. I prezzi e gli allergeni richiedono sempre verifica umana.`;
  } catch (error) {
    byId('preview-title').textContent = 'Anteprima non disponibile';
    status.textContent = error.message || 'Accesso negato o servizio non disponibile.';
  }
}
main();

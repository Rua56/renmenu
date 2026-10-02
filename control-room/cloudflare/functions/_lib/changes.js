// Applicazione delle modifiche scritte dal locale (prezzo, aggiunta, rimozione, coperto, allergeni)
// a una copia del menu. Usata sia per la risposta all'anteprima sia per gli aggiornamenti dei menu
// già online. Funzione pura: nessun accesso a D1 o GitHub. Le fonti dei valori invariati restano;
// quelle dei piatti successivi a una rimozione seguono il piatto.
import { applyExtras } from './extras.js';

export function applyMenuChanges(menu, provenanceIn, selected, { source, sections = {} } = {}) {
  const next = structuredClone(menu);
  const added = [];
  for (const entry of selected) if (entry.type === 'prezzo') next.sezioni[entry.si].voci[entry.vi].prezzo = entry.after;
  const extras = applyExtras(next, selected.filter((entry) => ['coperto', 'allergeni'].includes(entry.type)), () => source);
  Object.assign(next, extras.menu);
  for (const entry of selected) if (entry.type === 'aggiungi') {
    const si = Number.isInteger(Number(sections[entry.id])) && next.sezioni[Number(sections[entry.id])] ? Number(sections[entry.id]) : entry.section;
    next.sezioni[si].voci.push({ nome: { it: entry.name }, prezzo: entry.price });
    added.push({ si, vi: next.sezioni[si].voci.length - 1, entry });
  }
  // Rimozioni per ultime, dall'indice più alto.
  const removals = selected.filter((entry) => entry.type === 'rimuovi').sort((a, b) => b.si - a.si || b.vi - a.vi);
  let provenance = [...(provenanceIn || []).filter((row) => !extras.provenance.some((extra) => extra.path === row.path)), ...extras.provenance];
  for (const entry of removals) {
    next.sezioni[entry.si].voci.splice(entry.vi, 1);
    const prefix = `sezioni.${entry.si}.voci.`;
    provenance = provenance.filter((row) => !String(row.path).startsWith(`${prefix}${entry.vi}.`)).map((row) => {
      const match = String(row.path).match(/^sezioni\.(\d+)\.voci\.(\d+)\.(.+)$/);
      if (!match || Number(match[1]) !== entry.si || Number(match[2]) < entry.vi) return row;
      return { ...row, path: `${prefix}${Number(match[2]) - 1}.${match[3]}` };
    });
    for (const item of added) if (item.si === entry.si && item.vi > entry.vi) item.vi -= 1;
  }
  const changedPrices = selected.filter((entry) => entry.type === 'prezzo').map((entry) => {
    const shift = removals.filter((r) => r.si === entry.si && r.vi < entry.vi).length;
    return { path: `sezioni.${entry.si}.voci.${entry.vi - shift}.prezzo`, value: entry.after };
  });
  const newProvenance = [
    ...changedPrices.map((row) => ({ ...row, source, status: 'confermato' })),
    ...added.flatMap(({ si, vi, entry }) => [
      { path: `sezioni.${si}.voci.${vi}.nome.it`, source, value: entry.name, status: 'confermato' },
      { path: `sezioni.${si}.voci.${vi}.prezzo`, source, value: entry.price, status: 'confermato' }])
  ];
  return { next, added, removals, provenance, newProvenance };
}

export const describeChange = (entry) => (entry.type === 'prezzo' ? `${entry.name} ${entry.before} → ${entry.after}`
  : entry.type === 'aggiungi' ? `aggiunto ${entry.name} ${entry.price}` : entry.type === 'coperto' ? `coperto ${entry.value}`
    : entry.type === 'allergeni' ? `allergeni ${entry.name}: ${entry.label}` : `tolto ${entry.name}`);

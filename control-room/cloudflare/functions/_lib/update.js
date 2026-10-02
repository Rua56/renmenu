// Aggiornamento di un menu già online (punto 3 della roadmap di Jarvis). La bozza parte SEMPRE dal
// menu pubblicato su main (letto da GitHub), mai da zero: Jarvis applica solo le modifiche scritte
// in modo esplicito nell'email (prezzo, aggiunta, rimozione, coperto, allergeni) e lascia a Riccardo
// tutto il resto. Stesso Menu ID, quindi stesso QR. Se l'email contiene un menu completo, propone
// la sostituzione e mostra le differenze.
import { proposeReplyChanges } from './approvals.js';
import { applyMenuChanges, describeChange } from './changes.js';
import { VENUE_LINE, extractMenuFromText, menuDiff } from './menu.js';

const RECEIVED = /^Oggetto ricevuto:/i;
const itName = (value) => (typeof value === 'string' ? value : value?.it || '');

export function updateBody(sourceText) {
  return String(sourceText || '').split(/\r?\n/).filter((line) => !RECEIVED.test(line.trim()) && !VENUE_LINE.test(line.trim())).join('\n');
}

function baseProvenance(menu, label) {
  const rows = [];
  (menu.sezioni || []).forEach((section, si) => {
    rows.push({ path: `sezioni.${si}.nome.it`, source: label, value: itName(section.nome), status: 'confermato' });
    (section.voci || []).forEach((item, vi) => {
      rows.push({ path: `sezioni.${si}.voci.${vi}.nome.it`, source: label, value: itName(item.nome), status: 'confermato' });
      if (item.prezzo !== undefined) rows.push({ path: `sezioni.${si}.voci.${vi}.prezzo`, source: label, value: String(item.prezzo), status: 'confermato' });
    });
  });
  if (menu.coperto !== undefined) rows.push({ path: 'coperto', source: label, value: String(menu.coperto), status: 'confermato' });
  return rows;
}

/**
 * @returns {{ ok: true, extraction } | { ok: false, reason }}
 * extraction ha la stessa forma di extractMenuFromText (menu, extracted, uncertain, provenance, warnings)
 * più mode ('aggiornamento' | 'sostituzione') e added (numero di piatti nuovi).
 */
export function prepareUpdate({ slug, current, sha, sourceText, subject }) {
  const short = String(sha || '').slice(0, 7);
  const onlineLabel = `Menu online (main${short ? ` ${short}` : ''})`;
  const body = updateBody(sourceText);
  const itemCount = (current.sezioni || []).reduce((n, s) => n + (s.voci || []).length, 0);
  const full = extractMenuFromText(current.nome || slug, body, slug);
  if (full.extracted.length >= 5 && full.extracted.length >= itemCount / 2) {
    const menu = { ...current, ...full.menu, id: slug, nome: current.nome || full.menu.nome };
    const diff = menuDiff(current, menu);
    return { ok: true, extraction: { ...full, menu, mode: 'sostituzione', added: 0, warnings: [
      `L’email contiene un menu completo (${full.extracted.length} piatti): Jarvis propone di SOSTITUIRE il menu online «${slug}» (stesso Menu ID, QR invariato). Controlla bene le differenze.`,
      ...(diff.length ? [`Differenze rispetto al menu online: ${diff.slice(0, 12).map((d) => (d.type === 'prezzo' ? `${d.name} ${d.before} → ${d.after}` : `${d.type} ${d.name}`)).join('; ')}${diff.length > 12 ? '…' : ''}.`] : []),
      ...full.warnings] } };
  }
  const proposals = proposeReplyChanges(body, current);
  const changes = proposals.filter((entry) => entry.type !== 'manuale');
  const manual = proposals.filter((entry) => entry.type === 'manuale');
  if (!changes.length) return { ok: false, reason: 'Nell’email non trovo una modifica precisa (prezzo, piatto da aggiungere o togliere, coperto): leggila tu e modifica il menu nel Builder.' };
  const source = `Email del locale «${String(subject || '').slice(0, 80)}»`;
  const applied = applyMenuChanges(current, baseProvenance(current, onlineLabel), changes, { source });
  const changed = new Set(applied.newProvenance.map((row) => row.path));
  const provenance = [...applied.provenance.filter((row) => !changed.has(row.path)), ...applied.newProvenance];
  const menu = { ...applied.next, id: slug };
  return { ok: true, extraction: {
    menu, mode: 'aggiornamento', added: applied.added.length,
    extracted: changes.map((entry) => ({ name: entry.name || entry.type, price: entry.after || entry.price || entry.value || '', sourceLine: entry.source })),
    uncertain: manual.map((entry) => String(entry.source).slice(0, 220)),
    provenance,
    warnings: [
      `Aggiornamento del menu online «${slug}»${short ? ` (versione ${short})` : ''}: ${changes.map(describeChange).join('; ')}. Stesso Menu ID: il QR non cambia.`,
      ...manual.map((entry) => `Da valutare a mano: «${String(entry.source).slice(0, 160)}»${entry.note ? ` (${entry.note})` : ''}.`)
    ]
  } };
}

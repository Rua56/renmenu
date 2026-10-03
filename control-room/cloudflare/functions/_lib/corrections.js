/* Correzioni scritte dal locale nella stessa email del menu («il fritto misto in realtà lo abbiamo
 * alzato, adesso è 19 euro»): sono il prezzo NUOVO di un piatto già letto, non un piatto nuovo.
 * Jarvis aggiorna quel piatto (con la riga come fonte) e lo segnala; se la frase è ambigua decide Riccardo. */
import { proposeReplyChanges } from './approvals.js';

/** Righe che correggono il prezzo di un piatto già presente nel menu. */
export function priceCorrections(rows, menu) {
  const out = [];
  for (const row of rows) {
    const text = String(row || '').trim();
    if (!text || text.startsWith('[da verificare]') || !/\d/.test(text) || /^(?:il\s+)?coperto\b/i.test(text)) continue;
    const changes = proposeReplyChanges(text, menu).filter((c) => c.type === 'prezzo');
    if (changes.length === 1) out.push({ ...changes[0], row: text });
  }
  return out;
}

export function applyPriceCorrections(extraction, sourceText) {
  const lines = String(sourceText || '').split(/\r?\n/).map((l) => l.trim());
  const found = priceCorrections(extraction.uncertain || [], extraction.menu);
  const applied = [];
  for (const c of found) {
    const item = extraction.menu.sezioni?.[c.si]?.voci?.[c.vi];
    if (!item || String(item.prezzo) === c.after) continue;
    const line = lines.findIndex((l) => l === c.row) + 1 || null;
    item.prezzo = c.after;
    const path = `sezioni.${c.si}.voci.${c.vi}.prezzo`;
    extraction.provenance = [...(extraction.provenance || []).filter((p) => p.path !== path), { path, source: line ? `riga ${line}` : 'correzione del locale', value: c.after, status: 'confermato' }];
    applied.push({ name: c.name, before: c.before, after: c.after, line, source: c.row });
  }
  if (applied.length) extraction.warnings.push(`Correzioni del locale applicate: ${applied.map((a) => `${a.name} ${a.before} → ${a.after}${a.line ? ` (riga ${a.line})` : ''}`).join('; ')}. Controllale.`);
  return applied;
}

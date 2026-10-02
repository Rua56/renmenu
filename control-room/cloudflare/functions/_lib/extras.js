// Coperto e allergeni dichiarati dal locale (pilota 8, 2026-10-02).
// Jarvis li LEGGE dal testo ricevuto e li PROPONE: niente viene dedotto dagli ingredienti
// e niente entra nel menu senza il tocco di Riccardo. Codici allergeni UE 1–14, come
// window.RENMENU.allergeni del sito pubblico (assets/common.js).
export const ALLERGENS = Object.freeze([
  ['1', 'glutine', /\bglutine\b|\bfrumento\b/],
  ['2', 'crostacei', /\bcrostace[io]\b|\bgamber[io]\b|\bscampi\b/],
  ['3', 'uova', /\buov[ao]\b/],
  ['4', 'pesce', /\bpesce\b/],
  ['5', 'arachidi', /\barachid[ei]\b/],
  ['6', 'soia', /\bsoia\b/],
  ['7', 'latte', /\blatte\b|\blattosio\b|\blatticini\b/],
  ['8', 'frutta a guscio', /\bfrutta a guscio\b|\bnoci\b|\bnocciole\b|\bmandorle\b|\bpistacchi\b/],
  ['9', 'sedano', /\bsedano\b/],
  ['10', 'senape', /\bsenape\b/],
  ['11', 'sesamo', /\bsesamo\b/],
  ['12', 'solfiti', /\bsolfiti\b|\banidride solforosa\b/],
  ['13', 'lupini', /\blupini\b/],
  ['14', 'molluschi', /\bmolluschi\b|\bcozze\b|\bvongole\b/]
]);
const plain = (value) => String(value).toLocaleLowerCase('it-IT').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const STOP = new Set(['con', 'del', 'della', 'dello', 'dei', 'degli', 'delle', 'al', 'alla', 'allo', 'ai', 'agli', 'alle',
  'di', 'da', 'in', 'il', 'la', 'lo', 'le', 'gli', 'un', 'una', 'nel', 'nella', 'sul', 'sulla']);
const keyWords = (name) => (plain(name).match(/[a-z]+/g) || []).filter((word) => word.length >= 3 && !STOP.has(word));
const nameOf = (value) => (typeof value === 'string' ? value : value?.it || '').trim();
const NEGATION = /\b(?:senza|privo|priva|privi|prive|non cont(?:ien|eng)\w*|free)\b/;

export function allergenCodes(text) {
  const value = plain(text);
  return ALLERGENS.filter(([, , pattern]) => pattern.test(value)).map(([code]) => code);
}
export const allergenLabel = (codes) => codes.map((code) => ALLERGENS.find(([id]) => id === code)?.[1] || code).join(', ');

/** Riconosce coperto o allergeni in UNA frase/riga. Restituisce una proposta o null. */
export function detectExtra(sentence, menu) {
  const text = String(sentence || '').trim();
  const lower = plain(text);
  // "Il coperto è 2,50", "Aggiungete il coperto di 3 euro", "vorrei mettere anche il coperto a 2€":
  // un solo importo nella frase, altrimenti decide Riccardo.
  const amounts = lower.match(/\d{1,4}(?:[,.]\d{1,2})?/g) || [];
  const cover = amounts.length === 1 && lower.match(/^(?:[a-zà-ÿ'’\s]{0,40}\s)?(?:il\s+)?coperto\b[^\d]*(\d{1,2})(?:[,.](\d{1,2}))?\s*(?:€|euro)?(?:\s+(?:a\s+persona|a\s+testa|per\s+persona))?\s*\.?$/);
  // Importo insolito per un coperto (oltre 10 €): può essere un refuso, decide Riccardo.
  if (cover && Number(`${cover[1]}.${cover[2] || 0}`) > 10) return { type: 'manuale', source: text, note: `coperto di ${Number(cover[1])},${(cover[2] || '').padEnd(2, '0')} €: importo insolito, confermalo tu` };
  if (cover) return { type: 'coperto', value: `${Number(cover[1])},${(cover[2] || '').padEnd(2, '0')}`, source: text };
  if (/\bcoperto\b/.test(lower)) return { type: 'manuale', source: text, note: 'Coperto citato senza un importo chiaro: inseriscilo a mano.' };
  // Solo dichiarazioni esplicite ("contiene", "allergeni: …"): mai dedurre dal nome del piatto.
  if (!/\bcont(?:ien|eng|ener)\w*|\ballergen\w*|\bpresenza di\b/.test(lower)) return null;
  const codes = allergenCodes(text);
  if (NEGATION.test(lower) || /\btracce\b/.test(lower)) return { type: 'manuale', source: text, note: 'Frase su allergeni con “senza” o “tracce”: valutala tu, Jarvis non la trasforma in allergeni.' };
  if (!codes.length) return { type: 'manuale', source: text, note: 'Allergeni citati senza indicare quali: chiedi al locale l’elenco.' };
  const words = new Set(lower.match(/[a-z]+/g) || []);
  const items = [];
  (menu?.sezioni || []).forEach((section, si) => (section?.voci || []).forEach((item, vi) => {
    const keys = keyWords(nameOf(item?.nome));
    if (keys.length && words.has(keys[0])) items.push({ si, vi, name: nameOf(item.nome), score: keys.filter((key) => words.has(key)).length, current: Array.isArray(item.allergeni) ? item.allergeni.map(String) : [] });
  }));
  const best = items.length ? Math.max(...items.map((item) => item.score)) : 0;
  const matched = items.filter((item) => item.score === best);
  if (matched.length !== 1) return { type: 'manuale', source: text, note: matched.length
    ? `Più piatti possibili (${matched.map((item) => item.name).join(', ')}): assegna tu gli allergeni.`
    : 'Allergeni indicati senza un piatto riconoscibile: assegnali tu.' };
  const [item] = matched;
  const merged = [...new Set([...item.current, ...codes])].sort((a, b) => Number(a) - Number(b));
  if (merged.length === item.current.length) return null;
  return { type: 'allergeni', si: item.si, vi: item.vi, name: item.name, codes: merged, label: allergenLabel(merged), source: text };
}

/** Proposte dal testo originale della richiesta, con la riga di provenienza. */
export function proposeSourceExtras(sourceText, menu) {
  const proposals = [];
  String(sourceText || '').split(/\r?\n/).forEach((line, index) => {
    const row = line.trim().replace(/^[-•*]\s*/, '');
    if (!row || /(?:[—–\-:\t]|\.{2,})\s*(?:€\s*)?\d{1,4}(?:[,.]\d{1,2})?\s*€?$/.test(row) && !/^coperto\b/i.test(row)) return;
    const found = detectExtra(row, menu);
    if (!found) return;
    if (found.type === 'coperto' && String(menu?.coperto ?? '') === found.value) return;
    proposals.push({ id: `s${proposals.length + 1}`, line: index + 1, ...found });
  });
  return proposals;
}

/** Applica coperto/allergeni scelti a una copia del menu e restituisce le nuove fonti. */
export function applyExtras(menu, selected, sourceFor) {
  const next = structuredClone(menu);
  const provenance = [];
  for (const entry of selected) {
    if (entry.type === 'coperto') {
      next.coperto = entry.value;
      provenance.push({ path: 'coperto', source: sourceFor(entry), value: entry.value, status: 'confermato' });
    } else if (entry.type === 'allergeni' && next.sezioni?.[entry.si]?.voci?.[entry.vi]) {
      next.sezioni[entry.si].voci[entry.vi].allergeni = entry.codes;
      provenance.push({ path: `sezioni.${entry.si}.voci.${entry.vi}.allergeni`, source: sourceFor(entry), value: entry.codes.join(','), status: 'confermato' });
    }
  }
  return { menu: next, provenance };
}

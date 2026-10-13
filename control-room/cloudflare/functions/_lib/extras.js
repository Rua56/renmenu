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
import { prepareEmailSource } from './email-text.js';
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
  // Numeri che non sono importi (età, persone, ore: «sotto i 6 anni») non contano come secondo importo.
  const amounts = (lower.match(/\d{1,4}(?:[,.]\d{1,2})?(?:\s*(?:€|euro|anni|anno|mesi|persone|ore|tavol\w*))?/g) || []).filter((a) => !/(?:anni|anno|mesi|persone|ore|tavol\w*)$/.test(a));
  const cover = amounts.length === 1 && lower.match(/^(?:[a-zà-ÿ'’,\s]{0,120}\s)?(?:il\s+|un\s+)?coperto\b[^\d]*(\d{1,2})(?:[,.](\d{1,2}))?\s*(?:€|euro)?(?:\s+(?:a\s+persona|a\s+testa|per\s+persona))?\s*(?:\.|[,;]\s*(?:ma|però|tranne|esclus\w*|gratis|gratuit\w*|i bambini|per i bambini)\b[^\d€]*(?:\d{1,2}\s*anni)?[^\d€]*\.?)?$/);
  // Importo insolito per un coperto (oltre 10 €): può essere un refuso, decide Riccardo.
  // Negazioni o rimozioni ("togliete il coperto di 2 euro", "non mettete il coperto"): decide Riccardo.
  if (cover && /\b(?:non|togli\w*|toglie\w*|rimuov\w*|elimin\w*|senza|niente)\b/.test(lower.slice(0, lower.indexOf('coperto')))) return { type: 'manuale', source: text, note: 'Coperto da togliere o frase negativa: decidi tu.' };
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

// Numeri di allergeni scritti dal locale sotto il piatto come «Allergeni: 1, 4, 7 *» (anche «Allergens: …» nella traduzione):
// elenco di numeri UE 1–14, poi eventuali simboli di rimando (* @) che il menu spiega altrove.
const LABEL_ALLERGENS = /\ballergen(?:i|s)?\b\s*:?\s*(\d{1,2}(?:\s*[-,/–]\s*\d{1,2})*)(?:\s*[*@]+)*/i;
const LABEL_ALLERGENS_ALL = new RegExp(LABEL_ALLERGENS.source, 'gi');
const listOf = (raw) => String(raw).split(/\s*[-,/–]\s*/);

/** Numeri di allergeni scritti dal locale: «… panna acida (7)», «(1-3-4-7)» oppure «Allergeni: 1, 4, 7 *».
 * Proposte NON preselezionate, valgono solo se la legenda del menu segue i numeri UE 1–14. */
export function proposeMenuAllergens(menu) {
  const proposals = [];
  (menu?.sezioni || []).forEach((section, si) => (section?.voci || []).forEach((item, vi) => {
    const text = String(item?.descrizione?.it || '');
    if (Array.isArray(item.allergeni) && item.allergeni.length) return;
    const m = text.match(/\((\d{1,2}(?:\s*[-,/]\s*\d{1,2})*)\)/) || text.match(LABEL_ALLERGENS);
    if (!m) return;
    const parts = listOf(m[1]);
    const codes = [...new Set(parts)].filter((c) => Number(c) >= 1 && Number(c) <= 14).sort((a, b) => Number(a) - Number(b));
    if (!codes.length || codes.length !== parts.length) return;
    proposals.push({ id: `d${proposals.length + 1}`, line: null, type: 'allergeni', si, vi, name: nameOf(item.nome), codes, label: allergenLabel(codes), source: text.slice(0, 200), legend: true });
  }));
  return proposals;
}

/** Allergeni scritti in una email: una legenda numerata («1 glutine, 2 crostacei … 14 molluschi») e i numeri accanto ai piatti
 *  («I numeri accanto ai piatti sono: frico 7; gnocchi 1,3,7; …»). I numeri valgono solo se la legenda del cliente
 *  coincide con quella UE 1–14; altrimenti una sola proposta manuale. Mai dedotti dagli ingredienti. */
export function proposeEmailAllergens(sourceText, menu) {
  const text = String(sourceText || '');
  const rows = text.split(/\r?\n/);
  const numbersAt = rows.findIndex((row) => /\bnumeri\b[^:]{0,60}\b(?:piatti|accanto|sotto|vicino)\b[^:]{0,40}:/i.test(row) || /\ballergeni\b[^:]{0,30}\bpiatti\b[^:]{0,20}:/i.test(row));
  if (numbersAt < 0) return [];
  const legendAt = rows.findIndex((row) => /\b1\s+glutine\b/i.test(row) || /(?:\b\d{1,2}\s+[a-zà-ÿ][a-zà-ÿ ]{2,24}\s*[,.;]\s*){5,}/i.test(row));
  if (legendAt >= 0) {
    // legenda del cliente = legenda UE? ogni «N nome» deve avere lo stesso codice di ALLERGENS
    const pairs = [...rows[legendAt].matchAll(/\b(\d{1,2})\s+([a-zà-ÿ][a-zà-ÿ ]{2,24}?)(?=\s*[,.;]|\s*$)/gi)];
    const wrong = pairs.filter(([, n, label]) => { const codes = allergenCodes(label); return !codes.includes(n) || codes.length !== 1; });
    if (!pairs.length || wrong.length) return [{ id: 'e1', line: legendAt + 1, type: 'manuale', source: rows[legendAt].trim().slice(0, 200), note: 'La legenda degli allergeni scritta dal cliente non coincide con i numeri UE 1–14: assegna tu gli allergeni, Jarvis non li converte.' }];
  } else {
    return [{ id: 'e1', line: numbersAt + 1, type: 'manuale', source: rows[numbersAt].trim().slice(0, 200), note: 'Numeri degli allergeni senza una legenda: non so a cosa corrispondono, assegnali tu.' }];
  }
  const after = rows[numbersAt].slice(rows[numbersAt].indexOf(':') + 1);
  const list = after.split(/\.\s+(?=[A-ZÀ-Ý])/)[0];
  const rest = after.slice(list.length);
  const proposals = [];
  const dishes = [];
  (menu?.sezioni || []).forEach((section, si) => (section?.voci || []).forEach((item, vi) => dishes.push({ si, vi, name: nameOf(item?.nome), words: new Set(keyWords(nameOf(item?.nome))), current: Array.isArray(item.allergeni) ? item.allergeni.map(String) : [] })));
  for (const part of list.split(';')) {
    const m = part.trim().replace(/\.$/, '').match(/^(.+?)\s+((?:\d{1,2}\s*[,/-]?\s*)+)$/);
    if (!m) { if (part.trim()) proposals.push({ type: 'manuale', source: part.trim(), note: `Non riesco a leggere i numeri di «${part.trim().slice(0, 60)}»: assegnali tu.` }); continue; }
    const codes = [...new Set(m[2].split(/[\s,/-]+/).filter(Boolean))].sort((a, b) => Number(a) - Number(b));
    if (codes.some((c) => Number(c) < 1 || Number(c) > 14)) { proposals.push({ type: 'manuale', source: part.trim(), note: `Numeri fuori dalla legenda UE 1–14 per «${m[1].trim()}»: assegnali tu.` }); continue; }
    const keys = keyWords(m[1]);
    const found = dishes.filter((d) => keys.length && keys.every((k) => d.words.has(k) || [...d.words].some((w) => w.startsWith(k) && k.length >= 5)));
    if (found.length !== 1) { proposals.push({ type: 'manuale', source: part.trim(), note: found.length ? `«${m[1].trim()}» corrisponde a più piatti (${found.map((d) => d.name).join(', ')}): assegna tu gli allergeni.` : `«${m[1].trim()}»: non trovo il piatto nel menu, assegna tu gli allergeni.` }); continue; }
    const [dish] = found;
    const merged = [...new Set([...dish.current, ...codes])].sort((a, b) => Number(a) - Number(b));
    if (merged.length === dish.current.length) continue;
    proposals.push({ type: 'allergeni', si: dish.si, vi: dish.vi, name: dish.name, codes: merged, label: allergenLabel(merged), source: `${m[1].trim()} ${codes.join(',')}` });
  }
  // «Per la tartare e il resto non so, dovrei chiedere in cucina»: il resto resta senza allergeni, da chiedere.
  const unknown = (rest + ' ' + (rows[numbersAt + 1] || '')).match(/(?:per\s+[^.]{0,80}?)?\b(?:non so|non sappiamo|da chiedere|dovrei chiedere|devo chiedere)\b[^.]*\./i);
  if (unknown) proposals.push({ type: 'manuale', source: unknown[0].trim().slice(0, 200), note: 'Per gli altri piatti il cliente non conosce gli allergeni: chiedili in cucina. Jarvis non li deduce dagli ingredienti.' });
  return proposals.map((p, i) => ({ id: `e${i + 1}`, line: numbersAt + 1, ...p }));
}

/** Tutte le proposte: dal testo scritto (anche email a capo automatico), dai numeri nelle descrizioni e dagli allergeni dell'email. */
export const allExtras = (sourceText, menu) => {
  const text = prepareEmailSource(sourceText);
  const email = proposeEmailAllergens(text, menu);
  // Le frasi sugli allergeni già lette dall'email non diventano anche proposte manuali generiche.
  const own = proposeSourceExtras(text, menu).filter((p) => !(email.length && p.type === 'manuale' && /\ballergen/i.test(p.source) && /\b(?:legenda|numerat\w*)\b/i.test(p.source)));
  return [...own, ...email.map((p) => ({ ...p, id: `e${p.id.slice(1)}` })), ...proposeMenuAllergens(menu)];
};

/** Applica coperto/allergeni scelti a una copia del menu e restituisce le nuove fonti. */
export function applyExtras(menu, selected, sourceFor) {
  const next = structuredClone(menu);
  const provenance = [];
  for (const entry of selected) {
    if (entry.type === 'coperto') {
      next.coperto = entry.value;
      provenance.push({ path: 'coperto', source: sourceFor(entry), value: entry.value, status: 'confermato' });
    } else if (entry.type === 'allergeni' && next.sezioni?.[entry.si]?.voci?.[entry.vi]) {
      const item = next.sezioni[entry.si].voci[entry.vi];
      item.allergeni = entry.codes;
      // Descrizione fatta solo dei numeri («(10)», «(1-2-4)»): ora sono icone degli allergeni, il testo doppio si toglie.
      if (entry.legend && /^\s*\(\s*\d{1,2}(?:\s*[-,/]\s*\d{1,2})*\s*\)\s*$/.test(String(item.descrizione?.it || ''))) delete item.descrizione;
      else if (entry.legend && item.descrizione?.it) {
        // Numeri in una descrizione vera (in fondo, davanti o «Allergeni: …»): restano solo le parole (in ogni lingua).
        for (const lang of Object.keys(item.descrizione)) {
          const before = String(item.descrizione[lang]);
          const cleaned = before.replace(/\s*\(\s*\d{1,2}(?:\s*[-,/]\s*\d{1,2})*\s*\)\s*/g, ' ').replace(LABEL_ALLERGENS_ALL, ' ').replace(/\s+/g, ' ').trim();
          // Se il testo cominciava con i numeri, la prima parola rimasta apre la frase.
          item.descrizione[lang] = /^\s*(?:\(|allergen)/i.test(before) ? cleaned.replace(/^./, (c) => c.toLocaleUpperCase()) : cleaned;
        }
      }
      if (entry.legend && item.descrizione && !Object.values(item.descrizione).some((v) => String(v).trim())) delete item.descrizione;
      provenance.push({ path: `sezioni.${entry.si}.voci.${entry.vi}.allergeni`, source: sourceFor(entry), value: entry.codes.join(','), status: 'confermato' });
    }
  }
  return { menu: next, provenance };
}

/* Correzione dei refusi sulle parole chiave (non sui nomi dei piatti né sui valori):
 * «copreto» → coperto, «telfono» → telefono, «instgram» → instagram, «martedi» → martedì.
 * Distanza di Damerau-Levenshtein: 1 per parole da 4-7 lettere, 2 da 8 in su. */
export function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) for (let j = 1; j <= b.length; j += 1) {
    const cost = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}
const plain = (w) => w.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/** Parola più vicina del vocabolario, o null. Le parole corte (<4) devono essere esatte. */
export function closestWord(word, vocabulary) {
  const w = plain(word);
  if (w.length < 4 || /\d/.test(w)) return null;
  let best = null, bestD = Infinity;
  for (const target of vocabulary) {
    const t = plain(target);
    if (Math.abs(t.length - w.length) > 2 || w[0] !== t[0] && w.length < 6) continue;
    const max = t.length >= 8 ? 2 : t.length >= 4 ? 1 : 0;
    const dist = editDistance(w, t);
    if (dist <= max && dist < bestD) { best = target; bestD = dist; }
  }
  return best;
}

/** Testo con le sole parole chiave corrette; il resto resta com'è. */
export function fixTypos(text, vocabulary, protectedWords = new Set()) {
  return String(text || '').replace(/[A-Za-zÀ-ÿ]+/g, (word) => {
    if (protectedWords.has(plain(word))) return word;
    const hit = closestWord(word, vocabulary);
    if (!hit || plain(hit) === plain(word)) return word;
    return word[0] === word[0].toUpperCase() && word.length > 1 ? hit[0].toUpperCase() + hit.slice(1) : hit;
  });
}

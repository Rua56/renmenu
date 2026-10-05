// Dubbi della lettura di una foto, chiusi da Riccardo con un tocco su Telegram.
// Ogni dubbio viene da una riga «[da verificare] …» con nome, sezione e i prezzi letti dai modelli:
// Riccardo guarda il menu e sceglie il prezzo giusto (o ne scrive un altro, o salta). La voce scelta entra
// nel testo fonte della foto, sotto la sua sezione, come una voce confermata. Mai prezzi inventati:
// entra solo ciò che Riccardo ha scelto o scritto.

export const PRICE_INPUT = /^\s*(?:€\s*)?(\d{1,4})(?:[.,](\d{1,2}))?\s*(?:€|euro)?\s*$/i;

/** «7» → «7,00», «7.5» → «7,50». Null se non è un prezzo. */
export function normalizePrice(text) {
  const m = PRICE_INPUT.exec(String(text || ''));
  if (!m) return null;
  return `${Number(m[1])},${String(m[2] || '0').padEnd(2, '0')}`;
}

/** Inserisce «Nome — prezzo» sotto la sezione giusta e toglie la riga di dubbio. */
export function applyCheck(sourceText, check, price) {
  const lines = String(sourceText || '').split('\n');
  const at = lines.indexOf(check.line);
  if (at >= 0) lines.splice(at, 1);
  if (price === null || price === undefined) return lines.join('\n');
  const entry = [`${check.name} — ${price}`, ...(check.descr ? [`> ${check.descr}`] : [])];
  const head = check.section ? lines.findIndex((l) => l.trim().replace(/^#\s*/, '').replace(/\s+—\s+.*$/, '').toLowerCase() === check.section.toLowerCase() && l.startsWith('#')) : -1;
  const firstDoubt = lines.findIndex((l) => l.startsWith('[da verificare]'));
  if (head >= 0) {
    let end = head + 1;
    while (end < lines.length && !lines[end].startsWith('#') && !lines[end].startsWith('[da verificare]')) end += 1;
    lines.splice(end, 0, ...entry);
  } else {
    const where = firstDoubt >= 0 ? firstDoubt : lines.length;
    lines.splice(where, 0, ...(check.section ? [`# ${check.section}`] : []), ...entry);
  }
  return lines.join('\n');
}

/** Domanda su Telegram per il dubbio k (0-based) di total. */
export function checkQuestion(check, k, total) {
  const several = check.options.length > 1;
  const text = `Dubbio ${k + 1} di ${total}${check.section ? ` · ${check.section}` : ''}\n«${check.name}»${check.descr ? `\n${check.descr}` : ''}\n`
    + (several ? `Le letture non concordano: ${check.options.join(' oppure ')}. Guarda il menu: qual è il prezzo giusto?`
      : `Letto ${check.options[0]} da una sola lettura. È giusto?`)
    + '\nSe è un altro, scrivimelo (es. 7,50).';
  const buttons = [
    ...check.options.slice(0, 3).map((price, i) => [several ? `${price} €` : `Sì, ${price} €`, `chk:${k}:${i}`]),
    ['Salta (resta da verificare)', `chk:${k}:s`],
    ['Non è nel menu', `chk:${k}:n`],
    ['Basta, fai la bozza', 'chk:end']
  ];
  return { text, buttons };
}

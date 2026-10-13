/* Strutture dei menu veri (2026-10-03), imparate da Al Bakaro e Blanch:
 * - vini e bevande con PIÙ PREZZI sulla stessa voce («Ribolla — calice 5 / bottiglia 40»,
 *   «Friulano 5/40» sotto «Vini bianchi», colonne «calice  bottiglia», righe «calice 5» sotto il nome);
 * - PERCORSI DEGUSTAZIONE: titolo + portate senza prezzo + prezzo a persona («55 € a persona, vini esclusi»);
 * - DESCRIZIONI sotto il piatto (ingredienti, «CON SPUMA DI PATATE…», «Collio DOC, fresco»).
 * Regola di sempre: ogni prezzo e ogni etichetta vengono SOLO dal testo; quando un'etichetta è
 * dedotta (due prezzi senza «calice/bottiglia» in una sezione vini) diventa una nota da confermare. */

export const LABELS = [
  ['Mezza bottiglia', /\b(?:mezza bottiglia|1\/2 bottiglia|bottiglia da 0[,.]375)\b|\b0[,.]375 ?l\b/i],
  ['Magnum', /\bmagnum\b/i],
  ['Calice', /\b(?:al calice|calice|calici|al bicchiere|bicchiere|glass|in mescita|mescita)\b/i],
  ['Bottiglia', /(?:\bla bottiglia|\bbottiglia|\bbottiglie|\bbott\.|\bbott\b|\bbtg\.?|\bbt\.|\bbottle)(?![a-zà-ÿ])/i],
  ['Caraffa', /\bcaraff[ae]\b/i],
  ['1/4 l', /(?<![\d/])1\/4(?:\s?l(?:itro)?)?(?![\d/])|\bquartino\b/i],
  ['1/2 l', /(?<![\d/])1\/2\s?l(?:itro)?\b|\bmezzo litro\b/i],
  ['1 l', /\bun litro\b|(?<![\d/,.])1\s?l\b|\blitro\b/i],
  ['Piccola', /\bpiccol[ao]\b/i], ['Media', /\bmedi[ao]\b/i], ['Grande', /\bgrande\b/i],
  ['Mezza porzione', /\b(?:mezza porzione|1\/2 porzione)\b/i], ['Porzione intera', /\bporzione intera\b/i]
];
const LABEL_ANY = new RegExp(LABELS.map(([, rx]) => rx.source).join('|'), 'gi');
const labelOf = (text) => LABELS.find(([, rx]) => rx.test(text))?.[0] || null;

export const WINE_SECTION = /vin[io]\b|\bvini\b|bollicin|spumant|champagne|prosecco|franciacorta|metodo classico|bianch[io]|ross[io]|rosat[io]|orange|macerat|cantina|calic[ei]|mescita|bottigli|enoteca|carta dei vini/i;
const YEAR = /^(?:19|20)\d{2}$/;
// Importo: non un anno, non una quantità (0,75 l, 33 cl, 12%, 18 mesi…), non parte di una frazione.
const AMOUNT = /(?<![\d,.])(€\s*)?(\d{1,4}(?:[,.]\d{1,2})?)(?![\d])(\s*(?:€|euro|eur)(?![a-z]))?(?!\s*(?:%|cl\b|ml\b|lt\b|l\b|gr\b|g\b|kg\b|anni\b|mesi\b|gg\b|°|persone\b|pers\b|porzion|tempi\b|portat[ae]\b|piatti\b|calici\b|giorni\b|ore\b|settimane\b|volte\b|tavoli\b|ospiti\b|bambini\b|foto\b))/gi;
export const fmt = (amount) => { const [w, c = ''] = String(amount).replace('.', ',').split(','); return `${w},${c.padEnd(2, '0')}`; };
const positive = (amount) => Number(String(amount).replace(',', '.')) > 0;
const STOP = /\b(?:costa|costano|viene|vengono|vendiamo|facciamo|mettiamo|invece|prezzo|prezzi|adesso|ora|diventa|passa|vorrei|vorremmo|abbiamo|offriamo|proponiamo|grazie|buongiorno|salve|ciao)\b/i;

function amounts(text) {
  const out = [];
  for (const m of text.matchAll(AMOUNT)) {
    if (!m[1] && !m[3] && YEAR.test(m[2])) continue;
    // Frazioni di quantità (1/2, 1/4, 3/4 l): non sono prezzi.
    const around = text.slice(Math.max(0, m.index - 2), m.index + m[0].length + 2);
    if (/^\d$/.test(m[2]) && (/(?:^|[^\d])[1-3]\/[2-4](?!\d)/.test(around))) continue;
    out.push({ start: m.index, end: m.index + m[0].length, amount: m[2], currency: Boolean(m[1] || m[3]) });
  }
  return out;
}
function labels(text) {
  const out = [];
  for (const m of text.matchAll(LABEL_ANY)) out.push({ start: m.index, end: m.index + m[0].length, label: labelOf(m[0]), raw: m[0] });
  return out.filter((l) => l.label);
}
const GLUE = /\b(?:al|la|il|lo|a|per|in|da|e|ed|oppure|o|solo|soltanto|unicamente)\b|[€\s:—–\-/|,.()[\]+]|euro|eur/gi;
const glue = (text) => !String(text).replace(GLUE, '').trim();

/** «Nome — calice 5 / bottiglia 40», «Nome: 5 € al calice, 40 € la bottiglia», «Nome (calice) 5 (bottiglia) 40». */
export function labeledVariants(row) {
  const prices = amounts(row);
  if (prices.length < 2) return null;
  const tags = labels(row).filter((l) => !prices.some((p) => l.start < p.end && p.start < l.end));
  if (tags.length < prices.length) return null;
  const firstToken = Math.min(prices[0].start, ...tags.map((t) => t.start).filter((s) => s > 2));
  const name = row.slice(0, firstToken).replace(/[\s—–\-:|,(]+$/, '').trim();
  if (!/[A-Za-zÀ-ÿ]{3}/.test(name) || STOP.test(name)) return null;
  const tokens = [...prices.map((p) => ({ ...p, type: 'p' })), ...tags.filter((t) => t.start >= firstToken).map((t) => ({ ...t, type: 'l' }))].sort((a, b) => a.start - b.start);
  for (let i = 1; i < tokens.length; i += 1) if (!glue(row.slice(tokens[i - 1].end, tokens[i].start))) return null;
  if (!glue(row.slice(tokens.at(-1).end))) return null;
  // Abbinamento: etichetta subito prima del prezzo («calice 5») o subito dopo («5 € al calice»), stesso schema per tutta la riga.
  const before = tokens[0].type === 'l';
  const variants = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].type !== 'p') continue;
    const tag = before ? tokens[i - 1] : tokens[i + 1];
    if (!tag || tag.type !== 'l') return null;
    variants.push({ label: tag.label, amount: tokens[i].amount });
  }
  if (variants.length < 2 || new Set(variants.map((v) => v.label)).size !== variants.length || tokens.filter((t) => t.type === 'l').length !== variants.length) return null;
  if (!variants.every((v) => positive(v.amount))) return null;
  return { name, variants, inferred: false };
}

/** Due prezzi senza etichetta («Friulano 5/40», «Friulano 5,00 40,00»): solo in una sezione vini o con le colonne dichiarate. */
export function unlabeledVariants(row, { section = '', columns = null } = {}) {
  const prices = amounts(row);
  if (prices.length !== 2 || labels(row).some((l) => l.start > 2)) return null;
  const name = row.slice(0, prices[0].start).replace(/[\s—–\-:|,(]+$/, '').trim();
  if (!/[A-Za-zÀ-ÿ]{3}/.test(name) || STOP.test(name)) return null;
  if (!glue(row.slice(prices[0].end, prices[1].start)) || !glue(row.slice(prices[1].end))) return null;
  const [a, b] = prices.map((p) => p.amount);
  if (!positive(a) || !positive(b)) return null;
  if (columns?.length === 2) return { name, variants: [{ label: columns[0], amount: a }, { label: columns[1], amount: b }], inferred: false, fromColumns: true };
  if (!WINE_SECTION.test(section)) return null;
  // Calice prima e bottiglia dopo, come in tutte le carte dei vini: altrimenti decide Riccardo.
  if (!(Number(a.replace(',', '.')) < Number(b.replace(',', '.')))) return null;
  return { name, variants: [{ label: 'Calice', amount: a }, { label: 'Bottiglia', amount: b }], inferred: true };
}

/** Riga di sola etichetta e prezzo sotto il nome del vino: «calice 5», «Bottiglia € 40,00», «- al calice: 5 €». */
/** Riga che inizia con un'etichetta e ha più prezzi («piccola 3 grande 5»): manca il nome, va sotto la riga prima. */
export function namelessVariants(row) {
  const tags = labels(row);
  if (!tags.length || tags[0].start > 1) return null;
  const parsed = labeledVariants(`Xyzw ${row}`);
  return parsed && parsed.name === 'Xyzw' ? parsed.variants : null;
}
export function labelOnlyRow(row) {
  const prices = amounts(row), tags = labels(row);
  if (prices.length !== 1 || tags.length !== 1) return null;
  if (!glue(row.replace(tags[0].raw, ' ').replace(row.slice(prices[0].start, prices[0].end), ' '))) return null;
  return positive(prices[0].amount) ? { label: tags[0].label, amount: prices[0].amount } : null;
}

/** Intestazione di colonne: «calice  bottiglia» oppure «VINI BIANCHI   calice   bottiglia». */
export function columnsHeader(row) {
  if (amounts(row).length) return null;
  const tags = labels(row);
  if (tags.length < 2) return null;
  const head = row.slice(0, tags[0].start).replace(/[\s—–\-:|,(]+$/, '').trim();
  if (!glue(row.slice(tags[0].start).replace(LABEL_ANY, ' '))) return null;
  return { title: head, columns: tags.map((t) => t.label) };
}

/** «Ribolla (calice) — 5» seguito da «Ribolla (bottiglia) — 28»: etichetta in fondo al nome. */
export function labelSuffix(name) {
  const m = String(name).match(/^(.{3,}?)\s*[([]?\s*([^()[\]]{3,30}?)\s*[)\]]?$/);
  if (!m) return null;
  const tags = labels(m[2]);
  if (tags.length !== 1 || !glue(m[2].replace(tags[0].raw, ' '))) return null;
  return /[A-Za-zÀ-ÿ]{3}/.test(m[1]) ? { base: m[1].replace(/[\s—–\-:,]+$/, '').trim(), label: tags[0].label } : null;
}

// Percorsi degustazione.
const DEGU = /\b(?:menu|menù|percorso|percorsi|itinerario|viaggio)\b[^.!?]{0,40}\b(?:degustazion\w*|territorio|sorpresa|chef|tradizion\w*|stagion\w*|mare|terra|fiducia|carta bianca)\b|\bdegustazion\w*\b|\btasting(?: menu)?\b/i;
const DEGU_STOP = /\b(?:abbiamo|vorremmo|vorrei|offriamo|proponiamo|facciamo|anche|inoltre|piacerebbe|serve|ci sono|c'è|ce)\b/i;
const UNIT = /\b(?:a|per)\s+(?:persona|pers\.?|testa|coperto)\b|\b(?:vini|bevande|bevanda|acqua|caff[eè]|coperto)\s+(?:esclus[ie]|inclus[ie]|compres[ie]|a parte)\b|\b(?:minimo|min\.?|almeno)\s+\d+\s+persone\b|\bper tutto il tavolo\b|\bsolo per (?:l'intero|tutto il) tavolo\b/gi;
export function degustazioneHeading(row) {
  const text = row.replace(/^#{1,3}\s*|^\[|\]$/g, '').trim();
  if (!DEGU.test(text) || DEGU_STOP.test(text) || text.length > 90 || text.split(/\s+/).length > 14 || /[?!]/.test(text)) return null;
  const prices = amounts(text);
  const unit = [...text.matchAll(UNIT)].map((m) => m[0].toLowerCase());
  let name = text;
  if (prices.length) name = text.slice(0, prices[0].start);
  for (const u of unit) name = name.replace(new RegExp(u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' ');
  name = name.replace(/\b(?:prezzo|costo)\b/gi, ' ').replace(/[\s—–\-:|,(]+$/, '').replace(/\s{2,}/g, ' ').trim();
  if (!/[A-Za-zÀ-ÿ]{3}/.test(name)) return null;
  return { name, amount: prices.length === 1 ? prices[0].amount : null, unit: unit.join(', '), ambiguous: prices.length > 1 };
}
/** Riga del prezzo del percorso: «55 € a persona», «Prezzo: 55 euro, vini esclusi», «€ 55». */
export function degustazionePrice(row) {
  const prices = amounts(row);
  if (prices.length !== 1) return null;
  const unit = [...row.matchAll(UNIT)].map((m) => m[0].toLowerCase());
  let rest = row.replace(row.slice(prices[0].start, prices[0].end), ' ');
  for (const u of unit) rest = rest.replace(new RegExp(u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' ');
  rest = rest.replace(/\b(?:prezzo|costo|totale|del percorso|del menu|menu)\b/gi, ' ');
  if (!glue(rest)) return null;
  if (!unit.length && !prices[0].currency && !/prezzo|costo/i.test(row)) return null;
  return positive(prices[0].amount) ? { amount: prices[0].amount, unit: unit.join(', ') } : null;
}
/** Riga senza prezzo dentro il percorso che è una regola o una nota, non una portata. */
export function degustazioneNote(row) {
  const text = row.replace(/^>\s*/, '').trim();
  if (amounts(text).some((a) => a.currency) || text.length > 200) return null;
  const rule = /\b(?:per tutto il tavolo|intero tavolo|tutti i commensali|minimo\s+\d+\s+persone|almeno\s+\d+\s+persone|bevande\s+(?:escluse|incluse)|vini\s+(?:esclusi|inclusi)|acqua e caff[eè]|su prenotazione|prenotazione obbligatoria|si prenota|da prenotare|prenotabile|non\s+(?:è\s+)?disponibil[ei]|non\s+per\s+tavoli|non\s+si\s+(?:serve|fa|effettua)|entro le\s+\d{1,2})\b/i;
  const sentence = /\.$/.test(text) && text.split(/\s+/).length >= 5 && /\b(?:è|sono|viene|vengono|servit\w*|può|possono|richiede|prevede)\b/i.test(text);
  return rule.test(text) || sentence ? text : null;
}
/** «Abbinamento vini 25 €», «con abbinamento calici +25»: supplemento del percorso. */
export function pairingRow(row) {
  if (!/\babbinament\w*|\bcalici in abbinamento|\bwine pairing\b/i.test(row)) return null;
  const prices = amounts(row);
  if (prices.length !== 1) return null;
  const name = row.slice(0, prices[0].start).replace(/^\s*con\s+/i, '').replace(/[\s—–\-:|,(+]+$/, '').trim();
  return /[A-Za-zÀ-ÿ]{3}/.test(name) && positive(prices[0].amount) ? { name: name.charAt(0).toUpperCase() + name.slice(1), amount: prices[0].amount } : null;
}

// Descrizione sotto il piatto: riga senza prezzo, subito dopo, scritta come una descrizione.
const DESC_START = /^(?:>\s*|con\b|al\b|allo\b|alla\b|alle\b|ai\b|agli\b|all'|in\b|su\b|e\b|di\b|del\b|della\b|dei\b|delle\b|servit\w*|accompagnat\w*|ripien\w*|crema\b|salsa\b|fondo\b|emulsion\w*|cotto\b|cotta\b|marinat\w*|affumicat\w*|tartare\b|battuta\b)/i;
const WINE_DESC = /\b(?:doc|docg|igt|igp|aoc|annata|vitign\w*|uve|uvaggio|barrique|acciaio|affinat\w*|sur lie|metodo|brut|extra dry|dosaggio)\b/i;
const PROSE = /\b(?:buongiorno|buonasera|salve|ciao|grazie|cordiali|saluti|vorremmo|vorrei|potete|potreste|ci serve|ci piacerebbe|allego|allegato|in allegato|vi mando|vi invio|il nostro locale|siamo)\b/i;
export function descriptionLike(row, { wine = false } = {}) {
  const text = row.trim();
  if (text.length < 3 || text.length > 260 || PROSE.test(text) || /[?]$/.test(text) || /^#/.test(text)) return null;
  const letters = text.replace(/[^A-Za-zÀ-ÿ]/g, '');
  const shouting = letters.length >= 12 && letters === letters.toUpperCase() && /[,]|\b(?:CON|E|AL|ALLA|DI)\b/.test(text);
  if (DESC_START.test(text) || /^[a-zà-ÿ]/.test(text) || shouting || (wine && (WINE_DESC.test(text) || /,/.test(text)))) return text.replace(/^>\s*/, '').trim();
  return null;
}
/** Numeri di allergeni scritti dal locale in fondo alla descrizione: «(7-8-12)», «(1, 7)». */
export function allergenNumbers(text) {
  const m = String(text).match(/\((\d{1,2}(?:\s*[-,/]\s*\d{1,2})*)\)\s*\.?$/);
  if (!m) return null;
  const list = m[1].split(/\s*[-,/]\s*/).map(Number);
  return list.every((n) => n >= 1 && n <= 14) ? list : null;
}

/* ——— Righe scritte a parole dai clienti (email del 9 ottobre 2026, Osteria Ponte Vecchio) ——— */

/** Osservazioni del cliente dentro il nome, non parte del nome: «(nome inventato)», «(esempio)», «(prova)». */
const META_REMARK = /\s*\(\s*(?:nome|dato|prezzo|vino|piatto)?\s*(?:inventat\w*|fittizi\w*|di prova|d['’]esempio|esempio|di test|test|prova)\s*\)/gi;
export function cleanMeta(name) {
  const text = String(name || '');
  const cleaned = text.replace(META_REMARK, '').replace(/\s{2,}/g, ' ').trim();
  return { name: cleaned, removed: cleaned !== text.trim() ? text.match(META_REMARK)?.[0].trim() || '' : '' };
}

/** «Risotto … (solo in primavera)»: la disponibilità scritta dal cliente non è il nome del piatto, diventa la descrizione. */
const AVAILABILITY = /\s*[(\[]\s*((?:solo|soltanto)\s+(?:in|a|di|d['’]|nei|nel|il|la|le)\s*[^()[\]]{2,40}|stagionale|di stagione|su (?:richiesta|ordinazione|prenotazione)|fino a esaurimento)\s*[)\]]\s*$/i;
export function splitAvailability(name) {
  const m = String(name || '').match(AVAILABILITY);
  if (!m) return { name: String(name || '').trim(), availability: '' };
  const text = m[1].trim();
  return { name: String(name).slice(0, m.index).trim(), availability: text.charAt(0).toUpperCase() + text.slice(1) };
}

/** «Cappesante…: prezzo da decidere, circa 18-19 €»: il prezzo NON c'è. Mai scegliere un numero dell'intervallo. */
const TO_DECIDE = /^(.{2,150}?)\s*(?:[—–\-:]\s*)?\(?\s*(?:il\s+)?(?:prezzo\s+)?(?:ancora\s+)?(?:da\s+(?:decidere|definire|stabilire|confermare|concordare|vedere)|non\s+(?:ancora\s+)?(?:deciso|definito|stabilito)|tbd|n\.?\s?d\.?)\s*(?:[,;(]\s*(?:circa|più o meno|intorno a|sui|sugli|tra|forse|probabilmente)?\s*([^)]*?))?\s*\)?\.?$/i;
export function undecidedPrice(row) {
  const m = String(row || '').match(TO_DECIDE);
  if (!m || !/[A-Za-zÀ-ÿ]{3}/.test(m[1]) || /\d{1,3}\s*(?:€|euro)\s*$/.test(m[1].trim())) return null;
  const hint = (m[2] || '').replace(/^[\s,;:]+|[\s,;:.]+$/g, '').trim();
  return { name: m[1].replace(/[\s—–\-:,]+$/, '').trim(), hint };
}

/** «Branzino…: prezzo al mercato, cambia ogni giorno»: prezzo variabile, scritto dal cliente. */
const MARKET = /^(.{2,150}?)\s*[—–\-:,]\s*\(?\s*(?:il\s+)?(?:prezzo\s+)?(?:al\s+mercato|di\s+mercato|secondo\s+(?:il\s+)?mercato|variabile|stagionale|a\s+seconda\s+(?:del\s+)?(?:mercato|pescato)|secondo\s+(?:il\s+)?pescato|secondo\s+disponibilit[àa]|chiedere\s+(?:al\s+)?(?:cameriere|personale|staff|banco)|chiedi\s+(?:al\s+)?(?:cameriere|personale)|su\s+richiesta)(?:\s*[,;]\s*(?:cambia|varia|dipende|che\s+cambia)[^()]{0,60})?\s*\)?\.?$/i;
export function marketPrice(row) {
  const m = String(row || '').match(MARKET);
  if (!m || !/[A-Za-zÀ-ÿ]{3}/.test(m[1]) || /\d/.test(m[1].replace(/\b(?:19|20)\d{2}\b/g, ''))) return null;
  const why = /pescato/i.test(row) ? 'Prezzo variabile secondo il pescato del giorno' : /chiedere|chiedi|richiesta|disponibil/i.test(row) ? 'Prezzo da chiedere al personale' : 'Prezzo secondo il mercato del giorno';
  // Le parole della titolare, se dicono chiaramente che il prezzo varia: «Prezzo al mercato, cambia ogni giorno».
  const said = String(row).slice(String(row).indexOf(m[1]) + m[1].length).replace(/^\s*[—–\-:,]\s*\(?\s*/, '').replace(/[)\s.]+$/, '').replace(/^(?:il\s+)?prezzo\s+/i, '').trim();
  const verbatim = /^(?:al\s+mercato|di\s+mercato|secondo\s+(?:il\s+)?(?:mercato|pescato)|variabile|a\s+seconda\s+(?:del\s+)?(?:mercato|pescato))/i.test(said) && said.length <= 90 && !/\d/.test(said);
  const note = verbatim ? `Prezzo ${said}` : why;
  return { name: m[1].replace(/[\s—–\-:,]+$/, '').trim(), note };
}

/** Percorso con più formule: «5 portate: 65 € a persona (85 € con abbinamento di 4 calici)».
 *  Ogni formula è una voce con i suoi prezzi (etichetta = come scritto dal cliente). */
export function tastingTier(row) {
  const text = String(row || '').trim().replace(/^>\s*/, '');
  const head = text.match(/^((?:\d{1,2}|[a-zà-ÿ]+)\s+(?:portate|portata|tempi|piatti|assaggi|calici)(?:\s+[a-zà-ÿ]+){0,2})\s*[:\-–—]\s*(.+)$/i);
  if (!head) return null;
  const rest = head[2];
  const prices = amounts(rest).filter((p) => p.currency);
  if (!prices.length || prices.some((p) => !positive(p.amount))) return null;
  const variants = [];
  for (let i = 0; i < prices.length; i += 1) {
    const after = rest.slice(prices[i].end, prices[i + 1]?.start ?? rest.length)
      .replace(/^[\s,;(]+|[\s,;()]+$/g, '').replace(/\s*\($/, '').trim();
    let label = after.replace(/^\(|\)$/g, '').trim();
    if (!label || /^(?:a|per)\s+(?:persona|testa)$/i.test(label)) label = 'A persona';
    else if (/^(?:a|per)\s+persona\b/i.test(label)) label = label.replace(/^(?:a|per)\s+persona[\s,;]*/i, '').trim() || 'A persona';
    label = label.charAt(0).toUpperCase() + label.slice(1);
    if (label.length > 60 || variants.some((v) => v.label === label)) return null;
    variants.push({ label, amount: prices[i].amount });
  }
  // Prima del primo prezzo ci devono essere solo i due punti: niente testo in mezzo che il nome non spiega.
  if (rest.slice(0, prices[0].start).replace(/[\s€:]/g, '')) return null;
  const name = head[1].trim().replace(/^./, (c) => c.toUpperCase());
  return { name, variants };
}

/** Titolo di pagina senza piatti sotto: «Carta dei vini (la struttura è questa)». Apre le sezioni dopo, non è una voce. */
export const PAGE_TITLE = /^(?:la\s+)?carta\s+(?:dei|delle|del|degli)\s+[a-zà-ÿ]+(?:\s*\([^)]*\))?\s*:?$/i;

/** Frase del cliente, non una voce: mai un piatto, un percorso o una descrizione. */
export function proseLike(row) {
  const text = String(row || '').trim();
  if (text.length < 25) return false;
  const words = text.split(/\s+/).length;
  const verb = /\b(?:è|sono|siamo|abbiamo|vorremmo|vorrei|vogliamo|possiamo|dovrei|posso|puoi|potete|vi|ci|mi|mando|allego|scrivo|chiedere|sapere|decidere|pagano|pagare|compreso|compresa|inclus[oa]|escluso|esclusa)\b/i;
  return words >= 6 && verb.test(text) && (/[.?!]$/.test(text) || words >= 9);
}

import { premiumErrors } from './premium.js';
import { WINE_SECTION, allergenNumbers, degustazioneNote, namelessVariants, columnsHeader, degustazioneHeading, degustazionePrice, descriptionLike, fmt, labelOnlyRow, labelSuffix, labeledVariants, pairingRow, unlabeledVariants } from './menu-structure.js';
// Independent server-side rules. scripts/validate-menus.py remains the publication authority.
const PRICE = /^\d+(?:[,.]\d{1,2})?$/;
const TAGS = new Set(['veg', 'vegan', 'spicy', 'gf', 'new', 'top', 'frozen']);
const LEGACY = new Set(['hot', 'riserva']);
const LANGS = new Set(['it', 'en', 'de', 'fr', 'es']);
const PUBLIC_ROOT = new Set(['id', 'nome', 'sottotitolo', 'indirizzo', 'telefono', 'instagram', 'facebook', 'maps', 'orari', 'wifi', 'avviso', 'coperto', 'note', 'tema', 'premium', 'sezioni', 'lingue', 'url', 'sito', 'website']);
const PUBLIC_SECTION = new Set(['nome', 'descrizione', 'voci', 'tipo', 'prezzo', 'unita']);
const PUBLIC_ITEM = new Set(['nome', 'descrizione', 'prezzo', 'prezzi', 'allergeni', 'tag', 'foto', 'scheda']);
// Foto e scheda (sommelier o piatto) dei menu su misura: stesse regole di scripts/validate-menus.py.
const ITEM_IMAGE = /^(?:\.\.\/|\/)?[a-z0-9_./-]+\.(?:webp|png|jpe?g|svg|avif)$/i;
const SCHEDA_TEXT = new Set(['cantina', 'territorio', 'vitigno', 'annata', 'gradazione', 'temperatura', 'affinamento', 'colore', 'profumo', 'gusto', 'abbinamenti', 'nota']);
const SCHEDA_PROFILE = new Set(['aromi', 'struttura', 'acidita', 'dolcezza', 'corpo']);
const filledText = (v) => (typeof v === 'string' ? Boolean(v.trim()) : Boolean(v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).some((s) => typeof s === 'string' && s.trim())));
export function itemExtrasErrors(item, path) {
  const errors = [];
  if ('foto' in item && !(typeof item.foto === 'string' && (item.foto.startsWith('https://') || ITEM_IMAGE.test(item.foto)))) errors.push(`${path}.foto: serve un indirizzo https o un file immagine del sito.`);
  if (!('scheda' in item)) return errors;
  const sheet = item.scheda;
  if (!sheet || typeof sheet !== 'object' || Array.isArray(sheet)) return [...errors, `${path}.scheda: deve essere un oggetto.`];
  for (const [key, val] of Object.entries(sheet)) {
    if (key === 'profilo') {
      if (!val || typeof val !== 'object' || Array.isArray(val)) { errors.push(`${path}.scheda.profilo: deve essere un oggetto.`); continue; }
      for (const [pk, pv] of Object.entries(val)) if (!SCHEDA_PROFILE.has(pk) || !Number.isInteger(pv) || pv < 0 || pv > 100) errors.push(`${path}.scheda.profilo.${pk}: valore intero da 0 a 100.`);
    } else if (!SCHEDA_TEXT.has(key)) errors.push(`${path}.scheda: campo «${key}» non previsto.`);
    else if (!filledText(val)) errors.push(`${path}.scheda.${key}: testo vuoto.`);
  }
  return errors;
}
const text = (value) => typeof value === 'string' ? value.trim() : value && typeof value === 'object' && !Array.isArray(value) ? Object.values(value).some((item) => typeof item === 'string' && item.trim()) : false;
const localized = (value, lang) => value && typeof value === 'object' && typeof value[lang] === 'string' && value[lang].trim();
export const slugify = (value) => String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);

export function validateMenu(menu) {
  const errors = [], warnings = [];
  if (!menu || typeof menu !== 'object' || Array.isArray(menu)) return { errors: ['Radice JSON non valida.'], warnings };
  const allowed = (value, keys, path) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const key of Object.keys(value)) if (!keys.has(key)) errors.push(`${path}.${key}: campo non pubblico non ammesso nel menù.`);
  };
  const publicText = (value, path) => {
    if (typeof value === 'string') return;
    if (!value || typeof value !== 'object' || Array.isArray(value)) { errors.push(`${path}: serve testo o traduzioni ISO.`); return; }
    for (const [key, entry] of Object.entries(value)) {
      if (!/^[a-z]{2}$/.test(key) || typeof entry !== 'string') errors.push(`${path}.${key}: solo testi localizzati per lingua ISO, non metadati editoriali.`);
    }
  };
  allowed(menu, PUBLIC_ROOT, 'menu');
  for (const key of ['nome', 'sottotitolo', 'orari', 'avviso', 'note']) if (key in menu) publicText(menu[key], `menu.${key}`);
  if ('premium' in menu) errors.push(...premiumErrors(menu.premium));
  if ('tema' in menu && !['bordeaux', 'trattoria', 'mare', 'terracotta', 'notte', 'sole'].includes(menu.tema)) errors.push('menu.tema: usa bordeaux, trattoria, mare, terracotta, notte o sole.');
  for (const key of ['indirizzo', 'telefono', 'instagram', 'facebook', 'maps', 'wifi', 'coperto', 'url', 'sito', 'website'])
    if (key in menu && typeof menu[key] !== 'string') errors.push(`menu.${key}: serve testo pubblico, non un oggetto tecnico.`);
  for (const [si, section] of (Array.isArray(menu.sezioni) ? menu.sezioni : []).entries()) {
    allowed(section, PUBLIC_SECTION, `sezioni.${si}`);
    if (section && typeof section === 'object' && !Array.isArray(section)) {
      for (const key of ['nome', 'descrizione']) if (key in section) publicText(section[key], `sezioni.${si}.${key}`);
      for (const [vi, item] of (Array.isArray(section.voci) ? section.voci : []).entries()) {
        allowed(item, PUBLIC_ITEM, `sezioni.${si}.voci.${vi}`);
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          for (const key of ['nome', 'descrizione']) if (key in item) publicText(item[key], `sezioni.${si}.voci.${vi}.${key}`);
          errors.push(...itemExtrasErrors(item, `sezioni.${si}.voci.${vi}`));
        }
      }
    }
  }
  const inspect = (value, path = 'menu', depth = 0) => {
    if (typeof value === 'string' && /(?:private\/requests\/|r2:\/\/|BEGIN\s+PRIVATE\s+KEY|Bearer\s+\S+)/i.test(value))
      errors.push(`${path}: riferimento privato o credenziale non ammessa nel JSON pubblico.`);
    if (depth > 12 || !value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (/^(?:api[_-]?key|token|secret|password|private[_-]?key|authorization|access[_-]?token)$/i.test(key))
        errors.push(`${path}.${key}: campo tecnico o segreto vietato nel menù pubblico.`);
      inspect(item, `${path}.${key}`, depth + 1);
    }
  };
  inspect(menu);
  if (!text(menu.nome)) errors.push('Nome del locale mancante.');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(menu.id || '')) errors.push('Identificativo menu non valido.');
  const langs = menu.lingue === undefined ? [] : menu.lingue;
  if (!Array.isArray(langs) || (menu.lingue !== undefined && !langs.length)) errors.push('Lingue: serve un elenco valido.');
  const seenLangs = new Set();
  for (const lang of Array.isArray(langs) ? langs : []) {
    if (typeof lang !== 'string' || !/^[a-z]{2}$/.test(lang)) errors.push(`Lingua non valida: ${lang}.`);
    else if (seenLangs.has(lang)) errors.push(`Lingua duplicata: ${lang}.`);
    else { seenLangs.add(lang); if (!LANGS.has(lang)) warnings.push(`Lingua ${lang}: visualizzatore con fallback italiano.`); }
  }
  if (!Array.isArray(menu.sezioni) || !menu.sezioni.length) errors.push('Serve almeno una sezione non vuota.');
  const essential = [['Locale', menu.nome]];
  for (const [si, section] of (Array.isArray(menu.sezioni) ? menu.sezioni : []).entries()) {
    const sl = `Sezione ${si + 1}`;
    if (!section || typeof section !== 'object' || Array.isArray(section)) { errors.push(`${sl} non valida.`); continue; }
    if (!text(section.nome)) errors.push(`${sl}: nome mancante.`);
    else essential.push([sl, section.nome]);
    if ('tipo' in section && section.tipo !== 'degustazione') errors.push(`${sl}: tipo non supportato (consentito: degustazione).`);
    if ('prezzo' in section && !(typeof section.prezzo === 'number' ? section.prezzo > 0 : typeof section.prezzo === 'string' && PRICE.test(section.prezzo.trim()))) errors.push(`${sl}: prezzo della sezione non valido.`);
    if (!Array.isArray(section.voci) || !section.voci.length) { errors.push(`${sl}: nessun piatto.`); continue; }
    for (const [vi, item] of section.voci.entries()) {
      const label = `${sl}, voce ${vi + 1}`;
      if (!item || typeof item !== 'object' || Array.isArray(item)) { errors.push(`${label}: voce non valida.`); continue; }
      if (!text(item.nome)) errors.push(`${label}: nome mancante.`);
      else essential.push([label, item.nome]);
      const badPrice = (p) => typeof p === 'boolean' || (typeof p === 'number' && (!Number.isFinite(p) || p <= 0)) ||
        (typeof p !== 'number' && (typeof p !== 'string' || !PRICE.test(p.trim()) || Number(p.replace(',', '.')) <= 0));
      const variants = 'prezzi' in item;
      if (variants) {
        if (!Array.isArray(item.prezzi) || !item.prezzi.length) errors.push(`${label}: prezzi deve essere una lista di varianti.`);
        else for (const [pi, v] of item.prezzi.entries()) {
          if (!v || typeof v !== 'object' || Array.isArray(v) || !text(v.etichetta)) errors.push(`${label}, variante ${pi + 1}: etichetta mancante (es. calice, bottiglia).`);
          else if (badPrice(v.prezzo)) errors.push(`${label}, variante ${pi + 1}: prezzo non valido.`);
        }
      }
      if ('prezzo' in item) {
        const p = item.prezzo;
        if (p === '') warnings.push(`${label}: prezzo assente; verificare la fonte.`);
        else if (typeof p === 'boolean' || (typeof p === 'number' && (!Number.isFinite(p) || p <= 0)) ||
          (typeof p !== 'number' && (typeof p !== 'string' || !PRICE.test(p.trim()) || Number(p.replace(',', '.')) <= 0))) errors.push(`${label}: prezzo non valido.`);
      } else if (!variants && section.tipo !== 'degustazione') warnings.push(`${label}: prezzo non presente nella fonte.`);
      if ('allergeni' in item) {
        if (!Array.isArray(item.allergeni) || item.allergeni.some((a) => typeof a === 'boolean' || !/^(?:[1-9]|1[0-4])$/.test(String(a)))) errors.push(`${label}: allergeni fuori dall'intervallo 1–14.`);
        else if (new Set(item.allergeni.map(String)).size !== item.allergeni.length) warnings.push(`${label}: allergeni duplicati.`);
      } else warnings.push(`${label}: allergeni non confermati dal locale.`);
      if ('tag' in item) {
        if (!Array.isArray(item.tag)) errors.push(`${label}: tag non è una lista.`);
        else for (const tag of item.tag) {
          if (LEGACY.has(tag)) warnings.push(`${label}: tag legacy ${tag}.`);
          else if (!TAGS.has(tag)) errors.push(`${label}: tag non supportato ${tag}.`);
        }
      }
    }
  }
  for (const lang of Array.isArray(langs) ? langs.filter((lang) => typeof lang === 'string') : []) {
    if (!essential.some(([, value]) => localized(value, lang))) errors.push(`Lingua ${lang} dichiarata ma assente nei contenuti essenziali.`);
    for (const [label, value] of essential) if (typeof value === 'object' && !localized(value, lang))
      (lang === langs[0] ? errors : warnings).push(`${label}: traduzione ${lang} mancante.`);
  }
  if (menu.telefono != null && menu.telefono !== '' && (typeof menu.telefono !== 'string' ||
    menu.telefono.replace(/\D/g, '').length < 6 || menu.telefono.replace(/\D/g, '').length > 15)) warnings.push('telefono: formato da verificare.');
  if (menu.instagram != null && menu.instagram !== '' && (typeof menu.instagram !== 'string' ||
    !/^@?[A-Za-z0-9._]{1,30}$/.test(menu.instagram))) warnings.push('instagram: indicare solo l’handle, non un URL.');
  for (const key of ['maps', 'url', 'sito', 'website']) if (menu[key] && (typeof menu[key] !== 'string' ||
    !/^https?:\/\/[^\s/]+/i.test(menu[key]))) warnings.push(`${key}: URL sospetto.`);
  return { errors, warnings };
}

// Riga esplicita "Locale: …" / "Ristorante: …" a inizio riga. Non deduce nomi dalla prosa.
export const VENUE_LINE = /^(?:locale|ristorante)\s*:\s*(.{2,140}?)\s*$/i;
// Come scrivono davvero i clienti: "Nome del locale: X", "Pizzeria: X", "Il locale si chiama X",
// "Il nome del ristorante è X". Solo righe dedicate o frasi esplicite: mai un nome dedotto.
const VENUE_KIND = '(?:locale|ristorante|pizzeria|trattoria|osteria|agriturismo|bar|caff[eè]|pub|bistrot|attivit[aà])';
const VENUE_LABEL = new RegExp(`^(?:(?:il\\s+)?nome\\s+(?:del(?:l['’])?\\s*|della\\s+|dell['’]\\s*)?)?(?:nostr[oa]\\s+)?${VENUE_KIND}\\s*[:–—]\\s*(.{2,140}?)\\s*$`, 'i');
const VENUE_SENTENCE = new RegExp(`(?:^|[.!;,]\\s*)(?:il\\s+|la\\s+)?(?:(?:nome\\s+(?:del(?:l['’])?\\s*|della\\s+)?(?:nostr[oa]\\s+)?${VENUE_KIND}\\s+(?:[eè]|sar[aà])\\s*:?)|(?:(?:nostr[oa]\\s+)?${VENUE_KIND}\\s+si\\s+chiama))\\s+[«"“]?([^«»"“”.!?;\\n]{2,80}?)[»"”]?\\s*(?:[.!?;]|$)`, 'i');
const VENUE_QUOTED = new RegExp(`${VENUE_KIND}\\s+(?:si\\s+chiama|[eè])\\s+[«"“]([^«»"“”\\n]{2,80})[»"”]`, 'i');
const venueOk = (value) => /\p{L}/u.test(value) && !/\d{1,4}(?:[,.]\d{1,2})?\s*€?$/.test(value);
export function venueFromSource(source) {
  const rows = String(source || '').split(/\r?\n/).map((line) => line.trim().replace(/^[-•*]\s*/, ''));
  for (const line of rows) {
    const match = line.match(VENUE_LINE) || line.match(VENUE_LABEL);
    if (match && venueOk(match[1])) return match[1].trim().replace(/[.!;,]+$/, '').replace(/^[«"“]|[»"”]$/g, '').trim();
  }
  for (const line of rows) {
    const quoted = line.match(VENUE_QUOTED);
    if (quoted && venueOk(quoted[1])) return quoted[1].trim();
    const match = line.match(VENUE_SENTENCE);
    if (match && venueOk(match[1])) return match[1].trim();
  }
  // «sono Marta, titolare dell'Enoteca Isonzo Test (…) a Gorizia»: il nome come scritto, con le maiuscole.
  // Le email di Gmail vanno a capo da sole: le righe spezzate si riuniscono prima di cercare.
  const prose = String(source || '').replace(/\r/g, '').replace(/([^\n.!?:;])\n(?=[a-zà-ÿ(])/g, '$1 ');
  const owner = prose.match(new RegExp(`\\b(?:titolar[ei]|proprietari[oa]|gestor[ei]|responsabile|chef)\\s+(?:(?:del|dello|della)\\s+|dell['’]\\s*)(${VENUE_WORDS})\\s+([^\\n]{2,120})`, 'iu'));
  if (owner) {
    // Dopo il tipo di locale: un articolo/preposizione («da Mario», «al Ponte») poi solo parole con la maiuscola.
    const words = owner[2].split(/\s+/), kept = [];
    for (const [k, w] of words.entries()) {
      const clean = w.replace(/[,.;:!?)]+$/, '');
      if (!clean || /^\(/.test(clean)) break;
      if (/^[A-ZÀ-Ý0-9]/.test(clean)) { kept.push(clean); if (clean !== w) break; continue; }
      if (k === 0 && /^(?:da|dal|dalla|al|alla|ai|alle|del|della|dei|di|la|il|lo|le|i)$/.test(clean) && /^[A-ZÀ-Ý]/.test(words[1] || '')) { kept.push(clean); continue; }
      break;
    }
    const kind = owner[1].charAt(0).toUpperCase() + owner[1].slice(1);
    const name = `${kind} ${kept.join(' ')}`.trim();
    if (kept.some((w) => /^[A-ZÀ-Ý0-9]/.test(w)) && venueOk(name)) return name;
  }
  // Oggetto «Nuovo menu Premium · Enoteca Isonzo Test (TEST)»: il nome dopo l'ultimo «·», se ha le maiuscole.
  const subject = rows.find((line) => /^oggetto(?: ricevuto)?\s*:/i.test(line));
  const tail = subject && subject.split(/\s[·|–—-]\s/).slice(1).at(-1);
  const named = tail && tail.replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (named && /^[A-ZÀ-Ý]/.test(named) && named.length <= 60 && venueOk(named) && !/\b(?:menu|menù|richiesta|abbonamento|premium|standard|annuale|nuovo|aggiornamento|prezzi)\b/i.test(named)) return named;
  return '';
}
const VENUE_WORDS = "ristorante|trattoria|osteria|pizzeria|enoteca|locanda|agriturismo|bar|caff[eè]|pub|bistrot|birreria|braceria|gelateria|pasticceria|cantina|wine bar|frasca|hotel|albergo|taverna|hosteria|steakhouse|sushi|paninoteca|piadineria|rosticceria|lounge|cocktail bar";

// Titolo di sezione senza "#" (come scrivono i clienti veri: "Antipasti", "PRIMI", "Dolci:").
// Regola fissa: riga breve, senza prezzo né punteggiatura da frase, non un saluto/frase,
// e la riga non vuota successiva deve essere un piatto con prezzo.
const PRICE_ROW = /^(.{2,150}?)\s*(?:[—–\-:\t]|\.{2,})\s*(?:€\s*)?(\d{1,4}(?:[,.]\d{1,2})?)\s*€?$/;
// Formato libero "Fritto misto 10", "Fritto misto 10€", "Fritto misto € 10,50", "… 10 euro":
// prezzo in fondo alla riga separato solo da uno spazio. Valori sotto 1 senza simbolo di valuta
// (es. "Birra 0,4") sono quasi sempre quantità, non prezzi: restano da verificare.
const LOOSE_ROW = /^(.{2,150}?[A-Za-zÀ-ÿ)'’.])\s+(€\s*)?(\d{1,4}(?:[,.]\d{1,2})?)\s*(€|euro|eur)?\.?$/i;
// Frasi ("la margherita costa 7", "il fritto lo facciamo a 12"): non sono nomi di piatti.
// Restano alla lettura assistita, che prende solo nome e prezzo presenti nella riga.
const LOOSE_STOP = /\b(?:costa|costano|costerebbe|viene|vengono|invece|scusa|prezzo|prezzi|facciamo|mettiamo|vendiamo|euro|eur|lo|la|le|li|gli|il)$|\b(?:costa|costano|viene|vengono|invece|scusa|prezzo|facciamo|mettiamo|vendiamo|euro|eur|(?:alle|dalle|ore)\s*\d|apriamo|chiudiamo|aperti|chiusi|orario|orari|tel|telefono|cell|via|piazza|numero|tavoli|posti|persone)\b|€|,\s|\s(?:a|al|da)$/i;
// Prezzi particolari scritti dal cliente: «18 € a persona (minimo 2 persone)» e «prezzo secondo pescato».
// Il valore resta quello scritto; la condizione diventa una nota visibile sotto il piatto.
const PER_PERSON = /^(.{2,150}?)\s*[—–\-:]?\s*(?:€\s*)?(\d{1,4}(?:[,.]\d{1,2})?)\s*(?:€|euro|eur)\s*(?:a|per|\/)\s*(?:persona|pers\.?|testa)\.?$/i;
const MIN_PEOPLE = /\s*\(?\s*(?:min(?:imo|\.)?|almeno)\s*(\d+|due|tre|quattro|cinque|sei)\s*(?:persone|pers\.?|porzioni)\s*\)?/i;
const VARIABLE = /^(.{2,150}?)\s*[—–\-:,]?\s*\(?\s*(?:(?:prezzo\s+)?(?:secondo(?: il| la)?|in base al(?:la)?|a seconda del(?:la)?)\s+(pescato|mercato|peso|disponibilit\w*|stagione|grammatura)(?:\s+del giorno)?|(?:prezzo\s+)?(variabile|da definire|a peso|al kg|al chilo|all'etto)|(s\.\s?q\.?))\s*\)?\.?$/i;
const NUMBER_WORDS = { due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6 };
export function specialPriceRow(row) {
  if (row.startsWith('[da verificare]') || /^(?:coperto|servizio)\b/i.test(row)) return null;
  const person = row.match(PER_PERSON);
  // «Abbiamo anche un percorso da 55 euro a persona»: una frase, non un piatto.
  if (person && /\b(?:abbiamo|offriamo|proponiamo|facciamo|anche|nostro|nostra|vorremmo)\b/i.test(person[1])) return null;
  if (person && /[A-Za-zÀ-ÿ]{3}/.test(person[1])) {
    const min = person[1].match(MIN_PEOPLE) || row.match(MIN_PEOPLE);
    const name = person[1].replace(MIN_PEOPLE, ' ').replace(/\s{2,}/g, ' ').replace(/\s*[—–\-:,]\s*$/, '').trim();
    const people = min ? (NUMBER_WORDS[min[1].toLowerCase()] || Number(min[1])) : null;
    return { kind: 'a_persona', name, amount: person[2], note: people ? `Prezzo a persona, minimo ${people} persone` : 'Prezzo a persona', people };
  }
  const variable = row.match(VARIABLE);
  if (variable && /[A-Za-zÀ-ÿ]{3}/.test(variable[1]) && !/\d/.test(variable[1])) {
    const why = (variable[2] || variable[3] || variable[4] || '').toLowerCase();
    const note = why === 'pescato' ? 'Prezzo variabile secondo il pescato del giorno'
      : why === 'mercato' ? 'Prezzo secondo il mercato del giorno'
        : /peso|kg|chilo|etto|grammatura/.test(why) ? 'Prezzo a peso, chiedere al personale'
          : 'Prezzo variabile, chiedere al personale';
    return { kind: 'variabile', name: variable[1].replace(/\s*(?:prezzo)\s*$/i, '').trim(), note };
  }
  return null;
}
export function priceRow(row) {
  if (row.startsWith('[da verificare]')) return null; // righe dubbie delle foto: mai un prezzo
  const strict = row.match(PRICE_ROW);
  if (strict) return { name: strict[1].trim(), amount: strict[2], loose: false };
  const loose = row.match(LOOSE_ROW);
  if (!loose || !/[A-Za-zÀ-ÿ]{2}/.test(loose[1]) || SENTENCE_WORDS.test(loose[1]) || LOOSE_STOP.test(loose[1])) return null;
  const currency = Boolean(loose[2] || loose[4]);
  if (!currency && Number(loose[3].replace(',', '.')) < 1) return null;
  return { name: loose[1].trim(), amount: loose[3], loose: !currency };
}
const SENTENCE_WORDS = /\b(?:ecco|vorrei|vorremmo|grazie|buongiorno|buonasera|salve|ciao|allego|allegato|allegati|cordiali|saluti|gentile|gentili|seguito|seguono|questo|questi|nostro|nostri|test|interno|cliente|attivare)\b/i;
export function isPlainHeading(row, nextRow) {
  const title = row.replace(/:\s*$/, '').trim();
  if (title.length < 3 || title.length > 40 || title.split(/\s+/).length > 5) return false;
  if (/[.?!,;@\d]|https?:/i.test(title) || priceRow(row) || SENTENCE_WORDS.test(title)) return false;
  if (!/^[A-Za-zÀ-ÿ]/.test(title)) return false;
  return Boolean(priceRow(String(nextRow || '').trim().replace(/^[-•*]\s*/, '')));
}

// Titoli scritti tutto in maiuscolo ("PRIMI", "VINI AL CALICE") -> "Primi", "Vini al calice",
// per uniformità con gli altri titoli. Titoli con minuscole restano come scritti dal cliente.
export function sentenceCaseIfShouting(title) {
  const letters = title.replace(/[^A-Za-zÀ-ÿ]/g, '');
  if (letters.length < 2 || letters !== letters.toUpperCase()) return title;
  const lower = title.toLocaleLowerCase('it-IT');
  // Nome proprio tra virgolette («PERCORSO "TERRE DELL'ISONZO"»): iniziali maiuscole, virgolette «».
  const named = lower.replace(/["“”«»]([^"“”«»]{2,60})["“”«»]/g, (_, inner) => `«${inner.replace(/(^|[\s'’-])([a-zà-ÿ])([a-zà-ÿ]*)/g, (m, sep, first, rest, at) => (at > 0 && /^(?:di|del|della|dei|delle|dell|e|ed|al|alla|da|in|con|per|tra)$/.test(first + rest) ? m : sep + first.toLocaleUpperCase('it-IT') + rest))}»`);
  return named.charAt(0).toLocaleUpperCase('it-IT') + named.slice(1);
}

export function extractMenuFromText(venue, source, requestedSlug) {
  const slug = slugify(requestedSlug || venue);
  const items = [], unknown = [], provenance = [], consumed = [], confirm = [];
  let section = { nome: { it: 'Dal materiale ricevuto' }, voci: [] };
  const sections = [section];
  const lines = String(source || '').split(/\r?\n/);
  // Ultima voce letta (per descrizioni e righe «calice 5» subito sotto) e riga senza prezzo in attesa.
  let last = null, pending = null;
  const sectionName = () => section.nome?.it || '';
  const isWine = () => WINE_SECTION.test(sectionName()) || Boolean(section.columns);
  // Titolo di pagina «Mescita — by the glass», «Vini al calice» senza voci sotto: le sezioni dei vini
  // che seguono (Bollicine, Vini bianchi…) sono al calice. Diventa la descrizione della sezione.
  let glassPage = false;
  const openSection = (title, lineNumber, extra = {}) => {
    if (!section.voci.length && /\bmescita\b|by the glass|\bal calice\b|\bal bicchiere\b/i.test(section.nome?.it || '')) glassPage = true;
    else if (section.voci.length && !WINE_SECTION.test(section.nome?.it || '')) glassPage = false;
    section = { nome: { it: title.slice(0, 100) }, voci: [], line: lineNumber, ...extra };
    if (glassPage && WINE_SECTION.test(title) && !/calice|bicchiere|mescita|bottiglia/i.test(title)) section.descrizione = { it: 'Al calice' };
    else if (glassPage && !WINE_SECTION.test(title)) glassPage = false;
    sections.push(section); last = null; pending = null;
  };
  const addItem = (item, entry) => {
    section.voci.push(item);
    const record = { ...entry, section: sections.indexOf(section), index: section.voci.length - 1 };
    items.push(record);
    last = { item, entry: record, line: entry.line }; pending = null;
    return record;
  };
  const variantItem = (name, variants, lineNumber, row, how) => {
    const item = { nome: { it: name }, prezzi: variants.map((v) => ({ etichetta: { it: v.label }, prezzo: fmt(v.amount) })) };
    const record = addItem(item, { name, price: '', variants: item.prezzi.map((v) => `${v.etichetta.it} ${v.prezzo}`), sourceLine: row, line: lineNumber, loose: false });
    if (how) confirm.push({ text: row, line: lineNumber, hint: how });
    return record;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const row = lines[index].trim().replace(/^[-•*]\s*/, '');
    if (!row) { if (section.tipo !== 'degustazione') last = null; pending = null; continue; }
    if (VENUE_LINE.test(row)) continue; // Nome del locale: gestito dal chiamante, non è un piatto.
    const nextRow = lines.slice(index + 1).find((line) => line.trim()) || '';
    const nextClean = nextRow.trim().replace(/^[-•*]\s*/, '');
    // Percorso degustazione: titolo (con o senza prezzo) seguito da portate senza prezzo.
    const degu = row.startsWith('[da verificare]') ? null : degustazioneHeading(row);
    if (degu && nextClean && !priceRow(nextClean) && !degustazioneHeading(nextClean)) {
      openSection(sentenceCaseIfShouting(degu.name), lineNumber, { tipo: 'degustazione' });
      if (degu.amount) section.prezzo = fmt(degu.amount);
      if (degu.unit) section.unita = { it: degu.unit };
      if (degu.ambiguous) confirm.push({ text: row, line: lineNumber, hint: 'Percorso con più prezzi nella stessa riga: scegli tu il prezzo del percorso.' });
      continue;
    }
    // Intestazione di colonne («calice  bottiglia», anche dopo il titolo della sezione).
    const columns = columnsHeader(row.replace(/^#{1,3}\s*/, ''));
    if (columns) {
      if (columns.title && columns.title.length <= 60) openSection(sentenceCaseIfShouting(columns.title), lineNumber, { columns: columns.columns });
      else section.columns = columns.columns;
      consumed.push(lineNumber);
      continue;
    }
    // Titolo di sezione: "# Primi" o "#Primi" (come nella demo) oppure "[Primi]".
    const nextIsVariantOnly = Boolean(labelOnlyRow(nextClean) || namelessVariants(nextClean));
    const plainHeading = !nextIsVariantOnly && (isPlainHeading(row, nextRow) || (!last && !pending && isWineHeading(row, nextClean)))
      && (section.tipo !== 'degustazione' || KNOWN_SECTION.test(row) || isShouting(row));
    const knownHeading = section.tipo !== 'degustazione' && row.length <= 40 && !/\d/.test(row) && KNOWN_SECTION.test(row) && row.replace(/:\s*$/, '').trim().split(/\s+/).length <= 4 && !nextIsVariantOnly;
    if (/^#{1,3}\s*[^\s#]/.test(row) || /^\[[^\]]+\]$/.test(row) || plainHeading || knownHeading) {
      const title = sentenceCaseIfShouting(row.replace(/^#{1,3}\s*|^\[|\]$/g, '').replace(/:\s*$/, '').trim());
      if (title) openSection(title, lineNumber);
      continue;
    }
    // Coperto, telefono, orari e social non sono piatti: li gestisce venue-info.js.
    if (/^(?:il\s+)?coperto\b/i.test(row)) { unknown.push(row.slice(0, 220)); last = null; continue; }
    if (/^(?:orari\w*|pranzo|cena|aperti|apertura|chiusi|chiuso|tutti i giorni|dal\s|lun|mar|mer|gio|ven|sab|dom)\b.*\d{1,2}(?:[:.]\d{2})?\s*[-–]\s*\d{1,2}/i.test(row)) { unknown.push(row.slice(0, 220)); last = null; continue; }
    if (row.startsWith('[da verificare]')) { unknown.push(row.slice(0, 220)); last = null; continue; }
    if (section.tipo === 'degustazione') {
      const price = degustazionePrice(row);
      if (price && !section.prezzo) {
        section.prezzo = fmt(price.amount);
        if (price.unit) section.unita = { it: price.unit };
        consumed.push(lineNumber); section.priceLine = lineNumber;
        continue;
      }
      // «Il percorso è servito per tutto il tavolo», «Minimo 2 persone», «Bevande escluse»: nota del percorso, non una portata.
      const note = degustazioneNote(row);
      if (note) {
        section.descrizione = { it: section.descrizione?.it ? `${section.descrizione.it} ${note}` : note };
        consumed.push(lineNumber);
        confirm.push({ text: row, line: lineNumber, hint: `Nota del percorso «${section.nome.it}» messa come descrizione del percorso (non come portata): «${note}».` });
        continue;
      }
      const pairing = pairingRow(row);
      if (pairing) { addItem({ nome: { it: pairing.name }, prezzo: fmt(pairing.amount) }, { name: pairing.name, price: fmt(pairing.amount), sourceLine: row, line: lineNumber, loose: false }); continue; }
    }
    // Più prezzi sulla stessa voce: con etichette scritte, o due prezzi in una sezione vini/colonne.
    const labeled = labeledVariants(row);
    if (labeled) { variantItem(labeled.name, labeled.variants, lineNumber, row); continue; }
    // «Franciacorta Satèn — bottiglia 48», «Rosso della casa: calice 4»: un solo prezzo con la sua etichetta.
    const tail = row.match(/^(.*?[A-Za-zÀ-ÿ]{3}.*?)\s+[—–-]\s+(.+)$/) || row.match(/^(.*?[A-Za-zÀ-ÿ]{3}[^:]*?):\s+(.+)$/);
    const single = tail && labelOnlyRow(tail[2]);
    if (single && /^(?:Calice|Bottiglia|Mezza bottiglia|Magnum)$/.test(single.label) && !/\d/.test(tail[1].replace(/\b(?:19|20)\d{2}\b/g, ''))) { variantItem(tail[1].trim(), [single], lineNumber, row); continue; }
    const unlabeled = unlabeledVariants(row, { section: sectionName(), columns: section.columns });
    if (unlabeled) {
      variantItem(unlabeled.name, unlabeled.variants, lineNumber, row, unlabeled.inferred ? `Due prezzi senza etichetta in «${sectionName()}»: inseriti come calice ${fmt(unlabeled.variants[0].amount)} € e bottiglia ${fmt(unlabeled.variants[1].amount)} €. Conferma.` : '');
      continue;
    }
    // «calice 5» / «bottiglia 40» sotto il nome del vino (o sotto la voce appena letta con varianti).
    const only = labelOnlyRow(row);
    if (only) {
      if (pending && pending.line === lineNumber - 1) {
        const p0 = pending;
        unknown.splice(p0.unknownIndex, 1);
        const record = variantItem(p0.row, [only], p0.line, p0.row);
        record.lines = [p0.line, lineNumber];
        last.line = lineNumber;
        consumed.push(lineNumber);
        continue;
      }
      if (last?.item.prezzi && last.entry.lines && last.line === lineNumber - 1 && !last.item.prezzi.some((v) => v.etichetta.it === only.label) && last.item.prezzi.every((v) => labelFamily(v.etichetta.it) === labelFamily(only.label))) {
        last.item.prezzi.push({ etichetta: { it: only.label }, prezzo: fmt(only.amount) });
        last.entry.variants.push(`${only.label} ${fmt(only.amount)}`);
        last.line = lineNumber; last.entry.lines.push(lineNumber); consumed.push(lineNumber);
        continue;
      }
    }
    const nameless = namelessVariants(row);
    if (nameless || only) {
      if (nameless && pending && pending.line === lineNumber - 1) {
        const p0 = pending;
        unknown.splice(p0.unknownIndex, 1);
        const record = variantItem(p0.row, nameless, p0.line, p0.row);
        record.lines = [p0.line, lineNumber]; consumed.push(lineNumber); last.line = lineNumber;
        continue;
      }
      // Prezzi senza il nome del piatto: non si indovina a cosa appartengono.
      unknown.push(row.slice(0, 220)); last = null; pending = null;
      continue;
    }
    // Nel percorso una portata «secondo stagione» senza importo è una portata, non un prezzo variabile.
    const special = specialPriceRow(row);
    if (special && !(section.tipo === 'degustazione' && !special.amount)) {
      const item = { nome: { it: special.name } };
      let price = '';
      if (special.amount) { price = fmt(special.amount); item.prezzo = price; }
      item.descrizione = { it: special.note };
      addItem(item, { name: special.name, price, sourceLine: row, line: lineNumber, loose: false, special: special.kind, note: special.note });
      continue;
    }
    const match = priceRow(row);
    if (match) {
      const name = match.name.replace(/\s*[—–\-:]\s*$/, '').trim();
      // Solo formato: 12 -> 12,00 e 9,5 -> 9,50 (stesso valore, nessun prezzo inventato).
      const price = fmt(match.amount);
      if (name && Number(price.replace(',', '.')) > 0) {
        // «Ribolla (calice) — 5» subito dopo «Ribolla (bottiglia) — 28»: una voce sola con due prezzi.
        const suffix = labelSuffix(name), prev = last?.entry;
        if (suffix && prev && last.line >= lineNumber - 2 && (prev.suffixBase === normKey(suffix.base) || (last.item.prezzi && normKey(prev.name) === normKey(suffix.base)))) {
          if (!last.item.prezzi) {
            last.item.nome = { it: suffix.base.length >= prev.suffixBaseRaw.length ? suffix.base : prev.suffixBaseRaw };
            last.item.prezzi = [{ etichetta: { it: prev.suffixLabel }, prezzo: last.item.prezzo }];
            delete last.item.prezzo;
            prev.name = last.item.nome.it; prev.price = ''; prev.variants = [`${prev.suffixLabel} ${last.item.prezzi[0].prezzo}`];
          }
          if (!last.item.prezzi.some((v) => v.etichetta.it === suffix.label)) {
            last.item.prezzi.push({ etichetta: { it: suffix.label }, prezzo: price });
            prev.variants.push(`${suffix.label} ${price}`);
            last.line = lineNumber; consumed.push(lineNumber);
            continue;
          }
        }
        const record = addItem({ nome: { it: name }, prezzo: price }, { name, price, sourceLine: row, line: lineNumber, loose: match.loose });
        if (suffix) Object.assign(record, { suffixBase: normKey(suffix.base), suffixBaseRaw: suffix.base, suffixLabel: suffix.label });
        continue;
      }
    }
    // Descrizione o portata: riga senza prezzo subito sotto una voce (o dentro un percorso).
    const contiguous = last && last.line >= lineNumber - 1;
    const desc = contiguous ? descriptionLike(row, { wine: isWine() }) : null;
    if (desc && last && !last.descLocked) {
      const item = last.item;
      const text = sentenceCaseIfShouting(desc);
      item.descrizione = { it: item.descrizione?.it && last.entry.special ? `${item.descrizione.it} · ${text}` : item.descrizione?.it && last.descLine ? `${item.descrizione.it} ${text}` : text };
      last.descLine = lineNumber; last.line = lineNumber; last.entry.descriptionLine = last.entry.descriptionLine || lineNumber;
      consumed.push(lineNumber);
      const allergens = allergenNumbers(desc);
      if (allergens) confirm.push({ type: 'allergeni', name: item.nome.it, text: row, line: lineNumber, hint: `Numeri di allergeni scritti dal locale per «${item.nome.it}» (${allergens.join(', ')}): sono rimasti nella descrizione. Se seguono la legenda UE 1–14 inseriscili negli allergeni del piatto.` });
      continue;
    }
    if (section.tipo === 'degustazione' && courseLike(row)) {
      addItem({ nome: { it: sentenceCaseIfShouting(row.replace(/^>\s*/, '')).slice(0, 150) } }, { name: row.slice(0, 150), price: '', sourceLine: row, line: lineNumber, loose: false, course: true });
      continue;
    }
    pending = { row: row.replace(/[\s—–\-:]+$/, ''), line: lineNumber, unknownIndex: unknown.length };
    last = null;
    unknown.push(row.slice(0, 220));
  }
  const kept = sections.filter((s) => s.voci.length);
  for (const s of kept) if (s.tipo === 'degustazione') {
    if (!s.prezzo) confirm.push({ text: s.nome.it, line: s.line, hint: `Percorso «${s.nome.it}» senza prezzo scritto: inseriscilo tu (prezzo del percorso).` });
    if (!s.voci.some((v) => !v.prezzo)) confirm.push({ text: s.nome.it, line: s.line, hint: `Percorso «${s.nome.it}» senza portate lette: controlla il testo.` });
  }
  // Provenienza: ogni nome e prezzo punta alla riga del testo ricevuto da cui è stato letto.
  kept.forEach((s, sectionIndex) => {
    if (s.line) provenance.push({ path: `sezioni.${sectionIndex}.nome.it`, source: `riga ${s.line}`, value: s.nome.it, status: 'confermato' });
    if (s.prezzo) provenance.push({ path: `sezioni.${sectionIndex}.prezzo`, source: `riga ${s.priceLine || s.line}`, value: s.prezzo, status: 'confermato' });
    s.voci.forEach((item, itemIndex) => {
      const found = items.find((entry) => entry.section === sections.indexOf(s) && entry.index === itemIndex);
      const where = found ? `riga ${found.line}` : 'nessuna fonte';
      provenance.push({ path: `sezioni.${sectionIndex}.voci.${itemIndex}.nome.it`, source: where, value: item.nome.it, status: 'confermato' });
      if (item.prezzo !== undefined) provenance.push({ path: `sezioni.${sectionIndex}.voci.${itemIndex}.prezzo`, source: where, value: item.prezzo, status: 'confermato' });
      (item.prezzi || []).forEach((v, vi) => provenance.push({ path: `sezioni.${sectionIndex}.voci.${itemIndex}.prezzi.${vi}.prezzo`, source: where, value: `${v.etichetta.it} ${v.prezzo}`, status: 'confermato' }));
      if (item.descrizione) provenance.push({ path: `sezioni.${sectionIndex}.voci.${itemIndex}.descrizione.it`, source: found?.descriptionLine ? `riga ${found.descriptionLine}` : where, value: item.descrizione.it, status: 'confermato' });
    });
  });
  const menu = { id: slug, nome: venue.trim(), lingue: ['it'], sezioni: kept.map(({ nome, voci, tipo, prezzo, unita, descrizione }) => ({ nome, ...(descrizione ? { descrizione } : {}), ...(tipo ? { tipo } : {}), ...(prezzo ? { prezzo } : {}), ...(unita ? { unita } : {}), voci })) };
  const variantCount = items.filter((i) => i.variants).length, courses = kept.filter((s) => s.tipo === 'degustazione');
  return { menu, extracted: items.filter((i) => !i.course), courses: items.filter((i) => i.course), consumed, confirm, uncertain: unknown, provenance, warnings: [
    'Allergeni, ingredienti, coperto, contatti e traduzioni non sono stati dedotti.',
    ...items.filter((i) => i.special).map((i) => `«${i.name}»: ${i.special === 'variabile' ? 'senza prezzo fisso' : `${i.price} €`} con la nota «${i.note}» (dalla riga ${i.line}: “${i.sourceLine.slice(0, 90)}”). Controlla la nota.`),
    ...(variantCount ? [`${variantCount} voci con più prezzi (es. calice e bottiglia): ${items.filter((i) => i.variants).slice(0, 4).map((i) => `«${i.name}» ${i.variants.join(' · ')}`).join('; ')}${variantCount > 4 ? '…' : ''}. Controllale.`] : []),
    ...courses.map((s) => `Percorso degustazione «${s.nome.it}»: ${s.voci.filter((v) => !v.prezzo).length} portate${s.prezzo ? `, ${s.prezzo} €${s.unita ? ` ${s.unita.it}` : ''}` : ', prezzo da inserire'}. Controllalo.`),
    ...(items.some((i) => i.loose) ? [`${items.filter((i) => i.loose).length} prezzi scritti senza €, controlla che siano davvero prezzi: ${items.filter((i) => i.loose).map((i) => `«${i.name}» ${i.price}`).join(', ')}.`] : []),
    ...(unknown.length ? [`${unknown.length} righe senza prezzo o formato riconosciuto richiedono controllo.`] : [])
  ] };
}
const KNOWN_SECTION = /^(?:#\s*)?(?:(?:gli |i |le |il |la )?(?:antipasti|primi|secondi|contorni|dolci|dessert|formaggi|pizze|bevande|bibite|vini|birre|cocktail|caffetteria|amari|distillati|insalate|panini|crudi|bollicine|spumanti)\b|menu bambini|piatti del giorno)/i;
const isShouting = (row) => { const l = row.replace(/[^A-Za-zÀ-ÿ]/g, ''); return l.length >= 4 && l === l.toUpperCase(); };
// Etichette della stessa famiglia (vino: calice/bottiglia/caraffa; taglie: piccola/media/grande; porzioni).
const labelFamily = (label) => (/^(?:Piccola|Media|Grande)$/.test(label) ? 'taglia' : /porzione/i.test(label) ? 'porzione' : 'vino');
const normKey = (value) => String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
// Portata di un percorso: riga breve senza prezzo, non una frase dell'email.
function courseLike(row) {
  const text = row.trim();
  return text.length >= 3 && text.length <= 150 && /[A-Za-zÀ-ÿ]{3}/.test(text) && !/[?!]$/.test(text) && !SENTENCE_WORDS.test(text) && !/\b(?:abbiamo|vorremmo|potete|grazie|saluti)\b/i.test(text);
}
// «VINI BIANCHI» seguito da «Friulano 5/40»: titolo anche se la riga dopo ha due prezzi.
function isWineHeading(row, nextRow) {
  const title = row.replace(/:\s*$/, '').trim();
  if (title.length < 3 || title.length > 40 || title.split(/\s+/).length > 5 || /[.?!,;@\d]/.test(title) || !WINE_SECTION.test(title)) return false;
  return Boolean(labeledVariants(nextRow) || unlabeledVariants(nextRow, { section: title }) || priceRow(nextRow));
}

export function menuDiff(before, after) {
  const index = (menu) => new Map((menu?.sezioni || []).flatMap((section) => (section.voci || []).map((item) => [
    `${typeof section.nome === 'object' ? section.nome.it : section.nome} / ${typeof item.nome === 'object' ? item.nome.it : item.nome}`,
    item.prezzi?.length ? item.prezzi.map((v) => `${typeof v.etichetta === 'object' ? v.etichetta.it : v.etichetta} ${v.prezzo}`).join(' / ') : String(item.prezzo ?? '')
  ])));
  const previous = index(before), next = index(after), changes = [];
  for (const [name, price] of next) {
    if (!previous.has(name)) changes.push({ type: 'aggiunto', name, after: price });
    else if (previous.get(name) !== price) changes.push({ type: 'prezzo', name, before: previous.get(name), after: price });
  }
  for (const [name, price] of previous) if (!next.has(name)) changes.push({ type: 'rimosso', name, before: price });
  return changes;
}

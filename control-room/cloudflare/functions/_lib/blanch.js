/* Adattatore per il menu di Trattoria Blanch, che non è in menus/<id>.json ma in tre file propri:
 *   blanch/data/food.json   cucina e bevande (fonte, scritta a mano)
 *   blanch/data/wines.tsv   bottiglie (fonte)
 *   blanch/data/menu.json   menu compilato, quello che legge la pagina /blanch/ (equivale a build_menu.py)
 * Jarvis lavora sempre sul formato RenMenu (sezioni e voci): qui si converte da Blanch a RenMenu per la bozza
 * e si torna ai tre file al momento della pubblicazione, cambiando solo le righe toccate. L'indirizzo /blanch/ e il QR
 * già stampato non cambiano mai.
 *
 * Regola di sicurezza: dopo l'esportazione i file nuovi vengono riletti e devono dare esattamente il menu approvato;
 * ciò che il formato Blanch non può contenere (telefono, allergeni per piatto, foto, tema, ecc.) blocca la pubblicazione
 * con un messaggio chiaro, invece di sparire in silenzio. */
export const BLANCH_SLUG = 'trattoria-blanch';
export const BLANCH_PATHS = { food: 'blanch/data/food.json', wines: 'blanch/data/wines.tsv', menu: 'blanch/data/menu.json' };
export const BLANCH_FILE_LIST = [BLANCH_PATHS.food, BLANCH_PATHS.wines, BLANCH_PATHS.menu];
export const isBlanchSlug = (slug) => slug === BLANCH_SLUG;

const LANGS = ['it', 'en', 'de'];
const SEP = ' · ';
const DETAIL_SEP = ' — ';
export const WINE_CATEGORIES = {
  'Vini Bianchi': { it: 'Vini bianchi', en: 'White wines', de: 'Weißweine' },
  'Vini Rossi': { it: 'Vini rossi', en: 'Red wines', de: 'Rotweine' },
  'Vini Dolci': { it: 'Vini dolci', en: 'Dessert wines', de: 'Dessertweine' },
  'Vini Spumanti': { it: 'Vini spumanti', en: 'Sparkling wines', de: 'Schaumweine' }
};
const TSV_HEADER = ['category', 'producer', 'location', 'name', 'details', 'price', 'source'];
const INTERNAL_ITEM_KEYS = new Set(['source', 'editorial_note']);

export class BlanchError extends Error {
  constructor(message) { super(message); this.name = 'BlanchError'; this.code = 'BLANCH_FORMAT'; this.status = 422; }
}
const fail = (message) => { throw new BlanchError(message); };

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const itText = (value) => (typeof value === 'string' ? value : value?.it || '');
const clone = (value) => JSON.parse(JSON.stringify(value));

/** Testo (o oggetto per lingua) → oggetto con it, en, de. Le lingue mancanti ripiegano sull'italiano. */
function trilingual(value) {
  if (typeof value === 'string') return { it: value, en: value, de: value };
  const it = String(value?.it || '').trim();
  if (!it) fail('Una voce del menu non ha il testo in italiano.');
  const out = {};
  for (const lang of LANGS) out[lang] = typeof value[lang] === 'string' && value[lang].trim() ? value[lang] : it;
  return out;
}

/** «12,00» (RenMenu) ↔ «€ 12,00» (Blanch). */
function toBlanchPrice(value) {
  const raw = String(value ?? '').trim().replace('.', ',');
  if (!/^\d+(?:,\d{1,2})?$/.test(raw)) fail(`Prezzo non valido per il formato Blanch: «${value}».`);
  const [euro, cents = ''] = raw.split(',');
  return `€ ${Number(euro)},${cents.padEnd(2, '0')}`;
}
function fromBlanchPrice(value) {
  const match = /^€ (\d+,\d{2})$/.exec(String(value || ''));
  if (!match) fail(`Prezzo non riconosciuto nel menu Blanch: «${value}».`);
  return match[1];
}

// ———— Lettura dei file sorgente ————
export function parseFood(foodText) {
  let source;
  try { source = JSON.parse(foodText); } catch { fail('food.json non è un JSON valido.'); }
  if (!source || !Array.isArray(source.food) || !source.notes?.food || !source.notes?.wine) fail('food.json non ha la forma attesa (food e notes).');
  return source;
}

export function parseWines(tsvText) {
  const text = String(tsvText || '');
  if (text.includes('"') || text.includes('\r')) fail('wines.tsv contiene virgolette o ritorni a capo di Windows: non lo modifico.');
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines[0] !== TSV_HEADER.join('\t')) fail('Le colonne di wines.tsv non sono quelle attese.');
  return lines.slice(1).map((raw, index) => {
    const cells = raw.split('\t');
    if (cells.length !== TSV_HEADER.length) fail(`wines.tsv riga ${index + 2}: numero di colonne inatteso.`);
    return { raw, category: cells[0], producer: cells[1], location: cells[2], name: cells[3], details: cells[4], price: cells[5], source: cells[6] };
  });
}

/** Equivale a blanch/tools/build_menu.py: stesso risultato, byte per byte. */
export function compileBlanch(foodText, tsvText) {
  const source = parseFood(foodText);
  const food = source.food.map((section) => {
    const { items, ...rest } = section;
    return { ...rest, items: items.map((item) => Object.fromEntries(Object.entries(item).filter(([key]) => !INTERNAL_ITEM_KEYS.has(key)))) };
  });
  const wines = Object.fromEntries(Object.entries(WINE_CATEGORIES).map(([key, title]) => [key, { title, items: [] }]));
  for (const row of parseWines(tsvText)) {
    if (!wines[row.category]) fail(`wines.tsv: categoria sconosciuta «${row.category}».`);
    if (!row.name.trim() || !row.producer.trim()) fail('wines.tsv: nome o produttore mancante.');
    if (row.price.split(',').length !== 2) fail(`wines.tsv: prezzo inatteso «${row.price}».`);
    const item = { name: row.name, producer: row.producer + (row.location ? SEP + row.location : ''), price: `€ ${row.price}` };
    if (row.details) item.detail = row.details;
    wines[row.category].items.push(item);
  }
  if (!Object.values(wines).every((section) => section.items.length)) fail('Ogni sezione dei vini deve avere almeno una voce.');
  return { name: 'Trattoria Blanch', languages: [...LANGS], food, wine: Object.values(wines), notes: source.notes };
}
export const serializeCompiled = (compiled) => `${JSON.stringify(compiled)}\n`;

// Alcune voci hanno due importi stampati senza spiegazione («€ 10,00 / 13,00»): in RenMenu diventano due prezzi
// con etichette fisse, e tornano a un'unica stringa nel file Blanch. Jarvis non spiega mai quando si applica ciascuno.
const TWO_PRICE_LABELS = [
  { it: 'Primo prezzo', en: 'First price', de: 'Erster Preis' },
  { it: 'Secondo prezzo', en: 'Second price', de: 'Zweiter Preis' }
];
function twoPrices(value) {
  const match = /^€ (\d+,\d{2}) \/ (\d+,\d{2})$/.exec(String(value || ''));
  return match ? { prezzi: [{ etichetta: { ...TWO_PRICE_LABELS[0] }, prezzo: match[1] }, { etichetta: { ...TWO_PRICE_LABELS[1] }, prezzo: match[2] }] } : null;
}
const isTwoPrices = (prezzi) => Array.isArray(prezzi) && prezzi.length === 2
  && prezzi.every((v, i) => itText(v.etichetta).trim().toLowerCase() === TWO_PRICE_LABELS[i].it.toLowerCase());

// ———— Blanch (compilato) → formato RenMenu ————
export function blanchToMenu(compiled) {
  if (!compiled || !Array.isArray(compiled.food) || !Array.isArray(compiled.wine)) fail('Il menu Blanch non ha la forma attesa.');
  const sezioni = [];
  for (const section of compiled.food) {
    sezioni.push({
      nome: trilingual(section.title),
      ...(section.caption ? { descrizione: trilingual(section.caption) } : {}),
      voci: section.items.map((item) => ({
        nome: trilingual(item.name),
        ...(item.description ? { descrizione: trilingual(item.description) } : {}),
        ...(item.variants
          ? { prezzi: item.variants.map((variant) => ({ etichetta: trilingual(variant.label), prezzo: fromBlanchPrice(variant.price) })) }
          : twoPrices(item.price) || { prezzo: fromBlanchPrice(item.price) })
      }))
    });
  }
  for (const section of compiled.wine) {
    sezioni.push({
      nome: trilingual(section.title),
      voci: section.items.map((item) => ({
        nome: item.name,
        descrizione: item.producer + (item.detail ? DETAIL_SEP + item.detail : ''),
        prezzo: fromBlanchPrice(item.price)
      }))
    });
  }
  return {
    id: BLANCH_SLUG, nome: 'Trattoria Blanch', lingue: [...LANGS],
    avviso: trilingual(compiled.notes.food), note: trilingual(compiled.notes.wine), sezioni
  };
}

// ———— Formato RenMenu → Blanch (compilato desiderato) ————
const SECTION_KEYS = new Set(['nome', 'descrizione', 'voci']);
const ITEM_KEYS = new Set(['nome', 'descrizione', 'prezzo', 'prezzi']);
const ROOT_KEYS = new Set(['id', 'nome', 'lingue', 'avviso', 'note', 'sezioni']);

/** Campi del menu che il formato Blanch non può contenere: elenco leggibile, vuoto se tutto è esportabile. */
export function unsupportedFields(menu) {
  const found = [];
  const filled = (value) => value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && !value.length);
  for (const key of Object.keys(menu || {})) if (!ROOT_KEYS.has(key) && filled(menu[key])) found.push(key);
  (menu?.sezioni || []).forEach((section, si) => {
    for (const key of Object.keys(section)) if (!SECTION_KEYS.has(key) && filled(section[key])) found.push(`sezione ${si + 1}: ${key}`);
    (section.voci || []).forEach((item, vi) => {
      for (const key of Object.keys(item)) if (!ITEM_KEYS.has(key) && filled(item[key])) found.push(`${itText(item.nome) || `voce ${vi + 1}`}: ${key}`);
    });
  });
  return found;
}

const wineSectionKey = (section) => Object.entries(WINE_CATEGORIES).find(([, title]) => title.it.toLowerCase() === itText(section.nome).trim().toLowerCase())?.[0] || null;

export function menuToCompiled(menu) {
  if (!menu || !Array.isArray(menu.sezioni) || !menu.sezioni.length) fail('Il menu non ha sezioni.');
  const unsupported = unsupportedFields(menu);
  if (unsupported.length) fail(`Il formato di Trattoria Blanch non può contenere: ${unsupported.slice(0, 6).join('; ')}.`);
  const food = [];
  const wines = Object.fromEntries(Object.entries(WINE_CATEGORIES).map(([key, title]) => [key, { title, items: [] }]));
  for (const section of menu.sezioni) {
    const key = wineSectionKey(section);
    if (key) {
      for (const item of section.voci || []) {
        if (item.prezzi) fail(`«${itText(item.nome)}»: i vini in bottiglia hanno un solo prezzo.`);
        const description = String(itText(item.descrizione) || '').trim();
        const [producer, ...rest] = description.split(DETAIL_SEP);
        const entry = { name: itText(item.nome).trim(), producer: producer.trim(), price: toBlanchPrice(item.prezzo) };
        if (rest.length) entry.detail = rest.join(DETAIL_SEP).trim();
        if (!entry.name || !entry.producer) fail(`Vino «${entry.name || '?'}»: servono nome e produttore (nella descrizione).`);
        wines[key].items.push(entry);
      }
      continue;
    }
    const entry = { title: trilingual(section.nome), ...(section.descrizione ? { caption: trilingual(section.descrizione) } : {}), items: [] };
    for (const item of section.voci || []) {
      const out = { name: trilingual(item.nome) };
      if (item.descrizione) out.description = trilingual(item.descrizione);
      if (isTwoPrices(item.prezzi)) out.price = `${toBlanchPrice(item.prezzi[0].prezzo)} / ${toBlanchPrice(item.prezzi[1].prezzo).replace('€ ', '')}`;
      else if (Array.isArray(item.prezzi) && item.prezzi.length) out.variants = item.prezzi.map((v) => ({ label: trilingual(v.etichetta), price: toBlanchPrice(v.prezzo) }));
      else out.price = toBlanchPrice(item.prezzo);
      entry.items.push(out);
    }
    food.push(entry);
  }
  return { name: 'Trattoria Blanch', languages: [...LANGS], food, wine: Object.values(wines), notes: { food: trilingual(menu.avviso), wine: trilingual(menu.note) } };
}

/** Il menu nella sola forma che Blanch può rappresentare: serve a confrontare bozza, PR e menu online. */
export function canonicalBlanch(menu) {
  return blanchToMenu(menuToCompiled(menu));
}

// ———— Scrittura dei file: si toccano solo le righe cambiate ————
const FOOD_START = '  "food": [';
function splitFoodBlock(foodText) {
  const lines = foodText.split('\n');
  const start = lines.indexOf(FOOD_START);
  const end = lines.indexOf('  ],', start + 1);
  if (start < 0 || end < 0) fail('food.json: non trovo l’elenco delle sezioni.');
  const sections = [];
  let i = start + 1;
  while (i < end) {
    if (lines[i] !== '    {') fail(`food.json riga ${i + 1}: inizio sezione inatteso.`);
    const section = { header: [], items: [] };
    i += 1;
    while (!/^ {6}"items":\s*\[$/.test(lines[i] ?? '')) {
      if (i >= end) fail('food.json: sezione senza elenco di voci.');
      section.header.push(lines[i]); i += 1;
    }
    section.itemsOpen = lines[i]; i += 1;
    while (lines[i] !== '      ]') {
      if (i >= end) fail('food.json: elenco di voci non chiuso.');
      const match = /^( {8})(\{.*\})(,?)$/.exec(lines[i]);
      if (!match) fail(`food.json riga ${i + 1}: voce non riconosciuta.`);
      section.items.push({ raw: lines[i], indent: match[1], obj: JSON.parse(match[2]) });
      i += 1;
    }
    i += 1;
    if (!/^ {4}\},?$/.test(lines[i] ?? '')) fail(`food.json riga ${i + 1}: fine sezione inatteso.`);
    i += 1;
    for (const line of section.header) {
      const m = /^ {6}"(title|caption)":\s*(\{.*\}),?$/.exec(line);
      if (!m) fail('food.json: intestazione di sezione non riconosciuta.');
      section[m[1]] = JSON.parse(m[2]);
    }
    sections.push(section);
  }
  return { before: lines.slice(0, start + 1), sections, after: lines.slice(end) };
}

const itemKey = (item) => itText(item.name).trim().toLowerCase();

function mergeItem(old, wanted) {
  const out = { name: wanted.name };
  if (wanted.description) out.description = wanted.description;
  if (wanted.variants) out.variants = wanted.variants; else out.price = wanted.price;
  for (const key of INTERNAL_ITEM_KEYS) if (old && key in old) out[key] = old[key];
  if (!old) out.source = 'Jarvis';
  return out;
}

function patchFood(foodText, wantedFood) {
  const block = splitFoodBlock(foodText);
  const used = new Set();
  const out = [];
  wantedFood.forEach((wanted, index) => {
    const oldIndex = block.sections.findIndex((section, i) => !used.has(i) && itText(section.title).trim().toLowerCase() === itText(wanted.title).trim().toLowerCase());
    if (oldIndex >= 0) used.add(oldIndex);
    const old = oldIndex >= 0 ? block.sections[oldIndex] : null;
    const lines = ['    {'];
    const headerSame = old && same(old.title, wanted.title) && same(old.caption ?? null, wanted.caption ?? null);
    if (headerSame) lines.push(...old.header);
    else {
      lines.push(`      "title": ${JSON.stringify(wanted.title)},`);
      if (wanted.caption) lines.push(`      "caption": ${JSON.stringify(wanted.caption)},`);
    }
    lines.push(old ? old.itemsOpen : '      "items": [');
    const unusedOld = new Set((old?.items || []).map((_, i) => i));
    const matches = wanted.items.map((item) => {
      const found = [...unusedOld].find((i) => itemKey(old.items[i].obj) === itemKey(item));
      if (found !== undefined) unusedOld.delete(found);
      return found;
    });
    // Voci rinominate: stesse posizioni libere, stesso numero (altrimenti sono voci nuove).
    const freeNew = matches.map((m, i) => (m === undefined ? i : -1)).filter((i) => i >= 0);
    const freeOld = [...unusedOld].sort((a, b) => a - b);
    if (freeNew.length && freeNew.length === freeOld.length) freeNew.forEach((n, k) => { matches[n] = freeOld[k]; });
    wanted.items.forEach((item, k) => {
      const oldItem = matches[k] !== undefined ? old.items[matches[k]] : null;
      const merged = mergeItem(oldItem?.obj, item);
      const unchanged = oldItem && same(merged, oldItem.obj);
      const text = unchanged ? oldItem.raw.replace(/,$/, '') : `${oldItem?.indent || '        '}${JSON.stringify(merged)}`;
      lines.push(`${text}${k < wanted.items.length - 1 ? ',' : ''}`);
    });
    lines.push('      ]');
    lines.push(index < wantedFood.length - 1 ? '    },' : '    }');
    out.push(...lines);
  });
  return [...block.before, ...out, ...block.after].join('\n');
}

function splitProducer(merged, oldRow) {
  if (oldRow && oldRow.producer + (oldRow.location ? SEP + oldRow.location : '') === merged) return { producer: oldRow.producer, location: oldRow.location };
  const at = merged.indexOf(SEP);
  return at < 0 ? { producer: merged, location: '' } : { producer: merged.slice(0, at), location: merged.slice(at + SEP.length) };
}

function patchWines(tsvText, wantedWine) {
  const rows = parseWines(tsvText);
  const replace = new Map(); // indice riga originale → riga nuova (null = tolta)
  const before = new Map();
  const after = new Map();
  const tail = [];
  rows.forEach((_, i) => replace.set(i, null));
  const push = (map, index, line) => map.set(index, [...(map.get(index) || []), line]);
  for (const category of Object.keys(WINE_CATEGORIES)) {
    const wanted = wantedWine.find((section) => section.title.it === WINE_CATEGORIES[category].it)?.items || [];
    const oldIdx = rows.map((r, i) => (r.category === category ? i : -1)).filter((i) => i >= 0);
    const unusedOld = new Set(oldIdx);
    const rowKey = (r) => `${r.name}|${r.producer + (r.location ? SEP + r.location : '')}`.toLowerCase();
    const matches = wanted.map((item) => {
      const found = [...unusedOld].find((i) => rowKey(rows[i]) === `${item.name}|${item.producer}`.toLowerCase());
      if (found !== undefined) unusedOld.delete(found);
      return found;
    });
    const freeNew = matches.map((m, i) => (m === undefined ? i : -1)).filter((i) => i >= 0);
    const freeOld = [...unusedOld].sort((a, b) => a - b);
    if (freeNew.length && freeNew.length === freeOld.length) freeNew.forEach((n, k) => { matches[n] = freeOld[k]; });
    const lineFor = (item, oldRow) => {
      const { producer, location } = splitProducer(item.producer, oldRow);
      const row = [category, producer, location, item.name, item.detail || '', item.price.replace(/^€ /, ''), oldRow ? oldRow.source : 'Jarvis'].join('\t');
      return oldRow && oldRow.raw === row ? oldRow.raw : row;
    };
    wanted.forEach((item, k) => {
      if (matches[k] !== undefined) { replace.set(matches[k], lineFor(item, rows[matches[k]])); return; }
      const prev = [...matches.slice(0, k)].reverse().find((m) => m !== undefined);
      const next = matches.slice(k + 1).find((m) => m !== undefined);
      if (prev !== undefined) push(after, prev, lineFor(item, null));
      else if (next !== undefined) push(before, next, lineFor(item, null));
      else tail.push(lineFor(item, null));
    });
  }
  const lines = [TSV_HEADER.join('\t')];
  rows.forEach((_, i) => {
    lines.push(...(before.get(i) || []));
    if (replace.get(i)) lines.push(replace.get(i));
    lines.push(...(after.get(i) || []));
  });
  lines.push(...tail);
  return `${lines.join('\n')}\n`;
}

/** Dal menu approvato ai tre file nuovi. Rilegge il risultato e lo confronta con il menu approvato. */
export function exportBlanchFiles(menu, { food, wines, menu: currentMenuText } = {}) {
  if (typeof food !== 'string' || typeof wines !== 'string') fail('Mancano i file correnti di Blanch.');
  const wanted = menuToCompiled(menu);
  const current = compileBlanch(food, wines);
  if (typeof currentMenuText === 'string' && currentMenuText !== serializeCompiled(current)) fail('Il menu compilato di Blanch non coincide con food.json e wines.tsv: sistemalo a mano prima di usare Jarvis.');
  if (!same(wanted.notes, current.notes)) fail('Gli avvisi su coperto e allergie del menu Blanch non si cambiano da Jarvis.');
  const newFood = patchFood(food, wanted.food);
  const newWines = patchWines(wines, wanted.wine);
  const compiled = compileBlanch(newFood, newWines);
  if (!same(blanchToMenu(compiled), canonicalBlanch(menu))) fail('I file Blanch generati non coincidono con il menu approvato: non pubblico.');
  return { food: newFood, wines: newWines, menu: serializeCompiled(compiled), changed: { food: newFood !== food, wines: newWines !== wines } };
}

/** Indirizzi pubblici di controllo e di consegna al cliente. */
export function publicMenuJsonUrl(origin, slug) {
  return isBlanchSlug(slug) ? `${origin}/blanch/data/menu.json` : `${origin}/menus/${encodeURIComponent(slug)}.json`;
}
export function publicMenuPageUrl(origin, slug) {
  return isBlanchSlug(slug) ? `${origin}/blanch/` : `${origin}/menu/?m=${encodeURIComponent(slug)}`;
}

/** Il JSON pubblico (compilato) di Blanch, riletto come menu RenMenu; per gli altri menu è il JSON stesso. */
export function publicJsonToMenu(slug, json) {
  return isBlanchSlug(slug) ? blanchToMenu(json) : json;
}
export const semanticMenu = (slug, menu) => (isBlanchSlug(slug) ? canonicalBlanch(menu) : menu);
export const _test = { clone };

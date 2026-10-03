/* RenMenu Control Room — modello condiviso, senza dipendenze esterne. */

const ALLOWED_ALLERGENS = new Set(Array.from({ length: 14 }, (_, index) => String(index + 1)));
const ALLOWED_TAGS = new Set(['veg', 'vegan', 'spicy', 'gf', 'new', 'top', 'frozen']);
const LEGACY_TAGS = new Set(['hot', 'riserva']);
const PRICE_PATTERN = /^\d+(?:[,.]\d{1,2})?$/;
const PUBLIC_ROOT = new Set(['id', 'nome', 'sottotitolo', 'indirizzo', 'telefono', 'instagram', 'maps', 'orari', 'wifi', 'avviso', 'coperto', 'note', 'tema', 'sezioni', 'lingue', 'url', 'sito', 'website']);
const PUBLIC_SECTION = new Set(['nome', 'descrizione', 'voci']);
const PUBLIC_ITEM = new Set(['nome', 'descrizione', 'prezzo', 'allergeni', 'tag']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmptyText = (value) => {
  if (typeof value === 'string') return Boolean(value.trim());
  if (isObject(value)) return Object.values(value).some((item) => typeof item === 'string' && item.trim());
  return false;
};
const localText = (value, language) => isObject(value) && typeof value[language] === 'string' && Boolean(value[language].trim());

/** Convert a title to a file-safe RenMenu id without manufacturing content. */
export function slugify(value, fallback = 'menu-da-verificare') {
  const clean = String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return clean || fallback;
}

/**
 * Client-side mirror of scripts/validate-menus.py for editorial feedback.
 * It intentionally returns warnings separately: warnings do not make a menu
 * technically invalid, but must still be reviewed before any publication.
 */
export function validateMenu(menu) {
  const errors = [];
  const warnings = [];
  const add = (level, path, message) => (level === 'error' ? errors : warnings).push({ level, path, message });
  const price = (value, path) => {
    if (typeof value === 'boolean' || (!['string', 'number'].includes(typeof value))) {
      add('error', path, 'Il prezzo deve essere un numero o testo numerico.');
      return;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || value <= 0) add('error', path, 'Il prezzo deve essere maggiore di zero.');
      return;
    }
    const normalized = value.trim();
    if (!normalized) {
      add('warning', path, 'Prezzo vuoto: non sarà mostrato e richiede verifica.');
    } else if (!PRICE_PATTERN.test(normalized) || Number(normalized.replace(',', '.')) <= 0) {
      add('error', path, 'Prezzo non valido. Usa ad esempio 12 oppure 12,50.');
    }
  };

  if (!isObject(menu)) {
    add('error', 'radice', 'Il menu deve essere un oggetto JSON.');
    return { valid: false, errors, warnings };
  }
  const allowed = (object, keys, path) => { if (isObject(object)) for (const key of Object.keys(object))
    if (!keys.has(key)) add('error', `${path}.${key}`, 'Campo interno non ammesso nel menù pubblico.'); };
  const publicText = (value, path) => {
    if (typeof value === 'string') return;
    if (!isObject(value)) { add('error', path, 'Serve testo o traduzioni per lingua.'); return; }
    for (const [key, entry] of Object.entries(value)) if (!/^[a-z]{2}$/.test(key) || typeof entry !== 'string')
      add('error', `${path}.${key}`, 'Solo testi localizzati per lingua ISO.');
  };
  allowed(menu, PUBLIC_ROOT, 'menu');
  for (const key of ['nome', 'sottotitolo', 'orari', 'avviso', 'note']) if (key in menu) publicText(menu[key], `menu.${key}`);
  for (const key of ['indirizzo', 'telefono', 'instagram', 'maps', 'wifi', 'coperto', 'url', 'sito', 'website'])
    if (key in menu && typeof menu[key] !== 'string') add('error', `menu.${key}`, 'Serve un testo pubblico, non un oggetto tecnico.');
  if (!nonEmptyText(menu.nome)) add('error', 'nome', "Manca un nome del locale non vuoto ('nome').");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(menu.id || '')) add('error', 'id', 'ID menù non valido.');
  const inspect = (value, path = 'menu', depth = 0) => {
    if (typeof value === 'string' && /(?:private\/requests\/|r2:\/\/|BEGIN\s+PRIVATE\s+KEY|Bearer\s+\S+)/i.test(value))
      add('error', path, 'Percorso privato o credenziale vietata nel JSON pubblico.');
    if (depth > 12 || !value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value)) {
      if (/^(?:api[_-]?key|token|secret|password|private[_-]?key|authorization|access[_-]?token)$/i.test(key))
        add('error', `${path}.${key}`, 'Campo tecnico o segreto vietato nel JSON pubblico.');
      inspect(entry, `${path}.${key}`, depth + 1);
    }
  };
  inspect(menu);

  const languages = [];
  if ('lingue' in menu) {
    if (!Array.isArray(menu.lingue) || !menu.lingue.length) {
      add('error', 'lingue', 'Lingue deve essere una lista non vuota quando dichiarata.');
    } else {
      const seen = new Set();
      menu.lingue.forEach((language, index) => {
        if (typeof language !== 'string' || !/^[a-z]{2}$/.test(language.trim())) add('error', `lingue.${index}`, 'Codice lingua non valido.');
        else if (seen.has(language.trim())) add('error', `lingue.${index}`, 'Lingua dichiarata più di una volta.');
        else { seen.add(language.trim()); languages.push(language.trim()); }
      });
    }
  }

  if (!Array.isArray(menu.sezioni) || !menu.sezioni.length) {
    add('error', 'sezioni', "Manca almeno una sezione non vuota ('sezioni').");
    return { valid: false, errors, warnings };
  }

  // Il nome del locale è un nome proprio: nei menù pubblici è una stringa e non si traduce.
  // Solo se è già un oggetto per lingua va controllato come gli altri testi essenziali.
  const essential = isObject(menu.nome) ? [['nome', menu.nome]] : [];
  menu.sezioni.forEach((section, sectionIndex) => {
    const sectionPath = `sezioni.${sectionIndex}`;
    if (!isObject(section)) { add('error', sectionPath, 'La sezione deve essere un oggetto JSON.'); return; }
    allowed(section, PUBLIC_SECTION, sectionPath);
    for (const key of ['nome', 'descrizione']) if (key in section) publicText(section[key], `${sectionPath}.${key}`);
    if (!nonEmptyText(section.nome)) add('error', `${sectionPath}.nome`, 'Manca un nome della sezione.');
    else essential.push([`${sectionPath}.nome`, section.nome]);
    if (!Array.isArray(section.voci) || !section.voci.length) { add('error', `${sectionPath}.voci`, 'La sezione deve contenere almeno una voce.'); return; }
    section.voci.forEach((item, itemIndex) => {
      const itemPath = `${sectionPath}.voci.${itemIndex}`;
      if (!isObject(item)) { add('error', itemPath, 'La voce deve essere un oggetto JSON.'); return; }
      allowed(item, PUBLIC_ITEM, itemPath);
      for (const key of ['nome', 'descrizione']) if (key in item) publicText(item[key], `${itemPath}.${key}`);
      if (!nonEmptyText(item.nome)) add('error', `${itemPath}.nome`, 'Manca un nome della voce.');
      else essential.push([`${itemPath}.nome`, item.nome]);
      if ('prezzo' in item) price(item.prezzo, `${itemPath}.prezzo`);
      else add('warning', `${itemPath}.prezzo`, 'PREZZO NON CONFERMATO DAL LOCALE: nessuna fonte esplicita.');
      if ('allergeni' in item) {
        if (!Array.isArray(item.allergeni)) add('error', `${itemPath}.allergeni`, 'Allergeni deve essere una lista da 1 a 14.');
        else {
          const normalized = item.allergeni.map(String);
          if (!normalized.length) add('warning', `${itemPath}.allergeni`, 'ALLERGENI NON CONFERMATI DAL LOCALE: lista vuota; chiedere conferma dell’omissione.');
          normalized.forEach((allergen) => { if (!ALLOWED_ALLERGENS.has(allergen)) add('error', `${itemPath}.allergeni`, `Allergene '${allergen}' non ammesso.`); });
          if (new Set(normalized).size !== normalized.length) add('warning', `${itemPath}.allergeni`, 'Sono presenti allergeni duplicati.');
        }
      } else add('warning', `${itemPath}.allergeni`, 'ALLERGENI NON CONFERMATI DAL LOCALE: chiedere conferma esplicita, non inferire.');
      if ('tag' in item) {
        if (!Array.isArray(item.tag)) add('error', `${itemPath}.tag`, 'Tag deve essere una lista.');
        else {
          const tags = item.tag.filter((tag) => typeof tag === 'string');
          item.tag.forEach((tag) => {
            if (typeof tag !== 'string' || (!ALLOWED_TAGS.has(tag) && !LEGACY_TAGS.has(tag))) add('error', `${itemPath}.tag`, `Tag '${String(tag)}' non supportato.`);
            else if (LEGACY_TAGS.has(tag)) add('warning', `${itemPath}.tag`, `Tag legacy '${tag}': non usarlo in nuovi menu.`);
          });
          if (new Set(tags).size !== tags.length) add('warning', `${itemPath}.tag`, 'Sono presenti tag duplicati.');
        }
      }
    });
  });

  if (languages.length) {
    for (const language of languages) {
      if (!essential.some(([, value]) => localText(value, language))) add('error', 'lingue', `'${language}' è dichiarata ma non compare nei contenuti essenziali.`);
    }
    for (const [path, value] of essential) {
      for (const language of languages) {
        if (!localText(value, language)) {
          add(language === languages[0] ? 'error' : 'warning', path, language === languages[0]
            ? `Manca la lingua principale '${language}'.`
            : `Traduzione '${language}' mancante: avviso non bloccante.`);
        }
      }
    }
  }
  if (menu.telefono && (typeof menu.telefono !== 'string' || ![6, 7, 8, 9, 10, 11, 12, 13, 14, 15].includes(menu.telefono.replace(/\D/g, '').length)))
    add('warning', 'telefono', 'Recapito probabilmente non valido.');
  if (menu.instagram && (typeof menu.instagram !== 'string' || !/^@?[A-Za-z0-9._]{1,30}$/.test(menu.instagram)))
    add('warning', 'instagram', 'Indicare solo l’handle, non un URL.');
  for (const key of ['maps', 'url', 'sito', 'website']) if (menu[key] && (typeof menu[key] !== 'string' || !/^https?:\/\/[^\s/]+/i.test(menu[key])))
    add('warning', key, 'URL probabilmente non valido.');
  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Extract only explicit dish names and numeric prices. No price, allergen,
 * translation or contact is inferred. The returned provenance remains outside
 * the menu JSON so a future exported JSON stays compatible with RenMenu.
 */
export function extractMenuFromText(text, options = {}) {
  const source = String(text || '').replace(/\r/g, '');
  const lines = source.split('\n').map((line, index) => ({ raw: line.trim(), line: index + 1 })).filter(({ raw }) => raw);
  const titleMatch = source.match(/(?:locale|ristorante|menu)\s*[:\-]\s*(.+)/i);
  const explicitTitle = options.name || (titleMatch ? titleMatch[1].trim() : 'Menu da verificare');
  const warnings = [];
  if (!titleMatch && !options.name) warnings.push({ level: 'warning', path: 'nome', message: 'Nome del locale non presente nel testo: etichetta provvisoria.' });

  const menu = { id: slugify(options.slug || explicitTitle), nome: { it: explicitTitle }, lingue: ['it'], sezioni: [] };
  const provenance = [];
  let section = null;
  const ensureSection = () => {
    if (!section) {
      section = { nome: { it: 'Voci estratte' }, voci: [] };
      menu.sezioni.push(section);
      warnings.push({ level: 'warning', path: 'sezioni', message: 'Nessuna intestazione di sezione leggibile: raggruppamento tecnico da rivedere.' });
    }
  };

  for (const entry of lines) {
    const { raw, line } = entry;
    if (/^(?:locale|ristorante|menu)\s*[:\-]/i.test(raw)) continue;
    const heading = raw.match(/^#{1,3}\s*(.+)$/) || raw.match(/^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ &'’/-]{2,})\s*:\s*$/);
    if (heading) {
      section = { nome: { it: heading[1].trim() }, voci: [] };
      menu.sezioni.push(section);
      provenance.push({ path: `sezioni.${menu.sezioni.length - 1}.nome.it`, source: `riga ${line}`, value: heading[1].trim(), status: 'confermato' });
      continue;
    }
    // Require a separator to avoid treating prose as dish data. Price is optional only after a separator.
    const dish = raw.match(/^(.+?)\s*(?:—|–|-)\s*(.*)$/);
    if (!dish || !dish[1].trim()) continue;
    ensureSection();
    const name = dish[1].trim();
    const candidatePrice = dish[2].trim().replace(/^€\s*/, '');
    const explicitPrice = PRICE_PATTERN.test(candidatePrice) ? candidatePrice.replace('.', ',') : '';
    const item = { nome: { it: name }, prezzo: explicitPrice };
    section.voci.push(item);
    const itemPath = `sezioni.${menu.sezioni.indexOf(section)}.voci.${section.voci.length - 1}`;
    provenance.push({ path: `${itemPath}.nome.it`, source: `riga ${line}`, value: name, status: 'confermato' });
    provenance.push({ path: `${itemPath}.prezzo`, source: explicitPrice ? `riga ${line}` : 'nessuna fonte', value: explicitPrice || '—', status: explicitPrice ? 'confermato' : 'da_verificare' });
    if (!explicitPrice) warnings.push({ level: 'warning', path: `${itemPath}.prezzo`, message: `'${name}': prezzo non esplicito, non è stato inventato.` });
  }

  menu.sezioni = menu.sezioni.filter((candidate) => candidate.voci.length || candidate.nome.it !== 'Voci estratte');
  if (!menu.sezioni.length) warnings.push({ level: 'warning', path: 'sezioni', message: 'Nessuna voce nel formato “Nome — 12,00” trovata.' });
  const validation = validateMenu(menu);
  return { menu, provenance, warnings: [...warnings, ...validation.warnings], validation };
}

const itemMap = (menu) => new Map((menu?.sezioni || []).flatMap((section) =>
  (section.voci || []).map((item) => [`${section.nome?.it || section.nome}::${item.nome?.it || item.nome}`, { section, item }])));

/** Produce an editorial, field-level diff which never mutates either menu. */
export function menuDiff(previous, next) {
  const changes = [];
  const previousSections = new Map((previous?.sezioni || []).map((section) => [section.nome?.it || section.nome, section]));
  const nextSections = new Map((next?.sezioni || []).map((section) => [section.nome?.it || section.nome, section]));
  for (const name of previousSections.keys()) if (!nextSections.has(name)) changes.push({ type: 'section_removed', label: name, before: name, after: null });
  for (const name of nextSections.keys()) if (!previousSections.has(name)) changes.push({ type: 'section_added', label: name, before: null, after: name });
  const beforeItems = itemMap(previous);
  const afterItems = itemMap(next);
  for (const [key, value] of beforeItems) {
    if (!afterItems.has(key)) changes.push({ type: 'item_removed', label: value.item.nome?.it || value.item.nome, before: value.item.prezzo ?? '', after: null });
  }
  for (const [key, value] of afterItems) {
    if (!beforeItems.has(key)) changes.push({ type: 'item_added', label: value.item.nome?.it || value.item.nome, before: null, after: value.item.prezzo ?? '' });
    else {
      const oldValue = beforeItems.get(key).item.prezzo ?? '';
      const newValue = value.item.prezzo ?? '';
      if (oldValue !== newValue) changes.push({ type: 'price_changed', label: value.item.nome?.it || value.item.nome, before: oldValue, after: newValue });
    }
  }
  return { changes, summary: { added: changes.filter((change) => change.type.endsWith('added')).length, removed: changes.filter((change) => change.type.endsWith('removed')).length, changed: changes.filter((change) => change.type === 'price_changed').length } };
}

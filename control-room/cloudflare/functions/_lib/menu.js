// Independent server-side rules. scripts/validate-menus.py remains the publication authority.
const PRICE = /^\d+(?:[,.]\d{1,2})?$/;
const TAGS = new Set(['veg', 'vegan', 'spicy', 'gf', 'new', 'top', 'frozen']);
const LEGACY = new Set(['hot', 'riserva']);
const LANGS = new Set(['it', 'en', 'de', 'fr', 'es']);
const PUBLIC_ROOT = new Set(['id', 'nome', 'sottotitolo', 'indirizzo', 'telefono', 'instagram', 'maps', 'orari', 'wifi', 'avviso', 'coperto', 'note', 'sezioni', 'lingue', 'url', 'sito', 'website']);
const PUBLIC_SECTION = new Set(['nome', 'descrizione', 'voci']);
const PUBLIC_ITEM = new Set(['nome', 'descrizione', 'prezzo', 'allergeni', 'tag']);
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
  for (const key of ['indirizzo', 'telefono', 'instagram', 'maps', 'wifi', 'coperto', 'url', 'sito', 'website'])
    if (key in menu && typeof menu[key] !== 'string') errors.push(`menu.${key}: serve testo pubblico, non un oggetto tecnico.`);
  for (const [si, section] of (Array.isArray(menu.sezioni) ? menu.sezioni : []).entries()) {
    allowed(section, PUBLIC_SECTION, `sezioni.${si}`);
    if (section && typeof section === 'object' && !Array.isArray(section)) {
      for (const key of ['nome', 'descrizione']) if (key in section) publicText(section[key], `sezioni.${si}.${key}`);
      for (const [vi, item] of (Array.isArray(section.voci) ? section.voci : []).entries()) {
        allowed(item, PUBLIC_ITEM, `sezioni.${si}.voci.${vi}`);
        if (item && typeof item === 'object' && !Array.isArray(item))
          for (const key of ['nome', 'descrizione']) if (key in item) publicText(item[key], `sezioni.${si}.voci.${vi}.${key}`);
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
    if (!Array.isArray(section.voci) || !section.voci.length) { errors.push(`${sl}: nessun piatto.`); continue; }
    for (const [vi, item] of section.voci.entries()) {
      const label = `${sl}, voce ${vi + 1}`;
      if (!item || typeof item !== 'object' || Array.isArray(item)) { errors.push(`${label}: voce non valida.`); continue; }
      if (!text(item.nome)) errors.push(`${label}: nome mancante.`);
      else essential.push([label, item.nome]);
      if ('prezzo' in item) {
        const p = item.prezzo;
        if (p === '') warnings.push(`${label}: prezzo assente; verificare la fonte.`);
        else if (typeof p === 'boolean' || (typeof p === 'number' && (!Number.isFinite(p) || p <= 0)) ||
          (typeof p !== 'number' && (typeof p !== 'string' || !PRICE.test(p.trim()) || Number(p.replace(',', '.')) <= 0))) errors.push(`${label}: prezzo non valido.`);
      } else warnings.push(`${label}: prezzo non presente nella fonte.`);
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
export function venueFromSource(source) {
  for (const line of String(source || '').split(/\r?\n/)) {
    const match = line.trim().match(VENUE_LINE);
    if (match) return match[1].trim();
  }
  return '';
}

export function extractMenuFromText(venue, source, requestedSlug) {
  const slug = slugify(requestedSlug || venue);
  const items = [], unknown = [], provenance = [];
  let section = { nome: { it: 'Dal materiale ricevuto' }, voci: [] };
  const sections = [section];
  const lines = String(source || '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const row = lines[index].trim().replace(/^[-•*]\s*/, '');
    if (!row) continue;
    if (VENUE_LINE.test(row)) continue; // Nome del locale: gestito dal chiamante, non è un piatto.
    // Titolo di sezione: "# Primi" o "#Primi" (come nella demo) oppure "[Primi]".
    if (/^#{1,3}\s*[^\s#]/.test(row) || /^\[[^\]]+\]$/.test(row)) {
      const title = row.replace(/^#{1,3}\s*|^\[|\]$/g, '').trim();
      if (title) {
        section = { nome: { it: title.slice(0, 100) }, voci: [], line: lineNumber };
        sections.push(section);
      }
      continue;
    }
    const match = row.match(/^(.{2,150}?)\s*(?:[—–\-:\t]|\.{2,})\s*(?:€\s*)?(\d{1,4}(?:[,.]\d{1,2})?)\s*€?$/);
    if (match) {
      const name = match[1].trim();
      const price = match[2].replace('.', ',');
      if (name && Number(price.replace(',', '.')) > 0) {
        const item = { nome: { it: name }, prezzo: price };
        section.voci.push(item);
        items.push({ name, price, sourceLine: row, line: lineNumber });
        continue;
      }
    }
    unknown.push(row.slice(0, 220));
  }
  const kept = sections.filter((s) => s.voci.length);
  // Provenienza: ogni nome e prezzo punta alla riga del testo ricevuto da cui è stato letto.
  kept.forEach((s, sectionIndex) => {
    if (s.line) provenance.push({ path: `sezioni.${sectionIndex}.nome.it`, source: `riga ${s.line}`, value: s.nome.it, status: 'confermato' });
    s.voci.forEach((item, itemIndex) => {
      const found = items.find((entry) => entry.name === item.nome.it && entry.price === item.prezzo);
      const where = found ? `riga ${found.line}` : 'nessuna fonte';
      provenance.push({ path: `sezioni.${sectionIndex}.voci.${itemIndex}.nome.it`, source: where, value: item.nome.it, status: 'confermato' });
      provenance.push({ path: `sezioni.${sectionIndex}.voci.${itemIndex}.prezzo`, source: where, value: item.prezzo, status: 'confermato' });
    });
  });
  const menu = { id: slug, nome: venue.trim(), lingue: ['it'], sezioni: kept.map(({ nome, voci }) => ({ nome, voci })) };
  return { menu, extracted: items, uncertain: unknown, provenance, warnings: [
    'Allergeni, ingredienti, coperto, contatti e traduzioni non sono stati dedotti.',
    ...(unknown.length ? [`${unknown.length} righe senza prezzo o formato riconosciuto richiedono controllo.`] : [])
  ] };
}

export function menuDiff(before, after) {
  const index = (menu) => new Map((menu?.sezioni || []).flatMap((section) => (section.voci || []).map((item) => [
    `${typeof section.nome === 'object' ? section.nome.it : section.nome} / ${typeof item.nome === 'object' ? item.nome.it : item.nome}`,
    String(item.prezzo ?? '')
  ])));
  const previous = index(before), next = index(after), changes = [];
  for (const [name, price] of next) {
    if (!previous.has(name)) changes.push({ type: 'aggiunto', name, after: price });
    else if (previous.get(name) !== price) changes.push({ type: 'prezzo', name, before: previous.get(name), after: price });
  }
  for (const [name, price] of previous) if (!next.has(name)) changes.push({ type: 'rimosso', name, before: price });
  return changes;
}

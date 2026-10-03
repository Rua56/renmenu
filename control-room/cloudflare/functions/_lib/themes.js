/* Temi grafici del menu Standard (campo pubblico "tema", letto da menu/index.html sul sito).
 * Jarvis propone il tema dal nome del locale; Riccardo lo conferma o lo cambia in Revisione. */
export const THEMES = {
  bordeaux: 'Bordeaux classico',
  trattoria: 'Verde trattoria',
  mare: 'Blu mare',
  terracotta: 'Terracotta',
  notte: 'Nero elegante',
  sole: 'Ocra caffè'
};
const RULES = [
  ['notte', /cocktail|lounge|wine ?bar|enoteca|vineria|bistrot|sushi|club|speakeasy|american bar/],
  ['mare', /pesce|\bmare\b|porto|marina|\blido\b|spiaggia|ancora|pescheria|frutti di mare|\bcrudo|ostric|baia/],
  ['sole', /\bbar\b|caff|gelat|pasticc|colazion|bakery|panific|chiosco|cornett|brunch|\btea\b/],
  ['trattoria', /trattoria|osteria|agritur|locanda|frasca|malga|\bbio\b|vegan|veget|fattoria|cascina/],
  ['terracotta', /pizz|brace|grill|griglia|forno|bbq|tavern|messic|burger|hamburger|kebab|steak/]
];
const norm = (v) => String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/** Tema proposto dal nome del locale (o, se esplicito, dal testo: «ristorante di pesce», «pizzeria»…). */
export function proposeTheme(venue, sourceText = '') {
  const name = norm(venue);
  const byName = RULES.find(([, rx]) => rx.test(name));
  if (byName) return { tema: byName[0], why: `dal nome «${String(venue).trim()}»` };
  const text = norm(sourceText).slice(0, 4000);
  const explicit = [['mare', /ristorante di pesce|specialita di (pesce|mare)|cucina di mare/], ['terracotta', /\bpizzeria\b|\bbraceria\b/], ['notte', /cocktail bar|wine bar/], ['trattoria', /\btrattoria\b|\bosteria\b/]]
    .find(([, rx]) => rx.test(text));
  if (explicit) return { tema: explicit[0], why: 'dal testo della richiesta' };
  return { tema: 'bordeaux', why: 'tema predefinito' };
}

// Richiesta esplicita di colori/tema («tema blu mare», «sui toni del verde», «colori più scuri»).
// Serve una parola di contesto (tema, colori, toni, grafica…) per non confondere «salsa verde» con un tema.
const THEME_WORDS = [
  ['mare', /blu|azzurr|celest|mare|marin|oceano/],
  ['trattoria', /verd|oliva|salvia|bosco|trattoria/],
  ['terracotta', /terracott|arancio|aranci|mattone|ruggine|rame/],
  ['notte', /ner[oia]|scur|elegant|notte|nero e oro|oro/],
  ['sole', /ocra|giall|sole|senape|caff/],
  ['bordeaux', /bordeaux|bordo|rosso|vino|amaranto|classic/]
];
const CONTEXT = /\b(tema|temi|color[ei]|colorazion\w*|ton[oi]|tonalita|tinta|grafica|palette|sfondo|stile|look|aspetto)\b/;
const NAMED = /\b(?:tema|stile)\s+(bordeaux|trattoria|mare|terracotta|notte|sole)\b/;
export function themeFromText(text) {
  const lines = norm(text).split(/\r?\n|(?<=[.!?;])\s+/);
  for (const line of lines) {
    const named = line.match(NAMED);
    if (named) return { tema: named[1], source: line.trim().slice(0, 200) };
    if (!CONTEXT.test(line)) continue;
    const window = line.slice(Math.max(0, line.search(CONTEXT) - 60), line.search(CONTEXT) + 90);
    const hit = THEME_WORDS.find(([, rx]) => rx.test(window));
    if (hit) return { tema: hit[0], source: line.trim().slice(0, 200) };
  }
  return null;
}

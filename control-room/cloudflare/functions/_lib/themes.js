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

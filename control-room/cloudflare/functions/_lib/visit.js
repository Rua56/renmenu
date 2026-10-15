// Modalità visita: Riccardo è nel locale, fotografa il menù e lo manda a Jarvis con «visita <locale>».
// Jarvis legge subito le foto (senza fare domande sui prezzi in dubbio) e gli rimanda il link
// dell'anteprima da mostrare al titolare. Niente viene inviato al locale né pubblicato.

export const VISIT_CALM_MS = 15_000;
export const visitKey = (requestId) => `visit_${requestId}`;

// Parole che rendono «al/alla/allo» una preposizione e non parte del nome («visita al bar Centrale»).
export const PLACE = /^(?:bar|caff[eè]|osteria|trattoria|ristorante|pizzeria|enoteca|locale|pub|birreria|gelateria|pasticceria|agriturismo|hotel|albergo|bistrot|bistr[oò]|braceria|paninoteca|chiosco|tavern\w*|spaghetteria|wine\s*bar|cocktail\s*bar)(?=\s|$)/i;
const COMMAND = /^\s*(?:jarvis[\s,!.]*)?(?:\/visita\b|(?:modalit[aà]|sono\s+in|in)\s+visita\b|visita\b)\s*(.*)$/i;

/**
 * «visita Bar Centrale» → { venue: 'Bar Centrale' }; «visita» da solo → { venue: '' }; altro → null.
 * Vale solo un messaggio di una riga che comincia con «visita» (anche «/visita», «modalità visita», «sono in visita da …»).
 */
export function parseVisit(text) {
  const line = String(text || '').trim();
  if (!line || /\n/.test(line) || line.length > 120) return null;
  const match = line.match(COMMAND);
  if (!match) return null;
  let rest = match[1].replace(/[\s.!?]+$/, '').trim();
  // «visita il menù del …» o «visita la pratica …» non sono una visita a un locale.
  if (/^(?:il|lo|la|i|gli|le)\s+(?:menu|menù|pratica|bozza|sito)\b/i.test(rest)) return null;
  // «visita di domani al …», «visita finita»: si parla della visita, non se ne apre una.
  if (/^(?:di|del|della|delle|dei|domani|oggi|stasera|dopo|finita|conclusa|terminata|andata|fatta|com[eè]|e)(?=\s|$)/i.test(rest)) return null;
  rest = rest.replace(/^(?:a|da|presso|per|in)\s+/i, '');
  const articled = rest.match(/^(?:all['’]\s*|dall['’]\s*|(?:alla|allo|alle|agli|ai|al|dalla|dallo|dai|dal)\s+)(.*)$/i);
  if (articled && PLACE.test(articled[1])) rest = articled[1];
  rest = rest.replace(/^[«"“']|[»"”']$/g, '').trim();
  if (rest && !/[a-zà-ÿ]{2}/i.test(rest)) return null;
  return { venue: rest.slice(0, 80) };
}

export const visitStartText = (venue, reused = false) =>
  `Modalità visita per «${venue}»${reused ? ' (riprendo la visita già aperta)' : ''}. Mandami le foto del menù, anche più di una, o il PDF: le leggo subito e ti mando il link dell’anteprima da mostrare al titolare. Non invio niente al locale e non pubblico niente.`;

/** Messaggio a Riccardo quando l'anteprima della visita è pronta (vedi il giro dell'orologio di Jarvis). */
export function visitReadyText(venue, link, { items = 0, doubts = 0 } = {}) {
  const left = doubts > 0 ? ` ${doubts === 1 ? 'Una voce aveva' : `${doubts} voci avevano`} il prezzo poco leggibile: ${doubts === 1 ? 'non l’ho messa' : 'non le ho messe'} nell’anteprima, le sistemiamo dopo con calma.` : '';
  return `Anteprima pronta per «${venue}»${items ? ` (${items} voci)` : ''}: aprila e mostrala al titolare dal tuo telefono.\n${link}\n\nÈ solo da guardare: non è pubblicata e non l’ho mandata a nessuno. Il link vale 24 ore.${left}\n\nSe il titolare vuole il menù, la bozza resta in Revisione come una pratica normale.`;
}

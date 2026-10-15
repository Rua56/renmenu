// Numeri di telefono dei clienti: un solo formato (+39…, senza spazi) così WhatsApp riconosce il locale.
// Il numero arriva da WhatsApp come cifre con il prefisso internazionale (es. 393331234567) e viene
// confrontato con clients.phone: se Riccardo scrive «333 123 4567» va salvato come «+393331234567».

/** «333 123 4567», «0481 123456», «0039 333…», «+39 333-…» → «+39…»; null se non è un numero. */
export function normalizePhone(raw) {
  const text = String(raw ?? '').trim();
  if (!text || /[a-z]/i.test(text.replace(/\b(?:tel|cell)\.?\s*:?/gi, ''))) return null;
  let digits = text.replace(/[^\d+]/g, '');
  if (digits.lastIndexOf('+') > 0) return null;
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('00')) digits = digits.slice(2);
  else if (/^[03]\d{5,10}$/.test(digits)) digits = `39${digits}`;
  return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
}

const NUMBER = String.raw`(\+?[\d][\d\s.\/-]{5,22}\d)`;
const KIND = String.raw`(?:numero(?:\s+di\s+telefono)?|telefono|cellulare|whatsapp|n(?:umero)?\.?\s+whatsapp)`;
const ASK_IS = new RegExp(String.raw`^\s*(?:jarvis[\s,!.]*)?(?:il\s+)?${KIND}\s+(?:della|dello|dell[’']|del|di)\s*(.+?)\s+(?:è|e'|e|:)\s*${NUMBER}\s*[.!]*$`, 'i');
const ASK_ADD = new RegExp(String.raw`^\s*(?:jarvis[\s,!.]*)?(?:aggiungi|salva|metti|segna|registra|imposta)\s+(?:il\s+)?${KIND}\s+${NUMBER}\s+(?:alla|allo|all[’']|al|a|per|della|del|di|sul(?:la)?\s+scheda\s+di)\s*(.+?)\s*[.!]*$`, 'i');
const ASK_ADD_TO = new RegExp(String.raw`^\s*(?:jarvis[\s,!.]*)?(?:aggiungi|salva|metti|segna|registra|imposta)\s+(?:alla|allo|all[’']|al|a|per)\s*(.+?)\s+(?:il\s+)?${KIND}\s+${NUMBER}\s*[.!]*$`, 'i');

const ASK_NO_NUMBER = new RegExp(String.raw`^\s*(?:jarvis[\s,!.]*)?(?:aggiungi|salva|metti|segna|registra|imposta|inserisci)\s+(?:il\s+|un\s+)?${KIND}\s+(?:alla|allo|all[’']|al|a|per|della|del|di|sul(?:la)?\s+scheda\s+di)\s*([^\d]+?)\s*[.!]*$`, 'i');

/**
 * «il numero di Trattoria Blanch è 333 1234567», «aggiungi il telefono 333… a Trattoria Blanch»,
 * «salva a Trattoria Blanch il numero 333…» → { venue, number }. «… al menu di …» resta al pulsante
 * «Prenota su WhatsApp» del menu Premium, non è il numero della scheda cliente.
 */
export function parseClientPhone(text) {
  const line = String(text || '').trim();
  if (line.length > 200 || /\bal\s+men[uù]\b/i.test(line)) return null;
  let m = line.match(ASK_IS);
  if (m) return { venue: m[1].trim(), number: m[2].trim() };
  m = line.match(ASK_ADD);
  if (m) return { venue: m[2].trim(), number: m[1].trim() };
  m = line.match(ASK_ADD_TO);
  if (m) return { venue: m[1].trim(), number: m[2].trim() };
  // «registra un numero di telefono per Trattoria Blanch»: manca il numero, Jarvis lo chiede.
  m = line.match(ASK_NO_NUMBER);
  if (m) return { venue: m[1].trim(), number: null };
  return null;
}

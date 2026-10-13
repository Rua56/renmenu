// Risposte brevi ai pulsanti. Quando Jarvis fa una domanda con pulsanti, Riccardo può anche
// rispondere a parole: «la seconda», «entrambe», «sì», «no», «non ora», o una parola del pulsante.
// Qui si sceglie il pulsante corrispondente, solo se la scelta è certa; altrimenti null e la frase
// prosegue verso la comprensione normale. Pubblicare resta un tocco: «sì» non pubblica mai.
const MAX_WORDS = 8;
// Pulsanti che a parole non si possono premere (la policy vuole il tocco esplicito).
const TAP_ONLY = new Set(['pub']);
// Pulsanti che cancellano: a parole valgono solo come «sì» a una domanda di conferma. «La seconda» o
// «entrambe» davanti a un elenco passano invece dal flusso dell'eliminazione, che chiede conferma.
const CONFIRM_FIRST = new Set(['del', 'delc', 'dela']);

const plain = (value) => String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[’']/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
const verbOf = (data) => String(data || '').split(':')[0];

// Le risposte brevi devono essere SOLO la scelta: «metti il coperto a 2» o «fammi vedere prima la bozza»
// non sono «la seconda» o «la prima». Parole di contorno ammesse prima e dopo la scelta.
const LEAD = '(?:(?:si|ok|va bene|allora|direi|scelgo|voglio|prendo|vai con|vada per|metti|elimina|cancella|la|il|lo|l|le|i|quella|quello|quelle|quelli|numero|n|opzione)\\s+)*';
const TAIL = '(?:\\s+(?:opzione|pratica|pratiche|proposta|proposte|scelta|bozza|grazie|pure|allora|va bene|ok|jarvis|riccardo))*';
const exact = (core) => new RegExp(`^${LEAD}(?:${core})${TAIL}$`);
const NO = exact('no|nope|niente|nessun[ao]?|lascia(?: stare| perdere)?|annulla|stop|basta|non (?:ora|adesso|ancora|serve|farlo)|aspetta|dopo|piu tardi|no grazie|no lascia stare');
const NEVER = exact('mai|mai piu|non (?:me )?la proporre piu');
const YES = exact('si|certo|ok|okay|va bene|vai|fallo|falla|procedi|d accordo|confermo|conferma|sicuro|si grazie|si procedi|si fallo');
const ALL = exact('tutt[aei]|entramb[aeio]|ambedue|tutte e (?:due|tre|quattro)|tutti e (?:due|tre|quattro)');
const ORDINALS = ['prim[ao]|1', 'second[ao]|2', 'terz[ao]|3', 'quart[ao]|4', 'quint[ao]|5', 'sest[ao]|6'].map(exact);
const LAST = exact('ultim[ao]');
const STOP = new Set(['la', 'il', 'lo', 'le', 'gli', 'una', 'uno', 'quella', 'quello', 'quelle', 'quelli', 'per', 'con', 'del', 'della', 'dei', 'delle', 'pure', 'grazie', 'jarvis', 'riccardo']);

const isNo = (label, data) => /no$/.test(verbOf(data)) || /:(no|dopo|x)$/.test(String(data)) || /^(no|non|nessun\w*|aspett\w*|lascia)\b/.test(plain(label));
const isNever = (label, data) => /:mai$/.test(String(data)) || /^mai\b/.test(plain(label));
const isAll = (label) => /\btutt[ei]\b/.test(plain(label));
const isYes = (label) => /^(si|fallo|ok|affida|manda|usa|collega|conferma|metti|procedi)\b/.test(plain(label));

/**
 * Sceglie un pulsante da una risposta scritta o detta.
 * buttons: [[etichetta, dato], …]. Ritorna { label, data } oppure { tapOnly: etichetta } oppure null.
 */
export function pickButton(said, buttons) {
  const list = (Array.isArray(buttons) ? buttons : []).filter((b) => Array.isArray(b) && b[0] && b[1]);
  const text = plain(said);
  if (!list.length || !text || text.split(' ').length > MAX_WORDS) return null;
  const choose = (found, confirmed = false) => {
    if (!found) return null;
    const [label, data] = found;
    if (TAP_ONLY.has(verbOf(data))) return { tapOnly: label };
    if (CONFIRM_FIRST.has(verbOf(data)) && !confirmed) return null;
    return { label, data };
  };
  const only = (items) => (items.length === 1 ? items[0] : null);
  const choices = list.filter(([label, data]) => !isNo(label, data) && !isNever(label, data) && !isAll(label));

  if (NEVER.test(text)) return choose(only(list.filter(([l, d]) => isNever(l, d))));
  if (NO.test(text)) {
    const noes = list.filter(([l, d]) => isNo(l, d) && !isNever(l, d));
    return choose(only(noes) || noes.find(([, d]) => /:dopo$/.test(d)) || null);
  }
  if (ALL.test(text)) return choose(only(list.filter(([l]) => isAll(l))));
  const ordinal = LAST.test(text) ? choices.length - 1 : ORDINALS.findIndex((rx) => rx.test(text));
  if (ordinal >= 0 && ordinal < choices.length && choices.length > 1) return choose(choices[ordinal]);
  if (YES.test(text)) {
    const yes = list.filter(([l]) => isYes(l));
    if (yes.length === 1) return choose(yes[0], choices.length === 1);
    if (choices.length === 1) return choose(choices[0], true);
    return null;
  }
  // Parole del pulsante («quella del pranzo», «George»): tutte presenti in un solo pulsante.
  const words = text.split(' ').filter((w) => w.length > 2 && !STOP.has(w));
  if (!words.length || words.length > 4 || /\d/.test(text)) return null;
  return choose(only(list.filter(([label]) => { const l = plain(label); return words.every((w) => l.includes(w)); })));
}

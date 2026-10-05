/* Comprensione naturale dei comandi di Riccardo: riconosce nel testo libero (anche trascritto male)
 * i locali registrati e i piatti dei loro menu, e da parole chiave intuisce il compito. Sono solo
 * indizi: non inventano mai prezzi o piatti e non eseguono nulla da soli. */

import { fixTypos } from './typos.js';

// Parole dei comandi: con un refuso («agiungi», «toglii», «pubblca», «copreto») valgono lo stesso.
const COMMAND_WORDS = ['aggiungi', 'aggiungere', 'togli', 'togliere', 'rimuovi', 'elimina', 'cambia', 'cambiare', 'modifica', 'modificare', 'sostituisci', 'inserisci', 'metti', 'mettere', 'alza', 'abbassa', 'aumenta', 'prezzo', 'prezzi', 'costa', 'coperto', 'telefono', 'numero', 'orari', 'orario', 'aperti', 'chiusi', 'instagram', 'facebook', 'pubblica', 'pubblicare', 'ricorda', 'ricordati', 'memorizza', 'annota', 'esaurito', 'finito', 'terminato', 'disponibile', 'tema', 'colori', 'grafica', 'pratica', 'cliente', 'nuovo', 'nuova', 'crea', 'registra'];

const STOP = new Set(['con', 'alla', 'alle', 'allo', 'agli', 'dal', 'della', 'delle', 'dello', 'degli', 'del', 'nel', 'nella', 'sul', 'sulla', 'una', 'uno', 'gli', 'per', 'tra', 'fra', 'che', 'locale', 'ristorante', 'bar', 'osteria', 'trattoria', 'pizzeria', 'menu']);

export const words = (value) => String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
const keyWords = (value) => words(value).filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));

function distance(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > limit) return limit + 1;
    prev = cur;
  }
  return prev[b.length];
}
/** La parola compare nel testo, tollerando piccoli errori di trascrizione (1 lettera, 2 se lunga). */
const heard = (word, said) => {
  const limit = word.length >= 8 ? 2 : word.length >= 5 ? 1 : 0;
  return said.some((s) => s === word || (limit && Math.abs(s.length - word.length) <= limit && distance(s, word, limit) <= limit));
};

/** Locali registrati nominati nel testo (tutte le parole del nome, o quasi tutte se lungo). */
export function findLocales(text, clients) {
  const said = words(text);
  return clients.map((client) => {
    const name = keyWords(client.name);
    if (!name.length) return null;
    const hits = name.filter((w) => heard(w, said)).length;
    const need = name.length <= 2 ? name.length : Math.ceil(name.length * 0.67);
    return hits >= need ? { client, score: hits / name.length } : null;
  }).filter(Boolean).sort((a, b) => b.score - a.score).map((entry) => entry.client).slice(0, 3);
}

/** Riassunto del menu in memoria → piatti con prezzo (formato di memory.js). */
export function dishesFromSummary(summary) {
  const out = [];
  for (const line of String(summary || '').split('\n').slice(1)) {
    const colon = line.indexOf(': ');
    if (colon < 0) continue;
    for (const item of line.slice(colon + 2).split('; ')) {
      const price = item.match(/\s(\d+(?:[.,]\d{1,2})?) €$/)?.[1] || '';
      const name = item.replace(/\s\d+(?:[.,]\d{1,2})? €$/, '').replace(/\([^)]*\)|\*/g, '').replace(/\s+/g, ' ').trim();
      if (name && name !== 'nessuna voce') out.push({ name, price, section: line.slice(0, colon) });
    }
  }
  return out;
}

/** Piatti citati: la prima parola importante del nome deve comparire nel testo. */
export function findDishes(text, menus) {
  const said = words(text);
  const found = [];
  for (const { client, summary } of menus) {
    for (const dish of dishesFromSummary(summary)) {
      const key = keyWords(dish.name);
      if (!key.length || !heard(key[0], said)) continue;
      const hits = key.filter((w) => heard(w, said)).length;
      found.push({ client, dish, score: hits / key.length });
    }
  }
  return found.sort((a, b) => b.score - a.score).slice(0, 4);
}

const RX = {
  pubblica: /\b(pubblic\w*|metti\w*\s+online|mandal\w*\s+online|vai\s+online|online\s+subito)\b/,
  ricorda: /\b(ricorda\w*\s+che|memorizz\w*|segna\w*\s+che|segnat\w*|annota\w*|tieni\s+a\s+mente|prendi\s+nota)\b/,
  crea: /\b(crea\w*|apri\w*|nuov[ao]|registra\w*|inizia\w*|serve|servirebbe)\b.*\b(pratica|cliente|menu|locale)\b/,
  modifica: /\b(\d+(?:[.,]\d+)?|euro|€|(?:uno|due|tre|quattro|cinque|sei|sette|otto|nove|dieci|undici|dodici|tredici|quattordici|quindici|sedici|diciassette|diciotto|diciannove|venti\w*|trenta\w*|quaranta\w*|cinquanta)|alz\w*|port\w*\s+a|prezz\w*|cost\w*|aument\w*|abbass\w*|scont\w*|togli\w*|tolg\w*|rimuov\w*|elimin\w*|aggiung\w*|inserisc\w*|metti\w*|cambi\w*|modific\w*|sostitu\w*|coperto|tema|temi|color\w*|grafica|telefon\w*|numero|orari\w*|apert\w*|chius\w*|instagram|facebook|finit\w*|esaurit\w*|terminat\w*|non\b[a-z ]{0,30}\bpiu)\b/,
  stato: /\b(situazione|aggiornami|aggiornamento|resoconto|report|riepilogo|novita|buone\s+notizie|come\s+siamo\s+messi|come\s+va\w*|tutto\s+(?:a\s+posto|apposto|ok|bene|regolare)|a\s+che\s+punto|cosa\s+c\s+e\s+da\s+fare|pratiche|problemi|da\s+segnalare|mia\s+attenzione|cosa\s+non\s+va)\b/,
  anteprima: /\b(anteprima|bozza)\b.*\b(mostra\w*|vedere|fammi|mandami|invia\w*)\b|\b(mostra\w*|fammi\s+vedere|mandami|voglio\s+vedere)\b.*\b(anteprima|bozza)\b/,
  domanda: /\?|\b(quant[oiae]|quale|quali|come|cosa|quando|dove|perch\w*|dimmi|sai|mostra\w*|elenca\w*|situazione|riepilog\w*)\b/
};

/** Compito più probabile secondo le parole chiave (usato se il modello non è sicuro). */
export function guessIntent(text, { locales = [], dishes = [] } = {}) {
  // Il nome del locale non conta come parola chiave («Riccardo sei il migliore» non è il numero sei).
  const names = new Set(locales.flatMap((c) => keyWords(c.name)));
  const t = words(fixTypos(text, COMMAND_WORDS, names)).filter((w) => !names.has(w)).join(' ');
  const venue = locales[0]?.name || dishes[0]?.client?.name || '';
  if (RX.anteprima.test(t)) return { intent: 'anteprima', locale: venue };
  if (RX.stato.test(t) && !dishes.length && !RX.crea.test(t)) return { intent: 'stato', locale: '' };
  if (RX.ricorda.test(t)) return { intent: 'ricorda', locale: venue };
  if (RX.crea.test(t) && !dishes.length) return { intent: 'crea_pratica', locale: '' };
  if (RX.pubblica.test(t)) return { intent: 'pubblica', locale: venue };
  if (RX.domanda.test(String(text).toLowerCase()) && !/\b(cambi|togli|aggiung|metti|aument|abbass|alz|inserisc|aggiorn)\w*/.test(t)) return { intent: 'risposta', locale: venue };
  if ((venue || dishes.length) && RX.modifica.test(t)) return { intent: 'aggiorna_menu', locale: venue };
  return { intent: venue || dishes.length ? 'ambiguo' : 'non_chiaro', locale: venue };
}

/** Indizi leggibili per il modello. */
export function hintsText({ locales = [], dishes = [], guess }) {
  const parts = [];
  if (locales.length) parts.push(`Locali registrati riconosciuti nel comando: ${locales.map((c) => `«${c.name}»${c.menu_id ? ' (menu online)' : ' (senza menu online)'}`).join(', ')}.`);
  if (dishes.length) parts.push(`Piatti riconosciuti: ${dishes.map((d) => `«${d.dish.name}»${d.dish.price ? ` ${d.dish.price} €` : ''} di «${d.client.name}»`).join('; ')}.`);
  if (guess && !['non_chiaro', 'ambiguo'].includes(guess.intent)) parts.push(`Dalle parole chiave il compito sembra: ${guess.intent}.`);
  return parts.length ? `INDIZI:\n${parts.join('\n')}` : '';
}

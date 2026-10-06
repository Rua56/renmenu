// Percorso di approvazione prima della pubblicazione reale (decisioni di Riccardo, 2026-10-02):
// 1. revisione interna (prezzi, allergeni, lingue)  2. anteprima al cliente: Jarvis prepara
// link ed email, Riccardo la invia da Gmail  3. approvazione = risposta email chiara del
// cliente, confermata da Riccardo  4. attivazione del servizio obbligatoria per i menu nuovi
// 5-6. conferma finale e pubblicazione. Ogni approvazione vale solo per il contenuto esatto
// (SHA del JSON): qualsiasi modifica alla bozza la rende scaduta.

export const PUBLIC_VIEWER = 'https://renmenu.pages.dev/menu/';
export const APPROVAL_STATUSES = Object.freeze(['anteprima_pronta', 'anteprima_inviata', 'risposta_ricevuta', 'approvata_cliente', 'modifiche_richieste']);
export const ACTIVATIONS = Object.freeze({
  prova_30_giorni: 'Standard: prova gratuita di 30 giorni avviata',
  annuale_pagato: 'Annuale: pagamento ricevuto',
  premium_acconto: 'Premium: acconto ricevuto'
});
export const REFERENCE = /\bRM-[A-HJ-NP-Z2-9]{6}\b/;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function referenceCode(random = crypto.getRandomValues(new Uint8Array(6))) {
  return `RM-${[...random].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('')}`;
}

// Il visualizzatore pubblico legge il menu dal frammento #data= (base64 di UTF-8):
// il frammento non arriva mai al server, quindi l'anteprima non pubblica nulla.
export function previewUrl(menu, lang = 'it') {
  const bytes = new TextEncoder().encode(JSON.stringify(menu));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_');
  return `${PUBLIC_VIEWER}?lang=${lang}#data=${encoded}`;
}

const venueName = (menu) => (typeof menu?.nome === 'string' ? menu.nome : menu?.nome?.it || 'il vostro locale').trim();
const hasAllergens = (menu) => (menu?.sezioni || []).some((section) => (section.voci || []).some((item) => Array.isArray(item.allergeni) && item.allergeni.length));

export function previewEmail({ menu, code, url }) {
  const venue = venueName(menu);
  const languages = (Array.isArray(menu?.lingue) && menu.lingue.length ? menu.lingue : ['it'])
    .map((lang) => ({ it: 'italiano', en: 'inglese', de: 'tedesco', fr: 'francese', es: 'spagnolo', sl: 'sloveno' }[lang] || lang));
  const languageText = languages.length > 1 ? `${languages.slice(0, -1).join(', ')} e ${languages.at(-1)}` : languages[0];
  const subject = `Anteprima del vostro menu digitale RenMenu · rif. ${code}`;
  const lines = [
    'Buongiorno,',
    '',
    `ecco l’anteprima del menu digitale di ${venue}:`,
    url,
    '',
    `Il link mostra il menu come lo vedranno i vostri clienti, in ${languageText}. Non è ancora online.`,
    'Vi chiediamo di controllare con attenzione nomi dei piatti, prezzi e traduzioni.'
  ];
  // Premium su misura: anche la grafica va approvata; il preventivo lo manda Riccardo a parte (nessun totale qui).
  if (menu?.premium && typeof menu.premium === 'object') lines.push('Questa è la proposta grafica su misura: guardate anche colori, caratteri e impaginazione e diteci cosa cambiare.', 'Il preventivo del lavoro su misura ve lo invio a parte.');
  if (!hasAllergens(menu)) lines.push('Gli allergeni non sono indicati perché non ci sono stati comunicati: se volete inserirli, inviateci l’elenco ufficiale.');
  lines.push('', 'Se è tutto corretto, rispondete a questa email scrivendo «Approvo».',
    'Se qualcosa va cambiato, indicatelo nella risposta: prepariamo una nuova anteprima.', '', 'Grazie,', 'Riccardo · RenMenu',
    '', `Riferimento anteprima: ${code}`);
  return { subject, body: lines.join('\n') };
}

// Solo un suggerimento per Riccardo: la decisione resta sua. Una risposta con richieste,
// dubbi o negazioni non viene mai proposta come approvazione.
const CLEAR = /\b(approv[oa]|approviamo|approvato|confermo|confermiamo|va bene|tutto ok|tutto corretto|tutto giusto|ok,? pubblica|pubblicate(lo)?|procedete)\b/i;
const END = '(?=[^A-Za-zÀ-ÿ]|$)';
const DOUBT = new RegExp(`(?:^|[^A-Za-zÀ-ÿ])(?:ma|però|pero|tranne|eccetto|invece|non|anziché|anziche)${END}|(?:modific|cambi|corregg|sbagli|error|errat|manc|aggiung|togli|rimuov|sostitu)|[?]`, 'i');
export function stripQuoted(text) {
  const kept = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (/^\s*>/.test(line)) continue;
    if (/^\s*(il giorno|on .+ wrote:|-----|da:\s|from:\s)/i.test(line)) break;
    kept.push(line);
  }
  return kept.join('\n').trim();
}
export function assessReply(text) {
  const reply = stripQuoted(text);
  if (/^\[Testo parziale/.test(reply)) return { suggestion: 'incerta', reply, note: 'Testo parziale: leggi la risposta completa in Gmail prima di decidere.' };
  if (!reply) return { suggestion: 'vuota', reply, note: 'Risposta vuota o solo testo citato: non vale come approvazione.' };
  if (DOUBT.test(reply.replace(/\bnon vedo l[’']ora\b/gi, ''))) return { suggestion: 'modifiche', reply, note: 'La risposta contiene richieste, dubbi o negazioni: leggila e, se servono modifiche, riapri la revisione.' };
  if (CLEAR.test(reply)) return { suggestion: 'approvazione', reply, note: 'Sembra un’approvazione chiara. Leggi il testo e conferma tu.' };
  return { suggestion: 'incerta', reply, note: 'Non è un’approvazione esplicita: chiedi al locale di rispondere «Approvo».' };
}

export function approvalEvidence(approval) {
  const date = new Date(approval.reply_received_at);
  const day = Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10).split('-').reverse().join('/') : '';
  const excerpt = stripQuoted(approval.reply_text).replace(/\s+/g, ' ').slice(0, 220);
  if (approval.recipient === 'telegram:riccardo')
    return `Anteprima approvata da Riccardo su Telegram${day ? ` il ${day}` : ''} (rif. ${approval.reference_code}): il locale non ha email, pratica aperta da Riccardo.`;
  return `Email del cliente${day ? ` del ${day}` : ''} da ${approval.reply_from} (rif. ${approval.reference_code}): «${excerpt}»`.slice(0, 500);
}

// Approvazione valida solo se confermata da Riccardo e riferita al contenuto attuale.
export function approvalState(approval, currentSha, requestKind) {
  if (!approval) return { valid: false, stale: false, activationMissing: requestKind === 'nuovo' };
  const stale = approval.snapshot_sha !== currentSha;
  return {
    valid: approval.status === 'approvata_cliente' && !stale,
    stale,
    activationMissing: requestKind === 'nuovo' && !approval.activation
  };
}

// Modifiche chieste dal locale nella risposta all'anteprima: Jarvis le legge e le PROPONE.
// Riccardo sceglie quali applicare; nulla viene modificato senza la sua conferma.
// Riconosce solo frasi esplicite: cambio prezzo di un piatto esistente, aggiunta di un
// piatto con prezzo scritto, rimozione di un piatto. Tutto il resto resta "da gestire a mano".
const STOP_WORDS = new Set(['con', 'del', 'della', 'dello', 'dei', 'degli', 'delle', 'al', 'alla', 'allo', 'ai', 'agli', 'alle',
  'di', 'da', 'in', 'il', 'la', 'lo', 'le', 'gli', 'un', 'una', 'nel', 'nella', 'sul', 'sulla']);
const plainWords = (value) => (String(value).toLocaleLowerCase('it-IT').normalize('NFD').replace(/[\u0300-\u036f]/g, '').match(/[a-z]+/g) || []);
const keyWords = (name) => plainWords(name).filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
const PRICE_TOKEN = /(?<![\d,.])(\d{1,4})(?:[,.](\d{1,2}))?(?![\d,.]*\d)\s*(?:€|euro)?/gi;
const money = (whole, cents = '') => `${Number(whole)},${String(cents).padEnd(2, '0')}`;
const italianName = (value) => (typeof value === 'string' ? value : value?.it || '').trim();
import { detectExtra } from './extras.js';
const GREETING = /^(?:grazie|cordiali saluti|saluti|buongiorno|buonasera|ciao|a presto|un saluto)\b/i;

export function proposeReplyChanges(text, menu) {
  // Ogni riga è una frase a sé ("… 50 poi⏎vorrei aggiungere il coperto"), come i punti.
  // Una riga che inizia con una lettera è una frase nuova; "bottiglia⏎22,00" (a capo dell'email
  // dentro la frase) o una riga dopo ":" / "," resta unita.
  const reply = stripQuoted(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    .reduce((acc, line) => (!acc ? line : /[,:;]$/.test(acc) || !/^[A-Za-zÀ-ÿ]/.test(line) ? `${acc} ${line}` : `${acc.replace(/[.!?]$/, '')}. ${line}`), '')
    .replace(/\s+/g, ' ').trim();
  const items = [];
  (menu?.sezioni || []).forEach((section, si) => (section?.voci || []).forEach((item, vi) => {
    const name = italianName(item?.nome);
    items.push({ si, vi, name, keys: keyWords(name), price: String(item?.prezzo ?? '') });
  }));
  const sections = (menu?.sezioni || []).map((section) => italianName(section?.nome));
  const proposals = [];
  const add = (entry) => proposals.push({ id: `p${proposals.length + 1}`, ...entry });
  // "… a 35 euro e il coperto 2 euro": il coperto diventa una frase a parte.
  for (const raw of reply.split(/\.(?=\s|$)|[!;]|,?\s+e\s+(?=(?:anche\s+)?(?:il\s+)?coperto\b)|,?\s+(?:e\s+)?poi(?:\s*,)?\s+(?=[a-zà-ÿ])/i)) {
    // Riempitivi che non fanno parte del nome: "questo piatto:", "nelle informazioni", "anche".
    const sentence = raw.trim().replace(/\b(?:questo|questi|il|un|i|seguente|seguenti|nuovo|nuovi)\s+(?:nuovo\s+)?piatt[oi]\s*:?\s*/gi, '')
      .replace(/\s*\b(?:nelle|nella|tra\s+le)\s+(?:informazioni|info|note)\b/gi, '').replace(/\s+/g, ' ').trim()
      .replace(/^(?:poi|e)\s+/i, '').replace(/\s+(?:poi|e)$/i, '')
      // "Buongiorno, lo spritz ora costa 5": il saluto in testa non nasconde la richiesta.
      .replace(/^(?:buongiorno|buonasera|salve|ciao|gentile\s+riccardo|ciao\s+riccardo)\s*[,!:]\s*(?=\S)/i, '');
    if (!sentence || GREETING.test(sentence) || /^(?:approv\w*|ok|va bene|tutto ok)\W*$/i.test(sentence)) continue;
    const extra = detectExtra(sentence, menu);
    if (extra) { add(extra); continue; }
    const words = new Set(plainWords(sentence));
    const prices = [...sentence.matchAll(PRICE_TOKEN)].map((match) => money(match[1], match[2]));
    const matched = items.filter((item) => item.keys.length && words.has(item.keys[0]))
      .map((item) => ({ ...item, score: item.keys.filter((key) => words.has(key)).length }));
    const best = matched.length ? Math.max(...matched.map((item) => item.score)) : 0;
    const candidates = matched.filter((item) => item.score === best);
    const isAdd = /\b(?:aggiung\w*|inserit\w*|inserire)\b/i.test(sentence);
    const isRemove = /\b(?:togli\w*|tolg\w*|rimuov\w*|elimin\w*|cancell\w*)\b/i.test(sentence);
    if (isAdd) {
      // Sezione indicata dal locale ("nei secondi", "tra i dolci", "nella sezione Pizze"): ha la
      // precedenza sulla scelta automatica e viene tolta dal nome del piatto.
      let named = -1, clean = sentence;
      sections.forEach((title, index) => {
        if (named >= 0 || !title) return;
        const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const phrase = new RegExp(`\\s*\\b(?:nei|negli|nelle|nella|nel|tra\\s+(?:i|gli|le)|fra\\s+(?:i|gli|le)|ai|agli|alle|in|sezione|nella\\s+sezione)\\s+${escaped}\\b`, 'i');
        if (phrase.test(clean)) { named = index; clean = clean.replace(phrase, ' ').replace(/\s+/g, ' ').trim(); }
      });
      const match = clean.match(/\b(?:aggiung\w*|inserit\w*|inserire)\s+(?:anche\s+)?(?:(?:il|lo|la|l['’]|i|gli|le|un|una|uno)\s+)?([^:,\d€—–-]+)(?::|,|-|—|–)?\s*((?:[^\d]*\d[\d,.]*\s*(?:€|euro)?[\s,e]*)+)$/i);
      const base = match ? match[1].trim().replace(/\s+(?:a|al|da|costa|costano|prezzo)$/i, '').trim() : '';
      const rest = match ? match[2] : '';
      const pairs = [...rest.matchAll(/([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ ]{1,30}?)?\s*(\d{1,4})(?:[,.](\d{1,2}))?\s*(?:€|euro)?/gi)]
        .map((pair) => ({ label: (pair[1] || '').trim().replace(/^(?:e|ed)\s+/i, ''), price: money(pair[2], pair[3]) }));
      if (base && pairs.length && pairs.length <= 4) {
        const wine = /\b(?:calice|bottiglia|vino|vini|bicchiere)\b/i.test(sentence);
        const target = wine ? sections.findIndex((name) => /\bvin/i.test(name)) : -1;
        const food = sections.map((name, index) => (/\b(?:vin|bevand|bibit|drink)/i.test(name) ? -1 : index)).filter((index) => index >= 0);
        const section = named >= 0 ? named : target >= 0 ? target : food.length ? food[food.length - 1] : Math.max(0, sections.length - 1);
        const nameBase = base.charAt(0).toLocaleUpperCase('it-IT') + base.slice(1);
        for (const pair of pairs) {
          const name = pairs.length > 1 && pair.label ? `${nameBase} (${pair.label.toLocaleLowerCase('it-IT')})` : nameBase;
          if (items.some((item) => item.name.toLocaleLowerCase('it-IT') === name.toLocaleLowerCase('it-IT'))) continue;
          add({ type: 'aggiungi', name: name.slice(0, 120), price: pair.price, section, source: sentence });
        }
        continue;
      }
    } else if (isRemove && candidates.length === 1) {
      add({ type: 'rimuovi', si: candidates[0].si, vi: candidates[0].vi, name: candidates[0].name, source: sentence });
      continue;
    } else if (candidates.length === 1 && prices.length === 1) {
      const [item] = candidates;
      if (item.price !== prices[0]) add({ type: 'prezzo', si: item.si, vi: item.vi, name: item.name, before: item.price, after: prices[0], source: sentence });
      continue;
    }
    add({ type: 'manuale', source: sentence, note: candidates.length > 1 ? `Più piatti possibili: ${candidates.map((item) => item.name).join(', ')}.` : 'Jarvis non riconosce una modifica precisa: gestiscila a mano nel Builder.' });
  }
  return proposals;
}

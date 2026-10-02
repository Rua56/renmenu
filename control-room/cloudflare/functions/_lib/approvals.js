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
    .map((lang) => ({ it: 'italiano', en: 'inglese', de: 'tedesco', fr: 'francese', es: 'spagnolo' }[lang] || lang));
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

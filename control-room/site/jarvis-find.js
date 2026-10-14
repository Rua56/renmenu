/* «Cosa vuoi fare?»: scrivi o di' due parole («anteprima», «schede vini», «foto», «QR») e Jarvis ti porta
 * dritto al punto giusto della Control Room, anche dentro la pratica di un locale («foto Al Tralcio»).
 * Tutto nel browser: un elenco fisso di funzioni con le parole che le richiamano, nessuna chiamata. */

/**
 * Le funzioni. route: la schermata; find: il titolo del riquadro da raggiungere (testo di un titolo,
 * di un'etichetta o di un pulsante); pratica: lavora sulla pratica scelta; action: un gesto invece di una
 * schermata. Le parole sono già senza accenti e in minuscolo.
 */
export const ACTIONS = [
  { id: 'anteprima-cliente', label: 'Mandare l’anteprima al locale', hint: 'Approvazioni · email con il link di prova', route: 'approvazioni', find: 'PERCORSO DI PUBBLICAZIONE', pratica: true, words: ['anteprima', 'manda', 'mandare', 'inviare', 'invia', 'cliente', 'locale', 'email', 'prova', 'link'] },
  { id: 'pubblica', label: 'Pubblicare il menu', hint: 'Approvazioni · checklist e pubblicazione', route: 'approvazioni', pratica: true, words: ['pubblica', 'pubblicare', 'pubblicazione', 'online', 'approvazioni', 'approva', 'conferme', 'pr'] },
  { id: 'vedi-menu', label: 'Vedere il menu come lo vede il cliente', hint: 'Anteprima della bozza', route: 'anteprima', pratica: true, words: ['vedi', 'vedere', 'guarda', 'anteprima', 'menu', 'bozza', 'come', 'appare', 'renderer'] },
  { id: 'qr', label: 'Link e QR del menu', hint: 'Anteprima · link e QR provvisorio', route: 'anteprima', find: 'LINK E QR', pratica: true, words: ['qr', 'qrcode', 'codice', 'link', 'indirizzo', 'url'] },
  { id: 'modifica', label: 'Cambiare nomi o prezzi a mano', hint: 'Modifica a mano · voce per voce', route: 'modifica', pratica: true, words: ['modifica', 'modificare', 'cambia', 'cambiare', 'correggi', 'correggere', 'prezzo', 'prezzi', 'nome', 'nomi', 'piatto', 'piatti', 'voce', 'voci', 'togli', 'aggiungi'] },
  { id: 'revisione', label: 'Revisione della bozza', hint: 'Revisione · tutti i controlli della pratica', route: 'revisione', pratica: true, words: ['revisione', 'rivedi', 'rivedere', 'bozza', 'controlla'] },
  { id: 'schede', label: 'Schede dei vini e descrizioni dei piatti', hint: 'Revisione · Premium', route: 'revisione', find: 'SCHEDE PREMIUM', pratica: true, words: ['schede', 'scheda', 'vini', 'vino', 'cantina', 'cantine', 'descrizioni', 'descrizione', 'sommelier', 'bottiglie', 'bottiglia', 'etichette'] },
  { id: 'foto', label: 'Foto per il menu', hint: 'Revisione · foto del cliente da piazzare', route: 'revisione', find: 'FOTO DEL CLIENTE', pratica: true, words: ['foto', 'fotografie', 'immagini', 'immagine', 'piazza', 'carica'] },
  { id: 'tema', label: 'Aspetto del menu (tema grafico)', hint: 'Revisione · colori e stile', route: 'revisione', find: 'ASPETTO DEL MENU', pratica: true, words: ['aspetto', 'tema', 'grafica', 'grafico', 'colori', 'colore', 'stile', 'font', 'look'] },
  { id: 'premium', label: 'Scheda creativa Premium', hint: 'Revisione · direzioni grafiche su misura', route: 'revisione', find: 'PREMIUM SU MISURA', pratica: true, words: ['premium', 'creativa', 'direzioni', 'misura', 'bakaro'] },
  { id: 'da-sistemare', label: 'Righe da sistemare o confermare', hint: 'Revisione · controllo riga per riga', route: 'revisione', find: 'CONTROLLO RIGA PER RIGA', pratica: true, words: ['sistemare', 'controllo', 'controllare', 'dubbi', 'dubbio', 'righe', 'riga', 'confermare', 'errori', 'verifica'] },
  { id: 'rifai', label: 'Rifare la bozza', hint: 'Revisione · rileggi le foto da capo', route: 'revisione', find: 'RIFAI LA BOZZA', pratica: true, words: ['rifai', 'rifare', 'rileggi', 'rileggere', 'ricomincia', 'bozza', 'nuova'] },
  { id: 'affida', label: 'Affidare la pratica a Jarvis', hint: 'Revisione · Jarvis segue anteprima e pubblicazione', route: 'revisione', find: ['AFFIDA A JARVIS', 'JARVIS AL LAVORO'], pratica: true, words: ['affida', 'affidare', 'jarvis', 'segui', 'automatico', 'pensaci'] },
  { id: 'traduci', label: 'Tradurre in inglese', hint: 'Revisione · traduzione con Jarvis', route: 'revisione', find: 'Modifica avanzata', pratica: true, words: ['traduci', 'tradurre', 'traduzione', 'traduzioni', 'inglese', 'lingue', 'lingua', 'english'] },
  { id: 'json', label: 'Modifica avanzata (JSON)', hint: 'Revisione · il file del menu', route: 'revisione', find: 'Modifica avanzata', pratica: true, words: ['json', 'avanzata', 'codice', 'file'] },
  { id: 'riordina', label: 'Riordinare le sezioni', hint: 'Revisione · ordine delle sezioni', route: 'revisione', find: 'ORDINE SEZIONI', pratica: true, words: ['riordina', 'riordinare', 'ordine', 'sezioni', 'sezione', 'sposta', 'categorie'] },
  { id: 'nuova-voce', label: 'Aggiungere una voce al menu', hint: 'Revisione · nuova voce con fonte', route: 'revisione', find: 'NUOVA VOCE', pratica: true, words: ['aggiungi', 'aggiungere', 'nuova', 'voce', 'piatto', 'vino'] },
  { id: 'checklist', label: 'Checklist: prezzi, allergeni, lingue', hint: 'Revisione · controlli prima della pubblicazione', route: 'revisione', find: 'CHECKLIST', pratica: true, words: ['checklist', 'allergeni', 'allergene', 'evidenze', 'evidenza', 'controlli', 'spunta'] },
  { id: 'fonti', label: 'Foto e file originali del locale', hint: 'Revisione · materiali privati della pratica', route: 'revisione', find: 'FONTE ORIGINALE', pratica: true, words: ['originali', 'originale', 'fonte', 'fonti', 'materiali', 'allegati', 'file', 'pdf', 'foto'] },
  { id: 'carica', label: 'Caricare un materiale', hint: 'Materiali · aggiungi foto o PDF a una pratica', route: 'materiali', find: 'CARICAMENTO', pratica: true, words: ['carica', 'caricare', 'upload', 'materiale', 'materiali', 'pdf', 'allega'] },
  { id: 'richiesta', label: 'Registrare una richiesta nuova', hint: 'Richieste · nuova pratica a mano', route: 'richieste', find: 'NUOVA PRATICA', words: ['nuova', 'richiesta', 'richieste', 'registra', 'pratica', 'crea', 'apri'] },
  { id: 'pratiche', label: 'Tutte le pratiche', hint: 'Elenco con filtri', route: 'pratiche', words: ['pratiche', 'tutte', 'elenco', 'lista', 'chiuse', 'aperte'] },
  { id: 'locali', label: 'I locali', hint: 'Elenco dei locali', route: 'locali', words: ['locali', 'locale', 'ristoranti', 'clienti', 'elenco'] },
  { id: 'cliente', label: 'Scheda del cliente (email, telefono, piano, rinnovo)', hint: 'Schede cliente', route: 'clienti', find: 'SCHEDA CLIENTE COLLEGATA', words: ['scheda', 'cliente', 'email', 'telefono', 'piano', 'rinnovo', 'pagamento', 'referente', 'contatti', 'anagrafica'] },
  { id: 'nuovo-cliente', label: 'Aggiungere un locale', hint: 'Schede cliente · nuova anagrafica', route: 'clienti', find: 'NUOVA ANAGRAFICA', words: ['nuovo', 'aggiungi', 'locale', 'cliente', 'anagrafica', 'crea'] },
  { id: 'memoria', label: 'Cosa ricorda Jarvis di un locale', hint: 'Schede cliente · memoria di Jarvis', route: 'clienti', find: 'MEMORIA DI JARVIS', words: ['memoria', 'ricorda', 'ricordi', 'preferenze', 'note'] },
  { id: 'numeri', label: 'Grafici e numeri della settimana', hint: 'Oggi · grafici olografici', action: 'numeri', words: ['numeri', 'grafici', 'grafico', 'statistiche', 'andamento', 'settimana', 'trend'] },
  { id: 'registro', label: 'Registro di tutto quello che è successo', hint: 'Registro', route: 'registro', words: ['registro', 'storico', 'log', 'eventi', 'cronologia', 'successo'] },
  { id: 'notifiche', label: 'Notifiche di Jarvis', hint: 'Notifiche', route: 'notifiche', words: ['notifiche', 'notifica', 'avvisi', 'messaggi'] },
  { id: 'impostazioni', label: 'Collegamenti, voce, suoni, «Ehi Jarvis»', hint: 'Oggi · Collegamenti e voce di Jarvis', route: 'command', find: ['Collegamenti e voce di Jarvis', 'Collega Telegram'], words: ['impostazioni', 'collegamenti', 'voce', 'suoni', 'sveglia', 'ehi', 'telegram', 'chiave', 'gemini', 'elevenlabs', 'briefing', 'installa', 'app', 'telefono', 'lettura'] },
  { id: 'email-arrivo', label: 'Email in arrivo', hint: 'Sistema · casella business', route: 'sistema', find: 'EMAIL IN ARRIVO', words: ['email', 'posta', 'casella', 'arrivo', 'gmail', 'inbox'] },
  { id: 'parla', label: 'Parlare con Jarvis', hint: 'Conversazione a voce o scritta', action: 'parla', words: ['parla', 'parlare', 'chiedi', 'chiedere', 'jarvis', 'chat', 'voce', 'conversazione'] },
  { id: 'tema-scuro', label: 'Tema chiaro o scuro', hint: 'Cambia i colori della Control Room', action: 'tema', words: ['chiaro', 'scuro', 'notte', 'giorno', 'tema'] }
];

// Le più usate, quando la casella è ancora vuota.
export const COMMON = ['anteprima-cliente', 'modifica', 'foto', 'schede', 'qr', 'pubblica', 'cliente', 'numeri'];

const STOP = new Set(['il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'una', 'uno', 'di', 'del', 'della', 'dei', 'delle', 'al', 'alla', 'ai', 'a', 'da', 'in', 'per', 'con', 'su', 'e', 'o', 'che', 'mi', 'si', 'ci', 'voglio', 'vorrei', 'devo', 'come', 'faccio', 'fare', 'dove', 'dov', 'trovo', 'apri', 'aprimi', 'vai', 'portami', 'mostra', 'mostrami', 'jarvis']);
export const norm = (text) => String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’'`]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
const tokens = (text) => norm(text).split(' ').filter((t) => t.length > 1 && !STOP.has(t));

// Quanto una parola cercata somiglia a una parola della funzione (intera, inizio, o radice comune).
function wordScore(query, word) {
  if (query === word) return 3;
  if (word.startsWith(query) && query.length >= 3) return 2;
  if (query.startsWith(word) && word.length >= 4) return 2;
  const stem = Math.min(query.length, word.length) - 1;
  if (stem >= 4 && query.slice(0, stem) === word.slice(0, stem)) return 1.5;
  return 0;
}

/** Il locale nominato nella frase («foto Al Tralcio»): { client, rest } con la frase senza il nome. */
export function venueIn(text, clients = []) {
  const clean = ` ${norm(text)} `;
  let best = null;
  for (const client of clients) {
    const name = norm(client?.name).replace(/^(?:osteria|trattoria|ristorante|enoteca|pizzeria|bar|locanda|agriturismo|caffe|hotel)\s+/, '');
    if (name.length < 3) continue;
    const variants = [name, name.replace(/^(?:al|alla|da|il|la|lo|ai|le)\s+/, '')].filter((v) => v.length >= 3);
    const hit = variants.find((v) => clean.includes(` ${v} `));
    if (hit && (!best || hit.length > best.hit.length)) best = { client, hit };
  }
  if (!best) return { client: null, rest: text };
  return { client: best.client, rest: clean.replace(` ${best.hit} `, ' ').replace(/\s+/g, ' ').trim() };
}

/**
 * Le funzioni che corrispondono alla frase, dalla più adatta. Ogni risultato: { ...azione, score }.
 * Senza parole utili restituisce le più usate (score 0).
 */
export function findActions(query, { limit = 6 } = {}) {
  const words = tokens(query);
  if (!words.length) return COMMON.map((id) => ({ ...ACTIONS.find((a) => a.id === id), score: 0 })).slice(0, limit);
  const labelWords = (action) => tokens(action.label);
  return ACTIONS
    .map((action, index) => {
      const pool = [...new Set([...action.words, ...labelWords(action)])];
      let score = 0, matched = 0;
      for (const w of words) {
        const best = Math.max(0, ...pool.map((p) => wordScore(w, p)));
        if (best) { score += best; matched += 1; }
      }
      // Conta di più chi copre tutte le parole cercate; a parità vince l'ordine dell'elenco (le più comuni prima).
      if (matched === words.length) score += 2;
      return { ...action, score: score - index / 1000 };
    })
    .filter((a) => a.score >= 1.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Frase di navigazione detta a Jarvis («apri le schede dei vini», «dov'è il QR», «portami alle foto»)? */
export function navigationPhrase(text) {
  const match = norm(text).match(/^(?:jarvis\s+)?(?:apri(?:mi)?|vai (?:a|al|alla|alle|ai|agli|in|nelle?)|portami (?:a|al|alla|alle|ai|agli|in|nelle?)|dov e|dove (?:trovo|sono|sta|si trova|si trovano|posso)|come (?:faccio a|si fa a|posso))\b\s*(.*)$/);
  return match && match[1] ? match[1] : null;
}

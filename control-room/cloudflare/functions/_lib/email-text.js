/* Preparazione del testo di una email prima della lettura (7-9 ottobre 2026).
 *
 * I programmi di posta vanno a capo da soli ogni ~75 caratteri: una riga del menu come
 *   «Ribolla Gialla spumante brut, Azienda Zorzettig: 6 € al
 *    calice, 28 € in bottiglia»
 * arriva spezzata in due righe, e ciascuna metà da sola non ha senso (né come piatto né come prezzo).
 * Qui le righe spezzate si riuniscono nella prima, e la continuazione resta una riga VUOTA:
 * il numero di righe non cambia mai, così «riga N» nelle note e nella provenienza è sempre quella
 * dell'email originale (che resta com'è, intatta, nella pratica).
 *
 * Riunisce solo se il testo è davvero «a colonna»: quasi tutte le righe lunghe si fermano alla stessa
 * larghezza. Un testo scritto a mano (Telegram, Control Room), con una riga per voce, non viene toccato. */

const BULLET = /^\s*(?:[•·▪◦‣⁃*#>]|[-–—]\s|\[|\d{1,2}[.)]\s)/;
const SENTENCE_END = /[.!?:;]\s*$/;
const PRICE_END = /(?:€|euro|eur|\d)\s*$/i;

export function wrapWidth(lines) {
  const body = lines.filter((l) => !/^\s*oggetto(?: ricevuto)?\s*:/i.test(l) && l.length <= 100);
  const width = body.reduce((m, l) => Math.max(m, l.length), 0);
  if (width < 60) return 0;
  // Colonna vera: almeno 4 righe vicine al massimo (le righe spezzate si fermano tutte lì).
  const near = body.filter((l) => l.length >= width - 6).length;
  return near >= 4 ? width : 0;
}

/** Stesso testo, con le righe spezzate dal programma di posta riunite (le continuazioni diventano righe vuote). */
export function prepareEmailSource(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const width = wrapWidth(lines);
  if (!width) return lines.join('\n');
  const out = [...lines];
  for (let i = 0; i < out.length; i += 1) {
    let cursor = i;
    // Una riga può essere spezzata più volte: si riunisce finché la riga successiva è una continuazione.
    while (cursor + 1 < lines.length) {
      const prev = out[i].replace(/\s+$/, ''), next = lines[cursor + 1];
      if (!prev.trim() || !next.trim() || /^\s*oggetto(?: ricevuto)?\s*:/i.test(prev) || BULLET.test(next)) break;
      const first = next.trim().split(/\s+/)[0] || '', len = lines[cursor].replace(/\s+$/, '').length;
      // La riga prima si è fermata vicino al margine (chi scrive va a capo con qualche carattere di scarto):
      // o perché la parola dopo non ci stava più, o perché è a meno di ~12 caratteri dal margine.
      const wrapped = len >= width - 12 || (len + 1 + first.length > width && len >= width - 20);
      if (!wrapped) break;
      const lower = /^[a-zà-ÿ0-9€(,)%]/.test(next.trim());
      // Fine frase seguita da una nuova frase: non è una continuazione.
      if (SENTENCE_END.test(lines[cursor]) && !/^[a-zà-ÿ€(,)%]/.test(next.trim())) break;
      // Riga che finisce con un prezzo seguita da un'altra voce (maiuscola o cifra): è una nuova voce.
      if (PRICE_END.test(lines[cursor]) && !/^[a-zà-ÿ€(,)%]/.test(next.trim())) break;
      if (!lower && !/^[A-ZÀ-Ý]/.test(next.trim())) break;
      out[i] = `${prev} ${next.trim()}`;
      out[cursor + 1] = '';
      cursor += 1;
    }
    i = cursor;
  }
  return out.join('\n');
}

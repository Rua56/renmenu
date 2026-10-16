/* Foto di un menu a parte (menu del pranzo, del giorno, dei bambini…) mandata insieme al menu scritto
 * nell'email. La lettura della foto ha titoli come «Primi» o «Dolci» che spesso esistono già nell'email:
 * senza questo passo i piatti del pranzo finirebbero in sezioni doppie mescolate alla carta.
 * Vale solo per i menu a parte riconosciuti dal nome (pranzo, cena, del giorno, bambini, degustazione…).
 * Il nome del file dice cos'è («menu-del-pranzo.jpg» → «Menu del pranzo»): i titoli della foto diventano
 * «Menu del pranzo · Primi» e le formule a prezzo fisso («Menu completo … 16,00») vanno in testa, sotto
 * «Menu del pranzo». Niente viene inventato: se il nome del file non dice nulla, la foto resta com'è. */

const plain = (v) => String(v || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
// Parole che da sole non dicono che cosa è la foto.
const GENERIC = new Set(['menu', 'menù', 'foto', 'img', 'image', 'immagine', 'scan', 'scansione', 'pagina', 'page', 'whatsapp', 'pdf', 'jpg', 'jpeg', 'png', 'copia', 'nuovo', 'nuova', 'del', 'della', 'dei', 'di', 'il', 'la', 'le', 'lo', 'e', 'carta']);
// Menu a parte riconosciuti anche senza titoli doppi.
const APART = /\b(?:pranzo|cena|giorno|settimana|degustazione|bambini|bimbi|fisso|lavoro|business|domenica|brunch|aperitivo)\b/;
const FORMULA = /^\s*(?:menu|menù)\s+(?:complet|fiss|del giorno|pranzo|lavoro|degustazione|bambin)\w*|^\s*formula\b/i;

/** «menu-del-pranzo.jpg» → «Menu del pranzo»; null se il nome è generico («IMG_2041.jpg», «menu.jpg»). */
export function labelFromFilename(filename) {
  const words = String(filename || '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length || words.length > 6) return null;
  const meaningful = words.filter((w) => /^\p{L}{3,}$/u.test(w) && !GENERIC.has(plain(w)));
  if (!meaningful.length || words.some((w) => /\d{3,}/.test(w))) return null;
  const text = words.join(' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * @param {string} text lettura della foto (righe «# Titolo» e «Piatto — prezzo»)
 * @param {string} filename nome del file
 * @returns {{ text: string, label: string|null }}
 */
export function labelPhotoSections(text, filename) {
  const label = labelFromFilename(filename);
  const lines = String(text || '').split(/\r?\n/);
  const titles = lines.filter((l) => /^\s*#\s*\S/.test(l)).map((l) => plain(l.replace(/^\s*#\s*/, '')));
  if (!label || !titles.length) return { text, label: null };
  // Solo i menu a parte (pranzo, del giorno, bambini…): una seconda pagina della carta resta com'è.
  if (!APART.test(plain(label))) return { text, label: null };
  const formulas = [], rest = [];
  for (const line of lines) {
    if (/^\s*#/.test(line)) { rest.push(`# ${label} · ${line.replace(/^\s*#\s*/, '').trim()}`); continue; }
    if (FORMULA.test(line) && /\d/.test(line)) formulas.push(line); else rest.push(line);
  }
  return { text: [...(formulas.length ? [`# ${label}`, ...formulas] : []), ...rest].join('\n'), label };
}

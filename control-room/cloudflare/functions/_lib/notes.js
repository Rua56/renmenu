/* Cosa Jarvis non ha inserito nella bozza, riga per riga, già diviso per tipo: così Riccardo
 * interviene subito senza cercare nel testo. Nessuna riga viene scartata in silenzio. */
import { themeFromText } from './themes.js';

const norm = (v) => String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const RULES = [
  ['piano', /\b(?:piano|abbonament\w*|annual\w*|standard|premium|al mese|mensil\w*|prova gratuita)\b/, 'Piano: il cliente ne parla qui, sceglilo tu.'],
  ['coperto', /\bcoperto\b/, 'Coperto: non inserito, mettilo nel campo «coperto» se è giusto.'],
  ['allergeni', /\ballergen\w*/, 'Allergeni: non inseriti, servono i dati dal locale.'],
  ['orari', /\b(?:aperti|apriamo|chiusi|chiuso|chiusura|orari\w*)\b|\d{1,2}[:.]\d{2}\s*[-–]/, 'Orari: non inseriti, copiali nel campo «orari».'],
  ['contatti', /\b(?:telefono|tel|cell\w*|whatsapp|instagram|facebook|email|mail|indirizzo|via|piazza)\b|@[a-z0-9_.]{3,}|\b\d{3,4}\s?\d{5,7}\b/, 'Contatti: non inseriti, copiali nei campi del menu.'],
  ['lingue', /\b(?:inglese|tedesc\w*|frances\w*|spagnol\w*|slovenian?\w*|english|traduzion\w*)\b/, 'Lingue: il cliente le chiede qui, controlla quelle della bozza.']
];
const PROSE = /\b(?:buongiorno|buonasera|salve|ciao|grazie|cordiali|saluti|distinti|gentil\w*|vi scrivo|ecco|allego|allegat\w*|ci ha parlato|siamo il|siamo la|siamo un)\b/;

/**
 * @param {{ sourceText?: string, uncertain?: string[], extracted?: Array<{name?: string, line?: number}>, mode?: string }} input
 * @returns {Array<{ kind: string, text: string, hint: string, line: number|null }>}
 */
export function reviewNotes({ sourceText = '', uncertain = [], extracted = [], mode = '' } = {}) {
  const lines = String(sourceText).split(/\r?\n/).map((l) => l.trim());
  const lineOf = (row) => { const i = lines.findIndex((l) => l.replace(/^[-•*]\s*/, '').slice(0, 220) === row || l === row); return i >= 0 ? i + 1 : null; };
  const menuLines = extracted.map((e) => e.line).filter(Number.isFinite);
  const first = menuLines.length ? Math.min(...menuLines) : null, last = menuLines.length ? Math.max(...menuLines) : null;
  const dishKeys = extracted.map((e) => norm(e.name).split(/\s+/).filter((w) => w.length > 2).slice(0, 2).join(' ')).filter((k) => k.length > 4);
  return uncertain.map((raw) => {
    const text = String(raw).replace(/^\[da verificare\]\s*/, '');
    const t = norm(text), line = lineOf(String(raw));
    if (String(raw).startsWith('[da verificare]')) return { kind: 'foto', text, hint: 'Letta in modo diverso dalle due letture della foto: guarda la foto e inseriscila tu.', line };
    const dish = dishKeys.find((key) => t.includes(key));
    if (dish && /\d/.test(t)) return { kind: 'correzione', text, hint: `Possibile correzione per un piatto già in bozza («${dish}»): controlla il prezzo e correggilo tu.`, line };
    const theme = themeFromText(text);
    if (theme) return { kind: 'tema', text, hint: 'Tema grafico richiesto: già proposto nella bozza, confermalo.', line };
    const rules = RULES.filter(([, rx]) => rx.test(t));
    if (rules.length) return { kind: rules[0][0], also: rules.slice(1).map((r) => r[0]), text, hint: rules.map((r) => r[2]).join(' '), line };
    const inside = line && first && line > first && line < last;
    const short = text.length <= 90 && !/[.?!]$/.test(text) && !PROSE.test(t);
    if (mode === 'aggiornamento' || (inside && short) || (short && /\d/.test(t) && !PROSE.test(t))) return { kind: 'piatto', text, hint: 'Riga del menu che Jarvis non ha saputo leggere: aggiungila o correggila tu.', line };
    return { kind: 'testo', text, hint: 'Testo dell’email (saluti, presentazione): nessuna azione, salvo che contenga qualcosa per il menu.', line };
  });
}

export const NOTE_LABELS = { piatto: 'Righe del menu non lette', correzione: 'Correzioni da applicare', foto: 'Righe dubbie delle foto', piano: 'Piano', tema: 'Tema grafico', coperto: 'Coperto', orari: 'Orari', contatti: 'Contatti', allergeni: 'Allergeni', lingue: 'Lingue', testo: 'Altro testo dell’email' };

/** Riassunto breve per Telegram/notifiche: prima le cose che richiedono un intervento. */
export function notesSummary(notes, max = 6) {
  const urgent = notes.filter((n) => n.kind !== 'testo');
  if (!urgent.length) return '';
  const shown = urgent.slice(0, max).map((n) => `• ${[n.kind, ...(n.also || [])].map((k) => NOTE_LABELS[k]).join(' e ')}: «${n.text.slice(0, 80)}»`);
  return `Da sistemare a mano (${urgent.length}):\n${shown.join('\n')}${urgent.length > max ? `\n…e altre ${urgent.length - max} in Revisione.` : ''}`;
}

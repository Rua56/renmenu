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
export function reviewNotes({ sourceText = '', uncertain = [], extracted = [], mode = '', info = null } = {}) {
  const plainRow = (r) => norm(String(r).trim());
  const appliedBy = (row) => (info?.applied || []).filter((a) => plainRow(a.source).includes(plainRow(row).slice(0, 60)) || plainRow(row).includes(plainRow(a.source).slice(0, 60)));
  const doubtsBy = (row) => (info?.doubts || []).filter((d) => d.source && (plainRow(d.source).includes(plainRow(row).slice(0, 60)) || plainRow(row).includes(plainRow(d.source).slice(0, 60))));
  const lines = String(sourceText).split(/\r?\n/).map((l) => l.trim());
  const lineOf = (row) => { const i = lines.findIndex((l) => l.replace(/^[-•*]\s*/, '').slice(0, 220) === row || l === row); return i >= 0 ? i + 1 : null; };
  const menuLines = extracted.map((e) => e.line).filter(Number.isFinite);
  const first = menuLines.length ? Math.min(...menuLines) : null, last = menuLines.length ? Math.max(...menuLines) : null;
  const dishKeys = extracted.map((e) => norm(e.name).split(/\s+/).filter((w) => w.length > 2).slice(0, 2).join(' ')).filter((k) => k.length > 4);
  const notes = uncertain.map((raw) => {
    const text = String(raw).replace(/^\[da verificare\]\s*/, '');
    const t = norm(text), line = lineOf(String(raw));
    if (String(raw).startsWith('[da verificare]')) return { kind: 'foto', text, hint: 'Letta in modo diverso dalle due letture della foto: guarda la foto e inseriscila tu.', line };
    const doubts = doubtsBy(raw), done = appliedBy(raw);
    if (doubts.length) return { kind: 'conferma', text, hint: doubts.map((d) => d.doubt).join(' '), line, also: done.length ? ['inserito'] : [] };
    if (done.length) return { kind: 'inserito', text, hint: `Inserito nel menu: ${done.map((a) => `${INFO[a.field]} ${a.field === 'coperto' ? `${a.value} €` : a.field === 'instagram' ? `@${a.value}` : a.value}${a.fixed ? ' (corretto un refuso)' : ''}${a.check ? ` (${a.check})` : ''}`).join(', ')}. Controlla.`, line };
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
  // Informazioni inserite o in dubbio che non stavano tra le righe incerte (es. aggiornamenti): elencate comunque.
  const covered = (src) => notes.some((n) => plainRow(n.text).includes(plainRow(src).slice(0, 60)) || plainRow(src).includes(plainRow(n.text).slice(0, 60)));
  for (const a of info?.applied || []) if (!covered(a.source)) notes.push({ kind: 'inserito', text: a.source, hint: `Inserito nel menu: ${INFO[a.field]} ${a.field === 'coperto' ? `${a.value} €` : a.field === 'instagram' ? `@${a.value}` : a.value}${a.before ? ` (prima «${a.before}»)` : ''}${a.fixed ? ' (corretto un refuso)' : ''}. Controlla.`, line: a.line || null });
  for (const d of info?.doubts || []) if (!covered(d.source || '')) notes.push({ kind: 'conferma', text: d.source || INFO[d.field], hint: d.doubt, line: d.line || null });
  return notes;
}

const INFO = { coperto: 'Coperto', telefono: 'Telefono', orari: 'Orari', instagram: 'Instagram', facebook: 'Facebook' };
export const NOTE_LABELS = { inserito: 'Inserito da Jarvis', conferma: 'Da confermare', piatto: 'Righe del menu non lette', correzione: 'Correzioni da applicare', foto: 'Righe dubbie delle foto', piano: 'Piano', tema: 'Tema grafico', coperto: 'Coperto', orari: 'Orari', contatti: 'Contatti', allergeni: 'Allergeni', lingue: 'Lingue', testo: 'Altro testo dell’email' };

/** Riassunto breve per Telegram/notifiche: prima le cose che richiedono un intervento. */
export function notesSummary(notes, max = 6) {
  const done = notes.filter((n) => n.kind === 'inserito');
  const urgent = notes.filter((n) => !['testo', 'inserito'].includes(n.kind));
  const parts = [];
  if (done.length) parts.push(`Ho inserito dal testo: ${done.map((n) => n.hint.replace(/^Inserito nel menu: /, '').replace(/\. Controlla\.$/, '')).join('; ')}.`);
  if (urgent.length) {
    const shown = urgent.slice(0, max).map((n) => `• ${[n.kind, ...(n.also || [])].map((k) => NOTE_LABELS[k]).join(' e ')}: «${n.text.slice(0, 80)}»${n.kind === 'conferma' ? ` — ${n.hint.slice(0, 140)}` : ''}`);
    parts.push(`Da sistemare o confermare (${urgent.length}):\n${shown.join('\n')}${urgent.length > max ? `\n…e altre ${urgent.length - max} in Revisione.` : ''}`);
  }
  return parts.join('\n\n');
}

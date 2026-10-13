/* Cosa Jarvis non ha inserito nella bozza, riga per riga, già diviso per tipo: così Riccardo
 * interviene subito senza cercare nel testo. Nessuna riga viene scartata in silenzio. */
import { themeFromText } from './themes.js';

const norm = (v) => String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const MONTH = '(?:gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)';
const RULES = [
  ['preventivo', /\b(?:tempi e prezzi|prezzi e tempi|che tempi|quanto tempo|quanto costa|quanto costerebbe|preventivo|acconto|costi)\b/, 'Il cliente chiede prezzi o tempi, o parla di acconto: rispondi tu. Jarvis non comunica prezzi né tempi.'],
  ['ferie', new RegExp(`\\bferie\\b|\\b(?:ad|in)\\s+${MONTH}\\b.*\\bchi(?:us|ud)|\\bchi(?:us|ud)\\w*.*\\b${MONTH}\\b`), 'Chiusura per ferie: non è un orario settimanale, non la inserisco. Se le date non sono decise, chiedile al cliente.'],
  ['storia', /\b(?:storia|nato nel|nata nel|fondat\w*|mescita|dal\s+(?:19|20)\d\d)\b/, 'Storia del locale: la scrive il cliente, Jarvis non la inventa. Chiedi al cliente il testo e confermalo prima di pubblicare.'],
  ['galleria', /\bgalleria\b|\bfoto\b.*\b(?:domani|whatsapp|vi mando|ve le mando)|\b(?:whatsapp|domani)\b.*\bfoto\b/, 'Foto o galleria: arrivano dal cliente. Nessuna foto viene scelta o inserita da Jarvis senza la tua approvazione.'],
  ['schede', /\bschede\b/, 'Schede dei vini: servono i dati dal cliente (cantina, vitigno, annata). Jarvis non li inventa.'],
  ['servizio', /\bservizio\b.*\b(?:compres\w*|inclus\w*)\b/, 'Servizio compreso: il menu pubblico non ha un campo apposito. Se vuoi mostrarlo, scrivilo tu nelle note del menu.'],
  ['dicitura', /\b(?:scritta|dicitura|vogliamo scrivere|vorremmo scrivere)\b|\bfatt[aeio]\s+in casa\b/, 'Dicitura richiesta dal cliente: non la inserisco da solo, può essere una dichiarazione da verificare (es. sul pane). Decidi tu.'],
  ['stile', /\bpiù sobri\w*|\bsimile a\b|\bqualcosa di simile\b|\bnello stile\b|\bbistrot\b/, 'Richiesta di stile o riferimento: valutala tu (nel Premium è già nella scheda creativa).'],
  ['logo', /\blogo\b/, 'Logo: descritto dal cliente. Serve il file tra i materiali.'],
  ['allegati', /\b(?:in allegato|allego|allegat[aoie])\b/, 'Il cliente cita degli allegati: controlla che siano arrivati tra i materiali, altrimenti chiedili.'],
  ['piano', /\b(?:piano|abbonament\w*|annual\w*|standard|premium|al mese|mensil\w*|prova gratuita)\b/, 'Piano: il cliente ne parla qui, sceglilo tu.'],
  ['coperto', /\bcoperto\b/, 'Coperto: non inserito, mettilo nel campo «coperto» se è giusto.'],
  ['allergeni', /\ballergen\w*|(?:\b\d{1,2}\s+[a-z][a-z ]{2,24},\s*){5,}|\bnumeri\b[^:]{0,60}\b(?:piatti|accanto|sotto)\b/, 'Allergeni: non inseriti nel menu. Se il cliente ha scritto legenda e numeri per piatto, sono nei «Dati scritti dal locale» già divisi piatto per piatto: confermali tu. Per gli altri servono i dati dal locale.'],
  ['orari', /\b(?:aperti|apriamo|chiusi|chiuso|chiusura|orari\w*)\b|\d{1,2}[:.]\d{2}\s*[-–]/, 'Orari: non inseriti, copiali nel campo «orari».'],
  ['contatti', /\b(?:telefono|tel|cell\w*|whatsapp|instagram|facebook|email|mail|indirizzo|via|piazza)\b|@[a-z0-9_.]{3,}|\b\d{3,4}\s?\d{5,7}\b/, 'Contatti: non inseriti, copiali nei campi del menu.'],
  ['lingue', /\b(?:inglese|tedesc\w*|frances\w*|spagnol\w*|slovenian?\w*|english|traduzion\w*)\b/, 'Lingue: il cliente le chiede qui, controlla quelle della bozza.']
];
const PROSE = /\b(?:buongiorno|buonasera|salve|ciao|grazie|cordiali|saluti|distinti|gentil\w*|vi scrivo|ecco|allego|allegat\w*|ci ha parlato|siamo il|siamo la|siamo un)\b/;

/**
 * @param {{ sourceText?: string, uncertain?: string[], extracted?: Array<{name?: string, line?: number}>, mode?: string }} input
 * @returns {Array<{ kind: string, text: string, hint: string, line: number|null }>}
 */
export function reviewNotes({ sourceText = '', uncertain = [], extracted = [], mode = '', info = null, corrections = [] } = {}) {
  const plainRow = (r) => norm(String(r).trim());
  const appliedBy = (row) => (info?.applied || []).filter((a) => plainRow(a.source).includes(plainRow(row).slice(0, 60)) || plainRow(row).includes(plainRow(a.source).slice(0, 60)));
  const doubtsBy = (row) => (info?.doubts || []).filter((d) => d.source && (plainRow(d.source).includes(plainRow(row).slice(0, 60)) || plainRow(row).includes(plainRow(d.source).slice(0, 60))));
  const lines = String(sourceText).split(/\r?\n/).map((l) => l.trim());
  const lineOf = (row) => { const i = lines.findIndex((l) => l.replace(/^[-•*]\s*/, '').slice(0, 700) === row || l === row); return i >= 0 ? i + 1 : null; };
  const menuLines = extracted.map((e) => e.line).filter(Number.isFinite);
  const first = menuLines.length ? Math.min(...menuLines) : null, last = menuLines.length ? Math.max(...menuLines) : null;
  const dishKeys = extracted.map((e) => norm(e.name).split(/\s+/).filter((w) => w.length > 2).slice(0, 2).join(' ')).filter((k) => k.length > 4);
  // Le email arrivano spesso «a capo» ogni ~75 caratteri: le righe della stessa frase diventano una nota sola.
  const rows = [];
  for (const raw of uncertain) {
    if (/^Oggetto ricevuto:/i.test(String(raw))) continue;
    const line = lineOf(String(raw)), prev = rows[rows.length - 1];
    if (prev && line && prev.last && line === prev.last + 1 && !/[.!?:]$/.test(prev.text.trim()) && !String(raw).startsWith('[da verificare]') && prev.text.length > 45) {
      prev.text = `${prev.text} ${String(raw).trim()}`; prev.last = line; continue;
    }
    rows.push({ text: String(raw), line, last: line });
  }
  const classify = (text, line) => {
    const t = norm(text);
    const dish = dishKeys.find((key) => t.includes(key));
    if (dish && /\d/.test(t)) return { kind: 'correzione', text, hint: `Possibile correzione per un piatto già in bozza («${dish}»): controlla il prezzo e correggilo tu.`, line };
    const theme = themeFromText(text);
    if (theme) return { kind: 'tema', text, hint: 'Tema grafico richiesto: già proposto nella bozza, confermalo.', line };
    const rules = RULES.filter(([name, rx]) => rx.test(t) && !(name === 'contatti' && RULES.some(([n, r]) => ['galleria', 'schede', 'storia'].includes(n) && r.test(t)) && !/@|\d{3}/.test(t)));
    if (rules.length) return { kind: rules[0][0], also: rules.slice(1).map((r) => r[0]), text, hint: rules.map((r) => r[2]).join(' '), line };
    const inside = false; // (comportamento storico: «dentro il menu» non è mai stato attivo)
    const short = text.length <= 90 && !/[.?!]$/.test(text) && !PROSE.test(t);
    if (mode === 'aggiornamento' || (inside && short) || (short && /\d/.test(t) && !PROSE.test(t))) return { kind: 'piatto', text, hint: 'Riga del menu che Jarvis non ha saputo leggere: aggiungila o correggila tu.', line };
    const long = /\d/.test(t) || text.length > 90;
    return { kind: 'testo', text, hint: long ? 'Testo dell’email: non ho trovato dati da inserire nel menu. Se contiene una richiesta del cliente, valutala tu.' : 'Testo dell’email (saluti, presentazione): nessuna azione, salvo che contenga qualcosa per il menu.', line };
  };
  const notes = rows.map(({ text: raw, line: first }) => {
    const text = String(raw).replace(/^\[da verificare\]\s*/, '');
    const t = norm(text), line = first;
    if (String(raw).startsWith('[da verificare]')) return { kind: 'foto', text, hint: 'Letta in modo diverso dalle due letture della foto: guarda la foto e inseriscila tu.', line };
    const fix = (corrections || []).find((c) => plainRow(c.source) === plainRow(text) || plainRow(text).includes(plainRow(c.source).slice(0, 60)));
    if (fix) return { kind: 'inserito', text, hint: `Inserito nel menu: correzione ${fix.name} ${fix.before} → ${fix.after} €. Controlla.`, line };
    const doubts = doubtsBy(raw), done = appliedBy(raw);
    const remarks = done.map((a) => a.remark).filter(Boolean);
    const doneText = done.map((a) => `${INFO[a.field]} ${a.field === 'coperto' ? `${a.value} €` : a.field === 'instagram' ? `@${a.value}` : a.value}`).join(', ');
    if (doubts.length) return { kind: 'conferma', text, hint: `${done.length ? `Inserito nel menu: ${doneText}. ` : ''}${[...remarks, ...doubts.map((d) => d.doubt)].join(' ')}`, line, also: done.length ? ['inserito'] : [] };
    if (remarks.length) return { kind: 'conferma', text, hint: `Inserito nel menu: ${doneText}. ${remarks.join(' ')}`, line, also: ['inserito'] };
    const mailAddr = text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
    if (done.length && mailAddr) return { kind: 'inserito', text, hint: `Inserito nel menu: ${doneText}. L’indirizzo email (${mailAddr[0]}) non ha un campo nel menu pubblico: resta in questa pratica.`, line };
    if (done.length) return { kind: 'inserito', text, hint: `Inserito nel menu: ${done.map((a) => `${INFO[a.field]} ${a.field === 'coperto' ? `${a.value} €` : a.field === 'instagram' ? `@${a.value}` : a.value}${a.fixed ? ' (corretto un refuso)' : ''}${a.check ? ` (${a.check})` : ''}`).join(', ')}. Controlla.`, line };
    // Un paragrafo con più frasi (storia, foto, scritta, domanda…) non è «un solo argomento»: una nota per frase.
    const sentences = text.length > 140 ? text.split(/(?<=[.!?])\s+(?=[A-ZÀ-Ý“«"(])/).filter((x) => x.trim()) : [text];
    if (sentences.length > 1) {
      const parts = sentences.map((x) => classify(x.trim(), line));
      const merged = [];
      for (const n of parts) {
        const prev = merged[merged.length - 1];
        if (prev && prev.kind === 'testo' && n.kind === 'testo') prev.text = `${prev.text} ${n.text}`;
        else merged.push(n);
      }
      return merged;
    }
    return classify(text, line);
  }).flat();
  // Informazioni inserite o in dubbio che non stavano tra le righe incerte (es. aggiornamenti): elencate comunque.
  const covered = (src) => notes.some((n) => plainRow(n.text).includes(plainRow(src).slice(0, 60)) || plainRow(src).includes(plainRow(n.text).slice(0, 60)));
  for (const a of info?.applied || []) if (!covered(a.source)) notes.push({ kind: 'inserito', text: a.source, hint: `Inserito nel menu: ${INFO[a.field]} ${a.field === 'coperto' ? `${a.value} €` : a.field === 'instagram' ? `@${a.value}` : a.value}${a.before ? ` (prima «${a.before}»)` : ''}${a.fixed ? ' (corretto un refuso)' : ''}. Controlla.`, line: a.line || null });
  for (const d of info?.doubts || []) if (!covered(d.source || '')) notes.push({ kind: 'conferma', text: d.source || INFO[d.field], hint: d.doubt, line: d.line || null });
  return notes;
}

const INFO = { coperto: 'Coperto', telefono: 'Telefono', orari: 'Orari', instagram: 'Instagram', facebook: 'Facebook', indirizzo: 'Indirizzo', ferie: 'Chiusura per ferie' };
export const NOTE_LABELS = { premium: 'Premium su misura', inserito: 'Inserito da Jarvis', conferma: 'Da confermare', piatto: 'Righe del menu non lette', correzione: 'Correzioni da applicare', foto: 'Righe dubbie delle foto', piano: 'Piano', tema: 'Tema grafico', coperto: 'Coperto', orari: 'Orari', contatti: 'Contatti', allergeni: 'Allergeni', lingue: 'Lingue', testo: 'Altro testo dell’email', preventivo: 'Domanda su prezzi e tempi', ferie: 'Chiusura per ferie', storia: 'Storia del locale', galleria: 'Foto e galleria', schede: 'Schede dei vini', dicitura: 'Dicitura richiesta', stile: 'Stile richiesto', logo: 'Logo', allegati: 'Allegati citati', servizio: 'Servizio compreso' };

/** Riassunto breve per Telegram/notifiche: prima le cose che richiedono un intervento. */
export function notesSummary(notes, max = 6, { preview = false } = {}) {
  const done = notes.filter((n) => n.kind === 'inserito');
  const urgent = notes.filter((n) => !['testo', 'inserito'].includes(n.kind));
  const parts = [];
  if (done.length) parts.push(`${preview ? 'Quando generi la bozza inserisco dal testo' : 'Ho inserito dal testo'}: ${done.map((n) => n.hint.replace(/^Inserito nel menu: /, '').replace(/\. Controlla\.$/, '')).join('; ')}.`);
  if (urgent.length) {
    const shown = urgent.slice(0, max).map((n) => `• ${[n.kind, ...(n.also || [])].map((k) => NOTE_LABELS[k]).join(' e ')}: «${n.text.slice(0, 80)}»${['conferma', 'premium'].includes(n.kind) ? ` — ${n.hint.slice(0, 140)}` : ''}`);
    parts.push(`Da sistemare o confermare (${urgent.length}):\n${shown.join('\n')}${urgent.length > max ? `\n…e altre ${urgent.length - max} in Revisione.` : ''}`);
  }
  return parts.join('\n\n');
}

/** Note sulle strutture lette (più prezzi, percorsi, descrizioni): cosa confermare, mai in silenzio. */
export function structureNotes(extraction = {}) {
  const confirm = extraction.confirm || [];
  const notes = confirm.filter((c) => c.type !== 'allergeni').map((c) => ({ kind: 'conferma', text: String(c.text || '').slice(0, 220), hint: c.hint, line: c.line ?? null }));
  // Numeri di allergeni sotto i piatti: una nota sola, con la proposta già pronta nel riquadro dei dati del locale.
  const numbered = confirm.filter((c) => c.type === 'allergeni');
  if (numbered.length) notes.push({ kind: 'allergeni', text: numbered.slice(0, 5).map((c) => c.name).join(', ') + (numbered.length > 5 ? '…' : ''), hint: `Il locale ha scritto i numeri degli allergeni sotto ${numbered.length} piatti: sono nella descrizione. Se la legenda del menu segue i numeri UE 1–14, spuntali in «Dati scritti dal locale» e Jarvis li inserisce come allergeni.`, line: numbered[0].line ?? null });
  const variants = (extraction.extracted || []).filter((e) => e.variants?.length);
  if (variants.length) notes.push({ kind: 'inserito', text: variants.slice(0, 6).map((e) => `${e.name}: ${e.variants.join(' · ')}`).join('; ') + (variants.length > 6 ? '…' : ''), hint: `Inserite ${variants.length} voci con più prezzi (es. calice e bottiglia), ogni prezzo con la sua etichetta come scritto. Controllale.`, line: variants[0].line ?? null });
  for (const s of extraction.menu?.sezioni || []) if (s.tipo === 'degustazione') {
    notes.push({ kind: 'inserito', text: `${s.nome.it}${s.prezzo ? ` — ${s.prezzo} €${s.unita?.it ? ` ${s.unita.it}` : ''}` : ''}`, hint: `Percorso degustazione inserito come sezione a sé: ${s.voci.some((v) => v.prezzi?.length) ? `${s.voci.filter((v) => v.prezzi?.length).length} formule con i prezzi come scritti dal cliente` : `${s.voci.filter((v) => !v.prezzo).length} portate${s.voci.some((v) => v.prezzo) ? ' e supplementi' : ''}${s.prezzo ? ', prezzo a persona come scritto' : ', PREZZO DA INSERIRE'}`}. Controllalo.`, line: null });
  }
  return notes;
}

/** Stessa pagina mandata due volte (es. Riccardo rimanda le foto): resta una sola lettura, la più pulita
 * (meno righe «[da verificare]»; a parità la più recente). Mai fondere pagine diverse. */
const pageNames = (text) => new Set(String(text || '').split(/\r?\n/).map((row) => row.trim())
  .filter((row) => row && !/^[#>]/.test(row))
  .map((row) => row.replace(/^\[da verificare\]\s*/i, '').split(/\s+[—–-]\s+|:\s/)[0].toLocaleLowerCase('it-IT').normalize('NFD').replace(/[^a-z0-9]+/g, ' ').trim())
  .filter((name) => name.length >= 3));
const doubtCount = (text) => (String(text || '').match(/^\[da verificare\]/gim) || []).length;
export function dropRepeatedPages(analyses) {
  const info = analyses.map((a, index) => ({ a, index, names: pageNames(a.text), doubts: doubtCount(a.text) }));
  const dropped = new Map();
  for (const x of info) for (const y of info) {
    if (x.index >= y.index || dropped.has(x.index) || dropped.has(y.index)) continue;
    const small = Math.min(x.names.size, y.names.size);
    if (small < 2) continue;
    const common = [...x.names].filter((n) => y.names.has(n)).length;
    if (common / small < 0.8) continue;
    const loser = x.doubts < y.doubts ? y : x; // a parità vince la più recente (y)
    dropped.set(loser.index, loser === x ? y : x);
  }
  return {
    kept: info.filter((i) => !dropped.has(i.index)).map((i) => i.a),
    repeated: [...dropped.entries()].map(([index, winner]) => ({ filename: analyses[index].filename, keptFilename: winner.a.filename }))
  };
}

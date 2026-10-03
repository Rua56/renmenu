import { notesSummary, reviewNotes, structureNotes } from './notes.js';
import { applyVenueInfo, extractVenueInfo } from './venue-info.js';
// Autopilota di Jarvis (2026-10-02): appena arriva una richiesta email, Jarvis la classifica
// e, se il locale ha scritto in modo esplicito nome e piano di un nuovo menu, prepara da solo
// la bozza (con l'inglese). Le regole restano quelle di docs/renmenu-service-rules.md:
// la classificazione è una PROPOSTA con la riga di provenienza, Riccardo la conferma; nessun
// messaggio al cliente, nessuna PR, nessuna pubblicazione.
import { extractMenuFromText, venueFromSource } from './menu.js';
import { proposeSourceExtras } from './extras.js';
import { categoryByCode } from './service-rules.js';
import { briefLines, creativeBrief } from './premium.js';

const plain = (value) => String(value || '').toLocaleLowerCase('it-IT').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const RECEIVED_SUBJECT = /^Oggetto ricevuto:\s*/i;

const PLAN_PATTERNS = [
  ['standard', /\b(?:piano |menu |menù |formula )?standard\b|\b25 ?(?:€|euro)(?: al mese| mensili)?\b/],
  ['annuale', /\b(?:piano |formula |abbonamento )?annual[ei]\b|\b249 ?(?:€|euro)/],
  ['premium', /\bpremium\b|\bsu misura\b|\b490 ?(?:€|euro)/]
];
// Il cliente cita un piano ma non ha deciso («forse», «non abbiamo ancora deciso»): il piano resta da confermare.
const HESITANT = /\b(?:forse|non (?:abbiamo|ho|hanno) ancora deciso|non sappiamo|indecis\w*|stiamo valutando|valutando|stiamo pensando|ci pensiamo|magari|oppure|in alternativa)\b/;
const NEW_MENU = /\bnuovo menu\b|\bmenu nuovo\b|\bmenu digitale\b|\b(?:attivare|creare|fare|realizzare|vorrei|vorremmo)\b[^.\n]{0,40}\bmenu\b|\bprova gratuita\b/;
const UPDATE_RULES = [
  ['prezzo', /\b(?:cambi\w*|aggiorn\w*|modific\w*|alz\w*|abbass\w*)\b[^.\n]{0,40}\bprezz\w*|\bprezz\w*\b[^.\n]{0,30}\b(?:diventa|passa|ora|nuovo)\b/],
  ['vini_cocktail', /\b(?:vin[io]|cocktail|carta dei vini|calice|bottiglia)\b[^.\n]{0,60}\b(?:aggiung\w*|togli\w*|rimuov\w*|cambi\w*|aggiorn\w*)|\b(?:aggiung\w*|togli\w*|rimuov\w*|cambi\w*|aggiorn\w*)\b[^.\n]{0,40}\b(?:vin[io]|cocktail|carta dei vini)\b/],
  ['disponibilita', /\besaurit\w*|\bnon (?:e |è )?(?:piu )?disponibil\w*|\bpiatto del giorno\b|\bfuori menu\b/],
  ['piatto', /\b(?:aggiung\w*|togli\w*|rimuov\w*|elimin\w*|inserit\w*)\b[^.\n]{0,40}\b(?:piatt\w*|menu|voce|antipast\w*|prim\w|second\w|dolc\w)/],
  ['lingua', /\b(?:inglese|tedesco|francese|spagnolo|sloveno|traduzion\w*|lingu\w*)\b/],
  ['qr_cartello', /\bqr\b|\bcartell\w*|\badesiv\w*|\bsegnaposto\b/],
  ['commerciale', /\bquanto costa\b|\bpreventivo\b|\binformazioni sul servizio\b|\bprezz\w* del servizio\b/]
];

function lines(subject, text) {
  const body = String(text || '').split(/\r?\n/).map((line, index) => ({ line: index + 1, text: line.trim() }))
    .filter((row) => row.text && !RECEIVED_SUBJECT.test(row.text));
  return [{ line: 0, text: String(subject || '').trim() }, ...body].filter((row) => row.text);
}

/** Proposta di categoria e piano, con le righe che la giustificano (riga 0 = oggetto). */
export function classifyRequest(subject, text) {
  const rows = lines(subject, text);
  const plans = new Map();
  for (const row of rows) for (const [plan, pattern] of PLAN_PATTERNS) if (pattern.test(plain(row.text)) && !plans.has(plan)) plans.set(plan, row);
  const newMenu = rows.find((row) => NEW_MENU.test(plain(row.text)));
  const venue = venueFromSource(text);
  if (newMenu || (plans.size && venue)) {
    const hesitant = [...plans.values()].some((row) => HESITANT.test(plain(row.text)));
    const plan = plans.size === 1 && !hesitant ? [...plans.keys()][0] : null;
    const reasons = [newMenu, ...plans.values()].filter(Boolean);
    return {
      category: plan ? `nuovo_${plan}` : null, kind: 'nuovo', plan, venue: venue || null,
      explicitPlan: Boolean(plan), ambiguousPlan: plans.size > 1 || (plans.size > 0 && hesitant), hesitant,
      reasons: [...new Map(reasons.map((row) => [row.line, row])).values()]
    };
  }
  for (const [code, pattern] of UPDATE_RULES) {
    const row = rows.find((entry) => pattern.test(plain(entry.text)));
    if (row) return { category: code, kind: categoryByCode(code).kind, plan: null, venue: venue || null, explicitPlan: false, ambiguousPlan: false, reasons: [row] };
  }
  return { category: null, kind: 'altro', plan: null, venue: venue || null, explicitPlan: false, ambiguousPlan: false, reasons: [] };
}

const where = (row) => (row.line === 0 ? 'oggetto' : `riga ${row.line}`);
export const reasonText = (proposal) => proposal.reasons.map((row) => `${where(row)} «${row.text.slice(0, 60)}»`).join('; ');

/** Cosa Jarvis può fare da solo su questa pratica: bozza, solo proposta, o niente. */
export function autopilotPlan(request) {
  const proposal = classifyRequest(request.subject, request.source_text ?? request.sourceText);
  const entry = proposal.category ? categoryByCode(proposal.category) : null;
  if (!entry && proposal.kind === 'nuovo') return { proposal, action: 'proponi', why: proposal.ambiguousPlan ? (proposal.hesitant ? 'Il cliente cita un piano ma non ha ancora deciso: piano da confermare.' : 'Il testo cita più piani: scegli tu.') : 'Il piano non è scritto nella richiesta: scegli tu Standard, Annuale o Premium.' };
  if (!entry) return { proposal, action: 'chiedi', why: 'Richiesta non riconosciuta: decidi tu la categoria.' };
  if (['aggiornamento', 'prezzo'].includes(entry.kind)) {
    // Il menu da aggiornare è quello collegato al cliente (o indicato da Riccardo nella pratica):
    // Jarvis non lo deduce mai dal testo, per non toccare il menu di un altro locale.
    const menuId = request.menu_id || request.menuId || request.client_menu_id || request.clientMenuId || null;
    if (menuId) return { proposal, action: 'bozza', why: '', menuId };
    return { proposal, action: 'proponi', why: 'Non so ancora quale menu online aggiornare: imposta il Menu ID nella scheda cliente (una volta sola) o nella pratica, poi genera la bozza.' };
  }
  if (entry.kind !== 'nuovo') return { proposal, action: 'proponi', why: 'Per ora questo tipo di richiesta lo prepari tu.' };
  if (!proposal.explicitPlan) return { proposal, action: 'proponi', why: proposal.ambiguousPlan ? (proposal.hesitant ? 'Il cliente cita un piano ma non ha ancora deciso: piano da confermare.' : 'Il testo cita più piani: scegli tu.') : 'Il piano non è scritto nella richiesta: scegli tu Standard, Annuale o Premium.' };
  if (!proposal.venue) return { proposal, action: 'proponi', why: 'Manca una riga «Locale: …»: indica il nome del locale (Menu ID) e genera tu la bozza.' };
  // Premium su misura: nessuna bozza automatica. Jarvis prepara scheda creativa e 3 direzioni
  // grafiche quando Riccardo genera la bozza; il preventivo (totale) lo decide sempre Riccardo.
  if (proposal.plan === 'premium') return { proposal, action: 'proponi', why: 'Premium su misura: la bozza la avvii tu. Quando la generi preparo la scheda creativa e 3 direzioni grafiche da confrontare; il totale del preventivo lo decidi tu.' };
  return { proposal, action: 'bozza', why: '' };
}

/** Anteprima pura di ciò che Jarvis troverà (usata anche dall'importatore per la notifica). */
export function autopilotPreview(request) {
  const plan = autopilotPlan(request);
  const text = request.source_text ?? request.sourceText ?? '';
  const extraction = extractMenuFromText(plan.proposal.venue || 'Locale', text, plan.proposal.venue || 'locale');
  const extras = proposeSourceExtras(text, extraction.menu);
  return {
    action: plan.action, why: plan.why, menuId: plan.menuId || null,
    category: plan.proposal.category, kind: plan.proposal.kind,
    categoryLabel: plan.proposal.category ? categoryByCode(plan.proposal.category).label : plan.proposal.kind === 'nuovo' ? 'Nuovo menu (piano da scegliere)' : null,
    plan: plan.proposal.plan, venue: plan.proposal.venue, reasons: reasonText(plan.proposal),
    items: extraction.extracted.length, uncertain: extraction.uncertain.length,
    notes: [...reviewNotes({ sourceText: text, uncertain: extraction.uncertain, extracted: extraction.extracted, info: applyVenueInfo(extraction.menu, extractVenueInfo(text)) }), ...structureNotes(extraction)],
    brief: plan.proposal.plan === 'premium' ? briefLines(creativeBrief(text, { attachments: Number(request.attachments || 0) })) : [],
    extras: extras.filter((entry) => entry.type !== 'manuale').map((entry) => (entry.type === 'coperto' ? `coperto ${entry.value}` : `allergeni ${entry.name}`))
  };
}

/** Testo breve per Riccardo (notifica in app, email o push). Nessun dato personale del mittente. */
export function autopilotMessage(subject, preview, outcome = preview.action) {
  const base = autopilotBase(subject, preview, outcome);
  const todo = preview.kind === 'nuovo' && Array.isArray(preview.notes) ? notesSummary(preview.notes, 6, { preview: outcome !== 'bozza' }) : '';
  const brief = Array.isArray(preview.brief) && preview.brief.length ? `Scheda creativa (dal testo del cliente):\n${preview.brief.map((line) => `• ${line}`).join('\n')}` : '';
  return [base, brief, todo].filter(Boolean).join('\n\n');
}
function autopilotBase(subject, preview, outcome) {
  const head = String(subject || 'Nuova richiesta').slice(0, 70);
  const facts = preview.kind !== 'nuovo' ? '' : `${preview.items} piatti letti${Array.isArray(preview.notes) ? '' : `${preview.uncertain ? `, ${preview.uncertain} righe da verificare` : ''}${preview.extras.length ? `, trovati ${preview.extras.join(' e ')}` : ''}`}`;
  if (outcome === 'bozza' && preview.menuId) return `Riccardo, aggiornamento pronto per il menu online «${preview.menuId}» (${preview.categoryLabel}): ho applicato solo le modifiche scritte nell’email, QR invariato. Apri Revisione per controllarle.`;
  if (outcome === 'bozza') return `Riccardo, bozza pronta per «${preview.venue}» (${preview.categoryLabel}): ${facts}. Apri Revisione per controllarla.`;
  if (outcome === 'proponi') return `Riccardo, nuova richiesta «${head}». Propongo: ${preview.categoryLabel}. ${preview.why}${facts ? ` ${facts}.` : ''}`;
  return `Riccardo, nuova richiesta «${head}»: non l’ho riconosciuta. ${preview.why}`;
}

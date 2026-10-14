// Schede Premium preparate da Jarvis (2026-10-14): il livello del menu di Al Bakaro.
// Per i vini senza scheda Jarvis propone la scheda sommelier (vitigno, zona, colore, profumo, gusto,
// abbinamenti, temperatura, profilo); per i piatti senza descrizione propone una descrizione breve.
// Regole: solo fatti generali e sicuri sul vino o sul piatto NOMINATO dal cliente; mai prezzi, annate,
// gradazioni, premi, «fatto in casa», «km 0», «biologico». Nulla entra nel menu finché Riccardo non
// approva (tutte insieme o voce per voce); i campi già scritti dal cliente non si toccano mai.
import { geminiJson } from './gemini-json.js';
import { menuSlots, resolveTarget } from './media.js';

export const SCHEDE_SOURCE = 'Scheda proposta da Jarvis, approvata da Riccardo';
// Preparazione automatica: la scheda entra nella bozza e Riccardo la approva col SÌ all'anteprima.
export const SCHEDE_AUTO_SOURCE = 'Scheda preparata da Jarvis (preparazione automatica, da approvare con l’anteprima)';
const TEXT_FIELDS = ['vitigno', 'territorio', 'colore', 'profumo', 'gusto', 'abbinamenti', 'nota'];
const PROFILE_KEYS = ['aromi', 'struttura', 'acidita', 'dolcezza', 'corpo'];
const MAX = { vitigno: 80, territorio: 90, colore: 90, profumo: 110, gusto: 110, abbinamenti: 110, nota: 180, descrizione: 120 };
const LANGS = ['it', 'en', 'de', 'fr', 'es', 'sl'];
export const BATCH = 5;
export const PER_ROUND = 15;
// Affermazioni che Jarvis non può fare da solo: le scrive solo il cliente.
const CLAIMS = /fatt[oaie] in casa|della casa|nostr[aoie]|km\s*0|chilometro zero|biologic|\bbio\b|artigianal|premiat|medagli|punti|\bchef\b|ricetta segreta|dal \d{4}|\b(?:19|20)\d{2}\b|€|\beur\b|prezz|gluten|lattosio|vegan|vegetarian|allergen/i;
// Sezioni dove una descrizione non serve (bibite, acqua, caffè).
const SKIP_SECTION = /bibit|bevand|soft|analcol|acqu[ae]|caff|the\b|tisan|succh|soda|bevande/i;

const norm = (v) => String(v || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const text = (v) => (v == null ? '' : typeof v === 'string' ? v : v.it || Object.values(v)[0] || '');
const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f<>]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const voceAt = (menu, target) => { const m = /^voce:(\d+):(\d+)$/.exec(String(target || '')); return m ? menu?.sezioni?.[Number(m[1])]?.voci?.[Number(m[2])] : null; };
const filled = (v) => Boolean(text(v).trim());

/** Voci che possono ricevere una proposta: vini con scheda scarna, piatti senza descrizione. */
export function schedeTargets(menu, done = []) {
  const skip = new Set(done.map((d) => norm(d)));
  return menuSlots(menu).flatMap((slot) => {
    const voce = voceAt(menu, slot.target);
    if (!voce || skip.has(norm(slot.name))) return [];
    if (slot.wine) {
      const scheda = voce.scheda && typeof voce.scheda === 'object' ? voce.scheda : {};
      const have = TEXT_FIELDS.filter((k) => filled(scheda[k])).length;
      return have >= 4 ? [] : [{ target: slot.target, kind: 'vino', name: slot.name, section: slot.section, descr: slot.descr || '' }];
    }
    if (filled(voce.descrizione) || SKIP_SECTION.test(slot.section) || norm(slot.name).length < 4) return [];
    return [{ target: slot.target, kind: 'piatto', name: slot.name, section: slot.section, descr: '' }];
  });
}

export function schedePrompt(menu, items, langs) {
  const piatti = menuSlots(menu).filter((s) => !s.wine).map((s) => s.name).slice(0, 80);
  const system = [
    'Sei il sommelier e lo chef di RenMenu e scrivi le schede del menu digitale di un locale vero in Friuli Venezia Giulia.',
    'Scrivi SOLO fatti generali e sicuri sul vino o sul piatto nominato: vitigno, zona, colore, profumi e gusto tipici, ingredienti classici della ricetta.',
    'Se non riconosci con sicurezza il vino o il piatto, metti certezza "bassa" e lascia vuoti i campi: è molto meglio di un errore.',
    'Mai: prezzi, annate, gradazioni, premi, storia della cantina, «fatto in casa», «km 0», «biologico», «dello chef», allergeni o diete.',
    'Il nome della cantina conta solo se è scritto nel nome del vino. Non inventare il produttore.',
    'abbinamenti: preferisci i piatti dell\'elenco «piatti_del_menu» scritti con il loro nome esatto, altrimenti categorie generiche (salumi, pesce crudo, formaggi stagionati).',
    `Ogni testo è un oggetto con una chiave per lingua: ${langs.join(', ')}. Testi brevi ed eleganti, niente punto finale nei campi corti.`,
    'temperatura: solo per i vini, nel formato «8-10 °C». profilo: interi 0-100 (aromi, struttura, acidita, dolcezza, corpo).',
    'Rispondi solo con JSON: {"voci":[{"id":0,"certezza":"alta|media|bassa","vitigno":{},"territorio":{},"colore":{},"profumo":{},"gusto":{},"abbinamenti":{},"nota":{},"temperatura":"","profilo":{},"descrizione":{}}]}.',
    'Per i vini compila vitigno, territorio, colore, profumo, gusto, abbinamenti, temperatura, profilo e una nota di una frase; per i piatti solo descrizione.'
  ].join('\n');
  const user = JSON.stringify({ piatti_del_menu: piatti, voci: items.map((x, id) => ({ id, tipo: x.kind, nome: x.name, sezione: x.section, ...(x.descr ? { descrizione_del_cliente: x.descr } : {}) })) });
  return { system, user };
}

/** Testo multilingua accettabile: almeno l'italiano, solo lingue del menu, niente affermazioni vietate. */
function localized(value, max, langs, clientText = '') {
  const source = typeof value === 'string' ? { it: value } : value && typeof value === 'object' ? value : {};
  const out = {};
  for (const lang of langs) {
    const s = clean(source[lang], max);
    if (!s) continue;
    if (CLAIMS.test(s) && !CLAIMS.test(clientText)) return null;
    out[lang] = s.replace(/\.$/, '');
  }
  return out.it ? out : null;
}

/** Controlla e ripulisce la risposta del modello per un gruppo di voci. */
export function sanitizeSchede(raw, items, langs) {
  const byId = new Map((Array.isArray(raw?.voci) ? raw.voci : []).filter((r) => Number.isInteger(r?.id)).map((r) => [r.id, r]));
  const out = [], skipped = [];
  items.forEach((item, id) => {
    const r = byId.get(id);
    if (!r) { skipped.push({ name: item.name, reason: 'nessuna proposta' }); return; }
    if (!['alta', 'media'].includes(r.certezza)) { skipped.push({ name: item.name, reason: 'Jarvis non lo conosce con sicurezza' }); return; }
    if (item.kind === 'piatto') {
      const descrizione = localized(r.descrizione, MAX.descrizione, langs, item.descr);
      if (!descrizione) { skipped.push({ name: item.name, reason: 'descrizione non accettata' }); return; }
      out.push({ ...item, certezza: r.certezza, descrizione });
      return;
    }
    const scheda = {};
    for (const k of TEXT_FIELDS) { const v = localized(r[k], MAX[k], langs, item.descr); if (v) scheda[k] = v; }
    const t = /^(\d{1,2})\s*[-–]\s*(\d{1,2})\s*°\s*C$/i.exec(clean(r.temperatura, 20));
    if (t && Number(t[1]) >= 4 && Number(t[2]) <= 20 && Number(t[1]) <= Number(t[2])) scheda.temperatura = `${t[1]}-${t[2]} °C`;
    if (r.profilo && typeof r.profilo === 'object') {
      const profilo = {};
      for (const k of PROFILE_KEYS) { const n = Number(r.profilo[k]); if (Number.isInteger(n) && n >= 0 && n <= 100) profilo[k] = n; }
      if (Object.keys(profilo).length >= 3) scheda.profilo = profilo;
    }
    if (Object.keys(scheda).filter((k) => k !== 'profilo').length < 3) { skipped.push({ name: item.name, reason: 'scheda troppo scarna' }); return; }
    out.push({ ...item, certezza: r.certezza, scheda });
  });
  return { proposals: out, skipped };
}

/** Prepara fino a PER_ROUND proposte con Gemini (gratis). Le voci già proposte o scartate non tornano. */
export async function proposeSchede(menu, gemini, { done = [], tries = [] } = {}) {
  const langs = LANGS.filter((l) => l === 'it' || (Array.isArray(menu?.lingue) && menu.lingue.includes(l)));
  const targets = schedeTargets(menu, done);
  const round = targets.slice(0, PER_ROUND);
  const proposals = [], skipped = [];
  let unavailable = !gemini?.key;
  for (let i = 0; i < round.length && !unavailable; i += BATCH) {
    const items = round.slice(i, i + BATCH);
    const { system, user } = schedePrompt(menu, items, langs);
    const raw = await geminiJson(gemini, { system, user, maxOutputTokens: 900 * items.length * Math.max(1, langs.length / 2), deadlineMs: 40_000, perModelMs: 30_000, validate: (x) => Array.isArray(x?.voci) }, tries);
    if (!raw) { if (!proposals.length && i === 0) unavailable = true; skipped.push(...items.map((x) => ({ name: x.name, reason: 'servizio non disponibile, riprova' }))); continue; }
    const res = sanitizeSchede(raw, items, langs);
    proposals.push(...res.proposals); skipped.push(...res.skipped);
  }
  return { proposals, skipped, remaining: Math.max(0, targets.length - round.length), unavailable };
}

/**
 * Applica le proposte approvate. Ritrova la voce anche se la bozza è cambiata (per nome);
 * non sovrascrive mai un campo scritto dal cliente. Restituisce { menu, applied, lost, provenance }.
 */
export function applySchede(menu, proposals, source = SCHEDE_SOURCE) {
  const next = structuredClone(menu);
  const applied = [], lost = [], provenance = [];
  for (const p of proposals) {
    const target = resolveTarget(next, p.target, p.name);
    const voce = target && voceAt(next, target);
    if (!voce) { lost.push(p.name); continue; }
    const m = /^voce:(\d+):(\d+)$/.exec(target);
    const path = `sezioni.${m[1]}.voci.${m[2]}`;
    if (p.kind === 'piatto') {
      if (filled(voce.descrizione) || !p.descrizione) continue;
      voce.descrizione = p.descrizione;
      provenance.push({ path: `${path}.descrizione`, source, value: p.descrizione.it, status: 'da_verificare' });
    } else {
      const before = voce.scheda && typeof voce.scheda === 'object' ? voce.scheda : {};
      const scheda = { ...before };
      for (const [k, v] of Object.entries(p.scheda || {})) if (!(k in before)) { scheda[k] = v; provenance.push({ path: `${path}.scheda.${k}`, source, value: typeof v === 'object' ? (v.it ?? JSON.stringify(v)) : String(v), status: 'da_verificare' }); }
      voce.scheda = scheda;
    }
    applied.push(p.name);
  }
  return { menu: next, applied, lost, provenance };
}

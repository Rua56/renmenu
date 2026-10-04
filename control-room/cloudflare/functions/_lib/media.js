// Foto per il menu Premium (Fase 2, 2026-10-04).
// Il cliente manda logo, bottiglie, piatti e foto del locale insieme al menu. Jarvis:
//  1. riconosce che cosa mostra ogni foto (una sola lettura, un modello): logo, bottiglia, piatto,
//     locale, pagina di menu, altro. Le pagine di menu (e i dubbi) vanno alla lettura doppia di sempre;
//  2. propone dove metterla: il logo all'apertura, le foto del locale nella «Storia», la bottiglia
//     sul vino con lo stesso nome (letto dall'etichetta), il piatto sulla voce con lo stesso nome;
//  3. Riccardo conferma, sposta o scarta in Revisione. Solo allora la foto (ridotta dal telefono)
//     entra nella bozza e diventa visibile in anteprima. Nulla entra nel menu in silenzio.
// I dati letti sull'etichetta (cantina, annata, vitigno, zona, gradazione) entrano nella scheda del
// vino solo se Riccardo lo sceglie, e solo nei campi ancora vuoti.
import { WINE_SECTION } from './menu-structure.js';

export const MEDIA_KINDS = ['logo', 'bottiglia', 'piatto', 'locale', 'menu', 'altro'];
export const MEDIA_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
export const MAX_PUBLIC_IMAGE = 900_000;
const MAX_IMAGE_BYTES = 4_500_000;
const LABEL_KEYS = ['nome', 'cantina', 'annata', 'vitigno', 'denominazione', 'gradazione'];

const PROMPT = [
  'Guarda questa foto mandata da un ristorante o da un\'enoteca italiana per il suo menu digitale.',
  'Rispondi SOLO con un oggetto JSON, senza testo prima o dopo, con questi campi:',
  '{"tipo": "...", "descrizione": "...", "etichetta": {"nome": "", "cantina": "", "annata": "", "vitigno": "", "denominazione": "", "gradazione": ""}}',
  'tipo è uno solo tra:',
  '- "menu": una pagina, lavagna o foglio con un elenco di piatti o bevande e prezzi (anche se c\'è una decorazione);',
  '- "logo": il marchio o il nome del locale disegnato, su fondo semplice;',
  '- "bottiglia": una o più bottiglie di vino, birra o liquore dove si vede l\'etichetta;',
  '- "piatto": un piatto di cibo o un dolce servito, o un bicchiere/cocktail servito;',
  '- "locale": la sala, il bancone, l\'esterno, la cantina o le persone del locale;',
  '- "altro": tutto il resto.',
  'descrizione: al massimo 15 parole in italiano. Per un piatto usa il nome tipico se è riconoscibile (es. «frico con polenta», «tiramisù»).',
  'etichetta: SOLO per "bottiglia", copiando le parole esattamente come sono scritte sull\'etichetta; lascia "" quello che non si legge. Non indovinare e non completare.',
  'Se nella foto ci sono più prezzi o un elenco di piatti, il tipo è "menu".'
].join('\n');

const norm = (v) => String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const STOP = new Set(['di', 'del', 'della', 'dei', 'delle', 'al', 'alla', 'alle', 'ai', 'con', 'e', 'il', 'la', 'le', 'lo', 'i', 'gli', 'un', 'una', 'in', 'da', 'doc', 'docg', 'igt', 'dop', 'vino', 'bianco', 'rosso', 'the', 'and', 'bottiglia', 'piatto', 'foto', 'img', 'jpg', 'jpeg', 'png', 'image', 'casa', 'nostro', 'nostra']);
const tokens = (v) => norm(v).split(' ').filter((w) => w.length > 1 && !STOP.has(w));
const text = (v) => (v == null ? '' : typeof v === 'string' ? v : v.it || Object.values(v)[0] || '');
const cut = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Primo oggetto JSON nella risposta del modello (anche dentro ```json … ```). */
export function parseClassification(raw) {
  const str = String(raw ?? '').replace(/```[a-z]*\n?|```/g, '');
  const start = str.indexOf('{');
  if (start < 0) return null;
  let depth = 0, end = -1, inString = false, escaped = false;
  for (let i = start; i < str.length; i += 1) {
    const ch = str[i];
    if (inString) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') inString = false; continue; }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (!depth) { end = i; break; } }
  }
  if (end < 0) return null;
  let data;
  try { data = JSON.parse(str.slice(start, end + 1)); } catch { return null; }
  const tipo = norm(data?.tipo).replace(/\s+/g, '');
  const kind = MEDIA_KINDS.includes(tipo) ? tipo : tipo === 'bottiglie' ? 'bottiglia' : tipo === 'piatti' ? 'piatto' : null;
  if (!kind) return null;
  const label = {};
  if (kind === 'bottiglia' && data.etichetta && typeof data.etichetta === 'object') {
    for (const key of LABEL_KEYS) {
      const value = cut(data.etichetta[key], 80);
      if (value && !/^(?:n\/?a|non\s+(?:leggibile|visibile|indicat\w*)|sconosciut\w*|\?+|-+)$/i.test(value)) label[key] = value;
    }
    tidyLabel(label);
    if (label.annata && !/^(?:19|20)\d{2}$/.test(label.annata)) delete label.annata;
    if (label.gradazione && !/\d/.test(label.gradazione)) delete label.gradazione;
  }
  return { kind, description: cut(data.descrizione, 140), label };
}

/** Che cosa mostra la foto. Non lancia mai: { ok:false } se il modello non risponde o risponde male. */
export async function classifyPhoto(ai, bytes, mime, { timeoutMs = 30_000 } = {}) {
  if (typeof ai?.run !== 'function') return { ok: false, reason: 'riconoscimento delle foto non disponibile' };
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) return { ok: false, reason: 'formato non supportato' };
  if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, reason: 'foto troppo grande' };
  const payload = { messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }, { type: 'image_url', image_url: { url: `data:${mime};base64,${toBase64(bytes)}` } }] }], temperature: 0, max_tokens: 400 };
  let timer;
  try {
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('tempo scaduto')), timeoutMs); });
    const result = await Promise.race([Promise.resolve().then(() => ai.run(MEDIA_MODEL, payload)), timeout]);
    const raw = result?.response ?? result?.choices?.[0]?.message?.content ?? '';
    const parsed = parseClassification(typeof raw === 'string' ? raw : JSON.stringify(raw));
    return parsed ? { ok: true, ...parsed } : { ok: false, reason: 'risposta non comprensibile' };
  } catch (error) {
    const message = String(error?.message || error || '');
    return { ok: false, reason: /4006|daily free allocation|quota/i.test(message) ? 'quota giornaliera finita' : 'il modello non ha risposto', quota: /4006|daily free allocation/i.test(message) };
  } finally { clearTimeout(timer); }
}

/** Le foto che non sono pagine di menu non vanno alla trascrizione doppia. */
export const isMenuPhotoKind = (kind) => kind === 'menu' || kind === 'altro' || !kind;

// ── Posti possibili nella bozza ────────────────────────────────────────────────────────────
const isWineSection = (section) => {
  const name = Object.values(typeof section?.nome === 'string' ? { it: section.nome } : section?.nome || {}).join(' ');
  const voci = section?.voci || [];
  return section?.tipo !== 'degustazione' && (WINE_SECTION.test(name) || (voci.length > 0 && voci.every((v) => Array.isArray(v.prezzi) && v.prezzi.length)));
};

/** Voci della bozza a cui si può dare una foto: { target:'voce:s:i', name, section, wine }. */
export function menuSlots(menu) {
  const slots = [];
  (menu?.sezioni || []).forEach((section, si) => {
    if (section?.tipo === 'degustazione') return;
    const wine = isWineSection(section);
    (section.voci || []).forEach((voce, vi) => slots.push({ target: `voce:${si}:${vi}`, name: text(voce.nome), descr: text(voce.descrizione), section: text(section.nome), wine }));
  });
  return slots;
}

// Quanto del nome della voce ritrova la foto. Una parola «distintiva» (presente in una sola voce
// compatibile, es. «frico», «friulano», «tiramisù») basta per proporre; il resto aumenta la fiducia.
function coverage(source, slotName, df) {
  const have = new Set(tokens(source));
  const want = [...new Set(tokens(slotName))];
  if (!have.size || !want.length) return 0;
  const hit = (w) => have.has(w) || [...have].some((h) => h.length > 4 && w.length > 4 && (h.startsWith(w) || w.startsWith(h)));
  const common = want.filter(hit);
  if (!common.length) return 0;
  const share = common.length / want.length;
  const distinctive = common.some((w) => w.length >= 4 && !/^\d+$/.test(w) && (df.get(w) || 0) === 1);
  return distinctive ? 0.55 + 0.4 * share : share * 0.9;
}
/** Frequenza delle parole tra le voci dello stesso tipo (vini / cibo). */
export function slotFrequencies(slots) {
  const df = { wine: new Map(), food: new Map() };
  for (const slot of slots) for (const w of new Set(tokens(slot.name))) { const m = slot.wine ? df.wine : df.food; m.set(w, (m.get(w) || 0) + 1); }
  return df;
}

/** Quanto la foto somiglia a una voce (0-1). */
export function slotScore(media, slot, df = slotFrequencies([slot])) {
  if (media.kind === 'bottiglia') {
    if (!slot.wine) return 0;
    const label = media.label || {};
    const fromLabel = [label.nome, label.denominazione, label.vitigno, label.cantina, label.annata].filter(Boolean).join(' ');
    let score = Math.max(coverage(fromLabel, slot.name, df.wine), coverage(media.description, slot.name, df.wine) * 0.8, coverage(media.filename, slot.name, df.wine) * 0.8);
    const year = slot.name.match(/\b(?:19|20)\d{2}\b/)?.[0];
    if (score && year && label.annata) score = label.annata === year ? Math.min(1, score + 0.05) : score * 0.6;
    return score;
  }
  if (media.kind === 'piatto') {
    if (slot.wine) return 0;
    return Math.max(coverage(media.description, slot.name, df.food), coverage(media.filename, slot.name, df.food) * 0.9);
  }
  return 0;
}

const MIN_SCORE = 0.5;
/**
 * Proposte per le foto ancora da confermare. Ogni voce riceve al massimo una foto (anche contando
 * quelle già confermate); a parità vince la somiglianza più alta. Logo: uno solo.
 */
export function proposeTargets(menu, mediaRows) {
  const slots = menuSlots(menu);
  const df = slotFrequencies(slots);
  const taken = new Set(mediaRows.filter((m) => m.status === 'confermata' && m.target?.startsWith('voce:')).map((m) => m.target));
  let logoTaken = mediaRows.some((m) => m.status === 'confermata' && m.target === 'logo');
  const out = new Map();
  const candidates = [];
  for (const media of mediaRows) {
    if (media.status !== 'proposta') continue;
    if (media.kind === 'logo') { out.set(media.id, logoTaken ? { target: 'galleria', score: 0.3, why: 'c\'è già un logo: la propongo tra le foto del locale' } : { target: 'logo', score: 0.9, why: 'logo del locale: va all\'apertura del menu' }); logoTaken = true; continue; }
    if (media.kind === 'locale') { out.set(media.id, { target: 'galleria', score: 0.8, why: 'foto del locale: va nella scheda «La nostra storia»' }); continue; }
    if (media.kind === 'bottiglia' || media.kind === 'piatto') {
      for (const slot of slots) { const score = slotScore(media, slot, df); if (score >= MIN_SCORE) candidates.push({ media, slot, score }); }
      continue;
    }
    out.set(media.id, { target: null, score: 0, why: 'non so dove metterla: scegli tu' });
  }
  candidates.sort((a, b) => b.score - a.score);
  for (const { media, slot, score } of candidates) {
    if (out.has(media.id) || taken.has(slot.target)) continue;
    taken.add(slot.target);
    out.set(media.id, { target: slot.target, score: Math.round(score * 100) / 100, why: media.kind === 'bottiglia' ? `etichetta simile a «${slot.name}»` : `piatto simile a «${slot.name}»` });
  }
  for (const media of mediaRows) if (media.status === 'proposta' && !out.has(media.id))
    out.set(media.id, { target: null, score: 0, why: media.kind === 'bottiglia' ? 'non trovo un vino con questo nome nella bozza: scegli tu' : 'non trovo un piatto con questo nome nella bozza: scegli tu' });
  return out;
}

/** Descrizione breve di un posto, per l'interfaccia e l'audit. */
export function targetLabel(menu, target) {
  if (target === 'logo') return 'Logo all\'apertura';
  if (target === 'galleria') return 'Foto del locale («La nostra storia»)';
  const m = /^voce:(\d+):(\d+)$/.exec(String(target || ''));
  const voce = m && menu?.sezioni?.[Number(m[1])]?.voci?.[Number(m[2])];
  return voce ? `${text(menu.sezioni[Number(m[1])].nome)} › ${text(voce.nome)}` : '';
}

/** Il posto esiste ancora? Se le voci sono cambiate (bozza rifatta) si ritrova per nome. */
export function resolveTarget(menu, target, name) {
  if (target === 'logo' || target === 'galleria') return target;
  const m = /^voce:(\d+):(\d+)$/.exec(String(target || ''));
  if (!m) return null;
  const voce = menu?.sezioni?.[Number(m[1])]?.voci?.[Number(m[2])];
  if (voce && (!name || norm(text(voce.nome)) === norm(name))) return target;
  if (!name) return null;
  const hit = menuSlots(menu).find((slot) => norm(slot.name) === norm(name));
  return hit ? hit.target : null;
}

const SCHEDA_FROM_LABEL = { cantina: 'cantina', annata: 'annata', vitigno: 'vitigno', denominazione: 'territorio', gradazione: 'gradazione' };
/** Mette la foto (già pubblica) nel posto scelto. Restituisce un nuovo menu. */
export function applyMedia(menu, { target, url, label = {}, withLabel = false, alt = '' }) {
  const next = structuredClone(menu);
  if (target === 'logo') {
    next.premium = { ...(next.premium || {}), logo: url };
    return next;
  }
  if (target === 'galleria') {
    const gallery = Array.isArray(next.premium?.galleria) ? next.premium.galleria.filter((g) => (typeof g === 'string' ? g : g?.src) !== url) : [];
    gallery.push(alt ? { src: url, alt: { it: cut(alt, 80) } } : { src: url });
    next.premium = { ...(next.premium || {}), galleria: gallery.slice(0, 8) };
    return next;
  }
  const m = /^voce:(\d+):(\d+)$/.exec(String(target || ''));
  const voce = m && next.sezioni?.[Number(m[1])]?.voci?.[Number(m[2])];
  if (!voce) throw new Error('Posto non trovato nella bozza.');
  voce.foto = url;
  if (withLabel) {
    const scheda = { ...(voce.scheda && typeof voce.scheda === 'object' ? voce.scheda : {}) };
    for (const [from, to] of Object.entries(SCHEDA_FROM_LABEL)) if (label[from] && !scheda[to]) scheda[to] = cut(label[from], 80);
    if (Object.keys(scheda).length) voce.scheda = scheda;
  }
  return next;
}

/** Toglie la foto dal posto (la scheda del vino resta: si corregge a mano se serve). */
export function removeMedia(menu, { target, url }) {
  const next = structuredClone(menu);
  if (target === 'logo') { if (next.premium?.logo === url) delete next.premium.logo; return next; }
  if (target === 'galleria') {
    if (Array.isArray(next.premium?.galleria)) {
      next.premium.galleria = next.premium.galleria.filter((g) => (typeof g === 'string' ? g : g?.src) !== url);
      if (!next.premium.galleria.length) delete next.premium.galleria;
    }
    return next;
  }
  const m = /^voce:(\d+):(\d+)$/.exec(String(target || ''));
  const voce = m && next.sezioni?.[Number(m[1])]?.voci?.[Number(m[2])];
  if (voce && voce.foto === url) delete voce.foto;
  return next;
}

/** Bozza rifatta: rimette le foto già confermate al loro posto (ritrovato per nome). */
export function reapplyConfirmed(menu, mediaRows) {
  let next = menu;
  const applied = [], lost = [];
  for (const media of mediaRows) {
    if (media.status !== 'confermata' || !media.public_url) continue;
    const target = resolveTarget(next, media.target, media.target_name);
    if (!target) { lost.push(media); continue; }
    next = applyMedia(next, { target, url: media.public_url, label: parseLabel(media.label_json), withLabel: Boolean(media.with_label), alt: media.description });
    applied.push({ id: media.id, target });
  }
  return { menu: next, applied, lost };
}

export function parseLabel(json) {
  try { const v = JSON.parse(json || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? tidyLabel(v) : {}; } catch { return {}; }
}

// Etichette scritte in maiuscolo («COLLIO»): nella scheda vanno in forma normale («Collio»).
function tidyLabel(label) {
  for (const key of Object.keys(label)) if (typeof label[key] === 'string' && /[A-ZÀ-Ý]{3}/.test(label[key]) && label[key] === label[key].toUpperCase())
    label[key] = label[key].toLowerCase().replace(/(^|[\s'’(-])(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase()).replace(/\b(Di|Del|Della|Dei|Delle|Dal|Da|E|D'|Doc|Docg|Igt)\b/g, (w) => (/^(Doc|Docg|Igt)$/.test(w) ? w.toUpperCase() : w.toLowerCase()));
  return label;
}

/** JPEG/PNG/WebP vero, non troppo grande. */
export function publicImageOk(bytes, mime) {
  if (!bytes?.length || bytes.length > MAX_PUBLIC_IMAGE) return false;
  if (mime === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === 'image/webp') return String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP';
  if (mime === 'image/png') return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  return false;
}
export const PUBLIC_EXT = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' };
export const PUBLIC_FILE = /^([0-9a-f]{64})\.(jpg|webp|png)$/;

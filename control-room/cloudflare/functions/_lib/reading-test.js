// Prova di lettura: quanto bene Jarvis legge i menu veri.
// Le foto di prova (già in R2 dalle pratiche, o nel ramo GitHub «prove-lettura») vengono rilette con la
// stessa catena delle pratiche (readMenuPhoto, Gemini se c'è), una foto per giro dell'orologio; poi la bozza
// che ne uscirebbe si confronta piatto per piatto con il menu giusto (pubblicato, o trascritto a mano).
// Conta soprattutto un numero: i prezzi SBAGLIATI entrati in bozza senza avviso.
import { readMenuPhoto, PHOTO_TYPES } from './vision.js';
import { DEFAULT_SECTION, extractMenuFromText } from './menu.js';

export const CASES_URL = 'https://raw.githubusercontent.com/Rua56/renmenu/prove-lettura/prove-lettura/casi.json';
const FILES_ROOT = 'https://raw.githubusercontent.com/Rua56/renmenu/prove-lettura/prove-lettura/';
const PUBLIC_MENU = (slug) => `https://renmenu.com/menus/${slug}.json`;
const STATE = 'reading_test', LAST = 'reading_test_last', LOCK = 'reading_test_lock';

const norm = (value) => String(value || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const STOP = new Set(['di', 'da', 'del', 'della', 'dei', 'delle', 'con', 'al', 'alla', 'alle', 'ai', 'il', 'la', 'le', 'lo', 'gli', 'e', 'ed', 'in', 'su', 'a']);
const words = (value) => new Set(norm(value).split(' ').filter((w) => w.length > 1 && !STOP.has(w)));
/** Somiglianza tra due nomi (0-1): parole in comune sul nome più lungo; alta se uno contiene tutto l'altro. */
export function nameScore(a, b) {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return norm(a) && norm(a) === norm(b) ? 1 : 0;
  if (norm(a).replace(/ /g, '') === norm(b).replace(/ /g, '')) return 1;
  const common = [...x].filter((w) => y.has(w)).length;
  const small = Math.min(x.size, y.size);
  if (small >= 2 && common === small) return 0.9;
  // «Ribolla» e «Ribolla gialla»: una parola sola ma lunga, tutta dentro l'altro nome.
  if (small === 1 && common === 1 && [...(x.size === 1 ? x : y)][0].length >= 5) return 0.7;
  return common / Math.max(x.size, y.size);
}
const cents = (value) => {
  const m = String(value ?? '').replace(/\s/g, '').match(/(\d{1,4})(?:[.,](\d{1,2}))?/);
  return m ? Number(m[1]) * 100 + Number((m[2] || '0').padEnd(2, '0')) : null;
};
/** Le voci di un menu RenMenu con i loro prezzi in centesimi (le portate senza prezzo dei percorsi non contano). */
export function menuItems(menu) {
  const out = [];
  for (const section of menu?.sezioni || []) {
    for (const item of section.voci || []) {
      const name = item?.nome?.it || '';
      const prices = Array.isArray(item.prezzi) ? item.prezzi.map((v) => cents(v.prezzo)).filter((c) => c !== null) : [cents(item.prezzo)].filter((c) => c !== null);
      if (section.tipo === 'degustazione' && !prices.length) continue;
      if (name) out.push({ name, prices: prices.sort((p, q) => p - q), section: section?.nome?.it || '' });
    }
  }
  return out;
}
const samePrices = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const euro = (list) => list.length ? list.map((c) => `${Math.floor(c / 100)},${String(c % 100).padStart(2, '0')}`).join(' / ') : 'senza prezzo';

/** La bozza che Jarvis farebbe con queste letture, come nelle pratiche: un file dopo l'altro. */
export function draftFromReadings(venue, readings) {
  let source = '';
  for (const text of readings.filter(Boolean)) {
    const first = String(text).split(/\r?\n/).find((l) => l.trim());
    if (source.trim() && first && !/^\s*#/.test(first)) source += `\n# ${DEFAULT_SECTION}`;
    source += `\n${text}`;
  }
  const extraction = extractMenuFromText(venue || 'Locale', source, venue || 'locale');
  const doubts = source.split(/\r?\n/).filter((l) => /\[da verificare\]|\[\?\]/.test(l));
  for (const u of extraction.uncertain || []) doubts.push(typeof u === 'string' ? u : [u.text, u.line, u.source, u.reason].filter((v) => typeof v === 'string').join(' '));
  return { menu: extraction.menu, doubts };
}

/**
 * Confronto piatto per piatto. giusti: in bozza con il prezzo giusto. prezzoSbagliato: in bozza con un
 * prezzo diverso e nessun avviso (l'errore grave). senzaPrezzo: in bozza ma senza prezzo (la Revisione lo
 * segnala). daVerificare: non in bozza ma tra le righe dubbie che Jarvis chiede di controllare. persi: da
 * nessuna parte. inPiu: voci della bozza che nel menu giusto non ci sono.
 */
export function scoreCase(truthMenu, draftMenu, doubts = []) {
  const truth = menuItems(truthMenu), draft = menuItems(draftMenu).map((d) => ({ ...d, used: false }));
  const result = { totale: truth.length, giusti: 0, prezzoSbagliato: [], senzaPrezzo: [], daVerificare: [], persi: [], inPiu: [] };
  // Prima gli abbinamenti più sicuri: nome uguale e stesso prezzo vincono sulle somiglianze vaghe.
  const pairs = [];
  truth.forEach((t, ti) => draft.forEach((d, di) => {
    const score = nameScore(t.name, d.name);
    if (score >= 0.6) pairs.push({ ti, di, score: score + (samePrices(t.prices, d.prices) ? 0.5 : 0) });
  }));
  pairs.sort((p, q) => q.score - p.score);
  const matched = new Map();
  for (const p of pairs) if (!matched.has(p.ti) && !draft[p.di].used) { matched.set(p.ti, p.di); draft[p.di].used = true; }
  truth.forEach((t, ti) => {
    if (matched.has(ti)) {
      const d = draft[matched.get(ti)];
      if (samePrices(t.prices, d.prices)) result.giusti += 1;
      else if (!d.prices.length) result.senzaPrezzo.push({ nome: t.name, giusto: euro(t.prices) });
      else result.prezzoSbagliato.push({ nome: t.name, giusto: euro(t.prices), letto: euro(d.prices), nomeLetto: d.name });
      return;
    }
    if (doubts.some((line) => nameScore(t.name, line) >= 0.6 || (words(t.name).size >= 2 && [...words(t.name)].every((w) => words(line).has(w))))) result.daVerificare.push({ nome: t.name, giusto: euro(t.prices) });
    else result.persi.push({ nome: t.name, giusto: euro(t.prices) });
  });
  result.inPiu = draft.filter((d) => !d.used).map((d) => ({ nome: d.name, letto: euro(d.prices) }));
  return result;
}

const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '—');
/** Il resoconto per Telegram (breve) e per la Control Room. */
export function reportText(result) {
  const scored = result.cases.filter((c) => c.score);
  const sum = (key) => scored.reduce((n, c) => n + (Array.isArray(c.score[key]) ? c.score[key].length : c.score[key]), 0);
  const total = sum('totale');
  const lines = [`Prova di lettura finita: ${result.cases.length} locali, ${result.photos} foto${result.failed ? ` (${result.failed} non lette)` : ''}.`];
  if (total) {
    lines.push(`Su ${total} piatti: ${sum('giusti')} giusti (${pct(sum('giusti'), total)}), ${sum('daVerificare') + sum('senzaPrezzo')} segnalati da controllare, ${sum('persi')} persi, ${sum('prezzoSbagliato')} con il prezzo sbagliato senza avviso. Voci in più nella bozza: ${sum('inPiu')}.`);
  }
  for (const c of result.cases) {
    if (!c.score) { lines.push(`• ${c.nome}: ${c.error || 'manca il menu giusto per il confronto'}.`); continue; }
    const s = c.score;
    lines.push(`• ${c.nome}${c.provvisorio ? ' (riferimento provvisorio)' : ''}: ${s.giusti}/${s.totale} giusti, ${s.daVerificare.length + s.senzaPrezzo.length} da controllare, ${s.persi.length} persi, ${s.prezzoSbagliato.length} prezzi sbagliati, ${s.inPiu.length} in più.`);
  }
  const wrong = scored.flatMap((c) => c.score.prezzoSbagliato.map((w) => `${c.nome}: «${w.nome}» ${w.letto} invece di ${w.giusto}`));
  if (wrong.length) lines.push(`Prezzi sbagliati senza avviso:\n${wrong.slice(0, 8).map((w) => `– ${w}`).join('\n')}${wrong.length > 8 ? `\n…e altri ${wrong.length - 8}` : ''}`);
  return lines.join('\n');
}

async function getSetting(db, key) {
  const row = await db.prepare('SELECT value FROM jarvis_settings WHERE key=?').bind(key).first();
  return row ? row.value : null;
}
async function putSetting(db, key, value) {
  await db.prepare('INSERT INTO jarvis_settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at').bind(key, value, new Date().toISOString()).run();
}
const readJson = async (db, key) => { try { return JSON.parse(await getSetting(db, key) || 'null'); } catch { return null; } };

/** Avvia una prova (o dice a che punto è quella in corso). */
export async function startReadingTest(db, env, { fetchImpl = globalThis.fetch } = {}) {
  const running = await readJson(db, STATE);
  if (running?.queue?.length) return `Prova di lettura già in corso: ${running.photos - running.queue.length} foto lette su ${running.photos}. Ti scrivo io quando finisce.`;
  let cases;
  try {
    const response = await fetchImpl(CASES_URL, { headers: { 'Cache-Control': 'no-cache' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    cases = await response.json();
  } catch (error) { return `Non riesco a leggere l'elenco dei menu di prova (${String(error?.message || 'errore').slice(0, 80)}).`; }
  const valid = (Array.isArray(cases) ? cases : []).filter((c) => c && typeof c.id === 'string' && Array.isArray(c.foto) && c.foto.length);
  if (!valid.length) return 'L’elenco dei menu di prova è vuoto.';
  const queue = valid.flatMap((c) => c.foto.map((src, index) => ({ caseId: c.id, index, src })));
  const state = { startedAt: new Date().toISOString(), photos: queue.length, queue, cases: valid, readings: {}, notes: [] };
  await putSetting(db, STATE, JSON.stringify(state));
  return `Parte la prova di lettura: ${valid.length} locali, ${queue.length} foto. Le rileggo una alla volta quando non ci sono pratiche da leggere (Gemini usa la quota gratuita) e ti mando il risultato qui.`;
}

async function photoBytes(env, src, fetchImpl) {
  if (src.r2) {
    const object = await env.BUCKET?.get(src.r2);
    if (!object) throw new Error('foto non trovata in R2');
    return { bytes: new Uint8Array(await object.arrayBuffer()), mime: object.httpMetadata?.contentType || src.mime || 'image/jpeg' };
  }
  if (src.file && /^[a-z0-9][a-z0-9/_.-]*$/i.test(src.file) && !src.file.includes('..')) {
    const response = await fetchImpl(FILES_ROOT + src.file);
    if (!response.ok) throw new Error(`foto non scaricata (HTTP ${response.status})`);
    const mime = src.mime || (/\.png$/i.test(src.file) ? 'image/png' : /\.webp$/i.test(src.file) ? 'image/webp' : 'image/jpeg');
    return { bytes: new Uint8Array(await response.arrayBuffer()), mime };
  }
  throw new Error('origine della foto non valida');
}

async function truthMenu(db, c, fetchImpl) {
  const ref = c.riferimento || {};
  if (ref.pubblicato) {
    const response = await fetchImpl(PUBLIC_MENU(String(ref.pubblicato).replace(/[^a-z0-9-]/g, '')));
    if (!response.ok) throw new Error(`menu pubblicato non trovato (HTTP ${response.status})`);
    return response.json();
  }
  if (ref.file) {
    const response = await fetchImpl(FILES_ROOT + String(ref.file).replace(/\.\./g, ''));
    if (!response.ok) throw new Error(`riferimento non trovato (HTTP ${response.status})`);
    return response.json();
  }
  if (ref.bozza) {
    const row = await db.prepare('SELECT menu_json FROM drafts WHERE request_id=?').bind(String(ref.bozza)).first();
    if (!row) throw new Error('bozza di riferimento non trovata');
    return JSON.parse(row.menu_json);
  }
  return null;
}

/**
 * Un passo della prova: legge UNA foto. Quando la coda è vuota confronta tutto, salva il risultato e
 * restituisce { done: true, text } da mandare a Riccardo. Senza prova in corso restituisce null.
 */
export async function readingTestStep(db, env, { gemini = null, fetchImpl = globalThis.fetch } = {}) {
  let state = await readJson(db, STATE);
  if (!state?.queue) return null;
  // Un passo alla volta: una lettura può durare più di un giro dell'orologio.
  const stamp = new Date().toISOString(), stale = new Date(Date.now() - 6 * 60_000).toISOString();
  await db.prepare("INSERT OR IGNORE INTO jarvis_settings (key,value,updated_at) VALUES (?,'',?)").bind(LOCK, '1970-01-01T00:00:00.000Z').run();
  const got = await db.prepare("UPDATE jarvis_settings SET value='busy',updated_at=? WHERE key=? AND (value<>'busy' OR updated_at<?)").bind(stamp, LOCK, stale).run();
  if (got?.meta && got.meta.changes === 0) return null;
  try {
    if (state.queue.length) {
      const item = state.queue[0];
      let text = '', note = '';
      try {
        const { bytes, mime } = await photoBytes(env, item.src, fetchImpl);
        if (!PHOTO_TYPES.has(mime)) throw new Error(`formato ${mime}`);
        const read = await readMenuPhoto(env.AI, bytes, mime, { gemini });
        if (read.ok) text = read.text; else note = read.reason || 'non letta';
        if (read.models) note = `${note}${note ? ' · ' : ''}${read.models.join(', ')}`;
      } catch (error) { note = String(error?.message || 'errore').slice(0, 160); }
      // Rileggo lo stato: una nuova «/prova lettura» non va sovrascritta da un passo vecchio.
      const fresh = await readJson(db, STATE);
      if (!fresh?.queue?.length || fresh.startedAt !== state.startedAt) return null;
      state = fresh;
      state.queue.shift();
      (state.readings[item.caseId] ||= [])[item.index] = text;
      if (!text || note) state.notes.push({ caseId: item.caseId, index: item.index, note, failed: !text });
      await putSetting(db, STATE, JSON.stringify(state));
      if (state.queue.length) return { done: false, left: state.queue.length };
    }
    const result = { at: new Date().toISOString(), startedAt: state.startedAt, photos: state.photos, failed: state.notes.filter((n) => n.failed).length, cases: [] };
    for (const c of state.cases) {
      const entry = { id: c.id, nome: c.nome || c.id, provvisorio: Boolean(c.provvisorio) };
      try {
        const readings = state.readings[c.id] || [];
        const { menu, doubts } = draftFromReadings(entry.nome, readings);
        const truth = await truthMenu(db, c, fetchImpl);
        if (truth) entry.score = scoreCase(truth, menu, doubts);
        entry.letture = readings.map((t) => String(t || '').slice(0, 6000));
      } catch (error) { entry.error = String(error?.message || 'errore').slice(0, 160); }
      result.cases.push(entry);
    }
    result.notes = state.notes;
    result.text = reportText(result);
    await putSetting(db, LAST, JSON.stringify(result));
    await putSetting(db, STATE, '');
    return { done: true, text: result.text };
  } finally {
    await db.prepare("UPDATE jarvis_settings SET value='',updated_at=? WHERE key=?").bind(new Date().toISOString(), LOCK).run().catch(() => null);
  }
}

/** L'ultimo risultato, per «/prova lettura esito». */
export async function lastReadingTest(db) {
  const last = await readJson(db, LAST);
  const running = await readJson(db, STATE);
  const now = running?.queue?.length ? `In corso: ${running.photos - running.queue.length} foto lette su ${running.photos}.\n\n` : '';
  return `${now}${last?.text ? `Ultima prova (${String(last.at).slice(0, 16).replace('T', ' ')} UTC):\n${last.text}` : 'Nessuna prova di lettura finita finora. Scrivi «/prova lettura» per farne una.'}`;
}

// Anteprima dal vivo nella conversazione con Jarvis: confronta il menu prima e dopo una richiesta e
// prepara una «cartolina» leggera per la Control Room (le sezioni toccate, con le voci cambiate segnate).
// Solo confronto di dati: nessun modello, nessun costo.
const text = (value) => (typeof value === 'string' ? value : value && typeof value === 'object' ? String(value.it || Object.values(value).find((v) => typeof v === 'string') || '') : '').trim();
const key = (value) => text(value).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
export function priceText(item, section = null) {
  if (Array.isArray(item?.prezzi) && item.prezzi.length) return item.prezzi.map((p) => `${text(p.etichetta)} € ${p.prezzo}`.trim()).join(' · ');
  if (item?.prezzo !== undefined && item?.prezzo !== null && String(item.prezzo).trim()) return `${section?.tipo === 'degustazione' ? '+ ' : ''}€ ${String(item.prezzo).trim()}`;
  return '';
}
const MAX_SECTIONS = 3;
const MAX_ITEMS = 14;
const MAX_LINES = 8;

/**
 * Differenze tra due menu (oggetti come in menu_json). Ritorna l'elenco delle modifiche, voce per voce:
 * { mark: 'nuovo'|'tolto'|'prezzo'|'nome'|'descrizione'|'spostato', section, name, before?, after? }.
 */
export function menuDiff(before, after) {
  const changes = [];
  const old = new Map();
  for (const [si, section] of (before?.sezioni || []).entries()) {
    for (const [ii, item] of (section.voci || []).entries()) {
      const k = key(item.nome);
      if (k && !old.has(k)) old.set(k, { item, section, si, ii, used: false });
    }
  }
  const added = [];
  for (const section of after?.sezioni || []) {
    for (const [ii, item] of (section.voci || []).entries()) {
      const was = old.get(key(item.nome));
      if (!was) { added.push({ item, section, ii }); continue; }
      was.used = true;
      const name = text(item.nome), sec = text(section.nome);
      const p0 = priceText(was.item, was.section), p1 = priceText(item, section);
      if (p0 !== p1) changes.push({ mark: 'prezzo', section: sec, name, before: p0 || 'senza prezzo', after: p1 || 'senza prezzo' });
      else if (key(was.section.nome) !== key(section.nome)) changes.push({ mark: 'spostato', section: sec, name, before: text(was.section.nome), after: sec });
      else if (key(was.item.descrizione) !== key(item.descrizione)) changes.push({ mark: 'descrizione', section: sec, name, before: text(was.item.descrizione), after: text(item.descrizione) });
    }
  }
  const removed = [...old.values()].filter((o) => !o.used);
  for (const add of added) {
    // Stessa sezione, stesso posto, voce sparita: è la stessa voce con un nome nuovo.
    const twin = removed.find((r) => !r.paired && key(r.section.nome) === key(add.section.nome) && r.ii === add.ii);
    const name = text(add.item.nome), sec = text(add.section.nome);
    if (twin) {
      twin.paired = true;
      changes.push({ mark: 'nome', section: sec, name, before: text(twin.item.nome), after: name });
      const p0 = priceText(twin.item, twin.section), p1 = priceText(add.item, add.section);
      if (p0 !== p1) changes.push({ mark: 'prezzo', section: sec, name, before: p0 || 'senza prezzo', after: p1 || 'senza prezzo' });
    } else changes.push({ mark: 'nuovo', section: sec, name, after: priceText(add.item, add.section) });
  }
  for (const gone of removed.filter((r) => !r.paired)) changes.push({ mark: 'tolto', section: text(gone.section.nome), name: text(gone.item.nome), before: priceText(gone.item, gone.section) });
  return changes;
}

/** Una riga leggibile per modifica: «Frico: € 12 → € 14». */
export function changeLine(change) {
  if (change.mark === 'prezzo') return `${change.name}: ${change.before} → ${change.after}`;
  if (change.mark === 'nuovo') return `Nuova voce in ${change.section}: ${change.name}${change.after ? ` (${change.after})` : ''}`;
  if (change.mark === 'tolto') return `Tolta da ${change.section}: ${change.name}`;
  if (change.mark === 'nome') return `«${change.before}» ora si chiama «${change.after}»`;
  if (change.mark === 'spostato') return `${change.name}: da ${change.before} a ${change.after}`;
  return `${change.name}: descrizione cambiata`;
}

/**
 * Cartolina per la chat: { title, draftId, requestId, premium, mode, lines, total, sections:[{ name, items:[{ n, p, d, mark, was }] }], more }.
 * before null = bozza nuova o bozza mostrata così com'è (nessun segno, solo le prime sezioni).
 */
export function previewCard({ menu, before = null, title = '', draftId = '', requestId = '', mode = 'modifica' } = {}) {
  if (!menu?.sezioni?.length) return null;
  const changes = before ? menuDiff(before, menu) : [];
  const touched = new Set(changes.map((c) => key(c.section)));
  const all = menu.sezioni.map((section) => {
    const marks = new Map(changes.filter((c) => key(c.section) === key(section.nome) && c.mark !== 'tolto').map((c) => [key(c.name), c]));
    const items = (section.voci || []).map((item) => {
      const change = marks.get(key(item.nome));
      return { n: text(item.nome), p: priceText(item, section), d: text(item.descrizione).slice(0, 140), ...(change ? { mark: change.mark, was: change.mark === 'prezzo' || change.mark === 'nome' ? change.before : '' } : {}) };
    });
    for (const gone of changes.filter((c) => c.mark === 'tolto' && key(c.section) === key(section.nome))) items.push({ n: gone.name, p: gone.before || '', mark: 'tolto' });
    return { name: text(section.nome), items };
  });
  // Voci tolte da sezioni sparite del tutto.
  const orphan = changes.filter((c) => c.mark === 'tolto' && !menu.sezioni.some((s) => key(s.nome) === key(c.section)));
  if (orphan.length) all.push({ name: orphan[0].section, items: orphan.map((c) => ({ n: c.name, p: c.before || '', mark: 'tolto' })) });
  const chosen = changes.length ? all.filter((s) => touched.has(key(s.name))) : all;
  const sections = chosen.slice(0, MAX_SECTIONS).map((s) => {
    // Sezione lunga: si tengono le voci cambiate e un po' di contesto attorno.
    if (s.items.length <= MAX_ITEMS) return s;
    const keep = new Set();
    s.items.forEach((it, i) => { if (it.mark) for (let j = i - 1; j <= i + 1; j += 1) keep.add(j); });
    const list = keep.size ? s.items.filter((_, i) => keep.has(i)).slice(0, MAX_ITEMS) : s.items.slice(0, MAX_ITEMS);
    return { ...s, items: list, hidden: s.items.length - list.length };
  });
  return {
    title: text(title) || text(menu.nome) || 'Il menu',
    draftId, requestId, mode: changes.length ? mode : before ? 'uguale' : mode === 'modifica' ? 'bozza' : mode,
    premium: Boolean(menu.premium),
    total: changes.length,
    lines: changes.slice(0, MAX_LINES).map(changeLine),
    sections,
    more: Math.max(0, chosen.length - sections.length)
  };
}

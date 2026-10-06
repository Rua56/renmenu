/* Memoria dei locali: le note che Riccardo chiede di ricordare e il riassunto dell'ultimo menu
 * pubblicato. Serve a Jarvis per rispondere e per orientarsi nelle modifiche future; la fonte di
 * verità del menu resta sempre il file online su GitHub. */
const MAX_NOTE = 500;
const MAX_MENU = 4000;
const text = (value) => typeof value === 'string' ? value : value?.it || '';

/** Menu RenMenu → riassunto leggibile: sezioni, piatti e prezzi così come sono, niente di inventato. */
export function menuSummary(menu) {
  if (!menu || typeof menu !== 'object') return '';
  const lines = [`Menu «${text(menu.nome) || menu.id || 'senza nome'}»`];
  if (menu.coperto) lines.push(`Coperto ${menu.coperto} €`);
  for (const section of Array.isArray(menu.sezioni) ? menu.sezioni : []) {
    const items = (Array.isArray(section.voci) ? section.voci : []).map((voce) => `${text(voce.nome)}${voce.prezzo ? ` ${voce.prezzo} €` : ''}`).filter(Boolean);
    lines.push(`${text(section.nome) || 'Sezione'}: ${items.join('; ') || 'nessuna voce'}`);
  }
  return lines.join('\n').slice(0, MAX_MENU);
}

const id = () => `mem-${crypto.randomUUID()}`;
const nowIso = () => new Date().toISOString();

export function noteStatement(db, clientId, note, source) {
  const clean = String(note || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE);
  if (clean.length < 3) throw Object.assign(new Error('Nota troppo breve.'), { status: 400 });
  return db.prepare("INSERT INTO venue_memory (id,client_id,kind,text,source,created_at) VALUES (?,?,'nota',?,?,?)").bind(id(), clientId, clean, String(source).slice(0, 80), nowIso());
}

/** Sostituisce il riassunto del menu del locale (quello vecchio resta archiviato). */
export function menuStatements(db, clientId, menu, source) {
  const summary = menuSummary(menu);
  if (!summary) return [];
  const at = nowIso();
  return [
    db.prepare("UPDATE venue_memory SET archived_at=? WHERE client_id=? AND kind='menu' AND archived_at IS NULL").bind(at, clientId),
    db.prepare("INSERT INTO venue_memory (id,client_id,kind,text,source,created_at) VALUES (?,?,'menu',?,?,?)").bind(id(), clientId, summary, String(source).slice(0, 80), at)
  ];
}

export async function memoryFor(db, clientId) {
  const result = await db.prepare('SELECT id,kind,text,source,created_at FROM venue_memory WHERE client_id=? AND archived_at IS NULL ORDER BY created_at DESC LIMIT 40').bind(clientId).all();
  return result.results || [];
}

/** Testo compatto per il contesto di Jarvis: note recenti e menu online del locale. */
export function memoryContext(client, entries) {
  const notes = entries.filter((e) => e.kind === 'nota').slice(0, 10).map((e) => `- ${e.text} (${String(e.created_at).slice(0, 10)})`);
  const menu = entries.find((e) => e.kind === 'menu');
  return `Memoria su «${client.name}»${client.menu_id ? ` (menu ${client.menu_id})` : ''}:\n${notes.length ? `Note di Riccardo:\n${notes.join('\n')}` : 'Nessuna nota.'}\n${menu ? `Ultimo menu online (${String(menu.created_at).slice(0, 10)}):\n${menu.text}` : 'Nessun menu memorizzato.'}`;
}

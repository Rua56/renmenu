/* Dove sono i locali, per la mappa olografica della home (jarvis-holo.js). Nessun servizio esterno:
 * il paese si riconosce dal nome del locale, dalle note e dalle richieste («Enoteca Il Calice Storto Cormons»).
 * Senza paese il locale va attorno a Gorizia, in un punto fisso ricavato dal suo nome. */
export const CENTER = { name: 'Gorizia', lat: 45.9409, lon: 13.6205 };
// Paesi del Goriziano e dintorni (gradi decimali). I più lunghi prima: «Nova Gorica» prima di «Gorizia».
export const TOWNS = [
  ['San Floriano del Collio', 45.9800, 13.5900], ['Dolegna del Collio', 46.0300, 13.4800], ['Capriva del Friuli', 45.9420, 13.5120],
  ['Cividale del Friuli', 46.0937, 13.4325], ['Ronchi dei Legionari', 45.8270, 13.5040], ['Gradisca d\'Isonzo', 45.8920, 13.5000],
  ['Romans d\'Isonzo', 45.8900, 13.4400], ['Farra d\'Isonzo', 45.9100, 13.5200], ['Savogna d\'Isonzo', 45.9050, 13.5800],
  ['Nova Gorica', 45.9560, 13.6484], ['Šempeter', 45.9280, 13.6400], ['Sempeter', 45.9280, 13.6400], ['Monfalcone', 45.8095, 13.5330],
  ['Staranzano', 45.8030, 13.5050], ['Palmanova', 45.9056, 13.3101], ['Aquileia', 45.7697, 13.3700], ['Lignano', 45.6630, 13.1120],
  ['Sistiana', 45.7700, 13.6300], ['Duino', 45.7740, 13.6050], ['Sagrado', 45.8730, 13.4850], ['Lucinico', 45.9420, 13.5610],
  ['Cormons', 45.9554, 13.4673], ['Gradisca', 45.8920, 13.5000], ['Capriva', 45.9420, 13.5120], ['Mossa', 45.9370, 13.5490],
  ['Dobrovo', 45.9930, 13.5300], ['Trieste', 45.6495, 13.7768], ['Udine', 46.0711, 13.2346], ['Cividale', 46.0937, 13.4325],
  ['Grado', 45.6781, 13.3846], ['Ljubljana', 46.0569, 14.5058], ['Lubiana', 46.0569, 14.5058], ['Venezia', 45.4408, 12.3155],
  ['Gorizia', 45.9409, 13.6205]
].map(([name, lat, lon]) => ({ name: name.replace('Sempeter', 'Šempeter'), key: plain(name), lat, lon }));
// Costa del golfo di Trieste, da Grado a Muggia (approssimata): basta per orientarsi.
export const COAST = [[45.66, 13.30], [45.68, 13.38], [45.71, 13.44], [45.75, 13.50], [45.78, 13.54], [45.79, 13.57], [45.77, 13.60], [45.75, 13.63], [45.72, 13.67], [45.69, 13.71], [45.66, 13.75], [45.64, 13.76], [45.61, 13.74], [45.59, 13.72]];

function plain(text) { return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
function hash(text) { let h = 2166136261; for (const ch of String(text)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

/** Il paese citato nei testi (il primo trovato, i nomi lunghi vincono), o null. */
export function townIn(...texts) {
  const said = ` ${plain(texts.filter(Boolean).join(' '))} `;
  return TOWNS.find((town) => said.includes(` ${town.key} `)) || null;
}
/** Punto del locale: nel suo paese (spostato di poco, così due locali dello stesso paese non si coprono) o attorno a Gorizia. */
export function placeOf(id, town) {
  const h = hash(id);
  const angle = (h % 360) * Math.PI / 180;
  const spread = town ? 0.004 + ((h >> 9) % 100) / 100 * 0.006 : 0.012 + ((h >> 9) % 100) / 100 * 0.03;
  const base = town || CENTER;
  return { lat: base.lat + Math.sin(angle) * spread, lon: base.lon + Math.cos(angle) * spread * 1.4 };
}
/** Coordinate in km rispetto a Gorizia (x verso est, y verso nord). */
export function toKm(lat, lon) {
  return { x: (lon - CENTER.lon) * 111.32 * Math.cos(CENTER.lat * Math.PI / 180), y: (lat - CENTER.lat) * 110.57 };
}

/**
 * I locali per la mappa. state: { clients, requests }. decide: insieme di id dei clienti con una decisione in sospeso.
 * Ritorna [{ id, name, town, x, y, state: 'decide'|'online'|'lavoro'|'nuovo', plan, menuId, open }].
 */
export function venuesFor(state, decide = new Set()) {
  const requests = Array.isArray(state?.requests) ? state.requests : [];
  return (Array.isArray(state?.clients) ? state.clients : []).map((client) => {
    const own = requests.filter((r) => r.clientId === client.id);
    const open = own.filter((r) => !['completata', 'archiviata', 'chiusa'].includes(r.status));
    const town = townIn(client.name, client.internalNotes, ...own.slice(0, 4).map((r) => `${r.subject || ''} ${String(r.sourceText || '').slice(0, 1500)}`));
    const point = toKm(...Object.values(placeOf(client.id, town)));
    const status = decide.has(client.id) ? 'decide' : client.menuId ? 'online' : open.length ? 'lavoro' : 'nuovo';
    return { id: client.id, name: String(client.name || '').replace(/\s+—\s+demo$/i, ''), town: town?.name || '', x: point.x, y: point.y, state: status, plan: client.plan || '', menuId: client.menuId || '', open: open.length };
  });
}

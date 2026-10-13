// Copia di sicurezza del database di Jarvis (D1) nel bucket privato R2.
// Una volta al giorno, tra le 3:00 e le 3:59 ora italiana, l'orologio salva tutte le tabelle
// (schema e righe) in un file JSON compresso `backups/d1/AAAA-MM-GG.json.gz` e cancella le copie
// più vecchie di 30 giorni. Solo letture su D1: nessuna riga viene modificata, tranne l'annotazione
// `last_backup` in jarvis_settings. Il ripristino si fa a mano con `control-room/staging/d1-restore.mjs`.
import { romeDay } from './briefing.js';

export const BACKUP_PREFIX = 'backups/d1/';
export const BACKUP_KEEP_DAYS = 30;
const PAGE = 500;
const DAY = 86_400_000;

const romeHour = (date) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', hourCycle: 'h23' }).format(date));
export const backupDue = (date = new Date()) => romeHour(date) === 3;
export const backupKey = (day) => `${BACKUP_PREFIX}${day}.json.gz`;
const quote = (name) => `"${String(name).replace(/"/g, '""')}"`;

async function all(db, sql, ...params) {
  const result = await db.prepare(sql).bind(...params).all();
  return result?.results || [];
}

// Tabelle interne di Cloudflare e di SQLite restano fuori; d1_migrations resta dentro, così un
// database ripristinato sa già quali migrazioni ha.
export async function snapshot(db, { now = new Date() } = {}) {
  const schema = await all(db, "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name");
  const tables = {};
  let rows = 0;
  for (const { name } of schema.filter((s) => s.type === 'table')) {
    const list = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await all(db, `SELECT * FROM ${quote(name)} ORDER BY rowid LIMIT ? OFFSET ?`, PAGE, offset)
        .catch(() => all(db, `SELECT * FROM ${quote(name)} LIMIT ? OFFSET ?`, PAGE, offset));
      list.push(...page);
      if (page.length < PAGE) break;
    }
    tables[name] = list;
    rows += list.length;
  }
  return { format: 'renmenu-d1-backup', version: 1, createdAt: now.toISOString(), schema, tables, rows };
}

async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function prune(bucket, today) {
  if (typeof bucket?.list !== 'function') return 0;
  const limit = romeDay(new Date(Date.parse(`${today}T12:00:00Z`) - BACKUP_KEEP_DAYS * DAY));
  let removed = 0, cursor;
  do {
    const page = await bucket.list({ prefix: BACKUP_PREFIX, cursor });
    for (const object of page?.objects || []) {
      const day = object.key.slice(BACKUP_PREFIX.length, BACKUP_PREFIX.length + 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day < limit) { await bucket.delete(object.key); removed += 1; }
    }
    cursor = page?.truncated ? page.cursor : undefined;
  } while (cursor);
  return removed;
}

async function remember(db, value, at) {
  await db.prepare('INSERT INTO jarvis_settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
    .bind('last_backup', JSON.stringify(value), at.toISOString()).run();
}

async function lastBackup(db) {
  try { return JSON.parse((await db.prepare('SELECT value FROM jarvis_settings WHERE key=?').bind('last_backup').first())?.value || 'null'); }
  catch { return null; }
}

// Restituisce null se non è l'ora o la copia di oggi esiste già; altrimenti l'esito.
// Un errore viene annotato e ritentato al giro successivo, al massimo 3 volte nella stessa ora.
export async function dailyBackup(db, bucket, { now = new Date(), force = false } = {}) {
  if (!force && !backupDue(now)) return null;
  const day = romeDay(now);
  const previous = await lastBackup(db);
  if (!force && previous?.day === day && (previous.ok || previous.attempts >= 3)) return null;
  const attempts = previous?.day === day ? (previous.attempts || 0) + 1 : 1;
  if (typeof bucket?.put !== 'function') {
    const outcome = { day, ok: false, attempts, error: 'BUCKET_MISSING' };
    await remember(db, outcome, now);
    return outcome;
  }
  try {
    const copy = await snapshot(db, { now });
    const bytes = await gzip(JSON.stringify(copy));
    const key = backupKey(day);
    await bucket.put(key, bytes, { httpMetadata: { contentType: 'application/gzip' }, customMetadata: { rows: String(copy.rows) } });
    const removed = await prune(bucket, day).catch(() => 0);
    const outcome = { day, ok: true, attempts, key, rows: copy.rows, tables: Object.keys(copy.tables).length, bytes: bytes.length, removed };
    await remember(db, outcome, now);
    return outcome;
  } catch (error) {
    const outcome = { day, ok: false, attempts, error: String(error?.message || error).slice(0, 200) };
    await remember(db, outcome, now).catch(() => null);
    return outcome;
  }
}

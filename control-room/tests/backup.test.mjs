import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { backupDue, backupKey, dailyBackup, snapshot } from '../cloudflare/functions/_lib/backup.js';
import { readBackup, restoreSql } from '../staging/d1-restore.mjs';

const MIGRATIONS = new URL('../cloudflare/migrations/', import.meta.url);
function migrated() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
  return sqlite;
}
function d1(sqlite) {
  return {
    sqlite,
    prepare(sql) {
      return { bind(...params) {
        const statement = sqlite.prepare(sql);
        return {
          first: () => statement.get(...params) || null,
          all: () => ({ results: statement.all(...params).map((row) => ({ ...row })) }),
          run: () => ({ meta: { changes: statement.run(...params).changes } })
        };
      } };
    }
  };
}
function bucket(initial = []) {
  const objects = new Map(initial.map((key) => [key, new Uint8Array([1])]));
  return {
    objects,
    async put(key, bytes) { objects.set(key, bytes); },
    async delete(key) { objects.delete(key); },
    async list({ prefix }) { return { objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false }; }
  };
}
function seed(sqlite) {
  const stamp = '2026-10-12T10:00:00.000Z';
  sqlite.prepare('INSERT INTO jarvis_settings (key,value,updated_at) VALUES (?,?,?)').run('telegram_chat_id', '123', stamp);
  sqlite.prepare('INSERT INTO jarvis_settings (key,value,updated_at) VALUES (?,?,?)').run('nota', "L'osteria \"Codelli\"\nriga due", stamp);
  for (let i = 0; i < 1203; i += 1) sqlite.prepare('INSERT INTO jarvis_settings (key,value,updated_at) VALUES (?,?,?)').run(`k${i}`, String(i), stamp);
}
const at330 = new Date('2026-10-13T01:30:00.000Z'); // 3:30 a Roma (ora legale)
const dump = (sqlite) => Object.fromEntries(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
  .map(({ name }) => [name, sqlite.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all().map((r) => ({ ...r }))]));

describe('copia di sicurezza del database', () => {
  it('parte solo tra le 3:00 e le 3:59 ora italiana', () => {
    assert.equal(backupDue(at330), true);
    assert.equal(backupDue(new Date('2026-10-13T02:30:00.000Z')), false); // 4:30
    assert.equal(backupDue(new Date('2026-12-13T02:30:00.000Z')), true); // 3:30 in inverno
  });

  it('salva tutte le tabelle e il ripristino ricrea lo stesso database', async () => {
    const source = migrated(); seed(source);
    const before = dump(source);
    const store = bucket();
    const outcome = await dailyBackup(d1(source), store, { now: at330 });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.key, backupKey('2026-10-13'));
    const bytes = store.objects.get(outcome.key);
    assert.equal(bytes[0], 0x1f); // gzip
    const copy = readBackup(Buffer.from(bytes));
    assert.equal(copy.tables.jarvis_settings.length, 1205);

    const restored = new DatabaseSync(':memory:');
    restored.exec(restoreSql(copy));
    const after = dump(restored);
    delete before.jarvis_settings; delete after.jarvis_settings; // last_backup aggiunta dopo la copia
    assert.deepEqual(after, before);
    const nota = restored.prepare("SELECT value FROM jarvis_settings WHERE key='nota'").get();
    assert.equal(nota.value, "L'osteria \"Codelli\"\nriga due");
    const indexes = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name").all().map((r) => r.name);
    assert.deepEqual(indexes(restored), indexes(source));
  });

  it('una sola copia al giorno, e fuori orario non fa nulla', async () => {
    const db = d1(migrated());
    const store = bucket();
    assert.equal(await dailyBackup(db, store, { now: new Date('2026-10-13T08:00:00.000Z') }), null);
    assert.equal((await dailyBackup(db, store, { now: at330 })).ok, true);
    assert.equal(await dailyBackup(db, store, { now: new Date('2026-10-13T01:31:00.000Z') }), null);
    assert.equal(store.objects.size, 1);
  });

  it('tiene 30 giorni di copie e non tocca altri file del bucket', async () => {
    const store = bucket([backupKey('2026-09-01'), backupKey('2026-09-12'), backupKey('2026-09-13'), backupKey('2026-10-12'), 'mail/foto.jpg']);
    const outcome = await dailyBackup(d1(migrated()), store, { now: at330 });
    assert.equal(outcome.removed, 2);
    assert.deepEqual([...store.objects.keys()].sort(), [backupKey('2026-09-13'), backupKey('2026-10-12'), backupKey('2026-10-13'), 'mail/foto.jpg'].sort());
  });

  it('senza bucket annota l\'errore e si ferma dopo tre tentativi', async () => {
    const db = d1(migrated());
    for (let i = 1; i <= 3; i += 1) {
      const outcome = await dailyBackup(db, null, { now: at330 });
      assert.deepEqual([outcome.ok, outcome.attempts, outcome.error], [false, i, 'BUCKET_MISSING']);
    }
    assert.equal(await dailyBackup(db, null, { now: at330 }), null);
    const saved = JSON.parse(db.sqlite.prepare("SELECT value FROM jarvis_settings WHERE key='last_backup'").get().value);
    assert.equal(saved.attempts, 3);
  });

  it('non mette nella copia le tabelle interne', async () => {
    const sqlite = migrated();
    sqlite.exec('CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB)');
    const copy = await snapshot(d1(sqlite));
    assert.equal('_cf_KV' in copy.tables, false);
  });

  it('rifiuta un file che non è una copia di Jarvis', () => {
    assert.throws(() => readBackup(Buffer.from('{"format":"altro"}')), /formato sconosciuto/);
  });
});

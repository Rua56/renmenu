import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { buildDigest, digestText, recordEvent, SILENT_DAYS } from '../cloudflare/functions/_lib/journal.js';

const NOW = new Date('2026-10-13T06:00:00Z');
const ago = (days) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

function database({ migrations = true } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  if (migrations) {
    const dir = new URL('../cloudflare/migrations/', import.meta.url);
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(file, dir), 'utf8'));
  }
  return {
    sqlite,
    prepare(sql) {
      return { bind(...params) {
        const statement = sqlite.prepare(sql);
        return { first: async () => statement.get(...params) || null, all: async () => ({ results: statement.all(...params) }), run: async () => ({ meta: { changes: statement.run(...params).changes } }) };
      } };
    }
  };
}

function seed(db) {
  const s = db.sqlite;
  const client = (id, name, menu, created) => s.prepare("INSERT INTO clients (id,name,menu_id,created_at,updated_at) VALUES (?,?,?,?,?)").run(id, name, menu, created, created);
  const request = (id, clientId, kind, status, created, updated = created) => s.prepare("INSERT INTO requests (id,client_id,subject,source_channel,kind,status,created_at,updated_at) VALUES (?,?,?,'email',?,?,?,?)").run(id, clientId, `Pratica ${id}`, kind, status, created, updated);
  const audit = (action, summary, requestId, at) => s.prepare("INSERT INTO audit_events (id,request_id,action,summary,actor,created_at) VALUES (?,?,?,?,'jarvis',?)").run(crypto.randomUUID(), requestId, action, summary, at);
  client('c1', 'Al Bakaro', 'al-bakaro', ago(200));
  client('c2', 'Caffè Bon Bon', 'caffe-bon-bon', ago(120));
  client('c3', 'Osteria Nuova', null, ago(3));
  request('r-old', 'c2', 'nuovo', 'completata', ago(100), ago(95));
  request('r1', 'c1', 'prezzo', 'completata', ago(4), ago(2));
  request('r2', 'c1', 'aggiornamento', 'in_revisione', ago(1));
  request('r3', 'c3', 'nuovo', 'bozza_pronta', ago(3));
  audit('draft.generate', 'Bozza generata.', 'r1', ago(3));
  audit('draft.generate', 'Bozza generata.', 'r3', ago(2));
  audit('draft.rebuild', 'Bozza rifatta.', 'r3', ago(2));
  audit('draft.telegram_edit', 'Correzione.', 'r1', ago(2));
  audit('draft.telegram_edit', 'Correzione.', 'r1', ago(2));
  audit('draft.save', 'Salvata.', 'r3', ago(1));
  audit('material.check', 'Dubbio «Frico»: 9 € (scelto da Riccardo).', 'r3', ago(2));
  audit('material.check', 'Dubbio «Totale»: non è nel menu.', 'r3', ago(2));
  audit('material.check', 'Dubbio «Vino»: saltato.', 'r3', ago(2));
  audit('material.read.failed', 'Non letto.', 'r3', ago(2));
  audit('jarvis.entrust', 'Affidata.', 'r1', ago(3));
  audit('jarvis.publish_ok', 'SÌ.', 'r1', ago(2));
  audit('github.publication.verified', 'Online.', 'r1', ago(2));
  audit('draft.generate', 'Vecchia.', 'r-old', ago(30));
  audit('jarvis.chat', 'Non contato.', null, ago(1));
}

test('diario: recordEvent annota e non lancia mai, nemmeno senza tabella', async () => {
  const db = database();
  assert.equal(await recordEvent(db, 'errore.missione', { requestId: 'r1', detail: { errore: 'x'.repeat(5000) }, now: NOW }), true);
  const row = db.sqlite.prepare('SELECT kind,request_id,detail_json FROM jarvis_events').get();
  assert.equal(row.kind, 'errore.missione');
  assert.equal(row.request_id, 'r1');
  assert.ok(row.detail_json.length <= 1000);
  assert.equal(await recordEvent(database({ migrations: false }), 'errore.missione'), false);
});

test('diario: il riepilogo conta solo la settimana e raggruppa il registro', async () => {
  const db = database();
  seed(db);
  await recordEvent(db, 'errore.missione', { requestId: 'r1', now: new Date(ago(1)) });
  await recordEvent(db, 'errore.missione', { requestId: 'r1', now: new Date(ago(20)) });
  const d = await buildDigest(db, { now: NOW });
  assert.equal(d.richieste.nuove, 3);
  assert.equal(d.richieste.completate, 1);
  assert.equal(d.richieste.giorniMedi, 2);
  assert.deepEqual(d.bozze, { generate: 2, rifatte: 1 });
  assert.equal(d.correzioni.telegram, 2);
  assert.equal(d.correzioni.controlRoom, 1);
  assert.deepEqual(d.correzioni.perLocale[0], { name: 'Al Bakaro', n: 2 });
  assert.deepEqual(d.letture, { dubbi: 3, dubbiSaltati: 1, dubbiFuoriMenu: 1, fallite: 1 });
  assert.deepEqual(d.missioni, { affidate: 1, si: 1, pubblicate: 1, fermate: 0, fermeOra: 0 });
  assert.deepEqual(d.errori.diario, [{ kind: 'errore.missione', n: 1 }]);
  assert.deepEqual(d.locali.piuAttivi, [{ name: 'Al Bakaro', n: 2 }]);
  // Caffè Bon Bon: menu online, ultima richiesta 100 giorni fa. Osteria Nuova non ha menu online.
  assert.deepEqual(d.locali.silenziosi, [{ name: 'Caffè Bon Bon', days: 100 }]);
  assert.ok(SILENT_DAYS < 100);
});

test('diario: il testo per Telegram riassume senza dati di contatto', async () => {
  const db = database();
  seed(db);
  db.sqlite.prepare("UPDATE clients SET email='locale@example.com',phone='+39 333 0000000'").run();
  await recordEvent(db, 'errore.missione', { requestId: 'r1', now: new Date(ago(1)) });
  const text = digestText(await buildDigest(db, { now: NOW }));
  assert.match(text, /^Diario di Jarvis · dal 06\/10 al 13\/10/);
  assert.match(text, /Richieste: 3 nuove .*1 chiuse in 2 giorni di media/);
  assert.match(text, /Correzioni: 3 tue \(2 da Telegram, 1 dalla Control Room\)/);
  assert.match(text, /3 dubbi chiusi da te \(1 saltati\), 1 righe che non erano piatti; 1 file non letti/);
  assert.match(text, /Errori: 1 errori dell’orologio sulle pratiche\./);
  assert.match(text, /Caffè Bon Bon \(100 giorni\)/);
  assert.doesNotMatch(text, /example\.com|333/);
});

test('diario: database vuoto o senza tabelle dà un riepilogo a zero', async () => {
  for (const db of [database(), database({ migrations: false })]) {
    const text = digestText(await buildDigest(db, { now: NOW }));
    assert.match(text, /Richieste: 0 nuove, 0 chiuse\./);
    assert.match(text, /Errori: nessuno\./);
  }
});

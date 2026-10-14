import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { activeInitiatives, findInitiatives, loadInitiatives } from '../cloudflare/functions/_lib/initiative.js';
import { jarvisAsk, missions } from '../cloudflare/functions/control-room/api/[[route]].js';

const TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const NOW = Date.parse('2026-10-14T10:00:00Z');
const iso = (daysAgo) => new Date(NOW - daysAgo * 86_400_000).toISOString();
function database() {
  const sqlite = new DatabaseSync(':memory:');
  const dir = new URL('../cloudflare/migrations/', import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(file, dir), 'utf8'));
  const db = {
    sqlite,
    prepare(sql) {
      return { bind(...params) {
        const statement = sqlite.prepare(sql);
        return { first: () => statement.get(...params) || null, all: () => ({ results: statement.all(...params) }), run: () => ({ meta: { changes: statement.run(...params).changes } }) };
      } };
    },
    async batch(statements) { return statements.map((s) => s.run()); }
  };
  return db;
}
function seed(db) {
  const q = (sql, ...p) => db.sqlite.prepare(sql).run(...p);
  q("INSERT INTO clients (id,name,plan,created_at,updated_at) VALUES ('c1','Codelli 23','standard',?,?)", iso(20), iso(20));
  q("INSERT INTO clients (id,name,plan,trial_ends_at,created_at,updated_at) VALUES ('c2','Bakaro','standard',?,?,?)", new Date(NOW + 2 * 86_400_000).toISOString(), iso(30), iso(30));
  q("INSERT INTO clients (id,name,plan,created_at,updated_at) VALUES ('c3','Al Chiostro','da_definire',?,?)", iso(10), iso(10));
  q("INSERT INTO requests (id,client_id,subject,source_channel,kind,status,created_at,updated_at) VALUES ('r1','c1','Menu Codelli','email','nuovo','in_revisione',?,?)", iso(8), iso(8));
  q("INSERT INTO drafts (id,request_id,slug,menu_json,status,created_at,updated_at) VALUES ('d1','r1','codelli-23','{\"nome\":\"Codelli 23\"}','revisione',?,?)", iso(8), iso(8));
  q("INSERT INTO requests (id,client_id,subject,source_channel,kind,status,created_at,updated_at) VALUES ('r2','c2','Nuovo menu','whatsapp','nuovo','nuova',?,?)", iso(4), iso(4));
}

test('Jarvis propositivo: trova bozze ferme, richieste senza bozza, prove in scadenza e locali senza menu', async () => {
  const db = database(); seed(db);
  const list = await loadInitiatives(db, NOW);
  const keys = list.map((i) => i.key);
  assert.deepEqual(keys, ['prova:c2', 'bozza:d1', 'richiesta:r2', 'senzamenu:c3']);
  assert.match(list.find((i) => i.key === 'bozza:d1').text, /Codelli 23.*da 8 giorni/);
  assert.deepEqual(list.find((i) => i.key === 'bozza:d1').buttons.map(([, d]) => d), ['peek:d1', 'affq:d1']);
  assert.match(list[0].text, /prova di «Bakaro» finisce tra 2 giorni/);
});

test('Jarvis propositivo: niente proposte per cose recenti, e «più tardi» / «lascia stare» le nascondono', () => {
  const fresh = findInitiatives({ drafts: [{ id: 'd', request_id: 'r', updated_at: iso(1), menu_json: '{}' }], waiting: [{ id: 'r9', status: 'nuova', updated_at: iso(1) }] }, NOW);
  assert.equal(fresh.length, 0);
  const list = findInitiatives({ drafts: [{ id: 'd', request_id: 'r', updated_at: iso(5), menu_json: '{"nome":"X"}' }] }, NOW);
  assert.equal(list.length, 1);
  assert.equal(activeInitiatives(list, { 'bozza:d': { later: new Date(NOW + 1000).toISOString() } }, NOW).length, 0);
  assert.equal(activeInitiatives(list, { 'bozza:d': { mute: new Date(NOW - 1000).toISOString() } }, NOW).length, 1);
});

// Telegram finto: raccoglie i messaggi che Jarvis manderebbe.
function telegram() {
  const sent = [];
  const fetchImpl = async (url, init = {}) => {
    if (String(url).includes('/sendMessage')) sent.push(JSON.parse(init.body));
    return Response.json({ ok: true, result: { message_id: sent.length } });
  };
  return { sent, fetchImpl };
}

test('Jarvis propositivo: di giorno propone da solo una cosa, con Più tardi e Lascia stare, al massimo una all’ora', async () => {
  const db = database(); seed(db);
  const tg = telegram();
  const m = missions;
  const previous = globalThis.fetch;
  globalThis.fetch = tg.fetchImpl;
  try {
  await m.putSetting(db, 'telegram_chat_id', '42');
  const env = { DB: db, TELEGRAM_BOT_TOKEN: TOKEN };
  assert.equal(await m.initiativeTick(db, env, { now: new Date('2026-10-14T05:00:00Z') }), null); // le 7 in Italia: troppo presto
  const pick = await m.initiativeTick(db, env, { now: new Date('2026-10-14T10:00:00Z') });
  assert.ok(pick);
  assert.equal(tg.sent.length, 1);
  assert.match(tg.sent[0].text, /^Ti propongo una cosa, Riccardo\./);
  const datas = tg.sent[0].reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(datas.includes(`ini:later:${pick.key}`) && datas.includes(`ini:mute:${pick.key}`));
  assert.equal(await m.initiativeTick(db, env, { now: new Date('2026-10-14T10:05:00Z') }), null); // già fatto quest'ora
  // «Lascia stare»: non torna.
  await m.telegramUpdate(db, env, { callback_query: { id: 'q', data: `ini:mute:${pick.key}`, message: { chat: { id: 42 }, message_id: 1 } } });
  assert.match(tg.sent.at(-1).text, /due settimane/);
  assert.ok(!(await m.initiatives(db)).some((i) => i.key === pick.key));
  // /idee no: niente più proposte da sole.
  await m.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: '/idee no' } });
  assert.equal(await m.setting(db, 'ini_enabled'), 'no');
  } finally { globalThis.fetch = previous; }
});

test('Jarvis propositivo: «cosa mi proponi?» nella Control Room elenca le proposte con i pulsanti', async () => {
  const db = database(); seed(db);
  await missions.putSetting(db, 'telegram_chat_id', '42');
  const previous = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ ok: true, result: {} });
  try {
    const out = await jarvisAsk({ DB: db, TELEGRAM_BOT_TOKEN: TOKEN }, { text: 'Jarvis, cosa mi proponi?' });
    assert.match(out.messages[0].text, /Ecco cosa ti propongo/);
    assert.ok(out.messages.some((x) => x.buttons.some(([, d]) => d === 'peek:d1')));
    // La situazione (telefono e dialogo dal vivo) le contiene.
    assert.match(await missions.statusText(db), /Cosa ti propongo:/);
  } finally { globalThis.fetch = previous; }
});

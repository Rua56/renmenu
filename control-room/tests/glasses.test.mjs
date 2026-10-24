import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { jarvisGlasses, missions } from '../cloudflare/functions/control-room/api/[[route]].js';
import { onRequest as hook } from '../cloudflare/functions/jarvis-hook/[[route]].js';
import { GLASSES_ORIGIN, glassesInstallLink, glassesQr, glassesText } from '../cloudflare/functions/_lib/glasses.js';

const TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
function database() {
  const sqlite = new DatabaseSync(':memory:');
  const dir = new URL('../cloudflare/migrations/', import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(file, dir), 'utf8'));
  return {
    raw: sqlite,
    prepare(sql) {
      return { bind(...params) {
        const statement = sqlite.prepare(sql);
        return { first: () => statement.get(...params) || null, all: () => ({ results: statement.all(...params) }), run: () => ({ meta: { changes: statement.run(...params).changes } }) };
      } };
    },
    async batch(statements) {
      sqlite.exec('BEGIN TRANSACTION');
      try { const results = statements.map((s) => s.run()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    }
  };
}
// Telegram finto: ogni chiamata viene registrata.
async function withTelegram(fn) {
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ href: String(url), body: typeof options.body === 'string' ? JSON.parse(options.body) : options.body });
    return Response.json({ ok: true, result: { message_id: calls.length } });
  };
  try { return await fn(calls); } finally { globalThis.fetch = previous; }
}
const send = (db, env, text) => missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text } });
async function linked(db) {
  await missions.putSetting(db, 'telegram_chat_id', '42');
  return { DB: db, TELEGRAM_BOT_TOKEN: TOKEN };
}
const keyOf = async (db) => JSON.parse(await missions.setting(db, 'glasses_key')).key;

test('occhiali: link di installazione e testo per le lenti', async () => {
  const link = glassesInstallLink('abc');
  assert.match(link, /^fb-viewapp:\/\/web_app_deep_link\?appName=Jarvis&appUrl=https%3A%2F%2Fjarvis-meta-display\.vercel\.app%2F%3Fk%3Dabc$/);
  const png = await glassesQr('a'.repeat(64));
  assert.deepEqual([...png.slice(1, 4)], [80, 78, 71], 'il QR è un PNG');
  assert.equal(glassesText('Anteprima: https://renmenu.com/x\n\n\n\nFatto'), 'Anteprima:\n\nFatto');
});

test('/occhiali: chiave nuova con link del telefono e QR; la vecchia non vale più; «spegni» la toglie', async () => {
  await withTelegram(async (calls) => {
    const db = database(), env = await linked(db);
    assert.equal((await jarvisGlasses(env, { chiave: '', text: '/stato' })).status, 403, 'senza chiave nessuna risposta');
    await send(db, env, '/occhiali');
    const first = await keyOf(db);
    assert.match(first, /^[a-f0-9]{64}$/);
    const text = calls.filter((c) => c.href.endsWith('/sendMessage')).at(-1).body.text;
    assert.ok(text.includes(`https://jarvis-meta-display.vercel.app/telefono/?k=${first}`));
    assert.ok(calls.some((c) => c.href.endsWith('/sendPhoto')), 'il QR parte come foto');
    await send(db, env, 'collega gli occhiali');
    const second = await keyOf(db);
    assert.notEqual(second, first);
    assert.equal((await jarvisGlasses(env, { chiave: first, text: '/stato' })).status, 403);
    const out = await jarvisGlasses(env, { chiave: second, text: '/stato' });
    assert.equal(out.ok, true);
    assert.equal(out.domanda, '/stato');
    assert.ok(out.messages.length > 0 && out.messages.every((m) => typeof m.text === 'string' && Array.isArray(m.buttons)));
    // Gli occhiali leggono l'ultima risposta (anche quella chiesta dal telefono) una volta sola.
    assert.equal((await jarvisGlasses(env, { chiave: second, azione: 'ultimo' })).ultimo.id, out.id);
    assert.equal((await jarvisGlasses(env, { chiave: second, azione: 'ultimo', dopo: out.id })).ultimo, null);
    await send(db, env, '/occhiali spegni');
    assert.equal(await missions.setting(db, 'glasses_key'), null);
    assert.equal((await jarvisGlasses(env, { chiave: second, text: '/stato' })).status, 403);
  });
});

test('occhiali: la chiave non si cambia dalle lenti e la pubblicazione resta su Telegram', async () => {
  await withTelegram(async () => {
    const db = database(), env = await linked(db);
    await missions.putSetting(db, 'glasses_key', JSON.stringify({ key: 'k'.repeat(64), at: new Date().toISOString() }));
    await missions.putSetting(db, 'cr_buttons', JSON.stringify(['pub:m1', 'pubno:m1']));
    const asked = await jarvisGlasses(env, { chiave: 'k'.repeat(64), text: '/occhiali' });
    assert.match(asked.messages[0].text, /solo da Telegram/);
    assert.equal(await keyOf(db), 'k'.repeat(64));
    assert.equal((await jarvisGlasses(env, { chiave: 'k'.repeat(64), press: 'pub:m1' })).status, 409);
    assert.equal((await jarvisGlasses(env, { chiave: 'k'.repeat(64), press: 'inventato:1' })).status, 409, 'solo pulsanti offerti');
  });
});

test('/jarvis-hook/occhiali: CORS solo per la web app, corpo text/plain senza preflight', async () => {
  await withTelegram(async () => {
    const db = database(), env = await linked(db);
    await missions.putSetting(db, 'glasses_key', JSON.stringify({ key: 'k'.repeat(64), at: new Date().toISOString() }));
    const url = 'https://renmenu-jarvis-stage.pages.dev/jarvis-hook/occhiali';
    const pre = await hook({ request: new Request(url, { method: 'OPTIONS', headers: { Origin: GLASSES_ORIGIN } }), env });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('Access-Control-Allow-Origin'), GLASSES_ORIGIN);
    const post = (origin, body) => hook({ request: new Request(url, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'text/plain' }, body: JSON.stringify(body) }), env });
    const ok = await post(GLASSES_ORIGIN, { chiave: 'k'.repeat(64), text: '/stato' });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('Access-Control-Allow-Origin'), GLASSES_ORIGIN);
    assert.equal((await ok.json()).ok, true);
    const foreign = await post('https://altro.example', { chiave: 'k'.repeat(64), azione: 'ultimo' });
    assert.equal(foreign.headers.get('Access-Control-Allow-Origin'), null, 'altre origini: il browser non legge la risposta');
    assert.equal((await post(GLASSES_ORIGIN, { chiave: 'sbagliata', text: 'ciao' })).status, 403);
  });
});

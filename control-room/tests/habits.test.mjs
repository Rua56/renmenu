import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { missions } from '../cloudflare/functions/control-room/api/[[route]].js';
import { ASK_AFTER, habitOf, isAuto, recordChoice, rulesView, setRule } from '../cloudflare/functions/_lib/habits.js';

const TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
function database() {
  const sqlite = new DatabaseSync(':memory:');
  const dir = new URL('../cloudflare/migrations/', import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(file, dir), 'utf8'));
  return {
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
async function telegram(fn) {
  const sent = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes('/sendMessage')) sent.push(JSON.parse(options.body));
    return Response.json({ ok: true, result: { message_id: 1 } });
  };
  try { return await fn(sent); } finally { globalThis.fetch = previous; }
}

test('Abitudini: quali pulsanti insegnano qualcosa', () => {
  assert.deepEqual(habitOf('aff:d1:3:n'), { kind: 'anteprima', yes: true });
  assert.deepEqual(habitOf('affno:x'), { kind: 'anteprima', yes: false });
  assert.deepEqual(habitOf('soll:m1'), { kind: 'promemoria', yes: true });
  assert.deepEqual(habitOf('rep:send:r1'), { kind: 'risposta', yes: true });
  assert.deepEqual(habitOf('rep:edit:r1'), { kind: 'risposta', yes: false });
  // Pubblicare ed eliminare non diventano mai abitudini.
  assert.equal(habitOf('pub:m1'), null);
  assert.equal(habitOf('del:r1'), null);
  assert.equal(habitOf('affq:d1'), null);
});

test('Abitudini: chiede dopo tre sì di fila, un no azzera, «chiedimelo sempre» rimanda', () => {
  let state = {};
  const yes = { kind: 'risposta', yes: true }, no = { kind: 'risposta', yes: false };
  for (let i = 1; i < ASK_AFTER; i += 1) { const out = recordChoice(state, yes); state = out.state; assert.equal(out.ask, false); }
  state = recordChoice(state, no).state;
  assert.equal(state.risposta.streak, 0);
  for (let i = 1; i < ASK_AFTER; i += 1) state = recordChoice(state, yes).state;
  const third = recordChoice(state, yes);
  assert.equal(third.ask, true);
  state = setRule(third.state, 'risposta', 'never');
  assert.equal(isAuto(state, 'risposta'), false);
  const fourth = recordChoice(state, yes);
  assert.equal(fourth.ask, false, 'dopo un no alla regola non richiede subito');
  state = setRule(fourth.state, 'risposta', 'on');
  assert.ok(isAuto(state, 'risposta'));
  assert.equal(recordChoice(state, yes).ask, false, 'regola già accesa: niente domande');
  const view = rulesView(state);
  assert.match(view.text, /Risposte ai locali/);
  assert.deepEqual(view.buttons, [['Togli: Risposte ai locali', 'hab:off:risposta']]);
});

test('Jarvis impara dai tocchi su Telegram e la regola si accende e si toglie', async () => {
  const db = database();
  const env = { DB: db, TELEGRAM_BOT_TOKEN: TOKEN };
  await missions.putSetting(db, 'telegram_chat_id', '42');
  await telegram(async (sent) => {
    const press = (data) => missions.telegramUpdate(db, env, { callback_query: { id: `q-${data}`, data, message: { chat: { id: 42 }, message_id: 5 } } });
    for (let i = 0; i < ASK_AFTER; i += 1) await press('soll:m1');
    const asked = sent.at(-1);
    assert.match(asked.text, /promemoria/i);
    const on = asked.reply_markup.inline_keyboard.flat().find((b) => /fallo da solo/i.test(b.text));
    assert.equal(on.callback_data, 'hab:on:promemoria');
    await press(on.callback_data);
    assert.equal(await missions.habitOn(db, 'promemoria'), true);
    assert.match(sent.at(-1).text, /Ti avviso ogni volta/);
    await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: 'le mie regole' } });
    const list = sent.at(-1);
    assert.match(list.text, /Promemoria ai locali/);
    const off = list.reply_markup.inline_keyboard.flat()[0];
    await press(off.callback_data);
    assert.equal(await missions.habitOn(db, 'promemoria'), false);
  });
});

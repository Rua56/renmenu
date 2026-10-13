import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { missions } from '../cloudflare/functions/control-room/api/[[route]].js';
import { phoneNumber } from '../cloudflare/functions/_lib/phone.js';

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
// Telegram ed ElevenLabs finti. numbers: numeri importati in ElevenLabs.
async function withServices({ numbers = [{ phone_number_id: 'pn_1', phone_number: '+15550001111', provider: 'twilio', label: 'Jarvis' }] } = {}, fn) {
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    calls.push({ href, method: options.method || 'GET', body: typeof options.body === 'string' ? JSON.parse(options.body) : options.body });
    if (href.endsWith('/v1/convai/phone-numbers')) return Response.json(numbers);
    if (href.endsWith('/v1/convai/agents/create')) return Response.json({ agent_id: 'agent_jarvis' });
    if (href.endsWith('/v1/convai/conversations/conv_1')) return Response.json({ status: 'failed', transcript: [], metadata: { call_duration_secs: 2, termination_reason: 'Missing required dynamic variables' } });
    if (href.endsWith('/v1/convai/twilio/outbound-call')) return Response.json({ success: true, message: 'ok', conversation_id: 'conv_1', callSid: 'CA123' });
    return Response.json({ ok: true, result: { message_id: calls.length } });
  };
  try { return await fn(calls); } finally { globalThis.fetch = previous; }
}
const said = (calls) => calls.filter((c) => c.href.endsWith('/sendMessage')).map((c) => c.body.text);
const send = (db, env, text) => missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text } });
async function linked(db) {
  await missions.putSetting(db, 'telegram_chat_id', '42');
  await missions.putSetting(db, 'voice_provider', 'elevenlabs');
  await missions.putSetting(db, 'voice_api_key', 'el-test');
  await missions.putSetting(db, 'voice_id', 'JBFqnCBsd6RMkjVDRZzb');
  return { DB: db, TELEGRAM_BOT_TOKEN: TOKEN };
}

test('numero di telefono: +39, 0039 o cellulare senza prefisso', () => {
  assert.equal(phoneNumber('+39 333 123 4567'), '+393331234567');
  assert.equal(phoneNumber('0039 333.123.4567'), '+393331234567');
  assert.equal(phoneNumber('3331234567'), '+393331234567');
  assert.equal(phoneNumber('12345'), null);
});

test('/chiamami: chiede il numero, poi crea l’agente una volta e telefona con la situazione', async () => {
  await withServices({}, async (calls) => {
    const db = database(), env = await linked(db);
    await send(db, env, '/chiamami');
    assert.match(said(calls).at(-1), /A quale numero ti chiamo/);
    assert.equal(calls.filter((c) => c.href.includes('elevenlabs')).length, 0, 'senza numero nessuna chiamata a pagamento');
    await send(db, env, '/chiamami +39 333 123 4567');
    assert.match(said(calls).at(-1), /Ti sto chiamando dal \+15550001111/);
    const create = calls.find((c) => c.href.endsWith('/agents/create'));
    assert.equal(create.body.conversation_config.tts.voice_id, 'JBFqnCBsd6RMkjVDRZzb');
    assert.equal(create.body.conversation_config.agent.language, 'it');
    const dial = calls.find((c) => c.href.endsWith('/twilio/outbound-call'));
    assert.equal(dial.body.agent_id, 'agent_jarvis');
    assert.equal(dial.body.agent_phone_number_id, 'pn_1');
    assert.equal(dial.body.to_number, '+393331234567');
    assert.ok(dial.body.conversation_initiation_client_data.dynamic_variables.situazione.length > 0);
    await send(db, env, 'chiamami');
    assert.equal(calls.filter((c) => c.href.endsWith('/agents/create')).length, 1, 'l’agente si crea una volta sola');
    assert.equal(calls.filter((c) => c.href.endsWith('/twilio/outbound-call')).length, 2, 'il numero resta ricordato');
    await send(db, env, '/chiamami esito');
    assert.match(said(calls).at(-1), /stato «failed», 0 battute, 2 secondi, chiusura: Missing required dynamic variables/);
  });
});

test('/chiamami senza numero Twilio importato: spiega cosa manca, nessuna chiamata', async () => {
  await withServices({ numbers: [] }, async (calls) => {
    const db = database(), env = await linked(db);
    await send(db, env, '/chiamami 3331234567');
    assert.match(said(calls).at(-1), /non trovo ancora il numero Twilio/);
    assert.equal(calls.filter((c) => c.href.endsWith('/twilio/outbound-call')).length, 0);
  });
});

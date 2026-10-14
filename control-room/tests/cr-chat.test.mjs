import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { jarvisAsk, jarvisVoice, missions } from '../cloudflare/functions/control-room/api/[[route]].js';
import { spokenText, telegramCapture } from '../cloudflare/functions/_lib/cr-chat.js';

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
// Rete finta: registra le chiamate vere (nessuna deve andare a Telegram).
async function withNetwork(fn) {
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => { calls.push(String(url)); if (String(url).includes('elevenlabs')) return new Response(new Uint8Array(2000), { headers: { 'Content-Type': 'audio/mpeg' } }); return Response.json({ ok: true, result: {} }); };
  try { return await fn(calls); } finally { globalThis.fetch = previous; }
}

test('Parla con Jarvis: risponde nella Control Room senza scrivere su Telegram', async () => {
  const db = database();
  await missions.putSetting(db, 'telegram_chat_id', '42');
  await withNetwork(async (calls) => {
    const out = await jarvisAsk({ DB: db, TELEGRAM_BOT_TOKEN: TOKEN }, { text: '/stato' });
    assert.ok(out.messages.length >= 1);
    assert.equal(out.messages[0].kind, 'text');
    assert.ok(out.messages[0].text.length > 10);
    assert.ok(out.messages[0].say.length > 0);
    assert.equal(calls.filter((u) => u.includes('api.telegram.org')).length, 0);
  });
});

test('Parla con Jarvis: i pulsanti valgono come su Telegram, ma solo quelli offerti', async () => {
  const db = database();
  await missions.putSetting(db, 'telegram_chat_id', '42');
  await withNetwork(async (calls) => {
    const env = { DB: db, TELEGRAM_BOT_TOKEN: TOKEN };
    await assert.rejects(jarvisAsk(env, { press: 'tel:si' }), /non è più valido/);
    const menu = await jarvisAsk(env, { text: '/chiamami avvisi' });
    const offered = menu.messages.flatMap((m) => m.buttons).map(([, data]) => data);
    assert.ok(offered.includes('tel:si'));
    await jarvisAsk(env, { press: 'tel:si' });
    assert.equal(await missions.setting(db, 'phone_alerts'), 'si');
    // Usato una volta, il pulsante non vale più.
    await assert.rejects(jarvisAsk(env, { press: 'tel:si' }), /non è più valido/);
    assert.equal(calls.filter((u) => u.includes('api.telegram.org')).length, 0);
  });
});

test('Parla con Jarvis: senza Telegram collegato lo dice; funziona anche senza token', async () => {
  const db = database();
  await assert.rejects(jarvisAsk({ DB: db }, { text: 'ciao' }), /collega prima Telegram/);
  await missions.putSetting(db, 'telegram_chat_id', '42');
  await withNetwork(async () => {
    const out = await jarvisAsk({ DB: db }, { text: '/stato' });
    assert.ok(out.messages[0].text.length > 10);
  });
});

test('telegramCapture: testo, pulsanti, immagini e file restano qui', async () => {
  const real = [];
  const capture = telegramCapture(async (url) => { real.push(String(url)); return new Response('{}'); });
  const base = `https://api.telegram.org/bot${TOKEN}`;
  await capture.fetchImpl(`${base}/sendMessage`, { method: 'POST', body: JSON.stringify({ text: 'Pubblico?', reply_markup: { inline_keyboard: [[{ text: 'SÌ', callback_data: 'pub:1' }, { text: 'No', callback_data: 'no:1' }]] } }) });
  const form = new FormData(); form.append('photo', new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }), 'qr.png'); form.append('caption', 'QR');
  await capture.fetchImpl(`${base}/sendPhoto`, { method: 'POST', body: form });
  await capture.fetchImpl('https://example.test/altro');
  assert.deepEqual(capture.messages[0], { kind: 'text', text: 'Pubblico?', buttons: [['SÌ', 'pub:1'], ['No', 'no:1']] });
  assert.equal(capture.messages[1].kind, 'image');
  assert.match(capture.messages[1].src, /^data:image\/png;base64,/);
  assert.deepEqual(real, ['https://example.test/altro']);
});

test('spokenText e voce di Jarvis', async () => {
  assert.equal(spokenText('«ciao»\n\nTutto bene.\nVedi https://renmenu.com/x'), 'Tutto bene. Vedi');
  const db = database();
  const none = await jarvisVoice({ DB: db }, { text: 'Ciao Riccardo' });
  assert.equal(none.status, 204);
});

test('Orecchio di Jarvis: la frase registrata diventa testo con Whisper', async () => {
  const { jarvisHear } = await import('../cloudflare/functions/control-room/api/[[route]].js');
  const seen = [];
  const AI = { run: async (model, input) => { seen.push({ model, language: input.language }); return { text: ' quali locali sono registrati? ' }; } };
  assert.deepEqual(await jarvisHear({ AI }, new Uint8Array(5000)), { text: 'quali locali sono registrati?' });
  assert.equal(seen[0].language, 'it');
  await assert.rejects(jarvisHear({ AI }, new Uint8Array(10)), /Non ho sentito/);
  await assert.rejects(jarvisHear({ AI: { run: async () => ({ text: '' }) } }, new Uint8Array(5000)), /non ho sentito parole chiare/);
});

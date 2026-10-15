import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { missions } from '../cloudflare/functions/control-room/api/[[route]].js';
import { normalizePhone, parseClientPhone } from '../cloudflare/functions/_lib/phone-number.js';
import { senderStatus } from '../cloudflare/functions/_lib/whatsapp-in.js';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  for (const f of ['0001_initial', '0002_integrations', '0003_ai_free_scope', '0004_request_category', '0005_draft_provenance', '0010_draft_review_notes', '0011_draft_creative', '0006_publication_approvals', '0007_jarvis_missions', '0008_mail_files'])
    sqlite.exec(readFileSync(new URL(`../cloudflare/migrations/${f}.sql`, import.meta.url), 'utf8'));
  return {
    prepare(sql) { return { bind(...params) { const st = sqlite.prepare(sql); return { first: () => st.get(...params) || null, all: () => ({ results: st.all(...params) }), run: () => ({ meta: { changes: st.run(...params).changes } }) }; } }; },
    async batch(statements) { sqlite.exec('BEGIN TRANSACTION'); try { const r = statements.map((s) => s.run()); sqlite.exec('COMMIT'); return r; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } },
    close: () => sqlite.close()
  };
}
const TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const calls = [];
const fakeFetch = async (url, options = {}) => {
  if (String(url).startsWith('https://api.telegram.org/')) { calls.push({ method: String(url).split('/').pop(), body: JSON.parse(options.body || '{}') }); return Response.json({ ok: true, result: { message_id: 1 } }); }
  return new Response('no', { status: 404 });
};
const say = (db, env, text) => missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text } });
const texts = () => calls.filter((c) => c.method === 'sendMessage').map((c) => c.body.text);

describe('Telefono sulla scheda cliente', () => {
  it('scrive i numeri sempre come +39… e capisce le frasi', () => {
    assert.equal(normalizePhone('333 123 4567'), '+393331234567');
    assert.equal(normalizePhone('+39 333-123-4567'), '+393331234567');
    assert.equal(normalizePhone('0039 333 1234567'), '+393331234567');
    assert.equal(normalizePhone('0481 531234'), '+390481531234');
    assert.equal(normalizePhone('+386 41 123 456'), '+38641123456');
    for (const bad of ['12', 'chiamami', '']) assert.equal(normalizePhone(bad), null, bad);
    assert.deepEqual(parseClientPhone('il numero di Trattoria Blanch è 333 1234567'), { venue: 'Trattoria Blanch', number: '333 1234567' });
    assert.deepEqual(parseClientPhone('il telefono della trattoria blanch è 0481 531234'), { venue: 'trattoria blanch', number: '0481 531234' });
    assert.deepEqual(parseClientPhone('aggiungi il numero 333 1234567 alla trattoria blanch'), { venue: 'trattoria blanch', number: '333 1234567' });
    assert.deepEqual(parseClientPhone('salva a Trattoria Blanch il telefono +39 333 1234567'), { venue: 'Trattoria Blanch', number: '+39 333 1234567' });
    // Il pulsante «Prenota su WhatsApp» del menu Premium resta un'altra cosa.
    assert.equal(parseClientPhone('metti il whatsapp +39 333 1234567 al menu di Al Bakaro'), null);
    assert.equal(parseClientPhone('il numero di coperti è 40'), null);
  });

  it('su Telegram salva il numero e WhatsApp riconosce subito il locale', async () => {
    const db = database();
    const previous = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      calls.length = 0;
      await missions.putSetting(db, 'telegram_chat_id', '42');
      db.prepare("INSERT INTO clients (id,name,plan,payment_status,menu_id,created_at,updated_at) VALUES ('c1','Trattoria Blanch','premium','attivo','trattoria-blanch','2026-10-15','2026-10-15')").bind().run();
      db.prepare("INSERT INTO clients (id,name,plan,phone,created_at,updated_at) VALUES ('c2','Osteria Codelli 23','premium','+393400000000','2026-10-15','2026-10-15')").bind().run();
      const env = { DB: db, TELEGRAM_BOT_TOKEN: TOKEN, OWNER_EMAIL: 'renmenu1569@gmail.com' };
      assert.equal(await senderStatus(db, '393331234567'), 'unknown');
      await say(db, env, 'il numero di Trattoria Blanch è 333 123 4567');
      assert.match(texts().at(-1), /^Fatto: il numero di «Trattoria Blanch» è \+393331234567/);
      assert.equal(db.prepare("SELECT phone FROM clients WHERE id='c1'").bind().first().phone, '+393331234567');
      assert.equal(await senderStatus(db, '393331234567'), 'allowed');
      assert.ok(db.prepare("SELECT 1 FROM audit_events WHERE action='client.phone'").bind().first());
      await say(db, env, 'aggiungi il telefono 340 000 0000 a Trattoria Blanch');
      assert.match(texts().at(-1), /già sulla scheda di «Osteria Codelli 23»/);
      assert.equal(db.prepare("SELECT phone FROM clients WHERE id='c1'").bind().first().phone, '+393331234567');
      await say(db, env, 'il numero di Bar Inventato è 333 1234567');
      assert.match(texts().at(-1), /Non trovo un cliente che si chiami «Bar Inventato»/);
    } finally { globalThis.fetch = previous; db.close(); }
  });
});

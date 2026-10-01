import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { onRequest as gmailHook } from '../cloudflare/functions/hooks/gmail.js';
import { onRequest as whatsappHook } from '../cloudflare/functions/hooks/whatsapp.js';
import { gmailRelaySigningInput } from '../cloudflare/functions/_lib/inbound.js';

const encoder = new TextEncoder();
const gmailSecret = 'gmail-relay-test-secret-at-least-16';
const whatsAppSecret = 'whatsapp-app-test-secret-at-least-16';
const verifyToken = 'whatsapp-verify-token-at-least-16';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0001_initial.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0002_integrations.sql', import.meta.url), 'utf8'));
  return {
    prepare(sql) {
      return { bind(...params) {
        const statement = sqlite.prepare(sql);
        return {
          first: () => statement.get(...params) || null,
          all: () => ({ results: statement.all(...params) }),
          run: () => ({ meta: { changes: statement.run(...params).changes } })
        };
      } };
    },
    async batch(statements) {
      sqlite.exec('BEGIN TRANSACTION');
      try { const results = statements.map((statement) => statement.run()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
    rows(sql, ...params) { return sqlite.prepare(sql).all(...params).map((row) => ({ ...row })); },
    close() { sqlite.close(); }
  };
}

// A local, deterministic test signer: no network provider or real webhook secret is used.
async function fakeHmac(secret, value) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, value instanceof Uint8Array ? value : encoder.encode(value)));
}
const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

const gmailPayload = (overrides = {}) => ({
  mailbox: 'renmenu1569@gmail.com',
  messageId: 'gmail-hook-001',
  from: 'cliente@example.test',
  to: 'renmenu1569@gmail.com',
  subject: 'Aggiornamento menu',
  text: 'Il prezzo della pasta è cambiato.',
  bodyComplete: true,
  attachmentNames: [],
  receivedAt: '2026-10-01T10:00:00Z',
  relevant: true,
  ...overrides
});

const gmailEnv = (DB, extra = {}) => ({ DB, GMAIL_RELAY_ENABLED: 'true', GMAIL_RELAY_SECRET: gmailSecret, ...extra });
const whatsAppEnv = (DB, extra = {}) => ({ DB, WHATSAPP_WEBHOOK_ENABLED: 'true', WHATSAPP_APP_SECRET: whatsAppSecret, WHATSAPP_VERIFY_TOKEN: verifyToken, ...extra });

async function gmailRequest(payload, timestamp = Math.floor(Date.now() / 1000), secret = gmailSecret) {
  const signature = hex(await fakeHmac(secret, gmailRelaySigningInput(payload, timestamp)));
  return new Request('https://hooks.example.test/hooks/gmail', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Gmail-Relay-Timestamp': String(timestamp),
      'X-Gmail-Relay-Signature': `sha256=${signature}`
    },
    body: JSON.stringify(payload)
  });
}

const whatsAppPayload = (message = { id: 'wamid.hook.001', from: '393331234567', timestamp: '1760000000', type: 'text', text: { body: 'Vorrei aggiornare il menu' } }) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'business-001', changes: [{ field: 'messages', value: {
    contacts: [{ wa_id: '393331234567', profile: { name: 'Cliente prova' } }], messages: [message]
  } }]}]
});

async function whatsAppRequest(payload) {
  const raw = JSON.stringify(payload);
  const signature = hex(await fakeHmac(whatsAppSecret, raw));
  return new Request('https://hooks.example.test/hooks/whatsapp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': `sha256=${signature}` }, body: raw
  });
}

describe('Cloudflare Pages Gmail hook', () => {
  it('fails closed while disabled/misconfigured and only accepts POST', async () => {
    const db = database();
    try {
      assert.equal((await gmailHook({ request: new Request('https://hooks.example.test/hooks/gmail', { method: 'POST' }), env: { DB: db } })).status, 404);
      assert.equal((await gmailHook({ request: new Request('https://hooks.example.test/hooks/gmail'), env: gmailEnv(db) })).status, 404);
      assert.equal((await gmailHook({ request: new Request('https://hooks.example.test/hooks/gmail', { method: 'POST' }), env: gmailEnv(db, { GMAIL_RELAY_SECRET: 'short' }) })).status, 403);
    } finally { db.close(); }
  });

  it('verifies canonical JSON before field use, persists a single customer case, and records content-free relay audit data', async () => {
    const db = database();
    try {
      const payload = gmailPayload({ venue: { name: 'Osteria attestata', attested: true } });
      const response = await gmailHook({ request: await gmailRequest(payload), env: gmailEnv(db) });
      assert.deepEqual(await response.json(), { ok: true, accepted: true, deduplicated: false });
      assert.deepEqual(db.rows('SELECT source,source_event_id,status,reason FROM external_events'), [{ source: 'gmail', source_event_id: 'gmail-hook-001', status: 'imported', reason: null }]);
      assert.deepEqual(db.rows('SELECT name,email,plan,payment_status FROM clients'), [{ name: 'Osteria attestata', email: 'cliente@example.test', plan: 'da_definire', payment_status: null }]);
      assert.deepEqual(db.rows('SELECT source_channel,status,plan,contact_info FROM requests'), [{ source_channel: 'email', status: 'nuova', plan: 'da_definire', contact_info: 'cliente@example.test' }]);
      const [audit] = db.rows('SELECT action,summary,actor FROM audit_events');
      assert.deepEqual(audit, { action: 'webhook.gmail.import', summary: 'Evento webhook registrato per revisione.', actor: 'relay' });
      assert.equal(JSON.stringify(audit).includes(payload.text), false);

      const duplicate = await gmailHook({ request: await gmailRequest(payload), env: gmailEnv(db) });
      assert.deepEqual(await duplicate.json(), { ok: true, accepted: true, deduplicated: true });
      assert.equal(db.rows('SELECT * FROM clients').length, 1);
      assert.equal(db.rows('SELECT * FROM requests').length, 1);
      assert.equal(db.rows('SELECT * FROM audit_events').length, 1);

      const altered = { ...payload, messageId: 'gmail-hook-002', mailbox: 'other@example.test' };
      const signedOriginal = await gmailRequest(payload);
      const rejected = new Request(signedOriginal.url, { method: 'POST', headers: signedOriginal.headers, body: JSON.stringify(altered) });
      assert.equal((await gmailHook({ request: rejected, env: gmailEnv(db) })).status, 403);
      assert.equal(db.rows('SELECT * FROM external_events').length, 1);
    } finally { db.close(); }
  });

  it('retains only durable metadata for signed irrelevant mail and routes incomplete/attachment mail to review without R2', async () => {
    const db = database();
    try {
      const ignored = await gmailHook({ request: await gmailRequest(gmailPayload({ messageId: 'gmail-ignored', relevant: false })), env: gmailEnv(db) });
      assert.deepEqual(await ignored.json(), { ok: true, ignored: true, deduplicated: false });
      assert.deepEqual(db.rows('SELECT source_event_id,status,reason,request_id FROM external_events'), [{ source_event_id: 'gmail-ignored', status: 'ignored', reason: 'not_relevant', request_id: null }]);
      assert.equal(db.rows('SELECT * FROM clients').length, 0);
      assert.equal(db.rows('SELECT * FROM requests').length, 0);

      const review = await gmailHook({ request: await gmailRequest(gmailPayload({ messageId: 'gmail-review', bodyComplete: false, attachmentNames: ['menu.pdf'] })), env: gmailEnv(db) });
      assert.equal(review.status, 200);
      assert.deepEqual(db.rows('SELECT source_event_id,status,reason FROM external_events ORDER BY source_event_id'), [
        { source_event_id: 'gmail-ignored', status: 'ignored', reason: 'not_relevant' },
        { source_event_id: 'gmail-review', status: 'needs_review', reason: 'body_incomplete_or_attachments' }
      ]);
      assert.deepEqual(db.rows('SELECT status FROM requests'), [{ status: 'dati_da_confermare' }]);
      assert.equal(db.rows('SELECT * FROM materials').length, 0);
    } finally { db.close(); }
  });
});

describe('Cloudflare Pages WhatsApp hook', () => {
  it('returns the challenge only with complete configuration and matching token', async () => {
    const db = database();
    try {
      const query = new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': verifyToken, 'hub.challenge': 'meta-challenge' });
      const valid = await whatsappHook({ request: new Request(`https://hooks.example.test/hooks/whatsapp?${query}`), env: whatsAppEnv(db) });
      assert.equal(valid.status, 200);
      assert.equal(await valid.text(), 'meta-challenge');
      assert.equal((await whatsappHook({ request: new Request('https://hooks.example.test/hooks/whatsapp?hub.mode=subscribe'), env: whatsAppEnv(db, { WHATSAPP_VERIFY_TOKEN: 'short' }) })).status, 404);
      assert.equal((await whatsappHook({ request: new Request('https://hooks.example.test/hooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x'), env: whatsAppEnv(db) })).status, 403);
    } finally { db.close(); }
  });

  it('uses the exact raw Meta body, persistently deduplicates customer messages, and sends non-text messages to review without downloading them', async () => {
    const db = database();
    try {
      const payload = whatsAppPayload();
      const response = await whatsappHook({ request: await whatsAppRequest(payload), env: whatsAppEnv(db) });
      assert.deepEqual(await response.json(), { ok: true, accepted: 1, deduplicated: 0 });
      assert.deepEqual(db.rows('SELECT source,source_event_id,status FROM external_events'), [{ source: 'whatsapp', source_event_id: 'wamid.hook.001', status: 'imported' }]);
      assert.deepEqual(db.rows('SELECT phone,plan,payment_status FROM clients'), [{ phone: '+393331234567', plan: 'da_definire', payment_status: null }]);
      assert.deepEqual(db.rows('SELECT source_channel,status FROM requests'), [{ source_channel: 'whatsapp', status: 'nuova' }]);

      const repeated = await whatsappHook({ request: await whatsAppRequest(payload), env: whatsAppEnv(db) });
      assert.deepEqual(await repeated.json(), { ok: true, accepted: 0, deduplicated: 1 });
      assert.equal(db.rows('SELECT * FROM requests').length, 1);

      const alteredRaw = new Request('https://hooks.example.test/hooks/whatsapp', { method: 'POST', headers: { 'X-Hub-Signature-256': 'sha256=0000000000000000000000000000000000000000000000000000000000000000' }, body: JSON.stringify(payload) });
      assert.equal((await whatsappHook({ request: alteredRaw, env: whatsAppEnv(db) })).status, 403);

      const image = { id: 'wamid.hook.image', from: '393331234567', timestamp: '1760000001', type: 'image', image: { id: 'meta-media-id' } };
      assert.equal((await whatsappHook({ request: await whatsAppRequest(whatsAppPayload(image)), env: whatsAppEnv(db) })).status, 200);
      assert.deepEqual(db.rows("SELECT source_event_id,status,reason FROM external_events WHERE source_event_id='wamid.hook.image'"), [{ source_event_id: 'wamid.hook.image', status: 'needs_review', reason: 'unsupported_message_type' }]);
      assert.equal(db.rows('SELECT * FROM materials').length, 0);
    } finally { db.close(); }
  });
});

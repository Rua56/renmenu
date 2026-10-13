import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { onRequest as gmailHook } from '../cloudflare/functions/hooks/gmail.js';
import { onRequest as whatsappHook } from '../cloudflare/functions/hooks/whatsapp.js';
import { gmailRelaySigningInput } from '../cloudflare/functions/_lib/inbound.js';
import { approveSender, blockSender, takeUnannouncedHeld } from '../cloudflare/functions/_lib/whatsapp-in.js';

const encoder = new TextEncoder();
const gmailSecret = 'gmail-relay-test-secret-at-least-16';
const whatsAppSecret = 'whatsapp-app-test-secret-at-least-16';
const verifyToken = 'whatsapp-verify-token-at-least-16';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0001_initial.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0002_integrations.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0003_ai_free_scope.sql', import.meta.url), 'utf8'));
  sqlite.exec('CREATE TABLE IF NOT EXISTS jarvis_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
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

const whatsAppPayload = (message = { id: 'wamid.hook.001', from: '393331234567', timestamp: '1760000000', type: 'text', text: { body: 'Vorrei aggiornare il menu' } }, entryId = 'business-001', name = 'Cliente prova') => ({
  object: 'whatsapp_business_account',
  entry: [{ id: entryId, changes: [{ field: 'messages', value: {
    contacts: [{ wa_id: message.from, profile: { name } }], messages: [message]
  } }]}]
});
const textFrom = (id, from, body) => ({ id, from, timestamp: '1760000000', type: 'text', text: { body } });

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

  it('uses the exact raw Meta body, persistently deduplicates customer messages, and groups a photo that cannot be downloaded into the same case for review', async () => {
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
      // Senza token né bucket la foto non si scarica: stessa pratica del testo, da rivedere.
      assert.deepEqual(db.rows("SELECT source_event_id,status,reason FROM external_events WHERE source_event_id='wamid.hook.image'"), [{ source_event_id: 'wamid.hook.image', status: 'imported', reason: 'grouped' }]);
      assert.equal(db.rows('SELECT * FROM requests').length, 1);
      assert.match(db.rows('SELECT next_step FROM requests')[0].next_step, /non è stato scaricato/);
      assert.equal(db.rows('SELECT status FROM requests')[0].status, 'dati_da_confermare');
      assert.equal(db.rows('SELECT * FROM materials').length, 0);
    } finally { db.close(); }
  });

  it('downloads photos and PDFs from Meta into the private bucket and keeps one case per number', async () => {
    const db = database();
    const stored = [];
    const calls = [];
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const previous = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
      calls.push({ url: String(url), auth: options.headers?.Authorization });
      if (String(url) === 'https://graph.facebook.com/v21.0/media-photo') return Response.json({ url: 'https://lookaside.fbsbx.whatsapp.net/media?id=1', mime_type: 'image/jpeg', file_size: jpeg.length });
      if (String(url) === 'https://graph.facebook.com/v21.0/media-evil') return Response.json({ url: 'https://evil.example.com/x', mime_type: 'image/jpeg' });
      if (String(url).startsWith('https://lookaside.fbsbx.whatsapp.net/')) return new Response(jpeg);
      return new Response('no', { status: 404 });
    };
    try {
      const env = whatsAppEnv(db, { WHATSAPP_TOKEN: 'meta-token', BUCKET: { put: async (key, bytes, opts) => { stored.push({ key, size: bytes.length, type: opts.httpMetadata.contentType }); } } });
      const photo = { id: 'wamid.photo.1', from: '393331234567', timestamp: '1760000001', type: 'image', image: { id: 'media-photo', mime_type: 'image/jpeg', caption: 'Menu del pranzo' } };
      assert.equal((await whatsappHook({ request: await whatsAppRequest(whatsAppPayload(photo)), env })).status, 200);
      const text = { id: 'wamid.text.2', from: '393331234567', timestamp: '1760000002', type: 'text', text: { body: 'Il coperto è 2 euro' } };
      await whatsappHook({ request: await whatsAppRequest(whatsAppPayload(text)), env });
      const evil = { id: 'wamid.photo.3', from: '393331234567', timestamp: '1760000003', type: 'image', image: { id: 'media-evil' } };
      await whatsappHook({ request: await whatsAppRequest(whatsAppPayload(evil)), env });
      const [request] = db.rows('SELECT id,subject,status,source_text,next_step FROM requests');
      assert.equal(db.rows('SELECT * FROM requests').length, 1, 'una pratica per numero');
      assert.equal(request.subject, 'Richiesta WhatsApp');
      assert.match(request.source_text, /^WhatsApp da Cliente prova \(\+393331234567\)\n\nMenu del pranzo\n\nIl coperto è 2 euro\n\n\[foto allegata\]$/);
      assert.match(request.next_step, /UNEXPECTED_MEDIA_HOST/);
      assert.deepEqual(db.rows('SELECT source,processing_status,mime,size FROM materials'), [{ source: 'whatsapp', processing_status: 'da_trascrivere', mime: 'image/jpeg', size: jpeg.length }]);
      assert.deepEqual(stored.map((s) => s.type), ['image/jpeg']);
      assert.ok(stored[0].key.startsWith(`private/requests/${request.id}/`));
      assert.ok(calls.every((c) => c.auth === 'Bearer meta-token'));
      assert.ok(!calls.some((c) => c.url.includes('evil.example.com')), 'mai scaricare da indirizzi non di Meta');
      // Un messaggio di sistema (reazione) non crea pratiche.
      const reaction = { id: 'wamid.react.4', from: '393331234567', timestamp: '1760000004', type: 'reaction', reaction: { emoji: '👍' } };
      await whatsappHook({ request: await whatsAppRequest(whatsAppPayload(reaction)), env });
      assert.deepEqual(db.rows("SELECT status FROM external_events WHERE source_event_id='wamid.react.4'"), [{ status: 'ignored' }]);
    } finally { globalThis.fetch = previous; db.close(); }
  });

  it('with the private filter, unknown numbers wait for Riccardo: «locale» opens one case, «privato» is ignored forever', async () => {
    const db = database();
    try {
      const env = whatsAppEnv(db, { WHATSAPP_PRIVATE_FILTER: 'true' });
      await whatsappHook({ request: await whatsAppRequest(whatsAppPayload(textFrom('wamid.p.1', '393330000001', 'Ciao, ci vediamo stasera?'), 'business-001', 'Amico')), env });
      await whatsappHook({ request: await whatsAppRequest(whatsAppPayload(textFrom('wamid.l.1', '393330000002', 'Buongiorno, vi mando il menu'), 'business-001', 'Osteria Nuova')), env });
      await whatsappHook({ request: await whatsAppRequest(whatsAppPayload(textFrom('wamid.l.2', '393330000002', 'Il coperto è 2 euro'), 'business-001', 'Osteria Nuova')), env });
      const repeated = await whatsappHook({ request: await whatsAppRequest(whatsAppPayload(textFrom('wamid.l.2', '393330000002', 'Il coperto è 2 euro'), 'business-001', 'Osteria Nuova')), env });
      assert.deepEqual(await repeated.json(), { ok: true, accepted: 0, deduplicated: 1 });
      assert.equal(db.rows('SELECT * FROM requests').length, 0, 'nessuna pratica prima della scelta');
      assert.equal(db.rows('SELECT * FROM external_events').length, 0, 'niente registrato dei messaggi in attesa');

      const held = await takeUnannouncedHeld(db);
      assert.deepEqual(held.map((h) => [h.waId, h.name, h.count]), [['393330000001', 'Amico', 1], ['393330000002', 'Osteria Nuova', 2]]);
      assert.match(held[1].preview, /vi mando il menu · Il coperto/);
      assert.deepEqual(await takeUnannouncedHeld(db), [], 'annunciato una volta sola');

      const approved = await approveSender(db, env, '393330000002');
      assert.equal(approved.imported, 2);
      const [request] = db.rows('SELECT id,source_text FROM requests');
      assert.equal(request.id, approved.requestId);
      assert.match(request.source_text, /^WhatsApp da Osteria Nuova \(\+393330000002\)\n\nBuongiorno, vi mando il menu\n\nIl coperto è 2 euro$/);
      await whatsappHook({ request: await whatsAppRequest(whatsAppPayload(textFrom('wamid.l.3', '393330000002', 'Grazie'), 'business-001', 'Osteria Nuova')), env });
      assert.match(db.rows('SELECT source_text FROM requests')[0].source_text, /Grazie$/, 'i messaggi successivi del locale passano subito');

      assert.equal((await blockSender(db, '393330000001')).name, 'Amico');
      await whatsappHook({ request: await whatsAppRequest(whatsAppPayload(textFrom('wamid.p.2', '393330000001', 'Rispondi!'), 'business-001', 'Amico')), env });
      assert.deepEqual(db.rows("SELECT status,reason FROM external_events WHERE source_event_id='wamid.p.2'"), [{ status: 'ignored', reason: 'private_contact' }]);
      assert.equal(db.rows('SELECT * FROM requests').length, 1);
      assert.equal(JSON.stringify(db.rows('SELECT * FROM jarvis_settings')).includes('ci vediamo stasera'), false, 'i messaggi privati in attesa vengono cancellati');
      assert.deepEqual(await takeUnannouncedHeld(db), []);
    } finally { db.close(); }
  });

  it('via Dualhook accepts only the secret address and our WhatsApp account, and downloads files from Dualhook', async () => {
    const db = database();
    const calls = [];
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]);
    const fetchImpl = async (url, options = {}) => {
      calls.push({ url: String(url), auth: options.headers?.Authorization });
      if (String(url) === 'https://api.dualhook.com/v25.0/dh-media') return Response.json({ url: 'https://evil.example.com/x', mime_type: 'image/png', file_size: png.length });
      if (String(url) === 'https://api.dualhook.com/v25.0/dh-media/content') return new Response(png);
      return new Response('no', { status: 404 });
    };
    const previous = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const hookKey = 'dualhook-path-key-at-least-16';
      const env = { DB: db, WHATSAPP_WEBHOOK_ENABLED: 'true', WHATSAPP_INBOUND_VIA: 'dualhook', WHATSAPP_HOOK_KEY: hookKey, WHATSAPP_WABA_ID: '1234567890', WHATSAPP_VERIFY_TOKEN: verifyToken, WHATSAPP_TOKEN: 'dh-live-key',
        BUCKET: { put: async () => {} } };
      const post = (payload, key = hookKey) => new Request(`https://hooks.example.test/hooks/whatsapp?k=${key}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=firmata-da-dualhook' }, body: JSON.stringify(payload) });
      const photo = { id: 'wamid.dh.1', from: '393331234567', timestamp: '1760000001', type: 'image', image: { id: 'dh-media', mime_type: 'image/png' } };
      assert.equal((await whatsappHook({ request: post(whatsAppPayload(photo, '1234567890'), 'chiave-sbagliata-ma-lunga'), env })).status, 403);
      assert.equal((await whatsappHook({ request: post(whatsAppPayload(photo, '999')), env })).status, 403, 'conto WhatsApp diverso');
      assert.equal((await whatsappHook({ request: post(whatsAppPayload(photo, '1234567890')), env })).status, 200);
      assert.deepEqual(db.rows('SELECT source,mime,size FROM materials'), [{ source: 'whatsapp', mime: 'image/png', size: png.length }]);
      assert.ok(calls.every((c) => c.auth === 'Bearer dh-live-key' && c.url.startsWith('https://api.dualhook.com/')), 'mai seguire l\'indirizzo restituito');
      // La verifica dell'indirizzo funziona anche prima di conoscere il conto WhatsApp.
      const query = new URLSearchParams({ k: hookKey, 'hub.mode': 'subscribe', 'hub.verify_token': verifyToken, 'hub.challenge': 'dh-challenge' });
      const challenge = await whatsappHook({ request: new Request(`https://hooks.example.test/hooks/whatsapp?${query}`), env: { ...env, WHATSAPP_WABA_ID: '' } });
      assert.equal(await challenge.text(), 'dh-challenge');
      assert.equal((await whatsappHook({ request: post(whatsAppPayload(photo, '1234567890')), env: { ...env, WHATSAPP_WABA_ID: '' } })).status, 403, 'ma i messaggi no');
      // Senza la chiave dell'indirizzo la configurazione non è completa.
      assert.equal((await whatsappHook({ request: post(whatsAppPayload(photo, '1234567890')), env: { ...env, WHATSAPP_HOOK_KEY: '' } })).status, 403);
    } finally { globalThis.fetch = previous; db.close(); }
  });
});

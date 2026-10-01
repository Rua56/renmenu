import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  OWNER_NOTIFICATION_RECIPIENT,
  ownerNotificationConfigStatus,
  reserveOwnerNotification,
  sendOwnerNotification
} from '../cloudflare/functions/_lib/owner-notifications.js';

const migration = (name) => readFileSync(new URL(`../cloudflare/migrations/${name}`, import.meta.url), 'utf8');

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(migration('0001_initial.sql'));
  sqlite.exec(migration('0002_integrations.sql'));
  sqlite.exec(migration('0003_ai_free_scope.sql'));
  sqlite.exec(`INSERT INTO clients (id, name, plan, internal_notes, revision, created_at, updated_at)
    VALUES ('client-1', 'Cliente di test', 'da_definire', '', 1, '2026-01-15T09:00:00.000Z', '2026-01-15T09:00:00.000Z');
    INSERT INTO requests (id, client_id, subject, source_channel, source_text, kind, status, plan, internal_notes, revision, created_at, updated_at)
    VALUES ('request-1', 'client-1', 'Pratica di test', 'manuale', '', 'nuovo', 'nuova', 'da_definire', '', 1, '2026-01-15T09:00:00.000Z', '2026-01-15T09:00:00.000Z');
    INSERT INTO requests (id, client_id, subject, source_channel, source_text, kind, status, plan, internal_notes, revision, created_at, updated_at)
    VALUES ('request-2', 'client-1', 'Seconda pratica', 'manuale', '', 'nuovo', 'nuova', 'da_definire', '', 1, '2026-01-15T09:00:00.000Z', '2026-01-15T09:00:00.000Z');`);
  return {
    prepare(sql) {
      return { bind(...params) {
        const statement = sqlite.prepare(sql);
        return {
          first: async () => statement.get(...params) ?? null,
          all: async () => ({ results: statement.all(...params) }),
          run: async () => ({ meta: { changes: statement.run(...params).changes } })
        };
      } };
    },
    async batch(statements) {
      sqlite.exec('BEGIN TRANSACTION');
      try {
        const results = [];
        for (const item of statements) results.push(await item.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    rows(sql, ...params) { return sqlite.prepare(sql).all(...params); },
    close() { sqlite.close(); }
  };
}

const protectedEnv = {
  EMAIL_LIVE_ENABLED: 'true',
  RESEND_API_KEY: 'test-resend-key-not-a-real-secret',
  EMAIL_FROM: 'RenMenu Operations <ops@renmenu.test>',
  EMAIL_FROM_VERIFIED: 'true',
  OWNER_EMAIL: OWNER_NOTIFICATION_RECIPIENT,
  STAGING_PROTECTED: 'true',
  ENVIRONMENT: 'protected-staging'
};
const daytime = '2026-01-15T10:30:00+01:00';
const notification = {
  requestId: 'request-1',
  subject: 'Review richiesta',
  text: 'La pratica richiede una revisione manuale.'
};

function fakeSuccessfulFetch(calls) {
  return async (url, options) => {
    calls.push({ url: String(url), options });
    return Response.json({ id: 'resend-test-001' }, { status: 200 });
  };
}

describe('owner notifications', () => {
  it('sends only to the fixed owner through an injected fake, and stores no notification body in D1 audit data', async () => {
    const db = database();
    const calls = [];
    try {
      const result = await sendOwnerNotification({
        db, env: protectedEnv, ...notification,
        // This unsupported caller field must not alter the recipient.
        recipient: 'customer@example.test', now: daytime, fetchImpl: fakeSuccessfulFetch(calls)
      });
      assert.equal(result.ok, true);
      assert.equal(result.sent, true);
      assert.equal(result.status, 'sent');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://api.resend.com/emails');
      const payload = JSON.parse(calls[0].options.body);
      assert.deepEqual(payload.to, [OWNER_NOTIFICATION_RECIPIENT]);
      assert.equal(payload.from, protectedEnv.EMAIL_FROM);
      assert.equal(payload.text, notification.text);
      assert.equal(calls[0].options.headers['Idempotency-Key'], result.deliveryId);

      const [delivery] = db.rows('SELECT recipient, message_text, status, provider_id, content_hash FROM outbound_deliveries');
      assert.deepEqual({ ...delivery }, {
        recipient: OWNER_NOTIFICATION_RECIPIENT,
        message_text: '[owner notification body redacted]',
        status: 'sent',
        provider_id: 'resend-test-001',
        content_hash: result.contentHash
      });
      assert.match(delivery.content_hash, /^[a-f0-9]{64}$/);
      const audit = db.rows('SELECT action, summary FROM audit_events ORDER BY created_at, id');
      assert.deepEqual(audit.map((row) => `${row.action}:${row.summary}`).sort(), [
        'owner_email_reserved:Owner email reserved',
        'owner_email_sent:Owner email accepted by provider'
      ]);
      const persisted = JSON.stringify({ delivery, audit });
      assert.doesNotMatch(persisted, /revisione manuale|test-resend-key/);
    } finally { db.close(); }
  });

  it('fails closed unless all exact live, owner, verified-sender, and protected-staging gates hold', async () => {
    const db = database();
    try {
      const cases = [
        [{ EMAIL_LIVE_ENABLED: 'false' }, 'EMAIL_LIVE_DISABLED'],
        [{ RESEND_API_KEY: undefined }, 'MISSING_RESEND_API_KEY'],
        [{ EMAIL_FROM_VERIFIED: 'false' }, 'EMAIL_FROM_NOT_VERIFIED'],
        [{ OWNER_EMAIL: 'owner@example.test' }, 'OWNER_EMAIL_MISMATCH'],
        [{ STAGING_PROTECTED: 'false' }, 'STAGING_NOT_PROTECTED'],
        [{ ENVIRONMENT: 'production' }, 'STAGING_NOT_PROTECTED']
      ];
      for (const [override, reason] of cases) {
        const result = await reserveOwnerNotification({ db, env: { ...protectedEnv, ...override }, ...notification, now: daytime });
        assert.equal(result.reason, reason);
      }
      assert.equal(db.rows('SELECT * FROM outbound_deliveries').length, 0);
      assert.equal(db.rows('SELECT * FROM audit_events').length, 0);
    } finally { db.close(); }
  });

  it('rejects Resend onboarding sender until the relevant business account has explicitly authorized it', async () => {
    const onboardingEnv = { ...protectedEnv, EMAIL_FROM: 'onboarding@resend.dev' };
    assert.equal(ownerNotificationConfigStatus(onboardingEnv).reason, 'ONBOARDING_SENDER_NOT_AUTHORIZED');
    const allowed = ownerNotificationConfigStatus({ ...onboardingEnv, RESEND_ONBOARDING_SENDER_AUTHORIZED: 'true' });
    assert.equal(allowed.ok, true);
  });

  it('observes Rome quiet hours unless priority is exactly urgente, without creating suppressed rows', async () => {
    const db = database();
    try {
      const quiet = await reserveOwnerNotification({ db, env: protectedEnv, ...notification, now: '2026-01-15T21:30:00+01:00' });
      assert.equal(quiet.reason, 'QUIET_HOURS');
      assert.equal(db.rows('SELECT * FROM outbound_deliveries').length, 0);
      const urgent = await reserveOwnerNotification({
        db, env: protectedEnv, ...notification, priority: 'urgente', now: '2026-01-15T21:30:00+01:00'
      });
      assert.equal(urgent.ok, true);
      assert.equal(urgent.delivery.status, 'reserved');
    } finally { db.close(); }
  });

  it('uses the D1 unique key as idempotency: reserved, sent, and unknown rows are never resent', async () => {
    const db = database();
    const calls = [];
    try {
      const reserved = await reserveOwnerNotification({ db, env: protectedEnv, ...notification, now: daytime });
      assert.equal(reserved.created, true);
      const reservedAgain = await sendOwnerNotification({ db, env: protectedEnv, ...notification, now: daytime, fetchImpl: fakeSuccessfulFetch(calls) });
      assert.deepEqual({ status: reservedAgain.status, duplicate: reservedAgain.duplicate, calls: calls.length }, {
        status: 'reserved', duplicate: true, calls: 0
      });

      const sent = await sendOwnerNotification({
        db, env: protectedEnv, ...notification, requestId: 'request-2', text: 'Un contenuto diverso per la seconda pratica.', now: daytime,
        fetchImpl: fakeSuccessfulFetch(calls)
      });
      assert.equal(sent.status, 'sent');
      assert.equal(calls.length, 1);
      const sentAgain = await sendOwnerNotification({
        db, env: protectedEnv, ...notification, requestId: 'request-2', text: 'Un contenuto diverso per la seconda pratica.', now: daytime,
        fetchImpl: fakeSuccessfulFetch(calls)
      });
      assert.equal(sentAgain.status, 'sent');
      assert.equal(sentAgain.duplicate, true);
      assert.equal(calls.length, 1);

      const unavailable = await sendOwnerNotification({
        db, env: protectedEnv, ...notification, requestId: 'request-2', text: 'Provider non raggiungibile.', now: daytime,
        fetchImpl: async () => { calls.push('unavailable'); throw new Error('offline'); }
      });
      assert.deepEqual({ status: unavailable.status, sent: unavailable.sent, reason: unavailable.reason }, {
        status: 'unknown', sent: false, reason: 'PROVIDER_UNAVAILABLE'
      });
      const unknownAgain = await sendOwnerNotification({
        db, env: protectedEnv, ...notification, requestId: 'request-2', text: 'Provider non raggiungibile.', now: daytime,
        fetchImpl: async () => { throw new Error('must not retry'); }
      });
      assert.equal(unknownAgain.status, 'unknown');
      assert.equal(unknownAgain.duplicate, true);
      assert.equal(calls.filter((item) => item === 'unavailable').length, 1);
    } finally { db.close(); }
  });

  it('marks a provider rejection as failed, while requiring an injected fetch before reserving', async () => {
    const db = database();
    try {
      const noFetch = await sendOwnerNotification({ db, env: protectedEnv, ...notification, now: daytime });
      assert.equal(noFetch.reason, 'MISSING_FETCH_IMPLEMENTATION');
      assert.equal(db.rows('SELECT * FROM outbound_deliveries').length, 0);
      const rejected = await sendOwnerNotification({
        db, env: protectedEnv, ...notification, now: daytime,
        fetchImpl: async () => Response.json({ message: 'rejected' }, { status: 422 })
      });
      assert.deepEqual({ status: rejected.status, sent: rejected.sent, reason: rejected.reason }, {
        status: 'failed', sent: false, reason: 'PROVIDER_REJECTED'
      });
      const audit = db.rows('SELECT action FROM audit_events ORDER BY created_at, id');
      assert.deepEqual(audit.map(({ action }) => action).sort(), ['owner_email_failed', 'owner_email_reserved']);
    } finally { db.close(); }
  });
});

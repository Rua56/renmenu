import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const root = new URL('../', import.meta.url);
const guide = readFileSync(new URL('docs/gmail-trigger-relay.md', root), 'utf8');
const code = guide.split('```js\n')[1]?.split('\n```')[0];
assert.ok(code, 'Gmail relay tool code must remain in the runbook');
const placeholder = /const e = \{ messageId: 'ID_GMAIL_STABILE',[\s\S]*?venueName: null, ambiguous: false \};/;
assert.match(code, placeholder);
const migrations = ['0001_initial.sql', '0002_integrations.sql', '0003_ai_free_scope.sql'];

function harness() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of migrations) sqlite.exec(readFileSync(new URL(`cloudflare/migrations/${name}`, root), 'utf8'));
  const cloudflare = {
    async request({ method, path, body }) {
      assert.equal(method, 'POST');
      assert.match(path, /\/accounts\/staging-account\/d1\/database\/be94eb32-dad9-48c5-92b3-c3bf58565c8d\/query$/);
      if (body.batch) {
        sqlite.exec('BEGIN');
        try {
          const result = body.batch.map(({ sql, params }) => {
            assert.ok(params.every((x) => typeof x === 'string'), 'D1 REST params are strings');
            sqlite.prepare(sql).run(...params);
            return { success: true, meta: { changes: sqlite.prepare('SELECT changes() AS n').get().n } };
          });
          sqlite.exec('COMMIT');
          return { success: true, status: 200, result };
        } catch (error) {
          sqlite.exec('ROLLBACK');
          throw error;
        }
      }
      return { success: true, status: 200, result: [{ results: sqlite.prepare(body.sql).all(...body.params) }] };
    }
  };
  return { sqlite, cloudflare, close: () => sqlite.close() };
}

function sample(messageId, overrides = {}) {
  return {
    messageId, from: 'synthetic-customer@example.invalid', to: 'renmenu1569@gmail.com',
    subject: 'Richiesta menu di prova', text: 'Test fittizio: pizza margherita 9 euro.',
    receivedAt: '2026-10-01T20:00:00.000Z', relevant: true,
    bodyComplete: true, hasAttachments: false, attachmentNames: [], venueName: null, ambiguous: false,
    ...overrides
  };
}

async function relay(cloudflare, data) {
  const script = code.replace(placeholder, `const e = ${JSON.stringify(data)};`);
  return new Function('cloudflare', 'accountId', 'crypto', `return (${script})()`)(cloudflare, 'staging-account', webcrypto);
}

describe('Gmail Trigger D1 relay runbook', () => {
  it('persists one request and audit row across exact retries', async () => {
    const h = harness();
    try {
      const e = sample('synthetic001');
      const one = await relay(h.cloudflare, e);
      const two = await relay(h.cloudflare, e);
      assert.equal(one.ok, true);
      assert.equal(two.ok, true);
      assert.equal(one.requestId, two.requestId);
      assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM external_events').get().n, 1);
      assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM clients').get().n, 1);
      assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM requests').get().n, 1);
      assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM audit_events').get().n, 1);
    } finally { h.close(); }
  });

  it('does not persist content for irrelevant messages', async () => {
    const h = harness();
    try {
      const result = await relay(h.cloudflare, sample('synthetic002', { relevant: false, text: 'PRIVATE_TEXT_TEST' }));
      assert.equal(result.ok, true);
      assert.equal(result.status, 'ignored');
      assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM requests').get().n, 0);
      assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM audit_events').get().n, 0);
      assert.equal(JSON.stringify(h.sqlite.prepare('SELECT * FROM external_events').all()).includes('PRIVATE_TEXT_TEST'), false);
    } finally { h.close(); }
  });

  it('flags attachments and incomplete or overlong bodies for manual review', async () => {
    const h = harness();
    try {
      const a = await relay(h.cloudflare, sample('synthetic003', { attachmentNames: ['menu.pdf'], hasAttachments: true }));
      const b = await relay(h.cloudflare, sample('synthetic004', { bodyComplete: false }));
      const c = await relay(h.cloudflare, sample('synthetic005', { text: '€'.repeat(5000) }));
      const d = await relay(h.cloudflare, sample('synthetic007', { ambiguous: true }));
      assert.deepEqual([a.status, b.status, c.status, d.status], ['needs_review', 'needs_review', 'needs_review', 'needs_review']);
      const requests = h.sqlite.prepare('SELECT status,internal_notes,source_text FROM requests ORDER BY id').all();
      assert.equal(requests.length, 4);
      assert.ok(requests.every((r) => r.status === 'dati_da_confermare'));
      assert.match(requests[0].internal_notes, /NON importati/);
      assert.ok(new TextEncoder().encode(requests[2].source_text).length <= 8192);
    } finally { h.close(); }
  });

  it('rejects a message addressed elsewhere before any D1 write', async () => {
    const h = harness();
    try {
      const result = await relay(h.cloudflare, sample('synthetic006', { to: 'personal@example.invalid' }));
      assert.equal(result.ok, false);
      assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM external_events').get().n, 0);
    } finally { h.close(); }
  });
});

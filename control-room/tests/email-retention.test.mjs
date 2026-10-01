import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  purgePublishedEmail,
  PURGE_PUBLISHED_EMAIL_CONFIRMATION
} from '../cloudflare/functions/_lib/email-retention.js';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0001_initial.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0002_integrations.sql', import.meta.url), 'utf8'));
  return {
    sqlite,
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
    close: () => sqlite.close()
  };
}

const now = () => '2026-10-01T12:00:00.000Z';
let ids = 0;
const uid = () => `retention-audit-${++ids}`;
const menu = (price = '12,00') => ({
  id: 'osteria-di-prova', nome: { it: 'Osteria di prova' }, lingue: ['it'],
  sezioni: [{ nome: { it: 'Primi' }, voci: [{ nome: { it: 'Gnocchi' }, prezzo: price, allergeni: ['1'] }] }]
});
const reorderedMenu = () => {
  const value = menu();
  return {
    sezioni: value.sezioni.map((section) => ({
      voci: section.voci.map((item) => ({ allergeni: item.allergeni, prezzo: item.prezzo, nome: item.nome })),
      nome: section.nome
    })),
    lingue: value.lingue, nome: value.nome, id: value.id
  };
};

async function hash(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function seed(db, { revision = 7, sourceText = 'Corpo Gmail riservato: non deve restare in D1.' } = {}) {
  const menuJson = JSON.stringify(menu());
  db.sqlite.prepare('INSERT INTO clients (id,name,plan,revision,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run('client-1', 'Osteria di prova', 'standard', 1, now(), now());
  db.sqlite.prepare(`INSERT INTO requests (id,client_id,subject,source_channel,source_text,kind,status,plan,revision,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run('request-gmail-1', 'client-1', 'Aggiornamento menu', 'email', sourceText,
    'aggiornamento', 'approvata', 'standard', revision, now(), now());
  db.sqlite.prepare(`INSERT INTO external_events (id,source,source_event_id,request_id,status,reason,received_at)
    VALUES (?,?,?,?,?,?,?)`).run('event-gmail-1', 'gmail', 'gmail-message-1', 'request-gmail-1', 'imported', null, now());
  db.sqlite.prepare(`INSERT INTO drafts (id,request_id,slug,menu_json,status,checks_json,revision,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run('draft-1', 'request-gmail-1', 'osteria-di-prova', menuJson, 'pronta_pr', '{}', 5, now(), now());
  db.sqlite.prepare(`INSERT INTO live_pr_operations
    (id,draft_id,revision,snapshot_sha,base_sha,branch_name,pr_number,pr_url,status,last_error,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run('pr-live-1', 'draft-1', 5, await hash(menuJson), 'base-sha-1', 'control-room/test', 19,
    'https://github.example.test/Rua56/renmenu/pull/19', 'merged', null, now(), now());
}

function publicFetch(response) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => { calls.push({ url, init }); return response; }
  };
}

function payload(revision = 7) {
  return { requestId: 'request-gmail-1', revision, confirmation: PURGE_PUBLISHED_EMAIL_CONFIRMATION };
}

async function expectBlocked(db, fetch, expected) {
  await assert.rejects(() => purgePublishedEmail({ db, input: payload(), fetch, now, uid }),
    (error) => error.status === 409 && /nessun dato eliminato|nel frattempo/i.test(error.message));
  assert.equal(db.sqlite.prepare('SELECT source_text FROM requests WHERE id=?').get('request-gmail-1').source_text,
    'Corpo Gmail riservato: non deve restare in D1.');
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='email.retention.purged'").get().n, 0);
  assert.equal(expected(), true);
}

describe('published Gmail email retention (fake fetch only)', () => {
  it('keeps the Gmail body when the canonical public menu is not published', async () => {
    const db = database();
    try {
      await seed(db);
      const remote = publicFetch(new Response(null, { status: 404 }));
      await expectBlocked(db, remote.fetch, () => remote.calls.length === 1 &&
        remote.calls[0].url === 'https://renmenu.pages.dev/menus/osteria-di-prova.json');
    } finally { db.close(); }
  });

  it('keeps the Gmail body when a valid public JSON menu is semantically different', async () => {
    const db = database();
    try {
      await seed(db);
      const remote = publicFetch(Response.json(menu('13,00')));
      await expectBlocked(db, remote.fetch, () => remote.calls.length === 1);
    } finally { db.close(); }
  });

  it('rejects redirects instead of following a public-menu URL elsewhere', async () => {
    const db = database();
    try {
      await seed(db);
      const remote = publicFetch(new Response(null, { status: 302, headers: { Location: 'https://attacker.example/menu.json' } }));
      await expectBlocked(db, remote.fetch, () => remote.calls.length === 1 && remote.calls[0].init.redirect === 'manual');
    } finally { db.close(); }
  });

  it('fails before fetch and preserves the body for a stale concurrent request revision', async () => {
    const db = database();
    try {
      await seed(db, { revision: 8 });
      const remote = publicFetch(Response.json(menu()));
      await assert.rejects(() => purgePublishedEmail({ db, input: payload(7), fetch: remote.fetch, now, uid }),
        (error) => error.status === 409 && /nel frattempo/i.test(error.message));
      assert.equal(remote.calls.length, 0);
      assert.equal(db.sqlite.prepare('SELECT source_text FROM requests WHERE id=?').get('request-gmail-1').source_text,
        'Corpo Gmail riservato: non deve restare in D1.');
    } finally { db.close(); }
  });

  it('scrubs only the Gmail body atomically after the public menu and merged PR are verified', async () => {
    const db = database();
    try {
      await seed(db);
      const remote = publicFetch(Response.json(reorderedMenu()));
      const result = await purgePublishedEmail({ db, input: payload(), fetch: remote.fetch, now, uid });
      assert.deepEqual(result, { requestId: 'request-gmail-1', purged: true, reused: false });
      const scrubbed = db.sqlite.prepare('SELECT source_text,revision FROM requests WHERE id=?').get('request-gmail-1');
      assert.equal(scrubbed.source_text, '');
      assert.equal(scrubbed.revision, 8);
      assert.deepEqual({ ...db.sqlite.prepare('SELECT source,source_event_id,request_id,status,reason FROM external_events').get() },
        { source: 'gmail', source_event_id: 'gmail-message-1', request_id: 'request-gmail-1', status: 'imported', reason: null });
      const audit = db.sqlite.prepare("SELECT action,summary FROM audit_events WHERE action='email.retention.purged'").get();
      assert.equal(audit.action, 'email.retention.purged');
      assert.equal(audit.summary.includes('Corpo Gmail riservato'), false, 'audit must not retain inbound content');
      assert.equal(remote.calls.length, 1);
    } finally { db.close(); }
  });

  it('returns the durable redacted receipt on retry without another fetch or write', async () => {
    const db = database();
    try {
      await seed(db);
      const remote = publicFetch(Response.json(menu()));
      await purgePublishedEmail({ db, input: payload(), fetch: remote.fetch, now, uid });
      const retried = await purgePublishedEmail({ db, input: payload(), fetch: async () => {
        throw new Error('a completed retry must not fetch again');
      }, now, uid });
      assert.deepEqual(retried, { requestId: 'request-gmail-1', purged: true, reused: true });
      assert.equal(remote.calls.length, 1);
      assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='email.retention.purged'").get().n, 1);
    } finally { db.close(); }
  });
});

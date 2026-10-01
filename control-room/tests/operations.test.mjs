import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { runPrivateIntegrationAction } from '../cloudflare/functions/_lib/operations.js';

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
      try { const result = statements.map((statement) => statement.run()); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
    close: () => sqlite.close()
  };
}

const now = () => '2026-10-01T12:00:00.000Z';
let sequence = 0;
const uid = () => `id-${++sequence}`;
const getOne = (db, sql, ...params) => db.prepare(sql).bind(...params).first();
const rows = async (db, sql, ...params) => (await db.prepare(sql).bind(...params).all()).results || [];

async function auditedBatch(db, writes, event, message, requestId = null, guard = null) {
  const id = uid(), stamp = now();
  const auditSql = guard
    ? `INSERT INTO audit_events (id,request_id,action,summary,actor,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS (${guard.sql})`
    : 'INSERT INTO audit_events (id,request_id,action,summary,actor,created_at) VALUES (?,?,?,?,?,?)';
  const audit = db.prepare(auditSql).bind(id, requestId, event, message.slice(0, 240), 'owner', stamp, ...(guard?.args || []));
  const statements = [...writes, audit];
  if (requestId) statements.push(db.prepare('UPDATE requests SET last_action_at=? WHERE id=? AND EXISTS (SELECT 1 FROM audit_events WHERE id=?)').bind(stamp, requestId, id));
  const result = await db.batch(statements);
  if (result[writes.length].meta.changes !== 1) throw Object.assign(new Error('audit guard failed'), { status: 409 });
  return result.slice(0, writes.length);
}

function context(db, env = {}) {
  return { db, env, getOne, rows, auditedBatch, now, uid };
}

function insertRequest(db, { id = 'request-1', clientId = 'client-1', kind = 'nuovo', status = 'nuova', revision = 1, source = '## Primi\nGnocchi — 12,00' } = {}) {
  db.sqlite.prepare(`INSERT INTO clients (id,name,plan,revision,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
    .run(clientId, 'Osteria di prova', 'standard', 1, now(), now());
  db.sqlite.prepare(`INSERT INTO requests (id,client_id,subject,source_channel,source_text,kind,status,plan,revision,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, clientId, 'Menu prova', 'email', source, kind, status, 'standard', revision, now(), now());
  return id;
}

const menu = () => ({
  id: 'osteria-di-prova', nome: { it: 'Osteria di prova' }, lingue: ['it'],
  sezioni: [{ nome: { it: 'Primi' }, voci: [{ nome: { it: 'Gnocchi' }, prezzo: '12,00', allergeni: ['1'] }] }]
});

const checks = () => ({
  prices: true, allergens: true, languages: true, clientApproval: true, allergenOmissionConfirmed: true,
  fieldEvidence: {
    prices: 'Listino ufficiale di prova con Gnocchi a 12,00.',
    allergens: 'Documento ufficiale prova con allergene 1 per gli gnocchi.',
    languages: 'Fonte italiana ufficiale verificata dal revisore.'
  },
  clientApprovalEvidence: 'Approvazione scritta di prova del locale per la revisione.'
});

function response(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function prStatus({ merged = true, headRef = 'control-room/menu-osteria-di-prova-verify',
  htmlUrl = 'https://github.example.test/Rua56/renmenu/pull/18' } = {}) {
  return {
    number: 18, state: merged ? 'closed' : 'open', draft: false,
    merged_at: merged ? now() : null, html_url: htmlUrl,
    head: { ref: headRef, sha: 'head-a' }, base: { ref: 'main', sha: 'main-commit-a' }
  };
}

function githubFetch({ uncertain = false, status = prStatus() } = {}) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (uncertain) throw new Error('lost response');
    if (/\/pulls\/\d+$/.test(url.pathname) && init.method === 'GET') return response(status);
    if (url.pathname.endsWith('/pulls') && init.method === 'GET') return response([]);
    if (url.pathname.endsWith('/git/ref/heads/main')) return response({ object: { sha: 'main-commit-a' } });
    if (url.pathname.endsWith('/contents/menus/osteria-di-prova.json') && init.method === 'GET')
      return response({ type: 'file', sha: 'file-old', content: Buffer.from(JSON.stringify(menu())).toString('base64') });
    if (url.pathname.includes('/git/ref/heads/control-room/menu-osteria-di-prova-')) return response({ message: 'Not Found' }, 404);
    if (url.pathname.endsWith('/git/refs') && init.method === 'POST') return response({ ref: JSON.parse(init.body).ref, object: { sha: 'main-commit-a' } }, 201);
    if (url.pathname.endsWith('/contents/menus/osteria-di-prova.json') && init.method === 'PUT')
      return response({ content: { sha: 'file-new' }, commit: { sha: 'commit-new' } }, 201);
    if (url.pathname.endsWith('/pulls') && init.method === 'POST') {
      const body = JSON.parse(init.body);
      return response({ number: 18, state: 'open', draft: true, merged_at: null,
        html_url: 'https://github.example.test/Rua56/renmenu/pull/18',
        head: { ref: body.head, sha: 'head-a' }, base: { ref: 'main', sha: 'main-commit-a' } }, 201);
    }
    throw new Error(`unexpected GitHub call: ${init.method} ${url}`);
  };
  return { fetch, calls };
}

function publicFetch(handler) {
  const calls = [];
  return {
    calls,
    fetch: async (input, init = {}) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      return handler(url, init);
    }
  };
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function reorderedMenu() {
  const source = menu();
  return {
    lingue: source.lingue,
    sezioni: source.sezioni.map((section) => ({
      voci: section.voci.map((item) => ({ allergeni: item.allergeni, prezzo: item.prezzo, nome: item.nome })),
      nome: section.nome
    })),
    nome: source.nome,
    id: source.id
  };
}

async function insertPublication(db, {
  requestId = 'request-publication', draftId = 'draft-publication', requestRevision = 4,
  draftRevision = 7, operationId = 'operation-publication', branchName = 'control-room/menu-osteria-di-prova-verify'
} = {}) {
  insertRequest(db, { id: requestId, kind: 'aggiornamento', status: 'approvata', revision: requestRevision });
  const menuJson = JSON.stringify(menu());
  const snapshotSha = await sha256(menuJson);
  db.sqlite.prepare('INSERT INTO drafts (id,request_id,slug,menu_json,status,checks_json,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(draftId, requestId, 'osteria-di-prova', menuJson, 'pronta_pr', JSON.stringify(checks()), draftRevision, now(), now());
  db.sqlite.prepare('INSERT INTO draft_versions (id,draft_id,revision,menu_json,actor,created_at) VALUES (?,?,?,?,?,?)')
    .run(`${draftId}-version`, draftId, draftRevision, menuJson, 'editorial_review', now());
  db.sqlite.prepare(`INSERT INTO live_pr_operations
    (id,draft_id,revision,snapshot_sha,base_sha,branch_name,pr_number,pr_url,status,last_error,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(operationId, draftId, draftRevision, snapshotSha, 'main-commit-a', branchName, 18,
      'https://github.example.test/Rua56/renmenu/pull/18', 'pr_open', null, now(), now());
  return {
    requestId, draftId, requestRevision, draftRevision, operationId, branchName,
    payload: {
      draftId, requestRevision, revision: draftRevision,
      confirmation: 'CONFERMO VERIFICA PUBBLICAZIONE'
    }
  };
}

describe('private AI + GitHub operations (fakes only)', () => {
  it('keeps mock AI offline, treats classification/extraction as advisory, and saves only a confirmed human-reviewed draft with CAS', async () => {
    const db = database();
    try {
      const requestId = insertRequest(db);
      const offline = async () => { throw new Error('mock mode must not call a provider'); };
      const classified = await runPrivateIntegrationAction(context(db, { AI_PROVIDER: 'mock', AI_FETCH: offline }), 'aiClassifyRequest', {
        requestId, requestRevision: 1
      });
      assert.equal(classified.advisory, true);
      assert.equal(classified.provider, 'mock');
      const afterClassify = getOne(db, 'SELECT kind,status,revision FROM requests WHERE id=?', requestId);
      assert.equal(afterClassify.kind, 'nuovo');
      assert.equal(afterClassify.status, 'nuova');
      assert.equal(afterClassify.revision, 1);

      const preview = await runPrivateIntegrationAction(context(db, { AI_PROVIDER: 'mock', AI_FETCH: offline }), 'aiExtractMenu', {
        requestId, requestRevision: 1
      });
      assert.equal(preview.advisory, true);
      assert.equal(preview.menu.sezioni[0].voci[0].prezzo, '12,00');
      assert.equal(getOne(db, 'SELECT id FROM drafts WHERE request_id=?', requestId), null);
      await assert.rejects(() => runPrivateIntegrationAction(context(db), 'saveAiReviewedDraft', {
        requestId, requestRevision: 1, menu: preview.menu
      }), (error) => error.status === 403);

      const saved = await runPrivateIntegrationAction(context(db), 'saveAiReviewedDraft', {
        requestId, requestRevision: 1, confirmation: 'CONFERMO BOZZA AI REVISIONATA', menu: preview.menu
      });
      assert.equal(saved.requiresEditorialReview, true);
      assert.equal(getOne(db, 'SELECT status,revision FROM requests WHERE id=?', requestId).revision, 2);
      assert.equal(getOne(db, 'SELECT actor,status FROM draft_versions JOIN drafts ON drafts.id=draft_versions.draft_id WHERE drafts.request_id=?', requestId).actor, 'ai_human_review');

      const translations = await runPrivateIntegrationAction(context(db, { AI_PROVIDER: 'mock', AI_FETCH: offline }), 'aiSuggestTranslations', {
        requestId, requestRevision: 2, targetLanguage: 'en', items: [{ path: 'sezioni.0.nome', text: 'Primi' }]
      });
      assert.equal(translations.suggestions.requires_human_review, true);
      assert.equal(getOne(db, 'SELECT revision,status FROM drafts WHERE request_id=?', requestId).revision, 1);
      assert.ok((await rows(db, 'SELECT action FROM audit_events WHERE request_id=?', requestId)).some((entry) => entry.action === 'ai.draft.save'));
    } finally { db.close(); }
  });

  it('uses only transcripts whose private R2 object still matches the stored hash and size', async () => {
    const db = database();
    try {
      const requestId = insertRequest(db, { source: '' });
      const bytes = new TextEncoder().encode('## Primi\nRavioli — 13,00');
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      db.sqlite.prepare('INSERT INTO materials (id,request_id,r2_key,filename,mime,size,source,processing_status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run('material-1', requestId, 'private/test', 'listino.txt', 'text/plain', bytes.byteLength, 'manuale', 'trascritto', now());
      db.sqlite.prepare('INSERT INTO material_analyses (id,material_id,request_id,source_sha256,source_text,provenance_json,warnings_json,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run('analysis-1', 'material-1', requestId, hash, '## Primi\nRavioli — 13,00', '[]', '[]', 'needs_review', now());
      const BUCKET = { get: async () => ({ arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }) };
      const preview = await runPrivateIntegrationAction(context(db, { AI_PROVIDER: 'mock', BUCKET }), 'aiExtractMenu', { requestId, requestRevision: 1 });
      assert.equal(preview.menu.sezioni[0].voci[0].nome.it, 'Ravioli');
      assert.equal(preview.extraction.materialSources[0].materialId, 'material-1');

      const badBucket = { get: async () => ({ arrayBuffer: async () => new TextEncoder().encode('changed').buffer }) };
      await assert.rejects(() => runPrivateIntegrationAction(context(db, { AI_PROVIDER: 'mock', BUCKET: badBucket }), 'aiExtractMenu', {
        requestId, requestRevision: 1
      }), (error) => error.status === 409);
    } finally { db.close(); }
  });

  it('requires explicit live mode, reserves/audits an approved PR before fake GitHub writes, and does not retry an uncertain write', async () => {
    const db = database();
    try {
      const requestId = insertRequest(db, { id: 'request-pr', kind: 'aggiornamento', status: 'approvata', revision: 4 });
      db.sqlite.prepare('INSERT INTO drafts (id,request_id,slug,menu_json,status,checks_json,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run('draft-pr', requestId, 'osteria-di-prova', JSON.stringify(menu()), 'pronta_pr', JSON.stringify(checks()), 7, now(), now());
      const payload = {
        draftId: 'draft-pr', revision: 7, requestRevision: 4, confirmation: 'CONFERMO APERTURA PR LIVE',
        operationKey: 'operation-live-1', expectedBaseSha: 'main-commit-a', expectedFileSha: 'file-old'
      };
      await assert.rejects(() => runPrivateIntegrationAction(context(db), 'githubOpenPr', payload), (error) => error.status === 501);
      assert.equal(getOne(db, 'SELECT id FROM live_pr_operations WHERE draft_id=?', 'draft-pr'), null);

      const remote = githubFetch();
      const opened = await runPrivateIntegrationAction(context(db, { GITHUB_PROVIDER: 'live', GITHUB_TOKEN: 'test-token', GITHUB_FETCH: remote.fetch }), 'githubOpenPr', payload);
      assert.equal(opened.status, 'pr_open');
      assert.equal(getOne(db, 'SELECT status,pr_number FROM live_pr_operations WHERE draft_id=?', 'draft-pr').pr_number, 18);
      assert.equal(remote.calls.some(({ url }) => url.pathname.endsWith('/merge')), false);
      assert.ok((await rows(db, 'SELECT action FROM audit_events WHERE request_id=?', requestId)).some((entry) => entry.action === 'github.pr.reserve'));
      const callCount = remote.calls.length;
      const retried = await runPrivateIntegrationAction(context(db, { GITHUB_PROVIDER: 'live', GITHUB_TOKEN: 'test-token', GITHUB_FETCH: remote.fetch }), 'githubOpenPr', payload);
      assert.equal(retried.reused, true);
      assert.equal(remote.calls.length, callCount, 'idempotent completed operation makes no provider call');

      const requestId2 = insertRequest(db, { id: 'request-uncertain', clientId: 'client-2', status: 'approvata', revision: 3 });
      db.sqlite.prepare('INSERT INTO drafts (id,request_id,slug,menu_json,status,checks_json,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run('draft-uncertain', requestId2, 'osteria-di-prova', JSON.stringify(menu()), 'pronta_pr', JSON.stringify(checks()), 2, now(), now());
      const uncertainPayload = { ...payload, draftId: 'draft-uncertain', revision: 2, requestRevision: 3, operationKey: 'operation-live-uncertain' };
      const uncertain = githubFetch({ uncertain: true });
      await assert.rejects(() => runPrivateIntegrationAction(context(db, { GITHUB_PROVIDER: 'live', GITHUB_TOKEN: 'test-token', GITHUB_FETCH: uncertain.fetch }), 'githubOpenPr', uncertainPayload));
      assert.equal(getOne(db, 'SELECT status FROM live_pr_operations WHERE draft_id=?', 'draft-uncertain').status, 'needs_reconciliation');
      const callsBeforeRetry = uncertain.calls.length;
      const blocked = await runPrivateIntegrationAction(context(db, { GITHUB_PROVIDER: 'live', GITHUB_TOKEN: 'test-token', GITHUB_FETCH: uncertain.fetch }), 'githubOpenPr', uncertainPayload);
      assert.equal(blocked.needsReconciliation, true);
      assert.equal(uncertain.calls.length, callsBeforeRetry, 'uncertain write is never blindly retried');
    } finally { db.close(); }
  });

  it('verifies a merged reserved PR against the fixed public URL, ignores JSON key order, marks through audited CAS, and receipts retries', async () => {
    const db = database();
    try {
      const fixture = await insertPublication(db);
      const github = githubFetch({ status: prStatus({ headRef: fixture.branchName }) });
      const pages = publicFetch((url, init) => {
        assert.equal(url.href, 'https://renmenu.pages.dev/menus/osteria-di-prova.json');
        assert.equal(init.method, 'GET');
        assert.equal(init.redirect, 'error');
        return response(reorderedMenu());
      });
      const env = {
        GITHUB_PROVIDER: 'live', GITHUB_TOKEN: 'test-token', GITHUB_FETCH: github.fetch, PUBLIC_FETCH: pages.fetch
      };
      const verified = await runPrivateIntegrationAction(context(db, env), 'githubVerifyPublication', fixture.payload);
      assert.equal(verified.status, 'merged');
      assert.equal(verified.publicUrl, 'https://renmenu.pages.dev/menus/osteria-di-prova.json');
      assert.equal(getOne(db, 'SELECT status,pr_number FROM live_pr_operations WHERE id=?', fixture.operationId).status, 'merged');
      const completed = getOne(db, 'SELECT status,public_url,revision FROM requests WHERE id=?', fixture.requestId);
      assert.equal(completed.status, 'completata');
      assert.equal(completed.public_url, verified.publicUrl);
      assert.equal(completed.revision, fixture.requestRevision + 1);
      assert.equal(github.calls.length, 1);
      assert.equal(github.calls[0].url.pathname, '/repos/Rua56/renmenu/pulls/18');
      assert.equal(github.calls[0].init.method, 'GET');
      assert.equal(pages.calls.length, 1);
      assert.equal((await rows(db, "SELECT action FROM audit_events WHERE request_id=? AND action='github.publication.verified'", fixture.requestId)).length, 1);

      const receipt = await runPrivateIntegrationAction(context(db, env), 'githubVerifyPublication', fixture.payload);
      assert.equal(receipt.receipt, true);
      assert.equal(receipt.reused, true);
      assert.equal(github.calls.length, 1, 'a completed retry is receipt-only');
      assert.equal(pages.calls.length, 1, 'a completed retry makes no public upstream call');
      assert.equal((await rows(db, "SELECT action FROM audit_events WHERE request_id=? AND action='github.publication.verified'", fixture.requestId)).length, 1);
    } finally { db.close(); }
  });

  it('does not mark publication when the reserved PR is not merged', async () => {
    const db = database();
    try {
      const fixture = await insertPublication(db);
      const github = githubFetch({ status: prStatus({ merged: false, headRef: fixture.branchName }) });
      const pages = publicFetch(() => { throw new Error('public fetch must not run before merged PR confirmation'); });
      await assert.rejects(() => runPrivateIntegrationAction(context(db, {
        GITHUB_PROVIDER: 'live', GITHUB_TOKEN: 'test-token', GITHUB_FETCH: github.fetch, PUBLIC_FETCH: pages.fetch
      }), 'githubVerifyPublication', fixture.payload), (error) => error.status === 409);
      assert.equal(pages.calls.length, 0);
      assert.equal(getOne(db, 'SELECT status FROM live_pr_operations WHERE id=?', fixture.operationId).status, 'pr_open');
      assert.equal(getOne(db, 'SELECT status,public_url FROM requests WHERE id=?', fixture.requestId).status, 'approvata');
    } finally { db.close(); }
  });

  it('rejects a GitHub PR URL or branch mismatch before reading the public menu', async () => {
    for (const mismatch of ['url', 'branch']) {
      const db = database();
      try {
        const fixture = await insertPublication(db, {
          requestId: `request-pr-${mismatch}`, draftId: `draft-pr-${mismatch}`, operationId: `operation-pr-${mismatch}`
        });
        const github = githubFetch({ status: prStatus({
          headRef: mismatch === 'branch' ? 'control-room/menu-osteria-di-prova-other' : fixture.branchName,
          htmlUrl: mismatch === 'url' ? 'https://github.example.test/Rua56/renmenu/pull/999' : undefined
        }) });
        const pages = publicFetch(() => { throw new Error('public fetch must not run after PR identity mismatch'); });
        await assert.rejects(() => runPrivateIntegrationAction(context(db, {
          GITHUB_PROVIDER: 'live', GITHUB_TOKEN: 'test-token', GITHUB_FETCH: github.fetch, PUBLIC_FETCH: pages.fetch
        }), 'githubVerifyPublication', fixture.payload), (error) => error.status === 409);
        assert.equal(pages.calls.length, 0);
        assert.equal(getOne(db, 'SELECT status FROM live_pr_operations WHERE id=?', fixture.operationId).status, 'pr_open');
      } finally { db.close(); }
    }
  });

  it('rejects a semantically different or slug-mismatched public menu without marking the PR operation', async () => {
    for (const mode of ['different', 'slug-mismatch']) {
      const db = database();
      try {
        const fixture = await insertPublication(db, { requestId: `request-${mode}`, draftId: `draft-${mode}`, operationId: `operation-${mode}` });
        const github = githubFetch({ status: prStatus({ headRef: fixture.branchName }) });
        const pages = publicFetch(() => {
          if (mode === 'slug-mismatch') return response({ ...reorderedMenu(), id: 'another-menu' });
          const changed = reorderedMenu();
          changed.sezioni[0].voci[0].prezzo = '13,00';
          return response(changed);
        });
        await assert.rejects(() => runPrivateIntegrationAction(context(db, {
          GITHUB_PROVIDER: 'live', GITHUB_TOKEN: 'test-token', GITHUB_FETCH: github.fetch, PUBLIC_FETCH: pages.fetch
        }), 'githubVerifyPublication', fixture.payload), (error) => error.status === 409);
        assert.equal(getOne(db, 'SELECT status FROM live_pr_operations WHERE id=?', fixture.operationId).status, 'pr_open');
        const request = getOne(db, 'SELECT status,public_url FROM requests WHERE id=?', fixture.requestId);
        assert.equal(request.status, 'approvata');
        assert.equal(request.public_url, null);
      } finally { db.close(); }
    }
  });

  it('rejects a public redirect rather than following an alternate upstream', async () => {
    const db = database();
    try {
      const fixture = await insertPublication(db, { requestId: 'request-redirect', draftId: 'draft-redirect', operationId: 'operation-redirect' });
      const github = githubFetch({ status: prStatus({ headRef: fixture.branchName }) });
      const pages = publicFetch(() => new Response('', {
        status: 302, headers: { Location: 'https://untrusted.example.test/menu.json' }
      }));
      await assert.rejects(() => runPrivateIntegrationAction(context(db, {
        GITHUB_PROVIDER: 'live', GITHUB_TOKEN: 'test-token', GITHUB_FETCH: github.fetch, PUBLIC_FETCH: pages.fetch
      }), 'githubVerifyPublication', fixture.payload), (error) => error.status === 409);
      assert.equal(pages.calls[0].init.redirect, 'error');
      assert.equal(getOne(db, 'SELECT status FROM live_pr_operations WHERE id=?', fixture.operationId).status, 'pr_open');
    } finally { db.close(); }
  });

  it('uses CAS in the final audited batch so a request changed during external verification is not partially marked', async () => {
    const db = database();
    try {
      const fixture = await insertPublication(db, { requestId: 'request-cas', draftId: 'draft-cas', operationId: 'operation-cas' });
      const github = githubFetch({ status: prStatus({ headRef: fixture.branchName }) });
      const pages = publicFetch(() => {
        // Simulate another session winning the request revision after both
        // read-only upstream checks and before this action's audited batch.
        db.sqlite.prepare('UPDATE requests SET revision=revision+1 WHERE id=?').run(fixture.requestId);
        return response(reorderedMenu());
      });
      await assert.rejects(() => runPrivateIntegrationAction(context(db, {
        GITHUB_PROVIDER: 'live', GITHUB_TOKEN: 'test-token', GITHUB_FETCH: github.fetch, PUBLIC_FETCH: pages.fetch
      }), 'githubVerifyPublication', fixture.payload), (error) => error.status === 409);
      assert.equal(getOne(db, 'SELECT status FROM live_pr_operations WHERE id=?', fixture.operationId).status, 'pr_open');
      const request = getOne(db, 'SELECT status,public_url,revision FROM requests WHERE id=?', fixture.requestId);
      assert.equal(request.status, 'approvata');
      assert.equal(request.public_url, null);
      assert.equal(request.revision, fixture.requestRevision + 1);
      assert.equal((await rows(db, "SELECT action FROM audit_events WHERE request_id=? AND action='github.publication.verified'", fixture.requestId)).length, 0);
    } finally { db.close(); }
  });
});

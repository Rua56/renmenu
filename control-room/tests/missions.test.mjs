import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { onRequest } from '../cloudflare/functions/control-room/api/[[route]].js';

const domain = 'https://team-api-test.cloudflareaccess.com';
const accessEnv = { TEAM_DOMAIN: domain, POLICY_AUD: 'api-test-owner-only', OWNER_EMAIL: 'renmenu1569@gmail.com' };
const keyPair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...await crypto.subtle.exportKey('jwk', keyPair.publicKey), kid: 'api-test-key', use: 'sig', alg: 'RS256' };
const previousFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => String(url) === `${domain}/cdn-cgi/access/certs`
  ? Response.json({ keys: [jwk] }) : previousFetch(url, options);
after(() => { globalThis.fetch = previousFetch; });
const encode = (data) => Buffer.from(JSON.stringify(data)).toString('base64url');
const head = encode({ alg: 'RS256', kid: jwk.kid });
const body = encode({ iss: domain, aud: [accessEnv.POLICY_AUD], email: accessEnv.OWNER_EMAIL, type: 'app',
  exp: Math.floor(Date.now() / 1000) + 3600 });
const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keyPair.privateKey, new TextEncoder().encode(`${head}.${body}`));
const jwt = `${head}.${body}.${Buffer.from(signature).toString('base64url')}`;
const credentials = { 'Cf-Access-Jwt-Assertion': jwt };
const testEnv = (db, extra = {}) => ({ DB: db, ...accessEnv, ...extra });

function database({ withCategory = true } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0001_initial.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0002_integrations.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0003_ai_free_scope.sql', import.meta.url), 'utf8'));
  if (withCategory) sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0004_request_category.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0005_draft_provenance.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0006_publication_approvals.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0007_jarvis_missions.sql', import.meta.url), 'utf8'));
  return {
    prepare(sql) {
      return { bind(...params) {
        const statement = sqlite.prepare(sql);
        return { first: () => statement.get(...params) || null,
          all: () => ({ results: statement.all(...params) }),
          run: () => ({ meta: { changes: statement.run(...params).changes } }) };
      } };
    },
    async batch(statements) {
      sqlite.exec('BEGIN TRANSACTION');
      try { const results = statements.map((s) => s.run()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
    close: () => sqlite.close()
  };
}
const base = 'https://renmenu.pages.dev/control-room/api/';
async function call(db, path, payload, extra = {}) {
  const method = payload === undefined ? 'GET' : 'POST';
  const request = new Request(`${base}${path}`, {
    method, headers: method === 'POST' ? { ...credentials, Origin: 'https://renmenu.pages.dev', 'Content-Type': 'application/json' } : credentials,
    body: method === 'POST' ? JSON.stringify(payload) : undefined
  });
  const response = await onRequest({ request, env: testEnv(db, extra), params: { route: path.split('/') } });
  return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text() };
}
const action = (db, type, payload) => call(db, 'actions', { type, payload });

import { buildImportBatch, buildReplyBatch } from '../staging/gmail-import.mjs';
import { OUTBOX_GET_SQL, outboxSent } from '../staging/jarvis-outbox.mjs';
import { missions } from '../cloudflare/functions/control-room/api/[[route]].js';

const TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const telegramCalls = [];
const outerFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (String(url).startsWith('https://api.telegram.org/')) {
    telegramCalls.push({ method: String(url).split('/').pop(), body: JSON.parse(options.body) });
    return Response.json({ ok: true, result: { username: 'RenMenuJarvisBot', message_id: 1 } });
  }
  return outerFetch(url, options);
};
after(() => { globalThis.fetch = outerFetch; });

const run = async (db, plan) => { for (const { sql, params } of plan.batch) await db.prepare(sql).bind(...params).run(); };
const event = (messageId, subject, text, from = 'locale@example.com') => ({ messageId, from, to: 'renmenu1569@gmail.com', subject, text,
  receivedAt: '2026-10-02T18:00:00Z', relevant: true, bodyComplete: true, hasAttachments: false, attachmentNames: [], ambiguous: false });
const SOURCE = 'Buongiorno, vorrei attivare il menu digitale Standard.\nLocale: Osteria Missione\n\nANTIPASTI\nFrico con polenta — 12,00\nSardoni impanati — 9,00\nCoperto 2,50 €';
const env = { TELEGRAM_BOT_TOKEN: TOKEN };
const tick = async (db) => (await action(db, 'jarvisTick', {})).body;
const outbox = (db) => db.prepare(OUTBOX_GET_SQL.replace("o.reference_code=? AND m.status='attesa_invio'", "1=1 ORDER BY o.created_at DESC LIMIT 1").replace('SELECT o.recipient', 'SELECT o.reference_code,o.recipient')).bind().first();
async function clientReply(db, code, messageId, text) {
  const approval = await db.prepare('SELECT * FROM publication_approvals WHERE reference_code=?').bind(code).first();
  await run(db, buildReplyBatch(event(messageId, `Re: Anteprima rif. ${code}`, text), approval));
}

describe('Jarvis autonomo: dalla bozza affidata alla pubblicazione', () => {
  it('invia, applica le modifiche chiare, chiede il SÌ e registra approvazione e attivazione', async () => {
    const db = database();
    try {
      await run(db, buildImportBatch(event('m1', 'Nuovo menu', SOURCE)));
      await call(db, 'state'); await action(db, 'runAutopilot', {});
      let state = (await call(db, 'state')).body;
      const draft = state.drafts[0];
      const extras = draft.sourceExtras.filter((entry) => entry.type !== 'manuale').map((entry) => entry.id);
      assert.equal((await action(db, 'entrustToJarvis', { draftId: draft.id, revision: draft.revision, accept: extras })).status, 403, 'serve la conferma esplicita');
      const entrusted = await action(db, 'entrustToJarvis', { draftId: draft.id, revision: draft.revision, accept: extras, confirmation: 'AFFIDO A JARVIS' });
      assert.equal(entrusted.status, 200, String(entrusted.body.error));
      assert.equal(entrusted.body.result.status, 'attesa_invio');
      let queued = await outbox(db);
      assert.equal(queued.recipient, 'locale@example.com');
      assert.match(queued.subject, /rif\. RM-/);
      assert.match(entrusted.body.state.drafts[0].menu.coperto || JSON.stringify(entrusted.body.state.drafts[0].menu), /2,50/);
      assert.equal((await action(db, 'entrustToJarvis', { draftId: draft.id, revision: entrusted.body.state.drafts[0].revision, confirmation: 'AFFIDO A JARVIS' })).status, 409, 'una missione per pratica');

      // L'automazione Gmail invia e segna la riga; l'orologio registra l'invio.
      const sent = outboxSent(queued.reference_code, 'gmail-1');
      await db.prepare(sent.sql).bind(...sent.params).run();
      await tick(db);
      state = (await call(db, 'state')).body;
      assert.equal(state.missions[0].status, 'attesa_cliente');
      assert.equal(state.approvals[0].status, 'anteprima_inviata');

      // Modifica chiara: Jarvis la applica e rimanda una nuova anteprima.
      await clientReply(db, queued.reference_code, 'r1', 'Il frico con polenta costa 14,00');
      await tick(db);
      state = (await call(db, 'state')).body;
      assert.equal(state.missions[0].status, 'attesa_invio');
      assert.equal(state.missions[0].rounds, 1);
      const frico = state.drafts[0].menu.sezioni[0].voci.find((v) => v.nome.it === 'Frico con polenta');
      assert.equal(frico.prezzo, '14,00');
      const second = await outbox(db);
      assert.notEqual(second.reference_code, queued.reference_code);
      assert.ok(state.notifications.some((n) => n.subject === 'Jarvis · modifiche applicate' && /12,00 → 14,00/.test(n.body)));

      const sent2 = outboxSent(second.reference_code, 'gmail-2');
      await db.prepare(sent2.sql).bind(...sent2.params).run();
      await tick(db);
      await clientReply(db, second.reference_code, 'r2', 'Approvo, va benissimo così');
      await tick(db);
      state = (await call(db, 'state')).body;
      assert.equal(state.missions[0].status, 'attesa_si');
      assert.equal(state.approvals[0].status, 'risposta_ricevuta', 'senza il SÌ di Riccardo niente è approvato');

      // SÌ di Riccardo: approvazione e attivazione registrate; GitHub qui non è configurato,
      // quindi la pubblicazione resta in corso con un nuovo tentativo, senza errori.
      const yes = await action(db, 'jarvisDecide', { missionId: state.missions[0].id, yes: true });
      assert.equal(yes.status, 200, String(yes.body.error));
      state = yes.body.state;
      assert.equal(state.approvals[0].status, 'approvata_cliente');
      assert.equal(state.approvals[0].activation, 'prova_30_giorni');
      assert.equal(state.missions[0].status, 'pubblicazione');
      const jarvisActions = state.audit.filter((a) => a.actor === 'jarvis').map((a) => a.action);
      for (const name of ['approval.preview', 'approval.sent', 'approval.changes', 'draft.reply_changes', 'approval.client', 'approval.activation', 'jarvis.publish_ok'])
        assert.ok(jarvisActions.includes(name) || name === 'draft.reply_changes', `manca ${name}`);
      assert.deepEqual((await action(db, 'jarvisDecide', { missionId: state.missions[0].id, yes: true })).body.result.ok, false, 'il SÌ vale una volta');
    } finally { db.close(); }
  });

  it('si ferma su allergeni o risposte ambigue e lascia la decisione a Riccardo', async () => {
    const db = database();
    try {
      await run(db, buildImportBatch(event('m2', 'Nuovo menu', SOURCE.replace('Missione', 'Ferma'))));
      await action(db, 'runAutopilot', {});
      const draft = (await call(db, 'state')).body.drafts[0];
      await action(db, 'entrustToJarvis', { draftId: draft.id, revision: draft.revision, confirmation: 'AFFIDO A JARVIS' });
      const queued = await outbox(db);
      const sent = outboxSent(queued.reference_code, 'g');
      await db.prepare(sent.sql).bind(...sent.params).run();
      await tick(db);
      await clientReply(db, queued.reference_code, 'r3', 'Mmm non so, ci penso e vi faccio sapere');
      await tick(db);
      const state = (await call(db, 'state')).body;
      assert.equal(state.missions[0].status, 'ferma');
      assert.ok(state.notifications.some((n) => n.subject === 'Jarvis · serve una tua decisione'));
      const again = await action(db, 'entrustToJarvis', { draftId: state.drafts[0].id, revision: state.drafts[0].revision, confirmation: 'AFFIDO A JARVIS' });
      assert.equal(again.status, 422, 'la risposta è ancora da decidere: Riccardo la valuta prima');
    } finally { db.close(); }
  });

  it('Telegram: collegamento solo con il codice monouso e pulsanti solo dalla chat di Riccardo', async () => {
    const db = database();
    try {
      const linked = await action(db, 'telegramLink', {});
      assert.equal(linked.status, 503, 'senza token niente collegamento');
      const response = await onRequest({ request: new Request(`${base}actions`, { method: 'POST', headers: { ...credentials, Origin: 'https://renmenu.pages.dev', 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'telegramLink', payload: {} }) }), env: testEnv(db, env), params: { route: ['actions'] } });
      const link = (await response.json()).result.link;
      const code = link.split('start=')[1];
      assert.ok(telegramCalls.some((c) => c.method === 'setWebhook' && c.body.secret_token.length === 64));
      await missions.telegramUpdate(db, env, { message: { chat: { id: 99, type: 'private' }, text: '/start ' + 'f'.repeat(32) } });
      assert.equal(await missions.setting(db, 'telegram_chat_id'), null);
      await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: `/start ${code}` } });
      assert.equal(await missions.setting(db, 'telegram_chat_id'), '42');
      await missions.telegramUpdate(db, env, { message: { chat: { id: 77, type: 'private' }, text: `/start ${code}` } });
      assert.equal(await missions.setting(db, 'telegram_chat_id'), '42', 'codice già usato');
      const before = telegramCalls.length;
      await missions.telegramUpdate(db, env, { callback_query: { id: 'q', data: 'pub:x', message: { chat: { id: 77 }, message_id: 5 } } });
      assert.equal(telegramCalls.length, before, 'chat estranea ignorata');
      await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: '/stato' } });
      assert.match(telegramCalls.at(-1).body.text, /Nessuna pratica affidata/);
    } finally { db.close(); }
  });
});

import { briefingDue, buildBriefing } from '../cloudflare/functions/_lib/briefing.js';
describe('Briefing del mattino', () => {
  it('parte solo lun–sab tra le 8:00 e le 8:14 ora italiana', () => {
    assert.equal(briefingDue(new Date('2026-10-05T06:03:00Z')), true, 'lunedì 8:03 (ora legale)');
    assert.equal(briefingDue(new Date('2026-10-04T06:03:00Z')), false, 'domenica');
    assert.equal(briefingDue(new Date('2026-10-05T07:03:00Z')), false, '9:03');
    assert.equal(briefingDue(new Date('2026-12-07T07:05:00Z')), true, 'dicembre, ora solare');
  });
  it('riassume richieste, pratiche e salute dei menu online senza dati di contatto', async () => {
    const db = database();
    try {
      await run(db, buildImportBatch(event('b1', 'Nuovo menu', SOURCE)));
      const fakeFetch = async (url) => String(url).startsWith('https://api.github.com/')
        ? Response.json([{ type: 'file', name: 'bakaro.json' }, { type: 'file', name: 'rotto.json' }])
        : String(url).endsWith('/bakaro.json') ? Response.json({ id: 'bakaro', nome: 'Bakaro', lingue: ['it'], sezioni: [{ id: 's', nome: { it: 'Vini' }, voci: [{ id: 'v', nome: { it: 'Prosecco' }, prezzo: '4,00' }] }] })
          : new Response('no', { status: 404 });
      const text = await buildBriefing(db, { GITHUB_TOKEN: 'x' }, { now: new Date('2026-10-05T06:03:00Z'), fetchImpl: fakeFetch });
      assert.match(text, /Briefing di Jarvis · 05\/10/);
      assert.match(text, /1 da guardare \(nuove 1/);
      assert.match(text, /rotto: risponde 404/);
      assert.doesNotMatch(text, /@/);
    } finally { db.close(); }
  });
});

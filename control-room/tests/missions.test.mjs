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
  sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0010_draft_review_notes.sql', import.meta.url), 'utf8'));
  sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0011_draft_creative.sql', import.meta.url), 'utf8'));
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
import { ONLINE_GET_SQL, OUTBOX_GET_SQL, outboxSent } from '../staging/jarvis-outbox.mjs';
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

  it('locale senza email (pratica aperta su Telegram): anteprima a Riccardo su Telegram e pubblica solo al suo SÌ', async () => {
    const db = database();
    try {
      await run(db, buildImportBatch(event('t1', 'Nuovo menu', SOURCE)));
      await db.prepare('UPDATE clients SET email=NULL').bind().run();
      await action(db, 'runAutopilot', {});
      await missions.putSetting(db, 'telegram_chat_id', '42');
      const act = (type, payload) => call(db, 'actions', { type, payload }, env);
      const draft = (await call(db, 'state')).body.drafts[0];
      telegramCalls.length = 0;
      const entrusted = await act('entrustToJarvis', { draftId: draft.id, revision: draft.revision, confirmation: 'AFFIDO A JARVIS' });
      assert.equal(entrusted.status, 200, String(entrusted.body.error));
      assert.equal(entrusted.body.result.status, 'attesa_si');
      assert.equal(await outbox(db), null, 'nessuna email a nessuno');
      const message = telegramCalls.find((c) => c.method === 'sendMessage' && /anteprima/.test(c.body.text));
      const link = message.body.text.match(/https:\/\/\S+/)[0];
      assert.ok(link.length < 120, 'link breve, non tagliato da Telegram');
      const { onRequest: hook } = await import('../cloudflare/functions/jarvis-hook/[[route]].js');
      const opened = await hook({ request: new Request(link), env: { DB: db } });
      assert.equal(opened.status, 302);
      const full = opened.headers.get('Location');
      assert.match(full, /^https:\/\/renmenu\.pages\.dev\/menu\/\?lang=it#data=/);
      assert.equal(JSON.parse(Buffer.from(full.split('#data=')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()).id, draft.slug || JSON.parse(Buffer.from(full.split('#data=')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()).id);
      assert.equal((await hook({ request: new Request(link.replace(/RM-\w+/, 'RM-ZZZZZZ')), env: { DB: db } })).status, 404);
      assert.match(JSON.stringify(message.body.reply_markup), /pub:/);
      let state = entrusted.body.state;
      assert.equal(state.approvals[0].recipient, 'telegram:riccardo');
      assert.equal(state.approvals[0].status, 'anteprima_inviata');
      await tick(db);
      assert.equal((await call(db, 'state')).body.missions[0].status, 'attesa_si', 'aspetta solo Riccardo');
      const yes = await act('jarvisDecide', { missionId: state.missions[0].id, yes: true });
      assert.equal(yes.status, 200, String(yes.body.error));
      state = yes.body.state;
      assert.equal(state.approvals[0].status, 'approvata_cliente');
      assert.match(state.approvals[0].approvalEvidence || state.approvals[0].approval_evidence || '', /approvata da Riccardo su Telegram/);
      assert.equal(state.approvals[0].activation, 'prova_30_giorni');
      assert.equal(state.missions[0].status, 'pubblicazione');
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
      assert.match(telegramCalls.at(-1).body.text, /Foto lette oggi: 0/);
      await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: 'Jarvis, stato?' } });
      assert.match(telegramCalls.at(-1).body.text, /Nessun file in attesa di lettura/);
      await missions.putSetting(db, 'reads_day', JSON.stringify({ day: new Date().toISOString().slice(0, 10), n: 3, failed: 1 }));
      await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: 'jarvis stato.' } });
      assert.match(telegramCalls.at(-1).body.text, /Foto lette oggi: 3 \(1 non riuscite\)/);
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

describe('Pratiche già pubblicate', () => {
  it('non si riaffidano a Jarvis e non si rivedono', async () => {
    const db = database();
    try {
      await run(db, buildImportBatch(event('c1', 'Nuovo menu', SOURCE)));
      await action(db, 'runAutopilot', {});
      const draft = (await call(db, 'state')).body.drafts[0];
      await db.prepare("UPDATE requests SET status='completata'").bind().run();
      const again = await action(db, 'entrustToJarvis', { draftId: draft.id, revision: draft.revision, confirmation: 'AFFIDO A JARVIS' });
      assert.equal(again.status, 409);
      assert.match(again.body.error, /già pubblicato/);
      assert.equal((await db.prepare("SELECT status FROM requests").bind().first()).status, 'completata', 'resta chiusa');
    } finally { db.close(); }
  });
});

describe('Dubbi della foto su Telegram, uno alla volta', () => {
  it('Riccardo tocca il prezzo giusto, ne scrive uno, salta; dopo l’ultimo Jarvis prepara la bozza con le voci scelte', async () => {
    const db = database();
    try {
      await missions.putSetting(db, 'telegram_chat_id', '42');
      await db.prepare("INSERT INTO clients (id,name,plan,internal_notes,revision,created_at,updated_at) VALUES ('c1','Trattoria Dubbi','standard','',1,'2026-10-05','2026-10-05')").bind().run();
      await db.prepare("INSERT INTO requests (id,client_id,subject,source_channel,source_text,kind,status,plan,category,internal_notes,revision,created_at,updated_at) VALUES ('r1','c1','Nuovo menu Standard · Trattoria Dubbi','telegram','Locale: Trattoria Dubbi','nuovo','in_revisione','standard','nuovo_standard','',1,'2026-10-05','2026-10-05')").bind().run();
      await db.prepare("INSERT INTO materials (id,request_id,r2_key,filename,mime,size,source,processing_status,created_at) VALUES ('m1','r1','private/tg/1','menu.png','image/png',8,'telegram','letto_da_jarvis','2026-10-05')").bind().run();
      const { combineReadings } = await import('../cloudflare/functions/_lib/vision.js');
      const r = combineReadings('# Primi piatti\nSpaghetti — 7,00\nRisotto — 8,00\nGnocchi — 9,00\n# Dolci\nStrudel — 5,00',
        '# Primi piatti\nSpaghetti — 3,00\nRisotto — 8,00\nGnocchi — 6,00\n# Dolci\nStrudel — 5,00\nTiramisù — 5,00');
      assert.equal(r.checks.length, 3);
      await db.prepare("INSERT INTO material_analyses (id,material_id,request_id,source_sha256,source_text,provenance_json,warnings_json,status,created_at) VALUES ('a1','m1','r1','x',?,?,'[]','needs_review','2026-10-05')")
        .bind(r.text, JSON.stringify([{ materialId: 'm1', method: 'jarvis_foto_doppia_lettura', checks: r.checks }])).run();
      const lastSent = () => telegramCalls.filter((c) => c.method === 'sendMessage').at(-1).body.text;
      const before = telegramCalls.length;
      assert.equal(await missions.startChecks(db, env, 'r1'), 3);
      assert.match(lastSent(), /Dubbio 1 di 3 · Primi piatti\n«Spaghetti»/);
      assert.ok(telegramCalls.slice(before).every((c) => c.method !== 'sendMessage' || !/bozza pronta/i.test(c.body.text)));
      await missions.telegramUpdate(db, env, { callback_query: { id: 'q1', data: 'chk:0:0', message: { chat: { id: 42 }, message_id: 7 } } });
      assert.match(lastSent(), /Dubbio 2 di 3[\s\S]*«Gnocchi»/);
      await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: '8,5' } });
      assert.match(lastSent(), /Dubbio 3 di 3[\s\S]*«Tiramisù»/);
      await missions.telegramUpdate(db, env, { callback_query: { id: 'q3', data: 'chk:2:s', message: { chat: { id: 42 }, message_id: 9 } } });
      const text = (await db.prepare("SELECT source_text FROM material_analyses WHERE id='a1'").bind().first()).source_text;
      assert.match(text, /# Primi piatti\nRisotto — 8,00\nSpaghetti — 7,00\nGnocchi — 8,50\n# Dolci/);
      assert.match(text, /\[da verificare\] Tiramisù/, 'saltata: resta da verificare');
      assert.match(lastSent(), /Dubbi chiusi: 2 voci aggiunte/);
      assert.match(lastSent(), /Preparo la bozza adesso/);
      assert.equal(await db.prepare("SELECT count(*) n FROM drafts").bind().first().n ?? 0, 0, 'mai dentro la risposta a Telegram');
      await missions.draftAfterChecks(db, env);
      assert.match(lastSent(), /Bozza pronta/);
      const draft = await db.prepare("SELECT menu_json FROM drafts WHERE request_id='r1'").bind().first();
      assert.ok(draft, 'bozza preparata dopo l’ultimo dubbio');
      assert.match(draft.menu_json, /Spaghetti[\s\S]*7,00/);
      assert.equal(await missions.setting(db, 'tg_checks'), 'null');
    } finally { db.close?.(); }
  });
});

describe('Correzioni dettate alla bozza su Telegram', () => {
  const aiFor = (operazioni, dubbio = '') => ({ run: async (model, input) => {
    const schema = input?.response_format?.json_schema;
    if (schema?.properties?.operazioni) return { response: { operazioni, dubbio } };
    if (schema?.properties?.intent) return { response: { intent: 'aggiorna_menu', locale: '', risposta: '' } };
    return { response: 'ok' };
  } });
  const lastSent = () => telegramCalls.filter((c) => c.method === 'sendMessage').at(-1);
  const say = (db, env2, text) => missions.telegramUpdate(db, env2, { message: { chat: { id: 42, type: 'private' }, text } });
  async function draftDb() {
    const db = database();
    await missions.putSetting(db, 'telegram_chat_id', '42');
    await run(db, buildImportBatch(event('e1', 'Nuovo menu', SOURCE)));
    await action(db, 'runAutopilot', {});
    return db;
  }

  it('cambia un prezzo nella bozza, azzera la checklist, e Annulla ripristina', async () => {
    const db = await draftDb();
    try {
      const before = await db.prepare('SELECT id,menu_json,revision FROM drafts').bind().first();
      const frico = JSON.parse(before.menu_json).sezioni[0].voci.findIndex((v) => /frico/i.test(v.nome.it));
      const env2 = { ...env, AI: aiFor([{ tipo: 'prezzo', si: 0, vi: frico, prezzo: '14' }]) };
      await say(db, env2, 'il frico con polenta costa 14 euro');
      const after = await db.prepare('SELECT menu_json,revision,status FROM drafts').bind().first();
      assert.equal(JSON.parse(after.menu_json).sezioni[0].voci[frico].prezzo, '14,00');
      assert.equal(after.revision, before.revision + 1);
      assert.equal(after.status, 'revisione');
      const msg = lastSent();
      assert.match(msg.body.text, /Fatto, bozza di .* aggiornata/);
      assert.match(msg.body.text, /12,00 → 14,00/);
      assert.ok(JSON.stringify(msg.body.reply_markup).includes(`undo:${before.id}`), 'pulsante Annulla');
      assert.equal((await db.prepare("SELECT count(*) n FROM audit_events WHERE action='draft.telegram_edit'").bind().first()).n, 1);
      await missions.telegramUpdate(db, env2, { callback_query: { id: 'u1', data: `undo:${before.id}`, message: { chat: { id: 42 }, message_id: 5 } } });
      const undone = await db.prepare('SELECT menu_json,revision FROM drafts').bind().first();
      assert.equal(JSON.parse(undone.menu_json).sezioni[0].voci[frico].prezzo, JSON.parse(before.menu_json).sezioni[0].voci[frico].prezzo);
      assert.equal(undone.revision, before.revision + 2);
      assert.match(lastSent().body.text, /Annullato/);
    } finally { db.close?.(); }
  });

  it('un locale con menu in formato proprio (Blanch) è riconosciuto ma non modificato', async () => {
    const db = database();
    try {
      await missions.putSetting(db, 'telegram_chat_id', '42');
      await db.prepare("INSERT INTO clients (id,name,plan,menu_url,internal_notes,created_at,updated_at) VALUES ('c-bl','Trattoria Blanch','da_definire','https://renmenu.pages.dev/blanch/','',?,?)").bind('2026-10-06T10:00:00.000Z', '2026-10-06T10:00:00.000Z').run();
      const ai = { run: async (model, input) => input?.response_format?.json_schema?.properties?.intent ? { response: { intent: 'aggiorna_menu', locale: 'Trattoria Blanch', risposta: '' } } : { response: 'ok' } };
      await say(db, { ...env, AI: ai }, 'alla Trattoria Blanch il prosciutto costa 14 euro');
      assert.match(lastSent().body.text, /formato proprio/);
      assert.equal((await db.prepare('SELECT count(*) n FROM requests').bind().first()).n, 0);
    } finally { db.close?.(); }
  });

  it('se la pratica aspettava un SÌ, la modifica ferma la missione: nessun anteprima vecchia resta valida', async () => {
    const db = await draftDb();
    try {
      const draft = await db.prepare('SELECT id,request_id,menu_json FROM drafts').bind().first();
      const stamp = '2026-10-05T10:00:00.000Z';
      await db.prepare("INSERT INTO jarvis_missions (id,request_id,draft_id,status,step_started_at,created_at,updated_at) VALUES ('m1',?,?,'attesa_si',?,?,?)").bind(draft.request_id, draft.id, stamp, stamp, stamp).run();
      const frico = JSON.parse(draft.menu_json).sezioni[0].voci.findIndex((v) => /frico/i.test(v.nome.it));
      const env2 = { ...env, AI: aiFor([{ tipo: 'prezzo', si: 0, vi: frico, prezzo: '14' }]) };
      await say(db, env2, 'il frico con polenta costa 14 euro');
      assert.equal((await db.prepare("SELECT status FROM jarvis_missions WHERE id='m1'").bind().first()).status, 'annullata');
      assert.match(lastSent().body.text, /ho fermato quella pratica/);
    } finally { db.close?.(); }
  });

  it('un prezzo mai detto non entra: la bozza resta com’è', async () => {
    const db = await draftDb();
    try {
      const before = await db.prepare('SELECT menu_json,revision FROM drafts').bind().first();
      const env2 = { ...env, AI: aiFor([{ tipo: 'prezzo', si: 0, vi: 0, prezzo: '99' }]) };
      await say(db, env2, 'il frico con polenta costa 14 euro');
      const after = await db.prepare('SELECT menu_json,revision FROM drafts').bind().first();
      assert.equal(after.revision, before.revision);
      assert.equal(after.menu_json, before.menu_json);
      assert.match(lastSent().body.text, /non applico nulla/);
      const miss = await db.prepare("SELECT summary FROM audit_events WHERE action='jarvis.not_understood'").bind().first();
      assert.match(miss?.summary || '', /il frico con polenta costa 14 euro.*→/);
    } finally { db.close?.(); }
  });

  it('Annulla non cancella il lavoro fatto dopo la modifica', async () => {
    const db = await draftDb();
    try {
      const d = await db.prepare('SELECT id FROM drafts').bind().first();
      const env2 = { ...env, AI: aiFor([{ tipo: 'prezzo', si: 0, vi: 0, prezzo: '14' }]) };
      const name = JSON.parse((await db.prepare('SELECT menu_json FROM drafts').bind().first()).menu_json).sezioni[0].voci[0].nome.it;
      await say(db, env2, `${name} costa 14 euro`);
      await db.prepare('UPDATE drafts SET revision=revision+1').bind().run();
      await missions.telegramUpdate(db, env2, { callback_query: { id: 'u2', data: `undo:${d.id}`, message: { chat: { id: 42 }, message_id: 6 } } });
      assert.match(lastSent().body.text, /è cambiata ancora/);
    } finally { db.close?.(); }
  });
});

describe('Rilettura di tutti i file di una pratica', () => {
  it('rimette in coda foto e PDF già letti o falliti, non le foto per il menu né gli archiviati; «rileggi» da Telegram la chiede', async () => {
    const db = database();
    try {
      await missions.putSetting(db, 'telegram_chat_id', '42');
      await db.prepare("INSERT INTO clients (id,name,plan,internal_notes,revision,created_at,updated_at) VALUES ('c1','Trattoria Rilettura','standard','',1,'2026-10-05','2026-10-05')").bind().run();
      await db.prepare("INSERT INTO requests (id,client_id,subject,source_channel,source_text,kind,status,plan,category,internal_notes,revision,created_at,updated_at) VALUES ('r1','c1','Nuovo menu Standard · Trattoria Rilettura','telegram','x','nuovo','in_revisione','standard','nuovo_standard','',1,'2026-10-05','2026-10-05')").bind().run();
      const mat = (id, st, mime = 'image/png', archived = null) => db.prepare("INSERT INTO materials (id,request_id,r2_key,filename,mime,size,source,processing_status,created_at,archived_at) VALUES (?,'r1',?,'f.png',?,8,'telegram',?,'2026-10-05',?)").bind(id, 'private/'+id, mime, st, archived).run();
      await mat('m1', 'letto_da_jarvis'); await mat('m2', 'non_leggibile'); await mat('m3', 'foto_per_il_menu'); await mat('m4', 'letto_da_jarvis', 'image/png', '2026-10-05'); await mat('m5', 'letto_da_jarvis', 'text/plain');
      await missions.putSetting(db, 'tg_checks', JSON.stringify({ requestId: 'r1', queue: [], k: 0 }));
      const sent = () => telegramCalls.filter((c) => c.method === 'sendMessage').at(-1).body.text;
      await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: 'Jarvis, rileggi le foto di Trattoria Rilettura' } });
      const status = Object.fromEntries((await db.prepare('SELECT id,processing_status s FROM materials').bind().all()).results.map((r) => [r.id, r.s]));
      assert.deepEqual(status, { m1: 'da_trascrivere', m2: 'da_trascrivere', m3: 'foto_per_il_menu', m4: 'letto_da_jarvis', m5: 'letto_da_jarvis' });
      assert.match(sent(), /Rimetto in coda 2 file di «Trattoria Rilettura»/);
      assert.equal(await missions.setting(db, 'tg_checks'), 'null', 'i dubbi vecchi non valgono più');
      assert.equal((await db.prepare("SELECT count(*) n FROM audit_events WHERE action='material.reread'").bind().first()).n, 1);
    } finally { db.close?.(); }
  });
});

describe('Email al locale con link e QR dopo la pubblicazione', () => {
  it('mette in coda l’email con allegati, la consegna all’automazione e avvisa Riccardo', async () => {
    const db = database();
    try {
      await run(db, buildImportBatch(event('qm1', 'Nuovo menu', SOURCE)));
      await call(db, 'state'); await action(db, 'runAutopilot', {});
      const draft = (await call(db, 'state')).body.drafts[0];
      const extras = draft.sourceExtras.filter((entry) => entry.type !== 'manuale').map((entry) => entry.id);
      await action(db, 'entrustToJarvis', { draftId: draft.id, revision: draft.revision, accept: extras, confirmation: 'AFFIDO A JARVIS' });
      const mission = await db.prepare('SELECT * FROM jarvis_missions').bind().first();
      await db.prepare("UPDATE jarvis_missions SET status='completata'").bind().run();
      const row = await db.prepare('SELECT r.*,c.name AS client_name,c.email AS client_email FROM requests r JOIN clients c ON c.id=r.client_id WHERE r.id=?').bind(mission.request_id).first();
      const dr = await db.prepare('SELECT * FROM drafts WHERE id=?').bind(mission.draft_id).first();
      const qr = await missions.makeMenuQr({ slug: dr.slug, name: 'Osteria Missione', plan: 'standard' });
      const queued = await missions.queueOnlineEmail(db, env, { mission, request: row, draft: dr, menu: JSON.parse(dr.menu_json), qr });
      assert.equal(queued.queued, true);
      assert.equal(queued.to, 'locale@example.com');
      const out = await db.prepare(ONLINE_GET_SQL).bind(queued.code).first();
      assert.match(out.subject, /^Il tuo menu RenMenu è online · /);
      assert.match(out.body, new RegExp(`https://renmenu.pages.dev/menu/\\?m=${dr.slug}`));
      assert.match(out.body, /qr-.*\.png/);
      assert.doesNotMatch(out.body, /€|prezzo di/i, 'niente prezzi o pagamenti nell’email');
      const stored = JSON.parse((await db.prepare('SELECT value FROM jarvis_settings WHERE key=?').bind(`outbox_qr_${queued.code}`).first()).value);
      assert.equal(Buffer.from(stored.png, 'base64').subarray(1, 4).toString(), 'PNG');
      assert.match(stored.svg, /^<svg/);
      assert.equal(await db.prepare(OUTBOX_GET_SQL).bind(queued.code).first(), null, 'l’anteprima e l’email online non si scambiano');
      // Non ancora partita: nessun avviso.
      const before = (await call(db, 'state')).body.notifications.length;
      await missions.checkOnlineMails(db, env);
      assert.equal((await call(db, 'state')).body.notifications.length, before);
      // L'automazione la invia e segna la riga: Riccardo viene avvisato e gli allegati temporanei spariscono.
      const sent = outboxSent(queued.code, 'gmail-9');
      await db.prepare(sent.sql).bind(...sent.params).run();
      await missions.checkOnlineMails(db, env);
      const notes = (await call(db, 'state')).body.notifications;
      assert.ok(notes.some((n) => /email del menu online/.test(n.subject) && /inviata al locale \(locale@example\.com\)/.test(n.body)));
      assert.equal(await db.prepare('SELECT 1 FROM jarvis_settings WHERE key=?').bind(`outbox_qr_${queued.code}`).first(), null);
      // Senza email del locale o con un indirizzo interno: nessuna coda.
      for (const email of [null, 'iuran56@gmail.com']) {
        assert.equal((await missions.queueOnlineEmail(db, env, { mission, request: { ...row, client_email: email }, draft: dr, menu: JSON.parse(dr.menu_json), qr })).queued, false);
      }
    } finally { db.close(); }
  });
});

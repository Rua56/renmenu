import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { missions, onRequest } from "../cloudflare/functions/control-room/api/[[route]].js";

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
  sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0008_mail_files.sql', import.meta.url), 'utf8'));
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

import { buildImportBatch } from '../staging/gmail-import.mjs';
import { autopilotPreview } from '../cloudflare/functions/_lib/autopilot.js';

const email = (messageId, subject, text) => ({ messageId, from: 'locale@example.com', to: 'renmenu1569@gmail.com', subject, text,
  receivedAt: '2026-10-02T18:00:00Z', relevant: true, bodyComplete: true, hasAttachments: false, attachmentNames: [], ambiguous: false });
async function importEmail(db, event) {
  const plan = buildImportBatch(event);
  for (const { sql, params } of plan.batch) await db.prepare(sql).bind(...params).run();
  return plan.ids.requestId;
}
const act = (db, type, payload, extra) => call(db, 'actions', { type, payload }, extra);

import { matchVenue, speak, understand } from '../cloudflare/functions/_lib/voice.js';

const LIVE = { id: 'osteria-viva', nome: 'Osteria Viva', lingue: ['it'], sezioni: [
  { nome: { it: 'Antipasti' }, voci: [{ nome: { it: 'Frico con polenta' }, prezzo: '12,00' }] },
  { nome: { it: 'Bevande' }, voci: [{ nome: { it: 'Spritz Aperol' }, prezzo: '4,00' }] }] };
const TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const calls = [];
const fakeFetch = async (url, options = {}) => {
  const href = String(url);
  if (href.includes('/contents/menus/osteria-viva.json')) return Response.json({ type: 'file', sha: 'abc1234def', content: Buffer.from(JSON.stringify(LIVE)).toString('base64') });
  if (href.includes('/contents/menus/')) return Response.json({ message: 'Not Found' }, { status: 404 });
  if (href.startsWith('https://api.elevenlabs.io/')) { calls.push({ method: 'tts', url: href, body: JSON.parse(options.body), headers: options.headers }); return new Response(new Uint8Array(2000), { status: 200 }); }
  if (href.startsWith('https://api.telegram.org/file/')) return new Response(new Uint8Array([79, 103, 103, 83, 1, 2, 3]), { status: 200 });
  if (href.startsWith('https://api.telegram.org/')) {
    const method = href.split('/').pop();
    calls.push({ method, body: options.body instanceof FormData ? Object.fromEntries([...options.body.keys()].map((k) => [k, options.body.get(k)])) : JSON.parse(options.body || '{}') });
    return Response.json({ ok: true, result: method === 'getFile' ? { file_path: 'voice/file_1.oga', file_size: 7 } : { message_id: 1 } });
  }
  return Response.json({ message: 'unexpected' }, { status: 500 });
};
const aiSaying = (heard, intent) => ({ run: async (model) => (model.includes('whisper') ? { text: heard } : { response: JSON.stringify(intent) }) });

describe('Comandi vocali di Jarvis', () => {
  it('trova il locale detto a voce solo se la corrispondenza è unica', () => {
    const clients = [{ name: 'Osteria Viva', menu_id: 'osteria-viva' }, { name: 'Bakaro', menu_id: 'bakaro' }, { name: 'Pub Underground', menu_id: 'pub-underground' }, { name: 'Pub Centrale', menu_id: 'pub-centrale' }];
    assert.equal(matchVenue('all’Osteria Viva', clients).client.menu_id, 'osteria-viva');
    assert.equal(matchVenue('Osteria Morta', clients).client, null, 'nessuna corrispondenza inventata');
    assert.equal(matchVenue('Osteria Viva', clients).client.menu_id, 'osteria-viva');
    assert.equal(matchVenue('al Bakaro', clients).client.menu_id, 'bakaro');
    assert.equal(matchVenue('pub', clients).client, null);
    assert.equal(matchVenue('underground', clients).client.menu_id, 'pub-underground');
  });
  it('intenzione fuori elenco o JSON rotto: non chiaro, nessuna azione', async () => {
    assert.equal((await understand({ run: async () => ({ response: '{"intent":"cancella_tutto"}' }) }, 'x', '')).intent, 'non_chiaro');
    assert.equal((await understand({ run: async () => ({ response: 'boh' }) }, 'x', '')).intent, 'non_chiaro');
    const asObject = await understand({ run: async () => ({ response: { intent: 'risposta', locale: '', risposta: 'Tutto tranquillo.' } }) }, 'x', '');
    assert.deepEqual([asObject.intent, asObject.risposta], ['risposta', 'Tutto tranquillo.'], 'oggetto già decodificato da Workers AI');
  });
  it('voce ElevenLabs maschile multilingue, tono calmo; senza chiave nessun audio', async () => {
    calls.length = 0;
    assert.equal(await speak({ provider: 'elevenlabs', apiKey: '' }, 'ciao', fakeFetch), null);
    const audio = await speak({ provider: 'elevenlabs', apiKey: 'k'.repeat(30) }, 'Buonasera Riccardo. https://x.y', fakeFetch);
    assert.ok(audio.length > 500);
    assert.match(calls[0].url, /JBFqnCBsd6RMkjVDRZzb/);
    assert.equal(calls[0].body.model_id, 'eleven_multilingual_v2');
    assert.doesNotMatch(calls[0].body.text, /https/);
  });
  it('vocale «all’Osteria Viva lo spritz ora costa 5 euro» → bozza dal menu online e risposta a voce', async () => {
    const db = database();
    const previous = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      calls.length = 0;
      await db.prepare("INSERT INTO clients (id,name,email,plan,menu_id,internal_notes,revision,created_at,updated_at) VALUES ('c1','Osteria Viva','o@example.com','standard','osteria-viva','',1,'2026-10-01','2026-10-01')").bind().run();
      await missions.putSetting(db, 'telegram_chat_id', '42');
      await missions.putSetting(db, 'voice_provider', 'elevenlabs');
      await missions.putSetting(db, 'voice_api_key', 'k'.repeat(30));
      const env = testEnv(db, { TELEGRAM_BOT_TOKEN: TOKEN, GITHUB_PROVIDER: 'live', GITHUB_TOKEN: 't', GITHUB_FETCH: fakeFetch, TRANSLATION_PROVIDER: 'disabled',
        AI: aiSaying('Jarvis, all’Osteria Viva lo spritz ora costa 5 euro', { intent: 'aggiorna_menu', locale: 'Osteria Viva', risposta: '' }) });
      await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, voice: { file_id: 'v1', duration: 4 } } });
      const draft = await db.prepare("SELECT d.menu_json,r.subject,r.source_text FROM drafts d JOIN requests r ON r.id=d.request_id").bind().first();
      assert.ok(draft, JSON.stringify(calls.at(-1)));
      assert.equal(draft.source_text, 'Jarvis, all’Osteria Viva lo spritz ora costa 5 euro', 'fonte = parole di Riccardo, non del modello');
      const menu = JSON.parse(draft.menu_json);
      assert.equal(menu.sezioni[1].voci[0].prezzo, '5,00');
      assert.equal(menu.sezioni[0].voci[0].prezzo, '12,00', 'il resto invariato');
      const voice = calls.find((c) => c.method === 'sendVoice');
      assert.ok(voice, 'risposta a voce');
      assert.match(voice.body.caption, /«Jarvis, all’Osteria Viva.*»[\s\S]*Ho preparato l’aggiornamento di «Osteria Viva»/);
      const spokenText = calls.find((c) => c.method === 'tts').body.text;
      assert.match(spokenText, /^Fatto\./, 'a voce solo la risposta');
      assert.doesNotMatch(spokenText, /spritz ora costa 5 euro»/);
      assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM jarvis_missions').bind().first().n, 0, 'niente affidato né pubblicato');
    } finally { globalThis.fetch = previous; db.close(); }
  });
  it('«pubblica» a voce: mai pubblicazione diretta, solo il pulsante SÌ', async () => {
    const db = database();
    const previous = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      calls.length = 0;
      await missions.putSetting(db, 'telegram_chat_id', '42');
      const env = testEnv(db, { TELEGRAM_BOT_TOKEN: TOKEN, AI: aiSaying('', { intent: 'pubblica', locale: '', risposta: '' }) });
      await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: 'pubblica tutto adesso' } });
      assert.match(calls.at(-1).body.text, /nessun menu aspetta il tuo SÌ/);
    } finally { globalThis.fetch = previous; db.close(); }
  });
  it('«crea una nuova pratica per Antoine I love You con piano standard» → cliente + pratica, poi la foto si collega da sola', async () => {
    const db = database();
    const previous = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      calls.length = 0;
      await missions.putSetting(db, 'telegram_chat_id', '42');
      const store = new Map();
      const BUCKET = { put: async (k, v) => { store.set(k, v); }, get: async () => null, delete: async () => {} };
      const env = testEnv(db, { TELEGRAM_BOT_TOKEN: TOKEN, BUCKET, AI: aiSaying('', { intent: 'crea_pratica', locale: 'Antoine I love You', risposta: '' }) });
      await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: 'Jarvis, crea una nuova pratica per il locale Antoine I love You con un piano standard e attendi nuove direttive' } });
      const request = await db.prepare('SELECT r.*,c.name AS client FROM requests r JOIN clients c ON c.id=r.client_id').bind().first();
      assert.deepEqual([request.client, request.category, request.plan, request.kind, request.status], ['Antoine I love You', 'nuovo_standard', 'standard', 'nuovo', 'nuova']);
      assert.match(calls.at(-1).body.text, /Ho creato il cliente «Antoine I love You»/);
      await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, photo: [{ file_id: 'p1', width: 800, height: 1200, file_size: 7 }] } });
      const material = await db.prepare('SELECT * FROM materials WHERE request_id=?').bind(request.id).first();
      assert.ok(material, 'foto collegata alla pratica appena aperta');
      assert.equal(material.source, 'telegram');
      assert.match(calls.at(-1).body.text, /pratica che mi hai appena fatto aprire/);
    } finally { globalThis.fetch = previous; db.close(); }
  });
  it('nome non detto davvero o cliente simile: chiede, non crea', async () => {
    const db = database();
    const previous = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      calls.length = 0;
      await missions.putSetting(db, 'telegram_chat_id', '42');
      let env = testEnv(db, { TELEGRAM_BOT_TOKEN: TOKEN, AI: aiSaying('', { intent: 'crea_pratica', locale: 'Trattoria Inventata', risposta: '' }) });
      await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: 'crea una nuova pratica' } });
      assert.match(calls.at(-1).body.text, /Come si chiama il locale/);
      await db.prepare("INSERT INTO clients (id,name,plan,internal_notes,revision,created_at,updated_at) VALUES ('c9','Al Bakaro','standard','',1,'2026-10-01','2026-10-01')").bind().run();
      env = testEnv(db, { TELEGRAM_BOT_TOKEN: TOKEN, AI: aiSaying('', { intent: 'crea_pratica', locale: 'Bakaro', risposta: '' }) });
      await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: 'apri una pratica per Bakaro' } });
      assert.match(calls.at(-1).body.text, /Esiste già un cliente simile: «Al Bakaro»/);
      assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM requests').bind().first()).n, 0);
    } finally { globalThis.fetch = previous; db.close(); }
  });
  it('coperto detto a voce sul menu online: «aggiungi nella sezione informazioni … un coperto da 3 euro»', async () => {
    const db = database();
    const previous = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      await db.prepare("INSERT INTO clients (id,name,email,plan,menu_id,internal_notes,revision,created_at,updated_at) VALUES ('c1','Osteria Viva',NULL,'standard','osteria-viva','',1,'2026-10-01','2026-10-01')").bind().run();
      await missions.putSetting(db, 'telegram_chat_id', '42');
      const said = 'Jarvis, aggiungi nella sezione informazioni del menu Osteria Viva un coperto da 3 euro';
      const env = testEnv(db, { TELEGRAM_BOT_TOKEN: TOKEN, GITHUB_PROVIDER: 'live', GITHUB_TOKEN: 't', GITHUB_FETCH: fakeFetch, TRANSLATION_PROVIDER: 'disabled', AI: aiSaying('', { intent: 'aggiorna_menu', locale: 'Osteria Viva', risposta: '' }) });
      await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: said } });
      const draft = await db.prepare('SELECT menu_json FROM drafts').bind().first();
      assert.ok(draft, JSON.stringify(calls.at(-1)?.body));
      assert.equal(JSON.parse(draft.menu_json).coperto, '3,00');
    } finally { globalThis.fetch = previous; db.close(); }
  });
});

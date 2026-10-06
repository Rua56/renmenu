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
import { onRequest as jarvisHook } from '../cloudflare/functions/jarvis-hook/[[route]].js';
const hook = (request, env) => jarvisHook({ request, env });
const SOURCE = 'Buongiorno, vorrei attivare il menu digitale Standard.\nLocale: Trattoria Nuova\n\nANTIPASTI\nFrico con polenta — 12,00\nSardoni impanati — 9,00\nCoperto 2,50 €';

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
  it('«Il piano è un abbonamento standard» dopo aver aperto la pratica: aggiorna QUELLA pratica, non apre pratiche su altri clienti', async () => {
    const db = database();
    const previous = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      calls.length = 0;
      await missions.putSetting(db, 'telegram_chat_id', '42');
      await db.prepare("INSERT INTO clients (id,name,plan,menu_id,internal_notes,revision,created_at,updated_at) VALUES ('ph','Nuovo contatto email','premium','enoteca-prova','',1,'2026-10-01','2026-10-01')").bind().run();
      let env = testEnv(db, { TELEGRAM_BOT_TOKEN: TOKEN, AI: aiSaying('', { intent: 'crea_pratica', locale: 'Il Pisello di Marco', risposta: '' }) });
      await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: 'Il nome del locale è Il Pisello di Marco.' } });
      env = testEnv(db, { TELEGRAM_BOT_TOKEN: TOKEN, AI: aiSaying('', { intent: 'aggiorna_menu', locale: '', risposta: '' }) });
      await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: 'Il piano è un abbonamento standard.' } });
      const all = await db.prepare('SELECT r.subject,r.plan,r.category,c.name AS client FROM requests r JOIN clients c ON c.id=r.client_id').bind().all();
      assert.equal(all.results.length, 1, 'nessuna pratica in più');
      assert.deepEqual([all.results[0].client, all.results[0].plan, all.results[0].category, all.results[0].subject], ['Il Pisello di Marco', 'standard', 'nuovo_standard', 'Nuovo menu Standard · Il Pisello di Marco']);
      assert.match(calls.at(-1).body.text, /Segnato, Riccardo: piano Standard/);
      // Senza pratica appena aperta, un cliente «Nuovo contatto email» non viene mai scelto a caso.
      await missions.putSetting(db, 'tg_focus', 'null');
      await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: 'Il piano è un abbonamento standard.' } });
      assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM requests').bind().first()).n, 1);
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

  it('«tutto apposto?» → punto della situazione scritto dai dati, senza pratiche inventate', async () => {
    const db = database();
    const previous = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      calls.length = 0;
      await missions.putSetting(db, 'telegram_chat_id', '42');
      const env = testEnv(db, { TELEGRAM_BOT_TOKEN: TOKEN, AI: aiSaying('', { intent: 'stato', locale: '', risposta: 'INVENTATO', dettaglio: 'breve' }) });
      await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: 'Jarvis, tutto apposto?' } });
      const text = calls.at(-1).body.text;
      assert.match(text, /Non ci sono pratiche aperte/);
      assert.match(text, /tutto regolare/);
      assert.doesNotMatch(text, /INVENTATO/);
    } finally { globalThis.fetch = previous; db.close(); }
  });
  it('«dammi buone notizie» e «resoconto dettagliato» usano i dati; se il modello non risponde bastano le parole chiave', async () => {
    const db = database();
    const previous = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      calls.length = 0;
      await db.prepare("INSERT INTO clients (id,name,email,plan,menu_id,internal_notes,revision,created_at,updated_at) VALUES ('c1','Osteria Viva',NULL,'standard','osteria-viva','',1,'2026-10-01','2026-10-01')").bind().run();
      await missions.putSetting(db, 'telegram_chat_id', '42');
      const down = { run: async () => { throw new Error('giù'); } };
      const env = testEnv(db, { TELEGRAM_BOT_TOKEN: TOKEN, AI: down });
      await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: 'Jarvis dammi buone notizie' } });
      assert.match(calls.at(-1).body.text, /Buone notizie, Riccardo: 1 menu è online/);
      await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: 'Jarvis ho bisogno di un resoconto dettagliato' } });
      assert.match(calls.at(-1).body.text, /Resoconto completo, Riccardo/);
      await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: 'Jarvis come siamo messi con le pratiche?' } });
      assert.match(calls.at(-1).body.text, /Non ci sono pratiche aperte/);
    } finally { globalThis.fetch = previous; db.close(); }
  });
  it('«mostrami anteprima di X» → link breve di sola visione alla bozza, che si apre solo con il codice', async () => {
    const db = database();
    const previous = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      calls.length = 0;
      const stamp = '2026-10-05T10:00:00.000Z';
      await db.prepare("INSERT INTO clients (id,name,email,plan,menu_id,internal_notes,revision,created_at,updated_at) VALUES ('c9','Trattoria Nuova',NULL,'standard','','',1,?,?)").bind(stamp, stamp).run();
      globalThis.fetch = previous;
      const made = await action(db, 'createRequest', { clientId: 'c9', subject: 'Nuovo menu Standard · Trattoria Nuova', sourceChannel: 'altro', sourceText: SOURCE, kind: 'nuovo', plan: 'standard', category: 'nuovo_standard' });
      assert.equal(made.status, 200, JSON.stringify(made.body));
      const req = made.body.id || made.body.result?.id || made.body.data?.id;
      await action(db, 'generateDraft', { requestId: req });
      globalThis.fetch = fakeFetch;
      await missions.putSetting(db, 'telegram_chat_id', '42');
      const env = testEnv(db, { TELEGRAM_BOT_TOKEN: TOKEN, JARVIS_ORIGIN: 'https://jarvis.test', AI: aiSaying('', { intent: 'anteprima', locale: 'Trattoria Nuova', risposta: '' }) });
      await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: 'Jarvis mostrami anteprima di Trattoria Nuova' } });
      const text = calls.at(-1).body.text;
      const code = text.match(/jarvis-hook\/bozza\/(BZ-[A-Z0-9]{10})/)?.[1];
      assert.ok(code, text);
      assert.match(text, /non è pubblicata e non è stata inviata a nessuno/);
      const open = await hook(new Request(`https://jarvis.test/jarvis-hook/bozza/${code}`), env);
      assert.equal(open.status, 302);
      assert.match(open.headers.get('Location'), /^https:\/\/renmenu\.pages\.dev\/menu\/\?lang=it#data=/);
      const wrong = await hook(new Request('https://jarvis.test/jarvis-hook/bozza/BZ-AAAAAAAAAA'), env);
      assert.equal(wrong.status, 404);
      for (const [cut, pattern] of [['breve', /Hai 1 pratica aperta: «Trattoria Nuova» \(bozza in revisione/], ['completo', /Pratiche aperte \(1\):\n- Trattoria Nuova: bozza in revisione[\s\S]*Aspettano te: «Trattoria Nuova»/]]) {
        const envStato = testEnv(db, { TELEGRAM_BOT_TOKEN: TOKEN, AI: aiSaying('', { intent: 'stato', locale: '', risposta: '', dettaglio: cut }) });
        await missions.telegramUpdate(db, envStato, { message: { chat: { id: 42, type: 'private' }, text: `Jarvis stato ${cut}` } });
        assert.match(calls.at(-1).body.text, pattern);
      }
    } finally { globalThis.fetch = previous; db.close(); }
  });
  it('«mi serve un menu per X in fretta» → pratica segnata come urgente', async () => {
    const db = database();
    const previous = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      calls.length = 0;
      await missions.putSetting(db, 'telegram_chat_id', '42');
      const env = testEnv(db, { TELEGRAM_BOT_TOKEN: TOKEN, AI: aiSaying('', { intent: 'crea_pratica', locale: 'Bar Aurora', risposta: '', urgente: true }) });
      await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: "Jarvis mi serve un menu per il cliente Bar Aurora in fretta" } });
      assert.match(calls.at(-1).body.text, /L’ho segnata come urgente/);
      const note = await db.prepare('SELECT internal_notes AS n FROM requests').bind().first();
      assert.match(note.n, /URGENTE/);
    } finally { globalThis.fetch = previous; db.close(); }
  });

  async function pratica(db, name) {
    globalThis.fetch = previousFetch;
    const stamp = '2026-10-05T10:00:00.000Z';
    await db.prepare("INSERT INTO clients (id,name,email,plan,menu_id,internal_notes,revision,created_at,updated_at) VALUES ('cx',?,NULL,'standard','','',1,?,?)").bind(name, stamp, stamp).run();
    const made = await action(db, 'createRequest', { clientId: 'cx', subject: `Nuovo menu Standard · ${name}`, sourceChannel: 'altro', sourceText: SOURCE.replace('Trattoria Nuova', name), kind: 'nuovo', plan: 'standard', category: 'nuovo_standard' });
    const requestId = made.body.id || made.body.result?.id || made.body.data?.id;
    await action(db, 'generateDraft', { requestId });
    globalThis.fetch = fakeFetch;
    return requestId;
  }
  it('«elimina la pratica di X»: prima chiede conferma con pulsante, poi cancella pratica, bozza, file e cliente, lasciando il registro', async () => {
    const db = database();
    const previous = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      calls.length = 0;
      const requestId = await pratica(db, 'Trattoria Nuova');
      await missions.putSetting(db, 'telegram_chat_id', '42');
      await db.prepare("INSERT INTO materials (id,request_id,r2_key,filename,mime,size,source,processing_status,text_preview,created_at) VALUES ('mat1',?,'private/mat1.jpg','foto.jpg','image/jpeg',10,'telegram','letto_da_jarvis',NULL,'2026-10-05T10:00:00.000Z')").bind(requestId).run();
      const removed = [];
      const env = testEnv(db, { TELEGRAM_BOT_TOKEN: TOKEN, BUCKET: { delete: async (key) => { removed.push(key); } }, AI: aiSaying('', { intent: 'cancella_pratica', locale: 'Trattoria Nuova', risposta: '' }) });
      await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: 'Jarvis elimina la pratica di Trattoria Nuova' } });
      assert.match(calls.at(-1).body.text, /1 file caricato/);
      const ask = calls.at(-1).body;
      assert.match(ask.text, /Vuoi che elimini «Nuovo menu Standard · Trattoria Nuova»\?/);
      assert.match(ask.text, /Elimino anche il cliente/);
      assert.ok(JSON.stringify(ask.reply_markup).includes(`del:${requestId}`));
      assert.equal((await db.prepare('SELECT COUNT(*) n FROM requests').bind().first()).n, 1, 'niente è cancellato prima del pulsante');
      await missions.telegramUpdate(db, env, { callback_query: { id: 'c1', data: `delno:x`, message: { chat: { id: 42 }, message_id: 7 } } });
      assert.equal((await db.prepare('SELECT COUNT(*) n FROM requests').bind().first()).n, 1);
      await missions.telegramUpdate(db, env, { callback_query: { id: 'c2', data: `del:${requestId}`, message: { chat: { id: 42 }, message_id: 8 } } });
      assert.match(calls.at(-1).body.text, /Fatto, Riccardo: ho eliminato/);
      assert.match(calls.at(-1).body.text, /Prossimo passo: vuoi aprire una nuova pratica/);
      for (const table of ['requests', 'drafts', 'materials', 'clients']) assert.equal((await db.prepare(`SELECT COUNT(*) n FROM ${table}`).bind().first()).n, 0, table);
      assert.deepEqual(removed, ['private/mat1.jpg']);
      assert.equal((await db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='request.deleted'").bind().first()).n, 1);
      assert.ok((await db.prepare('SELECT COUNT(*) n FROM audit_events WHERE request_id IS NULL').bind().first()).n >= 2, 'il registro resta');
    } finally { globalThis.fetch = previous; db.close(); }
  });
  it('non elimina una pratica pubblicata né un cliente con menu online', async () => {
    const db = database();
    const previous = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      calls.length = 0;
      const requestId = await pratica(db, 'Osteria Online');
      await db.prepare("UPDATE requests SET status='completata' WHERE id=?").bind(requestId).run();
      await db.prepare("UPDATE clients SET menu_id='osteria-online' WHERE id='cx'").bind().run();
      await missions.putSetting(db, 'telegram_chat_id', '42');
      const env = testEnv(db, { TELEGRAM_BOT_TOKEN: TOKEN, AI: aiSaying('', { intent: 'cancella_pratica', locale: 'Osteria Online', risposta: '' }) });
      await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: 'Jarvis cancella il cliente Osteria Online' } });
      assert.match(calls.at(-1).body.text, /Non elimino .*il menu risulta già pubblicato|ha un menu online/);
      assert.equal(calls.at(-1).body.reply_markup, undefined);
      await missions.telegramUpdate(db, env, { callback_query: { id: 'c3', data: `del:${requestId}`, message: { chat: { id: 42 }, message_id: 9 } } });
      assert.match(calls.at(-1).body.text, /Non elimino/);
      assert.equal((await db.prepare('SELECT COUNT(*) n FROM requests').bind().first()).n, 1);
    } finally { globalThis.fetch = previous; db.close(); }
  });
  it('la situazione propone il passo successivo: guardare la bozza in revisione, con il pulsante', async () => {
    const db = database();
    const previous = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      calls.length = 0;
      await pratica(db, 'Bar Aurora');
      await missions.putSetting(db, 'telegram_chat_id', '42');
      const env = testEnv(db, { TELEGRAM_BOT_TOKEN: TOKEN, JARVIS_ORIGIN: 'https://jarvis.test', AI: aiSaying('', { intent: 'stato', locale: '', risposta: '', dettaglio: 'breve' }) });
      await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: 'Jarvis tutto apposto?' } });
      const msg = calls.at(-1).body;
      assert.match(msg.text, /Prossimo passo: guarda «Bar Aurora»/);
      const draft = await db.prepare('SELECT id FROM drafts').bind().first();
      assert.ok(JSON.stringify(msg.reply_markup).includes(`peek:${draft.id}`));
      await missions.telegramUpdate(db, env, { callback_query: { id: 'c4', data: `peek:${draft.id}`, message: { chat: { id: 42 }, message_id: 3 } } });
      assert.match(calls.at(-1).body.text, /jarvis-hook\/bozza\/BZ-/);
    } finally { globalThis.fetch = previous; db.close(); }
  });

  it('«affida la pratica»: riepilogo con link e pulsante; il tocco affida davvero; una bozza cambiata nel frattempo non si affida', async () => {
    const db = database();
    const previous = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      calls.length = 0;
      await pratica(db, 'Bar Aurora');
      await missions.putSetting(db, 'telegram_chat_id', '42');
      const env = testEnv(db, { TELEGRAM_BOT_TOKEN: TOKEN, AI: aiSaying('', { intent: 'affida_pratica', locale: 'Bar Aurora', risposta: '' }) });
      await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: 'Jarvis affida a te la pratica di Bar Aurora' } });
      const ask = calls.at(-1).body;
      assert.match(ask.text, /Riepilogo per affidare «Bar Aurora»/);
      assert.match(ask.text, /Con il tuo tocco confermi di aver controllato prezzi, allergeni e lingue/);
      assert.match(ask.text, /jarvis-hook\/bozza\/BZ-/);
      assert.match(ask.text, /Pubblico solo dopo il tuo SÌ/);
      const draft = await db.prepare('SELECT id,revision FROM drafts').bind().first();
      const data = JSON.stringify(ask.reply_markup);
      assert.ok(data.includes(`aff:${draft.id}:${draft.revision}:`), data);
      assert.equal((await db.prepare('SELECT COUNT(*) n FROM jarvis_missions').bind().first()).n, 0, 'niente prima del tocco');
      // la bozza cambia dopo il riepilogo: il tocco vecchio non vale
      await db.prepare('UPDATE drafts SET revision=revision+1 WHERE id=?').bind(draft.id).run();
      await missions.telegramUpdate(db, env, { callback_query: { id: 'a1', data: `aff:${draft.id}:${draft.revision}:n`, message: { chat: { id: 42 }, message_id: 5 } } });
      assert.match(calls.at(-1).body.text, /La bozza è cambiata dopo il riepilogo/);
      assert.equal((await db.prepare('SELECT COUNT(*) n FROM jarvis_missions').bind().first()).n, 0);
      const fresh = await db.prepare('SELECT revision FROM drafts WHERE id=?').bind(draft.id).first();
      await missions.telegramUpdate(db, env, { callback_query: { id: 'a2', data: `aff:${draft.id}:${fresh.revision}:n`, message: { chat: { id: 42 }, message_id: 6 } } });
      assert.match(calls.at(-1).body.text, /Fatto, Riccardo: «Bar Aurora» è affidata a Jarvis/);
      assert.equal((await db.prepare('SELECT COUNT(*) n FROM jarvis_missions').bind().first()).n, 1);
      assert.equal((await db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='jarvis.entrust'").bind().first()).n, 1);
      // già affidata: il riepilogo lo dice e non offre pulsanti
      await missions.telegramUpdate(db, env, { callback_query: { id: 'a3', data: `affq:${draft.id}`, message: { chat: { id: 42 }, message_id: 7 } } });
      assert.match(calls.at(-1).body.text, /sta già seguendo/);
    } finally { globalThis.fetch = previous; db.close(); }
  });
});

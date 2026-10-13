import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { onRequest } from '../cloudflare/functions/control-room/api/[[route]].js';
import { groundUnderstanding, understandClientRequest } from '../cloudflare/functions/_lib/request-ai.js';
import { buildImportBatch } from '../staging/gmail-import.mjs';

const domain = 'https://team-request-ai.cloudflareaccess.com';
const accessEnv = { TEAM_DOMAIN: domain, POLICY_AUD: 'request-ai-owner-only', OWNER_EMAIL: 'renmenu1569@gmail.com' };
const keyPair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...await crypto.subtle.exportKey('jwk', keyPair.publicKey), kid: 'request-ai-key', use: 'sig', alg: 'RS256' };
const previousFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => String(url) === `${domain}/cdn-cgi/access/certs`
  ? Response.json({ keys: [jwk] }) : previousFetch(url, options);
after(() => { globalThis.fetch = previousFetch; });
const encode = (data) => Buffer.from(JSON.stringify(data)).toString('base64url');
const head = encode({ alg: 'RS256', kid: jwk.kid });
const body = encode({ iss: domain, aud: [accessEnv.POLICY_AUD], email: accessEnv.OWNER_EMAIL, type: 'app', exp: Math.floor(Date.now() / 1000) + 3600 });
const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keyPair.privateKey, new TextEncoder().encode(`${head}.${body}`));
const credentials = { 'Cf-Access-Jwt-Assertion': `${head}.${body}.${Buffer.from(signature).toString('base64url')}` };

function database() {
  const sqlite = new DatabaseSync(':memory:');
  const dir = new URL('../cloudflare/migrations/', import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(file, dir), 'utf8'));
  return {
    prepare(sql) {
      return { bind(...params) {
        const statement = sqlite.prepare(sql);
        return { first: () => statement.get(...params) || null, all: () => ({ results: statement.all(...params) }),
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
async function act(db, type, payload, extra) {
  const request = new Request('https://renmenu.pages.dev/control-room/api/actions', { method: 'POST',
    headers: { ...credentials, Origin: 'https://renmenu.pages.dev', 'Content-Type': 'application/json' }, body: JSON.stringify({ type, payload }) });
  const response = await onRequest({ request, env: { DB: db, ...accessEnv, ...extra }, params: { route: ['actions'] } });
  return { status: response.status, body: await response.json() };
}
const email = (messageId, subject, text) => ({ messageId, from: 'locale@example.com', to: 'renmenu1569@gmail.com', subject, text,
  receivedAt: '2026-10-02T18:00:00Z', relevant: true, bodyComplete: true, hasAttachments: false, attachmentNames: [], ambiguous: false });
async function importEmail(db, event) {
  const plan = buildImportBatch(event);
  for (const { sql, params } of plan.batch) await db.prepare(sql).bind(...params).run();
  return plan.ids.requestId;
}
const LIVE = { id: 'osteria-viva', nome: 'Osteria Viva', lingue: ['it'], sezioni: [
  { nome: { it: 'Antipasti' }, voci: [{ nome: { it: 'Frico con polenta' }, prezzo: '12,00' }, { nome: { it: 'Tagliere di salumi' }, prezzo: '14,00' }] },
  { nome: { it: 'Dolci' }, voci: [{ nome: { it: 'Gubana' }, prezzo: '5,00' }] },
  { nome: { it: 'Bevande' }, voci: [{ nome: { it: 'Spritz Aperol' }, prezzo: '4,00' }] }] };
const github = async (url) => (String(url).includes('/contents/menus/osteria-viva.json')
  ? Response.json({ type: 'file', sha: 'abc1234def', content: Buffer.from(JSON.stringify(LIVE)).toString('base64') })
  : Response.json({ message: 'Not Found' }, { status: 404 }));
// Workers AI finto: risponde alla lettura della richiesta e poi alla traduzione in operazioni.
const freeAi = (understanding, ops) => {
  const calls = [];
  return { calls, run: async (model, payload) => {
    const system = payload.messages[0].content;
    calls.push(/assistente di RenMenu/.test(system) ? 'richiesta' : 'operazioni');
    return { response: JSON.stringify(/assistente di RenMenu/.test(system) ? understanding : ops) };
  } };
};

describe('Comprensione delle richieste dei clienti (modelli gratuiti)', () => {
  it('tiene solo ciò che è scritto: niente piano, locale o prezzi inventati', () => {
    const text = 'Buongiorno, vorremmo il menu digitale per la Trattoria Al Ponte. La carbonara la facciamo a 13.';
    const out = groundUnderstanding({ categoria: 'nuovo_premium', piano: 'premium', locale: 'Ristorante Belvedere', riassunto: 'Vuole un menu nuovo.',
      modifiche: ['carbonara a 13,00', 'tiramisù a 7,00'], citazione: 'vorremmo il menu digitale' }, { subject: 'Menu', text });
    assert.equal(out.category, null, 'piano mai nominato: categoria da scegliere');
    assert.equal(out.kind, 'nuovo');
    assert.equal(out.plan, null);
    assert.equal(out.venue, null, 'locale non presente nel testo');
    assert.deepEqual(out.ai.changes, ['carbonara a 13,00']);
    assert.equal(out.reasons[0].line, 1);
    const named = groundUnderstanding({ categoria: 'nuovo_standard', piano: 'standard', locale: 'Trattoria Al Ponte', citazione: 'piano standard' },
      { text: 'Locale nuovo: Trattoria Al Ponte, prendiamo il piano standard.' });
    assert.equal(named.category, 'nuovo_standard');
    assert.equal(named.venue, 'Trattoria Al Ponte');
    assert.equal(groundUnderstanding({ categoria: 'inventata' }, { text: 'ciao' }), null);
  });

  it('usa Gemini gratuito e, se non risponde, Workers AI', async () => {
    const gemini = { key: 'k', models: ['gemini-x'], fetchImpl: async () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ categoria: 'prezzo', riassunto: 'Spritz a 5 euro.', modifiche: ['spritz a 5'], citazione: 'lo spritz lo facciamo a 5' }) }] } }] }) };
    const viaGemini = await understandClientRequest({ gemini }, { subject: 'Novità', text: 'Ciao! Da domani lo spritz lo facciamo a 5.' });
    assert.equal(viaGemini.category, 'prezzo');
    assert.equal(viaGemini.ai.model, 'gemini-x');
    const down = { key: 'k', models: ['gemini-x'], fetchImpl: async () => new Response('busy', { status: 503 }) };
    const ai = freeAi({ categoria: 'disponibilita', riassunto: 'La gubana è finita.', modifiche: ['togliere la gubana'], citazione: 'la gubana è finita' }, {});
    const viaCloudflare = await understandClientRequest({ gemini: down, ai }, { text: 'Ciao, la gubana è finita.' });
    assert.equal(viaCloudflare.category, 'disponibilita');
    assert.equal(viaCloudflare.ai.model, 'cloudflare');
  });

  it('email scritta a parole: l’autopilota capisce la modifica e prepara la bozza dal menu online', async () => {
    const db = database();
    try {
      const requestId = await importEmail(db, email('n1', 'Novità da domani', 'Ciao Riccardo! Da domani lo spritz lo facciamo a 5, e la gubana non la facciamo più. Grazie mille'));
      await db.prepare("UPDATE clients SET menu_id='osteria-viva',plan='standard' WHERE id=(SELECT client_id FROM requests WHERE id=?)").bind(requestId).run();
      const ai = freeAi({ categoria: 'prezzo', riassunto: 'Spritz a 5 euro e niente più gubana.', modifiche: ['spritz a 5,00', 'togliere la gubana'], citazione: 'lo spritz lo facciamo a 5' },
        { operazioni: [{ tipo: 'prezzo', si: 2, vi: 0, prezzo: '5,00' }, { tipo: 'rimuovi', si: 1, vi: 0 }], dubbio: '' });
      const run = await act(db, 'runAutopilot', {}, { GITHUB_PROVIDER: 'live', GITHUB_TOKEN: 't', GITHUB_FETCH: github, TRANSLATION_PROVIDER: 'disabled', AI: ai });
      assert.equal(run.status, 200, JSON.stringify(run.body));
      const audit = await db.prepare('SELECT action,summary FROM audit_events WHERE request_id=? ORDER BY created_at').bind(requestId).all();
      assert.deepEqual(ai.calls, ['richiesta', 'operazioni'], JSON.stringify({ done: run.body.result.done, audit: audit.results }));
      const request = await db.prepare('SELECT category,kind FROM requests WHERE id=?').bind(requestId).first();
      assert.equal(request.category, 'prezzo');
      const draft = await db.prepare('SELECT menu_json FROM drafts WHERE request_id=?').bind(requestId).first();
      assert.ok(draft, JSON.stringify(run.body.result.done));
      const menu = JSON.parse(draft.menu_json);
      assert.deepEqual(menu.sezioni.map((s) => s.voci.map((v) => `${v.nome.it} ${v.prezzo}`)), [['Frico con polenta 12,00', 'Tagliere di salumi 14,00'], ['Spritz Aperol 5,00']]);
      const note = await db.prepare("SELECT body FROM notifications WHERE request_id=? AND subject LIKE 'Jarvis%'").bind(requestId).first();
      assert.match(note.body, /Ho capito: Spritz a 5 euro e niente più gubana\./);
      assert.match(note.body, /Modifiche applicate:/);
      assert.ok(run.body.result.done[0].buttons.some(([, data]) => data.startsWith('undo:')), 'pulsante Annulla su Telegram');
    } finally { db.close(); }
  });

  it('se il modello non sa applicare la modifica, niente bozza a metà: decide Riccardo', async () => {
    const db = database();
    try {
      const requestId = await importEmail(db, email('n2', 'Novità', 'Ciao, cambiamo un po’ di cose la settimana prossima, ti chiamo.'));
      await db.prepare("UPDATE clients SET menu_id='osteria-viva',plan='standard' WHERE id=(SELECT client_id FROM requests WHERE id=?)").bind(requestId).run();
      const ai = freeAi({ categoria: 'piatto', riassunto: 'Cambierà qualcosa, chiamerà.', modifiche: [], citazione: 'cambiamo un po’ di cose' }, { operazioni: [], dubbio: 'Non dice cosa cambiare.' });
      await act(db, 'runAutopilot', {}, { GITHUB_PROVIDER: 'live', GITHUB_TOKEN: 't', GITHUB_FETCH: github, TRANSLATION_PROVIDER: 'disabled', AI: ai });
      assert.equal(await db.prepare('SELECT id FROM drafts WHERE request_id=?').bind(requestId).first(), null);
      const note = await db.prepare("SELECT body,subject FROM notifications WHERE request_id=? AND subject LIKE 'Jarvis%'").bind(requestId).first();
      assert.equal(note.subject, 'Jarvis · serve una tua decisione');
      assert.match(note.body, /Ho capito: Cambierà qualcosa/);
    } finally { db.close(); }
  });

  it('WhatsApp: l’autopilota aspetta qualche minuto di calma, poi legge la richiesta', async () => {
    const db = database();
    try {
      const stamp = new Date().toISOString();
      await db.prepare("INSERT INTO clients (id,name,menu_id,plan,revision,created_at,updated_at) VALUES ('c1','Osteria Viva','osteria-viva','standard',1,?,?)").bind(stamp, stamp).run();
      await db.prepare("INSERT INTO requests (id,client_id,subject,source_channel,source_text,kind,status,last_action_at,revision,created_at,updated_at) VALUES ('w1','c1','Richiesta WhatsApp','whatsapp','WhatsApp da Mario (+39333)\n\nla gubana è finita','altro','nuova',?,2,?,?)").bind(stamp, stamp, stamp).run();
      const ai = freeAi({ categoria: 'disponibilita', riassunto: 'La gubana è finita.', modifiche: ['togliere la gubana'], citazione: 'la gubana è finita' }, { operazioni: [], dubbio: '' });
      const env = { GITHUB_PROVIDER: 'live', GITHUB_TOKEN: 't', GITHUB_FETCH: github, TRANSLATION_PROVIDER: 'disabled', AI: ai };
      const early = await act(db, 'runAutopilot', {}, env);
      assert.deepEqual(early.body.result.done, [], 'messaggi appena arrivati: aspetta');
      const old = new Date(Date.now() - 5 * 60_000).toISOString();
      await db.prepare("UPDATE requests SET updated_at=? WHERE id='w1'").bind(old).run();
      const later = await act(db, 'runAutopilot', {}, env);
      assert.equal(later.body.result.done.length, 1);
      assert.equal((await db.prepare("SELECT category FROM requests WHERE id='w1'").bind().first()).category, 'disponibilita');
    } finally { db.close(); }
  });
});

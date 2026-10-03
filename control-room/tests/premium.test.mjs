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
const SOURCE = 'Buongiorno, vorrei attivare il menu digitale Standard.\nLocale: Osteria Autopilota\n\nANTIPASTI\nFrico con polenta — 12,00\nSardoni impanati — 9,00\nCoperto 2,50 €\nGli sardoni contengono pesce e glutine.';
import { briefLines, creativeBrief, premiumDirections, premiumErrors } from '../cloudflare/functions/_lib/premium.js';
import { validateMenu } from '../cloudflare/functions/_lib/menu.js';

const PREMIUM = readFileSync(new URL('./fixtures-premium.txt', import.meta.url), 'utf8');

describe('Premium su misura', () => {
  it('scheda creativa: solo ciò che il cliente ha scritto, con il lavoro su misura separato', () => {
    const brief = creativeBrief(PREMIUM, { attachments: 0 });
    assert.deepEqual(brief.stile.map((s) => s.parola), ['elegante', 'caldo']);
    assert.deepEqual(brief.colori.map((c) => c.nome), ['verde bosco', 'oro']);
    assert.deepEqual(brief.lingue, ['en', 'de', 'sl']);
    assert.deepEqual(brief.sezioni.map((s) => s.codice), ['vini', 'degustazione']);
    assert.deepEqual(brief.fuori.map((f) => f.label), ['Prenotazioni online', 'Video o animazioni']);
    assert.equal(brief.logo.stato, 'allegato');
    assert.equal(brief.permessoFoto, true);
    assert.equal(brief.scadenza.testo, 'entro il 20 ottobre');
    assert.ok(brief.preventivo, 'chiede il preventivo');
    assert.ok(briefLines(brief).some((l) => /il totale lo decidi tu/.test(l)));
    assert.ok(!briefLines(brief).some((l) => /\b\d{3,} ?€/.test(l.replace('490 €', ''))), 'nessun totale inventato');
    const directions = premiumDirections(brief);
    assert.deepEqual(directions.map((d) => d.direzione), ['editoriale', 'bistrot', 'moderno']);
    for (const d of directions) {
      assert.deepEqual(premiumErrors(d.premium), []);
      assert.equal(d.premium.colori.accento, '#2f4a3a', 'colore del cliente');
      assert.ok(!('motto' in d.premium) && !('storia' in d.premium), 'niente testi inventati');
    }
    const empty = creativeBrief('Vorrei il menu premium.\nLocale: Bar X\nCaffè 1,20');
    assert.equal(empty.direzione, null);
    assert.ok(empty.mancanti.length >= 3, 'stile, colori e logo da chiedere');
    assert.ok(!creativeBrief('Abbiamo la salsa verde e il tiramisù al caffè').colori.length, 'colori solo con una parola di contesto');
  });

  it('il blocco premium è controllato in modo stretto', () => {
    assert.deepEqual(premiumErrors({ direzione: 'bistrot', caratteri: 'artigianale', colori: { accento: '#a4462b' }, logo: 'https://example.com/logo.png' }), []);
    assert.equal(premiumErrors({ direzione: 'fucsia' }).length, 1);
    assert.equal(premiumErrors({ colori: { accento: 'red' } }).length, 1);
    assert.equal(premiumErrors({ logo: 'javascript:alert(1)' }).length, 1);
    assert.equal(premiumErrors({ script: 'x' }).length, 1);
    const menu = { id: 'x', nome: 'X', premium: { direzione: 'moderno' }, sezioni: [
      { nome: 'Percorso', tipo: 'degustazione', prezzo: '55,00', voci: [{ nome: 'Frico' }] },
      { nome: 'Vini', voci: [{ nome: 'Ribolla', prezzi: [{ etichetta: 'Calice', prezzo: '6,00' }, { etichetta: 'Bottiglia', prezzo: '28' }] }] }] };
    assert.deepEqual(validateMenu(menu).errors, []);
    assert.ok(!validateMenu(menu).warnings.some((w) => /prezzo non presente/.test(w)), 'prezzo nella sezione o nelle varianti');
    menu.sezioni[1].voci[0].prezzi[0].prezzo = 'gratis';
    assert.ok(validateMenu(menu).errors.some((e) => /variante 1/.test(e)));
  });

  it('autopilota: nessuna bozza automatica; Riccardo la genera e ottiene 3 direzioni da confrontare', async () => {
    const db = database();
    try {
      const requestId = await importEmail(db, email('prem1', 'Menu su misura', PREMIUM));
      const run = await action(db, 'runAutopilot', {});
      assert.equal(run.status, 200, String(run.body.error));
      assert.equal(run.body.result.done[0].outcome, 'proponi');
      assert.match(run.body.result.done[0].message, /Scheda creativa/);
      assert.match(run.body.result.done[0].message, /Prenotazioni online/);
      assert.equal(run.body.state.drafts.length, 0, 'la bozza Premium la avvia Riccardo');
      const request = run.body.state.requests.find((r) => r.id === requestId);
      assert.equal(request.category, 'nuovo_premium');
      const generated = await action(db, 'generateDraft', { requestId });
      assert.equal(generated.status, 200, String(generated.body.error));
      const draft = generated.body.state.drafts.find((d) => d.requestId === requestId);
      assert.equal(draft.menu.tema, undefined, 'nessun tema Standard');
      assert.equal(draft.menu.premium.direzione, 'editoriale');
      assert.equal(draft.creative.directions.length, 3);
      assert.ok(draft.creative.lines.some((l) => /Lavoro su misura/.test(l)));
      assert.ok(draft.notes.some((n) => n.kind === 'premium' && /Prenotazioni online/.test(n.hint)));
      assert.ok(draft.notes.some((n) => n.kind === 'premium' && /totale lo decidi tu/.test(n.hint)));
      // Riccardo sceglie la seconda direzione: si salva come una normale revisione della bozza.
      const menu = { ...draft.menu, premium: draft.creative.directions[1].premium };
      const saved = await action(db, 'saveDraft', { id: draft.id, revision: draft.revision, menu, slug: menu.id });
      assert.equal(saved.status, 200, String(saved.body.error));
      assert.equal(saved.body.state.drafts.find((d) => d.id === draft.id).menu.premium.direzione, 'bistrot');
      const after = saved.body.state.drafts.find((d) => d.id === draft.id);
      const bad = await action(db, 'saveDraft', { id: draft.id, revision: after.revision, menu: { ...menu, premium: { direzione: 'bistrot', colori: { fondo: 'url(x)' } } }, slug: menu.id });
      assert.notEqual(bad.status, 200, 'colore non valido rifiutato');
    } finally { db.close(); }
  });

  it('email di prova «Enoteca Isonzo Test»: Premium, percorso e vini calice/bottiglia fino alla bozza valida', async () => {
    const db = database();
    try {
      const text = readFileSync(new URL('./fixtures-email-premium-isonzo.txt', import.meta.url), 'utf8');
      const requestId = await importEmail(db, email('iso1', 'Nuovo menu Premium su misura · Enoteca Isonzo Test (TEST)', text));
      const run = await action(db, 'runAutopilot', {});
      assert.equal(run.status, 200, String(run.body.error));
      assert.equal(run.body.state.requests.find((r) => r.id === requestId).category, 'nuovo_premium');
      const generated = await action(db, 'generateDraft', { requestId });
      assert.equal(generated.status, 200, String(generated.body.error));
      const draft = generated.body.state.drafts.find((d) => d.requestId === requestId);
      assert.deepEqual(validateMenu(draft.menu).errors, []);
      assert.ok(draft.menu.premium, 'blocco Premium');
      const degu = draft.menu.sezioni.find((s) => s.tipo === 'degustazione');
      assert.equal(degu.prezzo, '55,00');
      assert.equal(degu.voci.length, 5);
      const wines = draft.menu.sezioni.filter((s) => /vini|bollicine/i.test(s.nome.it)).flatMap((s) => s.voci);
      assert.equal(wines.length, 7);
      assert.ok(wines.every((v) => Array.isArray(v.prezzi) && v.prezzi.length && !('prezzo' in v)));
      assert.ok(draft.menu.coperto === '3,00' || draft.sourceExtras.some((e) => e.type === 'coperto' && e.value === '3,00'), JSON.stringify([draft.menu.coperto, draft.sourceExtras]));
      assert.ok(!draft.menu.sezioni.flatMap((s) => s.voci).some((v) => /allergen/i.test(JSON.stringify(v.allergeni || ''))));
    } finally { db.close(); }
  });

  it('i menu Standard restano invariati: tema sì, premium no', async () => {
    const db = database();
    try {
      const requestId = await importEmail(db, email('std1', 'Nuovo menu', SOURCE));
      const run = await action(db, 'runAutopilot', {});
      const draft = run.body.state.drafts.find((d) => d.requestId === requestId);
      assert.ok(draft.menu.tema);
      assert.equal(draft.menu.premium, undefined);
      assert.equal(draft.creative, null);
    } finally { db.close(); }
  });
});

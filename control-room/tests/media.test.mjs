import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { onRequest } from "../cloudflare/functions/control-room/api/[[route]].js";
import { onRequest as publicHook } from "../cloudflare/functions/jarvis-hook/[[route]].js";
import { applyMedia, parseClassification, proposeTargets, reapplyConfirmed, removeMedia } from "../cloudflare/functions/_lib/media.js";
import { validateMenu } from "../cloudflare/functions/_lib/menu.js";

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
  sqlite.exec(readFileSync(new URL('../cloudflare/migrations/0012_media.sql', import.meta.url), 'utf8'));
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
const act = (db, type, payload, extra) => call(db, 'actions', { type, payload }, extra);

const MENU = () => ({ id: 'enoteca-foto-test', nome: { it: 'Enoteca Foto Test' }, lingue: ['it'], premium: { direzione: 'bistrot', storia: { it: 'Dal 1987.' } }, sezioni: [
  { nome: { it: 'Cicchetti' }, voci: [{ nome: { it: 'Frico con polenta' }, prezzo: '12,00' }, { nome: { it: 'Tiramisù della casa' }, prezzo: '6,00', descrizione: { it: 'mascarpone e caffè' } }] },
  { nome: { it: 'Vini bianchi' }, voci: [
    { nome: { it: 'Ribolla Gialla Collio 2024' }, prezzi: [{ etichetta: { it: 'Calice' }, prezzo: '5,00' }, { etichetta: { it: 'Bottiglia' }, prezzo: '28,00' }] },
    { nome: { it: 'Friulano Collio 2023' }, prezzi: [{ etichetta: { it: 'Calice' }, prezzo: '5,00' }, { etichetta: { it: 'Bottiglia' }, prezzo: '26,00' }] }] },
  { nome: { it: 'Percorso degustazione' }, tipo: 'degustazione', prezzo: '55,00', voci: [{ nome: { it: 'Frico' } }] }
] });
const row = (id, kind, extra = {}) => ({ id, kind, status: 'proposta', description: '', label: {}, filename: `${id}.jpg`, ...extra });

describe('Foto per il menu · riconoscimento', () => {
  it('legge il JSON del modello anche dentro ``` e scarta campi inventati o vuoti', () => {
    const out = parseClassification('Ecco:\n```json\n{"tipo":"bottiglia","descrizione":"Bottiglia di Ribolla","etichetta":{"nome":"Ribolla Gialla","cantina":"Gradis\'ciutta","annata":"2024","vitigno":"n/a","gradazione":"non leggibile"}}\n```');
    assert.deepEqual(out, { kind: 'bottiglia', description: 'Bottiglia di Ribolla', label: { nome: 'Ribolla Gialla', cantina: 'Gradis\'ciutta', annata: '2024' } });
    assert.equal(parseClassification('{"tipo":"astronave"}'), null);
    assert.equal(parseClassification('non so'), null);
    assert.equal(parseClassification('{"tipo":"logo","etichetta":{"nome":"X"}}').label.nome, undefined, 'etichetta solo per le bottiglie');
    assert.equal(parseClassification('{"tipo":"bottiglia","etichetta":{"annata":"duemila"}}').label.annata, undefined);
  });
});

describe('Foto per il menu · proposte di posto', () => {
  it('bottiglia → vino giusto (annata compresa), piatto → piatto, logo → apertura, locale → storia', () => {
    const proposals = proposeTargets(MENU(), [
      row('b1', 'bottiglia', { label: { nome: 'Ribolla Gialla', denominazione: 'Collio', annata: '2024' } }),
      row('b2', 'bottiglia', { label: { nome: 'Friulano', annata: '2023' } }),
      row('p1', 'piatto', { description: 'tiramisù in coppa' }),
      row('l1', 'logo'), row('l2', 'logo'), row('s1', 'locale'), row('x1', 'bottiglia', { label: { nome: 'Barolo' } })
    ]);
    assert.equal(proposals.get('b1').target, 'voce:1:0');
    assert.equal(proposals.get('b2').target, 'voce:1:1');
    assert.equal(proposals.get('p1').target, 'voce:0:1');
    assert.equal(proposals.get('l1').target, 'logo');
    assert.equal(proposals.get('l2').target, 'galleria', 'un solo logo');
    assert.equal(proposals.get('s1').target, 'galleria');
    assert.equal(proposals.get('x1').target, null, 'vino non presente: decide Riccardo');
  });
  it('una bottiglia non va mai su un piatto, un piatto mai su un vino, e l’annata sbagliata non vince', () => {
    const p = proposeTargets(MENU(), [row('b', 'bottiglia', { description: 'frico con polenta' }), row('d', 'piatto', { description: 'Ribolla gialla collio' }),
      row('y', 'bottiglia', { label: { nome: 'Ribolla Gialla Collio', annata: '2019' } })]);
    assert.equal(p.get('b').target, null);
    assert.equal(p.get('d').target, null);
    assert.notEqual(p.get('y').score, 1);
  });
  it('una voce riceve una sola foto: vince la più simile, e conta anche quella già confermata', () => {
    const p = proposeTargets(MENU(), [row('a', 'piatto', { description: 'frico' }), row('b', 'piatto', { description: 'frico con polenta' }),
      row('c', 'piatto', { description: 'tiramisù', status: 'confermata', target: 'voce:0:1' }), row('d', 'piatto', { description: 'tiramisù della casa' })]);
    assert.equal(p.get('b').target, 'voce:0:0');
    assert.equal(p.get('a').target, null);
    assert.equal(p.get('d').target, null);
  });
});

describe('Foto per il menu · scrittura nella bozza', () => {
  const url = 'https://jarvis.example/media/' + 'a'.repeat(64) + '.jpg';
  it('foto + dati etichetta solo nei campi vuoti, galleria e logo; il menu resta valido', () => {
    let menu = MENU();
    menu.sezioni[1].voci[0].scheda = { cantina: 'Scritta da Riccardo' };
    menu = applyMedia(menu, { target: 'voce:1:0', url, label: { cantina: 'Altra', annata: '2024', denominazione: 'Collio DOC' }, withLabel: true });
    assert.deepEqual(menu.sezioni[1].voci[0].scheda, { cantina: 'Scritta da Riccardo', annata: '2024', territorio: 'Collio DOC' });
    assert.equal(menu.sezioni[1].voci[0].foto, url);
    menu = applyMedia(menu, { target: 'logo', url });
    menu = applyMedia(menu, { target: 'galleria', url: url.replace('.jpg', '.png'), alt: 'la sala' });
    assert.deepEqual(validateMenu(menu).errors, []);
    menu = removeMedia(menu, { target: 'voce:1:0', url });
    assert.equal(menu.sezioni[1].voci[0].foto, undefined);
    assert.ok(menu.sezioni[1].voci[0].scheda, 'la scheda resta: si corregge a mano');
    menu = removeMedia(menu, { target: 'galleria', url: url.replace('.jpg', '.png') });
    assert.equal(menu.premium.galleria, undefined);
    const bad = MENU(); bad.sezioni[0].voci[0].foto = 'javascript:alert(1)'; bad.sezioni[0].voci[0].scheda = { prezzo: '1' };
    assert.equal(validateMenu(bad).errors.length, 2);
  });
  it('bozza rifatta: le foto confermate tornano sulla voce con lo stesso nome, le altre tornano da sistemare', () => {
    const menu = MENU();
    menu.sezioni.reverse();
    const { menu: again, applied, lost } = reapplyConfirmed(menu, [
      { id: 'a', status: 'confermata', target: 'voce:1:0', target_name: 'Ribolla Gialla Collio 2024', public_url: url, label_json: '{}' },
      { id: 'b', status: 'confermata', target: 'voce:0:0', target_name: 'Piatto sparito', public_url: url, label_json: '{}' }]);
    assert.equal(applied[0].target, 'voce:1:0');
    assert.equal(again.sezioni[1].voci[0].nome.it, 'Ribolla Gialla Collio 2024');
    assert.equal(again.sezioni[1].voci[0].foto, url);
    assert.deepEqual(lost.map((m) => m.id), ['b']);
  });
});

const bucket = (store = new Map()) => ({ store,
  get: async (key) => (store.has(key) ? { body: store.get(key), arrayBuffer: async () => store.get(key).buffer } : null),
  put: async (key, value) => { store.set(key, value); } });
const JPEG = new Uint8Array([255, 216, 255, 224, 1, 2, 3, 4]);

async function setup(plan = 'premium') {
  const db = database();
  await db.prepare("INSERT INTO clients (id,name,plan,internal_notes,revision,created_at,updated_at) VALUES ('c1','Enoteca Foto Test',?,'',1,'2026-10-04','2026-10-04')").bind(plan).run();
  await db.prepare("INSERT INTO requests (id,client_id,subject,source_channel,source_text,kind,status,plan,internal_notes,revision,created_at,updated_at) VALUES ('r1','c1','Menu su misura','email','Locale: Enoteca Foto Test','nuovo','in_revisione',?,'',1,'2026-10-04','2026-10-04')").bind(plan).run();
  await db.prepare("INSERT INTO drafts (id,request_id,slug,menu_json,status,revision,created_at,updated_at) VALUES ('d1','r1','enoteca-foto-test',?,'revisione',3,'2026-10-04','2026-10-04')").bind(JSON.stringify(MENU())).run();
  await db.prepare("INSERT INTO materials (id,request_id,r2_key,filename,mime,size,source,processing_status,created_at) VALUES ('m1','r1','private/mail/x/1','ribolla.jpg','image/jpeg',8,'email','da_trascrivere','2026-10-04')").bind().run();
  return db;
}

describe('Foto per il menu · flusso nella Control Room', () => {
  it('Premium: Jarvis riconosce la bottiglia (una lettura), propone il vino, Riccardo conferma e la foto diventa pubblica', async () => {
    const db = await setup();
    try {
      const store = new Map([['private/mail/x/1', JPEG]]);
      const calls = [];
      const ai = { run: async (model) => { calls.push(model); return { response: '{"tipo":"bottiglia","descrizione":"bottiglia di Ribolla Gialla","etichetta":{"nome":"Ribolla Gialla","denominazione":"Collio","annata":"2024","cantina":"Cantina Prova"}}' }; } };
      const env = { BUCKET: bucket(store), AI: ai };
      const read = await act(db, 'readMaterial', { materialId: 'm1' }, env);
      assert.equal(read.status, 200, JSON.stringify(read.body));
      assert.equal(read.body.result.media, true);
      assert.equal(calls.length, 1, 'niente lettura doppia per una bottiglia');
      assert.equal((await db.prepare("SELECT processing_status AS s FROM materials WHERE id='m1'").bind().first()).s, 'foto_per_il_menu');
      const media = read.body.state.media.find((m) => m.materialId === 'm1');
      assert.equal(media.proposal.target, 'voce:1:0');
      assert.match(media.proposal.label, /Ribolla Gialla Collio 2024/);
      // Prima della conferma la foto non è pubblica né nel menu.
      const tooEarly = await act(db, 'mediaPlace', { mediaId: media.id, revision: 3, target: 'voce:1:0' }, env);
      assert.equal(tooEarly.status, 409);
      // Upload della copia ridotta (dal telefono) e conferma.
      const up = await onRequest({ request: new Request(`${base}media/${media.id}`, { method: 'POST', headers: { ...credentials, Origin: 'https://renmenu.pages.dev', 'Content-Type': 'image/jpeg', 'Content-Length': String(JPEG.length) }, body: JPEG }), env: testEnv(db, env), params: { route: ['media', media.id] } });
      const upBody = await up.json();
      assert.equal(up.status, 200, JSON.stringify(upBody));
      assert.match(upBody.result.publicUrl, /^https:\/\/renmenu\.pages\.dev\/jarvis-hook\/media\/[0-9a-f]{64}\.jpg$/);
      const file = upBody.result.publicUrl.split('/').pop();
      const pub = (name) => publicHook({ request: new Request(`https://renmenu.pages.dev/jarvis-hook/media/${name}`), env: { DB: db, BUCKET: bucket(store) }, params: {} });
      assert.equal((await pub(file)).status, 404, 'non confermata: non pubblica');
      const stale = await act(db, 'mediaPlace', { mediaId: media.id, revision: 2, target: 'voce:1:0' }, env);
      assert.equal(stale.status, 409, 'revisione vecchia');
      const placed = await act(db, 'mediaPlace', { mediaId: media.id, revision: 3, target: 'voce:1:0', withLabel: true }, env);
      assert.equal(placed.status, 200, JSON.stringify(placed.body));
      const draft = await db.prepare("SELECT * FROM drafts WHERE id='d1'").bind().first();
      const voce = JSON.parse(draft.menu_json).sezioni[1].voci[0];
      assert.equal(draft.revision, 4);
      assert.equal(voce.foto, upBody.result.publicUrl);
      assert.deepEqual(voce.scheda, { cantina: 'Cantina Prova', annata: '2024', territorio: 'Collio' });
      assert.equal(voce.prezzi[1].prezzo, '28,00', 'i prezzi non si toccano');
      const served = await pub(file);
      assert.equal(served.status, 200);
      assert.equal(served.headers.get('content-type'), 'image/jpeg');
      assert.equal((await pub('..%2Fprivate.jpg')).status, 404);
      assert.equal((await pub(file.replace('.jpg', '.png'))).status, 404, 'estensione diversa: non trovata');
      // Sposta su un altro vino, poi togli: torna da sistemare e non è più pubblica.
      const moved = await act(db, 'mediaPlace', { mediaId: media.id, revision: 4, target: 'voce:1:1' }, env);
      assert.equal(moved.status, 200, JSON.stringify(moved.body));
      const menu2 = JSON.parse((await db.prepare("SELECT menu_json FROM drafts WHERE id='d1'").bind().first()).menu_json);
      assert.equal(menu2.sezioni[1].voci[0].foto, undefined);
      assert.equal(menu2.sezioni[1].voci[1].foto, upBody.result.publicUrl);
      const removed = await act(db, 'mediaRemove', { mediaId: media.id, revision: 5 }, env);
      assert.equal(removed.status, 200, JSON.stringify(removed.body));
      assert.equal(JSON.parse((await db.prepare("SELECT menu_json FROM drafts WHERE id='d1'").bind().first()).menu_json).sezioni[1].voci[1].foto, undefined);
      assert.equal((await pub(file)).status, 404);
      const audits = await db.prepare("SELECT action FROM audit_events WHERE request_id='r1' ORDER BY created_at").bind().all();
      assert.ok(audits.results.some((a) => a.action === 'media.place'));
    } finally { db.close(); }
  });

  it('Standard: nessun riconoscimento in più, la foto si legge come pagina di menu come prima', async () => {
    const db = await setup('standard');
    try {
      const calls = [];
      const ai = { run: async (model) => { calls.push(model); return { response: '# Antipasti\nFrico con polenta — 12' }; } };
      const read = await act(db, 'readMaterial', { materialId: 'm1' }, { BUCKET: bucket(new Map([['private/mail/x/1', JPEG]])), AI: ai });
      assert.equal(read.status, 200, JSON.stringify(read.body));
      assert.equal(read.body.result.media, undefined);
      assert.equal(calls.length, 2, 'solo la lettura doppia di sempre');
    } finally { db.close(); }
  });

  it('Premium: pagina di menu o risposta incomprensibile → lettura doppia di sempre', async () => {
    for (const answer of ['{"tipo":"menu","descrizione":"lista di vini"}', 'boh']) {
      const db = await setup();
      try {
        const calls = [];
        const ai = { run: async (model, payload) => { calls.push(model); return { response: payload.max_tokens === 400 ? answer : '# Antipasti\nFrico con polenta — 12' }; } };
        const read = await act(db, 'readMaterial', { materialId: 'm1' }, { BUCKET: bucket(new Map([['private/mail/x/1', JPEG]])), AI: ai });
        assert.equal(read.status, 200, JSON.stringify(read.body));
        assert.equal(read.body.result.media, undefined);
        assert.equal(calls.length, 3, answer);
        assert.equal((await db.prepare("SELECT processing_status AS s FROM materials WHERE id='m1'").bind().first()).s, 'letto_da_jarvis');
      } finally { db.close(); }
    }
  });
});

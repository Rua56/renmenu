import test from 'node:test';
import assert from 'node:assert/strict';
import { extractVenueInfo, applyVenueInfo } from '../cloudflare/functions/_lib/venue-info.js';
import { labelFromFilename, labelPhotoSections } from '../cloudflare/functions/_lib/photo-sections.js';
import { unforwardSubject } from '../cloudflare/functions/_lib/mail-import.js';
import { premiumErrors } from '../cloudflare/functions/_lib/premium.js';

const val = (text) => Object.fromEntries(Object.entries(extractVenueInfo(text).found).map(([k, v]) => [k, v.doubt && !v.value ? `?${v.doubt}` : v.value]));
const BACARO = `Locale: Bacaro Al Collio
Indirizzo: Via Carducci 8, 34170 Gorizia
Telefono: 0481 539 270
WhatsApp per le prenotazioni: +39 320 555 0142
Recensioni Google: https://g.page/r/bacaro-al-collio-prova/review
Coperto: non c'è coperto`;

test('email Premium: WhatsApp e recensioni non si scontrano col telefono', () => {
  const found = val(BACARO);
  assert.equal(found.telefono, '0481 539 270');
  assert.equal(found.whatsapp, '+39 320 555 0142');
  assert.equal(found.recensioni, 'https://g.page/r/bacaro-al-collio-prova/review');
  assert.match(found.coperto, /^\?.*negativa/);
});

test('Premium: WhatsApp e recensioni vanno nei pulsanti del menu', () => {
  const out = applyVenueInfo({ nome: 'Bacaro', premium: { direzione: 'bistrot' } }, extractVenueInfo(BACARO));
  assert.equal(out.menu.telefono, '0481 539 270');
  assert.equal(out.menu.premium.whatsapp, '+39 320 555 0142');
  assert.equal(out.menu.premium.recensioni, 'https://g.page/r/bacaro-al-collio-prova/review');
  assert.ok(out.provenance.some((p) => p.path === 'premium.whatsapp'));
  assert.deepEqual(premiumErrors(out.menu.premium), []);
});

test('Standard: niente pulsanti Premium; WhatsApp solo come telefono se non ce n’è un altro', () => {
  const out = applyVenueInfo({ nome: 'X' }, extractVenueInfo(BACARO));
  assert.equal(out.menu.telefono, '0481 539 270');
  assert.equal(out.menu.premium, undefined);
  assert.ok(out.warnings.some((w) => /solo nel menu Premium/.test(w)));
  const only = applyVenueInfo({ nome: 'X' }, extractVenueInfo('WhatsApp: 333 123 4567'));
  assert.equal(only.menu.telefono, '333 123 4567');
});

test('«Telefono e WhatsApp: …» vale per tutti e due', () => {
  const found = val('Telefono e WhatsApp: 333 123 4567');
  assert.equal(found.telefono, '333 123 4567');
  assert.equal(found.whatsapp, '333 123 4567');
});

test('foto di un menu a parte: sezioni sue e formula in testa', () => {
  const text = '# Primi\nMinestra di orzo e fagioli — 7,00\n# Dolci\nStrudel di mele — 5,00\nMenu completo (primo, secondo, contorno, acqua e caffè) — 16,00';
  const out = labelPhotoSections(text, 'menu-del-pranzo.jpg');
  assert.equal(out.label, 'Menu del pranzo');
  assert.deepEqual(out.text.split('\n'), ['# Menu del pranzo', 'Menu completo (primo, secondo, contorno, acqua e caffè) — 16,00',
    '# Menu del pranzo · Primi', 'Minestra di orzo e fagioli — 7,00', '# Menu del pranzo · Dolci', 'Strudel di mele — 5,00']);
  // Nome generico o seconda pagina della carta: la foto resta com'è.
  for (const name of ['IMG_2041.jpg', 'menu.jpg', 'carta-dei-vini.jpg', 'WhatsApp Image 2026-10-16.jpeg']) assert.equal(labelPhotoSections(text, name).text, text);
  assert.equal(labelFromFilename('menu_bambini.png'), 'Menu bambini');
});

test('oggetto scritto con «Oggetto:» davanti', () => {
  assert.equal(unforwardSubject('Oggetto: Richiesta menu Premium'), 'Richiesta menu Premium');
  assert.equal(unforwardSubject('Re: Oggetto: Menu'), 'Menu');
});

// ——— Bozza Premium fatta a mano: lingue e schede le completa comunque Jarvis ———
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { onRequest, missions } from '../cloudflare/functions/control-room/api/[[route]].js';

const domain = 'https://team-prove-email.cloudflareaccess.com';
const accessEnv = { TEAM_DOMAIN: domain, POLICY_AUD: 'prove-email-owner', OWNER_EMAIL: 'renmenu1569@gmail.com' };
const keyPair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...await crypto.subtle.exportKey('jwk', keyPair.publicKey), kid: 'prove-email-key', use: 'sig', alg: 'RS256' };
const enc = (data) => Buffer.from(JSON.stringify(data)).toString('base64url');
const jwtHead = enc({ alg: 'RS256', kid: jwk.kid });
const jwtBody = enc({ iss: domain, aud: [accessEnv.POLICY_AUD], email: accessEnv.OWNER_EMAIL, type: 'app', exp: Math.floor(Date.now() / 1000) + 3600 });
const jwtSig = Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keyPair.privateKey, new TextEncoder().encode(`${jwtHead}.${jwtBody}`))).toString('base64url');
const jwt = `${jwtHead}.${jwtBody}.${jwtSig}`;
function fullDb() {
  const sqlite = new DatabaseSync(':memory:');
  const dir = new URL('../cloudflare/migrations/', import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(file, dir), 'utf8'));
  return {
    prepare(sql) { return { bind(...params) { const s = sqlite.prepare(sql); return { first: () => s.get(...params) || null, all: () => ({ results: s.all(...params) }), run: () => ({ meta: { changes: s.run(...params).changes } }) }; } }; },
    async batch(statements) { sqlite.exec('BEGIN TRANSACTION'); try { const r = statements.map((s) => s.run()); sqlite.exec('COMMIT'); return r; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } }
  };
}
async function act(db, type, payload) {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, options) => (String(url) === `${domain}/cdn-cgi/access/certs` ? Response.json({ keys: [jwk] }) : previous(url, options));
  try {
    const request = new Request('https://renmenu.pages.dev/control-room/api/actions', { method: 'POST', headers: { 'Cf-Access-Jwt-Assertion': jwt, Origin: 'https://renmenu.pages.dev', 'Content-Type': 'application/json' }, body: JSON.stringify({ type, payload }) });
    const response = await onRequest({ request, env: { DB: db, ...accessEnv }, params: { route: ['actions'] } });
    return { status: response.status, body: await response.json() };
  } finally { globalThis.fetch = previous; }
}

test('bozza Premium generata a mano: lingue e schede in coda per Jarvis, solo avviso alla fine', async () => {
  const db = fullDb();
  const client = await act(db, 'createClient', { name: 'Bacaro Al Collio', phone: '+390000000011', plan: 'premium' });
  const request = await act(db, 'createRequest', { clientId: client.body.result.id, subject: 'Premium', sourceChannel: 'manuale', category: 'nuovo_premium',
    sourceText: `Vorremmo il Premium, in italiano, inglese, tedesco e sloveno.\n${BACARO}\n\nCICCHETTI\nCrostino baccalà - 3,50 €\nFrico con polenta - 10,00 €` });
  const made = await act(db, 'generateDraft', { requestId: request.body.result.id });
  assert.equal(made.status, 200, JSON.stringify(made.body.error));
  const draft = made.body.state.drafts[0];
  const queued = JSON.parse(await missions.setting(db, 'auto_prep'))[draft.id];
  assert.deepEqual(queued.steps, ['lingue', 'schede', 'pronta']);
  assert.equal(queued.notifyOnly, true);
  const menu = draft.menu || JSON.parse(draft.menuJson);
  assert.equal(menu.premium.whatsapp, '+39 320 555 0142');
  assert.equal(menu.telefono, '0481 539 270');
});

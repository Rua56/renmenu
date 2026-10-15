import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { autoPrepareTick, missions } from '../cloudflare/functions/control-room/api/[[route]].js';
import { blanchToMenu, compileBlanch, isBlanchBottleSection } from '../cloudflare/functions/_lib/blanch.js';
import { menuSlots, proposeTargets } from '../cloudflare/functions/_lib/media.js';
import { winesWithoutPhoto } from '../cloudflare/functions/_lib/bottle-search.js';
import { previewUrl } from '../cloudflare/functions/_lib/approvals.js';
import { PREP_KEY, enrollPrep, parsePrep } from '../cloudflare/functions/_lib/autoprep.js';

// Foto delle bottiglie sulla carta dei vini di Trattoria Blanch (menu nel formato proprio, non Premium).
const dataFile = (name) => readFileSync(new URL(`../../blanch/data/${name}`, import.meta.url), 'utf8');
const blanch = () => blanchToMenu(compileBlanch(dataFile('food.json'), dataFile('wines.tsv')));

function database() {
  const sqlite = new DatabaseSync(':memory:');
  const dir = new URL('../cloudflare/migrations/', import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(file, dir), 'utf8'));
  return {
    raw: sqlite,
    prepare(sql) {
      return { bind(...params) {
        const statement = sqlite.prepare(sql);
        return { first: () => statement.get(...params) || null, all: () => ({ results: statement.all(...params) }), run: () => ({ meta: { changes: statement.run(...params).changes } }) };
      } };
    },
    async batch(statements) {
      sqlite.exec('BEGIN TRANSACTION');
      try { const results = statements.map((s) => s.run()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    }
  };
}

test('i vini con lo stesso nome (12 «Friulano») restano distinti: nome · cantina', () => {
  const slots = menuSlots(blanch()).filter((s) => s.wine);
  const friulani = slots.filter((s) => s.name === 'Friulano');
  assert.equal(friulani.length, 12);
  assert.equal(new Set(friulani.map((s) => s.key)).size, 12);
  assert.ok(friulani.every((s) => s.key.startsWith('Friulano · ')));
  // Solo le bottiglie: i vini della casa al calice (tra le bevande) non hanno foto nel formato Blanch.
  assert.equal(winesWithoutPhoto(blanch(), [], isBlanchBottleSection).length, 74);
  // Un Friulano già cercato non salta gli altri undici.
  assert.equal(winesWithoutPhoto(blanch(), [friulani[0].key], isBlanchBottleSection).length, 73);
});

test('la foto trovata per un vino preciso va su quel vino, non sul primo omonimo', () => {
  const menu = blanch();
  const target = menuSlots(menu).filter((s) => s.name === 'Friulano')[5];
  const proposals = proposeTargets(menu, [{ id: 'm1', kind: 'bottiglia', status: 'proposta', label: { nome: 'Friulano' }, description: 'bottiglia di Friulano', filename: 'x.jpg', forWine: target.key }]);
  assert.equal(proposals.get('m1').target, target.target);
});

test('l’anteprima di una bozza di Blanch apre la pagina vera di Blanch, con la bozza nell’indirizzo', () => {
  const menu = blanch();
  menu.sezioni.find((s) => s.nome.it === 'Vini rossi').voci[0].foto = `https://renmenu-jarvis-stage.pages.dev/jarvis-hook/media/${'d'.repeat(64)}.webp`;
  const url = previewUrl(menu, 'it');
  assert.match(url, /^https:\/\/renmenu\.com\/blanch\/\?lang=it#bozza=/);
  const data = JSON.parse(Buffer.from(url.split('#bozza=')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  assert.equal(data.wine[1].items[0].photo, menu.sezioni.find((s) => s.nome.it === 'Vini rossi').voci[0].foto);
  // Gli altri menu restano sul visore comune.
  assert.match(previewUrl({ id: 'al-bakaro', nome: 'Al Bakaro', sezioni: [] }), /^https:\/\/renmenu\.com\/menu\/\?lang=it#data=/);
});

test('Jarvis: «aggiungi le foto delle bottiglie a Trattoria Blanch» mette in coda la ricerca sulla bozza aperta', async () => {
  const db = database();
  const { raw } = db;
  raw.prepare("INSERT INTO clients (id,name,plan,menu_id,menu_url,internal_notes,revision,created_at,updated_at) VALUES ('cb','Trattoria Blanch','premium','trattoria-blanch','https://renmenu.pages.dev/blanch/','',1,'2026-10-05','2026-10-05')").run();
  raw.prepare("INSERT INTO requests (id,client_id,subject,source_channel,source_text,kind,status,plan,category,internal_notes,revision,created_at,updated_at) VALUES ('rb','cb','Richiesta a voce · Trattoria Blanch','telegram','x','aggiornamento','in_revisione','premium','vini_cocktail','',1,'2026-10-05','2026-10-05')").run();
  raw.prepare("INSERT INTO drafts (id,request_id,slug,menu_json,status,created_at,updated_at) VALUES ('db','rb','trattoria-blanch',?,'revisione','2026-10-05','2026-10-05')").run(JSON.stringify(blanch()));
  await db.prepare("INSERT INTO jarvis_settings (key,value,updated_at) VALUES ('gemini_api_key','gem-test','x'),('gemini_models','[\"gemini-2.5-flash\"]','x')").bind().run();
  await missions.putSetting(db, 'telegram_chat_id', '42');
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ href: String(url), body: typeof options.body === 'string' ? JSON.parse(options.body) : options.body });
    return Response.json({ ok: true, result: { message_id: calls.length } });
  };
  try {
    await missions.telegramUpdate(db, { DB: db, TELEGRAM_BOT_TOKEN: '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      { message: { chat: { id: 42, type: 'private' }, text: 'Aggiungi le foto delle bottiglie della carta dei vini di Trattoria Blanch' } });
  } finally { globalThis.fetch = previous; }
  const text = calls.filter((c) => c.href.endsWith('/sendMessage')).map((c) => c.body.text).join('\n');
  assert.match(text, /Cerco le foto delle bottiglie dei 74 vini di «Trattoria Blanch»/);
  const entry = parsePrep(await missions.setting(db, PREP_KEY)).db;
  assert.deepEqual(entry.steps, ['bottiglie', 'foto', 'pronta']);
  assert.equal(entry.notifyOnly, true);
  assert.ok(entry.maxRounds >= 26);
});

test('Jarvis: senza bozza aperta risponde subito e lascia la bozza al giro dell’orologio (Telegram non aspetta)', async () => {
  const db = database();
  db.raw.prepare("INSERT INTO clients (id,name,plan,menu_id,menu_url,internal_notes,revision,created_at,updated_at) VALUES ('cb','Trattoria Blanch','premium','trattoria-blanch','https://renmenu.pages.dev/blanch/','',1,'2026-10-05','2026-10-05')").run();
  await db.prepare("INSERT INTO jarvis_settings (key,value,updated_at) VALUES ('gemini_api_key','gem-test','x'),('gemini_models','[\"gemini-2.5-flash\"]','x')").bind().run();
  await missions.putSetting(db, 'telegram_chat_id', '42');
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ href: String(url), body: typeof options.body === 'string' ? JSON.parse(options.body) : options.body });
    return Response.json({ ok: true, result: { message_id: calls.length } });
  };
  const say = (text) => missions.telegramUpdate(db, { DB: db, TELEGRAM_BOT_TOKEN: '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, { message: { chat: { id: 42, type: 'private' }, text } });
  try {
    await say('Aggiungi le foto delle bottiglie della carta dei vini di Trattoria Blanch');
    await say('Aggiungi le foto delle bottiglie della carta dei vini di Trattoria Blanch');
  } finally { globalThis.fetch = previous; }
  const text = calls.filter((c) => c.href.endsWith('/sendMessage')).map((c) => c.body.text).join('\n');
  assert.match(text, /Preparo la bozza di «Trattoria Blanch» partendo dal menu online/);
  // Il messaggio ripetuto non apre una seconda pratica.
  const opened = db.raw.prepare("SELECT id FROM requests WHERE subject LIKE 'Foto delle bottiglie%'").all();
  assert.equal(opened.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(await missions.setting(db, 'bottle_queue'))), [opened[0].id]);
});

test('una nuova ricerca toglie le bottiglie di un\'altra cantina e ricerca i vini non trovati', async () => {
  const db = database();
  const { raw } = db;
  const menu = blanch();
  const slot = menuSlots(menu).filter((s) => s.name === 'Friulano')[5];
  const other = menuSlots(menu).filter((s) => s.name === 'Friulano')[2];
  const [si, vi] = slot.target.split(':').slice(1).map(Number);
  const [oi, ovi] = other.target.split(':').slice(1).map(Number);
  const wrongUrl = `https://renmenu-jarvis-stage.pages.dev/jarvis-hook/media/${'a'.repeat(64)}.webp`;
  const goodUrl = `https://renmenu-jarvis-stage.pages.dev/jarvis-hook/media/${'b'.repeat(64)}.webp`;
  menu.sezioni[si].voci[vi].foto = wrongUrl;
  menu.sezioni[oi].voci[ovi].foto = goodUrl;
  const producer = (s) => s.key.split(' · ')[1];
  raw.prepare("INSERT INTO clients (id,name,plan,menu_id,menu_url,internal_notes,revision,created_at,updated_at) VALUES ('cb','Trattoria Blanch','premium','trattoria-blanch','https://renmenu.pages.dev/blanch/','',1,'2026-10-05','2026-10-05')").run();
  raw.prepare("INSERT INTO requests (id,client_id,subject,source_channel,source_text,kind,status,plan,category,internal_notes,revision,created_at,updated_at) VALUES ('rb','cb','Foto delle bottiglie · Trattoria Blanch','telegram','x','aggiornamento','in_revisione','premium','vini_cocktail','',1,'2026-10-05','2026-10-05')").run();
  raw.prepare("INSERT INTO drafts (id,request_id,slug,menu_json,status,creative_json,created_at,updated_at) VALUES ('db','rb','trattoria-blanch',?,'revisione',?,'2026-10-05','2026-10-05')")
    .run(JSON.stringify(menu), JSON.stringify({ bottiglie: { cercate: [{ name: 'Malvasia', found: false, reason: 'nessuna pagina trovata' }] } }));
  const add = (id, s, url, cantina, page) => {
    raw.prepare("INSERT INTO materials (id,request_id,r2_key,filename,mime,size,source,processing_status,text_preview,created_at) VALUES (?,?,?,?,?,?,?,'foto_per_il_menu',?,'2026-10-05')")
      .run(`x${id}`, 'rb', `private/${id}`, 'Bottiglia', 'image/webp', 9000, 'sito_cantina', `Fonte: ${page} · immagine: ${page}/foto.jpg · vino: ${s.key}`);
    raw.prepare("INSERT INTO media_items (id,request_id,material_id,kind,description,label_json,status,target,target_name,public_url,public_sha,created_at,updated_at) VALUES (?,?,?,'bottiglia','bottiglia di vino bianco',?,'confermata',?,?,?,?,'2026-10-05','2026-10-05')")
      .run(id, 'rb', `x${id}`, JSON.stringify({ nome: 'Friulano', cantina }), s.target, 'Friulano', url, url.split('/').pop().split('.')[0]);
  };
  add('mwrong', slot, wrongUrl, 'Livio Felluga', 'https://www.liviofelluga.it/vini/friulano');
  add('mgood', other, goodUrl, '', `https://www.${producer(other).toLowerCase().replace(/[^a-z]/g, '')}.it/friulano`);
  await enrollPrep({ get: missions.setting, put: missions.putSetting }, db, { draftId: 'db', requestId: 'rb', plan: null, steps: ['bottiglie'], maxRounds: 30, notifyOnly: true }, '2026-10-05T00:00:00.000Z');
  await autoPrepareTick(db, { DB: db, BUCKET: { put: async () => null, get: async () => null }, AI: { run: async () => ({}) } }, { budgetMs: 5_000 });
  assert.equal(raw.prepare("SELECT status FROM media_items WHERE id='mwrong'").get().status, 'scartata');
  assert.equal(raw.prepare("SELECT status FROM media_items WHERE id='mgood'").get().status, 'confermata');
  const after = JSON.parse(raw.prepare("SELECT menu_json, creative_json FROM drafts WHERE id='db'").get().menu_json);
  assert.equal(after.sezioni[si].voci[vi].foto, undefined);
  assert.equal(after.sezioni[oi].voci[ovi].foto, goodUrl);
  assert.deepEqual(JSON.parse(raw.prepare("SELECT creative_json FROM drafts WHERE id='db'").get().creative_json).bottiglie.cercate, []);
  const entry = parsePrep(await missions.setting(db, PREP_KEY)).db;
  assert.equal(entry.rechecked, true);
  assert.equal(entry.wrong, 1);
});

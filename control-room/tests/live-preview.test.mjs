import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { enrollIdleDrafts, jarvisAsk, jarvisReady, missions } from '../cloudflare/functions/control-room/api/[[route]].js';
import { menuDiff, previewCard } from '../cloudflare/functions/_lib/menu-diff.js';

const TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
function database() {
  const sqlite = new DatabaseSync(':memory:');
  const dir = new URL('../cloudflare/migrations/', import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(file, dir), 'utf8'));
  return {
    sqlite,
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
async function quiet(fn) {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ ok: true, result: {} });
  try { return await fn(); } finally { globalThis.fetch = previous; }
}
const MENU = { nome: 'Osteria Al Tralcio', lingue: ['it'], sezioni: [
  { nome: 'Secondi', voci: [{ nome: 'Frico con polenta', prezzo: '12' }, { nome: 'Cevapcici', prezzo: '13' }, { nome: 'Gulasch', prezzo: '14' }] },
  { nome: 'Dolci', voci: [{ nome: 'Strudel', prezzo: '5' }] }
] };
const clone = (value) => JSON.parse(JSON.stringify(value));
function seed(db, { plan = 'standard', updated = new Date().toISOString(), menu = MENU } = {}) {
  db.sqlite.prepare("INSERT INTO clients (id,name,plan,internal_notes,revision,created_at,updated_at) VALUES ('c1','Osteria Al Tralcio',?,'',1,'2026-10-05','2026-10-05')").run(plan);
  db.sqlite.prepare("INSERT INTO requests (id,client_id,subject,source_channel,source_text,kind,status,plan,category,internal_notes,revision,created_at,updated_at) VALUES ('r1','c1','Nuovo menu · Al Tralcio','telegram','x','nuovo','in_revisione',?,'nuovo_standard','',1,'2026-10-05','2026-10-05')").run(plan);
  db.sqlite.prepare("INSERT INTO drafts (id,request_id,slug,menu_json,status,created_at,updated_at) VALUES ('d1','r1','al-tralcio',?,'revisione',?,?)").run(JSON.stringify(menu), updated, updated);
}

test('Anteprima dal vivo: prezzo cambiato, voce nuova, voce tolta e rinominata', () => {
  const after = clone(MENU);
  after.sezioni[0].voci[0].prezzo = '14';
  after.sezioni[0].voci[1].nome = 'Cevapcici della casa';
  after.sezioni[0].voci.splice(2, 1);
  after.sezioni[1].voci.push({ nome: 'Gubana', prezzo: '6' });
  const changes = menuDiff(MENU, after);
  assert.deepEqual(changes.map((c) => c.mark).sort(), ['nome', 'nuovo', 'prezzo', 'tolto']);
  const card = previewCard({ menu: after, before: MENU, title: 'Al Tralcio', draftId: 'd1', requestId: 'r1' });
  assert.equal(card.mode, 'modifica');
  assert.equal(card.total, 4);
  assert.ok(card.lines.includes('Frico con polenta: € 12 → € 14'));
  const frico = card.sections[0].items.find((i) => i.n === 'Frico con polenta');
  assert.equal(frico.mark, 'prezzo');
  assert.equal(frico.was, '€ 12');
  assert.ok(card.sections[0].items.some((i) => i.n === 'Gulasch' && i.mark === 'tolto'));
  assert.ok(card.sections[1].items.some((i) => i.n === 'Gubana' && i.mark === 'nuovo'));
});

test('Anteprima dal vivo: senza modifiche mostra le sezioni così come sono; sezioni lunghe si accorciano', () => {
  const card = previewCard({ menu: MENU, title: 'Al Tralcio' });
  assert.equal(card.mode, 'bozza');
  assert.equal(card.total, 0);
  assert.equal(card.sections.length, 2);
  const long = { nome: 'Lungo', sezioni: [{ nome: 'Pizze', voci: Array.from({ length: 40 }, (_, i) => ({ nome: `Pizza ${i}`, prezzo: String(5 + i) })) }] };
  const changed = clone(long); changed.sezioni[0].voci[30].prezzo = '99';
  const short = previewCard({ menu: changed, before: long });
  assert.ok(short.sections[0].items.length <= 14);
  assert.ok(short.sections[0].items.some((i) => i.n === 'Pizza 30' && i.mark === 'prezzo'));
  assert.ok(short.sections[0].hidden > 0);
});

test('«Mostrami la bozza» nella Control Room porta il menu disegnato dentro la conversazione', async () => {
  const db = database();
  seed(db);
  await missions.putSetting(db, 'telegram_chat_id', '42');
  await missions.putSetting(db, 'cr_buttons', JSON.stringify(['peek:d1']));
  const out = await quiet(() => jarvisAsk({ DB: db, TELEGRAM_BOT_TOKEN: TOKEN }, { press: 'peek:d1' }));
  const withCard = out.messages.find((m) => m.card);
  assert.ok(withCard, 'una risposta porta la cartolina');
  assert.equal(withCard.card.draftId, 'd1');
  assert.equal(withCard.card.requestId, 'r1');
  assert.equal(withCard.card.title, 'Osteria Al Tralcio');
  assert.equal(withCard.card.sections[0].items[0].p, '€ 12');
});

test('Risposta a voce a una decisione: «no» vale come il tocco, «sì» non pubblica mai', async () => {
  const db = database();
  await missions.putSetting(db, 'telegram_chat_id', '42');
  const env = { DB: db, TELEGRAM_BOT_TOKEN: TOKEN };
  await quiet(async () => {
    const menu = await jarvisAsk(env, { text: '/chiamami avvisi' });
    const buttons = menu.messages.flatMap((m) => m.buttons);
    const out = await jarvisAsk(env, { text: 'no', choose: buttons });
    assert.equal(out.pressed, 'tel:no');
    assert.equal(await missions.setting(db, 'phone_alerts'), 'no');
    await missions.putSetting(db, 'cr_buttons', JSON.stringify(['pub:m1', 'no:m1']));
    const yes = await jarvisAsk(env, { text: 'sì', choose: [['SÌ, pubblica', 'pub:m1'], ['Non ancora', 'no:m1']] });
    assert.equal(yes.messages[0].picked, 'tap');
    assert.match(yes.messages[0].text, /lo confermi tu toccando/);
    // Pulsanti mai offerti non valgono nemmeno a voce.
    const fake = await jarvisAsk(env, { text: 'sì', choose: [['Elimina', 'dela:x']] });
    assert.equal(fake.pressed, undefined);
  });
});

test('Pronto per te: bozza da affidare e risposta già scritta, con pulsanti validi nella conversazione', async () => {
  const db = database();
  seed(db);
  await missions.putSetting(db, 'telegram_chat_id', '42');
  await missions.putSetting(db, 'reply_r1', JSON.stringify({ id: 'r1', name: 'Osteria Al Tralcio', channel: 'email', to: 'tralcio@example.com', message: 'Quando è pronto?', text: 'Buongiorno, entro oggi.', at: new Date().toISOString() }));
  const { items } = await jarvisReady({ DB: db });
  const kinds = items.map((i) => i.kind);
  assert.ok(kinds.includes('bozza'));
  assert.ok(kinds.includes('risposta'));
  const reply = items.find((i) => i.kind === 'risposta');
  assert.deepEqual(reply.buttons.map(([label]) => label), ['Manda', 'Cambia', 'Non rispondere']);
  assert.ok(reply.say.length > 10);
  const offered = JSON.parse(await missions.setting(db, 'cr_buttons'));
  assert.ok(offered.includes('rep:send:r1'));
  assert.ok(offered.includes('affq:d1'));
});

test('Jarvis prepara da solo le bozze ferme da più di 3 ore, una volta sola', async () => {
  const db = database();
  seed(db, { updated: new Date(Date.now() - 4 * 3600_000).toISOString() });
  assert.equal(await enrollIdleDrafts(db), 'd1');
  const queued = JSON.parse(await missions.setting(db, 'auto_prep'));
  assert.ok(queued.d1);
  assert.equal(queued.d1.plan, 'standard');
  await missions.putSetting(db, 'auto_prep', '{}');
  assert.equal(await enrollIdleDrafts(db), null, 'non la riprende una seconda volta');
});

test('Bozze recenti, senza piano o già affidate non partono da sole', async () => {
  const fresh = database();
  seed(fresh);
  assert.equal(await enrollIdleDrafts(fresh), null);
  const undecided = database();
  seed(undecided, { plan: 'da_definire', updated: new Date(Date.now() - 5 * 3600_000).toISOString() });
  assert.equal(await enrollIdleDrafts(undecided), null);
});

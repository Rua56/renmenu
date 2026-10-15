import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { missions } from '../cloudflare/functions/control-room/api/[[route]].js';
import { GUARD_KEY, GUARD_STATE_KEY, dueSlugs, parseGuard, step } from '../cloudflare/functions/_lib/guard.js';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  for (const f of ['0001_initial', '0002_integrations', '0003_ai_free_scope', '0004_request_category', '0005_draft_provenance', '0010_draft_review_notes', '0011_draft_creative', '0006_publication_approvals', '0007_jarvis_missions', '0008_mail_files'])
    sqlite.exec(readFileSync(new URL(`../cloudflare/migrations/${f}.sql`, import.meta.url), 'utf8'));
  return {
    prepare(sql) { return { bind(...params) { const st = sqlite.prepare(sql); return { first: () => st.get(...params) || null, all: () => ({ results: st.all(...params) }), run: () => ({ meta: { changes: st.run(...params).changes } }) }; } }; },
    async batch(statements) { sqlite.exec('BEGIN TRANSACTION'); try { const r = statements.map((s) => s.run()); sqlite.exec('COMMIT'); return r; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } },
    close: () => sqlite.close()
  };
}
const TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const calls = [];
let blanchDown = false;
const fakeFetch = async (url, options = {}) => {
  const href = String(url);
  if (href.startsWith('https://api.telegram.org/')) { calls.push({ method: href.split('/').pop(), body: JSON.parse(options.body || '{}') }); return Response.json({ ok: true, result: { message_id: 1 } }); }
  if (href === 'https://renmenu.com/menus/bakaro.json') return Response.json({ id: 'bakaro', nome: 'Al Bakaro', sezioni: [] });
  if (href.startsWith('https://renmenu.com/menu/?m=bakaro')) return new Response('<html></html>');
  if (href === 'https://renmenu.com/blanch/data/menu.json') return blanchDown ? new Response('no', { status: 404 }) : Response.json({ name: 'Trattoria Blanch', food: [] });
  if (href === 'https://renmenu.com/blanch/') return blanchDown ? new Response('no', { status: 404 }) : new Response('<html></html>');
  return new Response('no', { status: 404 });
};
const say = (db, env, text) => missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text } });
const texts = () => calls.filter((c) => c.method === 'sendMessage').map((c) => c.body.text);

describe('Sorveglianza dei menu online', () => {
  it('capisce i comandi e decide quando avvisare', () => {
    for (const t of ['sorveglianza', '/sorveglianza', 'quali menu sorvegli?']) assert.equal(parseGuard(t)?.kind, 'show', t);
    assert.deepEqual(parseGuard('non sorvegliare Al Tralcio'), { kind: 'off', venue: 'Al Tralcio' });
    assert.deepEqual(parseGuard('Jarvis, sorveglia anche il menu di Calice Storto'), { kind: 'on', venue: 'Calice Storto' });
    for (const t of ['visita Bar Centrale', 'come va la sorveglianza delle visite di domani e poi?', 'agenda']) assert.equal(parseGuard(t), null, t);
    const at = Date.parse('2026-10-15T10:00:00Z');
    const first = step(undefined, ['x'], at);
    assert.equal(first.alert, null, 'un controllo andato male non basta');
    const second = step(first.entry, ['x'], at + 180_000);
    assert.equal(second.alert, 'giu');
    assert.equal(step(second.entry, ['x'], at + 3600_000).alert, null, 'non ripete subito');
    assert.equal(step(second.entry, ['x'], at + 7 * 3600_000).alert, 'ancora', 'ricorda dopo 6 ore');
    assert.equal(step(second.entry, [], at + 3600_000).alert, 'su');
    assert.deepEqual(dueSlugs(['a', 'b', 'c'], { a: { next: new Date(at + 60_000).toISOString() } }, at), ['b', 'c']);
  });
  it('controlla Al Bakaro e Blanch, avvisa se non si aprono e quando tornano online', async () => {
    const db = database();
    const previous = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      calls.length = 0; blanchDown = false;
      await missions.putSetting(db, 'telegram_chat_id', '42');
      const env = { DB: db, TELEGRAM_BOT_TOKEN: TOKEN, OWNER_EMAIL: 'renmenu1569@gmail.com' };
      const at = Date.parse('2026-10-15T10:00:00Z');
      assert.deepEqual((await missions.guardTick(db, env, { at })).map((r) => [r.slug, r.ok]), [['bakaro', true], ['trattoria-blanch', true]]);
      assert.deepEqual(await missions.guardTick(db, env, { at: at + 60_000 }), [], 'il prossimo controllo fra 15 minuti');
      assert.equal(texts().length, 0, 'tutto a posto: Jarvis tace');
      blanchDown = true;
      await missions.guardTick(db, env, { at: at + 16 * 60_000 });
      assert.equal(texts().length, 0, 'al primo errore riprova prima di avvisare');
      const out = await missions.guardTick(db, env, { at: at + 20 * 60_000 });
      assert.deepEqual(out.map((r) => r.alert), ['giu']);
      assert.match(texts().at(-1), /il menu di «Trattoria Blanch» non si apre: il file del menu risponde HTTP 404; la pagina del menu \(quella del QR\) risponde HTTP 404/);
      blanchDown = false;
      await missions.guardTick(db, env, { at: at + 40 * 60_000 });
      assert.match(texts().at(-1), /«Trattoria Blanch» è di nuovo online/);
      calls.length = 0;
      await say(db, env, 'sorveglianza');
      assert.match(texts().at(-1), /Menu che controllo ogni 15 minuti:\n• Al Bakaro: online[^\n]*\n• Trattoria Blanch: online/);
      await say(db, env, 'non sorvegliare Trattoria Blanch');
      assert.match(texts().at(-1), /non controllo più il menu di «Trattoria Blanch»/);
      assert.deepEqual(JSON.parse(await missions.setting(db, GUARD_KEY)), ['bakaro']);
      await missions.guardTick(db, env, { at: at + 80 * 60_000 });
      assert.deepEqual(Object.keys(JSON.parse(await missions.setting(db, GUARD_STATE_KEY))), ['bakaro']);
    } finally { globalThis.fetch = previous; db.close(); }
  });
});

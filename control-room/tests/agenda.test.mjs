import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { missions } from '../cloudflare/functions/control-room/api/[[route]].js';
import { AGENDA_KEY, parseAgenda, reminderDue, splitNames } from '../cloudflare/functions/_lib/agenda.js';

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
const fakeFetch = async (url, options = {}) => {
  const href = String(url);
  if (href.startsWith('https://api.telegram.org/')) { calls.push({ method: href.split('/').pop(), body: JSON.parse(options.body || '{}') }); return Response.json({ ok: true, result: { message_id: 1 } }); }
  return new Response('no', { status: 404 });
};
const say = (db, env, text) => missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text } });
const lastText = () => calls.filter((c) => c.method === 'sendMessage').at(-1)?.body.text || '';
const stored = async (db) => JSON.parse(await missions.setting(db, AGENDA_KEY) || 'null');

describe('Agenda delle visite', () => {
  it('capisce l’agenda dettata, le visite fatte e le domande', () => {
    assert.deepEqual(parseAgenda('Jarvis questa settimana devo visitare 8 locali: Bar Centrale, Pizzeria Università, Ai Tre Soldi Goriziani e la trattoria Blanch'),
      { kind: 'create', names: ['Bar Centrale', 'Pizzeria Università', 'Ai Tre Soldi Goriziani', 'trattoria Blanch'], count: 8 });
    assert.deepEqual(parseAgenda('questa settimana devo visitare otto locali bar Centrale, Pizzeria Università e Al Bakaro').names, ['bar Centrale', 'Pizzeria Università', 'Al Bakaro']);
    assert.deepEqual(parseAgenda('devo visitare 8 locali'), { kind: 'create', names: [], count: 8 });
    assert.deepEqual(parseAgenda('agenda:\n1. Bar X\n2. Osteria Y').names, ['Bar X', 'Osteria Y']);
    assert.deepEqual(splitNames('il Pane e Vino'), ['il Pane e Vino'], 'un nome con «e» resta intero');
    assert.deepEqual(parseAgenda('ho visitato Bar Centrale e Pizzeria Università: interessati al premium'), { kind: 'done', names: ['Bar Centrale', 'Pizzeria Università'], note: 'interessati al premium' });
    assert.deepEqual(parseAgenda('sono stato dal Bakaro').names, ['Bakaro']);
    assert.deepEqual(parseAgenda('ho fatto la visita al bar Centrale').names, ['bar Centrale']);
    for (const t of ['agenda', '/agenda', 'che locali devo ancora visitare?', 'chi mi manca?']) assert.equal(parseAgenda(t)?.kind, 'show', t);
    assert.equal(parseAgenda('cancella l’agenda').kind, 'clear');
    assert.deepEqual(parseAgenda('aggiungi all’agenda Caffè Garibaldi'), { kind: 'add', names: ['Caffè Garibaldi'] });
    for (const t of ['fatto, grazie', 'al Bakaro il frico costa 14', 'com’è la situazione?', 'visita Bar Centrale']) assert.equal(parseAgenda(t), null, t);
  });
  it('promemoria solo dopo un giorno di silenzio, di giorno e una volta al giorno', () => {
    const at = new Date('2026-10-16T10:00:00Z');
    const agenda = { last_contact: '2026-10-15T09:00:00Z', last_reminder: null, items: [{ name: 'Bar X', done_at: null }] };
    assert.equal(reminderDue(agenda, at, 12), true);
    assert.equal(reminderDue(agenda, at, 21), false, 'di sera no');
    assert.equal(reminderDue({ ...agenda, last_contact: '2026-10-15T20:00:00Z' }, at, 12), false, 'meno di un giorno');
    assert.equal(reminderDue({ ...agenda, last_reminder: '2026-10-16T08:00:00Z' }, at, 12), false, 'già ricordato oggi');
    assert.equal(reminderDue({ ...agenda, items: [{ name: 'Bar X', done_at: 'x' }] }, at, 12), false, 'tutti visitati');
  });
  it('su Telegram: prepara l’agenda, segna le visite (anche con «visita …») e ricorda quelli che mancano', async () => {
    const db = database();
    const previous = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      calls.length = 0;
      await missions.putSetting(db, 'telegram_chat_id', '42');
      const env = { DB: db, TELEGRAM_BOT_TOKEN: TOKEN, OWNER_EMAIL: 'renmenu1569@gmail.com' };
      await say(db, env, 'Jarvis, questa settimana devo visitare 3 locali');
      assert.match(lastText(), /^Va bene, 3 locali\. Dimmi i nomi/);
      await say(db, env, 'Bar Centrale, Pizzeria Università, Osteria Codelli');
      assert.match(lastText(), /Agenda pronta, 3 locali da visitare:\n1\. Bar Centrale\n2\. Pizzeria Università\n3\. Osteria Codelli/);
      await say(db, env, 'ho visitato bar centrale: vuole il premium');
      assert.match(lastText(), /Segnato: Bar Centrale ✅\. Ne restano 2: Pizzeria Università, Osteria Codelli\./);
      assert.equal((await stored(db)).items[0].note, 'vuole il premium');
      // «visita …» nel locale: si segna da solo anche nell'agenda.
      await say(db, env, 'visita Pizzeria Università');
      assert.match(lastText(), /L’ho segnato come visitato nell’agenda \(ne resta uno\)/);
      await say(db, env, 'chi mi manca?');
      assert.match(lastText(), /2 su 3 fatte\.\n✅ Bar Centrale · vuole il premium\n✅ Pizzeria Università\n⬜️ Osteria Codelli/);
      // Un giorno di silenzio: il promemoria parte una volta sola.
      const agenda = await stored(db); agenda.last_contact = '2026-01-01T09:00:00Z';
      await missions.putSetting(db, AGENDA_KEY, JSON.stringify(agenda));
      assert.equal(await missions.agendaTick(db, env, { now: new Date('2026-01-02T05:00:00Z') }), null, 'alle 6 del mattino no');
      assert.match(await missions.agendaTick(db, env, { now: new Date('2026-01-02T11:00:00Z') }), /Ti resta da visitare: Osteria Codelli/);
      assert.match(lastText(), /è da ieri che non mi dici niente delle visite/);
      assert.equal(await missions.agendaTick(db, env, { now: new Date('2026-01-02T15:00:00Z') }), null, 'una volta al giorno');
      await say(db, env, 'cancella l’agenda');
      assert.equal(await missions.setting(db, AGENDA_KEY), '');
      assert.match(lastText(), /agenda cancellata/);
    } finally { globalThis.fetch = previous; db.close(); }
  });
});

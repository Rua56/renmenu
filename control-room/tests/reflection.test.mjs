import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { missions } from '../cloudflare/functions/control-room/api/[[route]].js';
import { acceptProposals, askForProposals, decideProposal, proposalsList, REFLECTION_MODEL, reflectionDue, saveProposals, weekOf } from '../cloudflare/functions/_lib/reflection.js';

const NOW = new Date('2026-10-12T06:20:00Z'); // lunedì 8:20 a Roma
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

const good = (title, extra = {}) => ({ tipo: 'operativa', titolo: title, problema: 'Due locali non scrivono da mesi.', evidenza: 'Caffè Bon Bon senza richieste da 100 giorni', proposta: 'Preparo un messaggio per chiedere se il menu è ancora giusto.', rischio: 'Nessuno.', ...extra });

// Finto servizio: Claude, GitHub e Telegram. Registra ogni chiamata.
function fakeServices({ proposals = [good('Ricontatta i locali silenziosi')], claudeStatus = 200, issueStatus = 201 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const href = String(url), body = options.body ? JSON.parse(options.body) : null;
    calls.push({ href, body, headers: options.headers });
    if (href === 'https://api.anthropic.com/v1/messages') {
      if (claudeStatus !== 200) return Response.json({ type: 'error', error: { type: 'overloaded_error' } }, { status: claudeStatus });
      return Response.json({ model: REFLECTION_MODEL, stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify({ proposte: proposals }) }] });
    }
    if (href === 'https://api.github.com/repos/Rua56/renmenu/issues') return Response.json({ html_url: 'https://github.com/Rua56/renmenu/issues/200' }, { status: issueStatus });
    if (href.startsWith('https://api.telegram.org/')) return Response.json({ ok: true, result: { message_id: 1 } });
    if (href.startsWith('https://generativelanguage.googleapis.com/')) return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ proposte: proposals }) }] } }] });
    return Response.json({}, { status: 404 });
  };
  return { calls, fetchImpl, telegram: () => calls.filter((c) => c.href.endsWith('/sendMessage')).map((c) => c.body) };
}

test('riflessione: parte solo il lunedì tra le 8:15 e le 8:29 e la settimana è il lunedì italiano', () => {
  assert.equal(reflectionDue(NOW), true);
  assert.equal(reflectionDue(new Date('2026-10-12T06:10:00Z')), false);
  assert.equal(reflectionDue(new Date('2026-10-13T06:20:00Z')), false);
  assert.equal(weekOf(NOW), '2026-10-12');
  assert.equal(weekOf(new Date('2026-10-18T21:30:00Z')), '2026-10-12'); // domenica 23:30 a Roma: ancora la settimana del 12
  assert.equal(weekOf(new Date('2026-10-18T22:30:00Z')), '2026-10-19');
});

test('riflessione: la richiesta a Claude usa il modello, lo schema e i fallback, senza dati di contatto', async () => {
  const { calls, fetchImpl } = fakeServices();
  const out = await askForProposals({ ANTHROPIC_API_KEY: 'sk-test' }, { settimana: { richieste: { nuove: 2 } } }, { fetchImpl, useClaude: true });
  assert.equal(out.proposals.length, 1);
  const call = calls[0];
  assert.equal(call.headers['x-api-key'], 'sk-test');
  assert.equal(call.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(call.body.model, 'claude-opus-5-5');
  assert.equal(call.body.fallbacks, 'default');
  assert.equal(call.body.output_config.format.type, 'json_schema');
  assert.match(call.body.messages[0].content, /"nuove":2/);
  assert.deepEqual(await askForProposals({}, {}, { fetchImpl, useClaude: true }), { error: 'manca la chiave ANTHROPIC_API_KEY' });
  assert.match((await askForProposals({}, {}, { fetchImpl })).error, /manca la chiave Gemini/);
  const refused = async () => Response.json({ stop_reason: 'refusal', content: [] });
  assert.match((await askForProposals({ ANTHROPIC_API_KEY: 'k' }, {}, { fetchImpl: refused, useClaude: true })).error, /rifiutato/);
});

test('riflessione: scarta proposte senza numeri, doppie, già rifiutate o rimandate da poco', () => {
  const past = [
    { title: 'Già rifiutata per sempre', status: 'rifiutata', created_at: '2026-01-01T00:00:00Z' },
    { title: 'Rimandata da poco', status: 'rimandata', created_at: '2026-10-01T00:00:00Z', decided_at: '2026-10-01T00:00:00Z' },
    { title: 'Rimandata tanto tempo fa', status: 'rimandata', created_at: '2026-08-01T00:00:00Z', decided_at: '2026-08-01T00:00:00Z' }
  ];
  const kept = acceptProposals([
    good('Senza numeri', { evidenza: 'molti locali' }), good('Tipo sbagliato', { tipo: 'pagamenti' }), good('Già rifiutata per sempre'),
    good('Rimandata da poco'), good('Rimandata tanto tempo fa'), good('Una buona'), good('Una buona!'), good('Terza'), good('Quarta')
  ], past, NOW);
  assert.deepEqual(kept.map((p) => p.title), ['Rimandata tanto tempo fa', 'Una buona', 'Terza']);
});

test('riflessione: Fallo su una miglioria al codice apre una issue; Mai non torna più', async () => {
  const db = database();
  const { calls, fetchImpl } = fakeServices();
  const [code, ops] = await saveProposals(db, '2026-10-12', [
    { kind: 'codice', title: 'Leggi meglio calice e bottiglia', problem: 'Molti dubbi.', evidence: '3 dubbi su 5', proposal: 'Migliora vision.js.', risk: '' },
    { kind: 'operativa', title: 'Ricontatta i locali silenziosi', problem: 'Silenzio.', evidence: '2 locali da 100 giorni', proposal: 'Messaggio.', risk: '' }
  ], { now: NOW });
  const yes = await decideProposal(db, { GITHUB_TOKEN: 'gh-test' }, code.id, 'si', { fetchImpl, now: NOW });
  assert.match(yes.text, /issues\/200/);
  const issue = calls.find((c) => c.href.endsWith('/issues'));
  assert.equal(issue.body.title, 'Jarvis propone: Leggi meglio calice e bottiglia');
  assert.deepEqual(issue.body.labels, ['jarvis-proposta']);
  assert.match((await decideProposal(db, {}, code.id, 'mai', { fetchImpl })).text, /già risposto/);
  assert.match((await decideProposal(db, {}, ops.id, 'mai', { fetchImpl, now: NOW })).text, /non te la propongo più/);
  assert.equal(calls.filter((c) => c.href.endsWith('/issues')).length, 1, 'le proposte operative non aprono issue');
  const list = await proposalsList(db, NOW);
  assert.match(list, /Accettate, da fare:\n- Leggi meglio calice e bottiglia .*issues\/200/);
  assert.doesNotMatch(list, /silenziosi/);
});

test('riflessione: senza permesso sulle issue la proposta resta accettata e Jarvis lo dice', async () => {
  const db = database();
  const { fetchImpl } = fakeServices({ issueStatus: 403 });
  const [code] = await saveProposals(db, '2026-10-12', [{ kind: 'codice', title: 'Una miglioria', problem: 'x', evidence: '1 errore', proposal: 'y', risk: '' }], { now: NOW });
  const out = await decideProposal(db, { GITHUB_TOKEN: 'gh-test' }, code.id, 'si', { fetchImpl, now: NOW });
  assert.match(out.text, /il token GitHub non ha il permesso di aprire issue/);
  assert.equal(db.sqlite.prepare('SELECT status FROM jarvis_proposals').get().status, 'accettata');
});

test('riflessione: il lunedì Jarvis manda le proposte con i pulsanti, una volta sola, e registra il tocco', async () => {
  const db = database();
  const services = fakeServices({ proposals: [good('Ricontatta i locali silenziosi'), good('Senza numeri', { evidenza: 'boh' })] });
  const previous = globalThis.fetch;
  globalThis.fetch = services.fetchImpl;
  try {
    await missions.putSetting(db, 'telegram_chat_id', '42');
    await missions.putSetting(db, 'claude_enabled', 'si');
    const env = { DB: db, TELEGRAM_BOT_TOKEN: TOKEN, ANTHROPIC_API_KEY: 'sk-test' };
    const out = await missions.reflect(db, env, { now: NOW });
    assert.equal(out.proposals.length, 1);
    const sent = services.telegram();
    assert.match(sent[0].text, /ho una proposta per migliorare il servizio/);
    assert.match(sent[1].text, /Proposta 1 di 1 · Operativa\n«Ricontatta i locali silenziosi»/);
    const id = out.proposals[0].id;
    assert.ok(JSON.stringify(sent[1].reply_markup).includes(`prop:${id}:si`));
    assert.equal(await missions.reflect(db, env, { now: new Date(NOW.getTime() + 60_000) }), null, 'una sola volta a settimana');
    assert.equal(services.calls.filter((c) => c.href.includes('anthropic')).length, 1);
    await missions.telegramUpdate(db, env, { callback_query: { id: 'q1', data: `prop:${id}:dopo`, message: { chat: { id: 42 }, message_id: 7 } } });
    assert.match(services.telegram().at(-1).text, /la tengo da parte/);
    assert.equal(db.sqlite.prepare('SELECT status FROM jarvis_proposals WHERE id=?').get(id).status, 'rimandata');
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM audit_events WHERE action IN ('jarvis.reflection','jarvis.proposal')").get().n, 2);
  } finally { globalThis.fetch = previous; }
});

test('riflessione: senza chiavi il lunedì tace; /rifletti spiega cosa manca', async () => {
  const db = database();
  const services = fakeServices();
  const previous = globalThis.fetch;
  globalThis.fetch = services.fetchImpl;
  try {
    await missions.putSetting(db, 'telegram_chat_id', '42');
    const env = { DB: db, TELEGRAM_BOT_TOKEN: TOKEN };
    assert.equal(await missions.reflect(db, env, { now: NOW }), null);
    assert.equal(services.telegram().length, 0);
    await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: '/rifletti' } });
    assert.match(services.telegram().at(-1).text, /manca la chiave Gemini \(gratuita\)/);
    assert.equal(db.sqlite.prepare("SELECT kind FROM jarvis_events").get().kind, 'errore.riflessione');
    await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: '/proposte' } });
    assert.match(services.telegram().at(-1).text, /Nessuna proposta aperta/);
  } finally { globalThis.fetch = previous; }
});

test('riflessione: alla proposta si può rispondere a parole («non ora», poi «sì» alla seguente)', async () => {
  const db = database();
  const services = fakeServices({ proposals: [good('Ricontatta i locali silenziosi'), good('Prepara il menu del giorno')] });
  const previous = globalThis.fetch;
  globalThis.fetch = services.fetchImpl;
  try {
    await missions.putSetting(db, 'telegram_chat_id', '42');
    await missions.putSetting(db, 'claude_enabled', 'si');
    const env = { DB: db, TELEGRAM_BOT_TOKEN: TOKEN, ANTHROPIC_API_KEY: 'sk-test' };
    const out = await missions.reflect(db, env, { now: NOW });
    const [first, second] = out.proposals;
    // L'ultima proposta inviata è la seconda: «non ora» vale per quella.
    await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: 'non ora' } });
    assert.match(services.telegram().at(-1).text, /la tengo da parte/);
    assert.equal(db.sqlite.prepare('SELECT status FROM jarvis_proposals WHERE id=?').get(second.id).status, 'rimandata');
    assert.equal(db.sqlite.prepare('SELECT status FROM jarvis_proposals WHERE id=?').get(first.id).status, 'nuova');
    assert.ok(services.calls.some((c) => c.href.endsWith('/editMessageReplyMarkup')), 'i pulsanti del messaggio spariscono');
    assert.match(db.sqlite.prepare("SELECT summary FROM audit_events WHERE action='jarvis.conversation' ORDER BY created_at DESC").get().summary, /Risposta breve «non ora» → pulsante «Non ora»/);
    // Scelta già usata: un altro «no» non tocca più niente e va alla conversazione normale.
    assert.equal(db.sqlite.prepare("SELECT value FROM jarvis_settings WHERE key='tg_buttons'").get().value, 'null');
  } finally { globalThis.fetch = previous; }
});

test('riflessione: di base usa Gemini gratuito anche se la chiave Anthropic c’è; Claude solo se acceso con /claude', async () => {
  const db = database();
  const services = fakeServices();
  const previous = globalThis.fetch;
  globalThis.fetch = services.fetchImpl;
  try {
    await missions.putSetting(db, 'telegram_chat_id', '42');
    await missions.putSetting(db, 'gemini_api_key', 'gem-test');
    const env = { DB: db, TELEGRAM_BOT_TOKEN: TOKEN, ANTHROPIC_API_KEY: 'sk-test' };
    const out = await missions.reflect(db, env, { now: NOW });
    assert.equal(out.proposals.length, 1);
    assert.equal(services.calls.filter((c) => c.href.includes('anthropic')).length, 0, 'nessuna spesa su Anthropic');
    assert.ok(services.calls.some((c) => c.href.startsWith('https://generativelanguage.googleapis.com/')));
    await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: '/claude' } });
    assert.match(services.telegram().at(-1).text, /Claude è spento: rispondo e preparo le proposte solo con i modelli gratuiti/);
    await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: '/claude sì' } });
    assert.match(services.telegram().at(-1).text, /Claude è acceso/);
    await missions.reflect(db, env, { force: true, now: NOW });
    assert.equal(services.calls.filter((c) => c.href.includes('anthropic')).length, 1);
  } finally { globalThis.fetch = previous; }
});

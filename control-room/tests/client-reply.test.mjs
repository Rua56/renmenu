import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { draftClientReply, groundReply, lastMessage, originalSubject, replyFacts, sendWhatsAppReply, templateReply } from '../cloudflare/functions/_lib/client-reply.js';
import { missions } from '../cloudflare/functions/control-room/api/[[route]].js';

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
    async batch(statements) { return statements.map((s) => s.run()); }
  };
}
const fakeAi = (answer) => ({ calls: [], async run(model, input) { this.calls.push(input); return { response: typeof answer === 'function' ? answer(input) : answer }; } });

test('Risposte ai clienti: ultimo messaggio, oggetto e fatti veri della pratica', () => {
  const text = 'WhatsApp da Bar Centrale (+393331112222)\n\n[foto allegata]\n\nBuongiorno, quando è pronto il menu?';
  assert.equal(lastMessage(text), 'Buongiorno, quando è pronto il menu?');
  assert.equal(originalSubject('Oggetto ricevuto: Menu nuovo\n\nCiao'), 'Menu nuovo');
  assert.match(replyFacts({ materials: 0 })[0], /ci servono le foto o il PDF/);
  assert.match(replyFacts({ materials: 2 })[0], /ricevuto il materiale/);
  assert.match(replyFacts({ draftStatus: 'revisione' })[0], /Stiamo preparando/);
  assert.match(replyFacts({ missionStatus: 'attesa_cliente' })[0], /Approvo/);
  assert.match(replyFacts({ missionStatus: 'completata', menuUrl: 'https://renmenu.com/m/bar' })[0], /online: https:\/\/renmenu\.com\/m\/bar/);
  assert.match(templateReply({ channel: 'email', materials: 1 }), /^Buongiorno,\n\n.*\n\nRiccardo · RenMenu$/s);
});

test('Risposte ai clienti: scarta numeri, date e link inventati dal modello', () => {
  const facts = replyFacts({ materials: 1 });
  assert.equal(groundReply('Il menu sarà pronto venerdì 17, costa 249 euro.', { facts, message: 'quando è pronto?' }), null);
  assert.equal(groundReply('Guardate qui https://altro.it/menu', { facts, message: 'ciao' }), null);
  assert.equal(groundReply('Pronto il 17 come chiesto.', { facts, message: 'per il 17 ce la fate?' }), 'Pronto il 17 come chiesto.');
  assert.equal(groundReply('Ecco il menu: https://renmenu.com/m/bar', { facts, message: 'link?', menuUrl: 'https://renmenu.com/m/bar' }), 'Ecco il menu: https://renmenu.com/m/bar');
  assert.match(groundReply('Buongiorno, ricevuto tutto.', { facts, channel: 'email' }), /Riccardo · RenMenu$/);
});

test('Risposte ai clienti: modello gratuito, poi modello fisso; con un’indicazione niente modello fisso', async () => {
  const ctx = { channel: 'whatsapp', clientName: 'Bar Centrale', message: 'Quando è pronto?', materials: 1 };
  const good = await draftClientReply({ ai: fakeAi('{"risposta":"Buongiorno! Abbiamo il materiale e stiamo preparando la bozza."}') }, ctx);
  assert.equal(good.model, 'cloudflare');
  assert.match(good.text, /stiamo preparando la bozza/);
  const invented = await draftClientReply({ ai: fakeAi('{"risposta":"Sarà pronto entro 3 giorni, garantito."}') }, ctx);
  assert.equal(invented.model, 'modello fisso');
  assert.match(invented.text, /ricevuto il materiale/);
  const failed = await draftClientReply({ ai: fakeAi('niente') }, ctx, { instruction: 'più breve', previous: invented.text });
  assert.equal(failed.text, '');
  const ai = fakeAi('{"risposta":"Buongiorno! Il menu sarà pronto venerdì 17."}');
  const told = await draftClientReply({ ai }, ctx, { instruction: 'digli che è pronto venerdì 17', previous: invented.text });
  assert.match(told.text, /venerdì 17/);
  assert.match(ai.calls[0].messages[1].content, /INDICAZIONE DI RICCARDO/);
});

test('Risposte ai clienti: WhatsApp solo entro 24 ore e col numero di RenMenu', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization }); return Response.json({ messages: [{ id: 'wamid.1' }] }); };
  const env = { WHATSAPP_TOKEN: 'tok', WHATSAPP_INBOUND_VIA: 'dualhook' };
  const now = Date.parse('2026-10-14T10:00:00Z');
  assert.match((await sendWhatsAppReply(env, { phoneNumberId: '', to: '+39333', text: 'ciao', lastInboundAt: '2026-10-14T09:00:00Z', fetchImpl, now })).reason, /numero WhatsApp di RenMenu/);
  assert.match((await sendWhatsAppReply(env, { phoneNumberId: '123456', to: '+393331112222', text: 'ciao', lastInboundAt: '2026-10-13T09:00:00Z', fetchImpl, now })).reason, /24 ore/);
  const ok = await sendWhatsAppReply(env, { phoneNumberId: '123456', to: '+39 333 111 2222', text: 'ciao', lastInboundAt: '2026-10-14T09:00:00Z', fetchImpl, now });
  assert.deepEqual(ok, { ok: true, id: 'wamid.1' });
  assert.equal(sent[0].url, 'https://api.dualhook.com/v25.0/123456/messages');
  assert.equal(sent[0].body.to, '393331112222');
  assert.equal(sent[0].auth, 'Bearer tok');
});

function telegramAndWhatsApp() {
  const tg = [], wa = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/sendMessage')) { tg.push(JSON.parse(init.body)); return Response.json({ ok: true, result: { message_id: tg.length } }); }
    if (u.includes('dualhook')) { wa.push(JSON.parse(init.body)); return Response.json({ messages: [{ id: 'wamid.2' }] }); }
    return Response.json({ ok: true, result: {} });
  };
  return { tg, wa, fetchImpl };
}
function seedWhatsApp(db) {
  const stamp = new Date().toISOString();
  const q = (sql, ...p) => db.sqlite.prepare(sql).run(...p);
  q("INSERT INTO clients (id,name,phone,plan,created_at,updated_at) VALUES ('c1','Bar Centrale','+393331112222','standard',?,?)", stamp, stamp);
  q("INSERT INTO requests (id,client_id,subject,source_channel,source_text,kind,status,contact_info,created_at,updated_at) VALUES ('r1','c1','Richiesta WhatsApp','whatsapp',?,'altro','nuova','+393331112222',?,?)",
    'WhatsApp da Bar Centrale (+393331112222)\n\n[foto allegata]\n\nCiao, avete ricevuto la foto del menu?', stamp, stamp);
  q("INSERT INTO materials (id,request_id,r2_key,filename,mime,size,source,processing_status,created_at) VALUES ('m1','r1','k','menu.jpg','image/jpeg',10,'whatsapp','da_trascrivere',?)", stamp);
  q("INSERT INTO external_events (id,source,source_event_id,request_id,status,received_at) VALUES ('e1','whatsapp','wamid.0','r1','imported',?)", stamp);
}

test('Risposte ai clienti: Jarvis propone su Telegram, «Cambia» la riscrive, «Manda» la spedisce su WhatsApp', async () => {
  const db = database(); seedWhatsApp(db);
  const io = telegramAndWhatsApp();
  const previous = globalThis.fetch;
  globalThis.fetch = io.fetchImpl;
  try {
    const m = missions;
    await m.putSetting(db, 'telegram_chat_id', '42');
    await m.putSetting(db, 'wa_phone_number_id', '123456');
    const ai = fakeAi((input) => (/INDICAZIONE/.test(input.messages[1].content) ? '{"risposta":"Sì, ricevuta! Grazie."}' : '{"risposta":"Buongiorno! Sì, abbiamo ricevuto la foto e stiamo preparando la bozza."}'));
    const env = { DB: db, TELEGRAM_BOT_TOKEN: TOKEN, AI: ai, WHATSAPP_TOKEN: 'tok', WHATSAPP_INBOUND_VIA: 'dualhook' };
    // L'orologio prepara la risposta solo quando è il suo momento (dopo la raffica di messaggi).
    await m.putSetting(db, 'reply_queue', JSON.stringify({ r1: new Date(Date.now() + 60_000).toISOString() }));
    assert.equal(await m.replyTick(db, env), null);
    await m.putSetting(db, 'reply_queue', JSON.stringify({ r1: new Date(Date.now() - 1000).toISOString() }));
    const saved = await m.replyTick(db, env);
    assert.equal(saved.channel, 'whatsapp');
    assert.equal(io.tg.length, 1);
    assert.match(io.tg[0].text, /«Bar Centrale» ha scritto: «Ciao, avete ricevuto la foto del menu\?»/);
    assert.match(io.tg[0].text, /stiamo preparando la bozza/);
    assert.deepEqual(io.tg[0].reply_markup.inline_keyboard.flat().map((b) => b.callback_data), ['rep:send:r1', 'rep:edit:r1', 'rep:skip:r1']);
    assert.equal(io.wa.length, 0); // niente parte da solo
    // Cambia → indicazione a parole → nuova proposta.
    await m.telegramUpdate(db, env, { callback_query: { id: 'q', data: 'rep:edit:r1', message: { chat: { id: 42 }, message_id: 1 } } });
    assert.match(io.tg.at(-1).text, /Dimmi come cambiarla/);
    await m.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: 'più breve' } });
    assert.match(io.tg.at(-1).text, /Ecco la risposta cambiata[\s\S]*Sì, ricevuta! Grazie\./);
    // Manda.
    await m.telegramUpdate(db, env, { callback_query: { id: 'q2', data: 'rep:send:r1', message: { chat: { id: 42 }, message_id: 3 } } });
    assert.equal(io.wa.length, 1);
    assert.equal(io.wa[0].to, '393331112222');
    assert.equal(io.wa[0].text.body, 'Sì, ricevuta! Grazie.');
    assert.match(io.tg.at(-1).text, /Mandata a «Bar Centrale» su WhatsApp/);
    // Un secondo tocco non la rimanda.
    await m.telegramUpdate(db, env, { callback_query: { id: 'q3', data: 'rep:send:r1', message: { chat: { id: 42 }, message_id: 3 } } });
    assert.equal(io.wa.length, 1);
    assert.match(io.tg.at(-1).text, /non c’è più/);
  } finally { globalThis.fetch = previous; }
});

test('Risposte ai clienti: testo tra virgolette usato così com’è, /risposte no le spegne, in attesa di «Approvo» tace', async () => {
  const db = database(); seedWhatsApp(db);
  const io = telegramAndWhatsApp();
  const previous = globalThis.fetch;
  globalThis.fetch = io.fetchImpl;
  try {
    const m = missions;
    await m.putSetting(db, 'telegram_chat_id', '42');
    const env = { DB: db, TELEGRAM_BOT_TOKEN: TOKEN, AI: fakeAi('{"risposta":"Buongiorno! Ricevuta la foto, grazie."}'), WHATSAPP_TOKEN: 'tok', WHATSAPP_INBOUND_VIA: 'dualhook' };
    await m.proposeReply(db, env, 'r1');
    await m.telegramUpdate(db, env, { callback_query: { id: 'q', data: 'rep:edit:r1', message: { chat: { id: 42 }, message_id: 1 } } });
    await m.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: '«Ciao! Arrivata, domani vi mando la bozza.»' } });
    assert.match(io.tg.at(-1).text, /Ciao! Arrivata, domani vi mando la bozza\./);
    // Senza il numero di RenMenu WhatsApp non parte: Jarvis dà il testo da copiare.
    await m.telegramUpdate(db, env, { callback_query: { id: 'q2', data: 'rep:send:r1', message: { chat: { id: 42 }, message_id: 2 } } });
    assert.equal(io.wa.length, 0);
    assert.match(io.tg.at(-1).text, /non è partita: non conosco ancora il numero WhatsApp[\s\S]*Ciao! Arrivata/);
    // /risposte no
    await m.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: '/risposte no' } });
    assert.equal(await m.setting(db, 'reply_enabled'), 'no');
    const before = io.tg.length;
    assert.equal(await m.proposeReply(db, env, 'r1'), null);
    assert.equal(io.tg.length, before);
    await m.putSetting(db, 'reply_enabled', 'si');
    // Anteprima già mandata: risponde il giro delle approvazioni, non questa funzione.
    db.sqlite.prepare("INSERT INTO drafts (id,request_id,slug,menu_json,status,created_at,updated_at) VALUES ('d1','r1','bar-centrale','{}','revisione',?,?)").run(new Date().toISOString(), new Date().toISOString());
    db.sqlite.prepare("INSERT INTO jarvis_missions (id,request_id,draft_id,status,step_started_at,created_at,updated_at) VALUES ('mi1','r1','d1','attesa_cliente',?,?,?)").run(new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
    assert.equal(await m.proposeReply(db, env, 'r1'), null);
  } finally { globalThis.fetch = previous; }
});

test('Risposte ai clienti: l’annuncio del messaggio mette in coda la risposta per dopo la raffica', async () => {
  const db = database(); seedWhatsApp(db);
  const io = telegramAndWhatsApp();
  const previous = globalThis.fetch;
  globalThis.fetch = io.fetchImpl;
  try {
    await missions.putSetting(db, 'telegram_chat_id', '42');
    await missions.putSetting(db, 'external_seen_at', new Date(Date.now() - 60_000).toISOString());
    await missions.announceExternal(db, { DB: db, TELEGRAM_BOT_TOKEN: TOKEN });
    const queue = JSON.parse(await missions.setting(db, 'reply_queue'));
    assert.ok(Date.parse(queue.r1) > Date.now());
  } finally { globalThis.fetch = previous; }
});

test('Menu dei comandi: «/menu» mostra un pulsante per comando, il tocco lo esegue, il menu «/» si imposta una volta', async () => {
  const db = database();
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => { calls.push({ method: String(url).split('/').pop(), body: JSON.parse(init.body || '{}') }); return Response.json({ ok: true, result: { message_id: calls.length } }); };
  try {
    await missions.putSetting(db, 'telegram_chat_id', '42');
    const env = { DB: db, TELEGRAM_BOT_TOKEN: TOKEN };
    await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: '/menu' } });
    const commands = calls.find((c) => c.method === 'setMyCommands');
    assert.ok(commands.body.commands.some((c) => c.command === 'stato'));
    const menu = calls.filter((c) => c.method === 'sendMessage').at(-1).body;
    assert.match(menu.text, /Ecco i comandi/);
    assert.equal(menu.reply_markup.inline_keyboard[0].length, 2);
    const datas = menu.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
    assert.ok(datas.includes('cmd:stato') && datas.includes('cmd:risposte') && !datas.includes('cmd:menu'));
    await missions.telegramUpdate(db, env, { callback_query: { id: 'q', data: 'cmd:risposte', message: { chat: { id: 42 }, message_id: 1 } } });
    assert.match(calls.filter((c) => c.method === 'sendMessage').at(-1).body.text, /Risposte pronte accese/);
    await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: '/sconosciuto' } });
    assert.match(calls.filter((c) => c.method === 'sendMessage').at(-1).body.text, /Tocca un comando qui sotto/);
    assert.equal(calls.filter((c) => c.method === 'setMyCommands').length, 1);
  } finally { globalThis.fetch = previous; }
});

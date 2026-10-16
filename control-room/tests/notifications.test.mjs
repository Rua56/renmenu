import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
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
    async batch(statements) {
      sqlite.exec('BEGIN TRANSACTION');
      try { const results = statements.map((s) => s.run()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    }
  };
}

// Telegram ed ElevenLabs finti: registrano ogni chiamata.
async function withServices(fn) {
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    calls.push({ href, body: typeof options.body === 'string' ? JSON.parse(options.body) : options.body });
    if (href.startsWith('https://api.elevenlabs.io/')) return new Response(new Uint8Array(600), { headers: { 'Content-Type': 'audio/mpeg' } });
    return Response.json({ ok: true, result: { message_id: calls.length } });
  };
  try { return await fn(calls); } finally { globalThis.fetch = previous; }
}
const sent = (calls) => calls.filter((c) => c.href.endsWith('/sendMessage')).map((c) => c.body);
const voices = (calls) => calls.filter((c) => c.href.endsWith('/sendVoice'));
const speech = (calls) => calls.filter((c) => c.href.startsWith('https://api.elevenlabs.io/')).map((c) => c.body.text);

async function linked(db, { voice = true } = {}) {
  await missions.putSetting(db, 'telegram_chat_id', '42');
  if (voice) { await missions.putSetting(db, 'voice_provider', 'elevenlabs'); await missions.putSetting(db, 'voice_api_key', 'el-test'); }
  return { DB: db, TELEGRAM_BOT_TOKEN: TOKEN };
}

test('avvisi: di giorno suonano; gli importanti arrivano anche a voce, senza link', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-13T10:00:00Z') }); // 12:00 a Roma
  await withServices(async (calls) => {
    const db = database(), env = await linked(db);
    await missions.notify(db, env, null, 'foto letta', 'Ho letto «menu.jpg».');
    assert.equal(sent(calls)[0].disable_notification, undefined);
    assert.equal(voices(calls).length, 0, 'gli avvisi normali restano scritti');
    await missions.notify(db, env, null, 'menu online', 'Il menu di Al Bakaro è online e verificato: https://renmenu.com/al-bakaro. Ti mando il QR.\n1. riga di elenco', 'importante');
    assert.equal(voices(calls).length, 1);
    assert.equal(speech(calls)[0], 'Riccardo, il menu di Al Bakaro è online e verificato: Ti mando il QR.');
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM notifications WHERE channel='in_app'").get().n, 2, 'restano anche nella Control Room');
  });
});

test('avvisi: di notte i normali arrivano senza suono e senza voce; gli importanti suonano', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-13T21:30:00Z') }); // 23:30 a Roma
  await withServices(async (calls) => {
    const db = database(), env = await linked(db);
    await missions.putSetting(db, 'voice_alerts', 'tutti');
    await missions.notify(db, env, null, 'allegato', 'Collegato un allegato.');
    assert.equal(sent(calls)[0].disable_notification, true);
    assert.equal(voices(calls).length, 0);
    await missions.notify(db, env, null, 'missione ferma', 'Mi sono fermato.', 'importante');
    assert.equal(sent(calls)[1].disable_notification, undefined);
    assert.equal(voices(calls).length, 1);
  });
});

test('avvisi: /voce mostra la scelta, «nessuno» a parole spegne la voce', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-13T10:00:00Z') });
  await withServices(async (calls) => {
    const db = database(), env = await linked(db);
    await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: '/voce' } });
    assert.match(sent(calls).at(-1).text, /Avvisi a voce: solo gli avvisi importanti/);
    assert.ok(JSON.stringify(sent(calls).at(-1).reply_markup).includes('voce:nessuno'));
    await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: 'nessuno' } });
    assert.match(sent(calls).at(-1).text, /avvisi a voce per nessun avviso/);
    await missions.notify(db, env, null, 'menu online', 'Online.', 'importante');
    assert.equal(voices(calls).length, 0);
  });
});

test('avvisi: un guasto che si ripete avvisa una volta sola e finisce nel diario', async () => {
  await withServices(async (calls) => {
    const db = database(), env = await linked(db, { voice: false });
    assert.equal(await missions.alertOnce(db, env, 'orologio', 'orologio fermo', 'L’orologio si è inceppato.'), true);
    assert.equal(await missions.alertOnce(db, env, 'orologio', 'orologio fermo', 'L’orologio si è inceppato.'), false);
    assert.equal(sent(calls).length, 1);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM jarvis_events WHERE kind='errore.orologio'").get().n, 2);
  });
});

test('avvisi: i messaggi WhatsApp arrivati dal webhook vengono annunciati una volta, senza lo storico', async () => {
  await withServices(async (calls) => {
    const db = database(), env = await linked(db, { voice: false });
    const s = db.sqlite, at = (m) => new Date(Date.now() + m * 60_000).toISOString();
    const event = (id, minutes, text) => {
      s.prepare("INSERT INTO clients (id,name,phone,plan,created_at,updated_at) VALUES (?,?,?,'da_definire',?,?)").run(`c${id}`, 'Nuovo contatto WhatsApp', `+39${id}`, at(minutes), at(minutes));
      s.prepare("INSERT INTO requests (id,client_id,subject,source_channel,source_text,kind,status,created_at,updated_at) VALUES (?,?,?,'whatsapp',?,'altro','nuova',?,?)").run(`r${id}`, `c${id}`, 'Richiesta WhatsApp da verificare', text, at(minutes), at(minutes));
      s.prepare("INSERT INTO external_events (id,source,source_event_id,request_id,status,received_at) VALUES (?,?,?,?,'imported',?)").run(`e${id}`, 'whatsapp', `w${id}`, `r${id}`, at(minutes));
    };
    event(1, -60, 'Vecchio messaggio');
    assert.equal(await missions.announceExternal(db, env), 0, 'la prima volta segna solo il punto di partenza');
    event(2, 1, 'Ciao, il prezzo dello spritz ora è 4 euro');
    assert.equal(await missions.announceExternal(db, env), 1);
    assert.match(sent(calls)[0].text, /^Nuovo messaggio WhatsApp da Nuovo contatto WhatsApp: «Ciao, il prezzo dello spritz ora è 4 euro»/);
    assert.equal(await missions.announceExternal(db, env), 0, 'mai due volte');
    assert.doesNotMatch(JSON.stringify(sent(calls)), /Vecchio messaggio/);
  });
});

test('avvisi: un numero WhatsApp sconosciuto chiede «è un locale?» e il tocco apre la pratica', async () => {
  const { importWhatsAppMessage } = await import('../cloudflare/functions/_lib/whatsapp-in.js');
  await withServices(async (calls) => {
    const db = database(), env = { ...(await linked(db, { voice: false })), WHATSAPP_PRIVATE_FILTER: 'true' };
    await missions.announceExternal(db, env); // punto di partenza
    const message = { id: 'wamid.x1', waId: '393330000009', profileName: 'Trattoria Sole', messageType: 'text', content: { text: 'Vi mando il menu nuovo', raw: { type: 'text', text: { body: 'Vi mando il menu nuovo' } } } };
    assert.equal((await importWhatsAppMessage(db, env, message)).kind, 'held');
    assert.equal(await missions.announceExternal(db, env), 1);
    const ask = sent(calls).at(-1);
    assert.match(ask.text, /numero che non conosco: Trattoria Sole \(\+393330000009\), «Vi mando il menu nuovo»\. È un locale\?/);
    assert.deepEqual(ask.reply_markup.inline_keyboard.flat().map((b) => b.callback_data), ['wak:393330000009', 'wap:393330000009']);
    assert.equal(await missions.announceExternal(db, env), 0, 'una domanda sola per numero');
    await missions.telegramUpdate(db, env, { callback_query: { id: 'q1', data: 'wak:393330000009', message: { chat: { id: 42 }, message_id: 7 } } });
    assert.match(sent(calls).at(-1).text, /^Fatto: Trattoria Sole è un locale\. Ho aperto la pratica con il suo messaggio\./);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM requests WHERE source_channel='whatsapp'").get().n, 1);
  });
});

test('avvisi: al numero WhatsApp sconosciuto si risponde anche a parole (telefonata, Telegram, Control Room)', async () => {
  const { importWhatsAppMessage, contactVerdict } = await import('../cloudflare/functions/_lib/whatsapp-in.js');
  assert.equal(contactVerdict('è un privato, ignoralo'), 'private');
  assert.equal(contactVerdict('no, non è un locale'), 'private');
  assert.equal(contactVerdict('sì è un locale, registralo'), 'venue');
  assert.equal(contactVerdict('come va la pratica di Blanch?'), null);
  assert.equal(contactVerdict('è un locale'), 'venue');
  assert.equal(contactVerdict('è privato'), 'private');
  assert.equal(contactVerdict('apri la pratica di Blanch'), null);
  await withServices(async (calls) => {
    const db = database(), env = { ...(await linked(db, { voice: false })), WHATSAPP_PRIVATE_FILTER: 'true' };
    await missions.announceExternal(db, env);
    const msg = (id, waId, name, text) => ({ id, waId, profileName: name, messageType: 'text', content: { text, raw: { type: 'text', text: { body: text } } } });
    // Prima dell'annuncio la frase non tocca niente: segue la strada di sempre.
    await importWhatsAppMessage(db, env, msg('wamid.a', '393330000011', 'Marco', 'Ciao, ci vediamo stasera?'));
    await missions.announceExternal(db, env);
    await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: 'è un privato, ignoralo' } });
    assert.match(sent(calls).at(-1).text, /^Va bene, Marco è privato/);
    assert.match(db.sqlite.prepare("SELECT value FROM jarvis_settings WHERE key='wa_block'").get().value, /393330000011/);
    // Due numeri in attesa: «è un locale» senza dire quale chiede quale, coi pulsanti.
    await importWhatsAppMessage(db, env, msg('wamid.b', '393330000012', 'Bar Centrale', 'Vi mando il listino'));
    await importWhatsAppMessage(db, env, msg('wamid.c', '393330000013', 'Giulia', 'Ciao!'));
    await missions.announceExternal(db, env);
    await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: 'è un locale' } });
    const ask = sent(calls).at(-1);
    assert.match(ask.text, /^Ho più numeri WhatsApp in attesa/);
    assert.deepEqual(ask.reply_markup.inline_keyboard.flat().map((b) => b.callback_data).sort(), ['wak:393330000012', 'wak:393330000013']);
    // Col nome nella frase sceglie da solo e apre la pratica.
    await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: 'il bar centrale è un locale, registralo' } });
    assert.match(sent(calls).at(-1).text, /^Fatto: Bar Centrale è un locale\. Ho aperto la pratica/);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM requests WHERE source_channel='whatsapp'").get().n, 1);
  });
});

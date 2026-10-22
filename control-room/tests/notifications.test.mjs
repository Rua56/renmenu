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

test('avvisi: frasi riformulate dal telefono e «associalo a <locale>» mettono il numero sulla scheda del cliente', async () => {
  const { importWhatsAppMessage, contactVerdict } = await import('../cloudflare/functions/_lib/whatsapp-in.js');
  // Così le passa l'agente al telefono (16 ottobre): in terza persona e indirette.
  assert.equal(contactVerdict('Riccardo dice che il contatto WhatsApp di Vlad è un suo amico privato, non un locale. Chiede di segnalarlo come privato e di ignorarlo.'), 'private');
  assert.equal(contactVerdict('Riccardo dice che il numero è di Paolo, il titolare di Osteria Codelli 23: è un locale, associalo alla pratica di Osteria Codelli 23.'), 'venue');
  await withServices(async (calls) => {
    const db = database(), env = { ...(await linked(db, { voice: false })), WHATSAPP_PRIVATE_FILTER: 'true' };
    const s = db.sqlite;
    s.prepare("INSERT INTO clients (id,name,plan,created_at,updated_at) VALUES ('cod','Osteria Codelli 23','premium','2026-10-10','2026-10-10')").run();
    await missions.announceExternal(db, env);
    await importWhatsAppMessage(db, env, { id: 'wamid.k1', waId: '393477905309', profileName: 'Pao', messageType: 'text', content: { text: 'Ciao, ecco la carta dei vini', raw: { type: 'text', text: { body: 'Ciao, ecco la carta dei vini' } } } });
    await missions.announceExternal(db, env);
    // Una frase lunga che non parla del contatto non tocca niente.
    await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: 'ricordami che domani devo passare da un amico per il menu di Blanch, è importante' } });
    assert.equal(s.prepare("SELECT phone FROM clients WHERE id='cod'").get().phone, null);
    await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: 'Riccardo dice che il numero è di Paolo, il titolare di Osteria Codelli 23: è un locale, associalo alla pratica di Osteria Codelli 23.' } });
    assert.match(sent(calls).at(-1).text, /^Fatto: il numero \+393477905309 \(Pao\) ora è sulla scheda di «Osteria Codelli 23»/);
    assert.equal(s.prepare("SELECT phone FROM clients WHERE id='cod'").get().phone, '+393477905309');
    const req = s.prepare("SELECT client_id FROM requests WHERE source_channel='whatsapp'").all();
    assert.deepEqual(req.map((r) => r.client_id), ['cod'], 'il messaggio in attesa va tra le pratiche di Codelli');
  });
});

test('WhatsApp dei locali: testo nella pratica già aperta, nuova pratica solo col sì di Riccardo, vocali mai letti', async () => {
  const { importWhatsAppMessage, senderStatus } = await import('../cloudflare/functions/_lib/whatsapp-in.js');
  await withServices(async (calls) => {
    const db = database(), s = db.sqlite;
    const env = { ...(await linked(db, { voice: false })), WHATSAPP_PRIVATE_FILTER: 'true' };
    s.prepare("INSERT INTO clients (id,name,plan,phone,created_at,updated_at) VALUES ('cod','Osteria Codelli 23','premium','+393477905309','2026-10-10','2026-10-10')").run();
    s.prepare("INSERT INTO clients (id,name,plan,phone,created_at,updated_at) VALUES ('bla','Trattoria Blanch','premium','+393477658816','2026-10-10','2026-10-10')").run();
    s.prepare("INSERT INTO requests (id,client_id,subject,source_channel,source_text,kind,status,plan,revision,created_at,updated_at) VALUES ('rc','cod','Menu Premium · Osteria Codelli 23','email','Menu del locale','nuovo','in_attesa','premium',1,'2026-10-10','2026-10-10')").run();
    s.prepare("INSERT INTO requests (id,client_id,subject,source_channel,source_text,kind,status,plan,revision,created_at,updated_at) VALUES ('rb','bla','Menu Blanch','email','x','nuovo','completata','premium',1,'2026-10-05','2026-10-05')").run();
    await missions.putSetting(db, 'external_seen_at', '2026-01-01T00:00:00.000Z');
    const text = (id, waId, name, body) => ({ id, waId, profileName: name, messageType: 'text', content: { text: body, raw: { type: 'text', text: { body } } } });
    const count = () => s.prepare('SELECT COUNT(*) n FROM requests').get().n;

    // Codelli 23 ha già una pratica aperta (arrivata per email): il messaggio va lì.
    const out = await importWhatsAppMessage(db, env, text('wamid.c1', '393477905309', 'Pao', 'Il prezzo della carbonara diventa 13 euro'));
    assert.deepEqual([out.kind, out.requestId], ['appended', 'rc']);
    assert.equal(count(), 2, 'nessuna pratica nuova');
    // Un vocale: nessuna pratica, nessun testo salvato.
    const voice = { id: 'wamid.c2', waId: '393477905309', profileName: 'Pao', messageType: 'audio', content: { raw: { type: 'audio', audio: { id: 'media1', mime_type: 'audio/ogg' } } } };
    assert.equal((await importWhatsAppMessage(db, env, voice)).kind, 'voice');
    assert.equal((await importWhatsAppMessage(db, env, voice)).kind, 'duplicate');
    assert.equal(count(), 2);
    assert.doesNotMatch(s.prepare("SELECT source_text FROM requests WHERE id='rc'").get().source_text, /vocale|audio/);
    await missions.announceExternal(db, env);
    const notices = sent(calls).slice(-2).map((m) => m.text);
    assert.match(notices[0], /«Il prezzo della carbonara diventa 13 euro»\. L'ho aggiunto alla pratica già aperta «Menu Premium · Osteria Codelli 23», non ne ho aperta una nuova/);
    assert.doesNotMatch(notices[0], /Menu del locale/, 'solo il messaggio nuovo, non tutta la pratica');
    assert.match(notices[1], /^«Osteria Codelli 23» ti ha mandato un vocale su WhatsApp\. I vocali non li ascolto e non apro pratiche: chiedigli di scriverti la richiesta/);

    const { contactVerdict } = await import('../cloudflare/functions/_lib/whatsapp-in.js');
    assert.equal(contactVerdict('Sì, aprila'), 'venue');
    assert.equal(contactVerdict('No, lascia stare'), 'private');
    assert.equal(contactVerdict('Non aprire niente'), 'private');
    // Blanch non ha pratiche aperte: Jarvis chiede prima di aprirne una.
    assert.equal((await importWhatsAppMessage(db, env, text('wamid.b1', '393477658816', 'Blanch', 'Togliete il baccalà dal menu'))).kind, 'held');
    assert.equal(count(), 2);
    await missions.announceExternal(db, env);
    const ask = sent(calls).at(-1);
    assert.match(ask.text, /^«Trattoria Blanch» ti ha scritto su WhatsApp: «Togliete il baccalà dal menu»\. Non ha pratiche aperte: ne apro una nuova\?/);
    assert.deepEqual(ask.reply_markup.inline_keyboard.flat().map((b) => b.callback_data), ['wak:393477658816', 'wap:393477658816']);
    // «No»: niente pratica, ma il locale non diventa un contatto privato.
    await missions.telegramUpdate(db, env, { callback_query: { id: 'q1', data: 'wap:393477658816', message: { chat: { id: 42 }, message_id: 9 } } });
    assert.match(sent(calls).at(-1).text, /non apro nessuna pratica per il messaggio di Blanch/);
    assert.equal(await senderStatus(db, '393477658816'), 'allowed');
    assert.equal(count(), 2);
    // Al messaggio dopo richiede; «sì» apre la pratica.
    await importWhatsAppMessage(db, env, text('wamid.b2', '393477658816', 'Blanch', 'Aggiungete i tortelli a 14 euro'));
    await missions.announceExternal(db, env);
    await missions.telegramUpdate(db, env, { callback_query: { id: 'q2', data: 'wak:393477658816', message: { chat: { id: 42 }, message_id: 10 } } });
    assert.match(sent(calls).at(-1).text, /^Fatto: ho aperto una pratica nuova con il messaggio di Blanch/);
    const fresh = s.prepare("SELECT client_id,source_text FROM requests WHERE source_channel='whatsapp'").all();
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0].client_id, 'bla');
    assert.match(fresh[0].source_text, /Aggiungete i tortelli a 14 euro/);
  });
});

test('avvisi: «è un locale» e subito dopo «no, è un privato» corregge; «è un privato» blocca anche un numero già tra i locali', async () => {
  const { importWhatsAppMessage, senderStatus } = await import('../cloudflare/functions/_lib/whatsapp-in.js');
  await withServices(async (calls) => {
    const db = database(), s = db.sqlite, env = { ...(await linked(db, { voice: false })), WHATSAPP_PRIVATE_FILTER: 'true' };
    await missions.announceExternal(db, env);
    const msg = (id, body) => ({ id, waId: '393333802906', profileName: 'alessio☀️', messageType: 'text', content: { text: body, raw: { type: 'text', text: { body } } } });
    await importWhatsAppMessage(db, env, msg('wamid.al1', 'Ola pupo'));
    await missions.announceExternal(db, env);
    // Al telefono, 20 ottobre: prima «è un locale», poi la correzione.
    await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: 'è un locale, registralo' } });
    assert.equal(s.prepare("SELECT COUNT(*) n FROM requests WHERE source_channel='whatsapp'").get().n, 1);
    await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: 'no scusa, mi sono sbagliato: è un privato, ignoralo' } });
    assert.match(sent(calls).at(-1).text, /^Corretto: alessio☀️ è privato.*ho tolto la pratica che avevo appena aperto/);
    assert.equal(await senderStatus(db, '393333802906'), 'blocked');
    assert.equal(s.prepare("SELECT COUNT(*) n FROM requests WHERE source_channel='whatsapp'").get().n, 0);

    // Un numero già tra i locali (senza scheda cliente) che riscrive: «è un privato» lo blocca davvero.
    s.prepare("UPDATE jarvis_settings SET value='[\"393333802906\"]' WHERE key='wa_allow'").run();
    s.prepare("UPDATE jarvis_settings SET value='[]' WHERE key='wa_block'").run();
    s.prepare("UPDATE jarvis_settings SET value='null' WHERE key='wa_last_contact'").run();
    await importWhatsAppMessage(db, env, msg('wamid.al2', 'Stasera ci sei?'));
    await missions.announceExternal(db, env);
    await missions.telegramUpdate(db, env, { message: { chat: { id: 42, type: 'private' }, text: 'è un privato, lascia stare' } });
    assert.equal(await senderStatus(db, '393333802906'), 'blocked');
  });
});

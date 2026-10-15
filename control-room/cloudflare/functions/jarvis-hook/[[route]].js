// Ingressi pubblici di Jarvis, fuori da Cloudflare Access ma protetti da segreti:
// - /jarvis-hook/telegram: aggiornamenti del bot (header segreto impostato con setWebhook);
// - /jarvis-hook/tick: l'orologio (Worker con cron) con il segreto JARVIS_CLOCK_SECRET;
// - /jarvis-hook/mail-in: le email di menu@renmenu.com dal Worker email, con il segreto degli allegati;
// - /jarvis-hook/telefono: l'agente vocale durante una telefonata, con la chiave valida solo per quella chiamata.
// Nessun dato viene restituito: solo esiti sintetici.
import { autoPrepareTick, enrollIdleDrafts, geminiConfig, jarvisPhone, linkPendingMailFiles, missions, readPendingMaterials, receivePendingMail, runAutopilot } from '../control-room/api/[[route]].js';
import { sameSecret } from '../_lib/telegram.js';
import { chat } from '../_lib/voice.js';
import { serveMedia } from '../_lib/public-media.js';
import { previewUrl } from '../_lib/approvals.js';
import { dailyBackup } from '../_lib/backup.js';
import { readingTestStep } from '../_lib/reading-test.js';
import { MAX_RAW_BYTES, importIncomingMail } from '../_lib/mail-in.js';
import { visitReadyText } from '../_lib/visit.js';

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export async function onRequest(context) {
  const { request, env } = context;
  const path = new URL(request.url).pathname.replace(/\/+$/, '');
  // Link breve dell'anteprima per Riccardo su Telegram (il link completo supera il limite dei messaggi).
  const short = path.match(/^\/jarvis-hook\/anteprima\/(RM-[A-Z0-9]{4,12})$/);
  if (request.method === 'GET' && short && env.DB?.prepare) {
    let row = null;
    try { row = await env.DB.prepare("SELECT preview_url FROM publication_approvals WHERE reference_code=? AND recipient='telegram:riccardo' AND status IN ('anteprima_inviata','risposta_ricevuta','approvata_cliente')").bind(short[1]).first(); } catch { row = null; }
    if (!row?.preview_url) return new Response('Anteprima non più disponibile.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
    return new Response(null, { status: 302, headers: { Location: row.preview_url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  }
  // Link breve di sola visione alla bozza («mostrami l'anteprima di X»): vale 24 ore, non approva né pubblica nulla.
  const peek = path.match(/^\/jarvis-hook\/bozza\/(BZ-[A-Z0-9]{8,12})$/);
  if (request.method === 'GET' && peek && env.DB?.prepare) {
    let target = null;
    try {
      const saved = JSON.parse(await missions.setting(env.DB, `peek_${peek[1]}`) || 'null');
      if (saved?.draftId && saved.exp > new Date().toISOString()) {
        const row = await env.DB.prepare('SELECT menu_json FROM drafts WHERE id=?').bind(saved.draftId).first();
        if (row?.menu_json) target = previewUrl(JSON.parse(row.menu_json), 'it');
      }
    } catch { target = null; }
    if (!target) return new Response('Anteprima non più disponibile.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
    return new Response(null, { status: 302, headers: { Location: target, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  }
  // Foto del menu Premium confermate da Riccardo (servono all'anteprima e al menu).
  const media = path.match(/^\/jarvis-hook\/media\/([^/]+)$/);
  if (media) return serveMedia(request, env, media[1]);
  if (request.method !== 'POST' || !env.DB?.prepare) return reply({ ok: false }, 404);
  try {
    if (path === '/jarvis-hook/telegram') {
      const expected = await missions.setting(env.DB, 'telegram_webhook_secret');
      if (!sameSecret(request.headers.get('X-Telegram-Bot-Api-Secret-Token'), expected)) return reply({ ok: false }, 403);
      if (Number(request.headers.get('content-length') || 0) > 100_000) return reply({ ok: true });
      const update = await request.json().catch(() => null);
      if (update) await missions.telegramUpdate(env.DB, env, update);
      return reply({ ok: true });
    }
    if (path === '/jarvis-hook/telefono') {
      // Agente di ElevenLabs durante una telefonata a Riccardo: vale solo con la chiave di quella chiamata.
      if (Number(request.headers.get('content-length') || 0) > 20_000) return reply({ ok: false }, 413);
      const body = await request.json().catch(() => null);
      const out = await jarvisPhone(env, body || {});
      return reply({ risposta: out.risposta }, out.status || 200);
    }
    if (path === '/jarvis-hook/probe-intent') {
      // Solo diagnostica: stesso segreto del bot; restituisce l'intenzione capita, non esegue nulla.
      const expected = await missions.setting(env.DB, 'telegram_webhook_secret');
      if (!sameSecret(request.headers.get('X-Telegram-Bot-Api-Secret-Token'), expected)) return reply({ ok: false }, 403);
      const body = await request.json().catch(() => null);
      const phrases = Array.isArray(body?.phrases) ? body.phrases.map((p) => String(p).slice(0, 400)).filter(Boolean) : [];
      return reply({ ok: true, results: await missions.probeIntents(env.DB, env, phrases, ['auto', 'gemini', 'cloudflare'].includes(body?.engine) ? body.engine : 'auto') });
    }
    if (path === '/jarvis-hook/mail-files') {
      // Script Google dell'account renmenu1569: foto e PDF allegati alle email dei clienti.
      const expected = await missions.setting(env.DB, 'mail_files_secret');
      if (!expected || !sameSecret(request.headers.get('X-Jarvis-Mail'), expected)) return reply({ ok: false }, 403);
      if (Number(request.headers.get('content-length') || 0) > 90_000_000) return reply({ ok: false, error: 'TOO_LARGE' }, 413);
      const payload = await request.json().catch(() => null);
      const outcome = await receivePendingMail(env.DB, env, payload);
      return reply(outcome, outcome.ok ? 200 : 400);
    }
    if (path === '/jarvis-hook/mail-in') {
      // Worker email di menu@renmenu.com: l'email grezza (MIME), con lo stesso segreto degli allegati.
      const expected = await missions.setting(env.DB, 'mail_files_secret');
      if (!expected || !sameSecret(request.headers.get('X-Jarvis-Mail'), expected)) return reply({ ok: false }, 403);
      if (Number(request.headers.get('content-length') || 0) > MAX_RAW_BYTES) return reply({ ok: false, error: 'TOO_LARGE' }, 413);
      const raw = new Uint8Array(await request.arrayBuffer());
      if (!raw.length || raw.length > MAX_RAW_BYTES) return reply({ ok: false, error: 'TOO_LARGE' }, 413);
      // Esito dell'ultima email (senza contenuto) in jarvis_settings.last_mail_in: serve a capire un rifiuto.
      const remember = (value) => missions.putSetting(env.DB, 'last_mail_in', JSON.stringify({ at: new Date().toISOString(), bytes: raw.length, ...value })).catch(() => null);
      let outcome;
      try {
        outcome = await importIncomingMail(env.DB, raw, { envelopeFrom: request.headers.get('X-Mail-From'), envelopeTo: request.headers.get('X-Mail-To') },
          { receiveFiles: (payload) => receivePendingMail(env.DB, env, payload) });
      } catch (error) {
        await remember({ ok: false, error: String(error?.message || error).slice(0, 300) });
        await missions.alertOnce(env.DB, env, 'mail_in', 'email non importata', `Non sono riuscito a registrare un'email arrivata a menu@renmenu.com (${String(error?.message || 'errore').slice(0, 120)}). Il server di posta la ritenta e la copia resta in renmenu1569@gmail.com: controllala lì.`, { minutes: 30 }).catch(() => null);
        return reply({ ok: false, error: 'IMPORT_FAILED' }, 500);
      }
      await remember({ ok: outcome.ok, kind: outcome.kind, error: outcome.error, attachments: outcome.attachments });
      if (outcome.note) await missions.notify(env.DB, env, outcome.requestId || null, 'email ricevuta', outcome.note).catch(() => null);
      return reply({ ok: outcome.ok, kind: outcome.kind, error: outcome.error }, outcome.ok ? 200 : 422);
    }
    if (path === '/jarvis-hook/probe-ai') {
      // Collaudo del modello di conversazione: domanda fissa, nessun dato della Control Room.
      if (!sameSecret(request.headers.get('X-Jarvis-Clock'), env.JARVIS_CLOCK_SECRET)) return reply({ ok: false }, 403);
      const talk = await chat(env.AI, { utterance: 'Ciao Jarvis, presentati in due frasi e dimmi un consiglio per far crescere un servizio di menu digitali.', context: 'Nessun dato: collaudo.' });
      return reply({ ok: talk.ok, model: talk.model || null, text: talk.text });
    }
    if (path === '/jarvis-hook/tick') {
      if (!sameSecret(request.headers.get('X-Jarvis-Clock'), env.JARVIS_CLOCK_SECRET)) return reply({ ok: false }, 403);
      await missions.announceExternal(env.DB, env).catch(() => 0);
      const linked = await linkPendingMailFiles(env.DB, env).catch(() => []);
      for (const notice of linked) await missions.notify(env.DB, env, notice.requestId, 'allegato', notice.text);
      const read = await readPendingMaterials(env.DB, env).catch(() => []);
      for (const { material, request, outcome } of read) {
        if (outcome?.ok && outcome.waiting) continue; // altre foto in coda: un solo messaggio alla fine
        if (outcome?.deferred) {
          // Google lento: un solo avviso, al primo rinvio.
          if (outcome.deferred.n === 1) await missions.notify(env.DB, env, material.request_id, 'foto in attesa', `Google è lento e non ha risposto alla lettura di «${material.filename}». Non ripiego su modelli più deboli: riprovo tra ${outcome.deferred.minutes} minuti (fino a ${outcome.deferred.of} tentativi) e ti scrivo appena ho il risultato.`);
          continue;
        }
        // Visita: un solo messaggio con il link da mostrare al titolare (niente avviso importante né telefonata).
        if (outcome?.visit?.link) { await missions.notify(env.DB, env, material.request_id, 'anteprima per la visita', visitReadyText(outcome.visit.venue, outcome.visit.link, outcome.visit)); continue; }
        const many = (outcome?.files || []).length > 1;
        const head = many
          ? `Ho letto ${outcome.files.length} file${request?.subject ? ` della pratica «${String(request.subject).slice(0, 60)}»` : ''}, uno alla volta:\n${outcome.files.map((f, i) => `${i + 1}. «${f.filename}»: ${String(f.note).slice(0, 160)}`).join('\n')}\n`
          : `Ho letto «${material.filename}»${request?.subject ? ` (pratica «${String(request.subject).slice(0, 60)}»)` : ''}`;
        const weak = outcome?.weak ? ` Però le due letture concordano solo su ${outcome.weak.sure} voci e ${outcome.weak.unsure} righe restano in dubbio: NON preparo la bozza, verrebbe un menu a metà.${outcome.weak.sections ? ` Le parti meno sicure: ${outcome.weak.sections}; rimandami soprattutto quelle, ritagliate e ingrandite.` : ''} Mandami il menu in 2-3 screenshot (una parte per foto, testo grande) oppure come File (graffetta → File); se vuoi procedere lo stesso, in Revisione tocca «Rifai la bozza».` : '';
        const kept = outcome?.draftKept ? ' Attenzione: c’è già una bozza che hai modificato o affidato, quindi NON l’ho cambiata e questi file non sono dentro. Se vuoi includerli: Revisione → «Rifai la bozza con tutti i materiali».' : '';
        const text = !outcome?.ok ? `Non sono riuscito a leggere «${material.filename}»: ${outcome?.reason || 'errore'}.`
          : `${head}${many ? '' : `. ${outcome.warnings?.[0] || ''}`}${kept}${weak}${outcome.drafted ? ` Bozza pronta con tutti i file della pratica.${outcome.prep ? ' Ora preparo da solo il resto e poi ti chiedo solo se mandare l’anteprima al locale.' : ' Controllala in Revisione, confrontando i prezzi con le foto.'}${outcome.notesText ? `\n\n${outcome.notesText}` : ''}` : outcome.draftError ? ` Bozza non generata: ${outcome.draftError}` : ''}`;
        const checks = outcome?.checks ? `\n\nVoci sicure: ${outcome.checks.sure}. Mi restano ${outcome.checks.count} dubbi sui prezzi: te li chiedo uno alla volta qui sotto, tu guarda il menu e tocca il prezzo giusto. Dopo l'ultimo preparo la bozza.` : '';
        await missions.notify(env.DB, env, material.request_id, outcome?.ok ? 'foto letta' : 'foto non leggibile', `${text}${checks}`);
        if (outcome?.checks) await missions.startChecks(env.DB, env, material.request_id).catch(() => 0);
      }
      await missions.draftAfterChecks(env.DB, env).catch(() => null);
      await missions.translateAfterEdit(env.DB, env).catch(() => null);
      const drafted = await runAutopilot(env.DB, env);
      for (const entry of drafted) await missions.ping(env.DB, env, entry.message, entry.buttons || null, entry.outcome === 'bozza' && !entry.prep ? 'importante' : 'normale').catch(() => null);
      // Bozze fatte da Jarvis: lingue, schede e foto, poi una sola domanda a Riccardo («la mando al locale?»).
      await enrollIdleDrafts(env.DB).catch(() => null);
      await autoPrepareTick(env.DB, env).catch(() => null);
      const done = await missions.tick(env.DB, env);
      await missions.watchTick(env.DB, env).catch(() => null);
      const briefed = await missions.briefing(env.DB, env).catch(() => null);
      await missions.initiativeTick(env.DB, env).catch(() => null);
      await missions.agendaTick(env.DB, env).catch(() => null);
      await missions.replyTick(env.DB, env).catch(() => null);
      await missions.phoneTick(env.DB, env).catch(() => null);
      const backup = await dailyBackup(env.DB, env.BUCKET).catch(() => null);
      if (backup && !backup.ok && backup.attempts >= 3) {
        await missions.alertOnce(env.DB, env, 'backup', 'copia di sicurezza', `Copia di sicurezza del database non riuscita oggi (${backup.error}). Ritento domattina alle 3: se si ripete, controlla il bucket R2 dello staging.`, { minutes: 20 * 60 }).catch(() => null);
      }
      // Prova di lettura (/prova lettura): una foto per giro, a fine giro, solo quando non ci sono materiali veri da leggere.
      if (!read.length) {
        const step = await readingTestStep(env.DB, env, { gemini: await geminiConfig(env.DB, env) }).catch(() => null);
        if (step?.done) await missions.ping(env.DB, env, step.text).catch(() => null);
      }
      return reply({ ok: true, autopilot: drafted.length, briefing: Boolean(briefed), backup: backup ? Boolean(backup.ok) : undefined, missions: done.map(({ from, to, error }) => ({ from, to, error: error ? 'errore' : undefined })) });
    }
    return reply({ ok: false }, 404);
  } catch (error) {
    // L'orologio che si inceppa non deve restare muto: un avviso all'ora al massimo, e il diario lo conta.
    if (path === '/jarvis-hook/tick') await missions.alertOnce(env.DB, env, 'orologio', 'orologio fermo', `L'orologio di Jarvis si è inceppato (${String(error?.message || 'errore').slice(0, 120)}). Riprovo ogni minuto; finché non riparte pratiche, foto e pubblicazioni restano ferme.`).catch(() => null);
    // Per Telegram rispondiamo comunque 200: evita ripetizioni infinite dello stesso aggiornamento.
    return reply({ ok: path === '/jarvis-hook/telegram' }, path === '/jarvis-hook/telegram' ? 200 : 500);
  }
}

// Ingressi pubblici di Jarvis, fuori da Cloudflare Access ma protetti da segreti:
// - /jarvis-hook/telegram: aggiornamenti del bot (header segreto impostato con setWebhook);
// - /jarvis-hook/tick: l'orologio (Worker con cron) con il segreto JARVIS_CLOCK_SECRET.
// Nessun dato viene restituito: solo esiti sintetici.
import { linkPendingMailFiles, missions, readPendingMaterials, receivePendingMail, runAutopilot } from '../control-room/api/[[route]].js';
import { sameSecret, sendTelegram, telegramReady } from '../_lib/telegram.js';
import { chat } from '../_lib/voice.js';
import { serveMedia } from '../_lib/public-media.js';

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
    if (path === '/jarvis-hook/mail-files') {
      // Script Google dell'account renmenu1569: foto e PDF allegati alle email dei clienti.
      const expected = await missions.setting(env.DB, 'mail_files_secret');
      if (!expected || !sameSecret(request.headers.get('X-Jarvis-Mail'), expected)) return reply({ ok: false }, 403);
      if (Number(request.headers.get('content-length') || 0) > 90_000_000) return reply({ ok: false, error: 'TOO_LARGE' }, 413);
      const payload = await request.json().catch(() => null);
      const outcome = await receivePendingMail(env.DB, env, payload);
      return reply(outcome, outcome.ok ? 200 : 400);
    }
    if (path === '/jarvis-hook/probe-ai') {
      // Collaudo del modello di conversazione: domanda fissa, nessun dato della Control Room.
      if (!sameSecret(request.headers.get('X-Jarvis-Clock'), env.JARVIS_CLOCK_SECRET)) return reply({ ok: false }, 403);
      const talk = await chat(env.AI, { utterance: 'Ciao Jarvis, presentati in due frasi e dimmi un consiglio per far crescere un servizio di menu digitali.', context: 'Nessun dato: collaudo.' });
      return reply({ ok: talk.ok, model: talk.model || null, text: talk.text });
    }
    if (path === '/jarvis-hook/tick') {
      if (!sameSecret(request.headers.get('X-Jarvis-Clock'), env.JARVIS_CLOCK_SECRET)) return reply({ ok: false }, 403);
      const linked = await linkPendingMailFiles(env.DB, env).catch(() => []);
      for (const notice of linked) await missions.notify(env.DB, env, notice.requestId, 'allegato', notice.text);
      const read = await readPendingMaterials(env.DB, env).catch(() => []);
      for (const { material, request, outcome } of read) {
        if (outcome?.ok && outcome.waiting) continue; // altre foto in coda: un solo messaggio alla fine
        const many = (outcome?.files || []).length > 1;
        const head = many
          ? `Ho letto ${outcome.files.length} file${request?.subject ? ` della pratica «${String(request.subject).slice(0, 60)}»` : ''}, uno alla volta:\n${outcome.files.map((f, i) => `${i + 1}. «${f.filename}»: ${String(f.note).slice(0, 160)}`).join('\n')}\n`
          : `Ho letto «${material.filename}»${request?.subject ? ` (pratica «${String(request.subject).slice(0, 60)}»)` : ''}`;
        const weak = outcome?.weak ? ` Però le due letture concordano solo su ${outcome.weak.sure} voci e ${outcome.weak.unsure} righe restano in dubbio: NON preparo la bozza, verrebbe un menu a metà.${outcome.weak.sections ? ` Le parti meno sicure: ${outcome.weak.sections}; rimandami soprattutto quelle, ritagliate e ingrandite.` : ''} Mandami il menu in 2-3 screenshot (una parte per foto, testo grande) oppure come File (graffetta → File); se vuoi procedere lo stesso, in Revisione tocca «Rifai la bozza».` : '';
        const kept = outcome?.draftKept ? ' Attenzione: c’è già una bozza che hai modificato o affidato, quindi NON l’ho cambiata e questi file non sono dentro. Se vuoi includerli: Revisione → «Rifai la bozza con tutti i materiali».' : '';
        const text = !outcome?.ok ? `Non sono riuscito a leggere «${material.filename}»: ${outcome?.reason || 'errore'}.`
          : `${head}${many ? '' : `. ${outcome.warnings?.[0] || ''}`}${kept}${weak}${outcome.drafted ? ` Bozza pronta con tutti i file della pratica: controllala in Revisione, confrontando i prezzi con le foto.${outcome.notesText ? `\n\n${outcome.notesText}` : ''}` : outcome.draftError ? ` Bozza non generata: ${outcome.draftError}` : ''}`;
        const checks = outcome?.checks ? `\n\nVoci sicure: ${outcome.checks.sure}. Mi restano ${outcome.checks.count} dubbi sui prezzi: te li chiedo uno alla volta qui sotto, tu guarda il menu e tocca il prezzo giusto. Dopo l'ultimo preparo la bozza.` : '';
        await missions.notify(env.DB, env, material.request_id, outcome?.ok ? 'foto letta' : 'foto non leggibile', `${text}${checks}`);
        if (outcome?.checks) await missions.startChecks(env.DB, env, material.request_id).catch(() => 0);
      }
      await missions.draftAfterChecks(env.DB, env).catch(() => null);
      const drafted = await runAutopilot(env.DB, env);
      const chat = drafted.length ? await missions.setting(env.DB, 'telegram_chat_id') : null;
      if (chat && telegramReady(env)) for (const entry of drafted) await sendTelegram(env, chat, entry.message);
      const done = await missions.tick(env.DB, env);
      const briefed = await missions.briefing(env.DB, env).catch(() => null);
      return reply({ ok: true, autopilot: drafted.length, briefing: Boolean(briefed), missions: done.map(({ from, to, error }) => ({ from, to, error: error ? 'errore' : undefined })) });
    }
    return reply({ ok: false }, 404);
  } catch {
    // Per Telegram rispondiamo comunque 200: evita ripetizioni infinite dello stesso aggiornamento.
    return reply({ ok: path === '/jarvis-hook/telegram' }, path === '/jarvis-hook/telegram' ? 200 : 500);
  }
}

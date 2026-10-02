// Ingressi pubblici di Jarvis, fuori da Cloudflare Access ma protetti da segreti:
// - /jarvis-hook/telegram: aggiornamenti del bot (header segreto impostato con setWebhook);
// - /jarvis-hook/tick: l'orologio (Worker con cron) con il segreto JARVIS_CLOCK_SECRET.
// Nessun dato viene restituito: solo esiti sintetici.
import { missions, runAutopilot } from '../control-room/api/[[route]].js';
import { sameSecret, sendTelegram, telegramReady } from '../_lib/telegram.js';

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export async function onRequest(context) {
  const { request, env } = context;
  const path = new URL(request.url).pathname.replace(/\/+$/, '');
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
    if (path === '/jarvis-hook/tick') {
      if (!sameSecret(request.headers.get('X-Jarvis-Clock'), env.JARVIS_CLOCK_SECRET)) return reply({ ok: false }, 403);
      const drafted = await runAutopilot(env.DB, env);
      const chat = drafted.length ? await missions.setting(env.DB, 'telegram_chat_id') : null;
      if (chat && telegramReady(env)) for (const entry of drafted) await sendTelegram(env, chat, entry.message);
      const done = await missions.tick(env.DB, env);
      return reply({ ok: true, autopilot: drafted.length, missions: done.map(({ from, to, error }) => ({ from, to, error: error ? 'errore' : undefined })) });
    }
    return reply({ ok: false }, 404);
  } catch {
    // Per Telegram rispondiamo comunque 200: evita ripetizioni infinite dello stesso aggiornamento.
    return reply({ ok: path === '/jarvis-hook/telegram' }, path === '/jarvis-hook/telegram' ? 200 : 500);
  }
}

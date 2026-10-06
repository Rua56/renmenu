// Orologio di Jarvis: ogni minuto chiede al Control Room di far avanzare le pratiche affidate
// e di preparare le bozze delle richieste nuove. Nessuna logica qui: solo il segnale, con segreto.
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(fetch('https://renmenu-jarvis-stage.pages.dev/jarvis-hook/tick', {
      method: 'POST', headers: { 'X-Jarvis-Clock': env.JARVIS_CLOCK_SECRET, 'Content-Type': 'application/json' }, body: '{}'
    }).then((r) => r.text()).catch(() => null));
  },
  async fetch() { return new Response('Not found', { status: 404 }); }
};

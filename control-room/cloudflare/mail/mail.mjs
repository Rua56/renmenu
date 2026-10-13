// Posta di Jarvis: Email Routing consegna qui le email per menu@renmenu.com. Nessuna logica:
// l'email grezza passa al Control Room (/jarvis-hook/mail-in) con il segreto, come fa l'orologio.
// Variabili del Worker:
//   JARVIS_MAIL_SECRET  segreto (lo stesso di mail_files_secret nel database di Jarvis)
//   MAIL_COPY_TO        facoltativo: casella verificata in Email Routing che riceve una copia di ogni email
// Se il Control Room non risponde, l'email va comunque nella copia; senza copia il Worker
// fallisce e il server del mittente ritenta più tardi (nessuna email persa in silenzio).
const HOOK = 'https://renmenu-jarvis-stage.pages.dev/jarvis-hook/mail-in';

export default {
  async email(message, env) {
    const raw = await new Response(message.raw).arrayBuffer();
    let delivered = false;
    try {
      const response = await fetch(HOOK, {
        method: 'POST',
        headers: { 'X-Jarvis-Mail': env.JARVIS_MAIL_SECRET || '', 'X-Mail-From': message.from, 'X-Mail-To': message.to, 'Content-Type': 'message/rfc822' },
        body: raw
      });
      delivered = response.ok;
    } catch { delivered = false; }
    if (env.MAIL_COPY_TO) {
      await message.forward(env.MAIL_COPY_TO);
      return;
    }
    if (!delivered) throw new Error('Jarvis non raggiungibile: riprovare più tardi');
  },
  async fetch() { return new Response('Not found', { status: 404 }); }
};

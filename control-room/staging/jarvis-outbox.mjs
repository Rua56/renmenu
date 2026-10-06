// Coda di invio di Jarvis per l'automazione Gmail di renmenu1569.
// L'automazione riceve dal Worker solo il codice RM-XXXXXX; destinatario, oggetto e testo
// arrivano da qui (D1), mai dall'email di comando. Uso:
//   node jarvis-outbox.mjs get RM-XXXXXX           → {ok, recipient, subject, body}
//   node jarvis-outbox.mjs getonline RM-XXXXXX [cartella]  → come get, per l'email «menu online»: scrive qr-<slug>.png/.svg
//                                                     nella cartella (default /tmp/jarvis-qr) e restituisce files:[percorsi]
//   node jarvis-outbox.mjs sent RM-XXXXXX <id>      → segna inviata (id del messaggio Gmail)
//   node jarvis-outbox.mjs failed RM-XXXXXX <code>  → segna errore
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { d1 } from './gmail-import.mjs';
import { REFERENCE } from '../cloudflare/functions/_lib/approvals.js';

export const OUTBOX_GET_SQL = "SELECT o.recipient,o.subject,o.body,o.status FROM jarvis_outbox o JOIN jarvis_missions m ON m.id=o.mission_id WHERE o.reference_code=? AND m.status='attesa_invio'";
// Email «menu online»: la missione è completata (menu pubblicato e verificato), l'oggetto è quello fisso di Jarvis.
export const ONLINE_GET_SQL = "SELECT o.recipient,o.subject,o.body,o.status FROM jarvis_outbox o JOIN jarvis_missions m ON m.id=o.mission_id WHERE o.reference_code=? AND m.status='completata' AND o.subject LIKE 'Il tuo menu RenMenu è online · %'";
export const ONLINE_FILES_SQL = 'SELECT value FROM jarvis_settings WHERE key=?';
export const outboxSent = (code, messageId, stamp = new Date().toISOString()) => ({
  sql: "UPDATE jarvis_outbox SET status='inviata',sent_at=?,gmail_message_id=?,error=NULL,updated_at=? WHERE reference_code=? AND status='in_coda'",
  params: [stamp, String(messageId || 'sconosciuto').slice(0, 200), stamp, code] });
export const outboxFailed = (code, reason, stamp = new Date().toISOString()) => ({
  sql: "UPDATE jarvis_outbox SET status='errore',error=?,updated_at=? WHERE reference_code=? AND status='in_coda'",
  params: [String(reason || 'SEND_FAILED').replace(/[^A-Za-z0-9_ .:-]/g, '').slice(0, 120), stamp, code] });
export const validCode = (code) => typeof code === 'string' && REFERENCE.test(code) && code.length === 9;

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [verb, code, extra] = process.argv.slice(2);
  const out = (value, exit = 0) => { console.log(JSON.stringify(value)); process.exit(exit); };
  try {
    if (!validCode(code)) out({ ok: false, reason: 'CODICE_NON_VALIDO' }, 2);
    if (verb === 'get') {
      const row = d1(OUTBOX_GET_SQL, [code])?.results?.[0];
      if (!row) out({ ok: false, reason: 'NON_IN_CODA' }, 1);
      if (row.status !== 'in_coda') out({ ok: false, reason: row.status === 'inviata' ? 'GIA_INVIATA' : 'NON_IN_CODA' }, 1);
      out({ ok: true, recipient: row.recipient, subject: row.subject, body: row.body });
    }
    if (verb === 'getonline') {
      const row = d1(ONLINE_GET_SQL, [code])?.results?.[0];
      if (!row) out({ ok: false, reason: 'NON_IN_CODA' }, 1);
      if (row.status !== 'in_coda') out({ ok: false, reason: row.status === 'inviata' ? 'GIA_INVIATA' : 'NON_IN_CODA' }, 1);
      const raw = d1(ONLINE_FILES_SQL, [`outbox_qr_${code}`])?.results?.[0]?.value;
      if (!raw) out({ ok: false, reason: 'QR_MANCANTE' }, 1);
      const qr = JSON.parse(raw), dir = extra || '/tmp/jarvis-qr', slug = String(qr.slug).replace(/[^a-z0-9-]/gi, '').slice(0, 40) || 'menu';
      mkdirSync(dir, { recursive: true });
      const files = [`${dir}/qr-${slug}.png`, `${dir}/qr-${slug}.svg`];
      writeFileSync(files[0], Buffer.from(qr.png, 'base64'));
      writeFileSync(files[1], qr.svg);
      out({ ok: true, recipient: row.recipient, subject: row.subject, body: row.body, files });
    }
    if (verb === 'sent' || verb === 'failed') {
      const { sql, params } = verb === 'sent' ? outboxSent(code, extra) : outboxFailed(code, extra);
      const changes = d1(sql, params)?.meta?.changes ?? 0;
      out({ ok: changes === 1, reason: changes === 1 ? null : 'NESSUNA_RIGA' }, changes === 1 ? 0 : 1);
    }
    out({ ok: false, reason: 'COMANDO_SCONOSCIUTO' }, 2);
  } catch (error) { out({ ok: false, reason: String(error.message).slice(0, 200) }, 1); }
}
